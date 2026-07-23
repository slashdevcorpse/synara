// FILE: commandCodeCliExecutable.ts
// Purpose: Resolves the Command Code CLI launcher predictably across platforms.
// Layer: Shared Node runtime utility

import { statSync } from "node:fs";
import * as Path from "node:path";

import {
  resolveWindowsCommandCandidates,
  resolveWindowsCommandPath,
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

function npmShim(
  appData: string | undefined,
  command: (typeof COMMAND_CODE_ALIASES)[number],
  readStat: StatSyncLike,
): string | undefined {
  if (!appData) return undefined;
  const candidate = Path.win32.join(appData, "npm", `${command}.cmd`);
  return isRegularAbsoluteWindowsFile(candidate, readStat) ? candidate : undefined;
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

function unresolvedDiscoveryOutcome(
  observations: ReadonlyArray<WindowsCommandDiscoveryObservation>,
): WindowsCommandDiscoveryOutcome | undefined {
  if (observations.length === 0) return undefined;
  return observations.every((observation) => observation.outcome === "not_found")
    ? "not_found"
    : "transient_failure";
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
        : { discoveryOutcome: unresolvedDiscoveryOutcome(observations) }),
    };
  }

  const readStat = input.statSync ?? statSync;
  const env = input.env ?? process.env;
  const appData = environmentValue(env, "APPDATA");
  const orderedAliases = [
    normalized as (typeof COMMAND_CODE_ALIASES)[number],
    ...COMMAND_CODE_ALIASES.filter((alias) => alias !== normalized),
  ];

  for (const alias of orderedAliases) {
    const candidate = firstValidCandidate(
      alias,
      resolveWindowsCommandCandidates(alias, discoveryInput),
      readStat,
    );
    if (candidate) return { executable: candidate };
  }
  for (const alias of orderedAliases) {
    const candidate = npmShim(appData, alias, readStat);
    if (candidate) return { executable: candidate };
  }
  return {
    executable:
      normalized === "cmd"
        ? DEFAULT_COMMAND_CODE_COMMAND
        : configured || DEFAULT_COMMAND_CODE_COMMAND,
    discoveryOutcome: unresolvedDiscoveryOutcome(observations),
  };
}
