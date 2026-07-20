// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

import {
  SYNARA_WINDOWS_INSTALLER_GUID,
  synaraDesktopIdentity,
  type SynaraDesktopIdentity,
} from "@synara/shared/desktopIdentity";
import type { DesktopBuildArch } from "./desktop-build-options.ts";
import launcherConfig from "../../apps/server/native/windows-job-launcher/launcher.config.json" with { type: "json" };

export const MICROPHONE_USAGE_DESCRIPTION =
  "Synara needs microphone access so you can record voice notes and transcribe them into the chat composer.";
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
export const MAC_APPSNAP_HELPER_STAGE_PATH =
  "apps/desktop/native/appsnap/build/synara-appsnap-helper";
export const MAC_APPSNAP_HELPER_ASAR_EXCLUSION = "!apps/desktop/native/appsnap/build/**";
export const MAC_APPSNAP_HELPER_BUNDLE_PATH = "Contents/Helpers/synara-appsnap-helper";
export const MAC_PRESIGNED_VENDOR_SIGN_IGNORE_PATTERNS = [
  String.raw`/Contents/Resources/app\.asar\.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-(?:arm64|x64)/claude$`,
] as const;
export const WINDOWS_INSTALLER_GUID = SYNARA_WINDOWS_INSTALLER_GUID;
export const WINDOWS_JOB_LAUNCHER_EXECUTABLE = launcherConfig.executableName;
export const WINDOWS_JOB_LAUNCHER_EXTRA_FILE_DESTINATION = `resources/synara-native/${WINDOWS_JOB_LAUNCHER_EXECUTABLE}`;
const MAC_DMG_ICON_PATH = "icon.icns";
export const NODE_PTY_ASAR_UNPACK_GLOBS = ["node_modules/node-pty/**"] as const;
export const MAC_FOREIGN_NATIVE_EXCLUSIONS = [
  "!node_modules/@earendil-works/pi-tui/native/win32/**",
  "!node_modules/node-pty/prebuilds/win32-*/**",
  "!node_modules/node-pty/third_party/conpty/**",
  "!node_modules/node-pty/deps/winpty/**",
] as const;

export function resolveMacNativeExclusions(arch: DesktopBuildArch): ReadonlyArray<string> {
  const oppositeArch = arch === "arm64" ? "x64" : arch === "x64" ? "arm64" : null;
  if (!oppositeArch) return [...MAC_FOREIGN_NATIVE_EXCLUSIONS];

  return [
    ...MAC_FOREIGN_NATIVE_EXCLUSIONS,
    `!node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-${oppositeArch}/**`,
    `!node_modules/node-pty/prebuilds/darwin-${oppositeArch}/**`,
  ];
}

export function windowsJobLauncherStagePath(arch: DesktopBuildArch): string {
  return `apps/server/dist/native/win32-${arch}/${WINDOWS_JOB_LAUNCHER_EXECUTABLE}`;
}

export interface DesktopPlatformBuildConfig {
  readonly asarUnpack?: ReadonlyArray<string>;
  readonly dmg?: Record<string, unknown>;
  readonly extraFiles?: ReadonlyArray<Record<string, string>>;
  readonly extraResources?: ReadonlyArray<Record<string, string>>;
  readonly files?: ReadonlyArray<string>;
  readonly linux?: Record<string, unknown>;
  readonly mac?: Record<string, unknown>;
  readonly nsis?: Record<string, unknown>;
  readonly win?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly arch: DesktopBuildArch;
  readonly platform: "linux" | "mac" | "win";
  readonly target: string;
  readonly signed?: boolean;
  readonly identity?: SynaraDesktopIdentity;
  readonly disableUpdates?: boolean;
  readonly windowsAzureSignOptions?: Record<string, string>;
}

export interface DesktopNativeBuildHostInput {
  readonly arch: DesktopBuildArch;
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "linux" | "mac" | "win";
}

