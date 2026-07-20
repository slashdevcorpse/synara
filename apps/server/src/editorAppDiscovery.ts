// FILE: editorAppDiscovery.ts
// Purpose: Shared helpers for resolving installed editor apps/packages without
//          duplicating platform-specific search rules across launch and icons.
// Layer: Server runtime utility
// Exports: app/package search helpers used by open.ts and editorAppIcons.ts
// Depends on: EDITORS metadata plus filesystem stat checks.

import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import pathWin32 from "node:path/win32";
import type { Readable } from "node:stream";

import { EDITORS } from "@synara/contracts";
import {
  normalizeWindowsChildEnvironment,
  readEffectiveWindowsEnvironmentValue,
  resolveWindowsSystemRoot,
} from "@synara/shared/windowsProcess";

export type EditorDefinition = (typeof EDITORS)[number];

export interface WindowsStorePackageDefinition {
  readonly packageName: string;
  readonly publisherId: string;
}

type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: true;
  },
) => string | Buffer;

interface WindowsStorePowerShellLookupOptions {
  readonly useCache?: boolean;
  readonly now?: () => number;
}

interface CachedPowerShellAppxLookup {
  readonly value: string | null;
  readonly expiresAt: number;
}

const POWERSHELL_APPX_LOOKUP_TIMEOUT_MS = 1_500;
const POWERSHELL_APPX_LOOKUP_CACHE_TTL_MS = 300_000;
const POWERSHELL_APPX_PACKAGE_QUERY =
  "Get-AppxPackage -Name $packageDef.Name -ErrorAction Stop | " +
  "Where-Object { $_.PackageFamilyName -ieq $packageDef.Family } | Select-Object -First 1";
const powershellAppxLookupCache = new Map<string, CachedPowerShellAppxLookup>();

export const WINDOWS_STORE_BULK_LOOKUP_TIMEOUT_MS = 2_000;
export const WINDOWS_STORE_BULK_LOOKUP_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const WINDOWS_STORE_BULK_LOOKUP_TERMINATION_GRACE_MS = 100;

export type WindowsStoreBulkLookupFailureCategory =
  | "cancelled"
  | "malformed_output"
  | "output_limit"
  | "process_error"
  | "process_exit"
  | "timeout";

export type WindowsStoreBulkLookupResult =
  | {
      readonly status: "success";
      readonly installLocationsByFamily: Readonly<Record<string, string>>;
      readonly subprocessCount: 0 | 1;
    }
  | {
      readonly status: "failure";
      readonly category: WindowsStoreBulkLookupFailureCategory;
      readonly subprocessCount: 0 | 1;
    };

type SpawnWindowsStorePowerShell = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
    windowsHide: true;
  },
) => ChildProcessByStdio<null, Readable, Readable>;

export interface WindowsStoreBulkLookupOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly spawnProcess?: SpawnWindowsStorePowerShell;
}

export function getEditorMacApplications(editor: EditorDefinition): readonly string[] | undefined {
  return "macApplications" in editor ? editor.macApplications : undefined;
}

export function getEditorWindowsUriScheme(editor: EditorDefinition): string | undefined {
  return "windowsUriScheme" in editor ? editor.windowsUriScheme : undefined;
}

export function getEditorWindowsStorePackages(
  editor: EditorDefinition,
): readonly WindowsStorePackageDefinition[] | undefined {
  return "windowsStorePackages" in editor ? editor.windowsStorePackages : undefined;
}

export function normalizeMacApplicationBundleName(appName: string): string {
  return appName.endsWith(".app") ? appName : `${appName}.app`;
}

// Checks the standard user/system app locations, including JetBrains Toolbox installs.
export function resolveMacApplicationSearchPaths(
  appName: string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const bundleName = normalizeMacApplicationBundleName(appName);
  const home = env.HOME?.trim();
  const homeCandidates = home
    ? [
        join(home, "Applications", bundleName),
        join(home, "Applications", "JetBrains Toolbox", bundleName),
      ]
    : [];

  return [
    ...homeCandidates,
    join("/Applications", bundleName),
    join("/Applications", "Utilities", bundleName),
    join("/Applications", "JetBrains Toolbox", bundleName),
    join("/System", "Applications", bundleName),
    join("/System", "Applications", "Utilities", bundleName),
  ];
}

