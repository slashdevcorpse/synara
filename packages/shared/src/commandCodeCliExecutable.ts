// FILE: commandCodeCliExecutable.ts
// Purpose: Resolves the Command Code CLI launcher predictably across platforms.
// Layer: Shared Node runtime utility

import { statSync } from "node:fs";
import * as Path from "node:path";

import {
  resolveWindowsCommandCandidates,
  resolveWindowsCommandPath,
  type WindowsSafeProcessInput,
} from "./windowsProcess";

interface FileStatLike {
  isFile(): boolean;
}

type StatSyncLike = (path: string) => FileStatLike;

export interface CommandCodeCliExecutableInput extends WindowsSafeProcessInput {
  readonly statSync?: StatSyncLike | undefined;
}

const DEFAULT_COMMAND_CODE_COMMAND = "commandcode";
const COMMAND_CODE_ALIASES = ["commandcode", "command-code", "cmdc"] as const;
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
  candidates: ReadonlyArray<string>,
  readStat: StatSyncLike,
): string | undefined {
  return candidates.find((candidate) => isRegularAbsoluteWindowsFile(candidate, readStat));
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
 * Resolve the configured Command Code command. On Windows, both official npm
 * aliases are considered and `.cmd` shims are returned explicitly so callers
 * can use the shared shell-free batch wrapper.
 */
export function resolveCommandCodeCliExecutable(
  command: string = DEFAULT_COMMAND_CODE_COMMAND,
  input: CommandCodeCliExecutableInput = {},
): string {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return command;

  const configured = command.trim();
  const normalized = configured.toLowerCase();
  if (!COMMAND_CODE_ALIASES.includes(normalized as (typeof COMMAND_CODE_ALIASES)[number])) {
    return resolveWindowsCommandPath(command, input);
  }

  const readStat = input.statSync ?? statSync;
  const env = input.env ?? process.env;
  const appData = environmentValue(env, "APPDATA");
  const orderedAliases = [
    normalized as (typeof COMMAND_CODE_ALIASES)[number],
    ...COMMAND_CODE_ALIASES.filter((alias) => alias !== normalized),
  ];

  for (const alias of orderedAliases) {
    const candidate = firstValidCandidate(resolveWindowsCommandCandidates(alias, input), readStat);
    if (candidate) return candidate;
  }
  for (const alias of orderedAliases) {
    const candidate = npmShim(appData, alias, readStat);
    if (candidate) return candidate;
  }
  return configured || DEFAULT_COMMAND_CODE_COMMAND;
}
