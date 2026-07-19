import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

import {
  createDesktopIdentityBuildConfig,
  findProhibitedUpdaterMetadataFiles,
  isProhibitedUpdaterMetadataFile,
  resolveDesktopGitHubPublishConfig,
} from "./desktop-artifact-policy.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop artifact policy", () => {
  it("builds Super Synara with the locked package identity and bundled license", () => {
    expect(
      createDesktopIdentityBuildConfig({
        identity: synaraDesktopIdentity("super"),
        signed: false,
        disableUpdates: true,
      }),
    ).toEqual({
      appId: "io.github.slashdevcorpse.supersynara",
      productName: "Super Synara",
      artifactName: "Super-Synara-${version}-${arch}.${ext}",
      directories: { buildResources: "apps/desktop/resources" },
      forceCodeSigning: false,
      extraResources: [{ from: "LICENSE", to: "LICENSE" }],
    });
  });

  it("ignores every update repository fallback when updates are disabled", () => {
    const env = {
      SYNARA_DESKTOP_UPDATE_REPOSITORY: "owner/explicit",
      GITHUB_REPOSITORY: "owner/automatic",
    };
    expect(resolveDesktopGitHubPublishConfig({ disableUpdates: true, env })).toBeUndefined();
    expect(resolveDesktopGitHubPublishConfig({ disableUpdates: false, env })).toEqual({
      provider: "github",
      owner: "owner",
      repo: "explicit",
      releaseType: "release",
    });
  });

  it("identifies updater metadata that may never leave a disabled build", () => {
    for (const fileName of [
      "app-update.yml",
      "latest.yml",
      "latest-mac.yml",
      "Super-Synara.exe.blockmap",
      "Super-Synara.dmg.blockmap",
    ]) {
      expect(isProhibitedUpdaterMetadataFile(fileName)).toBe(true);
    }
    expect(isProhibitedUpdaterMetadataFile("Super-Synara.exe")).toBe(false);
    expect(isProhibitedUpdaterMetadataFile("UNSIGNED-BUILD.md")).toBe(false);
  });

  it("finds updater metadata nested inside a packaged Super output tree", () => {
    const root = mkdtempSync(join(tmpdir(), "super-synara-artifact-policy-"));
    temporaryRoots.push(root);
    const resources = join(root, "win-unpacked", "resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "app-update.yml"), "provider: github\n");
    writeFileSync(join(root, "latest.yml"), "version: 1.2.3\n");
    writeFileSync(join(root, "Super-Synara-1.2.3-x64.exe"), "installer");

    expect(findProhibitedUpdaterMetadataFiles(root)).toEqual([
      "latest.yml",
      join("win-unpacked", "resources", "app-update.yml"),
    ]);
  });
});
