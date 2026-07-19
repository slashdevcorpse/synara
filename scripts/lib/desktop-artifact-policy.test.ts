import { describe, expect, it } from "vitest";

import { synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

import {
  createDesktopIdentityBuildConfig,
  isProhibitedUpdaterMetadataFile,
  resolveDesktopGitHubPublishConfig,
} from "./desktop-artifact-policy.ts";

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
});
