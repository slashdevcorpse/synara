import {
  DEFAULT_SERVER_SETTINGS,
  ProviderStartOptions,
  type ServerSettings,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { providerStartOptionsFromServerSettings } from "./serverSettings";

function withProviderPaths(
  binaryPath: string,
  commandCodeBinaryPath = binaryPath,
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, binaryPath },
      commandCode: {
        ...DEFAULT_SERVER_SETTINGS.providers.commandCode,
        binaryPath: commandCodeBinaryPath,
      },
      claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, binaryPath },
      cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, binaryPath },
      antigravity: { ...DEFAULT_SERVER_SETTINGS.providers.antigravity, binaryPath },
      grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, binaryPath },
      droid: { ...DEFAULT_SERVER_SETTINGS.providers.droid, binaryPath },
      kilo: { ...DEFAULT_SERVER_SETTINGS.providers.kilo, binaryPath },
      opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, binaryPath },
      pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, binaryPath },
    },
  };
}

describe("providerStartOptionsFromServerSettings", () => {
  it("omits cleared provider paths so adapters can use PATH defaults", () => {
    const options = providerStartOptionsFromServerSettings(withProviderPaths("   "));

    for (const providerOptions of Object.values(options)) {
      expect(providerOptions).not.toHaveProperty("binaryPath");
    }
    expect(() => Schema.decodeUnknownSync(ProviderStartOptions)(options)).not.toThrow();
  });

  it("preserves explicit paths and includes Command Code", () => {
    const windowsCodexPath = String.raw`C:\Tools\codex.exe`;
    const windowsCommandCodePath = String.raw`C:\Tools\commandcode.exe`;
    const options = providerStartOptionsFromServerSettings(
      withProviderPaths(windowsCodexPath, windowsCommandCodePath),
    );

    expect(options.codex?.binaryPath).toBe(windowsCodexPath);
    expect(options.commandCode?.binaryPath).toBe(windowsCommandCodePath);
    expect(options.droid?.binaryPath).toBe(windowsCodexPath);
    expect(Schema.decodeUnknownSync(ProviderStartOptions)(options)).toEqual(options);
  });

  it("keeps non-path launch options when a provider path is cleared", () => {
    const settings = withProviderPaths("");
    const options = providerStartOptionsFromServerSettings({
      ...settings,
      providers: {
        ...settings.providers,
        codex: { ...settings.providers.codex, homePath: String.raw`C:\CodexHome` },
        cursor: { ...settings.providers.cursor, apiEndpoint: "https://cursor.example" },
        kilo: { ...settings.providers.kilo, serverUrl: "https://kilo.example" },
        opencode: {
          ...settings.providers.opencode,
          serverUrl: "https://opencode.example",
          experimentalWebSockets: true,
        },
        pi: { ...settings.providers.pi, agentDir: String.raw`C:\PiAgents` },
      },
    });

    expect(options).toMatchObject({
      codex: { homePath: String.raw`C:\CodexHome` },
      cursor: { apiEndpoint: "https://cursor.example" },
      kilo: { serverUrl: "https://kilo.example" },
      opencode: {
        serverUrl: "https://opencode.example",
        experimentalWebSockets: true,
      },
      pi: { agentDir: String.raw`C:\PiAgents` },
    });
    expect(() => Schema.decodeUnknownSync(ProviderStartOptions)(options)).not.toThrow();
  });
});
