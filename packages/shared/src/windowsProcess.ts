// FILE: windowsProcess.ts
// Purpose: Prepares Windows child-process launches without Node's `shell: true`.
// Layer: Shared Node runtime utility
// Exports: command resolution plus safe spawn/spawnSync argument preparation.

import { spawnSync } from "node:child_process";
import * as Path from "node:path";

type SpawnSyncLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    encoding: "utf8";
    shell: false;
    stdio: ["ignore", "pipe", "ignore"];
    maxBuffer: number;
    timeout: number;
    windowsHide: true;
  },
) => { stdout?: string | null; status?: number | null; error?: Error | undefined };

export type WindowsCommandDiscoveryOutcome = "resolved" | "not_found" | "transient_failure";

export interface WindowsCommandDiscoveryObservation {
  readonly outcome: WindowsCommandDiscoveryOutcome;
  readonly source: "bypass" | "cache" | "where";
}

export interface WindowsCommandDiscoveryCache {
  readonly kind: "windows-command-discovery-cache";
}

export interface WindowsCommandDiscoveryCacheOptions {
  readonly now?: (() => number) | undefined;
}

export interface WindowsSafeProcessInput {
  readonly platform?: NodeJS.Platform | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly spawnSync?: SpawnSyncLike | undefined;
  readonly commandDiscoveryCache?: WindowsCommandDiscoveryCache | undefined;
  readonly onCommandDiscovery?:
    | ((observation: WindowsCommandDiscoveryObservation) => void)
    | undefined;
}

export interface WindowsSafeProcessCommand {
  readonly command: string;
  readonly args: string[];
  readonly shell: false;
  readonly windowsHide?: true;
  readonly windowsVerbatimArguments?: true;
}

const WINDOWS_BATCH_EXTENSION_PATTERN = /\.(?:cmd|bat)$/i;
const WINDOWS_SPAWN_SAFE_EXTENSION_PATTERN = /\.(?:exe|com|cmd|bat)$/i;
const WINDOWS_PATH_SEPARATOR_PATTERN = /[\\/]/;
const WINDOWS_BATCH_UNSAFE_TOKEN_PATTERN = /[\r\n&|<>^%]/;
const WHERE_TIMEOUT_MS = 2_000;
const WHERE_STDOUT_MAX_BYTES = 256 * 1024;
const WINDOWS_COMMAND_DISCOVERY_POSITIVE_TTL_MS = 30_000;
const WINDOWS_COMMAND_DISCOVERY_NEGATIVE_TTL_MS = 2_000;
const WINDOWS_COMMAND_DISCOVERY_CACHE_MAX_ENTRIES = 256;

export const WINDOWS_COMMAND_DISCOVERY_ALGORITHM_VERSION = 1;

type CacheableWindowsCommandDiscovery =
  | { readonly outcome: "resolved"; readonly candidates: readonly string[] }
  | { readonly outcome: "not_found"; readonly candidates: readonly [] };

interface WindowsCommandDiscoveryCacheEntry {
  readonly discovery: CacheableWindowsCommandDiscovery;
  readonly expiresAt: number;
}

interface WindowsCommandDiscoveryCacheState {
  readonly entries: Map<string, WindowsCommandDiscoveryCacheEntry>;
  readonly now: () => number;
}

const windowsCommandDiscoveryCacheStates = new WeakMap<
  WindowsCommandDiscoveryCache,
  WindowsCommandDiscoveryCacheState
>();

export function createWindowsCommandDiscoveryCache(
  options: WindowsCommandDiscoveryCacheOptions = {},
): WindowsCommandDiscoveryCache {
  const cache = Object.freeze({
    kind: "windows-command-discovery-cache" as const,
  });
  windowsCommandDiscoveryCacheStates.set(cache, {
    entries: new Map(),
    now: options.now ?? Date.now,
  });
  return cache;
}

const processWindowsCommandDiscoveryCache = createWindowsCommandDiscoveryCache();

function getWindowsCommandDiscoveryCacheState(
  cache: WindowsCommandDiscoveryCache,
): WindowsCommandDiscoveryCacheState {
  const state = windowsCommandDiscoveryCacheStates.get(cache);
  if (!state) {
    throw new Error("Windows command discovery cache must be created by this module.");
  }
  return state;
}

