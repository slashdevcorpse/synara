// FILE: super-synara-release-admission.ts
// Purpose: Builds and validates the exact public Super Synara prerelease staging set.
// Layer: Release publication admission

import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import type {
  ReleaseArtifactDigest,
  ReleaseArtifactProvenanceManifest,
} from "./release-artifact-provenance.ts";
import {
  type MacSignatureAllowlist,
  validateMacUnsignedSignatureReport,
} from "./super-synara-macos-signatures.ts";

const REPOSITORY = "slashdevcorpse/synara";
const PROHIBITED_ASSET_PATTERN = /(?:\.blockmap|\.ya?ml|\.zip|\.AppImage)$/i;
const WINDOWS_ONLY_PROHIBITED_ASSET_PATTERN = /(?:macos|\.dmg$)/i;

export type SuperSynaraReleaseScope = "windows-only" | "windows-and-macos";

export interface SuperSynaraReleaseCoordinates {
  readonly version: string;
  readonly tag: string;
  readonly sourceCommit: string;
  readonly absorbedUpstreamSha: string;
}

export interface SuperSynaraReleaseIndex {
  readonly schemaVersion: 1;
  readonly distributionKind: "github-unsigned-prerelease";
  readonly repository: typeof REPOSITORY;
  readonly version: string;
  readonly tag: string;
  readonly sourceCommit: string;
  readonly absorbedUpstreamSha: string;
  readonly platforms: readonly ["windows-x64"] | readonly ["windows-x64", "macos-arm64"];
  readonly files: ReadonlyArray<ReleaseArtifactDigest>;
}

export interface SuperSynaraReleaseFileNames {
  readonly windowsInstaller: string;
  readonly macosDiskImage: string;
  readonly windowsProvenance: "artifact-windows-x64.provenance.json";
  readonly macosProvenance: "artifact-macos-arm64.provenance.json";
  readonly releaseIndex: "release-index.json";
  readonly checksums: "SHA256SUMS.txt";
  readonly warning: "UNSIGNED-BUILD.md";
  readonly license: "LICENSE";
}

function bytewiseSort(values: ReadonlyArray<string>): string[] {
  return values.toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function hasExactUnsignedEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return (
    evidence.status === "NotSigned" &&
    evidence.signerCertificate === null &&
    evidence.timeStamperCertificate === null
  );
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestFile(directory: string, fileName: string): ReleaseArtifactDigest {
  const path = join(directory, fileName);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Release asset must be a regular non-symlink file: ${fileName}.`);
  }
  return { fileName, size: entry.size, sha256: sha256File(path) };
}

function renderCanonicalChecksums(directory: string, fileNames: ReadonlyArray<string>): string {
  return `${bytewiseSort(fileNames)
    .map((fileName) => `${sha256File(join(directory, fileName))}  ${fileName}`)
    .join("\n")}\n`;
}

function assertFullSha(label: string, value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a full 40-character commit SHA.`);
  }
}

export function superSynaraReleaseFileNames(version: string): SuperSynaraReleaseFileNames {
  if (!/^\d+\.\d+\.\d+-super\.[1-9]\d*$/.test(version)) {
    throw new Error(`Invalid Super Synara prerelease version: ${version}.`);
  }
  return {
    windowsInstaller: `Super-Synara-${version}-windows-x64-unsigned.exe`,
    macosDiskImage: `Super-Synara-${version}-macos-arm64-unsigned.dmg`,
    windowsProvenance: "artifact-windows-x64.provenance.json",
    macosProvenance: "artifact-macos-arm64.provenance.json",
    releaseIndex: "release-index.json",
    checksums: "SHA256SUMS.txt",
    warning: "UNSIGNED-BUILD.md",
    license: "LICENSE",
  };
}

function assertReleaseScope(value: string): asserts value is SuperSynaraReleaseScope {
  if (value !== "windows-only" && value !== "windows-and-macos") {
    throw new Error(`Unsupported Super Synara release scope: ${value}.`);
  }
}

