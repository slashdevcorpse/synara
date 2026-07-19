import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeReleaseArtifactProvenance } from "./release-artifact-provenance.ts";
import {
  exactSuperSynaraReleaseAllowlist,
  prepareSuperSynaraRelease,
  superSynaraReleaseFileNames,
  verifyPreparedSuperSynaraRelease,
} from "./super-synara-release-admission.ts";

const roots: string[] = [];
const coordinates = {
  version: "0.5.5-super.1",
  tag: "super-v0.5.5-super.1",
  sourceCommit: "a".repeat(40),
  absorbedUpstreamSha: "b".repeat(40),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function createPlatformStaging(): Promise<{ directory: string; licensePath: string }> {
  const directory = mkdtempSync(join(tmpdir(), "super-synara-release-admission-test-"));
  const licenseRoot = mkdtempSync(join(tmpdir(), "super-synara-release-license-test-"));
  roots.push(directory, licenseRoot);
  const names = superSynaraReleaseFileNames(coordinates.version);
  writeFileSync(join(directory, names.windowsInstaller), "windows-installer");
  writeFileSync(join(directory, names.macosDiskImage), "macos-dmg");
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
  await writeReleaseArtifactProvenance({
    ...common,
    assetsDirectory: directory,
    artifactFileNames: [names.windowsInstaller],
    outputFileName: names.windowsProvenance,
    platform: "win",
    arch: "x64",
    target: "nsis",
  });
  await writeReleaseArtifactProvenance({
    ...common,
    assetsDirectory: directory,
    artifactFileNames: [names.macosDiskImage],
    outputFileName: names.macosProvenance,
    platform: "mac",
    arch: "arm64",
    target: "dmg",
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
          cdHash: "d".repeat(40),
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
          scheme: "ad-hoc-only",
        },
      ],
    },
  });
  const licensePath = join(licenseRoot, "LICENSE");
  writeFileSync(licensePath, "MIT fixture\n");
  return { directory, licensePath };
}

describe("Super Synara release admission", () => {
  it("creates the exact eight-file set with canonical checksums and a complete index", async () => {
    const { directory, licensePath } = await createPlatformStaging();
    const index = prepareSuperSynaraRelease({
      directory,
      licensePath,
      coordinates,
      maxTotalBytes: 10_000_000,
    });
    expect(index.files.map((file) => file.fileName)).toEqual(
      exactSuperSynaraReleaseAllowlist(coordinates.version).filter(
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
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toEqual(index);
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
        coordinates,
        maxTotalBytes: 10_000_000,
      }),
    ).toThrow("bytes differ from platform provenance");
  });
});