export function getWindowsCommandDiscoveryCacheStats(
  cache: WindowsCommandDiscoveryCache = processWindowsCommandDiscoveryCache,
): { readonly size: number } {
  return { size: getWindowsCommandDiscoveryCacheState(cache).entries.size };
}

export function clearWindowsCommandDiscoveryCache(): void {
  getWindowsCommandDiscoveryCacheState(processWindowsCommandDiscoveryCache).entries.clear();
}

function compareWindowsEnvironmentNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeWindowsChildEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = {};
  const selectedNames = new Set<string>();
  const names = Object.keys(env).toSorted(compareWindowsEnvironmentNames);
  for (const name of names) {
    const value = env[name];
    if (value === undefined) continue;
    const normalizedName = name.toUpperCase();
    if (selectedNames.has(normalizedName)) continue;
    selectedNames.add(normalizedName);
    normalized[name] = value;
  }
  return normalized;
}

export function readEffectiveWindowsEnvironmentValue(
  env: NodeJS.ProcessEnv,
  requestedName: string,
): string | undefined {
  const normalizedName = requestedName.toUpperCase();
  const effectiveName = Object.keys(env)
    .filter((name) => env[name] !== undefined && name.toUpperCase() === normalizedName)
    // Node applies this ordinal lexicographic ordering before de-duplicating
    // Windows environment keys case-insensitively. Do not use localeCompare:
    // locale-sensitive ordering could diverge from the spawned environment.
    .sort(compareWindowsEnvironmentNames)[0];
  return effectiveName === undefined ? undefined : env[effectiveName];
}

function trimNonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveWindowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return trimNonEmpty(readEffectiveWindowsEnvironmentValue(env, "SystemRoot")) ?? "C:\\Windows";
}

export function resolveWindowsComSpec(env: NodeJS.ProcessEnv = process.env): string {
  return (
    trimNonEmpty(readEffectiveWindowsEnvironmentValue(env, "ComSpec")) ??
    Path.win32.join(resolveWindowsSystemRoot(env), "System32", "cmd.exe")
  );
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function resolveAbsoluteWindowsPath(value: string, cwd: string): string {
  return Path.win32.resolve(cwd, stripWrappingQuotes(value).replaceAll("/", "\\"));
}

function foldWindowsAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20),
  );
}

function normalizeWindowsPathIdentity(value: string, cwd: string): string {
  const normalized = resolveAbsoluteWindowsPath(value, cwd);
  const root = Path.win32.parse(normalized).root;
  const withoutTrailingSeparators =
    normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
  return foldWindowsAsciiCase(withoutTrailingSeparators);
}

function normalizeWindowsCwdCacheIdentity(cwd: string): string {
  if (cwd.trim() !== cwd || cwd.startsWith('"') || cwd.endsWith('"')) {
    return foldWindowsAsciiCase(cwd);
  }
  const root = Path.win32.parse(cwd).root;
  const withoutTrailingSeparators = cwd.replace(/[\\/]+$/, "");
  const normalized =
    root.length > 0 && withoutTrailingSeparators.length < root.length
      ? root
      : (withoutTrailingSeparators ?? cwd);
  return foldWindowsAsciiCase(normalized);
}

function resolveWindowsWhereExe(env: NodeJS.ProcessEnv, cwd: string): string {
  return Path.win32.join(
    resolveAbsoluteWindowsPath(resolveWindowsSystemRoot(env), cwd),
    "System32",
    "where.exe",
  );
}

export function isWindowsBatchCommand(command: string): boolean {
  return WINDOWS_BATCH_EXTENSION_PATTERN.test(command);
}

function quoteWindowsBatchToken(token: string, label: string): string {
  if (WINDOWS_BATCH_UNSAFE_TOKEN_PATTERN.test(token)) {
    throw new Error(
      `Cannot safely execute Windows batch ${label} containing cmd.exe control characters.`,
    );
  }
  return `"${token.replaceAll('"', '""')}"`;
}

