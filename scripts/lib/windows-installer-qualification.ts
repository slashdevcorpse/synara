// FILE: windows-installer-qualification.ts
// Purpose: Qualifies Super Synara's Windows installer lifecycle without touching live profiles.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, normalize, resolve } from "node:path";

import {
  SYNARA_WINDOWS_INSTALLER_GUID,
  synaraDesktopIdentity,
  type SynaraDesktopIdentity,
  type SynaraDesktopFlavor,
} from "@synara/shared/desktopIdentity";

import {
  createPackagedDesktopSmokeEnvironment,
  verifyPackagedDesktopExecutableStartup,
} from "../verify-packaged-desktop-startup.ts";
import {
  compareSuperSynaraVersions,
  parseSuperSynaraVersion,
  superSynaraWindowsInstallerName,
} from "./super-synara-previous-release.ts";

export type WindowsRegistryHive = "HKCU" | "HKLM";
export type WindowsRegistryView = "32" | "64";
export type WindowsRegistrationKind = "install" | "uninstall";

export interface WindowsRegistryTarget {
  readonly id: string;
  readonly hive: WindowsRegistryHive;
  readonly view: WindowsRegistryView;
  readonly key: string;
  readonly kind: WindowsRegistrationKind;
}

export interface ParsedRegistryValue {
  readonly name: string;
  readonly type: string;
  readonly data: string;
}

export interface ParsedRegistryKey {
  readonly key: string;
  readonly values: ReadonlyArray<ParsedRegistryValue>;
}

export interface WindowsCommandSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly label: string;
}

export interface WindowsExecutableIdentity {
  readonly productName: string;
}

export interface WindowsInstallerQualificationRuntime {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isEphemeralHostedRunner: boolean;
  readonly readRegistry: (target: WindowsRegistryTarget) => string | null;
  readonly runCommand: (spec: WindowsCommandSpec) => void;
  readonly readExecutableIdentity: (executablePath: string) => WindowsExecutableIdentity;
  readonly verifyStartup: typeof verifyPackagedDesktopExecutableStartup;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface WindowsInstallerQualificationOptions {
  readonly installerPath: string;
  readonly upstreamInstallerPath: string;
  readonly version: string;
  readonly previousInstallerPath?: string;
  readonly startupTimeoutMs: number;
}

export interface WindowsInstallerQualificationReport {
  readonly schemaVersion: 1;
  readonly platform: "windows-x64";
  readonly currentVersion: string;
  readonly upgrade: "qualified" | "not-run-no-previous-release";
  readonly previousVersion: string | null;
  readonly sideBySide: {
    readonly upstreamVersion: string;
    readonly upstreamTag: string;
    readonly upstreamInstallerSha256: string;
    readonly upstreamProductName: "Synara";
    readonly upstreamExecutablePreserved: true;
    readonly upstreamRegistrationPreserved: true;
    readonly upstreamProfileSentinelsPreserved: true;
    readonly upstreamUninstallCleanupProven: true;
  };
  readonly isolation: {
    readonly liveProfilesRead: false;
    readonly liveProfilesMutated: false;
    readonly upstreamRegistrationPreserved: true;
    readonly upstreamSentinelsPreserved: true;
    readonly superStateWasTemporary: true;
  };
  readonly installation: {
    readonly productName: "Super Synara";
    readonly executableName: "Super Synara.exe";
    readonly registrationScope: "current-user-64";
    readonly startupProven: true;
    readonly cleanExitProven: true;
    readonly uninstallCleanupProven: true;
  };
}

interface RegistrySnapshot {
  readonly targets: ReadonlyArray<WindowsRegistryTarget>;
  readonly values: ReadonlyMap<string, string | null>;
}

interface ValidatedRegistration {
  readonly uninstallCommand: WindowsCommandSpec;
}

interface QualificationPaths {
  readonly root: string;
  readonly installDirectory: string;
  readonly executablePath: string;
  readonly uninstallerPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly logPath: string;
  readonly sentinelPaths: ReadonlyArray<string>;
}

const SUPER_IDENTITY = synaraDesktopIdentity("super");
const UPSTREAM_IDENTITY = synaraDesktopIdentity("production");
const REGISTRY_UNINSTALL_ROOT = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const QUALIFICATION_SENTINEL = Buffer.from(
  "super-synara-installer-qualification-sentinel-v1\r\n\u0000preserve-exactly",
  "utf8",
);

function registrationKey(kind: WindowsRegistrationKind, guid: string): string {
  return kind === "install" ? `Software\\${guid}` : `${REGISTRY_UNINSTALL_ROOT}\\${guid}`;
}

export function createWindowsRegistrationTargets(
  guid: string,
): ReadonlyArray<WindowsRegistryTarget> {
  return (["HKCU", "HKLM"] as const).flatMap((hive) =>
    (["32", "64"] as const).flatMap((view) =>
      (["install", "uninstall"] as const).map((kind) => ({
        id: `${hive}:${view}:${kind}`,
        hive,
        view,
        kind,
        key: registrationKey(kind, guid),
      })),
    ),
  );
}

export function parseRegistryQueryOutput(output: string): ReadonlyArray<ParsedRegistryKey> {
  const records: Array<{ key: string; values: ParsedRegistryValue[] }> = [];
  let current: { key: string; values: ParsedRegistryValue[] } | null = null;
  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^HKEY_(?:CURRENT_USER|LOCAL_MACHINE)\\/i.test(line.trim())) {
      current = { key: line.trim(), values: [] };
      records.push(current);
      continue;
    }
    const valueMatch = /^\s+(.+?)\s{2,}(REG_[A-Z0-9_]+)\s{2,}(.*)$/i.exec(line);
    if (!current || !valueMatch) {
      throw new Error(`Unrecognized registry query line: ${rawLine}.`);
    }
    current.values.push({
      name: valueMatch[1]!.trim(),
      type: valueMatch[2]!.toUpperCase(),
      data: valueMatch[3]!,
    });
  }
  if (records.length === 0) {
    throw new Error("Registry query succeeded without returning a registry key.");
  }
  return records.map((record) => ({
    key: record.key,
    values: record.values.toSorted((left, right) => left.name.localeCompare(right.name)),
  }));
}

