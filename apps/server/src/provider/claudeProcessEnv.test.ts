// FILE: claudeProcessEnv.test.ts
// Purpose: Covers Claude env sanitization so stale process tokens do not shadow CLI OAuth.
// Layer: Provider utility tests.
// Exports: Vitest coverage for apps/server/src/provider/claudeProcessEnv.ts.
import nodePath from "node:path";

import { readEffectiveWindowsEnvironmentValue } from "@synara/shared/windowsProcess";
import { describe, it, assert } from "@effect/vitest";

import {
  buildClaudeProcessEnv,
  hasUsableClaudeCliCredentials,
  hasUsableClaudeCliCredentialsContent,
  readClaudeCliCredentialsContentSummary,
  resolveClaudeCredentialsPaths,
} from "./claudeProcessEnv.ts";

describe("claudeProcessEnv", () => {
  it("prefers local Claude CLI credentials over stale direct request credentials", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/tester",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude",
      ANTHROPIC_API_KEY: "stale-api-key",
      ANTHROPIC_AUTH_TOKEN: "stale-auth-token",
      CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth-token",
    };

    const result = buildClaudeProcessEnv({
      env,
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.PATH, "/bin");
    assert.equal(result.HOME, "/home/tester");
    assert.equal(result.CLAUDE_CONFIG_DIR, "/home/tester/.claude");
    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(result.DISABLE_AUTOUPDATER, "1");
    assert.equal(env.ANTHROPIC_API_KEY, "stale-api-key");
  });

  it("keeps direct credentials when no local Claude CLI login is usable", () => {
    const result = buildClaudeProcessEnv({
      env: {
        ANTHROPIC_API_KEY: "api-key-auth",
      },
      hasClaudeCliCredentials: false,
    });

    assert.equal(result.ANTHROPIC_API_KEY, "api-key-auth");
    assert.equal(result.DISABLE_AUTOUPDATER, "1");
  });

  it("overrides inherited updater settings without mutating the source environment", () => {
    const env = {
      DISABLE_AUTOUPDATER: "0",
    };
    const result = buildClaudeProcessEnv({
      env,
      hasClaudeCliCredentials: false,
      platform: "linux",
    });

    assert.equal(result.DISABLE_AUTOUPDATER, "1");
    assert.equal(env.DISABLE_AUTOUPDATER, "0");
  });

  it("normalizes mixed-case Windows updater keys to the process-local override", () => {
    const result = buildClaudeProcessEnv({
      env: {
        Disable_AutoUpdater: "0",
      },
      hasClaudeCliCredentials: false,
      platform: "win32",
    });

    assert.equal(result.DISABLE_AUTOUPDATER, "1");
    assert.equal(result.Disable_AutoUpdater, undefined);
  });

  it("removes mixed-case Windows direct credentials when local OAuth is usable", () => {
    const env = {
      anthropic_api_key: "stale-api-key",
      Anthropic_Auth_Token: "stale-auth-token",
      claude_code_oauth_token: "stale-oauth-token",
      Path: "C:\\Windows",
    };

    const result = buildClaudeProcessEnv({
      env,
      hasClaudeCliCredentials: true,
      platform: "win32",
    });

    assert.equal(readEffectiveWindowsEnvironmentValue(result, "ANTHROPIC_API_KEY"), undefined);
    assert.equal(readEffectiveWindowsEnvironmentValue(result, "ANTHROPIC_AUTH_TOKEN"), undefined);
    assert.equal(
      readEffectiveWindowsEnvironmentValue(result, "CLAUDE_CODE_OAUTH_TOKEN"),
      undefined,
    );
    assert.equal(readEffectiveWindowsEnvironmentValue(result, "PATH"), "C:\\Windows");
    assert.equal(env.anthropic_api_key, "stale-api-key");
  });

  it("recognizes mixed-case Windows external auth before applying OAuth isolation", () => {
    const result = buildClaudeProcessEnv({
      env: {
        anthropic_api_key: "proxy-api-key",
        anthropic_base_url: "https://anthropic-proxy.example.test",
      },
      hasClaudeCliCredentials: true,
      platform: "win32",
    });

    assert.equal(
      readEffectiveWindowsEnvironmentValue(result, "ANTHROPIC_API_KEY"),
      "proxy-api-key",
    );
    assert.equal(
      readEffectiveWindowsEnvironmentValue(result, "ANTHROPIC_BASE_URL"),
      "https://anthropic-proxy.example.test",
    );
  });

  it("does not grant Synara control-plane authority to Claude", () => {
    const result = buildClaudeProcessEnv({
      env: {
        ANTHROPIC_API_KEY: "api-key-auth",
        SYNARA_AUTH_TOKEN: "server-secret",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/browser.sock",
        NODE_OPTIONS: "--require=/tmp/inject.js",
      },
      hasClaudeCliCredentials: false,
    });

    assert.equal(result.ANTHROPIC_API_KEY, "api-key-auth");
    assert.equal(result.SYNARA_AUTH_TOKEN, undefined);
    assert.equal(result.SYNARA_BROWSER_USE_PIPE_PATH, undefined);
    assert.equal(result.NODE_OPTIONS, undefined);
  });

  it("aligns subprocess HOME with the credential home it checks", () => {
    const result = buildClaudeProcessEnv({
      env: {
        HOME: "/wrong-home",
      },
      homeDir: "/home/tester",
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.HOME, "/home/tester");
  });

  it("keeps direct credentials for explicitly configured Claude-compatible backends", () => {
    const result = buildClaudeProcessEnv({
      env: {
        ANTHROPIC_API_KEY: "proxy-api-key",
        ANTHROPIC_BASE_URL: "https://anthropic-proxy.example.test",
      },
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.ANTHROPIC_API_KEY, "proxy-api-key");
    assert.equal(result.ANTHROPIC_BASE_URL, "https://anthropic-proxy.example.test");
  });

  it("checks CLAUDE_CONFIG_DIR before the default Claude home", () => {
    const root = nodePath.parse(process.cwd()).root;
    const configDir = nodePath.join(root, "tmp", "custom-claude");
    const homeDir = nodePath.join(root, "home", "tester");

    assert.deepEqual(
      resolveClaudeCredentialsPaths({
        env: { CLAUDE_CONFIG_DIR: configDir },
        homeDir,
      }),
      [
        nodePath.join(configDir, ".credentials.json"),
        nodePath.join(homeDir, ".claude", ".credentials.json"),
      ],
    );
  });

  it("detects usable Claude OAuth credential files", () => {
    assert.equal(
      hasUsableClaudeCliCredentialsContent(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "local-access-token",
            expiresAt: 2_000,
          },
        }),
        1_000,
      ),
      true,
    );

    assert.equal(
      hasUsableClaudeCliCredentialsContent(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-access-token",
            refreshToken: "refresh-token",
            expiresAt: 500,
          },
        }),
        1_000,
      ),
      true,
    );
  });

  it("reads subscription metadata from usable Claude OAuth credentials", () => {
    assert.deepEqual(
      readClaudeCliCredentialsContentSummary(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "local-access-token",
            refreshToken: "refresh-token",
            expiresAt: 2_000,
            subscriptionType: "max",
          },
        }),
        1_000,
      ),
      { usable: true, subscriptionType: "max" },
    );
  });

  it("rejects leftover expired or malformed Claude credential files", () => {
    assert.equal(
      hasUsableClaudeCliCredentialsContent(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-access-token",
            expiresAt: 500,
          },
        }),
        1_000,
      ),
      false,
    );
    assert.equal(hasUsableClaudeCliCredentialsContent("{}", 1_000), false);
    assert.equal(hasUsableClaudeCliCredentialsContent("not json", 1_000), false);
  });

  it("reads the first usable credentials path", () => {
    const seen: string[] = [];
    const root = nodePath.parse(process.cwd()).root;
    const configDir = nodePath.join(root, "tmp", "custom-claude");
    const homeDir = nodePath.join(root, "home", "tester");
    const configCredentialsPath = nodePath.join(configDir, ".credentials.json");

    assert.equal(
      hasUsableClaudeCliCredentials({
        env: { CLAUDE_CONFIG_DIR: configDir },
        homeDir,
        nowMs: 1_000,
        readFile: (path) => {
          seen.push(path);
          if (path === configCredentialsPath) {
            throw new Error("missing");
          }
          return JSON.stringify({
            claudeAiOauth: {
              accessToken: "local-access-token",
              expiresAt: 2_000,
            },
          });
        },
      }),
      true,
    );
    assert.deepEqual(seen, [
      configCredentialsPath,
      nodePath.join(homeDir, ".claude", ".credentials.json"),
    ]);
  });
});