function assertMacSignatureAllowlistScope(input: {
  readonly releaseScope: SuperSynaraReleaseScope;
  readonly macSignatureAllowlist?: MacSignatureAllowlist;
}): asserts input is typeof input &
  (
    | {
        readonly releaseScope: "windows-only";
        readonly macSignatureAllowlist?: never;
      }
    | {
        readonly releaseScope: "windows-and-macos";
        readonly macSignatureAllowlist: MacSignatureAllowlist;
      }
  ) {
  if (input.releaseScope === "windows-only" && input.macSignatureAllowlist !== undefined) {
    throw new Error("Windows-only release admission must not include a macOS signature allowlist.");
  }
  if (input.releaseScope === "windows-and-macos" && !input.macSignatureAllowlist) {
    throw new Error("Combined release admission requires the reviewed macOS signature allowlist.");
  }
}

function releasePlatforms(
  releaseScope: SuperSynaraReleaseScope,
): SuperSynaraReleaseIndex["platforms"] {
  return releaseScope === "windows-only" ? ["windows-x64"] : ["windows-x64", "macos-arm64"];
}

export function exactSuperSynaraReleaseAllowlist(
  version: string,
  releaseScope: SuperSynaraReleaseScope,
): ReadonlyArray<string> {
  const names = superSynaraReleaseFileNames(version);
  const fileNames =
    releaseScope === "windows-only"
      ? [
          names.windowsInstaller,
          names.windowsProvenance,
          names.releaseIndex,
          names.checksums,
          names.warning,
          names.license,
        ]
      : Object.values(names);
  return bytewiseSort(fileNames);
}

export function assertNoProhibitedReleaseAssets(
  directory: string,
  releaseScope: SuperSynaraReleaseScope,
): void {
  for (const fileName of readdirSync(directory)) {
    if (
      PROHIBITED_ASSET_PATTERN.test(fileName) ||
      /(?:linux|intel|x64-macos|macos-x64)/i.test(fileName) ||
      (releaseScope === "windows-only" && WINDOWS_ONLY_PROHIBITED_ASSET_PATTERN.test(fileName))
    ) {
      throw new Error(`Prohibited Super Synara release asset: ${fileName}.`);
    }
  }
}

export function enforceReleaseByteCap(
  directory: string,
  maxBytes: number,
  fileNames = readdirSync(directory),
): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Release artifact byte cap must be a positive safe integer.");
  }
  let totalBytes = 0;
  for (const fileName of fileNames) {
    totalBytes += digestFile(directory, fileName).size;
  }
  if (totalBytes > maxBytes) {
    throw new Error(`Release artifacts use ${totalBytes} bytes, exceeding cap ${maxBytes}.`);
  }
  return totalBytes;
}

export function renderUnsignedBuildWarning(
  coordinates: SuperSynaraReleaseCoordinates,
  releaseScope: SuperSynaraReleaseScope,
): string {
  const introduction =
    releaseScope === "windows-only"
      ? `This is an unofficial downstream Super Synara Windows x64 build. It is publicly distributed without a trusted Windows publisher certificate.\n\n`
      : `This is an unofficial downstream Super Synara build. It is publicly distributed without a trusted Windows publisher certificate, Apple Developer ID signature, or Apple notarization.\n\n`;
  const operatingSystemWarnings =
    releaseScope === "windows-only"
      ? `Windows may show **Unknown publisher** or Microsoft Defender SmartScreen, and organization policy or Smart App Control may block the installer.\n\n`
      : `Windows may show **Unknown publisher** or Microsoft Defender SmartScreen, and organization policy or Smart App Control may block the installer.\n\n` +
        `macOS Gatekeeper may block the app. Use Apple's documented per-app Finder or Privacy & Security override: https://support.apple.com/en-ca/102445. Do not disable Gatekeeper or another system-wide security protection.\n\n`;
  const downloadedPayload = releaseScope === "windows-only" ? "installer" : "installer or DMG";
  return (
    `# Super Synara unsigned prerelease\n\n` +
    introduction +
    `- Version: \`${coordinates.version}\`\n` +
    `- Tag: \`${coordinates.tag}\`\n` +
    `- Downstream commit: \`${coordinates.sourceCommit.toLowerCase()}\`\n` +
    `- Absorbed upstream SHA: \`${coordinates.absorbedUpstreamSha.toLowerCase()}\`\n` +
    `- Updates: manual download only; no automatic updater feed is included.\n` +
    `- License and attribution: MIT; the complete license and copyright notice are included in the attached \`LICENSE\` file.\n\n` +
    `## Operating-system warnings\n\n` +
    operatingSystemWarnings +
    `## Verify downloaded bytes\n\n` +
    `Compute SHA-256 for the ${downloadedPayload} and compare it with \`SHA256SUMS.txt\`. The release index binds every published file to this exact tag, downstream commit, and absorbed upstream SHA.\n`
  );
}