export function canonicalizeRegistryQueryOutput(output: string): string {
  return JSON.stringify(parseRegistryQueryOutput(output));
}

function readRegistryValue(raw: string, name: string): string | null {
  const values = parseRegistryQueryOutput(raw).flatMap((record) => record.values);
  const matches = values.filter((value) => value.name.toLowerCase() === name.toLowerCase());
  if (matches.length !== 1) return null;
  return matches[0]!.data;
}

function snapshotRegistry(
  runtime: WindowsInstallerQualificationRuntime,
  targets: ReadonlyArray<WindowsRegistryTarget>,
): RegistrySnapshot {
  return {
    targets,
    values: new Map(
      targets.map((target) => {
        const raw = runtime.readRegistry(target);
        return [target.id, raw === null ? null : canonicalizeRegistryQueryOutput(raw)] as const;
      }),
    ),
  };
}

function snapshotRawRegistry(
  runtime: WindowsInstallerQualificationRuntime,
  targets: ReadonlyArray<WindowsRegistryTarget>,
): RegistrySnapshot {
  return {
    targets,
    values: new Map(targets.map((target) => [target.id, runtime.readRegistry(target)] as const)),
  };
}

function assertRegistrySnapshotsEqual(
  before: RegistrySnapshot,
  after: RegistrySnapshot,
  label: string,
): void {
  for (const target of before.targets) {
    if (before.values.get(target.id) !== after.values.get(target.id)) {
      throw new Error(`${label} registry changed at ${target.id}.`);
    }
  }
}

function assertNoRegistration(snapshot: RegistrySnapshot, label: string): void {
  const present = snapshot.targets.filter((target) => snapshot.values.get(target.id) !== null);
  if (present.length > 0) {
    throw new Error(
      `${label} registration already exists at ${present.map((target) => target.id).join(", ")}; qualification refuses to modify an installed copy.`,
    );
  }
}

function targetValue(snapshot: RegistrySnapshot, id: string): string | null {
  return snapshot.values.get(id) ?? null;
}

