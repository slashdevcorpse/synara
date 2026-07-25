import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings";

describe("Command Code server settings", () => {
  it("defaults to the Command Code executable without changing stock Codex", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.commandCode).toMatchObject({
      enabled: true,
      binaryPath: "commandcode",
      customModels: [],
    });
    expect(DEFAULT_SERVER_SETTINGS.providers.codex.binaryPath).toBe("codex");
  });

  it("accepts a custom Command Code binary path and custom models", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({
      providers: {
        commandCode: {
          binaryPath: "C:\\tools\\commandcode.cmd",
          customModels: ["private/model"],
        },
      },
    });

    expect(patch.providers?.commandCode).toEqual({
      binaryPath: "C:\\tools\\commandcode.cmd",
      customModels: ["private/model"],
    });
  });

  it("normalizes explicit blank provider paths to defaults at the settings boundary", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({
      providers: Object.fromEntries(
        Object.keys(DEFAULT_SERVER_SETTINGS.providers).map((provider) => [
          provider,
          { binaryPath: " \t " },
        ]),
      ),
    });

    expect(
      Object.fromEntries(
        Object.entries(settings.providers).map(([provider, value]) => [
          provider,
          value.binaryPath,
        ]),
      ),
    ).toEqual({
      codex: "codex",
      commandCode: "commandcode",
      claudeAgent: "claude",
      cursor: "cursor-agent",
      antigravity: "agy",
      grok: "grok",
      droid: "droid",
      kilo: "kilo",
      opencode: "opencode",
      pi: "pi",
    });
  });

  it("normalizes blank patch paths so persistence resets providers to their defaults", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({
      providers: {
        codex: { binaryPath: "   " },
        commandCode: { binaryPath: "\t" },
        opencode: { binaryPath: "" },
        antigravity: { binaryPath: " " },
        droid: { binaryPath: " " },
      },
    });

    expect(patch.providers).toMatchObject({
      codex: { binaryPath: "codex" },
      commandCode: { binaryPath: "commandcode" },
      opencode: { binaryPath: "opencode" },
      antigravity: { binaryPath: "agy" },
      droid: { binaryPath: "droid" },
    });
  });
});
