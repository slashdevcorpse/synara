#!/usr/bin/env node
// FILE: verify-packaged-desktop-startup.ts
// Purpose: Launches a packaged desktop payload from an isolated temporary tree before upload.
// Layer: Release verification script

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { synaraDesktopIdentity, type SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";
import {
  PACKAGED_DESKTOP_IDENTITY_PROOF_PREFIX,
  parsePackagedDesktopIdentityProof,
  type PackagedDesktopIdentityProof,
} from "@synara/shared/desktopIdentityProof";

export type PackagedDesktopPlatform = "linux" | "mac" | "win";

export interface PackagedDesktopStartupOptions {
  readonly assetsDirectory: string;
  readonly platform: PackagedDesktopPlatform;
  readonly arch: string;
  readonly version: string;
  readonly flavor: Exclude<SynaraDesktopFlavor, "development">;
  readonly timeoutMs: number;
}

export function parsePackagedDesktopStartupArgs(
  argv: ReadonlyArray<string>,
): PackagedDesktopStartupOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid packaged startup argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  const known = new Set([
    "--assets-dir",
    "--platform",
    "--arch",
    "--version",
    "--flavor",
    "--timeout-ms",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown packaged startup argument: ${name}.`);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing packaged startup argument: ${name}.`);
    return value;
  };
  const platform = required("--platform");
  if (platform !== "linux" && platform !== "mac" && platform !== "win") {
    throw new Error(`Unsupported packaged startup platform: ${platform}.`);
  }
  const timeoutMs = Number(values.get("--timeout-ms") ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) {
    throw new Error("--timeout-ms must be an integer between 5000 and 180000.");
  }
  const flavor = values.get("--flavor")?.trim().toLowerCase() || "production";
  if (flavor !== "production" && flavor !== "canary" && flavor !== "super") {
    throw new Error(`Unsupported packaged startup flavor: ${flavor}.`);
  }
  return {
    assetsDirectory: resolve(required("--assets-dir")),
    platform,
    arch: required("--arch"),
    version: required("--version"),
    flavor,
    timeoutMs,
  };
}

function runCommand(command: string, args: ReadonlyArray<string>, cwd?: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.`);
  }
}

function findFiles(root: string, predicate: (path: string) => boolean): string[] {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && predicate(candidate)) {
        matches.push(candidate);
      }
    }
  }
  return matches.toSorted((left, right) => left.localeCompare(right));
}

function requireSingleAsset(directory: string, suffix: string): string {
  const matches = readdirSync(directory)
    .map((entry) => join(directory, entry))
    .filter((candidate) => statSync(candidate).isFile() && candidate.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${suffix} release asset, found ${matches.length}.`);
  }
  return matches[0]!;
}

interface LaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

interface SyncTextCommandResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type SyncTextCommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => SyncTextCommandResult;

export interface PackagedDesktopExecutableStartupOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
  readonly timeoutMs: number;
  readonly description: string;
  readonly expectedIdentityProof?: PackagedDesktopIdentityProof;
}

export interface PackagedDesktopExitOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface PackagedDesktopControlledStopResult extends PackagedDesktopExitOutcome {
  readonly mode: "already-exited" | "controlled-process-tree-cleanup";
}

export interface RunningPackagedDesktop {
  readonly pid: number;
  assertRunning(): void;
  waitForExit(timeoutMs: number): Promise<PackagedDesktopExitOutcome | null>;
  stopControlled(): Promise<PackagedDesktopControlledStopResult>;
}

const runSyncTextCommand: SyncTextCommandRunner = (command, args) => {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  return {
    ...(result.error ? { error: result.error } : {}),
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
};

function readMacPlist(plistPath: string, runner: SyncTextCommandRunner): Record<string, unknown> {
  const result = runner("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]);
  if (result.error) {
    throw new Error(`Could not read packaged macOS Info.plist: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not read packaged macOS Info.plist: ${(result.stderr || result.stdout).trim() || `plutil exited with ${result.status ?? "unknown"}`}.`,
    );
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("plist JSON root is not an object");
    }
    return value as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `Could not parse packaged macOS Info.plist: ${cause instanceof Error ? cause.message : String(cause)}.`,
      { cause },
    );
  }
}