export function buildWindowsBatchCommandArgs(
  command: string,
  args: ReadonlyArray<string>,
): string[] {
  // Keep cmd.exe's semantic command line together so quote-bearing arguments
  // are encoded for cmd instead of independently escaped as C-runtime argv.
  // The call prefix also keeps /s from stripping the executable's outer quotes.
  const commandLine = [
    "call",
    quoteWindowsBatchToken(command, "command"),
    ...args.map((arg) => quoteWindowsBatchToken(arg, "argument")),
  ].join(" ");
  return ["/d", "/s", "/v:off", "/c", commandLine];
}

function isPathLikeCommand(command: string): boolean {
  return WINDOWS_PATH_SEPARATOR_PATTERN.test(command) || Path.win32.isAbsolute(command);
}

function hasWindowsExecutableExtension(command: string): boolean {
  return Path.win32.extname(command).length > 0;
}

function isFromCurrentDirectory(candidate: string, cwd: string | undefined): boolean {
  if (!cwd) {
    return false;
  }
  const candidateDir = Path.win32.resolve(Path.win32.dirname(candidate)).toLowerCase();
  const currentDir = Path.win32.resolve(cwd).toLowerCase();
  return candidateDir === currentDir;
}

function isWindowsSpawnSafeResolvedCommand(command: string): boolean {
  return WINDOWS_SPAWN_SAFE_EXTENSION_PATTERN.test(command);
}

function selectWindowsCommandCandidate(candidates: ReadonlyArray<string>): string | undefined {
  return candidates.find(isWindowsSpawnSafeResolvedCommand) ?? candidates[0];
}

type WindowsCommandResolutionMode = "bare" | "relative_path_like" | "absolute_path_like";

type WindowsCommandDiscovery =
  | CacheableWindowsCommandDiscovery
  | { readonly outcome: "transient_failure"; readonly candidates: readonly [] };

function getWindowsCommandResolutionMode(command: string): WindowsCommandResolutionMode {
  if (Path.win32.isAbsolute(command)) {
    return "absolute_path_like";
  }
  return isPathLikeCommand(command) ? "relative_path_like" : "bare";
}

function normalizeWindowsCommandIdentity(
  command: string,
  mode: WindowsCommandResolutionMode,
): string {
  const windowsCommand = command.replaceAll("/", "\\");
  return foldWindowsAsciiCase(
    mode === "bare" ? windowsCommand : Path.win32.normalize(windowsCommand),
  );
}

function resolveWindowsPathCacheIdentity(
  env: NodeJS.ProcessEnv,
): { readonly kind: "missing" } | { readonly kind: "configured"; readonly value: string } {
  const pathValue = readEffectiveWindowsEnvironmentValue(env, "PATH");
  return pathValue === undefined
    ? { kind: "missing" }
    : {
        kind: "configured",
        // where.exe receives Node's selected PATH value verbatim. Quotes,
        // whitespace, delimiters, empty entries, order, and duplicates can all
        // affect its result, so only fold ASCII case for the cache identity.
        value: foldWindowsAsciiCase(pathValue),
      };
}

function resolveWindowsPathExtCacheIdentity(
  env: NodeJS.ProcessEnv,
): { readonly kind: "missing" } | { readonly kind: "configured"; readonly value: string } {
  const pathExtValue = readEffectiveWindowsEnvironmentValue(env, "PATHEXT");
  return pathExtValue === undefined
    ? { kind: "missing" }
    : {
        kind: "configured",
        // where.exe treats extension case equivalently, but dots, quotes,
        // whitespace, delimiters, empty entries, order, and duplicates can all
        // affect its candidate list. Preserve that structure apart from case.
        value: foldWindowsAsciiCase(pathExtValue),
      };
}

function buildWindowsCommandDiscoveryCacheKey(
  command: string,
  input: WindowsSafeProcessInput,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  const platform = input.platform ?? process.platform;
  const mode = getWindowsCommandResolutionMode(command);
  const resolvedWhereExe = resolveWindowsWhereExe(env, cwd);
  const resolvedSystemRoot = Path.win32.dirname(Path.win32.dirname(resolvedWhereExe));
  return JSON.stringify({
    algorithmVersion: WINDOWS_COMMAND_DISCOVERY_ALGORITHM_VERSION,
    platform,
    command: normalizeWindowsCommandIdentity(command, mode),
    mode,
    // Preserve the exact working-directory syntax passed to spawnSync. Quoted
    // or whitespace-wrapped values are not equivalent to a valid directory.
    cwd: normalizeWindowsCwdCacheIdentity(cwd),
    path: resolveWindowsPathCacheIdentity(env),
    pathExt: resolveWindowsPathExtCacheIdentity(env),
    // Sign the paths that actually select the launched where.exe, rather than
    // the raw SystemRoot spelling that resolveWindowsWhereExe canonicalizes.
    systemRoot: normalizeWindowsPathIdentity(resolvedSystemRoot, cwd),
    whereExe: normalizeWindowsPathIdentity(resolvedWhereExe, cwd),
  });
}

