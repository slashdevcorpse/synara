import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "./settings";

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
});
