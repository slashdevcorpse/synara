import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderListModelsInput, ProviderListModelsResult } from "./providerDiscovery";

const decodeProviderListModelsResult = Schema.decodeUnknownSync(ProviderListModelsResult);
const decodeProviderListModelsInput = Schema.decodeUnknownSync(ProviderListModelsInput);

describe("ProviderListModelsResult", () => {
  it("accepts Command Code model discovery requests", () => {
    expect(
      decodeProviderListModelsInput({
        provider: "commandCode",
        binaryPath: "C:\\tools\\commandcode.cmd",
      }),
    ).toEqual({
      provider: "commandCode",
      binaryPath: "C:\\tools\\commandcode.cmd",
    });
  });

  it("accepts configured Codex model discovery requests", () => {
    expect(
      decodeProviderListModelsInput({
        provider: "codex",
        binaryPath: "C:\\tools\\codex.cmd",
        homePath: "C:\\isolated\\codex-home",
        cwd: "C:\\repo",
      }),
    ).toEqual({
      provider: "codex",
      binaryPath: "C:\\tools\\codex.cmd",
      homePath: "C:\\isolated\\codex-home",
      cwd: "C:\\repo",
    });
  });

  it("preserves optional runtime model descriptions", () => {
    const result = decodeProviderListModelsResult({
      models: [
        {
          slug: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          description: "0.4x Factory token rate",
        },
        {
          slug: "custom:GPT-5.6-Luna-0",
          name: "GPT-5.6 Luna",
        },
      ],
      source: "droid-acp",
    });

    expect(result.models[0]?.description).toBe("0.4x Factory token rate");
    expect(result.models[1]?.description).toBeUndefined();
  });
});