export function createSilentInstallerCommand(
  installerPath: string,
  installDirectory: string,
  env: NodeJS.ProcessEnv,
): WindowsCommandSpec {
  return {
    command: resolve(installerPath),
    args: ["/S", `/D=${resolve(installDirectory)}`],
    env,
    timeoutMs: 180_000,
    label: `silent installer ${basename(installerPath)}`,
  };
}

export function parseWindowsExecutableCommandLine(input: string): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  const match = /^"([^"]+)"(?:\s+(.*))?$/.exec(input.trim());
  if (!match)
    throw new Error(`Windows command line must start with one quoted executable: ${input}.`);
  return {
    command: match[1]!,
    args: match[2]?.trim() ? match[2]!.trim().split(/\s+/) : [],
  };
}

function sameWindowsPath(left: string, right: string): boolean {
  return normalize(resolve(left)).toLowerCase() === normalize(resolve(right)).toLowerCase();
}

function validateRegistration(
  snapshot: RegistrySnapshot,
  expectedVersion: string,
  paths: QualificationPaths,
  identity: SynaraDesktopIdentity,
): ValidatedRegistration {
  const installRaw = targetValue(snapshot, "HKCU:64:install");
  const uninstallRaw = targetValue(snapshot, "HKCU:64:uninstall");
  if (!installRaw || !uninstallRaw) {
    throw new Error(`${identity.displayName} registration is incomplete.`);
  }
  for (const kind of ["install", "uninstall"] as const) {
    for (const hive of ["HKLM"] as const) {
      for (const view of ["32", "64"] as const) {
        if (targetValue(snapshot, `${hive}:${view}:${kind}`) !== null) {
          throw new Error(`${identity.displayName} registration escaped current-user scope.`);
        }
      }
    }
    const sharedViewRaw = targetValue(snapshot, `HKCU:32:${kind}`);
    const nativeViewRaw = kind === "install" ? installRaw : uninstallRaw;
    if (
      sharedViewRaw !== null &&
      canonicalizeRegistryQueryOutput(sharedViewRaw) !==
        canonicalizeRegistryQueryOutput(nativeViewRaw)
    ) {
      throw new Error(
        `${identity.displayName} registration differs across Windows registry views.`,
      );
    }
  }

  const installLocation = readRegistryValue(installRaw, "InstallLocation");
  const displayName = readRegistryValue(uninstallRaw, "DisplayName");
  const displayVersion = readRegistryValue(uninstallRaw, "DisplayVersion");
  const quietUninstallString = readRegistryValue(uninstallRaw, "QuietUninstallString");
  if (!installLocation || !sameWindowsPath(installLocation, paths.installDirectory)) {
    throw new Error(
      `${identity.displayName} registry InstallLocation is not the isolated install directory.`,
    );
  }
  if (displayName !== `${identity.displayName} ${expectedVersion}`) {
    throw new Error(
      `Unexpected ${identity.displayName} uninstall DisplayName: ${displayName ?? "<missing>"}.`,
    );
  }
  if (displayVersion !== expectedVersion) {
    throw new Error(
      `Unexpected ${identity.displayName} uninstall DisplayVersion: ${displayVersion ?? "<missing>"}.`,
    );
  }
  if (!quietUninstallString) {
    throw new Error(`${identity.displayName} QuietUninstallString is missing.`);
  }
  const parsed = parseWindowsExecutableCommandLine(quietUninstallString);
  if (!sameWindowsPath(parsed.command, paths.uninstallerPath)) {
    throw new Error(
      `${identity.displayName} QuietUninstallString points outside the isolated install directory.`,
    );
  }
  if (parsed.args.join(" ").toLowerCase() !== "/currentuser /s") {
    throw new Error(
      `Unexpected ${identity.displayName} quiet-uninstall arguments: ${parsed.args.join(" ")}.`,
    );
  }
  return {
    uninstallCommand: {
      command: parsed.command,
      args: parsed.args,
      env: paths.environment,
      timeoutMs: 180_000,
      label: `silent ${identity.displayName} uninstaller`,
    },
  };
}

