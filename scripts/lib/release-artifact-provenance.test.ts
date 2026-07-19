import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeReleaseArtifactProvenance } from "./release-artifact-provenance.ts";

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
    const result = await writeReleaseArtifactProvenance({
      assetsDirectory: createNativeAsset(installer, "unsigned-installer"),
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
    });

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
      },
    });
    expect(result.path.endsWith("artifact-windows-x64.provenance.json")).toBe(true);
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
        productOwnedPaths: ["Contents/MacOS/Super Synara"],
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
        schemaVersion: 1,
        appBundle: "Super Synara.app",
        electronVersion: "40.10.6",
        notarizationTicket: "absent",
        notarizationEvidence: {
          command: "xcrun stapler validate",
          exitCode: 65,
          output: "The validate action failed because no ticket was found.",
        },
        productOwned: [
          {
            path: "Contents/MacOS/Super Synara",
            identifier: "io.github.slashdevcorpse.supersynara",
            teamId: null,
            authorities: [],
            cdHash: "1".repeat(40),
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
