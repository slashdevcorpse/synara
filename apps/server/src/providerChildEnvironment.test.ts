import { spawnSync } from "node:child_process";

import { readEffectiveWindowsEnvironmentValue } from "@synara/shared/windowsProcess";
import { describe, expect, it } from "vitest";

import { buildProviderChildEnvironment } from "./providerChildEnvironment";

describe("buildProviderChildEnvironment", () => {
  it("strips Synara control-plane and inherited native capabilities", () => {
    const env = buildProviderChildEnvironment({
      provider: "antigravity",
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        GEMINI_API_KEY: "provider-key",
        SYNARA_AUTH_TOKEN: "control-plane-secret",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/browser.sock",
        NODE_OPTIONS: "--require=/tmp/inject.js",
        NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/other.sock",
      },
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GEMINI_API_KEY: "provider-key",
    });
  });

  it("admits only explicitly granted capability keys", () => {
    const env = buildProviderChildEnvironment({
      provider: "codex",
      baseEnv: {
        SYNARA_AUTH_TOKEN: "control-plane-secret",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/browser.sock",
        NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/browser.sock",
      },
      inheritedSynaraKeys: ["SYNARA_BROWSER_USE_PIPE_PATH"],
      inheritedNativeCapabilityKeys: ["NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS"],
    });

    expect(env).toEqual({
      SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/browser.sock",
      NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/browser.sock",
    });
  });

  it("does not let overlays bypass the capability policy", () => {
    const env = buildProviderChildEnvironment({
      provider: "opencode",
      baseEnv: { PATH: "/usr/bin" },
      overrides: {
        OPENCODE_EXPERIMENTAL_WEBSOCKETS: "true",
        SYNARA_AUTH_TOKEN: "overlaid-control-plane-secret",
        NODE_OPTIONS: "--require=/tmp/inject.js",
      },
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      OPENCODE_EXPERIMENTAL_WEBSOCKETS: "true",
    });
  });

  it("forces Command Code update suppression after caller overlays without removing credentials", () => {
    const env = buildProviderChildEnvironment({
      provider: "commandCode",
      baseEnv: {
        COMMANDCODE_SKIP_UPDATES: "0",
        OPENAI_API_KEY: "openai-secret",
      },
      overrides: {
        COMMANDCODE_SKIP_UPDATES: "false",
        ANTHROPIC_API_KEY: "anthropic-secret",
      },
    });

    expect(env.COMMANDCODE_SKIP_UPDATES).toBe("1");
    expect(env.OPENAI_API_KEY).toBe("openai-secret");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-secret");
  });

  it("prevents mixed-case Windows overlays from disabling Command Code update suppression", () => {
    const env = buildProviderChildEnvironment({
      provider: "commandCode",
      baseEnv: {
        commandcode_skip_updates: "0",
      },
      overrides: {
        CommandCode_Skip_Updates: "false",
      },
      platform: "win32",
    });

    expect(readEffectiveWindowsEnvironmentValue(env, "COMMANDCODE_SKIP_UPDATES")).toBe("1");
    expect(
      Object.keys(env).filter((key) => key.toUpperCase() === "COMMANDCODE_SKIP_UPDATES"),
    ).toEqual(["COMMANDCODE_SKIP_UPDATES"]);
  });

  it.each([
    "acp",
    "antigravity",
    "claude",
    "codex",
    "cursor",
    "droid",
    "grok",
    "kilo",
    "opencode",
    "pi",
  ] as const)("does not inject Command Code update suppression for %s", (provider) => {
    const env = buildProviderChildEnvironment({
      provider,
      baseEnv: { PATH: "/usr/bin" },
    });

    expect(env.COMMANDCODE_SKIP_UPDATES).toBeUndefined();
  });

  it.each([
    ["claude", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
    ["cursor", "CURSOR_API_KEY", "FACTORY_API_KEY"],
    ["droid", "FACTORY_API_KEY", "XAI_API_KEY"],
    ["antigravity", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"],
    ["grok", "XAI_API_KEY", "GOOGLE_API_KEY"],
  ] as const)(
    "grants %s only its declared provider credential group",
    (provider, grantedKey, unrelatedKey) => {
      const env = buildProviderChildEnvironment({
        provider,
        baseEnv: {
          PATH: "/usr/bin",
          [grantedKey]: "native-provider-secret",
          [unrelatedKey]: "unrelated-provider-secret",
        },
      });

      expect(env[grantedKey]).toBe("native-provider-secret");
      expect(env[unrelatedKey]).toBeUndefined();
    },
  );

  it.each(["codex", "commandCode", "kilo", "opencode", "pi"] as const)(
    "preserves upstream credential discovery for multi-provider %s",
    (provider) => {
      const env = buildProviderChildEnvironment({
        provider,
        baseEnv: {
          ANTHROPIC_API_KEY: "anthropic-secret",
          AZURE_OPENAI_API_KEY: "azure-openai-secret",
          GEMINI_API_KEY: "gemini-secret",
          KIMI_MODEL_API_KEY: "kimi-secret",
          OPENAI_API_KEY: "openai-secret",
        },
      });

      expect(env.ANTHROPIC_API_KEY).toBe("anthropic-secret");
      expect(env.AZURE_OPENAI_API_KEY).toBe("azure-openai-secret");
      expect(env.GEMINI_API_KEY).toBe("gemini-secret");
      expect(env.KIMI_MODEL_API_KEY).toBe("kimi-secret");
      expect(env.OPENAI_API_KEY).toBe("openai-secret");
    },
  );

  it("filters mixed-case Windows credentials using case-insensitive policy keys", () => {
    const source = {
      Path: "C:\\tools",
      factory_api_key: "factory-secret",
      OpenAi_Api_Key: "openai-secret",
      Azure_OpenAI_Api_Key: "azure-secret",
      Kimi_Model_Api_Key: "kimi-secret",
      PortKey_Api_Key: "portkey-secret",
    };
    const env = buildProviderChildEnvironment({
      provider: "droid",
      baseEnv: source,
      platform: "win32",
    });

    expect(readEffectiveWindowsEnvironmentValue(env, "PATH")).toBe("C:\\tools");
    expect(readEffectiveWindowsEnvironmentValue(env, "FACTORY_API_KEY")).toBe("factory-secret");
    expect(readEffectiveWindowsEnvironmentValue(env, "OPENAI_API_KEY")).toBeUndefined();
    expect(readEffectiveWindowsEnvironmentValue(env, "AZURE_OPENAI_API_KEY")).toBeUndefined();
    expect(readEffectiveWindowsEnvironmentValue(env, "KIMI_MODEL_API_KEY")).toBeUndefined();
    expect(readEffectiveWindowsEnvironmentValue(env, "PORTKEY_API_KEY")).toBeUndefined();
    expect(source.OpenAi_Api_Key).toBe("openai-secret");
  });

  it("does not let mixed-case Windows overlays bypass credential policy", () => {
    const env = buildProviderChildEnvironment({
      provider: "grok",
      baseEnv: { XAI_API_KEY: "grok-secret" },
      overrides: {
        OpenAi_Api_Key: "overlaid-openai-secret",
        Azure_Api_Key: "overlaid-azure-secret",
      },
      platform: "win32",
    });

    expect(readEffectiveWindowsEnvironmentValue(env, "XAI_API_KEY")).toBe("grok-secret");
    expect(readEffectiveWindowsEnvironmentValue(env, "OPENAI_API_KEY")).toBeUndefined();
    expect(readEffectiveWindowsEnvironmentValue(env, "AZURE_API_KEY")).toBeUndefined();
  });

  it("keeps stripped authority absent in descendants", () => {
    const env = buildProviderChildEnvironment({
      provider: "grok",
      baseEnv: {
        XAI_API_KEY: "grok-secret",
        ANTHROPIC_API_KEY: "unrelated-secret",
        SYNARA_AUTH_TOKEN: "control-plane-secret",
      },
    });
    const descendantScript =
      "process.stdout.write(JSON.stringify({ xai: process.env.XAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, synara: process.env.SYNARA_AUTH_TOKEN }))";
    const parentScript = `const { spawnSync } = require("node:child_process"); const result = spawnSync(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { env: process.env, encoding: "utf8" }); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);`;
    const result = spawnSync(process.execPath, ["-e", parentScript], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ xai: "grok-secret" });
  });
});
