// FILE: codexCliExecutable.ts
// Purpose: Resolves the native Codex CLI executable on Windows before batch shims.
// Layer: Shared Node runtime utility

import { statSync } from "node:fs";
import * as Path from "node:path";

import {
  resolveWindowsCommandCandidates,
  resolveWindowsCommandCandidatesAsync,
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

export interface CodexCliExecutableInput extends WindowsSafeProcessInput {
  readonly statSync?: StatSyncLike | undefined;
}

export interface CodexCliExecutableAsyncInput
  extends CodexCliExecutableInput, WindowsAsyncCommandDiscoveryInput {}

export interface CodexCliExecutableResolution {
  readonly executable: string;
  readonly discoveryOutcome?: WindowsCommandDiscoveryOutcome | undefined;
}

const DEFAULT_CODEX_COMMAND = "codex";
const WINDOWS_NATIVE_EXECUTABLE_PATTERN = /\.(?:exe|com)$/i;
const WINDOWS_BATCH_EXECUTABLE_PATTERN = /\.(?:cmd|bat)$/i;
const WINDOWS_FULLY_QUALIFIED_PATH_PATTERN = /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i;

function readEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (typeof exact === "string") {
    return exact;
  }

  const normalizedName = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === normalizedName && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function nonEmptyEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = readEnvironmentValue(env, name)?.trim();
  return value ? value : undefined;
}

function isAbsoluteRegularFile(candidate: string, readStat: StatSyncLike): boolean {
  if (!Path.win32.isAbsolute(candidate) || !WINDOWS_FULLY_QUALIFIED_PATH_PATTERN.test(candidate)) {
    return false;
  }

  try {
    return readStat(candidate).isFile();
  } catch {
    return false;
  }
}

function firstValidCandidate(
  candidates: ReadonlyArray<string>,
  pattern: RegExp,
  readStat: StatSyncLike,
): string | undefined {
  return candidates.find(
    (candidate) => pattern.test(candidate) && isAbsoluteRegularFile(candidate, readStat),
  );
}

function validCodexExecutableInDirectory(
  directory: string | undefined,
  readStat: StatSyncLike,
): string | undefined {
  if (!directory) {
    return undefined;
  }
  const candidate = Path.win32.join(directory, "codex.exe");
  return isAbsoluteRegularFile(candidate, readStat) ? candidate : undefined;
}

function validNpmCodexShim(
  appData: string | undefined,
  readStat: StatSyncLike,
): string | undefined {
  if (!appData) {
    return undefined;
  }
  const candidate = Path.win32.join(appData, "npm", "codex.cmd");
  return isAbsoluteRegularFile(candidate, readStat) ? candidate : undefined;
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

function resolveDefaultCodexExecutable(
  whereCandidates: ReadonlyArray<string>,
  input: CodexCliExecutableInput,
): string {
  const env = input.env ?? process.env;
  const readStat = input.statSync ?? statSync;
  const localAppData = nonEmptyEnvironmentValue(env, "LOCALAPPDATA");
  const standaloneInstallDirectory = localAppData
    ? Path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin")
    : undefined;

  return (
    firstValidCandidate(whereCandidates, WINDOWS_NATIVE_EXECUTABLE_PATTERN, readStat) ??
    validCodexExecutableInDirectory(nonEmptyEnvironmentValue(env, "CODEX_INSTALL_DIR"), readStat) ??
    validCodexExecutableInDirectory(standaloneInstallDirectory, readStat) ??
    firstValidCandidate(whereCandidates, WINDOWS_BATCH_EXECUTABLE_PATTERN, readStat) ??
    validNpmCodexShim(nonEmptyEnvironmentValue(env, "APPDATA"), readStat) ??
    DEFAULT_CODEX_COMMAND
  );
}

function withUnresolvedDiscoveryOutcome(
  executable: string,
  isUnresolved: boolean,
  observations: ReadonlyArray<WindowsCommandDiscoveryObservation>,
): CodexCliExecutableResolution {
  return {
    executable,
    ...(isUnresolved
      ? { discoveryOutcome: unresolvedWindowsCommandDiscoveryOutcome(observations) }
      : {}),
  };
}

export function resolveCodexCliExecutableWithDiscovery(
  command: string,
  input: CodexCliExecutableInput = {},
): CodexCliExecutableResolution {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return { executable: command };
  }
  const { observations, discoveryInput } = observeCodexCommandDiscovery(input);
  if (command.trim().toLowerCase() !== DEFAULT_CODEX_COMMAND) {
    const executable = resolveWindowsCommandPath(command, discoveryInput);
    return withUnresolvedDiscoveryOutcome(
      executable,
      !Path.win32.isAbsolute(executable),
      observations,
    );
  }

  const whereCandidates = resolveWindowsCommandCandidates(DEFAULT_CODEX_COMMAND, discoveryInput);
  const executable = resolveDefaultCodexExecutable(whereCandidates, input);
  return withUnresolvedDiscoveryOutcome(
    executable,
    executable === DEFAULT_CODEX_COMMAND,
    observations,
  );
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
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return { executable: command };
  }
  const { observations, discoveryInput } = observeCodexCommandDiscovery(input);
  if (command.trim().toLowerCase() !== DEFAULT_CODEX_COMMAND) {
    const executable = await resolveWindowsCommandPathAsync(command, discoveryInput);
    return withUnresolvedDiscoveryOutcome(
      executable,
      !Path.win32.isAbsolute(executable),
      observations,
    );
  }

  const whereCandidates = await resolveWindowsCommandCandidatesAsync(
    DEFAULT_CODEX_COMMAND,
    discoveryInput,
  );
  const executable = resolveDefaultCodexExecutable(whereCandidates, input);
  return withUnresolvedDiscoveryOutcome(
    executable,
    executable === DEFAULT_CODEX_COMMAND,
    observations,
  );
}

export async function resolveCodexCliExecutableAsync(
  command: string,
  input: CodexCliExecutableAsyncInput = {},
): Promise<string> {
  return (await resolveCodexCliExecutableWithDiscoveryAsync(command, input)).executable;
}
