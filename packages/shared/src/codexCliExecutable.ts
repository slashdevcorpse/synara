// FILE: codexCliExecutable.ts
// Purpose: Resolves the configured or first PATH-selected Codex CLI on Windows.
// Layer: Shared Node runtime utility

import { statSync } from "node:fs";
import * as Path from "node:path";

import {
  resolveWindowsCommandPath,
  resolveWindowsCommandPathAsync,
  unresolvedWindowsCommandDiscoveryOutcome,
  type WindowsAsyncCommandDiscoveryInput,
  type WindowsCommandDiscoveryObservation,
  type WindowsCommandDiscoveryOutcome,
  type WindowsSafeProcessInput,
} from "./windowsProcess";

interface FileStatLike {
  isFile(): boolean;
}

type StatSyncLike = (path: string) => FileStatLike;
type ReadFileSyncLike = (path: string, encoding: "utf8") => string;

export interface CodexCliExecutableInput extends WindowsSafeProcessInput {
  readonly statSync?: StatSyncLike | undefined;
  /**
   * Retained for source compatibility with callers that injected the former
   * package-version probe. Resolution no longer reads package metadata.
   */
  readonly readFileSync?: ReadFileSyncLike | undefined;
  readonly arch?: NodeJS.Architecture | undefined;
}

export interface CodexCliExecutableAsyncInput
  extends CodexCliExecutableInput, WindowsAsyncCommandDiscoveryInput {}

export interface CodexCliExecutableResolution {
  /**
   * Discovery result, not a directly spawnable Windows launch plan. This may
   * be an absolute `.cmd` or `.bat` candidate; launching consumers must retain
   * their argument vector and pass both through Windows provider preparation,
   * which validates canonical npm shims and resolves their native Node host.
   */
  readonly executable: string;
  readonly discoveryOutcome?: WindowsCommandDiscoveryOutcome | undefined;
}

const DEFAULT_CODEX_COMMAND = "codex";
const WINDOWS_EXECUTABLE_PATTERN = /\.(?:exe|com|cmd|bat)$/iu;

function readEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toUpperCase();
  const effectiveName = Object.keys(env)
    .filter((key) => env[key] !== undefined && key.toUpperCase() === normalizedName)
    .sort()[0];
  return effectiveName === undefined ? undefined : env[effectiveName];
}

function nonEmptyEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = readEnvironmentValue(env, name)?.trim();
  return value ? value : undefined;
}

function isAbsoluteRegularWindowsExecutable(candidate: string, readStat: StatSyncLike): boolean {
  if (!Path.win32.isAbsolute(candidate) || !WINDOWS_EXECUTABLE_PATTERN.test(candidate)) {
    return false;
  }
  try {
    return readStat(candidate).isFile();
  } catch {
    return false;
  }
}

function fallbackCodexCandidates(input: CodexCliExecutableInput): ReadonlyArray<string> {
  const env = input.env ?? process.env;
  const localAppData = nonEmptyEnvironmentValue(env, "LOCALAPPDATA");
  const appData = nonEmptyEnvironmentValue(env, "APPDATA");
  const installDirectory = nonEmptyEnvironmentValue(env, "CODEX_INSTALL_DIR");
  return [
    ...(installDirectory ? [Path.win32.join(installDirectory, "codex.exe")] : []),
    ...(localAppData
      ? [Path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe")]
      : []),
    ...(appData ? [Path.win32.join(appData, "npm", "codex.cmd")] : []),
  ];
}

function firstVerifiedFallback(input: CodexCliExecutableInput): string | undefined {
  const readStat = input.statSync ?? statSync;
  return fallbackCodexCandidates(input).find((candidate) =>
    isAbsoluteRegularWindowsExecutable(candidate, readStat),
  );
}

function observeCodexCommandDiscovery(input: CodexCliExecutableInput): {
  readonly observations: WindowsCommandDiscoveryObservation[];
  readonly discoveryInput: CodexCliExecutableInput;
} {
  const observations: WindowsCommandDiscoveryObservation[] = [];
  return {
    observations,
    discoveryInput: {
      ...input,
      onCommandDiscovery: (observation) => {
        observations.push(observation);
        input.onCommandDiscovery?.(observation);
      },
    },
  };
}

function resolution(
  executable: string,
  observations: ReadonlyArray<WindowsCommandDiscoveryObservation>,
): CodexCliExecutableResolution {
  return {
    executable,
    ...(!Path.win32.isAbsolute(executable)
      ? { discoveryOutcome: unresolvedWindowsCommandDiscoveryOutcome(observations) }
      : {}),
  };
}

function defaultCodexResolutionAfterUnresolvedDiscovery(
  input: CodexCliExecutableInput,
  observations: ReadonlyArray<WindowsCommandDiscoveryObservation>,
): CodexCliExecutableResolution {
  const discoveryOutcome = unresolvedWindowsCommandDiscoveryOutcome(observations);
  if (discoveryOutcome !== "not_found") {
    return {
      executable: DEFAULT_CODEX_COMMAND,
      ...(discoveryOutcome ? { discoveryOutcome } : {}),
    };
  }
  return resolution(firstVerifiedFallback(input) ?? DEFAULT_CODEX_COMMAND, observations);
}

export function resolveCodexCliExecutableWithDiscovery(
  command: string,
  input: CodexCliExecutableInput = {},
): CodexCliExecutableResolution {
  if ((input.platform ?? process.platform) !== "win32") {
    return { executable: command };
  }

  const { observations, discoveryInput } = observeCodexCommandDiscovery(input);
  const isDefault = command.trim().toLowerCase() === DEFAULT_CODEX_COMMAND;
  const resolved = resolveWindowsCommandPath(
    isDefault ? DEFAULT_CODEX_COMMAND : command,
    discoveryInput,
  );
  if (!isDefault || Path.win32.isAbsolute(resolved)) {
    return resolution(resolved, observations);
  }

  return defaultCodexResolutionAfterUnresolvedDiscovery(input, observations);
}

export function resolveCodexCliExecutable(
  command: string,
  input: CodexCliExecutableInput = {},
): string {
  return resolveCodexCliExecutableWithDiscovery(command, input).executable;
}

export async function resolveCodexCliExecutableWithDiscoveryAsync(
  command: string,
  input: CodexCliExecutableAsyncInput = {},
): Promise<CodexCliExecutableResolution> {
  if ((input.platform ?? process.platform) !== "win32") {
    return { executable: command };
  }

  const { observations, discoveryInput } = observeCodexCommandDiscovery(input);
  const isDefault = command.trim().toLowerCase() === DEFAULT_CODEX_COMMAND;
  const resolved = await resolveWindowsCommandPathAsync(
    isDefault ? DEFAULT_CODEX_COMMAND : command,
    discoveryInput,
  );
  if (!isDefault || Path.win32.isAbsolute(resolved)) {
    return resolution(resolved, observations);
  }

  return defaultCodexResolutionAfterUnresolvedDiscovery(input, observations);
}

export async function resolveCodexCliExecutableAsync(
  command: string,
  input: CodexCliExecutableAsyncInput = {},
): Promise<string> {
  return (await resolveCodexCliExecutableWithDiscoveryAsync(command, input)).executable;
}
