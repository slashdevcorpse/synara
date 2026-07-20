import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME,
  writeReleaseArtifactProvenance,
  writeReleaseArtifactProvenanceWithRuntimeForTest,
} from "./release-artifact-provenance.ts";
import {
  exactSuperSynaraReleaseAllowlist,
  prepareSuperSynaraRelease,
  superSynaraReleaseFileNames,
  verifyPreparedSuperSynaraRelease,
} from "./super-synara-release-admission.ts";
import type { MacSignatureAllowlist } from "./super-synara-macos-signatures.ts";

const roots: string[] = [];
const coordinates = {
  version: "0.5.5-super.1",
  tag: "super-v0.5.5-super.1",
  sourceCommit: "a".repeat(40),
  absorbedUpstreamSha: "b".repeat(40),
};
const macSignatureAllowlist: MacSignatureAllowlist = {
  schemaVersion: 1,
  electronVersion: "40.10.6",
  productOwnedPaths: [".", "Contents/MacOS/Super Synara", "Contents/Helpers/synara-appsnap-helper"],
  thirdParty: [
    {
      path: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      identifier: "com.github.Electron.framework",
      teamId: null,
      authorities: [],
      scheme: "ad-hoc-only",
    },
  ],
};

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Test fixture field ${field} is not an object.`);
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  if (!fieldValue || typeof fieldValue !== "object" || Array.isArray(fieldValue)) {
    throw new Error(`Test fixture field ${field} is not an object.`);
  }
  return fieldValue as Record<string, unknown>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function createPlatformStaging(): Promise<{
  directory: string;
  licensePath: string;
  macSignatureAllowlist: MacSignatureAllowlist;
  releaseScope: "windows-and-macos";
}> {
  const directory = mkdtempSync(join(tmpdir(), "super-synara-release-admission-test-"));
  const licenseRoot = mkdtempSync(join(tmpdir(), "super-synara-release-license-test-"));
  roots.push(directory, licenseRoot);
  const names = superSynaraReleaseFileNames(coordinates.version);
  writeFileSync(join(directory, names.windowsInstaller), "windows-installer");
  const diskImageBytes = "macos-dmg";
  writeFileSync(join(directory, names.macosDiskImage), diskImageBytes);
  const common = {
    version: coordinates.version,
    sourceCommit: coordinates.sourceCommit,
    sourceTag: coordinates.tag,
    lockfileSha256: "c".repeat(64),
    publication: true,
    signed: false,
    distributionKind: "github-unsigned-prerelease" as const,
    distributionRepository: "slashdevcorpse/synara",
    distributionPrerelease: true,
    distributionLatest: false,
    updaterFeed: false,
    absorbedUpstreamSha: coordinates.absorbedUpstreamSha,
  };
  const installerPath = join(directory, names.windowsInstaller);
  const installDirectory = join(directory, "controlled-install", "Super Synara");
  const unsignedEvidence = (path: string) => ({
    path: resolve(path),
    status: "NotSigned" as const,
    signerCertificate: null,
    timeStamperCertificate: null,
  });
  writeFileSync(
    join(directory, WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME),
    JSON.stringify({
      schemaVersion: 3,
      platform: "windows-x64",
      currentVersion: coordinates.version,
      upgrade: "not-run-no-previous-release",
      previousVersion: null,
      installer: {
        role: "installer",
        fileName: names.windowsInstaller,
        path: resolve(installerPath),
        productName: "Super Synara",
        sha256: createHash("sha256").update("windows-installer").digest("hex"),
        authenticode: unsignedEvidence(installerPath),
      },
      sideBySide: {
        upstreamStartupProven: true,
        upstreamControlledCleanupProven: true,
        concurrentOverlapProven: true,
        distinctProcessLocksProven: true,
        distinctProfileRootsProven: true,
        upstreamExecutablePreserved: true,
        upstreamRegistrationPreserved: true,
        upstreamProfileSentinelsPreserved: true,
        upstreamUninstallCleanupProven: true,
      },
      isolation: {
        liveProfilesRead: false,
        liveProfilesMutated: false,
        upstreamRegistrationPreserved: true,
        upstreamSentinelsPreserved: true,
        superStateWasTemporary: true,
      },
      installation: {
        productName: "Super Synara",
        executableName: "Super Synara.exe",
        registrationScope: "current-user-64",
        startupProven: true,
        cleanExitProven: true,
        uninstallCleanupProven: true,
        installDirectory,
        productOwnedExecutables: [
          {
            role: "main-executable",
            fileName: "Super Synara.exe",
            path: join(installDirectory, "Super Synara.exe"),
            productName: "Super Synara",
            sha256: "d".repeat(64),
            authenticode: unsignedEvidence(join(installDirectory, "Super Synara.exe")),
          },
          {
            role: "uninstaller",
            fileName: "Uninstall Super Synara.exe",
            path: join(installDirectory, "Uninstall Super Synara.exe"),
            productName: "Super Synara",
            sha256: "e".repeat(64),
            authenticode: unsignedEvidence(join(installDirectory, "Uninstall Super Synara.exe")),
          },
        ],
        vendorExecutables: [],
      },
    }),
  );
  await writeReleaseArtifactProvenanceWithRuntimeForTest(
    {
      ...common,
      assetsDirectory: directory,
      artifactFileNames: [names.windowsInstaller],
      outputFileName: names.windowsProvenance,
      platform: "win",
      arch: "x64",
      target: "nsis",
      windowsQualificationReportPath: join(
        directory,
        WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME,
      ),
    },
    {
      inspectUnsignedWindowsExecutable: unsignedEvidence,
      windowsQualificationReportDirectory: directory,
    },
  );
  unlinkSync(join(directory, WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME));
  await writeReleaseArtifactProvenance({
    ...common,
    assetsDirectory: directory,
    artifactFileNames: [names.macosDiskImage],
    outputFileName: names.macosProvenance,
    platform: "mac",
    arch: "arm64",
    target: "dmg",
    macSignatureAllowlist,
    macSignatureReport: {
      schemaVersion: 2,
      diskImage: {
        fileName: names.macosDiskImage,
        size: Buffer.byteLength(diskImageBytes),
        sha256: createHash("sha256").update(diskImageBytes).digest("hex"),
        codeSignature: {
          command: "codesign -d --verbose=4",
          exitCode: 1,
          output: "code object is not signed at all",
          status: "unsigned",
          teamId: null,
          authorities: [],
          cdHash: null,
          signature: null,
        },
      },
      appBundle: "Super Synara.app",
      electronVersion: "40.10.6",
      deepVerification: {
        command: "codesign --verify --deep --strict --verbose=4",
        exitCode: 0,
        output: "valid on disk",
      },
      notarization: {
        diskImage: {
          ticket: "absent",
          evidence: {
            command: "xcrun stapler validate",
            exitCode: 65,
            output:
              'CloudKit query for Super Synara.dmg (2/abc) failed due to "Record not found".\nCould not find base64 encoded ticket in response for 2/abc',
          },
        },
        appBundle: {
          ticket: "absent",
          evidence: {
            command: "xcrun stapler validate",
            exitCode: 65,
            output:
              'CloudKit query for Super Synara.app (2/def) failed due to "Record not found".\nCould not find base64 encoded ticket in response for 2/def',
          },
        },
      },
      productOwned: [
        {
          path: ".",
          identifier: "io.github.slashdevcorpse.supersynara",
          teamId: null,
          authorities: [],
          cdHash: "f".repeat(40),
          signature: "adhoc",
          scheme: "ad-hoc-only",
        },
        {
          path: "Contents/MacOS/Super Synara",
          identifier: "io.github.slashdevcorpse.supersynara",
          teamId: null,
          authorities: [],
          cdHash: "d".repeat(40),
          signature: "adhoc",
          scheme: "ad-hoc-only",
        },
        {
          path: "Contents/Helpers/synara-appsnap-helper",
          identifier: "synara-appsnap-helper",
          teamId: null,
          authorities: [],
          cdHash: "a".repeat(40),
          signature: "adhoc",
          scheme: "ad-hoc-only",
        },
      ],
      thirdParty: [
        {
          path: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
          identifier: "com.github.Electron.framework",
          teamId: null,
          authorities: [],
          cdHash: "e".repeat(40),
          signature: "adhoc",
          scheme: "ad-hoc-only",
        },
      ],
    },
  });
  const licensePath = join(licenseRoot, "LICENSE");
  writeFileSync(licensePath, "MIT fixture\n");
  return {
    directory,
    licensePath,
    macSignatureAllowlist,
    releaseScope: "windows-and-macos",
  };
}

async function createWindowsPlatformStaging(): Promise<{
  directory: string;
  licensePath: string;
}> {
  const staged = await createPlatformStaging();
  const names = superSynaraReleaseFileNames(coordinates.version);
  unlinkSync(join(staged.directory, names.macosDiskImage));
  unlinkSync(join(staged.directory, names.macosProvenance));
  return { directory: staged.directory, licensePath: staged.licensePath };
}

describe("Super Synara release admission", () => {
  it("creates the exact eight-file set with canonical checksums and a complete index", async () => {
    const { directory, licensePath, macSignatureAllowlist, releaseScope } =
      await createPlatformStaging();
    const index = prepareSuperSynaraRelease({
      directory,
      licensePath,
      releaseScope,
      macSignatureAllowlist,
      coordinates,
      maxTotalBytes: 10_000_000,
    });
    expect(index.files.map((file) => file.fileName)).toEqual(
      exactSuperSynaraReleaseAllowlist(coordinates.version, releaseScope).filter(
        (file) => file !== "release-index.json",
      ),
    );
    const checksums = readFileSync(join(directory, "SHA256SUMS.txt"), "utf8");
    expect(checksums.endsWith("\n")).toBe(true);
    expect(checksums.split("\n").filter(Boolean)).toHaveLength(6);
    for (const line of checksums.split("\n").filter(Boolean)) {
      expect(line).toMatch(/^[0-9a-f]{64}  [^\r\n]+$/);
    }
    expect(readFileSync(join(directory, "UNSIGNED-BUILD.md"), "utf8")).toContain(
      "Do not disable Gatekeeper",
    );
    expect(readFileSync(join(directory, "UNSIGNED-BUILD.md"), "utf8")).toContain(
      "License and attribution: MIT; the complete license and copyright notice are included in the attached `LICENSE` file.",
    );
    expect(
      verifyPreparedSuperSynaraRelease({
        directory,
        releaseScope,
        macSignatureAllowlist,
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toEqual(index);
  });

  it("creates and verifies the exact Windows-only six-file release", async () => {
    const staged = await createWindowsPlatformStaging();
    const releaseScope = "windows-only" as const;
    const index = prepareSuperSynaraRelease({
      ...staged,
      releaseScope,
      coordinates,
      maxTotalBytes: 10_000_000,
    });

    expect(index.platforms).toEqual(["windows-x64"]);
    expect(index.files.map((file) => file.fileName)).toEqual(
      exactSuperSynaraReleaseAllowlist(coordinates.version, releaseScope).filter(
        (file) => file !== "release-index.json",
      ),
    );
    expect(
      readFileSync(join(staged.directory, "SHA256SUMS.txt"), "utf8").split("\n").filter(Boolean),
    ).toHaveLength(4);
    const warning = readFileSync(join(staged.directory, "UNSIGNED-BUILD.md"), "utf8");
    expect(warning).toContain("Windows x64 build");
    expect(warning).toContain("SHA-256 for the installer");
    expect(warning).not.toMatch(/Apple|macOS|Gatekeeper|DMG/);
    expect(
      verifyPreparedSuperSynaraRelease({
        directory: staged.directory,
        releaseScope,
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toEqual(index);
  });

  it("keeps release scopes fail closed on macOS policy and asset drift", async () => {
    const combined = await createPlatformStaging();
    const { macSignatureAllowlist: _macSignatureAllowlist, ...combinedWithoutAllowlist } = combined;
    expect(() =>
      prepareSuperSynaraRelease({
        ...combinedWithoutAllowlist,
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toThrow("Combined release admission requires");

    const windows = await createWindowsPlatformStaging();
    writeFileSync(join(windows.directory, "unexpected-macos-arm64.dmg"), "mac payload");
    expect(() =>
      prepareSuperSynaraRelease({
        ...windows,
        releaseScope: "windows-only",
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toThrow("Prohibited Super Synara release asset");

    const windowsWithMacPolicy = await createWindowsPlatformStaging();
    expect(() =>
      prepareSuperSynaraRelease({
        ...windowsWithMacPolicy,
        releaseScope: "windows-only",
        macSignatureAllowlist,
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toThrow("must not include a macOS signature allowlist");
  });

  it("rejects prohibited files, byte-cap overflow, and post-admission mutation", async () => {
    const prohibited = await createPlatformStaging();
    writeFileSync(join(prohibited.directory, "latest.yml"), "updater");
    expect(() =>
      prepareSuperSynaraRelease({
        ...prohibited,
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toThrow("Prohibited");

    const capped = await createPlatformStaging();
    expect(() =>
      prepareSuperSynaraRelease({
        ...capped,
        coordinates,
        maxTotalBytes: 1,
      }),
    ).toThrow("exceeding cap");

    const mutated = await createPlatformStaging();
    prepareSuperSynaraRelease({
      ...mutated,
      coordinates,
      maxTotalBytes: 10_000_000,
    });
    writeFileSync(
      join(mutated.directory, superSynaraReleaseFileNames(coordinates.version).windowsInstaller),
      "changed bytes",
    );
    expect(() =>
      verifyPreparedSuperSynaraRelease({
        directory: mutated.directory,
        releaseScope: mutated.releaseScope,
        macSignatureAllowlist: mutated.macSignatureAllowlist,
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toThrow("bytes differ from platform provenance");
  });

  it("rejects forged signed product-owned evidence at final release admission", async () => {
    const staged = await createPlatformStaging();
    const provenancePath = join(
      staged.directory,
      superSynaraReleaseFileNames(coordinates.version).windowsProvenance,
    );
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    provenance.signing.identity.productOwnedExecutables[1].authenticode.status = "Valid";
    provenance.signing.identity.productOwnedExecutables[1].authenticode.signerCertificate = {
      Subject: "CN=Unexpected",
    };
    writeFileSync(provenancePath, JSON.stringify(provenance));

    expect(() =>
      prepareSuperSynaraRelease({
        ...staged,
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toThrow("does not bind exact unsigned Windows product-owned binaries");
  });

  it("rejects malformed macOS signing identity at final release preparation", async () => {
    for (const scenario of [
      "product-owned",
      "reviewed-third-party",
      "disk-image",
      "deep-verification",
      "notarization",
    ] as const) {
      const staged = await createPlatformStaging();
      const provenancePath = join(
        staged.directory,
        superSynaraReleaseFileNames(coordinates.version).macosProvenance,
      );
      const provenance: unknown = JSON.parse(readFileSync(provenancePath, "utf8"));
      const identity = objectField(objectField(provenance, "signing"), "identity");
      switch (scenario) {
        case "product-owned":
          identity.productOwned = [];
          break;
        case "reviewed-third-party":
          identity.thirdParty = [];
          break;
        case "disk-image":
          objectField(identity, "diskImage").sha256 = "0".repeat(64);
          break;
        case "deep-verification":
          objectField(identity, "deepVerification").exitCode = 1;
          break;
        case "notarization":
          objectField(
            objectField(objectField(identity, "notarization"), "appBundle"),
            "evidence",
          ).output = "Could not establish secure connection NSURLErrorDomain";
          break;
      }
      writeFileSync(provenancePath, JSON.stringify(provenance));

      expect(() =>
        prepareSuperSynaraRelease({
          ...staged,
          coordinates,
          maxTotalBytes: 10_000_000,
        }),
      ).toThrow();
    }
  });

  it("revalidates macOS signing identity against the reviewed allowlist", async () => {
    const staged = await createPlatformStaging();
    prepareSuperSynaraRelease({
      ...staged,
      coordinates,
      maxTotalBytes: 10_000_000,
    });
    const provenancePath = join(
      staged.directory,
      superSynaraReleaseFileNames(coordinates.version).macosProvenance,
    );
    const provenance: unknown = JSON.parse(readFileSync(provenancePath, "utf8"));
    objectField(objectField(provenance, "signing"), "identity").thirdParty = [];
    writeFileSync(provenancePath, JSON.stringify(provenance));

    expect(() =>
      verifyPreparedSuperSynaraRelease({
        directory: staged.directory,
        releaseScope: staged.releaseScope,
        macSignatureAllowlist: staged.macSignatureAllowlist,
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toThrow("Third-party signature paths differ from the reviewed allowlist");
  });
});