export function resolveMacApplicationBundlePath(
  appNames: readonly string[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== "darwin" || !appNames) return null;

  for (const appName of appNames) {
    for (const candidate of resolveMacApplicationSearchPaths(appName, env)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // Keep probing the remaining standard locations.
      }
    }
  }

  return null;
}

export function resolveAvailableMacApplication(
  appNames: readonly string[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== "darwin" || !appNames) return null;

  return (
    appNames.find((appName) =>
      resolveMacApplicationSearchPaths(appName, env).some((candidate) => {
        try {
          return statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      }),
    ) ?? null
  );
}

function trimNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueNonEmpty(values: ReadonlyArray<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => value !== null)));
}

export function resolveWindowsStorePackageSearchRoots(
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const programFiles = trimNonEmpty(env.ProgramFiles);
  const programW6432 = trimNonEmpty(env.ProgramW6432);
  const systemDrive = trimNonEmpty(env.SystemDrive);

  return uniqueNonEmpty([
    programFiles ? join(programFiles, "WindowsApps") : null,
    programW6432 ? join(programW6432, "WindowsApps") : null,
    systemDrive ? join(systemDrive, "Program Files", "WindowsApps") : null,
  ]);
}

function windowsStorePackageDirMatches(
  dirName: string,
  packageDef: WindowsStorePackageDefinition,
): boolean {
  const normalizedName = dirName.toLowerCase();
  const packageName = packageDef.packageName.toLowerCase();
  const publisherId = packageDef.publisherId.toLowerCase();

  return (
    normalizedName === `${packageName}_${publisherId}` ||
    (normalizedName.startsWith(`${packageName}_`) && normalizedName.endsWith(`__${publisherId}`))
  );
}

function windowsStorePackageFamilyName(packageDef: WindowsStorePackageDefinition): string {
  return `${packageDef.packageName}_${packageDef.publisherId}`;
}

function uniqueWindowsStorePackageDefinitions(
  packages: readonly WindowsStorePackageDefinition[],
): readonly WindowsStorePackageDefinition[] {
  const byFamily = new Map<string, WindowsStorePackageDefinition>();
  for (const packageDef of packages) {
    byFamily.set(windowsStorePackageFamilyName(packageDef).toLowerCase(), packageDef);
  }
  return Array.from(byFamily.values());
}

// Scans package payload folders only. Availability still needs current-user AppX registration.
export function resolveWindowsStorePackageDirectory(
  packages: readonly WindowsStorePackageDefinition[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== "win32" || !packages) return null;

  for (const root of resolveWindowsStorePackageSearchRoots(env)) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!packages.some((packageDef) => windowsStorePackageDirMatches(entry.name, packageDef))) {
        continue;
      }

      const packageDir = join(root, entry.name);
      try {
        if (statSync(packageDir).isDirectory()) return packageDir;
      } catch {
        // Keep probing other package roots.
      }
    }
  }

  return null;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolvePowerShellCacheKey(
  packages: readonly WindowsStorePackageDefinition[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  const families = uniqueWindowsStorePackageDefinitions(packages)
    .map((packageDef) => windowsStorePackageFamilyName(packageDef).toLowerCase())
    .sort();
  return JSON.stringify({
    platform,
    families,
    path: readEffectiveWindowsEnvironmentValue(env, "PATH") ?? "",
    systemRoot:
      readEffectiveWindowsEnvironmentValue(env, "SystemRoot") ??
      readEffectiveWindowsEnvironmentValue(env, "WINDIR") ??
      "",
  });
}

function readPowerShellAppxLookupCache(key: string, now: number): string | null | undefined {
  const cached = powershellAppxLookupCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt > now) return cached.value;
  powershellAppxLookupCache.delete(key);
  return undefined;
}

function writePowerShellAppxLookupCache(key: string, value: string | null, now: number): void {
  powershellAppxLookupCache.set(key, {
    value,
    expiresAt: now + POWERSHELL_APPX_LOOKUP_CACHE_TTL_MS,
  });
}

export function clearWindowsStorePackageDiscoveryCache(): void {
  powershellAppxLookupCache.clear();
}