function readManifest(directory: string, fileName: string): ReleaseArtifactProvenanceManifest {
  const parsed = JSON.parse(
    readFileSync(join(directory, fileName), "utf8"),
  ) as ReleaseArtifactProvenanceManifest;
  if (parsed.schemaVersion !== 2) {
    throw new Error(
      `${fileName} has unsupported provenance schema ${String(parsed.schemaVersion)}.`,
    );
  }
  return parsed;
}

function validatePlatformManifest(input: {
  readonly directory: string;
  readonly manifestFileName: string;
  readonly payloadFileName: string;
  readonly platform: "win" | "mac";
  readonly coordinates: SuperSynaraReleaseCoordinates;
  readonly macSignatureAllowlist?: MacSignatureAllowlist;
}): ReleaseArtifactProvenanceManifest {
  const manifest = readManifest(input.directory, input.manifestFileName);
  const expectedArch = input.platform === "win" ? "x64" : "arm64";
  const expectedTarget = input.platform === "win" ? "nsis" : "dmg";
  if (
    !manifest.publication ||
    manifest.distribution.kind !== "github-unsigned-prerelease" ||
    manifest.distribution.repository !== REPOSITORY ||
    manifest.distribution.tag !== input.coordinates.tag ||
    !manifest.distribution.prerelease ||
    manifest.distribution.latest !== false ||
    manifest.distribution.updaterFeed ||
    manifest.platform !== input.platform ||
    manifest.arch !== expectedArch ||
    manifest.target !== expectedTarget ||
    manifest.version !== input.coordinates.version ||
    manifest.source.commit !== input.coordinates.sourceCommit.toLowerCase() ||
    manifest.source.tag !== input.coordinates.tag ||
    manifest.source.absorbedUpstreamSha !== input.coordinates.absorbedUpstreamSha.toLowerCase()
  ) {
    throw new Error(`${input.manifestFileName} does not match the admitted release coordinates.`);
  }
  if (
    manifest.signing.status !== "unsigned-prerelease" ||
    (input.platform === "win"
      ? manifest.signing.scheme !== "none" ||
        manifest.signing.thirdPartyComponents !== "not-applicable"
      : manifest.signing.scheme !== "ad-hoc-only" ||
        manifest.signing.thirdPartyComponents !== "reviewed-allowlist")
  ) {
    throw new Error(`${input.manifestFileName} does not contain the required unsigned evidence.`);
  }
  if (
    manifest.artifacts.length !== 1 ||
    manifest.artifacts[0]?.fileName !== input.payloadFileName
  ) {
    throw new Error(`${input.manifestFileName} must describe exactly ${input.payloadFileName}.`);
  }
  const actual = digestFile(input.directory, input.payloadFileName);
  if (
    manifest.artifacts[0].size !== actual.size ||
    manifest.artifacts[0].sha256 !== actual.sha256
  ) {
    throw new Error(`${input.payloadFileName} bytes differ from platform provenance.`);
  }
  if (input.platform === "win") {
    const signing = manifest.signing;
    if (signing.status !== "unsigned-prerelease" || signing.scheme !== "none") {
      throw new Error(`${input.manifestFileName} omitted Windows Authenticode evidence.`);
    }
    const identity = signing.identity;
    const installer = identity.installer;
    const productOwned = identity.productOwnedExecutables;
    if (
      identity.qualificationReportSchemaVersion !== 3 ||
      identity.currentVersion !== input.coordinates.version ||
      installer.fileName !== input.payloadFileName ||
      installer.productName !== "Super Synara" ||
      installer.sha256 !== manifest.artifacts[0].sha256 ||
      !hasExactUnsignedEvidence(installer.authenticode) ||
      productOwned.length !== 2 ||
      productOwned[0]?.role !== "main-executable" ||
      productOwned[0].fileName !== "Super Synara.exe" ||
      productOwned[0].productName !== "Super Synara" ||
      !hasExactUnsignedEvidence(productOwned[0].authenticode) ||
      productOwned[1]?.role !== "uninstaller" ||
      productOwned[1].fileName !== "Uninstall Super Synara.exe" ||
      productOwned[1].productName !== "Super Synara" ||
      !hasExactUnsignedEvidence(productOwned[1].authenticode) ||
      !Array.isArray(identity.vendorExecutables)
    ) {
      throw new Error(
        `${input.manifestFileName} does not bind exact unsigned Windows product-owned binaries.`,
      );
    }
  }
  if (input.platform === "mac") {
    if (!input.macSignatureAllowlist) {
      throw new Error("Final macOS release admission requires the reviewed signature allowlist.");
    }
    const signing = manifest.signing;
    if (signing.status !== "unsigned-prerelease" || signing.scheme !== "ad-hoc-only") {
      throw new Error(`${input.manifestFileName} omitted macOS signature evidence.`);
    }
    const identity = validateMacUnsignedSignatureReport(
      signing.identity,
      input.macSignatureAllowlist,
    );
    const artifact = manifest.artifacts[0]!;
    if (
      identity.diskImage.fileName !== artifact.fileName ||
      identity.diskImage.size !== artifact.size ||
      identity.diskImage.sha256 !== artifact.sha256
    ) {
      throw new Error(`${input.manifestFileName} does not bind exact admitted macOS DMG evidence.`);
    }
  }
  return manifest;
}