export function validateDesktopNativeBuildHost(input: DesktopNativeBuildHostInput): string | null {
  if (input.platform === "win" && input.arch === "universal") {
    return "Windows desktop artifacts support x64 or arm64 builds, not universal builds.";
  }
  if (input.platform === "mac" && input.hostPlatform !== "darwin") {
    return [
      "macOS desktop artifacts include the native Swift AppSnap helper.",
      `Build mac/${input.arch} on macOS so the helper can be compiled and signed.`,
      `Current host is ${input.hostPlatform}/${input.hostArch}.`,
    ].join(" ");
  }
  if (input.platform !== "linux") return null;
  if (input.arch === "universal") {
    return "Linux desktop artifacts support x64 or arm64 builds, not universal builds.";
  }
  if (input.hostPlatform === "linux" && input.hostArch === input.arch) return null;

  return [
    "Linux desktop artifacts include the native node-pty terminal dependency.",
    `Build linux/${input.arch} on a matching Linux host so pty.node and spawn-helper are compiled for Linux.`,
    `Current host is ${input.hostPlatform}/${input.hostArch}.`,
  ].join(" ");
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  const nativePackaging = { asarUnpack: [...NODE_PTY_ASAR_UNPACK_GLOBS] };
  const identity = input.identity ?? synaraDesktopIdentity("production");
  const licensedPackaging = {
    ...nativePackaging,
    extraResources: [{ from: "LICENSE", to: "LICENSE" }],
  };

  if (input.platform === "mac") {
    const mac = {
      target:
        input.target === "dmg"
          ? input.disableUpdates
            ? [input.target]
            : [input.target, "zip"]
          : [input.target],
      icon: MAC_DMG_ICON_PATH,
      category: "public.app-category.developer-tools",
      hardenedRuntime: input.signed === true,
      notarize: input.signed === true,
      ...(input.signed === true ? {} : { identity: "-" }),
      entitlements: MAC_ENTITLEMENTS_PATH,
      entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
      binaries: [MAC_APPSNAP_HELPER_BUNDLE_PATH],
      signIgnore: [...MAC_PRESIGNED_VENDOR_SIGN_IGNORE_PATTERNS],
      // The universal build stages the same pre-lipo'd helper in both app trees.
      // @electron/universal needs this pattern to preserve that existing fat binary.
      x64ArchFiles: MAC_APPSNAP_HELPER_BUNDLE_PATH,
      extendInfo: {
        NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
      },
    } satisfies Record<string, unknown>;

    return {
      ...licensedPackaging,
      files: ["**/*", ...resolveMacNativeExclusions(input.arch), MAC_APPSNAP_HELPER_ASAR_EXCLUSION],
      extraFiles: [
        {
          from: MAC_APPSNAP_HELPER_STAGE_PATH,
          to: "Helpers/synara-appsnap-helper",
        },
      ],
      ...(input.disableUpdates && input.target === "dmg"
        ? { dmg: { writeUpdateInfo: false } }
        : {}),
      mac,
    };
  }

  if (input.platform === "linux") {
    return {
      ...licensedPackaging,
      linux: {
        target: [input.target],
        executableName: "synara",
        icon: "icon.png",
        category: "Development",
        desktop: {
          entry: {
            StartupWMClass: "synara",
          },
        },
      },
    };
  }

  return {
    ...licensedPackaging,
    extraFiles: [
      {
        from: windowsJobLauncherStagePath(input.arch),
        to: WINDOWS_JOB_LAUNCHER_EXTRA_FILE_DESTINATION,
      },
    ],
    // Keep the Windows product registration stable while the public app ID changes.
    // This lets NSIS updates replace the existing installation and own its uninstaller.
    nsis: {
      guid: identity.windowsInstallerGuid,
      ...(input.disableUpdates ? { differentialPackage: false } : {}),
    },
    win: {
      target: [input.target],
      icon: "icon.ico",
      executableName: identity.executableName,
      ...(input.windowsAzureSignOptions
        ? {
            publisherName: input.windowsAzureSignOptions.publisherName,
            azureSignOptions: input.windowsAzureSignOptions,
          }
        : {}),
    },
  };
}