function createQualificationPaths(
  root: string,
  identity: SynaraDesktopIdentity,
  flavor: Exclude<SynaraDesktopFlavor, "development">,
): QualificationPaths {
  const stateRoot = join(root, "state");
  const environment = createPackagedDesktopSmokeEnvironment(
    stateRoot,
    { platform: "win", version: "qualification", flavor },
    process.env,
  );
  environment.TEMP = join(stateRoot, "temp");
  environment.TMP = environment.TEMP;
  mkdirSync(environment.TEMP, { recursive: true });

  const installDirectory = join(root, "install", identity.displayName);
  const profileSeed = join(root, "copied-profile-seed");
  const seededBackendHome = join(profileSeed, "backend-home");
  const seededDesktopProfile = join(profileSeed, "appdata", identity.userDataDirectoryName);
  mkdirSync(join(seededBackendHome, "userdata"), { recursive: true });
  mkdirSync(seededDesktopProfile, { recursive: true });
  writeFileSync(
    join(seededBackendHome, "userdata", "qualification-sentinel.bin"),
    QUALIFICATION_SENTINEL,
  );
  writeFileSync(join(seededDesktopProfile, "qualification-sentinel.bin"), QUALIFICATION_SENTINEL);
  rmSync(environment.SYNARA_HOME!, { recursive: true, force: true });
  rmSync(join(environment.APPDATA!, identity.userDataDirectoryName), {
    recursive: true,
    force: true,
  });
  cpSync(seededBackendHome, environment.SYNARA_HOME!, { recursive: true });
  cpSync(seededDesktopProfile, join(environment.APPDATA!, identity.userDataDirectoryName), {
    recursive: true,
  });

  const executablePath = join(installDirectory, `${identity.executableName}.exe`);
  return {
    root,
    installDirectory,
    executablePath,
    uninstallerPath: join(installDirectory, `Uninstall ${identity.displayName}.exe`),
    environment,
    logPath: join(environment.SYNARA_HOME!, "userdata", "logs", "desktop-main.log"),
    sentinelPaths: [
      join(environment.SYNARA_HOME!, "userdata", "qualification-sentinel.bin"),
      join(environment.APPDATA!, identity.userDataDirectoryName, "qualification-sentinel.bin"),
    ],
  };
}

function snapshotSentinels(paths: ReadonlyArray<string>): ReadonlyMap<string, Buffer> {
  return new Map(paths.map((path) => [path, readFileSync(path)] as const));
}

function assertSentinelsUnchanged(snapshot: ReadonlyMap<string, Buffer>): void {
  for (const [path, before] of snapshot) {
    if (!existsSync(path) || !readFileSync(path).equals(before)) {
      throw new Error(`Isolated profile sentinel changed: ${path}.`);
    }
  }
}

function requireInstallerFile(installerPath: string, version: string): string {
  const resolvedPath = resolve(installerPath);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new Error(`Installer does not exist as a regular file: ${resolvedPath}.`);
  }
  const expectedName = superSynaraWindowsInstallerName(version);
  if (basename(resolvedPath) !== expectedName) {
    throw new Error(
      `Expected exact installer name ${expectedName}, received ${basename(resolvedPath)}.`,
    );
  }
  return resolvedPath;
}

function previousVersionFromInstaller(installerPath: string, currentVersion: string): string {
  const match = /^Super-Synara-(.+)-windows-x64-unsigned\.exe$/.exec(basename(installerPath));
  if (!match)
    throw new Error(`Invalid previous Super Synara installer name: ${basename(installerPath)}.`);
  const previous = parseSuperSynaraVersion(match[1]!);
  const current = parseSuperSynaraVersion(currentVersion);
  if (compareSuperSynaraVersions(previous, current) >= 0) {
    throw new Error(
      "Previous Super Synara installer version must be older than the current version.",
    );
  }
  requireInstallerFile(installerPath, previous.text);
  return previous.text;
}

export function upstreamVersionFromInstaller(installerPath: string): string {
  const resolvedPath = resolve(installerPath);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new Error(`Upstream installer does not exist as a regular file: ${resolvedPath}.`);
  }
  const match = /^Synara-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-x64\.exe$/.exec(
    basename(resolvedPath),
  );
  if (!match) {
    throw new Error(`Invalid exact upstream Synara x64 installer name: ${basename(resolvedPath)}.`);
  }
  return match[1]!;
}

