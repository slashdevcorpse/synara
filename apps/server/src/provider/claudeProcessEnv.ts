// FILE: claudeProcessEnv.ts
// Purpose: Builds Claude subprocess environments that prefer valid local Claude CLI OAuth.
// Layer: Provider utility shared by Claude runtime sessions and provider health probes.
// Exports: Claude credentials parsing, path resolution, and env sanitization helpers.
import { readFileSync } from "node:fs";
import OS from "node:os";
import nodePath from "node:path";

import {
  normalizeWindowsChildEnvironment,
  readEffectiveWindowsEnvironmentValue,
} from "@synara/shared/windowsProcess";

import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";

const CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

const CLAUDE_EXTERNAL_AUTH_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && normalized !== "0" && normalized !== "false");
}

function readEnvironmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  return platform === "win32" ? readEffectiveWindowsEnvironmentValue(env, key) : env[key];
}

function deleteEnvironmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): void {
  if (platform !== "win32") {
    delete env[key];
    return;
  }
  const normalizedKey = key.toUpperCase();
  for (const candidate of Object.keys(env)) {
    if (candidate.toUpperCase() === normalizedKey) {
      delete env[candidate];
    }
  }
}

function hasClaudeExternalAuthEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return CLAUDE_EXTERNAL_AUTH_ENV_KEYS.some((key) =>
    envFlagEnabled(readEnvironmentValue(env, key, platform)),
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tryParseJsonRecord(content: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}

export interface ClaudeCliCredentialsSummary {
  readonly usable: boolean;
  readonly subscriptionType?: string;
}

export function resolveClaudeCredentialsPaths(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}): ReadonlyArray<string> {
  const env = input?.env ?? process.env;
  const platform = input?.platform ?? process.platform;
  const homeDir =
    trimToUndefined(input?.homeDir) ??
    trimToUndefined(readEnvironmentValue(env, "HOME", platform)) ??
    OS.homedir();
  const paths: string[] = [];
  const configDir = trimToUndefined(readEnvironmentValue(env, "CLAUDE_CONFIG_DIR", platform));
  if (configDir) {
    paths.push(nodePath.join(configDir, ".credentials.json"));
  }
  paths.push(nodePath.join(homeDir, ".claude", ".credentials.json"));
  return [...new Set(paths)];
}

export function hasUsableClaudeCliCredentialsContent(content: string, nowMs = Date.now()): boolean {
  return readClaudeCliCredentialsContentSummary(content, nowMs).usable;
}

export function readClaudeCliCredentialsContentSummary(
  content: string,
  nowMs = Date.now(),
): ClaudeCliCredentialsSummary {
  const root = tryParseJsonRecord(content);
  const oauth = readRecord(root?.claudeAiOauth);
  const accessToken = readNonEmptyString(oauth?.accessToken);
  const refreshToken = readNonEmptyString(oauth?.refreshToken);
  if (!accessToken && !refreshToken) {
    return { usable: false };
  }

  const expiresAtMs = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
  const usable = expiresAtMs === undefined || expiresAtMs > nowMs || refreshToken !== undefined;
  const subscriptionType = readNonEmptyString(oauth?.subscriptionType);
  return {
    usable,
    ...(subscriptionType ? { subscriptionType } : {}),
  };
}

export function hasUsableClaudeCliCredentials(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly nowMs?: number;
  readonly readFile?: (path: string) => string;
}): boolean {
  return readClaudeCliCredentialsSummary(input).usable;
}

export function readClaudeCliCredentialsSummary(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly nowMs?: number;
  readonly readFile?: (path: string) => string;
}): ClaudeCliCredentialsSummary {
  const readFile = input?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  for (const path of resolveClaudeCredentialsPaths(input)) {
    try {
      const summary = readClaudeCliCredentialsContentSummary(readFile(path), input?.nowMs);
      if (summary.usable) {
        return summary;
      }
    } catch {
      continue;
    }
  }
  return { usable: false };
}

export function buildClaudeProcessEnv(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly hasClaudeCliCredentials?: boolean;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = input?.platform ?? process.platform;
  const sourceEnv = { ...(input?.env ?? process.env) };
  const env = platform === "win32" ? normalizeWindowsChildEnvironment(sourceEnv) : sourceEnv;
  if (input?.homeDir) {
    deleteEnvironmentValue(env, "HOME", platform);
    env.HOME = input.homeDir;
  }
  const credentialInput = input?.homeDir
    ? { env, homeDir: input.homeDir, platform }
    : { env, platform };
  const hasLocalClaudeAuth =
    input?.hasClaudeCliCredentials ?? hasUsableClaudeCliCredentials(credentialInput);

  if (hasLocalClaudeAuth && !hasClaudeExternalAuthEnv(env, platform)) {
    // Claude gives direct request credentials precedence over local OAuth. Drop stale
    // app-process keys when a real Claude CLI login can satisfy the subprocess.
    for (const key of CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS) {
      deleteEnvironmentValue(env, key, platform);
    }
  }

  const childEnv = buildProviderChildEnvironment({
    provider: "claude",
    baseEnv: env,
    overrides: { DISABLE_AUTOUPDATER: "1" },
    platform,
  });
  return childEnv;
}