export function assertPackagedMacBundleIdentity(
  appBundle: string,
  flavor: Exclude<SynaraDesktopFlavor, "development">,
  runner: SyncTextCommandRunner = runSyncTextCommand,
): string {
  const identity = synaraDesktopIdentity(flavor);
  const expectedAppBundleName = `${identity.displayName}.app`;
  if (basename(appBundle) !== expectedAppBundleName) {
    throw new Error(
      `Packaged macOS app name mismatch: expected ${expectedAppBundleName}, got ${basename(appBundle)}.`,
    );
  }

  const plistPath = join(appBundle, "Contents", "Info.plist");
  if (!existsSync(plistPath)) {
    throw new Error(`Packaged macOS app is missing ${join("Contents", "Info.plist")}.`);
  }
  const plistStat = lstatSync(plistPath);
  if (!plistStat.isFile() || plistStat.isSymbolicLink()) {
    throw new Error("Packaged macOS Info.plist must be a non-symlink regular file.");
  }
  const plist = readMacPlist(plistPath, runner);
  const executableName = plist.CFBundleExecutable;
  if (executableName !== identity.executableName) {
    throw new Error(
      `Packaged macOS CFBundleExecutable mismatch: expected ${identity.executableName}, got ${executableName}.`,
    );
  }
  const bundleIdentifier = plist.CFBundleIdentifier;
  if (bundleIdentifier !== identity.bundleId) {
    throw new Error(
      `Packaged macOS CFBundleIdentifier mismatch: expected ${identity.bundleId}, got ${bundleIdentifier}.`,
    );
  }
  if (plist.CFBundleName !== identity.displayName) {
    throw new Error(
      `Packaged macOS CFBundleName mismatch: expected ${identity.displayName}, got ${String(plist.CFBundleName)}.`,
    );
  }
  if (
    plist.CFBundleDisplayName !== undefined &&
    plist.CFBundleDisplayName !== identity.displayName
  ) {
    throw new Error(
      `Packaged macOS CFBundleDisplayName mismatch: expected ${identity.displayName}, got ${String(plist.CFBundleDisplayName)}.`,
    );
  }

  const executable = join(appBundle, "Contents", "MacOS", identity.executableName);
  if (!existsSync(executable)) {
    throw new Error(`Packaged macOS app is missing its locked executable: ${executable}.`);
  }
  const executableStat = lstatSync(executable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
    throw new Error("Packaged macOS main executable must be a non-symlink regular file.");
  }
  return executable;
}