function runAndValidateInstaller(
  runtime: WindowsInstallerQualificationRuntime,
  installerPath: string,
  version: string,
  paths: QualificationPaths,
  targets: ReadonlyArray<WindowsRegistryTarget>,
  identity: SynaraDesktopIdentity,
): ValidatedRegistration {
  runtime.runCommand(
    createSilentInstallerCommand(installerPath, paths.installDirectory, paths.environment),
  );
  if (!existsSync(paths.executablePath) || !statSync(paths.executablePath).isFile()) {
    throw new Error(
      `Installed ${identity.displayName} executable is missing: ${paths.executablePath}.`,
    );
  }
  const executableIdentity = runtime.readExecutableIdentity(paths.executablePath);
  if (executableIdentity.productName !== identity.displayName) {
    throw new Error(
      `Installed executable product identity mismatch: ${executableIdentity.productName}.`,
    );
  }
  return validateRegistration(snapshotRawRegistry(runtime, targets), version, paths, identity);
}

async function waitForUninstallCleanup(
  runtime: WindowsInstallerQualificationRuntime,
  targets: ReadonlyArray<WindowsRegistryTarget>,
  installDirectory: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const registration = snapshotRawRegistry(runtime, targets);
    const registryAbsent = [...registration.values.values()].every((value) => value === null);
    if (registryAbsent && !existsSync(installDirectory)) return;
    await runtime.sleep(200);
  }
  throw new Error(`${label} uninstall did not remove its registration and install directory.`);
}

async function cleanupAttemptedInstallation(
  runtime: WindowsInstallerQualificationRuntime,
  targets: ReadonlyArray<WindowsRegistryTarget>,
  paths: QualificationPaths,
  attemptedVersion: string | null,
  identity: SynaraDesktopIdentity,
): Promise<void> {
  const snapshot = snapshotRawRegistry(runtime, targets);
  const hasRegistration = [...snapshot.values.values()].some((value) => value !== null);
  if (hasRegistration) {
    if (!attemptedVersion) {
      throw new Error(
        `${identity.displayName} registration appeared without an owned installer attempt.`,
      );
    }
    let uninstallCommand: WindowsCommandSpec;
    try {
      uninstallCommand = validateRegistration(
        snapshot,
        attemptedVersion,
        paths,
        identity,
      ).uninstallCommand;
    } catch (error) {
      if (!existsSync(paths.uninstallerPath) || !statSync(paths.uninstallerPath).isFile())
        throw error;
      uninstallCommand = {
        command: paths.uninstallerPath,
        args: ["/currentuser", "/S"],
        env: paths.environment,
        timeoutMs: 180_000,
        label: `owned partial-install ${identity.displayName} uninstaller`,
      };
    }
    runtime.runCommand(uninstallCommand);
    await waitForUninstallCleanup(runtime, targets, paths.installDirectory, identity.displayName);
    return;
  }
  if (existsSync(paths.installDirectory)) {
    rmSync(paths.installDirectory, { recursive: true, force: true });
  }
}