export function prepareSuperSynaraRelease(input: {
  readonly directory: string;
  readonly licensePath: string;
  readonly releaseScope: SuperSynaraReleaseScope;
  readonly macSignatureAllowlist?: MacSignatureAllowlist;
  readonly coordinates: SuperSynaraReleaseCoordinates;
  readonly maxTotalBytes: number;
}): SuperSynaraReleaseIndex {
  const { coordinates } = input;
  assertReleaseScope(input.releaseScope);
  assertMacSignatureAllowlistScope(input);
  assertFullSha("Source commit", coordinates.sourceCommit);
  assertFullSha("Absorbed upstream SHA", coordinates.absorbedUpstreamSha);
  if (coordinates.tag !== `super-v${coordinates.version}`) {
    throw new Error(`Release tag must be super-v${coordinates.version}.`);
  }
  const names = superSynaraReleaseFileNames(coordinates.version);
  assertNoProhibitedReleaseAssets(input.directory, input.releaseScope);

  const windowsManifest = validatePlatformManifest({
    directory: input.directory,
    manifestFileName: names.windowsProvenance,
    payloadFileName: names.windowsInstaller,
    platform: "win",
    coordinates,
  });
  if (input.releaseScope === "windows-and-macos") {
    const macosManifest = validatePlatformManifest({
      directory: input.directory,
      manifestFileName: names.macosProvenance,
      payloadFileName: names.macosDiskImage,
      platform: "mac",
      coordinates,
      macSignatureAllowlist: input.macSignatureAllowlist,
    });
    if (windowsManifest.source.lockfileSha256 !== macosManifest.source.lockfileSha256) {
      throw new Error("Platform provenance manifests disagree on bun.lock SHA-256.");
    }
  }

  const licenseEntry = lstatSync(input.licensePath);
  if (
    !licenseEntry.isFile() ||
    licenseEntry.isSymbolicLink() ||
    basename(input.licensePath) !== "LICENSE"
  ) {
    throw new Error("Release license source must be a regular root LICENSE file.");
  }
  copyFileSync(input.licensePath, join(input.directory, names.license), constants.COPYFILE_EXCL);
  writeFileSync(
    join(input.directory, names.warning),
    renderUnsignedBuildWarning(coordinates, input.releaseScope),
    {
      encoding: "utf8",
      flag: "wx",
    },
  );

  const checksumFiles = bytewiseSort([
    names.windowsInstaller,
    names.windowsProvenance,
    ...(input.releaseScope === "windows-and-macos"
      ? [names.macosDiskImage, names.macosProvenance]
      : []),
    names.warning,
    names.license,
  ]);
  const checksumText = renderCanonicalChecksums(input.directory, checksumFiles);
  writeFileSync(join(input.directory, names.checksums), checksumText, {
    encoding: "utf8",
    flag: "wx",
  });

  const indexFileNames = bytewiseSort([...checksumFiles, names.checksums]);
  const index: SuperSynaraReleaseIndex = {
    schemaVersion: 1,
    distributionKind: "github-unsigned-prerelease",
    repository: REPOSITORY,
    version: coordinates.version,
    tag: coordinates.tag,
    sourceCommit: coordinates.sourceCommit.toLowerCase(),
    absorbedUpstreamSha: coordinates.absorbedUpstreamSha.toLowerCase(),
    platforms: releasePlatforms(input.releaseScope),
    files: indexFileNames.map((fileName) => digestFile(input.directory, fileName)),
  };
  writeFileSync(join(input.directory, names.releaseIndex), `${JSON.stringify(index, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  const actualFiles = bytewiseSort(readdirSync(input.directory));
  const expectedFiles = exactSuperSynaraReleaseAllowlist(coordinates.version, input.releaseScope);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Release staging set differs from the exact allowlist. Expected ${JSON.stringify(expectedFiles)}, got ${JSON.stringify(actualFiles)}.`,
    );
  }
  assertNoProhibitedReleaseAssets(input.directory, input.releaseScope);
  enforceReleaseByteCap(input.directory, input.maxTotalBytes, actualFiles);
  return index;
}

