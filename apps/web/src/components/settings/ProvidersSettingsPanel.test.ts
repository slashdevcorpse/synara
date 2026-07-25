import { describe, expect, it } from "vitest";

import { type AppSettings, AppSettingsSchema } from "~/appSettings";

import {
  ANTIGRAVITY_WINDOWS_COMPATIBILITY_DESCRIPTION,
  createProviderInstallResetPatch,
  isProviderInstallSettingsDirty,
} from "./ProvidersSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});

describe("Antigravity Windows compatibility guidance", () => {
  it("discloses capture, continuity, and provider-state limits", () => {
    expect(ANTIGRAVITY_WINDOWS_COMPATIBILITY_DESCRIPTION).toContain(
      "native compatibility mode",
    );
    expect(ANTIGRAVITY_WINDOWS_COMPATIBILITY_DESCRIPTION).toContain("final response text");
    expect(ANTIGRAVITY_WINDOWS_COMPATIBILITY_DESCRIPTION).toContain(
      "bounded Synara transcript",
    );
    expect(ANTIGRAVITY_WINDOWS_COMPATIBILITY_DESCRIPTION).toContain(
      "Live structured events, usage telemetry, and native resume are unavailable",
    );
    expect(ANTIGRAVITY_WINDOWS_COMPATIBILITY_DESCRIPTION).toContain(
      "does not install hooks or modify Antigravity provider state",
    );
  });
});

describe("isProviderInstallSettingsDirty", () => {
  it("covers every provider install text and boolean field", () => {
    const dirtyPatches = [
      { codexBinaryPath: "/opt/codex" },
      { codexHomePath: "/tmp/codex-home" },
      { commandCodeBinaryPath: "/opt/commandcode" },
      { claudeBinaryPath: "/opt/claude" },
      { cursorBinaryPath: "/opt/cursor" },
      { cursorApiEndpoint: "https://cursor.example" },
      { antigravityBinaryPath: "/opt/agy" },
      { grokBinaryPath: "/opt/grok" },
      { droidBinaryPath: "/opt/droid" },
      { kiloBinaryPath: "/opt/kilo" },
      { kiloServerUrl: "http://127.0.0.1:5000" },
      { openCodeBinaryPath: "/opt/opencode" },
      { openCodeServerUrl: "http://127.0.0.1:5001" },
      { openCodeExperimentalWebSockets: true },
      { piBinaryPath: "/opt/pi" },
      { piAgentDir: "/tmp/pi-agent" },
    ] satisfies ReadonlyArray<Partial<AppSettings>>;

    expect(isProviderInstallSettingsDirty(defaults, defaults)).toBe(false);
    for (const patch of dirtyPatches) {
      expect(isProviderInstallSettingsDirty({ ...defaults, ...patch }, defaults)).toBe(true);
    }
  });

  it("uses configured flags instead of unreadable password values", () => {
    expect(
      isProviderInstallSettingsDirty({ ...defaults, kiloServerPassword: "secret" }, defaults),
    ).toBe(false);
    expect(
      isProviderInstallSettingsDirty({ ...defaults, kiloServerPasswordConfigured: true }, defaults),
    ).toBe(true);
    expect(
      isProviderInstallSettingsDirty(
        { ...defaults, openCodeServerPasswordConfigured: true },
        defaults,
      ),
    ).toBe(true);
  });
});

describe("createProviderInstallResetPatch", () => {
  it("resets every configured field and writes password values so configured flags clear", () => {
    const patch = createProviderInstallResetPatch({
      ...defaults,
      kiloServerPassword: "",
      openCodeServerPassword: "",
    });

    expect(Object.keys(patch).sort()).toEqual(
      [
        "antigravityBinaryPath",
        "claudeBinaryPath",
        "codexBinaryPath",
        "codexHomePath",
        "commandCodeBinaryPath",
        "cursorApiEndpoint",
        "cursorBinaryPath",
        "droidBinaryPath",
        "grokBinaryPath",
        "kiloBinaryPath",
        "kiloServerPassword",
        "kiloServerUrl",
        "openCodeBinaryPath",
        "openCodeExperimentalWebSockets",
        "openCodeServerPassword",
        "openCodeServerUrl",
        "piAgentDir",
        "piBinaryPath",
      ].sort(),
    );
    expect(patch.kiloServerPassword).toBe("");
    expect(patch.openCodeServerPassword).toBe("");
  });
});