function prepareMacLaunch(
  assetsDirectory: string,
  extractionRoot: string,
  flavor: Exclude<SynaraDesktopFlavor, "development">,
): LaunchCommand {
  const diskImage = requireSingleAsset(assetsDirectory, ".dmg");
  const identity = synaraDesktopIdentity(flavor);
  const expectedAppBundleName = `${identity.displayName}.app`;
  const mountPoint = join(extractionRoot, "mounted-dmg");
  mkdirSync(mountPoint);
  let mounted = false;
  let inspectionFailure: Error | null = null;
  try {
    runCommand("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountPoint,
      diskImage,
    ]);
    mounted = true;
    const appBundles = readdirSync(mountPoint).filter((entry) => {
      const candidate = join(mountPoint, entry);
      if (!entry.endsWith(".app")) return false;
      const candidateStat = lstatSync(candidate);
      return candidateStat.isDirectory() && !candidateStat.isSymbolicLink();
    });
    if (appBundles.length !== 1 || appBundles[0] !== expectedAppBundleName) {
      throw new Error(
        `Expected only packaged macOS app ${expectedAppBundleName} in ${basename(diskImage)}, found ${appBundles.join(", ") || "<none>"}.`,
      );
    }
    runCommand("ditto", [
      join(mountPoint, expectedAppBundleName),
      join(extractionRoot, expectedAppBundleName),
    ]);
  } catch (cause) {
    inspectionFailure = cause instanceof Error ? cause : new Error(String(cause));
  }
  let detachFailure: Error | null = null;
  if (mounted) {
    try {
      runCommand("hdiutil", ["detach", mountPoint]);
    } catch (cause) {
      detachFailure = cause instanceof Error ? cause : new Error(String(cause));
    }
  }
  if (inspectionFailure || detachFailure) {
    throw new AggregateError(
      [inspectionFailure, detachFailure].filter((error): error is Error => error !== null),
      "Packaged macOS DMG inspection failed.",
    );
  }
  const appBundle = join(extractionRoot, expectedAppBundleName);
  const executable = assertPackagedMacBundleIdentity(appBundle, flavor);
  return { command: executable, args: [], cwd: appBundle };
}

function prepareLinuxLaunch(assetsDirectory: string, extractionRoot: string): LaunchCommand {
  const collectedAppImage = requireSingleAsset(assetsDirectory, ".AppImage");
  const appImage = join(extractionRoot, basename(collectedAppImage));
  copyFileSync(collectedAppImage, appImage);
  chmodSync(appImage, 0o755);
  runCommand(appImage, ["--appimage-extract"], extractionRoot);
  const appRun = join(extractionRoot, "squashfs-root", "AppRun");
  if (!existsSync(appRun)) {
    throw new Error(`${basename(appImage)} did not extract a runnable AppRun payload.`);
  }
  chmodSync(appRun, 0o755);
  return {
    command: "xvfb-run",
    args: ["-a", appRun, "--no-sandbox", "--disable-gpu"],
    cwd: join(extractionRoot, "squashfs-root"),
  };
}

function prepareWindowsLaunch(
  assetsDirectory: string,
  extractionRoot: string,
  flavor: Exclude<SynaraDesktopFlavor, "development">,
): LaunchCommand {
  const installer = requireSingleAsset(assetsDirectory, ".exe");
  const installerRoot = join(extractionRoot, "installer");
  const applicationRoot = join(extractionRoot, "application");
  mkdirSync(installerRoot, { recursive: true });
  mkdirSync(applicationRoot, { recursive: true });
  runCommand("7z", ["x", "-y", `-o${installerRoot}`, installer]);
  const applicationArchives = findFiles(installerRoot, (candidate) =>
    /[/\\]app-(?:32|64|arm64)\.7z$/i.test(candidate),
  );
  if (applicationArchives.length !== 1) {
    throw new Error(
      `Expected one embedded NSIS application archive, found ${applicationArchives.length}.`,
    );
  }
  runCommand("7z", ["x", "-y", `-o${applicationRoot}`, applicationArchives[0]!]);
  const expectedExecutable = `${synaraDesktopIdentity(flavor).executableName}.exe`;
  const executables = findFiles(
    applicationRoot,
    (candidate) => basename(candidate).toLowerCase() === expectedExecutable.toLowerCase(),
  );
  if (executables.length !== 1) {
    throw new Error(`Expected one extracted ${expectedExecutable}, found ${executables.length}.`);
  }
  return { command: executables[0]!, args: [], cwd: dirname(executables[0]!) };
}

function prepareLaunch(
  options: PackagedDesktopStartupOptions,
  extractionRoot: string,
): LaunchCommand {
  if (options.platform === "mac") {
    return prepareMacLaunch(options.assetsDirectory, extractionRoot, options.flavor);
  }
  if (options.platform === "linux") {
    return prepareLinuxLaunch(options.assetsDirectory, extractionRoot);
  }
  return prepareWindowsLaunch(options.assetsDirectory, extractionRoot, options.flavor);
}

