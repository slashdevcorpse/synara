// FILE: release-artifact-provenance.ts
// Purpose: Hashes collected release assets and proves platform signing before upload.
// Layer: Release/build helper

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { matchesDistinguishedName } from "@synara/shared/windowsCertificate";

import {
  type MacSignatureAllowlist,
  type MacUnsignedSignatureReport,
  validateMacUnsignedSignatureReport,
} from "./super-synara-macos-signatures.ts";
import type {
  WindowsInstallerQualificationReport,
  WindowsQualifiedExecutableEvidence,
  WindowsVendorExecutableEvidence,
} from "./windows-installer-qualification.ts";
import {
  inspectUnsignedWindowsExecutable,
  type WindowsUnsignedAuthenticodeEvidence,
} from "./windows-authenticode.ts";

export type ReleaseArtifactPlatform = "linux" | "mac" | "win";
export type ReleaseDistributionKind =
  | "build-only"
  | "github-unsigned-prerelease"
  | "signed-release";

export interface ReleaseArtifactProvenanceInput {
  readonly assetsDirectory: string;
  readonly platform: ReleaseArtifactPlatform;
  readonly arch: string;
  readonly target: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly sourceTag: string | null;
  readonly lockfileSha256: string;
  readonly publication: boolean;
  readonly signed: boolean;
  readonly distributionKind?: ReleaseDistributionKind;
  readonly distributionRepository?: string;
  readonly distributionPrerelease?: boolean;
  readonly distributionLatest?: boolean;
  readonly updaterFeed?: boolean;
  readonly absorbedUpstreamSha?: string;
  readonly macSignatureReport?: MacUnsignedSignatureReport;
  readonly macSignatureAllowlist?: MacSignatureAllowlist;
  readonly expectedMacTeamId?: string;
  readonly expectedWindowsPublisher?: string;
  readonly expectedWindowsSubjectDn?: string;
  readonly windowsQualificationReportPath?: string;
  readonly artifactFileNames?: ReadonlyArray<string>;
  readonly outputFileName?: string;
}

