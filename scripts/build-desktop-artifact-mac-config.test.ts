import { assert, describe, it } from "@effect/vitest";

import {
  createDesktopPlatformBuildConfig,
  MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
  MAC_APPSNAP_HELPER_BUNDLE_PATH,
  MAC_APPSNAP_HELPER_STAGE_PATH,
  MAC_ENTITLEMENTS_PATH,
  MAC_FOREIGN_NATIVE_EXCLUSIONS,
  MAC_INHERITED_ENTITLEMENTS_PATH,
  MAC_PRESIGNED_VENDOR_SIGN_IGNORE_PATTERNS,
  MICROPHONE_USAGE_DESCRIPTION,
  NODE_PTY_ASAR_UNPACK_GLOBS,
  resolveMacNativeExclusions,
  validateDesktopNativeBuildHost,
  WINDOWS_INSTALLER_GUID,
  WINDOWS_JOB_LAUNCHER_EXTRA_FILE_DESTINATION,
  WINDOWS_JOB_LAUNCHER_EXECUTABLE,
  windowsJobLauncherStagePath,
} from "./lib/desktop-platform-build-config.ts";
import {
  BRAND_ASSET_PATHS,
  resolveDesktopBrandAssetPaths,
  SUPER_DESKTOP_BRAND_ASSET_PATHS,
} from "./lib/brand-assets.ts";
import { DESKTOP_BUILD_ARCHES } from "./lib/desktop-build-options.ts";
import { synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

describe("createDesktopPlatformBuildConfig", () => {
  it("adds explicit microphone entitlements to macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      arch: "arm64",
      platform: "mac",
      target: "dmg",
      signed: true,
    });
    const mac = config.mac as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.equal(mac.icon, "icon.icns");
    assert.deepStrictEqual(config.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.notarize, true);
    assert.equal(mac.identity, undefined);
    assert.equal(mac.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(mac.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    assert.equal(MAC_APPSNAP_HELPER_BUNDLE_PATH, "Contents/Helpers/synara-appsnap-helper");
    assert.deepStrictEqual(mac.binaries, ["Contents/Helpers/synara-appsnap-helper"]);
    assert.deepStrictEqual(
      [...MAC_PRESIGNED_VENDOR_SIGN_IGNORE_PATTERNS],
      [
        String.raw`/Contents/Resources/app\.asar\.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-(?:arm64|x64)/claude$`,
      ],
    );
    assert.deepStrictEqual(mac.signIgnore, [...MAC_PRESIGNED_VENDOR_SIGN_IGNORE_PATTERNS]);
    assert.equal(mac.x64ArchFiles, "Contents/Helpers/synara-appsnap-helper");
    assert.equal(
      MAC_APPSNAP_HELPER_STAGE_PATH,
      "apps/desktop/native/appsnap/build/synara-appsnap-helper",
    );
    assert.equal(MAC_APPSNAP_HELPER_ASAR_EXCLUSION, "!apps/desktop/native/appsnap/build/**");
    assert.deepStrictEqual(config.files, [
      "**/*",
      ...resolveMacNativeExclusions("arm64"),
      MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
    ]);
    assert.deepStrictEqual(
      [...MAC_FOREIGN_NATIVE_EXCLUSIONS],
      [
        "!node_modules/@earendil-works/pi-tui/native/win32/**",
        "!node_modules/node-pty/prebuilds/win32-*/**",
        "!node_modules/node-pty/third_party/conpty/**",
        "!node_modules/node-pty/deps/winpty/**",
      ],
    );
    assert.deepStrictEqual(config.extraFiles, [
      {
        from: "apps/desktop/native/appsnap/build/synara-appsnap-helper",
        to: "Helpers/synara-appsnap-helper",
      },
    ]);
    assert.deepStrictEqual(config.extraResources, [{ from: "LICENSE", to: "LICENSE" }]);
    assert.equal(extendInfo.NSMicrophoneUsageDescription, MICROPHONE_USAGE_DESCRIPTION);
    assert.equal(extendInfo.NSScreenCaptureUsageDescription, undefined);
  });

  it("keeps only target-architecture Darwin prebuilds in single-architecture macOS apps", () => {
    const piTuiArm64 =
      "!node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/**";
    const piTuiX64 = "!node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-x64/**";
    const nodePtyArm64 = "!node_modules/node-pty/prebuilds/darwin-arm64/**";
    const nodePtyX64 = "!node_modules/node-pty/prebuilds/darwin-x64/**";

    const exclusionsByArch = {
      arm64: [...MAC_FOREIGN_NATIVE_EXCLUSIONS, piTuiX64, nodePtyX64],
      x64: [...MAC_FOREIGN_NATIVE_EXCLUSIONS, piTuiArm64, nodePtyArm64],
      universal: [...MAC_FOREIGN_NATIVE_EXCLUSIONS],
    } as const;

    for (const arch of DESKTOP_BUILD_ARCHES) {
      const expected = exclusionsByArch[arch];
      assert.deepStrictEqual(resolveMacNativeExclusions(arch), expected);

      const config = createDesktopPlatformBuildConfig({
        arch,
        platform: "mac",
        target: "dmg",
      });
      assert.deepStrictEqual(config.files, [
        "**/*",
        ...expected,
        MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
      ]);
    }
  });

  it("leaves non-macOS platform configs unchanged", () => {
    const linux = createDesktopPlatformBuildConfig({
      arch: "x64",
      platform: "linux",
      target: "AppImage",
    });
    const win = createDesktopPlatformBuildConfig({
      arch: "x64",
      platform: "win",
      target: "nsis",
      windowsAzureSignOptions: { publisherName: "Synara" },
    });

    assert.equal(linux.mac, undefined);
    assert.equal(linux.files, undefined);
    assert.equal(linux.extraFiles, undefined);
    assert.deepStrictEqual(linux.extraResources, [{ from: "LICENSE", to: "LICENSE" }]);
    assert.deepStrictEqual(linux.asarUnpack, ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(linux.linux, {
      target: ["AppImage"],
      executableName: "synara",
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: "synara",
        },
      },
    });

    assert.equal(win.mac, undefined);
    assert.equal(win.files, undefined);
    assert.equal(WINDOWS_JOB_LAUNCHER_EXECUTABLE, "synara-windows-job-launcher.exe");
    assert.equal(
      WINDOWS_JOB_LAUNCHER_EXTRA_FILE_DESTINATION,
      "resources/synara-native/synara-windows-job-launcher.exe",
    );
    assert.equal(
      windowsJobLauncherStagePath("x64"),
      "apps/server/dist/native/win32-x64/synara-windows-job-launcher.exe",
    );
    assert.deepStrictEqual(win.extraFiles, [
      {
        from: "apps/server/dist/native/win32-x64/synara-windows-job-launcher.exe",
        to: "resources/synara-native/synara-windows-job-launcher.exe",
      },
    ]);
    assert.deepStrictEqual(win.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(WINDOWS_INSTALLER_GUID, "368107a8-afe6-5db5-ab3b-d4f331684868");
    assert.deepStrictEqual(win.nsis, {
      guid: WINDOWS_INSTALLER_GUID,
    });
    assert.deepStrictEqual(win.win, {
      target: ["nsis"],
      icon: "icon.ico",
      executableName: "Synara",
      publisherName: "Synara",
      azureSignOptions: { publisherName: "Synara" },
    });
  });

  it("omits Azure signing options for unsigned build-only artifacts", () => {
    const config = createDesktopPlatformBuildConfig({
      arch: "x64",
      platform: "win",
      target: "nsis",
    });

    assert.deepStrictEqual(config.win, {
      target: ["nsis"],
      icon: "icon.ico",
      executableName: "Synara",
    });
  });

  it("keeps node-pty unpacked from ASAR in generated build config", () => {
    const config = createDesktopPlatformBuildConfig({
      arch: "x64",
      platform: "linux",
      target: "AppImage",
    });

    assert.deepStrictEqual([...NODE_PTY_ASAR_UNPACK_GLOBS], ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(config.asarUnpack, [...NODE_PTY_ASAR_UNPACK_GLOBS]);
  });

  it("blocks unsupported or non-matching Linux native build hosts", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "x64",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      null,
    );

    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "universal",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      "Linux desktop artifacts support x64 or arm64 builds, not universal builds.",
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "linux",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });

    assert.ok(issue?.includes("Build linux/x64 on a matching Linux host"));
  });

  it("blocks unsupported universal Windows native builds", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "win",
        arch: "universal",
        hostPlatform: "win32",
        hostArch: "x64",
      }),
      "Windows desktop artifacts support x64 or arm64 builds, not universal builds.",
    );
  });

  it("requires a macOS host for the native Swift AppSnap helper", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "mac",
        arch: "universal",
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
      null,
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "mac",
      arch: "arm64",
      hostPlatform: "linux",
      hostArch: "arm64",
    });
    assert.ok(issue?.includes("Build mac/arm64 on macOS"));
  });

  it("keeps separate macOS sources for solid and rounded icons", () => {
    assert.equal(BRAND_ASSET_PATHS.productionMacIconPng, "assets/prod/black-macos-1024.png");
    assert.equal(
      BRAND_ASSET_PATHS.productionMacLegacyIconPng,
      "assets/prod/black-macos-legacy-1024.png",
    );
  });

  it("uses dedicated Super Synara desktop artwork without changing upstream flavors", () => {
    assert.deepStrictEqual(resolveDesktopBrandAssetPaths("super"), {
      macIconSource: "assets/super/super-synara-1024.png",
      macLegacyIconSource: "assets/super/super-synara-macos-legacy-1024.png",
      windowsIconIco: "assets/super/super-synara-windows.ico",
      windowsNotificationIconPng: "assets/super/super-synara-1024.png",
    });
    assert.deepStrictEqual(resolveDesktopBrandAssetPaths("super"), SUPER_DESKTOP_BRAND_ASSET_PATHS);

    for (const flavor of ["production", "canary"] as const) {
      assert.deepStrictEqual(resolveDesktopBrandAssetPaths(flavor), {
        macIconSource: "assets/prod/black-macos-1024.png",
        macLegacyIconSource: "assets/prod/black-macos-legacy-1024.png",
        windowsIconIco: "assets/prod/synara-black-windows.ico",
        windowsNotificationIconPng: "assets/prod/black-universal-1024.png",
      });
    }
  });

  it("uses explicit macOS ad-hoc signing and isolated Super Synara Windows registration", () => {
    const identity = synaraDesktopIdentity("super");
    const mac = createDesktopPlatformBuildConfig({
      arch: "arm64",
      platform: "mac",
      target: "dmg",
      signed: false,
      identity,
      disableUpdates: true,
    });
    const win = createDesktopPlatformBuildConfig({
      arch: "x64",
      platform: "win",
      target: "nsis",
      identity,
      disableUpdates: true,
    });

    const macOptions = mac.mac as Record<string, unknown>;
    assert.equal(macOptions.identity, "-");
    assert.equal(macOptions.hardenedRuntime, false);
    assert.equal(macOptions.notarize, false);
    assert.deepStrictEqual(macOptions.target, ["dmg"]);
    assert.deepStrictEqual(mac.dmg, { writeUpdateInfo: false });
    assert.deepStrictEqual(mac.extraResources, [{ from: "LICENSE", to: "LICENSE" }]);
    assert.deepStrictEqual(win.nsis, {
      guid: "ab3ea852-4edf-4caa-977e-9d00ccab2b1e",
      differentialPackage: false,
    });
    assert.deepStrictEqual(win.win, {
      target: ["nsis"],
      icon: "icon.ico",
      executableName: "Super Synara",
    });
  });
});