export function packagedDesktopExecutableFileName(
  flavor: Exclude<SynaraDesktopFlavor, "development">,
  platform: PackagedDesktopPlatform,
): string {
  const executableName = synaraDesktopIdentity(flavor).executableName;
  return platform === "win" ? `${executableName}.exe` : executableName;
}

export function createExpectedPackagedDesktopIdentityProof(
  options: Pick<PackagedDesktopStartupOptions, "platform" | "flavor">,
  env: NodeJS.ProcessEnv,
): PackagedDesktopIdentityProof {
  const identity = synaraDesktopIdentity(options.flavor);
  const userDataBase =
    options.platform === "mac"
      ? env.HOME && join(env.HOME, "Library", "Application Support")
      : options.platform === "win"
        ? env.APPDATA
        : env.XDG_CONFIG_HOME;
  if (!userDataBase || !env.SYNARA_HOME) {
    throw new Error(
      `Packaged ${options.platform} identity proof requires isolated user-data and backend-home paths.`,
    );
  }
  return {
    flavor: identity.flavor,
    appUserModelId: options.platform === "win" ? identity.bundleId : null,
    bundleId: identity.bundleId,
    internalProtocolScheme: identity.scheme,
    internalProtocolRegistered: true,
    userDataDirectoryName: identity.userDataDirectoryName,
    userDataPath: join(userDataBase, identity.userDataDirectoryName),
    backendHomePath: env.SYNARA_HOME,
  };
}

export function createPackagedDesktopSmokeEnvironment(
  root: string,
  options: Pick<PackagedDesktopStartupOptions, "platform" | "version"> &
    Partial<Pick<PackagedDesktopStartupOptions, "flavor">>,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const identity = synaraDesktopIdentity(options.flavor ?? "production");
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    SYNARA_HOME: join(root, `${identity.userDataDirectoryName}-home`),
    SYNARA_DESKTOP_FLAVOR: identity.flavor,
    SYNARA_DISABLE_AUTO_UPDATE: "1",
    SYNARA_DESKTOP_QUALIFICATION_EXIT_AFTER_STARTUP: "1",
    ELECTRON_ENABLE_LOGGING: "1",
  };
  delete env.SYNARA_AUTH_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  for (const path of [
    env.HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.SYNARA_HOME,
  ]) {
    if (path) mkdirSync(path, { recursive: true });
  }
  const userDataPath = createExpectedPackagedDesktopIdentityProof(
    { platform: options.platform, flavor: options.flavor ?? "production" },
    env,
  ).userDataPath;
  mkdirSync(userDataPath, { recursive: true });
  if (options.platform === "mac") {
    // Prevent the packaged app's update-only icon repair from registering this
    // temporary bundle in the runner's normal Launch Services database.
    const launchVersionPath = join(userDataPath, "last-launch-version.json");
    writeFileSync(launchVersionPath, `${JSON.stringify({ version: options.version }, null, 2)}\n`);
  }
  return env;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  if (!child.pid) throw new Error("Cannot terminate a packaged desktop process without a PID.");
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (await waitForExit(child, 5_000)) return !result.error && result.status === 0;
    throw new Error(
      `Packaged desktop process tree ${child.pid} remained alive after taskkill (status=${result.status ?? "unknown"}).`,
    );
  }
  let terminationRequested = false;
  try {
    process.kill(-child.pid, "SIGTERM");
    terminationRequested = true;
  } catch {
    terminationRequested = child.kill("SIGTERM");
  }
  if (await waitForExit(child, 5_000)) return terminationRequested;
  try {
    process.kill(-child.pid, "SIGKILL");
    terminationRequested = true;
  } catch {
    terminationRequested = child.kill("SIGKILL") || terminationRequested;
  }
  if (!(await waitForExit(child, 2_000))) {
    throw new Error(`Packaged desktop process tree ${child.pid} remained alive after SIGKILL.`);
  }
  return terminationRequested;
}