export interface ReleaseArtifactDigest {
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface WindowsSignatureEvidence {
  readonly fileName: string;
  readonly subject: string;
  readonly publisher: string;
  readonly thumbprint: string;
  readonly timestampSubject: string;
  readonly timestampThumbprint: string;
}

interface MacSignatureEvidence {
  readonly teamId: string;
  readonly authorities: ReadonlyArray<string>;
  readonly appBundle: string;
  readonly diskImage: string;
}

interface WindowsUnsignedQualificationEvidence {
  readonly qualificationReportSchemaVersion: 3;
  readonly currentVersion: string;
  readonly upgrade: "qualified" | "not-run-no-previous-release";
  readonly previousVersion: string | null;
  readonly installer: WindowsQualifiedExecutableEvidence & { readonly role: "installer" };
  readonly productOwnedExecutables: readonly [
    WindowsQualifiedExecutableEvidence & { readonly role: "main-executable" },
    WindowsQualifiedExecutableEvidence & { readonly role: "uninstaller" },
  ];
  readonly vendorExecutables: ReadonlyArray<WindowsVendorExecutableEvidence>;
}

export interface ReleaseArtifactProvenanceRuntime {
  readonly inspectUnsignedWindowsExecutable: (
    executablePath: string,
  ) => WindowsUnsignedAuthenticodeEvidence;
  readonly windowsQualificationReportDirectory?: string;
}

export type SigningEvidence =
  | {
      readonly status: "verified";
      readonly scheme: "apple-developer-id";
      readonly identity: MacSignatureEvidence;
      readonly checks: ReadonlyArray<string>;
    }
  | {
      readonly status: "verified";
      readonly scheme: "windows-authenticode";
      readonly identity: ReadonlyArray<WindowsSignatureEvidence>;
      readonly checks: ReadonlyArray<string>;
    }
  | {
      readonly status: "not-applicable";
      readonly scheme: "none";
      readonly identity: null;
      readonly checks: ReadonlyArray<string>;
    }
  | {
      readonly status: "unsigned-build-only";
      readonly scheme: "none";
      readonly identity: null;
      readonly checks: ReadonlyArray<string>;
    }
  | {
      readonly status: "unsigned-prerelease";
      readonly scheme: "none";
      readonly thirdPartyComponents: "not-applicable";
      readonly identity: WindowsUnsignedQualificationEvidence;
      readonly checks: ReadonlyArray<string>;
    }
  | {
      readonly status: "unsigned-prerelease";
      readonly scheme: "ad-hoc-only";
      readonly thirdPartyComponents: "reviewed-allowlist";
      readonly identity: MacUnsignedSignatureReport;
      readonly checks: ReadonlyArray<string>;
    };

export interface ReleaseArtifactProvenanceManifest {
  readonly schemaVersion: 2;
  readonly publication: boolean;
  readonly distribution: {
    readonly kind: ReleaseDistributionKind;
    readonly repository: string | null;
    readonly tag: string | null;
    readonly prerelease: boolean;
    readonly latest: boolean | null;
    readonly updaterFeed: boolean;
  };
  readonly platform: ReleaseArtifactPlatform;
  readonly arch: string;
  readonly target: string;
  readonly version: string;
  readonly source: {
    readonly commit: string;
    readonly tag: string | null;
    readonly lockfileSha256: string;
    readonly absorbedUpstreamSha: string | null;
  };
  readonly signing: SigningEvidence;
  readonly artifacts: ReadonlyArray<ReleaseArtifactDigest>;
}

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
export const WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME =
  "windows-installer-qualification.json";

const nativeProvenanceRuntime: ReleaseArtifactProvenanceRuntime = {
  inspectUnsignedWindowsExecutable,
  ...(process.env.RUNNER_TEMP
    ? { windowsQualificationReportDirectory: process.env.RUNNER_TEMP }
    : {}),
};

function runCommand(command: string, args: ReadonlyArray<string>): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function requireSingleArtifact(
  artifacts: ReadonlyArray<ReleaseArtifactDigest>,
  suffix: string,
): ReleaseArtifactDigest {
  const matches = artifacts.filter((artifact) => artifact.fileName.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${suffix} artifact, found ${matches.length}.`);
  }
  return matches[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameWindowsPath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function validateUnsignedAuthenticodeEvidence(
  value: unknown,
  expectedPath: string,
  label: string,
): asserts value is WindowsUnsignedAuthenticodeEvidence {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !sameWindowsPath(value.path, expectedPath) ||
    value.status !== "NotSigned" ||
    value.signerCertificate !== null ||
    value.timeStamperCertificate !== null
  ) {
    throw new Error(`${label} does not contain exact NotSigned Authenticode evidence.`);
  }
}

function validateQualifiedExecutable(
  value: unknown,
  expected: {
    readonly role: WindowsQualifiedExecutableEvidence["role"];
    readonly fileName?: string;
    readonly path?: string;
    readonly productName?: string;
  },
  label: string,
): asserts value is WindowsQualifiedExecutableEvidence {
  if (
    !isRecord(value) ||
    value.role !== expected.role ||
    typeof value.fileName !== "string" ||
    typeof value.path !== "string" ||
    (value.productName !== null && typeof value.productName !== "string") ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error(`${label} is malformed.`);
  }
  if (
    (expected.fileName !== undefined && value.fileName !== expected.fileName) ||
    (expected.path !== undefined && !sameWindowsPath(value.path, expected.path)) ||
    (expected.productName !== undefined && value.productName !== expected.productName)
  ) {
    throw new Error(`${label} does not match the expected executable identity.`);
  }
  validateUnsignedAuthenticodeEvidence(value.authenticode, value.path, label);
}

function validateVendorExecutable(
  value: unknown,
  label: string,
): asserts value is WindowsVendorExecutableEvidence {
  if (
    !isRecord(value) ||
    value.role !== "vendor-executable" ||
    typeof value.fileName !== "string" ||
    typeof value.path !== "string" ||
    basename(value.path) !== value.fileName ||
    (value.productName !== null && typeof value.productName !== "string") ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error(`${label} is malformed.`);
  }
}

function readWindowsQualificationReport(
  input: ReleaseArtifactProvenanceInput,
  artifact: ReleaseArtifactDigest,
  runtime: ReleaseArtifactProvenanceRuntime,
): WindowsUnsignedQualificationEvidence {
  const reportPath = input.windowsQualificationReportPath
    ? resolve(input.windowsQualificationReportPath)
    : "";
  const trustedReportDirectory = runtime.windowsQualificationReportDirectory?.trim();
  if (
    !trustedReportDirectory ||
    basename(reportPath) !== WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME ||
    dirname(reportPath).toLowerCase() !== resolve(trustedReportDirectory).toLowerCase()
  ) {
    throw new Error(
      "Windows qualification report must be the exact native report under RUNNER_TEMP.",
    );
  }
  if (!existsSync(reportPath) || !lstatSync(reportPath).isFile()) {
    throw new Error(
      `Windows unsigned provenance requires ${WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error("Windows installer qualification report is malformed JSON.", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error("Windows installer qualification report must be an object.");
  }
  const report = parsed as unknown as WindowsInstallerQualificationReport;
  if (
    report.schemaVersion !== 3 ||
    report.platform !== "windows-x64" ||
    report.currentVersion !== input.version ||
    (report.upgrade !== "qualified" && report.upgrade !== "not-run-no-previous-release") ||
    (report.upgrade === "qualified"
      ? typeof report.previousVersion !== "string"
      : report.previousVersion !== null)
  ) {
    throw new Error("Windows installer qualification report does not match this release.");
  }
  if (
    report.sideBySide?.upstreamStartupProven !== true ||
    report.sideBySide.upstreamControlledCleanupProven !== true ||
    report.sideBySide.concurrentOverlapProven !== true ||
    report.sideBySide.distinctProcessLocksProven !== true ||
    report.sideBySide.distinctProfileRootsProven !== true ||
    report.sideBySide.upstreamExecutablePreserved !== true ||
    report.sideBySide.upstreamRegistrationPreserved !== true ||
    report.sideBySide.upstreamProfileSentinelsPreserved !== true ||
    report.sideBySide.upstreamUninstallCleanupProven !== true ||
    report.isolation?.liveProfilesRead !== false ||
    report.isolation.liveProfilesMutated !== false ||
    report.isolation.upstreamRegistrationPreserved !== true ||
    report.isolation.upstreamSentinelsPreserved !== true ||
    report.isolation.superStateWasTemporary !== true ||
    report.installation?.productName !== "Super Synara" ||
    report.installation.executableName !== "Super Synara.exe" ||
    report.installation.registrationScope !== "current-user-64" ||
    report.installation.startupProven !== true ||
    report.installation.cleanExitProven !== true ||
    report.installation.uninstallCleanupProven !== true
  ) {
    throw new Error("Windows installer qualification report omitted a required lifecycle proof.");
  }

  const installerPath = resolve(input.assetsDirectory, artifact.fileName);
  validateQualifiedExecutable(
    report.installer,
    {
      role: "installer",
      fileName: artifact.fileName,
      path: installerPath,
      productName: "Super Synara",
    },
    "Windows installer evidence",
  );
  if (report.installer.sha256 !== artifact.sha256) {
    throw new Error("Windows qualification installer SHA-256 differs from the staged artifact.");
  }

  const installDirectory = report.installation.installDirectory;
  if (
    typeof installDirectory !== "string" ||
    !Array.isArray(report.installation.productOwnedExecutables)
  ) {
    throw new Error(
      "Windows installer qualification report omitted installed executable evidence.",
    );
  }
  if (report.installation.productOwnedExecutables.length !== 2) {
    throw new Error("Windows qualification must report exactly two product-owned executables.");
  }
  const [mainExecutable, uninstaller] = report.installation.productOwnedExecutables;
  validateQualifiedExecutable(
    mainExecutable,
    {
      role: "main-executable",
      fileName: "Super Synara.exe",
      path: join(installDirectory, "Super Synara.exe"),
      productName: "Super Synara",
    },
    "Installed Super Synara executable evidence",
  );
  validateQualifiedExecutable(
    uninstaller,
    {
      role: "uninstaller",
      fileName: "Uninstall Super Synara.exe",
      path: join(installDirectory, "Uninstall Super Synara.exe"),
      productName: "Super Synara",
    },
    "Installed Super Synara uninstaller evidence",
  );
  if (!Array.isArray(report.installation.vendorExecutables)) {
    throw new Error("Windows qualification must report vendor executables separately.");
  }
  for (const [index, executable] of report.installation.vendorExecutables.entries()) {
    validateVendorExecutable(executable, `Installed vendor executable evidence ${index}`);
    const relativePath = executable.path.slice(resolve(installDirectory).length + 1);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("..") ||
      resolve(installDirectory, relativePath).toLowerCase() !== executable.path.toLowerCase()
    ) {
      throw new Error("Reported vendor executable is outside the controlled install directory.");
    }
  }

  const nativeInstallerEvidence = runtime.inspectUnsignedWindowsExecutable(installerPath);
  validateUnsignedAuthenticodeEvidence(
    nativeInstallerEvidence,
    installerPath,
    "Native Windows installer inspection",
  );
  if (JSON.stringify(nativeInstallerEvidence) !== JSON.stringify(report.installer.authenticode)) {
    throw new Error("Native installer inspection differs from qualification evidence.");
  }

  return {
    qualificationReportSchemaVersion: 3,
    currentVersion: report.currentVersion,
    upgrade: report.upgrade,
    previousVersion: report.previousVersion,
    installer: report.installer,
    productOwnedExecutables: report.installation.productOwnedExecutables,
    vendorExecutables: report.installation.vendorExecutables,
  };
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export async function collectReleaseArtifactDigests(
  assetsDirectory: string,
  artifactFileNames?: ReadonlyArray<string>,
): Promise<ReadonlyArray<ReleaseArtifactDigest>> {
  const fileNames = (artifactFileNames ?? readdirSync(assetsDirectory))
    .filter((fileName) => !fileName.endsWith(".provenance.json"))
    .toSorted((left, right) => left.localeCompare(right));
  if (new Set(fileNames).size !== fileNames.length) {
    throw new Error("Release artifact file names must be unique.");
  }
  if (fileNames.length === 0) {
    throw new Error(`No release assets found in ${assetsDirectory}.`);
  }

  const artifacts: ReleaseArtifactDigest[] = [];
  for (const fileName of fileNames) {
    const filePath = join(assetsDirectory, fileName);
    const entry = lstatSync(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Release asset must be a regular file: ${fileName}`);
    }
    artifacts.push({
      fileName,
      size: entry.size,
      sha256: await hashFile(filePath),
    });
  }
  return artifacts;
}

function parseMacIdentity(output: string): {
  readonly teamId: string;
  readonly authorities: ReadonlyArray<string>;
} {
  const teamId = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (!teamId || authorities.length === 0) {
    throw new Error("codesign returned incomplete signing identity output.");
  }
  return { teamId, authorities };
}

function verifyMacSignatures(
  input: ReleaseArtifactProvenanceInput,
  artifacts: ReadonlyArray<ReleaseArtifactDigest>,
): SigningEvidence {
  if (process.platform !== "darwin") {
    throw new Error("macOS artifact verification must run on macOS.");
  }
  const expectedTeamId = input.expectedMacTeamId?.trim();
  if (!expectedTeamId) {
    throw new Error("Signed macOS provenance requires an expected Apple team ID.");
  }

  const zip = requireSingleArtifact(artifacts, ".zip");
  const diskImage = requireSingleArtifact(artifacts, ".dmg");
  const extractionRoot = mkdtempSync(join(tmpdir(), "synara-release-provenance-"));
  try {
    runCommand("ditto", ["-x", "-k", join(input.assetsDirectory, zip.fileName), extractionRoot]);
    const appBundles = readdirSync(extractionRoot).filter((entry) => {
      const candidate = join(extractionRoot, entry);
      return entry.endsWith(".app") && statSync(candidate).isDirectory();
    });
    if (appBundles.length !== 1) {
      throw new Error(`Expected one top-level app bundle in ${zip.fileName}.`);
    }

    const appBundleName = appBundles[0]!;
    const appBundlePath = join(extractionRoot, appBundleName);
    runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appBundlePath]);
    const appIdentityOutput = runCommand("codesign", ["-d", "--verbose=4", appBundlePath]);
    const appIdentity = parseMacIdentity(
      `${appIdentityOutput.stdout}\n${appIdentityOutput.stderr}`,
    );
    if (appIdentity.teamId !== expectedTeamId) {
      throw new Error(
        `macOS app team ID ${appIdentity.teamId} does not match expected ${expectedTeamId}.`,
      );
    }
    runCommand("spctl", ["--assess", "--type", "execute", "--verbose=4", appBundlePath]);
    runCommand("xcrun", ["stapler", "validate", appBundlePath]);

    const diskImagePath = join(input.assetsDirectory, diskImage.fileName);
    runCommand("codesign", ["--verify", "--strict", "--verbose=4", diskImagePath]);
    const diskImageIdentityOutput = runCommand("codesign", ["-d", "--verbose=4", diskImagePath]);
    const diskImageIdentity = parseMacIdentity(
      `${diskImageIdentityOutput.stdout}\n${diskImageIdentityOutput.stderr}`,
    );
    if (diskImageIdentity.teamId !== expectedTeamId) {
      throw new Error(
        `macOS disk image team ID ${diskImageIdentity.teamId} does not match expected ${expectedTeamId}.`,
      );
    }
    runCommand("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      diskImagePath,
    ]);

    return {
      status: "verified",
      scheme: "apple-developer-id",
      identity: {
        teamId: appIdentity.teamId,
        authorities: appIdentity.authorities,
        appBundle: appBundleName,
        diskImage: diskImage.fileName,
      },
      checks: [
        "codesign --verify app",
        "spctl --assess app",
        "stapler validate app",
        "codesign --verify dmg",
        "spctl --assess dmg",
      ],
    };
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function escapePowerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function verifyWindowsSignatures(
  input: ReleaseArtifactProvenanceInput,
  artifacts: ReadonlyArray<ReleaseArtifactDigest>,
): SigningEvidence {
  if (process.platform !== "win32") {
    throw new Error("Windows artifact verification must run on Windows.");
  }
  const expectedPublisher = input.expectedWindowsPublisher?.trim();
  if (!expectedPublisher) {
    throw new Error("Signed Windows provenance requires an expected publisher.");
  }
  const expectedSubjectDn = input.expectedWindowsSubjectDn?.trim();
  if (!expectedSubjectDn) {
    throw new Error("Signed Windows provenance requires an expected subject DN.");
  }
  const executables = artifacts.filter((artifact) => artifact.fileName.endsWith(".exe"));
  if (executables.length === 0) {
    throw new Error("Expected at least one Windows executable artifact.");
  }

  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) {
    throw new Error("SystemRoot is required for Windows signature verification.");
  }
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const identity: WindowsSignatureEvidence[] = [];
  for (const executable of executables) {
    const executablePath = resolve(input.assetsDirectory, executable.fileName);
    const literalPath = escapePowerShellLiteral(executablePath);
    const command = [
      `$signature = Get-AuthenticodeSignature -LiteralPath '${literalPath}'`,
      "$certificate = $signature.SignerCertificate",
      "$timestamp = $signature.TimeStamperCertificate",
      "[PSCustomObject]@{ Status = [string]$signature.Status; Path = $signature.Path; Subject = $certificate.Subject; Publisher = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false); Thumbprint = $certificate.Thumbprint; TimestampSubject = $timestamp.Subject; TimestampThumbprint = $timestamp.Thumbprint } | ConvertTo-Json -Compress",
    ].join("; ");
    const result = runCommand(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "None",
      "-Command",
      command,
    ]);
    if (result.stderr.trim().length > 0) {
      throw new Error(`PowerShell signature verification wrote stderr: ${result.stderr.trim()}`);
    }
    const signature = JSON.parse(result.stdout) as Record<string, unknown>;
    if (signature.Status !== "Valid") {
      throw new Error(`${executable.fileName} Authenticode status is ${String(signature.Status)}.`);
    }
    if (
      typeof signature.Path !== "string" ||
      resolve(signature.Path).toLowerCase() !== executablePath.toLowerCase()
    ) {
      throw new Error(`${executable.fileName} signature path does not match the collected asset.`);
    }
    if (signature.Publisher !== expectedPublisher) {
      throw new Error(
        `${executable.fileName} publisher ${String(signature.Publisher)} does not match expected ${expectedPublisher}.`,
      );
    }
    if (
      typeof signature.Subject !== "string" ||
      !matchesDistinguishedName(expectedSubjectDn, signature.Subject)
    ) {
      throw new Error(
        `${executable.fileName} subject ${String(signature.Subject)} does not match expected ${expectedSubjectDn}.`,
      );
    }
    if (
      typeof signature.Subject !== "string" ||
      typeof signature.Thumbprint !== "string" ||
      !/^[0-9a-f]{40,64}$/i.test(signature.Thumbprint) ||
      typeof signature.TimestampSubject !== "string" ||
      typeof signature.TimestampThumbprint !== "string" ||
      !/^[0-9a-f]{40,64}$/i.test(signature.TimestampThumbprint)
    ) {
      throw new Error(`${executable.fileName} returned incomplete certificate identity.`);
    }
    identity.push({
      fileName: executable.fileName,
      subject: signature.Subject,
      publisher: expectedPublisher,
      thumbprint: signature.Thumbprint.toUpperCase(),
      timestampSubject: signature.TimestampSubject,
      timestampThumbprint: signature.TimestampThumbprint.toUpperCase(),
    });
  }

  return {
    status: "verified",
    scheme: "windows-authenticode",
    identity,
    checks: [
      "Get-AuthenticodeSignature Status=Valid",
      "publisher exact match",
      "subject DN field match",
    ],
  };
}

function resolveSigningEvidence(
  input: ReleaseArtifactProvenanceInput,
  artifacts: ReadonlyArray<ReleaseArtifactDigest>,
  runtime: ReleaseArtifactProvenanceRuntime,
): SigningEvidence {
  const distributionKind = resolveDistributionKind(input);
  if (distributionKind === "github-unsigned-prerelease") {
    if (input.platform === "linux") {
      throw new Error("Unsigned GitHub prereleases support only Windows and macOS.");
    }
    const publishableArtifact = requireSingleArtifact(
      artifacts,
      input.platform === "mac" ? ".dmg" : ".exe",
    );
    if (input.platform === "win") {
      const installer = publishableArtifact;
      if (artifacts.length !== 1) {
        throw new Error("Windows unsigned provenance must describe exactly one staged artifact.");
      }
      const stagedExecutables = readdirSync(input.assetsDirectory).filter((fileName) =>
        fileName.endsWith(".exe"),
      );
      if (stagedExecutables.length !== 1 || stagedExecutables[0] !== installer.fileName) {
        throw new Error("Windows unsigned provenance requires the exact sole staged installer.");
      }
      return {
        status: "unsigned-prerelease",
        scheme: "none",
        thirdPartyComponents: "not-applicable",
        identity: readWindowsQualificationReport(input, installer, runtime),
        checks: [
          "outer installer Get-AuthenticodeSignature Status=NotSigned",
          "installed product-owned executables Status=NotSigned",
          "signer and timestamp certificates absent",
          "qualification installer SHA-256 exact match",
          "vendor executables inventoried separately without an unsigned-signature claim",
        ],
      };
    }
    if (!input.macSignatureReport || !input.macSignatureAllowlist) {
      throw new Error(
        "Unsigned macOS prerelease provenance requires a signature report and reviewed allowlist.",
      );
    }
    const identity = validateMacUnsignedSignatureReport(
      input.macSignatureReport,
      input.macSignatureAllowlist,
    );
    if (
      identity.diskImage.fileName !== publishableArtifact.fileName ||
      identity.diskImage.size !== publishableArtifact.size ||
      identity.diskImage.sha256 !== publishableArtifact.sha256
    ) {
      throw new Error(
        `macOS signature report disk-image evidence does not match staged ${publishableArtifact.fileName}.`,
      );
    }
    return {
      status: "unsigned-prerelease",
      scheme: "ad-hoc-only",
      thirdPartyComponents: "reviewed-allowlist",
      identity,
      checks: [
        "all product-owned binaries ad-hoc-only",
        "reviewed third-party signature allowlist exact match",
        "published DMG filename, size, and SHA-256 match signature report",
        "published DMG has no Developer ID signature",
        "DMG and app notarization tickets explicitly absent",
      ],
    };
  }

  if (input.platform === "linux") {
    if (input.signed) {
      throw new Error("Linux release provenance cannot claim an unsupported signing scheme.");
    }
    requireSingleArtifact(artifacts, ".AppImage");
    return {
      status: "not-applicable",
      scheme: "none",
      identity: null,
      checks: ["AppImage payload present"],
    };
  }

  if (!input.signed) {
    if (input.publication) {
      throw new Error(`Publishing ${input.platform} artifacts requires verified signing.`);
    }
    requireSingleArtifact(artifacts, input.platform === "mac" ? ".dmg" : ".exe");
    return {
      status: "unsigned-build-only",
      scheme: "none",
      identity: null,
      checks: ["publication disabled"],
    };
  }

  return input.platform === "mac"
    ? verifyMacSignatures(input, artifacts)
    : verifyWindowsSignatures(input, artifacts);
}

function resolveDistributionKind(input: ReleaseArtifactProvenanceInput): ReleaseDistributionKind {
  return input.distributionKind ?? (input.signed ? "signed-release" : "build-only");
}

function resolveDistribution(
  input: ReleaseArtifactProvenanceInput,
): ReleaseArtifactProvenanceManifest["distribution"] {
  const kind = resolveDistributionKind(input);
  if (kind === "github-unsigned-prerelease") {
    return {
      kind,
      repository: input.distributionRepository!,
      tag: input.sourceTag,
      prerelease: true,
      latest: false,
      updaterFeed: false,
    };
  }
  if (kind === "signed-release") {
    return {
      kind,
      repository: input.distributionRepository?.trim() || null,
      tag: input.sourceTag,
      prerelease: input.distributionPrerelease ?? input.version.includes("-"),
      latest: input.distributionLatest ?? null,
      updaterFeed: input.updaterFeed ?? true,
    };
  }
  return {
    kind,
    repository: null,
    tag: input.sourceTag,
    prerelease: false,
    latest: false,
    updaterFeed: false,
  };
}

function validateInput(input: ReleaseArtifactProvenanceInput): void {
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommit)) {
    throw new Error("Artifact provenance requires a full source commit.");
  }
  if (!/^[0-9a-f]{64}$/i.test(input.lockfileSha256)) {
    throw new Error("Artifact provenance requires a bun.lock SHA-256.");
  }
  if (
    input.outputFileName !== undefined &&
    !/^artifact-(?:windows-x64|macos-arm64|linux-[a-z0-9_-]+|mac-[a-z0-9_-]+|win-[a-z0-9_-]+)\.provenance\.json$/.test(
      input.outputFileName,
    )
  ) {
    throw new Error(`Invalid artifact provenance output name: ${input.outputFileName}.`);
  }
  if (
    input.absorbedUpstreamSha !== undefined &&
    !/^[0-9a-f]{40}$/i.test(input.absorbedUpstreamSha)
  ) {
    throw new Error("Artifact provenance requires a full absorbed upstream SHA.");
  }

  const distributionKind = resolveDistributionKind(input);
  if (distributionKind === "github-unsigned-prerelease") {
    if (!input.publication || input.signed) {
      throw new Error("Unsigned GitHub prerelease policy must be public and unsigned.");
    }
    if (input.platform !== "win" && input.platform !== "mac") {
      throw new Error("Unsigned GitHub prerelease policy supports only Windows and macOS.");
    }
    if (!/^\d+\.\d+\.\d+-super\.[1-9]\d*$/.test(input.version)) {
      throw new Error(`Invalid Super Synara prerelease version: ${input.version}.`);
    }
    if (input.sourceTag !== `super-v${input.version}`) {
      throw new Error(
        `Source tag ${input.sourceTag ?? "<missing>"} does not match Super Synara version ${input.version}.`,
      );
    }
    if (input.distributionRepository !== "slashdevcorpse/synara") {
      throw new Error("Unsigned prerelease repository must be slashdevcorpse/synara.");
    }
    if (
      input.distributionPrerelease === false ||
      input.distributionLatest === true ||
      input.updaterFeed === true
    ) {
      throw new Error(
        "Unsigned prerelease distribution flags must remain prerelease, non-Latest, and updater-free.",
      );
    }
    if (!input.absorbedUpstreamSha) {
      throw new Error("Unsigned prerelease provenance requires the absorbed upstream SHA.");
    }
    if (input.platform === "win" && !input.windowsQualificationReportPath?.trim()) {
      throw new Error("Windows unsigned provenance requires a qualification report path.");
    }
    if (input.platform === "mac" && input.windowsQualificationReportPath !== undefined) {
      throw new Error("macOS provenance cannot consume Windows qualification evidence.");
    }
    return;
  }

  if (input.sourceTag !== null && input.sourceTag !== `v${input.version}`) {
    throw new Error(`Source tag ${input.sourceTag} does not match version ${input.version}.`);
  }
  if (input.publication && input.sourceTag === null) {
    throw new Error("Published artifact provenance requires an exact source tag.");
  }
  if (distributionKind === "build-only" && input.publication) {
    throw new Error("Build-only provenance cannot authorize public distribution.");
  }
  if (distributionKind === "signed-release" && input.publication && !input.signed) {
    throw new Error("Signed-release publication requires verified signing.");
  }
}

export async function writeReleaseArtifactProvenance(
  input: ReleaseArtifactProvenanceInput,
): Promise<{ readonly manifest: ReleaseArtifactProvenanceManifest; readonly path: string }> {
  return writeReleaseArtifactProvenanceWithRuntime(input, nativeProvenanceRuntime);
}

/** Cross-platform test seam. Production callers must use writeReleaseArtifactProvenance. */
export async function writeReleaseArtifactProvenanceWithRuntimeForTest(
  input: ReleaseArtifactProvenanceInput,
  runtime: ReleaseArtifactProvenanceRuntime,
): Promise<{ readonly manifest: ReleaseArtifactProvenanceManifest; readonly path: string }> {
  return writeReleaseArtifactProvenanceWithRuntime(input, runtime);
}

async function writeReleaseArtifactProvenanceWithRuntime(
  input: ReleaseArtifactProvenanceInput,
  runtime: ReleaseArtifactProvenanceRuntime,
): Promise<{ readonly manifest: ReleaseArtifactProvenanceManifest; readonly path: string }> {
  validateInput(input);
  const artifacts = await collectReleaseArtifactDigests(
    input.assetsDirectory,
    input.artifactFileNames,
  );
  const manifest: ReleaseArtifactProvenanceManifest = {
    schemaVersion: 2,
    publication: input.publication,
    distribution: resolveDistribution(input),
    platform: input.platform,
    arch: input.arch,
    target: input.target,
    version: input.version,
    source: {
      commit: input.sourceCommit.toLowerCase(),
      tag: input.sourceTag,
      lockfileSha256: input.lockfileSha256.toLowerCase(),
      absorbedUpstreamSha: input.absorbedUpstreamSha?.toLowerCase() ?? null,
    },
    signing: resolveSigningEvidence(input, artifacts, runtime),
    artifacts,
  };
  const outputPath = join(
    input.assetsDirectory,
    input.outputFileName ?? `artifact-${input.platform}-${input.arch}.provenance.json`,
  );
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { manifest, path: outputPath };
}
