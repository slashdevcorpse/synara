import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME,
  writeReleaseArtifactProvenance,
  writeReleaseArtifactProvenanceWithRuntimeForTest,
  type ReleaseArtifactProvenanceInput,
} from "./release-artifact-provenance.ts";
import type { MacUnsignedSignatureReport } from "./super-synara-macos-signatures.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createAssets(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-artifact-provenance-test-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "Synara-1.2.3-x64.AppImage"), "app-image-bytes");
  writeFileSync(join(root, "latest-linux.yml"), "version: 1.2.3\n");
  return root;
}

function createNativeAsset(fileName: string, bytes: string): string {
  const root = mkdtempSync(join(tmpdir(), "super-synara-artifact-provenance-test-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, fileName), bytes);
  return root;
}

function authenticode(path: string): Record<string, unknown> {
  return {
    path: resolve(path),
    status: "NotSigned",
    signerCertificate: null,
    timeStamperCertificate: null,
  };
}

function createWindowsQualificationReport(
  assetsDirectory: string,
  installer: string,
  version: string,
): Record<string, any> {
  const installerPath = join(assetsDirectory, installer);
  const installDirectory = join(assetsDirectory, "controlled-install", "Super Synara");
  const mainPath = join(installDirectory, "Super Synara.exe");
  const uninstallerPath = join(installDirectory, "Uninstall Super Synara.exe");
  const report = {
    schemaVersion: 3,
    platform: "windows-x64",
    currentVersion: version,
    upgrade: "not-run-no-previous-release",
    previousVersion: null,
    installer: {
      role: "installer",
      fileName: installer,
      path: resolve(installerPath),
      productName: "Super Synara",
      sha256: createHash("sha256").update("unsigned-installer").digest("hex"),
      authenticode: authenticode(installerPath),
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
          path: mainPath,
          productName: "Super Synara",
          sha256: "d".repeat(64),
          authenticode: authenticode(mainPath),
        },
        {
          role: "uninstaller",
          fileName: "Uninstall Super Synara.exe",
          path: uninstallerPath,
          productName: "Super Synara",
          sha256: "e".repeat(64),
          authenticode: authenticode(uninstallerPath),
        },
      ],
      vendorExecutables: [],
    },
  };
  writeFileSync(
    join(assetsDirectory, WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME),
    JSON.stringify(report),
  );
  return report;
}

function windowsUnsignedInput(
  assetsDirectory: string,
  installer: string,
  version: string,
): ReleaseArtifactProvenanceInput {
  return {
    assetsDirectory,
    artifactFileNames: [installer],
    outputFileName: "artifact-windows-x64.provenance.json",
    platform: "win",
    arch: "x64",
    target: "nsis",
    version,
    sourceCommit: "a".repeat(40),
    sourceTag: `super-v${version}`,
    lockfileSha256: "b".repeat(64),
    publication: true,
    signed: false,
    distributionKind: "github-unsigned-prerelease",
    distributionRepository: "slashdevcorpse/synara",
    distributionPrerelease: true,
    distributionLatest: false,
    updaterFeed: false,
    absorbedUpstreamSha: "c".repeat(40),
    windowsQualificationReportPath: join(
      assetsDirectory,
      WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME,
    ),
  };
}