function childExitOutcome(child: ChildProcess): PackagedDesktopExitOutcome | null {
  if (child.exitCode === null && child.signalCode === null) return null;
  return { code: child.exitCode, signal: child.signalCode };
}

export async function launchPackagedDesktopAndWaitForStartup(
  options: PackagedDesktopExecutableStartupOptions,
): Promise<RunningPackagedDesktop> {
  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const childOutcome: { launchError: Error | null } = { launchError: null };
  child.once("error", (error) => {
    childOutcome.launchError = error;
  });
  child.stdout?.resume();
  child.stderr?.resume();

  let startupProven = false;
  try {
    const startupDeadline = Date.now() + options.timeoutMs;
    while (Date.now() < startupDeadline) {
      if (childOutcome.launchError) {
        throw new Error(
          `${options.description} could not start: ${childOutcome.launchError.message}`,
        );
      }
      if (hasPackagedDesktopStartupProof(options.logPath, options.expectedIdentityProof)) {
        startupProven = true;
        break;
      }
      const exited = childExitOutcome(child);
      if (exited) {
        throw new Error(
          `${options.description} exited before startup proof (code=${exited.code ?? "null"}, signal=${exited.signal ?? "null"}).`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    if (!startupProven) {
      throw new Error(
        `${options.description} startup proof timed out after ${options.timeoutMs}ms.`,
      );
    }

    const pid = child.pid;
    if (!pid) throw new Error(`${options.description} started without a process ID.`);
    const assertRunning = (): void => {
      if (childOutcome.launchError) {
        throw new Error(
          `${options.description} process failed: ${childOutcome.launchError.message}`,
        );
      }
      const exited = childExitOutcome(child);
      if (exited) {
        throw new Error(
          `${options.description} is not running (code=${exited.code ?? "null"}, signal=${exited.signal ?? "null"}).`,
        );
      }
    };
    return {
      pid,
      assertRunning,
      waitForExit: async (timeoutMs) => {
        if (!(await waitForExit(child, timeoutMs))) return null;
        return childExitOutcome(child) ?? { code: null, signal: null };
      },
      stopControlled: async () => {
        const existingOutcome = childExitOutcome(child);
        if (existingOutcome) return { mode: "already-exited", ...existingOutcome };
        const cleanupRequested = await terminateProcessTree(child);
        const stoppedOutcome = childExitOutcome(child);
        if (!stoppedOutcome) {
          throw new Error(`${options.description} controlled process-tree cleanup was unproven.`);
        }
        if (!cleanupRequested) return { mode: "already-exited", ...stoppedOutcome };
        return { mode: "controlled-process-tree-cleanup", ...stoppedOutcome };
      },
    };
  } finally {
    if (!startupProven && child.pid) await terminateProcessTree(child);
  }
}

function hasExpectedPackagedDesktopIdentityProof(
  log: string,
  expected: PackagedDesktopIdentityProof,
): boolean {
  return log.split(/\r?\n/).some((line) => {
    const proofStart = line.indexOf(PACKAGED_DESKTOP_IDENTITY_PROOF_PREFIX);
    if (proofStart < 0) return false;
    const actual = parsePackagedDesktopIdentityProof(line.slice(proofStart));
    return (
      actual !== null &&
      actual.flavor === expected.flavor &&
      actual.appUserModelId === expected.appUserModelId &&
      actual.bundleId === expected.bundleId &&
      actual.internalProtocolScheme === expected.internalProtocolScheme &&
      actual.internalProtocolRegistered === expected.internalProtocolRegistered &&
      actual.userDataDirectoryName === expected.userDataDirectoryName &&
      normalize(actual.userDataPath) === normalize(expected.userDataPath) &&
      normalize(actual.backendHomePath) === normalize(expected.backendHomePath)
    );
  });
}

export function hasPackagedDesktopStartupProof(
  logPath: string,
  expectedIdentityProof?: PackagedDesktopIdentityProof,
): boolean {
  try {
    const log = readFileSync(logPath, "utf8");
    return (
      log.includes("app ready") &&
      log.includes("bootstrap main window created") &&
      log.includes("bootstrap backend ready source=") &&
      (!expectedIdentityProof ||
        hasExpectedPackagedDesktopIdentityProof(log, expectedIdentityProof))
    );
  } catch {
    return false;
  }
}

export function hasPackagedDesktopCleanExitProof(logPath: string): boolean {
  try {
    const log = readFileSync(logPath, "utf8");
    return (
      log.includes("packaged startup qualification exit requested") &&
      log.includes("packaged startup qualification shutdown complete")
    );
  } catch {
    return false;
  }
}

export async function verifyPackagedDesktopExecutableStartup(
  options: PackagedDesktopExecutableStartupOptions,
): Promise<void> {
  const running = await launchPackagedDesktopAndWaitForStartup(options);
  try {
    const exited = await running.waitForExit(30_000);
    if (!exited)
      throw new Error(`${options.description} clean-exit proof timed out after startup.`);
    if (exited.code !== 0 || exited.signal !== null) {
      throw new Error(
        `${options.description} did not exit cleanly (code=${exited.code ?? "null"}, signal=${exited.signal ?? "null"}).`,
      );
    }
    if (!hasPackagedDesktopCleanExitProof(options.logPath)) {
      throw new Error(`${options.description} exited without graceful shutdown proof.`);
    }
    console.log(`${options.description} startup and clean-exit smoke passed from isolated state.`);
  } finally {
    await running.stopControlled();
  }
}

export function resolveNativePackagedDesktopPlatform(
  platform: NodeJS.Platform,
): PackagedDesktopPlatform {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return "linux";
}

export async function verifyPackagedDesktopStartup(
  options: PackagedDesktopStartupOptions,
): Promise<void> {
  const nativePlatform = resolveNativePackagedDesktopPlatform(process.platform);
  if (nativePlatform !== options.platform) {
    throw new Error(
      `Packaged ${options.platform} startup smoke must run on its native host, not ${process.platform}.`,
    );
  }
  const temporaryRoot = mkdtempSync(
    join(
      tmpdir(),
      `${synaraDesktopIdentity(options.flavor).userDataDirectoryName}-packaged-smoke-${options.platform}-`,
    ),
  );
  const extractionRoot = join(temporaryRoot, "payload");
  mkdirSync(extractionRoot, { recursive: true });

  let verificationFailure: Error | null = null;
  try {
    const launch = prepareLaunch(options, extractionRoot);
    const env = createPackagedDesktopSmokeEnvironment(join(temporaryRoot, "state"), options);
    const logPath = join(env.SYNARA_HOME!, "userdata", "logs", "desktop-main.log");
    await verifyPackagedDesktopExecutableStartup({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env,
      logPath,
      timeoutMs: options.timeoutMs,
      description: `Packaged ${options.platform}/${options.arch}`,
      expectedIdentityProof: createExpectedPackagedDesktopIdentityProof(options, env),
    });
  } catch (cause) {
    verificationFailure = cause instanceof Error ? cause : new Error(String(cause));
  }
  let cleanupFailure: Error | null = null;
  try {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (cause) {
    cleanupFailure = cause instanceof Error ? cause : new Error(String(cause));
  }
  if (verificationFailure || cleanupFailure) {
    throw new AggregateError(
      [verificationFailure, cleanupFailure].filter((error): error is Error => error !== null),
      "Packaged desktop startup verification or cleanup failed.",
    );
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyPackagedDesktopStartup(parsePackagedDesktopStartupArgs(process.argv.slice(2)));
}
