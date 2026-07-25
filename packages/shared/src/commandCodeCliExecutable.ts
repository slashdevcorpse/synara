// FILE: commandCodeCliExecutable.ts
// Purpose: Resolves the Command Code CLI launcher predictably across platforms.
// Layer: Shared Node runtime utility

import { statSync } from "node:fs";
import * as Path from "node:path";

import {
  resolveWindowsCommandCandidates,
  resolveWindowsCommandCandidatesAsync,
  resolveWindowsCommandPath,
  resolveWindowsCommandPathAsync,
  resolveWindowsSystemRoot,
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

export interface CommandCodeCliExecutableInput extends WindowsSafeProcessInput {
  readonly statSync?: StatSyncLike | undefined;
}

export interface CommandCodeCliExecutableAsyncInput
  extends CommandCodeCliExecutableInput, WindowsAsyncCommandDiscoveryInput {}

export interface CommandCodeCliExecutableResolution {
  readonly executable: string;
  readonly discoveryOutcome?: WindowsCommandDiscoveryOutcome | undefined;
}

const DEFAULT_COMMAND_CODE_COMMAND = "commandcode";
const COMMAND_CODE_ALIASES = ["commandcode", "command-code", "cmdc", "cmd"] as const;
const WINDOWS_EXECUTABLE_PATTERN = /\.(?:exe|com|cmd|bat)$/i;

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === normalizedName && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isRegularAbsoluteWindowsFile(candidate: string, readStat: StatSyncLike): boolean {
  if (!Path.win32.isAbsolute(candidate) || !WINDOWS_EXECUTABLE_PATTERN.test(candidate)) {
    return false;
  }
  try {
    return readStat(candidate).isFile();
  } catch {
    return false;
  }
}

function firstValidCandidate(
  command: (typeof COMMAND_CODE_ALIASES)[number],
  candidates: ReadonlyArray<string>,
  readStat: StatSyncLike,
): string | undefined {
  return candidates.find(
    (candidate) =>
      isRegularAbsoluteWindowsFile(candidate, readStat) &&
      // `cmd` is also the Windows command processor. The npm package's launcher is a `.cmd`
      // shim; never reinterpret bare Command Code configuration as `cmd.exe` or `cmd.com`.
      (command !== "cmd" || Path.win32.basename(candidate).toLowerCase() === "cmd.cmd"),
  );
}

function effectiveAliasDiscoveryObservations(
  command: (typeof COMMAND_CODE_ALIASES)[number],
  candidates: ReadonlyArray<string>,
  observations: ReadonlyArray<WindowsCommandDiscoveryObservation>,
  commandProcessorPaths: ReadonlySet<string>,
): WindowsCommandDiscoveryObservation[] {
  const resolvedOnlyToWindowsCommandProcessor =
    command === "cmd" &&
    candidates.length > 0 &&
    candidates.every((candidate) =>
      commandProcessorPaths.has(Path.win32.normalize(candidate).toLowerCase()),
    ) &&
    observations.length > 0 &&
    observations.every((observation) => observation.outcome === "resolved");
  if (!resolvedOnlyToWindowsCommandProcessor) {
    return [...observations];
  }

  // `cmd` is an official package alias, but Windows normally resolves it to
  // the command processor. That collision means no usable Command Code alias
  // was found; it is not a discovery transport failure.
  return observations.map((observation) => ({ ...observation, outcome: "not_found" }));
}

function windowsCommandProcessorPaths(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const systemRoot =
    environmentValue(env, "SystemRoot") ??
    environmentValue(env, "WINDIR") ??
    resolveWindowsSystemRoot(env);
  return new Set(
    ["cmd.exe", "cmd.com"].map((name) =>
      Path.win32.normalize(Path.win32.join(systemRoot, "System32", name)).toLowerCase(),
    ),
  );
}

function npmShim(
  appData: string | undefined,
  command: (typeof COMMAND_CODE_ALIASES)[number],
  readStat: StatSyncLike,
): string | undefined {
  if (!appData) return undefined;
  const candidate = Path.win32.join(appData, "npm", `${command}.cmd`);
  return isRegularAbsoluteWindowsFile(candidate, readStat) ? candidate : undefined;
}

function unresolvedOfficialAliasExecutable(configured: string, normalized: string): string {
  return normalized === "cmd"
    ? DEFAULT_COMMAND_CODE_COMMAND
    : configured || DEFAULT_COMMAND_CODE_COMMAND;
}

/**
 * Resolve the configured Command Code command. On Windows, all official npm
 * aliases are considered and `.cmd` shims are returned explicitly so callers
 * can use the shared shell-free batch wrapper.
 */
export function resolveCommandCodeCliExecutable(
  command: string = DEFAULT_COMMAND_CODE_COMMAND,
  input: CommandCodeCliExecutableInput = {},
): string {
  return resolveCommandCodeCliExecutableWithDiscovery(command, input).executable;
}

export function resolveCommandCodeCliExecutableWithDiscovery(
  command: string = DEFAULT_COMMAND_CODE_COMMAND,
  input: CommandCodeCliExecutableInput = {},
): CommandCodeCliExecutableResolution {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return { executable: command };

  const observations: WindowsCommandDiscoveryObservation[] = [];
  const discoveryInput: CommandCodeCliExecutableInput = {
    ...input,
    onCommandDiscovery: (observation) => {
      observations.push(observation);
      input.onCommandDiscovery?.(observation);
    },
  };

  const configured = command.trim();
  const normalized = configured.toLowerCase();
  if (!COMMAND_CODE_ALIASES.includes(normalized as (typeof COMMAND_CODE_ALIASES)[number])) {
    const executable = resolveWindowsCommandPath(command, discoveryInput);
    return {
      executable,
      ...(Path.win32.isAbsolute(executable)
        ? {}
        : { discoveryOutcome: unresolvedWindowsCommandDiscoveryOutcome(observations) }),
    };
  }

  const readStat = input.statSync ?? statSync;
  const env = input.env ?? process.env;
  const appData = environmentValue(env, "APPDATA");
  const commandProcessorPaths = windowsCommandProcessorPaths(env);
  const orderedAliases = [
    normalized as (typeof COMMAND_CODE_ALIASES)[number],
    ...COMMAND_CODE_ALIASES.filter((alias) => alias !== normalized),
  ];
  const effectiveObservations: WindowsCommandDiscoveryObservation[] = [];

  for (const alias of orderedAliases) {
    const observationStart = observations.length;
    const candidates = resolveWindowsCommandCandidates(alias, discoveryInput);
    const candidate = firstValidCandidate(alias, candidates, readStat);
    if (candidate) {
      return { executable: candidate };
    }
    effectiveObservations.push(
      ...effectiveAliasDiscoveryObservations(
        alias,
        candidates,
        observations.slice(observationStart),
        commandProcessorPaths,
      ),
    );
  }
  const executable = unresolvedOfficialAliasExecutable(configured, normalized);
  const discoveryOutcome = unresolvedWindowsCommandDiscoveryOutcome(effectiveObservations);
  if (discoveryOutcome !== "not_found") {
    return {
      executable,
      ...(discoveryOutcome ? { discoveryOutcome } : {}),
    };
  }
  for (const alias of orderedAliases) {
    const candidate = npmShim(appData, alias, readStat);
    if (candidate) return { executable: candidate };
  }
  return {
    executable,
    discoveryOutcome,
  };
}

export async function resolveCommandCodeCliExecutableWithDiscoveryAsync(
  command: string = DEFAULT_COMMAND_CODE_COMMAND,
  input: CommandCodeCliExecutableAsyncInput = {},
): Promise<CommandCodeCliExecutableResolution> {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return { executable: command };

  const observations: WindowsCommandDiscoveryObservation[] = [];
  const discoveryInput: CommandCodeCliExecutableAsyncInput = {
    ...input,
    onCommandDiscovery: (observation) => {
      observations.push(observation);
      input.onCommandDiscovery?.(observation);
    },
  };

  const configured = command.trim();
  const normalized = configured.toLowerCase();
  if (!COMMAND_CODE_ALIASES.includes(normalized as (typeof COMMAND_CODE_ALIASES)[number])) {
    const executable = await resolveWindowsCommandPathAsync(command, discoveryInput);
    return {
      executable,
      ...(Path.win32.isAbsolute(executable)
        ? {}
        : { discoveryOutcome: unresolvedWindowsCommandDiscoveryOutcome(observations) }),
    };
  }

  const readStat = input.statSync ?? statSync;
  const env = input.env ?? process.env;
  const appData = environmentValue(env, "APPDATA");
  const commandProcessorPaths = windowsCommandProcessorPaths(env);
  const orderedAliases = [
    normalized as (typeof COMMAND_CODE_ALIASES)[number],
    ...COMMAND_CODE_ALIASES.filter((alias) => alias !== normalized),
  ];
  const effectiveObservations: WindowsCommandDiscoveryObservation[] = [];

  for (const alias of orderedAliases) {
    const observationStart = observations.length;
    const candidates = await resolveWindowsCommandCandidatesAsync(alias, discoveryInput);
    const candidate = firstValidCandidate(alias, candidates, readStat);
    if (candidate) {
      return { executable: candidate };
    }
    effectiveObservations.push(
      ...effectiveAliasDiscoveryObservations(
        alias,
        candidates,
        observations.slice(observationStart),
        commandProcessorPaths,
      ),
    );
  }
  const executable = unresolvedOfficialAliasExecutable(configured, normalized);
  const discoveryOutcome = unresolvedWindowsCommandDiscoveryOutcome(effectiveObservations);
  if (discoveryOutcome !== "not_found") {
    return {
      executable,
      ...(discoveryOutcome ? { discoveryOutcome } : {}),
    };
  }
  for (const alias of orderedAliases) {
    const candidate = npmShim(appData, alias, readStat);
    if (candidate) return { executable: candidate };
  }
  return {
    executable,
    discoveryOutcome,
  };
}

export async function resolveCommandCodeCliExecutableAsync(
  command: string = DEFAULT_COMMAND_CODE_COMMAND,
  input: CommandCodeCliExecutableAsyncInput = {},
): Promise<string> {
  return (await resolveCommandCodeCliExecutableWithDiscoveryAsync(command, input)).executable;
}
