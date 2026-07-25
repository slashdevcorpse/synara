// FILE: codexCliExecutable.ts
// Purpose: Resolves the native Codex CLI executable on Windows before batch shims.
// Layer: Shared Node runtime utility

import { readFileSync, statSync } from "node:fs";
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
type ReadFileSyncLike = (path: string, encoding: "utf8") => string;

export interface CodexCliExecutableInput extends WindowsSafeProcessInput {
  readonly statSync?: StatSyncLike | undefined;
  readonly readFileSync?: ReadFileSyncLike | undefined;
  readonly arch?: NodeJS.Architecture | undefined;
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
const CODEX_NATIVE_EXECUTABLE_NAME = "codex.exe";
const CODEX_BATCH_EXECUTABLE_PATTERN = /^codex\.(?:cmd|bat)$/i;
const CODEX_PACKAGE_MANIFEST_NAME = "codex-package.json";
const CODEX_RESOURCE_DIRECTORY_NAME = "codex-resources";
const CODEX_REQUIRED_WINDOWS_RESOURCES = [
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
] as const;

interface CodexExecutableCandidate {
  readonly executable: string;
  readonly version?: StableCodexVersion | undefined;
}

type StableCodexVersion = readonly [major: string, minor: string, patch: string];

interface WindowsCodexPlatformPackage {
  readonly packageName: string;
  readonly target: string;
}

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

function isCodexNativeExecutable(candidate: string): boolean {
  return Path.win32.basename(candidate).toLowerCase() === CODEX_NATIVE_EXECUTABLE_NAME;
}

function codexPackageRoot(candidate: string): string {
  return Path.win32.dirname(Path.win32.dirname(candidate));
}

function parseStableCodexVersion(version: unknown): StableCodexVersion | undefined {
  if (typeof version !== "string") {
    return undefined;
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return match ? [match[1], match[2], match[3]] : undefined;
}

function readStableCodexVersion(
  candidate: string,
  readFile: ReadFileSyncLike,
): StableCodexVersion | undefined {
  try {
    const manifest: unknown = JSON.parse(
      readFile(Path.win32.join(codexPackageRoot(candidate), CODEX_PACKAGE_MANIFEST_NAME), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
      return undefined;
    }
    return parseStableCodexVersion(manifest.version);
  } catch {
    return undefined;
  }
}

function hasCompleteCodexResourceBundle(candidate: string, readStat: StatSyncLike): boolean {
  const resourceDirectory = Path.win32.join(
    codexPackageRoot(candidate),
    CODEX_RESOURCE_DIRECTORY_NAME,
  );
  return CODEX_REQUIRED_WINDOWS_RESOURCES.every((resourceName) =>
    isAbsoluteRegularFile(Path.win32.join(resourceDirectory, resourceName), readStat),
  );
}

function validNativeCandidate(
  candidate: string,
  readStat: StatSyncLike,
  readFile: ReadFileSyncLike,
): CodexExecutableCandidate | undefined {
  if (
    !WINDOWS_NATIVE_EXECUTABLE_PATTERN.test(candidate) ||
    !isAbsoluteRegularFile(candidate, readStat)
  ) {
    return undefined;
  }
  if (!isCodexNativeExecutable(candidate)) {
    return { executable: candidate };
  }
  if (!hasCompleteCodexResourceBundle(candidate, readStat)) {
    return undefined;
  }
  return {
    executable: candidate,
    version: readStableCodexVersion(candidate, readFile),
  };
}

function validCodexExecutableInDirectory(
  directory: string | undefined,
  readStat: StatSyncLike,
  readFile: ReadFileSyncLike,
): CodexExecutableCandidate | undefined {
  if (!directory) {
    return undefined;
  }
  const candidate = Path.win32.join(directory, "codex.exe");
  return validNativeCandidate(candidate, readStat, readFile);
}

function compareDecimalIntegers(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStableCodexVersions(left: StableCodexVersion, right: StableCodexVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = compareDecimalIntegers(left[index], right[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function selectPreferredCandidate(
  candidates: ReadonlyArray<CodexExecutableCandidate>,
): string | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const versionedCandidates = candidates.flatMap((candidate) =>
    candidate.version ? [{ candidate, version: candidate.version }] : [],
  );
  if (versionedCandidates.length !== candidates.length) {
    return candidates[0]?.executable;
  }
  return versionedCandidates.reduce((selected, candidate) =>
    compareStableCodexVersions(candidate.version, selected.version) > 0 ? candidate : selected,
  ).candidate.executable;
}

function windowsCodexPlatformPackage(
  arch: NodeJS.Architecture,
): WindowsCodexPlatformPackage | undefined {
  if (arch === "x64") {
    return {
      packageName: "codex-win32-x64",
      target: "x86_64-pc-windows-msvc",
    };
  }
  if (arch === "arm64") {
    return {
      packageName: "codex-win32-arm64",
      target: "aarch64-pc-windows-msvc",
    };
  }
  return undefined;
}

function npmVendorExecutablePaths(
  shim: string,
  arch: NodeJS.Architecture,
): ReadonlyArray<string> {
  const platformPackage = windowsCodexPlatformPackage(arch);
  if (!platformPackage) {
    return [];
  }
  const shimDirectory = Path.win32.dirname(shim);
  const codexPackageRoot = Path.win32.join(shimDirectory, "node_modules", "@openai", "codex");
  const vendorSuffix = [
    "vendor",
    platformPackage.target,
    "bin",
    CODEX_NATIVE_EXECUTABLE_NAME,
  ] as const;
  return [
    Path.win32.join(
      codexPackageRoot,
      "node_modules",
      "@openai",
      platformPackage.packageName,
      ...vendorSuffix,
    ),
    Path.win32.join(
      shimDirectory,
      "node_modules",
      "@openai",
      platformPackage.packageName,
      ...vendorSuffix,
    ),
    Path.win32.join(codexPackageRoot, ...vendorSuffix),
  ];
}

function nativeCandidatesBehindNpmShim(
  shim: string,
  arch: NodeJS.Architecture,
  readStat: StatSyncLike,
  readFile: ReadFileSyncLike,
): ReadonlyArray<CodexExecutableCandidate> {
  if (
    !CODEX_BATCH_EXECUTABLE_PATTERN.test(Path.win32.basename(shim)) ||
    !isAbsoluteRegularFile(shim, readStat)
  ) {
    return [];
  }
  return npmVendorExecutablePaths(shim, arch).flatMap((candidate) => {
    const validCandidate = validNativeCandidate(candidate, readStat, readFile);
    return validCandidate ? [validCandidate] : [];
  });
}

function addUniqueCandidates(
  target: CodexExecutableCandidate[],
  seen: Set<string>,
  candidates: ReadonlyArray<CodexExecutableCandidate | undefined>,
): void {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const identity = candidate.executable.toLowerCase();
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    target.push(candidate);
  }
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
  const readFile = input.readFileSync ?? readFileSync;
  const arch = input.arch ?? process.arch;
  const localAppData = nonEmptyEnvironmentValue(env, "LOCALAPPDATA");
  const standaloneInstallDirectory = localAppData
    ? Path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin")
    : undefined;
  const discoveredCandidates: CodexExecutableCandidate[] = [];
  const seen = new Set<string>();

  addUniqueCandidates(
    discoveredCandidates,
    seen,
    whereCandidates.map((candidate) => validNativeCandidate(candidate, readStat, readFile)),
  );
  addUniqueCandidates(discoveredCandidates, seen, [
    validCodexExecutableInDirectory(
      nonEmptyEnvironmentValue(env, "CODEX_INSTALL_DIR"),
      readStat,
      readFile,
    ),
    validCodexExecutableInDirectory(standaloneInstallDirectory, readStat, readFile),
  ]);
  for (const shim of whereCandidates.filter((candidate) =>
    WINDOWS_BATCH_EXECUTABLE_PATTERN.test(candidate),
  )) {
    addUniqueCandidates(
      discoveredCandidates,
      seen,
      nativeCandidatesBehindNpmShim(shim, arch, readStat, readFile),
    );
  }
  const appData = nonEmptyEnvironmentValue(env, "APPDATA");
  if (appData) {
    addUniqueCandidates(
      discoveredCandidates,
      seen,
      nativeCandidatesBehindNpmShim(
        Path.win32.join(appData, "npm", "codex.cmd"),
        arch,
        readStat,
        readFile,
      ),
    );
  }

  return selectPreferredCandidate(discoveredCandidates) ?? DEFAULT_CODEX_COMMAND;
}

function resolveExplicitCodexExecutable(
  executable: string,
  input: CodexCliExecutableInput,
): string | undefined {
  const readStat = input.statSync ?? statSync;
  const readFile = input.readFileSync ?? readFileSync;
  if (isCodexNativeExecutable(executable)) {
    return validNativeCandidate(executable, readStat, readFile)?.executable;
  }
  if (CODEX_BATCH_EXECUTABLE_PATTERN.test(Path.win32.basename(executable))) {
    return selectPreferredCandidate(
      nativeCandidatesBehindNpmShim(
        executable,
        input.arch ?? process.arch,
        readStat,
        readFile,
      ),
    );
  }
  return executable;
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
    const resolvedExplicitExecutable = resolveWindowsCommandPath(command, discoveryInput);
    const executable = resolveExplicitCodexExecutable(resolvedExplicitExecutable, input);
    if (executable !== undefined) {
      return withUnresolvedDiscoveryOutcome(
        executable,
        !Path.win32.isAbsolute(executable),
        observations,
      );
    }
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
    const resolvedExplicitExecutable = await resolveWindowsCommandPathAsync(
      command,
      discoveryInput,
    );
    const executable = resolveExplicitCodexExecutable(resolvedExplicitExecutable, input);
    if (executable !== undefined) {
      return withUnresolvedDiscoveryOutcome(
        executable,
        !Path.win32.isAbsolute(executable),
        observations,
      );
    }
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