function buildBulkPowerShellPackageScript(
  packages: readonly WindowsStorePackageDefinition[],
): string {
  const packageArray = `@(${packages
    .map(
      (packageDef) =>
        `@{ Name = ${quotePowerShellLiteral(packageDef.packageName)}; Family = ${quotePowerShellLiteral(
          windowsStorePackageFamilyName(packageDef),
        )} }`,
    )
    .join(",")})`;

  return [
    `$packageDefs = ${packageArray}`,
    "$results = @()",
    "foreach ($packageDef in $packageDefs) {",
    `  $package = ${POWERSHELL_APPX_PACKAGE_QUERY}`,
    "  if ($null -ne $package -and $package.InstallLocation) {",
    "    $results += [PSCustomObject]@{ Family = $package.PackageFamilyName; InstallLocation = $package.InstallLocation }",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($results) -Compress",
  ].join("; ");
}

function parseBulkPowerShellPackageOutput(
  stdout: string,
  expectedFamilies: ReadonlySet<string>,
): Readonly<Record<string, string>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const installLocationsByFamily: Record<string, string> = {};
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("Family" in entry) ||
      !("InstallLocation" in entry) ||
      typeof entry.Family !== "string" ||
      typeof entry.InstallLocation !== "string"
    ) {
      return null;
    }
    const family = entry.Family.trim().toLowerCase();
    const installLocation = entry.InstallLocation.trim();
    if (!expectedFamilies.has(family) || installLocation.length === 0) {
      return null;
    }
    installLocationsByFamily[family] = installLocation;
  }
  return installLocationsByFamily;
}

/**
 * Resolves every relevant AppX package in one bounded, interruptible PowerShell process.
 * Empty output is represented by a successful empty JSON array; subprocess failures are
 * deliberately distinct so callers never turn a transient lookup failure into false absence.
 */
export async function discoverWindowsStorePackageInstallLocations(
  packages: readonly WindowsStorePackageDefinition[],
  options: WindowsStoreBulkLookupOptions = {},
): Promise<WindowsStoreBulkLookupResult> {
  const platform = options.platform ?? process.platform;
  const packageDefs = uniqueWindowsStorePackageDefinitions(packages);
  if (platform !== "win32" || packageDefs.length === 0) {
    return { status: "success", installLocationsByFamily: {}, subprocessCount: 0 };
  }
  if (options.signal?.aborted) {
    return { status: "failure", category: "cancelled", subprocessCount: 0 };
  }

  const env = normalizeWindowsChildEnvironment(options.env ?? process.env);
  const powershellPath = pathWin32.join(
    resolveWindowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    buildBulkPowerShellPackageScript(packageDefs),
  ] as const;
  const launch: SpawnWindowsStorePowerShell =
    options.spawnProcess ??
    ((command, commandArgs, spawnOptions) => spawn(command, [...commandArgs], spawnOptions));

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = launch(powershellPath, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return { status: "failure", category: "process_error", subprocessCount: 1 };
  }

  return await new Promise<WindowsStoreBulkLookupResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    let combinedOutputBytes = 0;
    let terminationCategory: WindowsStoreBulkLookupFailureCategory | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let postKillFallback: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanup = () => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
      if (postKillFallback !== undefined) {
        clearTimeout(postKillFallback);
        postKillFallback = undefined;
      }
      options.signal?.removeEventListener("abort", handleAbort);
      child.stdout.removeListener("data", handleStdout);
      child.stderr.removeListener("data", handleStderr);
      child.removeListener("error", handleError);
      child.removeListener("close", handleClose);
    };
    const finish = (result: WindowsStoreBulkLookupResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const requestTermination = (category: WindowsStoreBulkLookupFailureCategory) => {
      if (terminationCategory !== null || settled) return;
      terminationCategory = category;
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
      try {
        if (!child.kill()) {
          finish({ status: "failure", category, subprocessCount: 1 });
          return;
        }
      } catch {
        finish({ status: "failure", category, subprocessCount: 1 });
        return;
      }
      if (settled) return;
      postKillFallback = setTimeout(
        () => finish({ status: "failure", category, subprocessCount: 1 }),
        WINDOWS_STORE_BULK_LOOKUP_TERMINATION_GRACE_MS,
      );
      postKillFallback.unref();
    };
    const recordOutput = (chunk: Buffer | string, retain: boolean) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      combinedOutputBytes += buffer.byteLength;
      if (combinedOutputBytes > WINDOWS_STORE_BULK_LOOKUP_OUTPUT_LIMIT_BYTES) {
        requestTermination("output_limit");
        return;
      }
      if (retain) stdoutChunks.push(buffer);
    };
    const handleStdout = (chunk: Buffer | string) => recordOutput(chunk, true);
    const handleStderr = (chunk: Buffer | string) => recordOutput(chunk, false);
    const handleAbort = () => requestTermination("cancelled");
    const handleError = () =>
      finish({
        status: "failure",
        category: terminationCategory ?? "process_error",
        subprocessCount: 1,
      });
    const handleClose = (code: number | null) => {
      if (terminationCategory !== null) {
        finish({ status: "failure", category: terminationCategory, subprocessCount: 1 });
        return;
      }
      if (code !== 0) {
        finish({ status: "failure", category: "process_exit", subprocessCount: 1 });
        return;
      }

      const expectedFamilies = new Set(
        packageDefs.map((packageDef) => windowsStorePackageFamilyName(packageDef).toLowerCase()),
      );
      const parsed = parseBulkPowerShellPackageOutput(
        Buffer.concat(stdoutChunks).toString("utf8"),
        expectedFamilies,
      );
      finish(
        parsed === null
          ? { status: "failure", category: "malformed_output", subprocessCount: 1 }
          : {
              status: "success",
              installLocationsByFamily: parsed,
              subprocessCount: 1,
            },
      );
    };
    deadline = setTimeout(
      () => requestTermination("timeout"),
      WINDOWS_STORE_BULK_LOOKUP_TIMEOUT_MS,
    );
    deadline.unref();

    child.stdout.on("data", handleStdout);
    child.stderr.on("data", handleStderr);
    child.once("error", handleError);
    child.once("close", handleClose);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) handleAbort();
  });
}