describe("release artifact provenance", () => {
  it("hashes the exact collected Linux assets into a deterministic manifest", async () => {
    const assetsDirectory = createAssets();
    const result = await writeReleaseArtifactProvenance({
      assetsDirectory,
      platform: "linux",
      arch: "x64",
      target: "AppImage",
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceTag: null,
      lockfileSha256: "b".repeat(64),
      publication: false,
      signed: false,
    });

    expect(result.path).toBe(join(assetsDirectory, "artifact-linux-x64.provenance.json"));
    expect(result.manifest.target).toBe("AppImage");
    expect(result.manifest.distribution.kind).toBe("build-only");
    expect(result.manifest.signing).toEqual({
      status: "not-applicable",
      scheme: "none",
      identity: null,
      checks: ["AppImage payload present"],
    });
    expect(result.manifest.artifacts.map((artifact) => artifact.fileName)).toEqual([
      "latest-linux.yml",
      "Synara-1.2.3-x64.AppImage",
    ]);
    expect(
      result.manifest.artifacts.find(
        (artifact) => artifact.fileName === "Synara-1.2.3-x64.AppImage",
      )?.sha256,
    ).toBe(createHash("sha256").update("app-image-bytes").digest("hex"));
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual(result.manifest);
  });

  it("rejects publication without an exact source tag", async () => {
    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createAssets(),
        platform: "linux",
        arch: "x64",
        target: "AppImage",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: null,
        lockfileSha256: "b".repeat(64),
        publication: true,
        signed: false,
      }),
    ).rejects.toThrow("requires an exact source tag");
  });

  it("records truthful Windows unsigned-prerelease distribution evidence", async () => {
    const version = "0.5.5-super.1";
    const installer = `Super-Synara-${version}-windows-x64-unsigned.exe`;
    const assetsDirectory = createNativeAsset(installer, "unsigned-installer");
    createWindowsQualificationReport(assetsDirectory, installer, version);
    const result = await writeReleaseArtifactProvenanceWithRuntimeForTest(
      windowsUnsignedInput(assetsDirectory, installer, version),
      {
        inspectUnsignedWindowsExecutable: (path) => authenticode(path) as any,
        windowsQualificationReportDirectory: assetsDirectory,
      },
    );

    expect(result.manifest).toMatchObject({
      schemaVersion: 2,
      publication: true,
      distribution: {
        kind: "github-unsigned-prerelease",
        repository: "slashdevcorpse/synara",
        tag: `super-v${version}`,
        prerelease: true,
        latest: false,
        updaterFeed: false,
      },
      signing: {
        status: "unsigned-prerelease",
        scheme: "none",
        thirdPartyComponents: "not-applicable",
        identity: {
          qualificationReportSchemaVersion: 3,
          installer: {
            sha256: createHash("sha256").update("unsigned-installer").digest("hex"),
            authenticode: {
              status: "NotSigned",
              signerCertificate: null,
              timeStamperCertificate: null,
            },
          },
          productOwnedExecutables: [
            { role: "main-executable", fileName: "Super Synara.exe" },
            { role: "uninstaller", fileName: "Uninstall Super Synara.exe" },
          ],
        },
      },
    });
    expect(result.path.endsWith("artifact-windows-x64.provenance.json")).toBe(true);
  });

  it("rejects missing, signed, and digest-mismatched Windows qualification evidence", async () => {
    const version = "0.5.5-super.3";
    const installer = `Super-Synara-${version}-windows-x64-unsigned.exe`;

    const missingDirectory = createNativeAsset(installer, "unsigned-installer");
    await expect(
      writeReleaseArtifactProvenanceWithRuntimeForTest(
        windowsUnsignedInput(missingDirectory, installer, version),
        {
          inspectUnsignedWindowsExecutable: (path) => authenticode(path) as any,
          windowsQualificationReportDirectory: missingDirectory,
        },
      ),
    ).rejects.toThrow("requires windows-installer-qualification.json");

    const signedDirectory = createNativeAsset(installer, "unsigned-installer");
    const signedReport = createWindowsQualificationReport(signedDirectory, installer, version);
    signedReport.installation.productOwnedExecutables[0].authenticode.status = "Valid";
    writeFileSync(
      join(signedDirectory, WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME),
      JSON.stringify(signedReport),
    );
    await expect(
      writeReleaseArtifactProvenanceWithRuntimeForTest(
        windowsUnsignedInput(signedDirectory, installer, version),
        {
          inspectUnsignedWindowsExecutable: (path) => authenticode(path) as any,
          windowsQualificationReportDirectory: signedDirectory,
        },
      ),
    ).rejects.toThrow("NotSigned Authenticode evidence");

    const signedOuterDirectory = createNativeAsset(installer, "unsigned-installer");
    createWindowsQualificationReport(signedOuterDirectory, installer, version);
    await expect(
      writeReleaseArtifactProvenanceWithRuntimeForTest(
        windowsUnsignedInput(signedOuterDirectory, installer, version),
        {
          inspectUnsignedWindowsExecutable: (path) =>
            ({
              ...authenticode(path),
              status: "Valid",
              signerCertificate: { Subject: "CN=Unexpected" },
            }) as any,
          windowsQualificationReportDirectory: signedOuterDirectory,
        },
      ),
    ).rejects.toThrow("Native Windows installer inspection");

    const mismatchDirectory = createNativeAsset(installer, "unsigned-installer");
    const mismatchReport = createWindowsQualificationReport(mismatchDirectory, installer, version);
    mismatchReport.installer.sha256 = "f".repeat(64);
    writeFileSync(
      join(mismatchDirectory, WINDOWS_INSTALLER_QUALIFICATION_REPORT_FILE_NAME),
      JSON.stringify(mismatchReport),
    );
    await expect(
      writeReleaseArtifactProvenanceWithRuntimeForTest(
        windowsUnsignedInput(mismatchDirectory, installer, version),
        {
          inspectUnsignedWindowsExecutable: (path) => authenticode(path) as any,
          windowsQualificationReportDirectory: mismatchDirectory,
        },
      ),
    ).rejects.toThrow("SHA-256 differs");
  });

  it("validates macOS ad-hoc and reviewed-vendor evidence without weakening signed releases", async () => {
    const version = "0.5.5-super.2";
    const diskImage = `Super-Synara-${version}-macos-arm64-unsigned.dmg`;
    const result = await writeReleaseArtifactProvenance({
      assetsDirectory: createNativeAsset(diskImage, "unsigned-dmg"),
      artifactFileNames: [diskImage],
      outputFileName: "artifact-macos-arm64.provenance.json",
      platform: "mac",
      arch: "arm64",
      target: "dmg",
      version,
      sourceCommit: "d".repeat(40),
      sourceTag: `super-v${version}`,
      lockfileSha256: "e".repeat(64),
      publication: true,
      signed: false,
      distributionKind: "github-unsigned-prerelease",
      distributionRepository: "slashdevcorpse/synara",
      updaterFeed: false,
      absorbedUpstreamSha: "f".repeat(40),
      macSignatureAllowlist: {
        schemaVersion: 1,
        electronVersion: "40.10.6",
        productOwnedPaths: [
          ".",
          "Contents/MacOS/Super Synara",
          "Contents/Helpers/synara-appsnap-helper",
        ],
        thirdParty: [
          {
            path: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
            identifier: "com.github.Electron.framework",
            teamId: null,
            authorities: [],
            scheme: "ad-hoc-only",
          },
        ],
      },
      macSignatureReport: {
        schemaVersion: 2,
        diskImage: {
          fileName: diskImage,
          size: Buffer.byteLength("unsigned-dmg"),
          sha256: createHash("sha256").update("unsigned-dmg").digest("hex"),
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
            cdHash: "3".repeat(40),
            signature: "adhoc",
            scheme: "ad-hoc-only",
          },
          {
            path: "Contents/MacOS/Super Synara",
            identifier: "io.github.slashdevcorpse.supersynara",
            teamId: null,
            authorities: [],
            cdHash: "1".repeat(40),
            signature: "adhoc",
            scheme: "ad-hoc-only",
          },
          {
            path: "Contents/Helpers/synara-appsnap-helper",
            identifier: "synara-appsnap-helper",
            teamId: null,
            authorities: [],
            cdHash: "4".repeat(40),
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
            cdHash: "2".repeat(40),
            signature: "adhoc",
            scheme: "ad-hoc-only",
          },
        ],
      },
    });

    expect(result.manifest.signing).toMatchObject({
      status: "unsigned-prerelease",
      scheme: "ad-hoc-only",
      thirdPartyComponents: "reviewed-allowlist",
    });

    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createNativeAsset(diskImage, "mutated-dmg"),
        artifactFileNames: [diskImage],
        outputFileName: "artifact-macos-arm64.provenance.json",
        platform: "mac",
        arch: "arm64",
        target: "dmg",
        version,
        sourceCommit: "d".repeat(40),
        sourceTag: `super-v${version}`,
        lockfileSha256: "e".repeat(64),
        publication: true,
        signed: false,
        distributionKind: "github-unsigned-prerelease",
        distributionRepository: "slashdevcorpse/synara",
        updaterFeed: false,
        absorbedUpstreamSha: "f".repeat(40),
        macSignatureAllowlist: {
          schemaVersion: 1,
          electronVersion: "40.10.6",
          productOwnedPaths: [
            ".",
            "Contents/MacOS/Super Synara",
            "Contents/Helpers/synara-appsnap-helper",
          ],
          thirdParty: [
            {
              path: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
              identifier: "com.github.Electron.framework",
              teamId: null,
              authorities: [],
              scheme: "ad-hoc-only",
            },
          ],
        },
        macSignatureReport: result.manifest.signing.identity as MacUnsignedSignatureReport,
      }),
    ).rejects.toThrow("disk-image evidence does not match staged");
  });

  it("continues rejecting unsigned calls through signed-release policy", async () => {
    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createNativeAsset("Synara-1.2.3.exe", "unsigned"),
        platform: "win",
        arch: "x64",
        target: "nsis",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: "v1.2.3",
        lockfileSha256: "b".repeat(64),
        publication: true,
        signed: false,
        distributionKind: "signed-release",
      }),
    ).rejects.toThrow("requires verified signing");
  });
});
