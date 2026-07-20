// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.

export const SYNARA_DESKTOP_SCHEME = "synara";
export const SYNARA_DESKTOP_ORIGIN = `${SYNARA_DESKTOP_SCHEME}://app`;
export const SYNARA_DESKTOP_ENTRY_URL = `${SYNARA_DESKTOP_ORIGIN}/index.html`;
export const SYNARA_DESKTOP_UPDATE_CHANNEL = "synara";
export const SYNARA_PRODUCTION_BUNDLE_ID = "com.emanueledipietro.synara";
export const SYNARA_DEVELOPMENT_BUNDLE_ID = `${SYNARA_PRODUCTION_BUNDLE_ID}.dev`;
export const SYNARA_CANARY_BUNDLE_ID = `${SYNARA_PRODUCTION_BUNDLE_ID}.canary`;
export const SYNARA_CANARY_DESKTOP_SCHEME = "synara-canary";
export const SYNARA_CANARY_DESKTOP_ORIGIN = `${SYNARA_CANARY_DESKTOP_SCHEME}://app`;
export const SYNARA_CANARY_DESKTOP_ENTRY_URL = `${SYNARA_CANARY_DESKTOP_ORIGIN}/index.html`;
export const SYNARA_SUPER_BUNDLE_ID = "io.github.slashdevcorpse.supersynara";
export const SYNARA_SUPER_DESKTOP_SCHEME = "super-synara";
export const SYNARA_SUPER_DESKTOP_ORIGIN = `${SYNARA_SUPER_DESKTOP_SCHEME}://app`;
export const SYNARA_SUPER_DESKTOP_ENTRY_URL = `${SYNARA_SUPER_DESKTOP_ORIGIN}/index.html`;
export const SYNARA_WINDOWS_INSTALLER_GUID = "368107a8-afe6-5db5-ab3b-d4f331684868";
export const SYNARA_SUPER_WINDOWS_INSTALLER_GUID = "ab3ea852-4edf-4caa-977e-9d00ccab2b1e";

export type SynaraDesktopFlavor = "production" | "development" | "canary" | "super";
export type SynaraDesktopDefaultThemeMode = "dark" | "system";
export type SynaraDesktopUpdateStrategy = "automatic" | "development" | "scripted" | "manual";

export interface SynaraDesktopIdentity {
  readonly flavor: SynaraDesktopFlavor;
  readonly displayName: string;
  readonly artifactPrefix: string;
  readonly executableName: string;
  readonly bundleId: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly defaultThemeMode: SynaraDesktopDefaultThemeMode;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
  readonly windowsInstallerGuid: string;
  readonly updateStrategy: SynaraDesktopUpdateStrategy;
  readonly allowsProfileBridgeRepair: boolean;
  readonly usesScriptedUpdates: boolean;
  readonly downstreamRepositoryUrl?: string;
}

export function resolveSynaraDesktopFlavor(input: {
  readonly isDevelopment: boolean;
  readonly requestedFlavor?: string | undefined;
  readonly packagedFlavor?: string | undefined;
}): SynaraDesktopFlavor {
  if (input.packagedFlavor !== undefined) {
    const packagedFlavor = input.packagedFlavor.trim().toLowerCase();
    if (
      packagedFlavor === "production" ||
      packagedFlavor === "canary" ||
      packagedFlavor === "super"
    ) {
      return packagedFlavor;
    }
    throw new Error(`Invalid packaged desktop flavor '${input.packagedFlavor}'.`);
  }
  const requestedFlavor = input.requestedFlavor?.trim().toLowerCase();
  if (requestedFlavor === "canary" || requestedFlavor === "super") {
    return requestedFlavor;
  }
  return input.isDevelopment ? "development" : "production";
}

export function synaraDesktopIdentity(flavor: SynaraDesktopFlavor): SynaraDesktopIdentity {
  if (flavor === "super") {
    return {
      flavor,
      displayName: "Super Synara",
      artifactPrefix: "Super-Synara",
      executableName: "Super Synara",
      bundleId: SYNARA_SUPER_BUNDLE_ID,
      scheme: SYNARA_SUPER_DESKTOP_SCHEME,
      origin: SYNARA_SUPER_DESKTOP_ORIGIN,
      entryUrl: SYNARA_SUPER_DESKTOP_ENTRY_URL,
      defaultThemeMode: "dark",
      userDataDirectoryName: "super-synara",
      defaultHomeDirectoryName: ".super-synara",
      windowsInstallerGuid: SYNARA_SUPER_WINDOWS_INSTALLER_GUID,
      updateStrategy: "manual",
      allowsProfileBridgeRepair: false,
      usesScriptedUpdates: false,
      downstreamRepositoryUrl: "https://github.com/slashdevcorpse/synara",
    };
  }
  if (flavor === "canary") {
    return {
      flavor,
      displayName: "Synara Canary",
      artifactPrefix: "Synara-Canary",
      executableName: "Synara Canary",
      bundleId: SYNARA_CANARY_BUNDLE_ID,
      scheme: SYNARA_CANARY_DESKTOP_SCHEME,
      origin: SYNARA_CANARY_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CANARY_DESKTOP_ENTRY_URL,
      defaultThemeMode: "system",
      userDataDirectoryName: "synara-canary",
      defaultHomeDirectoryName: ".synara-canary",
      windowsInstallerGuid: SYNARA_WINDOWS_INSTALLER_GUID,
      updateStrategy: "scripted",
      allowsProfileBridgeRepair: true,
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "development") {
    return {
      flavor,
      displayName: "Synara (Dev)",
      artifactPrefix: "Synara",
      executableName: "Synara",
      bundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      scheme: SYNARA_DESKTOP_SCHEME,
      origin: SYNARA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_DESKTOP_ENTRY_URL,
      defaultThemeMode: "system",
      userDataDirectoryName: "synara-dev",
      defaultHomeDirectoryName: ".synara",
      windowsInstallerGuid: SYNARA_WINDOWS_INSTALLER_GUID,
      updateStrategy: "development",
      allowsProfileBridgeRepair: true,
      usesScriptedUpdates: false,
    };
  }
  return {
    flavor,
    displayName: "Synara",
    artifactPrefix: "Synara",
    executableName: "Synara",
    bundleId: SYNARA_PRODUCTION_BUNDLE_ID,
    scheme: SYNARA_DESKTOP_SCHEME,
    origin: SYNARA_DESKTOP_ORIGIN,
    entryUrl: SYNARA_DESKTOP_ENTRY_URL,
    defaultThemeMode: "system",
    userDataDirectoryName: "synara",
    defaultHomeDirectoryName: ".synara",
    windowsInstallerGuid: SYNARA_WINDOWS_INSTALLER_GUID,
    updateStrategy: "automatic",
    allowsProfileBridgeRepair: true,
    usesScriptedUpdates: false,
  };
}

export function synaraBundleId(isDevelopment: boolean): string {
  return synaraDesktopIdentity(isDevelopment ? "development" : "production").bundleId;
}