function cloneCacheableWindowsCommandDiscovery(
  discovery: CacheableWindowsCommandDiscovery,
): CacheableWindowsCommandDiscovery {
  return discovery.outcome === "resolved"
    ? { outcome: "resolved", candidates: [...discovery.candidates] }
    : { outcome: "not_found", candidates: [] };
}

function readWindowsCommandDiscoveryCache(
  cache: WindowsCommandDiscoveryCache,
  key: string,
): CacheableWindowsCommandDiscovery | undefined {
  const state = getWindowsCommandDiscoveryCacheState(cache);
  const entry = state.entries.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= state.now()) {
    state.entries.delete(key);
    return undefined;
  }

  // Map insertion order is the LRU order. Refresh it on every successful read.
  state.entries.delete(key);
  state.entries.set(key, entry);
  return cloneCacheableWindowsCommandDiscovery(entry.discovery);
}

function writeWindowsCommandDiscoveryCache(
  cache: WindowsCommandDiscoveryCache,
  key: string,
  discovery: CacheableWindowsCommandDiscovery,
): void {
  const state = getWindowsCommandDiscoveryCacheState(cache);
  const ttl =
    discovery.outcome === "resolved"
      ? WINDOWS_COMMAND_DISCOVERY_POSITIVE_TTL_MS
      : WINDOWS_COMMAND_DISCOVERY_NEGATIVE_TTL_MS;
  state.entries.delete(key);
  state.entries.set(key, {
    discovery: cloneCacheableWindowsCommandDiscovery(discovery),
    expiresAt: state.now() + ttl,
  });
  while (state.entries.size > WINDOWS_COMMAND_DISCOVERY_CACHE_MAX_ENTRIES) {
    const leastRecentlyUsedKey = state.entries.keys().next().value;
    if (leastRecentlyUsedKey === undefined) {
      break;
    }
    state.entries.delete(leastRecentlyUsedKey);
  }
}

function isMalformedWindowsWhereCandidate(candidate: string): boolean {
  return !Path.win32.isAbsolute(candidate) || /[\u0000-\u001f]/.test(candidate);
}

function classifyWindowsWhereResult(result: ReturnType<SpawnSyncLike>): WindowsCommandDiscovery {
  if (result.error || typeof result.stdout !== "string") {
    return { outcome: "transient_failure", candidates: [] };
  }
  if (Buffer.byteLength(result.stdout, "utf8") > WHERE_STDOUT_MAX_BYTES) {
    return { outcome: "transient_failure", candidates: [] };
  }
  if (result.status === 1 && result.stdout.trim().length === 0) {
    return { outcome: "not_found", candidates: [] };
  }
  if (result.status !== 0) {
    return { outcome: "transient_failure", candidates: [] };
  }

  const candidates = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length === 0 || candidates.some(isMalformedWindowsWhereCandidate)) {
    return { outcome: "transient_failure", candidates: [] };
  }
  return { outcome: "resolved", candidates };
}

function observeWindowsCommandDiscovery(
  input: WindowsSafeProcessInput,
  discovery: WindowsCommandDiscovery,
  source: WindowsCommandDiscoveryObservation["source"],
): void {
  input.onCommandDiscovery?.({ outcome: discovery.outcome, source });
}

function selectWindowsCommandDiscoveryCache(
  input: WindowsSafeProcessInput,
): WindowsCommandDiscoveryCache | undefined {
  if (input.commandDiscoveryCache) {
    return input.commandDiscoveryCache;
  }
  // Injected process launchers are generally test- or caller-specific. They do
  // not share process cache state unless the caller explicitly supplies an
  // isolated cache created by this module.
  return input.spawnSync ? undefined : processWindowsCommandDiscoveryCache;
}

