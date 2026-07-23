import { statSync } from "node:fs";
import * as NodePath from "node:path";

import {
  readEffectiveWindowsEnvironmentValue,
  resolveWindowsSystemRoot,
} from "@synara/shared/windowsProcess";
import { parse, type ParseError } from "jsonc-parser";

import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";

export type OpenCodeCompatibleProvider = "kilo" | "opencode";

const OPENCODE_DISABLE_AUTOUPDATE_ENV = "OPENCODE_DISABLE_AUTOUPDATE";
const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";
const KILO_CONFIG_CONTENT_ENV = "KILO_CONFIG_CONTENT";

type IsFile = (path: string) => boolean;

const isFile: IsFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  return platform === "win32" ? readEffectiveWindowsEnvironmentValue(env, name) : env[name];
}

function parseConfigContentRecord(content: string | undefined): Record<string, unknown> {
  if (!content?.trim()) {
    return {};
  }

  const errors: ParseError[] = [];
  const parsed = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (
    errors.length === 0 &&
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    return parsed as Record<string, unknown>;
  }

  // Invalid or non-object inline content cannot be safely merged. Replace only the
  // child-process overlay with the required safe values; never mutate the parent env
  // or the provider's persisted configuration.
  return {};
}

function normalizeLocalWindowsPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;
  const normalized = NodePath.win32.normalize(trimmed.replaceAll("/", "\\"));
  return /^[A-Za-z]:\\/u.test(normalized) ? normalized : undefined;
}

function resolveBuiltInWindowsPowerShell(env: NodeJS.ProcessEnv): string {
  const systemRoot =
    normalizeLocalWindowsPath(resolveWindowsSystemRoot(env)) ?? String.raw`C:\Windows`;
  return NodePath.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function resolveSafeWindowsShell(
  config: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
  checkIsFile: IsFile,
): string {
  const configuredShell =
    typeof config.shell === "string" ? normalizeLocalWindowsPath(config.shell) : undefined;
  if (
    configuredShell &&
    NodePath.win32.basename(configuredShell).toLowerCase() === "pwsh.exe" &&
    checkIsFile(configuredShell)
  ) {
    return configuredShell;
  }
  return resolveBuiltInWindowsPowerShell(env);
}

function mergeConfigContentForChild(
  content: string | undefined,
  makeOverrides: (config: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): string {
  const config = parseConfigContentRecord(content);
  return JSON.stringify({
    ...config,
    ...makeOverrides(config),
  });
}

export function mergeKiloConfigContentForChild(
  content: string | undefined,
  platform: NodeJS.Platform = process.platform,
  options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly isFile?: IsFile;
  },
): string {
  const env = options?.env ?? process.env;
  const checkIsFile = options?.isFile ?? isFile;
  return mergeConfigContentForChild(content, (config) => ({
    autoupdate: false,
    ...(platform === "win32" ? { shell: resolveSafeWindowsShell(config, env, checkIsFile) } : {}),
  }));
}

export function buildOpenCodeCompatibleProcessEnv(input: {
  readonly provider: OpenCodeCompatibleProvider;
  readonly experimentalWebSockets?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly isFile?: IsFile;
}): NodeJS.ProcessEnv {
  const baseEnv = input.baseEnv ?? process.env;
  const platform = input.platform ?? process.platform;
  const overrides: NodeJS.ProcessEnv = {};

  if (input.provider === "kilo") {
    overrides[KILO_CONFIG_CONTENT_ENV] = mergeKiloConfigContentForChild(
      environmentValue(baseEnv, KILO_CONFIG_CONTENT_ENV, platform),
      platform,
      { env: baseEnv, ...(input.isFile ? { isFile: input.isFile } : {}) },
    );
  } else {
    overrides[OPENCODE_DISABLE_AUTOUPDATE_ENV] = "1";
    if (platform === "win32") {
      overrides[OPENCODE_CONFIG_CONTENT_ENV] = mergeConfigContentForChild(
        environmentValue(baseEnv, OPENCODE_CONFIG_CONTENT_ENV, platform),
        (config) => ({
          shell: resolveSafeWindowsShell(config, baseEnv, input.isFile ?? isFile),
        }),
      );
    }
  }

  if (input.experimentalWebSockets) {
    overrides.OPENCODE_EXPERIMENTAL_WEBSOCKETS = "true";
  }

  const childEnv = buildProviderChildEnvironment({
    provider: input.provider,
    baseEnv,
    overrides,
    platform,
  });
  return childEnv;
}