interface InstalledApplicationSnapshot {
  readonly registration: RegistrySnapshot;
  readonly executableSha256: string;
  readonly uninstallerSha256: string;
  readonly sentinels: ReadonlyMap<string, Buffer>;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotInstalledApplication(
  runtime: WindowsInstallerQualificationRuntime,
  targets: ReadonlyArray<WindowsRegistryTarget>,
  paths: QualificationPaths,
): InstalledApplicationSnapshot {
  return {
    registration: snapshotRegistry(runtime, targets),
    executableSha256: sha256File(paths.executablePath),
    uninstallerSha256: sha256File(paths.uninstallerPath),
    sentinels: snapshotSentinels(paths.sentinelPaths),
  };
}

function assertInstalledApplicationUnchanged(
  runtime: WindowsInstallerQualificationRuntime,
  targets: ReadonlyArray<WindowsRegistryTarget>,
  paths: QualificationPaths,
  before: InstalledApplicationSnapshot,
  label: string,
): void {
  assertRegistrySnapshotsEqual(before.registration, snapshotRegistry(runtime, targets), label);
  assertSentinelsUnchanged(before.sentinels);
  if (
    !existsSync(paths.executablePath) ||
    sha256File(paths.executablePath) !== before.executableSha256
  ) {
    throw new Error(`${label} executable bytes changed during side-by-side qualification.`);
  }
  if (
    !existsSync(paths.uninstallerPath) ||
    sha256File(paths.uninstallerPath) !== before.uninstallerSha256
  ) {
    throw new Error(`${label} uninstaller bytes changed during side-by-side qualification.`);
  }
}

export async function qualifySuperSynaraWindowsInstaller(
  options: WindowsInstallerQualificationOptions,
  runtime: WindowsInstallerQualificationRuntime,
): Promise<WindowsInstallerQualificationReport> {
  if (runtime.platform !== "win32" || runtime.arch !== "x64") {
    throw new Error(
      `Super Synara Windows installer qualification requires Windows x64, not ${runtime.platform}/${runtime.arch}.`,
    );
  }
  if (!runtime.isEphemeralHostedRunner) {
    throw new Error(
      "Native installer qualification is restricted to the ephemeral GitHub-hosted Windows lane so NSIS shell-folder and registry side effects cannot touch a live workstation.",
    );
  }
  const currentVersion = parseSuperSynaraVersion(options.version).text;
  const currentInstaller = requireInstallerFile(options.installerPath, currentVersion);
  const upstreamInstaller = resolve(options.upstreamInstallerPath);
  const upstreamVersion = upstreamVersionFromInstaller(upstreamInstaller);
  const upstreamInstallerSha256 = sha256File(upstreamInstaller);
  const previousInstaller = options.previousInstallerPath
    ? resolve(options.previousInstallerPath)
    : null;
  const previousVersion = previousInstaller
    ? previousVersionFromInstaller(previousInstaller, currentVersion)
    : null;

  const root = mkdtempSync(join(tmpdir(), "super-synara-installer-qualification-"));
  let superPaths: QualificationPaths;
  let upstreamPaths: QualificationPaths;
  try {
    superPaths = createQualificationPaths(join(root, "super"), SUPER_IDENTITY, "super");
    upstreamPaths = createQualificationPaths(
      join(root, "upstream"),
      UPSTREAM_IDENTITY,
      "production",
    );
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const superSentinelSnapshot = snapshotSentinels(superPaths.sentinelPaths);
  const upstreamSentinelSnapshot = snapshotSentinels(upstreamPaths.sentinelPaths);
  const superTargets = createWindowsRegistrationTargets(SUPER_IDENTITY.windowsInstallerGuid);
  const upstreamTargets = createWindowsRegistrationTargets(SYNARA_WINDOWS_INSTALLER_GUID);
  const preexistingUpstreamRegistration = snapshotRegistry(runtime, upstreamTargets);
  const preexistingSuperRegistration = snapshotRegistry(runtime, superTargets);

  let attemptedSuperVersion: string | null = null;
  let attemptedUpstreamVersion: string | null = null;
  let report: WindowsInstallerQualificationReport | null = null;
  const failures: unknown[] = [];

  try {
    assertNoRegistration(preexistingSuperRegistration, "Super Synara");
    assertNoRegistration(preexistingUpstreamRegistration, "Upstream Synara");

    attemptedUpstreamVersion = upstreamVersion;
    const upstreamRegistration = runAndValidateInstaller(
      runtime,
      upstreamInstaller,
      upstreamVersion,
      upstreamPaths,
      upstreamTargets,
      UPSTREAM_IDENTITY,
    );
    const installedUpstream = snapshotInstalledApplication(runtime, upstreamTargets, upstreamPaths);
    assertSentinelsUnchanged(upstreamSentinelSnapshot);

    if (previousInstaller && previousVersion) {
      attemptedSuperVersion = previousVersion;
      runAndValidateInstaller(
        runtime,
        previousInstaller,
        previousVersion,
        superPaths,
        superTargets,
        SUPER_IDENTITY,
      );
      assertSentinelsUnchanged(superSentinelSnapshot);
      assertInstalledApplicationUnchanged(
        runtime,
        upstreamTargets,
        upstreamPaths,
        installedUpstream,
        "Installed upstream Synara",
      );
    }

    attemptedSuperVersion = currentVersion;
    const currentRegistration = runAndValidateInstaller(
      runtime,
      currentInstaller,
      currentVersion,
      superPaths,
      superTargets,
      SUPER_IDENTITY,
    );
    assertSentinelsUnchanged(superSentinelSnapshot);
    assertInstalledApplicationUnchanged(
      runtime,
      upstreamTargets,
      upstreamPaths,
      installedUpstream,
      "Installed upstream Synara",
    );
    await runtime.verifyStartup({
      command: superPaths.executablePath,
      cwd: superPaths.installDirectory,
      env: superPaths.environment,
      logPath: superPaths.logPath,
      timeoutMs: options.startupTimeoutMs,
      description: "Installed Super Synara windows/x64",
    });
    assertSentinelsUnchanged(superSentinelSnapshot);
    assertInstalledApplicationUnchanged(
      runtime,
      upstreamTargets,
      upstreamPaths,
      installedUpstream,
      "Installed upstream Synara",
    );
    runtime.runCommand(currentRegistration.uninstallCommand);
    await waitForUninstallCleanup(
      runtime,
      superTargets,
      superPaths.installDirectory,
      SUPER_IDENTITY.displayName,
    );
    assertInstalledApplicationUnchanged(
      runtime,
      upstreamTargets,
      upstreamPaths,
      installedUpstream,
      "Installed upstream Synara",
    );
    runtime.runCommand(upstreamRegistration.uninstallCommand);
    await waitForUninstallCleanup(
      runtime,
      upstreamTargets,
      upstreamPaths.installDirectory,
      UPSTREAM_IDENTITY.displayName,
    );

    report = {
      schemaVersion: 1,
      platform: "windows-x64",
      currentVersion,
      upgrade: previousVersion ? "qualified" : "not-run-no-previous-release",
      previousVersion,
      sideBySide: {
        upstreamVersion,
        upstreamTag: `v${upstreamVersion}`,
        upstreamInstallerSha256,
        upstreamProductName: "Synara",
        upstreamExecutablePreserved: true,
        upstreamRegistrationPreserved: true,
        upstreamProfileSentinelsPreserved: true,
        upstreamUninstallCleanupProven: true,
      },
      isolation: {
        liveProfilesRead: false,
        liveProfilesMutated: false,
        upstreamRegistrationPreserved: true,
        upstreamSentinelsPreserved: true,
        superStateWasTemporary: true,
      },
      installation: {
        productName: "Super Synara",
        executableName: "Super Synara.exe",
        registrationScope: "current-user-64",
        startupProven: true,
        cleanExitProven: true,
        uninstallCleanupProven: true,
      },
    };
  } catch (error) {
    failures.push(error);
  }

  try {
    await cleanupAttemptedInstallation(
      runtime,
      superTargets,
      superPaths,
      attemptedSuperVersion,
      SUPER_IDENTITY,
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    await cleanupAttemptedInstallation(
      runtime,
      upstreamTargets,
      upstreamPaths,
      attemptedUpstreamVersion,
      UPSTREAM_IDENTITY,
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    assertSentinelsUnchanged(superSentinelSnapshot);
    assertSentinelsUnchanged(upstreamSentinelSnapshot);
    assertRegistrySnapshotsEqual(
      preexistingUpstreamRegistration,
      snapshotRegistry(runtime, upstreamTargets),
      "Upstream Synara",
    );
    assertRegistrySnapshotsEqual(
      preexistingSuperRegistration,
      snapshotRegistry(runtime, superTargets),
      "Super Synara",
    );
  } catch (error) {
    failures.push(error);
  }

  rmSync(root, { recursive: true, force: true });
  if (failures.length > 0) {
    throw new AggregateError(failures, "Super Synara Windows installer qualification failed.");
  }
  if (!report) throw new Error("Super Synara Windows installer qualification produced no report.");
  return report;
}