export function resolveWindowsStorePackageDirectoryFromPowerShell(
  packages: readonly WindowsStorePackageDefinition[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  execFile: ExecFileSyncLike = execFileSync,
  options: WindowsStorePowerShellLookupOptions = {},
): string | null {
  if (platform !== "win32" || !packages) return null;

  const packageDefs = uniqueWindowsStorePackageDefinitions(packages);
  if (packageDefs.length === 0) return null;
  const childEnv = normalizeWindowsChildEnvironment(env);

  const now = options.now?.() ?? Date.now();
  const useCache = options.useCache ?? execFile === execFileSync;
  const cacheKey = useCache ? resolvePowerShellCacheKey(packageDefs, platform, childEnv) : null;
  if (cacheKey) {
    const cached = readPowerShellAppxLookupCache(cacheKey, now);
    if (cached !== undefined) return cached;
  }

  const packageArray = `@(${packageDefs
    .map(
      (packageDef) =>
        `@{ Name = ${quotePowerShellLiteral(packageDef.packageName)}; Family = ${quotePowerShellLiteral(
          windowsStorePackageFamilyName(packageDef),
        )} }`,
    )
    .join(",")})`;
  const script = [
    `$packages = ${packageArray}`,
    "foreach ($packageDef in $packages) {",
    `  $package = ${POWERSHELL_APPX_PACKAGE_QUERY}`,
    "  if ($null -ne $package -and $package.InstallLocation) {",
    "    Write-Output $package.InstallLocation",
    "    exit 0",
    "  }",
    "}",
    "exit 0",
  ].join("; ");

  try {
    const stdout = execFile("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      env: childEnv,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: POWERSHELL_APPX_LOOKUP_TIMEOUT_MS,
      windowsHide: true,
    });
    const result =
      String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? null;
    if (cacheKey) writePowerShellAppxLookupCache(cacheKey, result, now);
    return result;
  } catch {
    return null;
  }
}

export function resolveWindowsStorePackageInstallLocation(
  packages: readonly WindowsStorePackageDefinition[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  execFile: ExecFileSyncLike = execFileSync,
  options: WindowsStorePowerShellLookupOptions = {},
): string | null {
  return resolveWindowsStorePackageDirectoryFromPowerShell(
    packages,
    platform,
    env,
    execFile,
    options,
  );
}
