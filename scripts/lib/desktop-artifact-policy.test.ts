import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

import {
  createDesktopIdentityBuildConfig,
  desktopStageFileBytesMatch,
  findProhibitedUpdaterMetadataFiles,
  isProhibitedUpdaterMetadataFile,
  resolveDesktopGitHubPublishConfig,
  resolveDesktopFinalArtifactCopies,
  resolveDesktopPlatformBuildVersion,
  resolveDesktopSourceTag,
  resolveDesktopStageInstallArgs,
  resolveSuperDesktopStageInstallEnvironment,
} from "./desktop-artifact-policy.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop artifact policy", () => {
  it("uses a normal-saving, unfiltered production stage install only for Super Synara", () => {
    const baseArgs = [
      "install",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--linker",
      "hoisted",
    ];
    expect(resolveDesktopStageInstallArgs("super")).toEqual([
      "install",
      "--production",
      "--ignore-scripts",
      "--linker",
      "hoisted",
    ]);
    expect(resolveDesktopStageInstallArgs("super")).not.toContain("--frozen-lockfile");
    expect(resolveDesktopStageInstallArgs("super")).not.toContain("--no-save");
    expect(resolveDesktopStageInstallArgs("super")).not.toContain("--save");
    for (const flavor of ["production", "canary"] as const) {
      expect(resolveDesktopStageInstallArgs(flavor)).toEqual([
        ...baseArgs,
        "--filter",
        "@synara/cli",
        "--filter",
        "@synara/desktop",
      ]);
    }
  });

  it("rejects any staged lockfile byte change", () => {
    const repositoryLockfile = Buffer.from('lock = "same"\n');
    expect(desktopStageFileBytesMatch(repositoryLockfile, Buffer.from(repositoryLockfile))).toBe(
      true,
    );
    expect(desktopStageFileBytesMatch(repositoryLockfile, Buffer.from('lock = "changed"\n'))).toBe(
      false,
    );
    expect(desktopStageFileBytesMatch(repositoryLockfile, Buffer.from('lock = "same"\r\n'))).toBe(
      false,
    );
  });

  it("removes only the proven nested Bun user-agent trigger", () => {
    const inheritedEnvironment = {
      PATH: "C:\\repo\\node_modules\\.bin;C:\\tools",
      NODE: "C:\\tools\\node.exe",
      CI: "true",
      INIT_CWD: "C:\\workflow",
      npm_config_user_agent: "bun/1.3.12 npm/? node/v24.3.0 win32 x64",
      npm_config_local_prefix: "C:\\repo",
      npm_package_json: "C:\\repo\\package.json",
      npm_package_name: "@synara/monorepo",
      npm_command: "run-script",
      npm_execpath: "C:\\tools\\bun.exe",
      npm_node_execpath: "C:\\tools\\node.exe",
    };
    expect(resolveSuperDesktopStageInstallEnvironment(inheritedEnvironment)).toEqual({
      PATH: "C:\\repo\\node_modules\\.bin;C:\\tools",
      NODE: "C:\\tools\\node.exe",
      CI: "true",
      INIT_CWD: "C:\\workflow",
      npm_config_local_prefix: "C:\\repo",
      npm_package_json: "C:\\repo\\package.json",
      npm_package_name: "@synara/monorepo",
      npm_command: "run-script",
      npm_execpath: "C:\\tools\\bun.exe",
      npm_node_execpath: "C:\\tools\\node.exe",
    });
  });

  it("uses flavor-aware source tags without changing upstream flavors", () => {
    expect(resolveDesktopSourceTag("production", "0.5.5")).toBe("v0.5.5");
    expect(resolveDesktopSourceTag("canary", "0.5.5")).toBe("v0.5.5");
    expect(resolveDesktopSourceTag("super", "0.5.5-super.1")).toBe("super-v0.5.5-super.1");
  });

  it("maps Super prerelease semver to numeric platform build metadata", () => {
    expect(resolveDesktopPlatformBuildVersion("super", "0.5.5-super.1")).toBe("0.5.5.1");
    expect(resolveDesktopPlatformBuildVersion("super", "0.5.5")).toBe("0.5.5.0");
    expect(resolveDesktopPlatformBuildVersion("production", "0.5.5-beta.1")).toBe("0.5.5-beta.1");
    expect(resolveDesktopPlatformBuildVersion("canary", "0.5.5-canary.1")).toBe("0.5.5-canary.1");
    expect(() => resolveDesktopPlatformBuildVersion("super", "0.5.5-beta.1")).toThrow("must use");
  });

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

  it("resolves exact public Super installer and disk-image names", () => {
    expect(
      resolveDesktopFinalArtifactCopies({
        flavor: "super",
        platform: "win",
        target: "nsis",
        arch: "x64",
        version: "0.5.5-super.3",
        stageFileNames: ["Super-Synara-0.5.5-super.3-x64.exe"],
      }),
    ).toEqual([
      {
        sourceFileName: "Super-Synara-0.5.5-super.3-x64.exe",
        outputFileName: "Super-Synara-0.5.5-super.3-windows-x64-unsigned.exe",
      },
    ]);

    expect(
      resolveDesktopFinalArtifactCopies({
        flavor: "super",
        platform: "mac",
        target: "dmg",
        arch: "arm64",
        version: "0.5.5-super.3",
        stageFileNames: [
          "Super-Synara-0.5.5-super.3-arm64.dmg",
          "Super-Synara-0.5.5-super.3-arm64.zip",
        ],
      }),
    ).toEqual([
      {
        sourceFileName: "Super-Synara-0.5.5-super.3-arm64.dmg",
        outputFileName: "Super-Synara-0.5.5-super.3-macos-arm64-unsigned.dmg",
      },
      {
        sourceFileName: "Super-Synara-0.5.5-super.3-arm64.zip",
        outputFileName: "Super-Synara-0.5.5-super.3-arm64.zip",
      },
    ]);
  });

  it("leaves production, canary, and verification-only macOS zip names unchanged", () => {
    for (const input of [
      {
        flavor: "production",
        platform: "win",
        target: "nsis",
        arch: "x64",
        version: "1.2.3",
        stageFileNames: ["Synara-1.2.3-x64.exe"],
      },
      {
        flavor: "canary",
        platform: "mac",
        target: "dmg",
        arch: "arm64",
        version: "1.2.3-canary.1",
        stageFileNames: ["Synara-Canary-1.2.3-canary.1-arm64.dmg"],
      },
    ] as const) {
      expect(resolveDesktopFinalArtifactCopies(input)).toEqual(
        input.stageFileNames.map((fileName) => ({
          sourceFileName: fileName,
          outputFileName: fileName,
        })),
      );
    }
  });

  it("rejects duplicate and unexpected Super publishable payloads", () => {
    const input = {
      flavor: "super" as const,
      platform: "win" as const,
      target: "nsis",
      arch: "x64",
      version: "0.5.5-super.3",
    };
    expect(() =>
      resolveDesktopFinalArtifactCopies({
        ...input,
        stageFileNames: [
          "Super-Synara-0.5.5-super.3-x64.exe",
          "Super-Synara-0.5.5-super.3-windows-x64-unsigned.exe",
        ],
      }),
    ).toThrow("Expected exactly one");
    expect(() =>
      resolveDesktopFinalArtifactCopies({
        ...input,
        stageFileNames: ["Other-0.5.5-super.3-x64.exe"],
      }),
    ).toThrow("Unexpected Super Synara");
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