function discoverWindowsCommandCandidates(
  command: string,
  input: WindowsSafeProcessInput,
  env: NodeJS.ProcessEnv,
  cwd: string,
): WindowsCommandDiscovery {
  const cache = selectWindowsCommandDiscoveryCache(input);
  const cacheKey = cache
    ? buildWindowsCommandDiscoveryCacheKey(command, input, env, cwd)
    : undefined;
  if (cache && cacheKey) {
    const cached = readWindowsCommandDiscoveryCache(cache, cacheKey);
    if (cached) {
      observeWindowsCommandDiscovery(input, cached, "cache");
      return cached;
    }
  }

  // spawnSync blocks the JavaScript isolate, so identical synchronous callers
  // are naturally serialized: the first result is stored before the next call
  // can enter discovery. The public API remains synchronous.
  const launchWhere: SpawnSyncLike =
    input.spawnSync ??
    ((whereCommand, whereArgs, options) => spawnSync(whereCommand, [...whereArgs], options));
  const result = launchWhere(resolveWindowsWhereExe(env, cwd), [command], {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: WHERE_STDOUT_MAX_BYTES,
    timeout: WHERE_TIMEOUT_MS,
    windowsHide: true,
  });
  const discovery = classifyWindowsWhereResult(result);
  observeWindowsCommandDiscovery(input, discovery, "where");
  if (cache && cacheKey && discovery.outcome !== "transient_failure") {
    writeWindowsCommandDiscoveryCache(cache, cacheKey, discovery);
  }
  return discovery;
}

// Return every where.exe result in PATH order after applying the same
// current-directory protection used by resolveWindowsCommandPath. Consumers
// with command-specific precedence rules can inspect the full list without
// changing the generic launcher selection behavior.
export function resolveWindowsCommandCandidates(
  command: string,
  input: WindowsSafeProcessInput = {},
): string[] {
  const pathLikeCommand = isPathLikeCommand(command);
  if (pathLikeCommand && hasWindowsExecutableExtension(command)) {
    observeWindowsCommandDiscovery(input, { outcome: "resolved", candidates: [command] }, "bypass");
    return [command];
  }

  const env = normalizeWindowsChildEnvironment(input.env ?? process.env);
  const cwd = input.cwd ?? process.cwd();
  const discovery = discoverWindowsCommandCandidates(command, input, env, cwd);
  const candidates = [...discovery.candidates];
  return pathLikeCommand
    ? candidates
    : candidates.filter((candidate) => !isFromCurrentDirectory(candidate, cwd));
}

// Resolve PATH/PATHEXT commands through where.exe so `.cmd` shims can be wrapped
// explicitly. Prefer candidates that native spawn can execute or that we can
// wrap, and skip current-directory hits for PATH commands to avoid restoring
// shell-style CWD command hijacking.
export function resolveWindowsCommandPath(
  command: string,
  input: WindowsSafeProcessInput = {},
): string {
  const pathLikeCommand = isPathLikeCommand(command);
  if (pathLikeCommand && hasWindowsExecutableExtension(command)) {
    return command;
  }
  return selectWindowsCommandCandidate(resolveWindowsCommandCandidates(command, input)) ?? command;
}

export function prepareWindowsSafeProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsSafeProcessInput = {},
): WindowsSafeProcessCommand {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], shell: false };
  }

  return prepareResolvedWindowsSafeProcess(resolveWindowsCommandPath(command, input), args, input);
}

// Prepare a command whose PATH/PATHEXT resolution has already been finalized.
// This keeps batch wrapping separate from command discovery so callers can
// prove that validation and launch use the same executable.
export function prepareResolvedWindowsSafeProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsSafeProcessInput = {},
): WindowsSafeProcessCommand {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], shell: false };
  }

  const env = normalizeWindowsChildEnvironment(input.env ?? process.env);
  if (!isWindowsBatchCommand(command)) {
    return {
      command,
      args: [...args],
      shell: false,
      windowsHide: true,
    };
  }

  return {
    command: resolveWindowsComSpec(env),
    args: buildWindowsBatchCommandArgs(command, args),
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
  };
}
