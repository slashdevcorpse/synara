import { describe, expect, it } from "vitest";

import {
  resolveSynaraDesktopFlavor,
  SYNARA_CANARY_BUNDLE_ID,
  SYNARA_CANARY_DESKTOP_ENTRY_URL,
  SYNARA_CANARY_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_ENTRY_URL,
  SYNARA_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
  SYNARA_SUPER_BUNDLE_ID,
  SYNARA_SUPER_DESKTOP_ENTRY_URL,
  SYNARA_SUPER_DESKTOP_ORIGIN,
  SYNARA_SUPER_WINDOWS_INSTALLER_GUID,
  synaraBundleId,
  synaraDesktopIdentity,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(SYNARA_PRODUCTION_BUNDLE_ID).toBe("com.emanueledipietro.synara");
    expect(SYNARA_DEVELOPMENT_BUNDLE_ID).toBe("com.emanueledipietro.synara.dev");
    expect(synaraBundleId(false)).toBe(SYNARA_PRODUCTION_BUNDLE_ID);
    expect(synaraBundleId(true)).toBe(SYNARA_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(SYNARA_DESKTOP_ORIGIN).toBe("synara://app");
    expect(SYNARA_DESKTOP_ENTRY_URL).toBe("synara://app/index.html");
  });

  it("uses the isolated Synara desktop update channel", () => {
    expect(SYNARA_DESKTOP_UPDATE_CHANNEL).toBe("synara");
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(SYNARA_CANARY_BUNDLE_ID).toBe("com.emanueledipietro.synara.canary");
    expect(SYNARA_CANARY_DESKTOP_ORIGIN).toBe("synara-canary://app");
    expect(SYNARA_CANARY_DESKTOP_ENTRY_URL).toBe("synara-canary://app/index.html");
    expect(synaraDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "Synara Canary",
      artifactPrefix: "Synara-Canary",
      executableName: "Synara Canary",
      bundleId: SYNARA_CANARY_BUNDLE_ID,
      scheme: "synara-canary",
      origin: SYNARA_CANARY_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CANARY_DESKTOP_ENTRY_URL,
      defaultThemeMode: "system",
      userDataDirectoryName: "synara-canary",
      defaultHomeDirectoryName: ".synara-canary",
      windowsInstallerGuid: "368107a8-afe6-5db5-ab3b-d4f331684868",
      updateStrategy: "scripted",
      allowsProfileBridgeRepair: true,
      usesScriptedUpdates: true,
    });
  });

  it("selects Canary explicitly without changing normal dev and production defaults", () => {
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " })).toBe(
      "canary",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
  });

  it("gives Super Synara every locked collision-free identity surface", () => {
    expect(SYNARA_SUPER_BUNDLE_ID).toBe("io.github.slashdevcorpse.supersynara");
    expect(SYNARA_SUPER_DESKTOP_ORIGIN).toBe("super-synara://app");
    expect(SYNARA_SUPER_DESKTOP_ENTRY_URL).toBe("super-synara://app/index.html");
    expect(SYNARA_SUPER_WINDOWS_INSTALLER_GUID).toBe("ab3ea852-4edf-4caa-977e-9d00ccab2b1e");
    expect(synaraDesktopIdentity("super")).toEqual({
      flavor: "super",
      displayName: "Super Synara",
      artifactPrefix: "Super-Synara",
      executableName: "Super Synara",
      bundleId: SYNARA_SUPER_BUNDLE_ID,
      scheme: "super-synara",
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
    });
  });

  it("bakes packaged identity independently from runtime flavor environment", () => {
    expect(
      resolveSynaraDesktopFlavor({
        isDevelopment: false,
        requestedFlavor: "canary",
        packagedFlavor: "super",
      }),
    ).toBe("super");
    expect(
      resolveSynaraDesktopFlavor({
        isDevelopment: false,
        requestedFlavor: "super",
        packagedFlavor: "production",
      }),
    ).toBe("production");
    expect(() =>
      resolveSynaraDesktopFlavor({
        isDevelopment: false,
        packagedFlavor: "unknown",
      }),
    ).toThrow("Invalid packaged desktop flavor");
  });

  it("preserves every pre-existing production, development, and canary identity value", () => {
    expect(synaraDesktopIdentity("production")).toMatchObject({
      displayName: "Synara",
      bundleId: "com.emanueledipietro.synara",
      scheme: "synara",
      origin: "synara://app",
      entryUrl: "synara://app/index.html",
      defaultThemeMode: "system",
      userDataDirectoryName: "synara",
      defaultHomeDirectoryName: ".synara",
      usesScriptedUpdates: false,
    });
    expect(synaraDesktopIdentity("development")).toMatchObject({
      displayName: "Synara (Dev)",
      bundleId: "com.emanueledipietro.synara.dev",
      scheme: "synara",
      origin: "synara://app",
      entryUrl: "synara://app/index.html",
      defaultThemeMode: "system",
      userDataDirectoryName: "synara-dev",
      defaultHomeDirectoryName: ".synara",
      usesScriptedUpdates: false,
    });
    expect(synaraDesktopIdentity("canary")).toMatchObject({
      displayName: "Synara Canary",
      bundleId: "com.emanueledipietro.synara.canary",
      scheme: "synara-canary",
      origin: "synara-canary://app",
      entryUrl: "synara-canary://app/index.html",
      defaultThemeMode: "system",
      userDataDirectoryName: "synara-canary",
      defaultHomeDirectoryName: ".synara-canary",
      windowsInstallerGuid: "368107a8-afe6-5db5-ab3b-d4f331684868",
      updateStrategy: "scripted",
      allowsProfileBridgeRepair: true,
      usesScriptedUpdates: true,
    });
  });
});