export function verifyPreparedSuperSynaraRelease(input: {
  readonly directory: string;
  readonly releaseScope: SuperSynaraReleaseScope;
  readonly macSignatureAllowlist?: MacSignatureAllowlist;
  readonly coordinates: SuperSynaraReleaseCoordinates;
  readonly maxTotalBytes: number;
}): SuperSynaraReleaseIndex {
  assertReleaseScope(input.releaseScope);
  assertMacSignatureAllowlistScope(input);
  const expectedFiles = exactSuperSynaraReleaseAllowlist(
    input.coordinates.version,
    input.releaseScope,
  );
  const actualFiles = bytewiseSort(readdirSync(input.directory));
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Prepared release no longer matches the exact asset allowlist.");
  }
  assertNoProhibitedReleaseAssets(input.directory, input.releaseScope);
  const names = superSynaraReleaseFileNames(input.coordinates.version);
  const windowsManifest = validatePlatformManifest({
    directory: input.directory,
    manifestFileName: names.windowsProvenance,
    payloadFileName: names.windowsInstaller,
    platform: "win",
    coordinates: input.coordinates,
  });
  if (input.releaseScope === "windows-and-macos") {
    const macosManifest = validatePlatformManifest({
      directory: input.directory,
      manifestFileName: names.macosProvenance,
      payloadFileName: names.macosDiskImage,
      platform: "mac",
      coordinates: input.coordinates,
      macSignatureAllowlist: input.macSignatureAllowlist,
    });
    if (windowsManifest.source.lockfileSha256 !== macosManifest.source.lockfileSha256) {
      throw new Error("Platform provenance manifests disagree on bun.lock SHA-256.");
    }
  }
  const index = JSON.parse(
    readFileSync(join(input.directory, names.releaseIndex), "utf8"),
  ) as SuperSynaraReleaseIndex;
  if (
    index.schemaVersion !== 1 ||
    index.distributionKind !== "github-unsigned-prerelease" ||
    index.repository !== REPOSITORY ||
    index.version !== input.coordinates.version ||
    index.tag !== input.coordinates.tag ||
    index.sourceCommit !== input.coordinates.sourceCommit.toLowerCase() ||
    index.absorbedUpstreamSha !== input.coordinates.absorbedUpstreamSha.toLowerCase() ||
    JSON.stringify(index.platforms) !== JSON.stringify(releasePlatforms(input.releaseScope))
  ) {
    throw new Error("Release admission index no longer matches release coordinates.");
  }
  const expectedIndexFiles = bytewiseSort(
    expectedFiles.filter((fileName) => fileName !== names.releaseIndex),
  );
  if (
    JSON.stringify(index.files.map((file) => file.fileName)) !== JSON.stringify(expectedIndexFiles)
  ) {
    throw new Error("Release admission index file set is not canonical.");
  }
  for (const expected of index.files) {
    const actual = digestFile(input.directory, expected.fileName);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`Release asset changed after admission: ${expected.fileName}.`);
    }
  }
  const checksumFiles = expectedFiles.filter(
    (fileName) => fileName !== names.releaseIndex && fileName !== names.checksums,
  );
  const actualChecksums = readFileSync(join(input.directory, names.checksums), "utf8");
  const expectedChecksums = renderCanonicalChecksums(input.directory, checksumFiles);
  if (actualChecksums !== expectedChecksums) {
    throw new Error("SHA256SUMS.txt is not the canonical checksum set for the admitted bytes.");
  }
  enforceReleaseByteCap(input.directory, input.maxTotalBytes, actualFiles);
  return index;
}
