// FILE: windowsProviderProcess.ts
// Purpose: Routes Windows provider-only child launches through the atomic Job Object helper.
// Layer: Server provider process supervision

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import launcherConfig from "../../native/windows-job-launcher/launcher.config.json" with { type: "json" };

import {
  parseCanonicalWindowsNpmNodeShimTarget,
  windowsNpmPackageManifestDeclaresShimTarget,
} from "@synara/shared/windowsNpmShim";
import {
  createWindowsCommandDiscoveryCache,
  isWindowsBatchCommand,
  prepareResolvedWindowsSafeProcess,
  prepareWindowsSafeProcess,
  resolveWindowsCommandCandidates,
  resolveWindowsCommandCandidatesAsync,
  resolveWindowsCommandPath,
  resolveWindowsCommandPathAsync,
  type WindowsAsyncCommandDiscoveryInput,
  type WindowsCommandDiscoveryOutcome,
  type WindowsSafeProcessCommand,
} from "@synara/shared/windowsProcess";

const WINDOWS_JOB_PREPARED_COMMAND = Symbol("synara.windowsJobPreparedCommand");
const WINDOWS_JOB_CONTROL_FILE = Symbol("synara.windowsJobControlFile");
const MAX_WINDOWS_PROVIDER_SHIM_BYTES = 64 * 1024;

export interface WindowsJobPreparedCommand extends WindowsSafeProcessCommand {
  readonly [WINDOWS_JOB_PREPARED_COMMAND]: true;
  readonly [WINDOWS_JOB_CONTROL_FILE]: string;
}

export const WINDOWS_JOB_LAUNCHER_ENV = "SYNARA_WINDOWS_JOB_LAUNCHER_PATH";
export const WINDOWS_JOB_LAUNCHER_EXECUTABLE = launcherConfig.executableName;
export const WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION = launcherConfig.protocolVersion;

export interface WindowsProviderProcessInput extends WindowsAsyncCommandDiscoveryInput {
  readonly arch?: NodeJS.Architecture | undefined;
  readonly launcherPath?: string | undefined;
  readonly fileExists?: ((path: string) => boolean) | undefined;
  readonly readFileString?: ((path: string) => string | undefined) | undefined;
  readonly realPath?: ((path: string) => string | undefined) | undefined;
  readonly controlDirectory?: string | undefined;
  /**
   * Cache-only mode is reserved for a synchronously constrained callback after
   * an asynchronous provider preparer has populated the exact supplied cache.
   * A cache miss fails closed without invoking an OS-level synchronous lookup.
   */
  readonly commandDiscoveryMode?: "default" | "cache-only" | undefined;
}

export class WindowsProviderTargetNotResolvedError extends Error {
  readonly command: string;
  readonly discoveryOutcome: WindowsCommandDiscoveryOutcome | undefined;

  constructor(command: string, discoveryOutcome?: WindowsCommandDiscoveryOutcome) {
    super(
      `Windows provider target '${command}' was not resolved to an absolute executable path; containment refuses PATH/CWD fallback.`,
    );
    this.name = "WindowsProviderTargetNotResolvedError";
    this.command = command;
    this.discoveryOutcome = discoveryOutcome;
  }
}

export type WindowsProviderBatchShimLaunchFailure =
  | "shim_not_file"
  | "shim_not_canonical_npm_node"
  | "package_manifest_not_file"
  | "package_manifest_bin_mismatch"
  | "target_not_file"
  | "target_outside_node_modules"
  | "target_outside_package"
  | "native_node_not_found";

export class WindowsProviderBatchShimLaunchError extends Error {
  readonly command: string;
  readonly reason: WindowsProviderBatchShimLaunchFailure;
  readonly discoveryOutcome: WindowsCommandDiscoveryOutcome | undefined;

  constructor(
    command: string,
    reason: WindowsProviderBatchShimLaunchFailure,
    discoveryOutcome?: WindowsCommandDiscoveryOutcome,
  ) {
    const detail = {
      shim_not_file: "the resolved batch shim is missing or cannot be verified as a file",
      shim_not_canonical_npm_node:
        "the batch file is not one of npm's canonical Node shim templates",
      package_manifest_not_file:
        "the npm package manifest referenced by the shim is missing or not a file",
      package_manifest_bin_mismatch:
        "the npm package manifest does not declare this shim name and exact target",
      target_not_file: "the npm package target referenced by the shim is missing or not a file",
      target_outside_node_modules:
        "the npm package target does not remain inside the shim's canonical node_modules tree",
      target_outside_package:
        "the npm package target does not remain inside the package declared by the shim",
      native_node_not_found:
        "no verified native node.exe or node.com was found beside the shim or on PATH",
    } satisfies Record<WindowsProviderBatchShimLaunchFailure, string>;
    super(
      `Windows provider batch shim '${command}' cannot be launched without cmd.exe: ${detail[reason]}. Reinstall the provider CLI with npm or configure a native provider executable.`,
    );
    this.name = "WindowsProviderBatchShimLaunchError";
    this.command = command;
    this.reason = reason;
    this.discoveryOutcome = discoveryOutcome;
  }
}

export class WindowsProviderShellLaunchError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(
      `Windows provider command '${command}' cannot be launched through cmd.exe or a raw batch file. Configure a native provider executable or reinstall a canonical npm provider shim.`,
    );
    this.name = "WindowsProviderShellLaunchError";
    this.command = command;
  }
}

export function isWindowsJobPreparedCommand(
  command: WindowsSafeProcessCommand,
): command is WindowsJobPreparedCommand {
  return (command as Partial<WindowsJobPreparedCommand>)[WINDOWS_JOB_PREPARED_COMMAND] === true;
}

export function windowsJobControlFilePath(command: WindowsJobPreparedCommand): string {
  return command[WINDOWS_JOB_CONTROL_FILE];
}

function markWindowsJobPreparedCommand(
  command: WindowsSafeProcessCommand,
  controlFilePath: string,
): WindowsJobPreparedCommand {
  Object.defineProperty(command, WINDOWS_JOB_PREPARED_COMMAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  Object.defineProperty(command, WINDOWS_JOB_CONTROL_FILE, {
    configurable: false,
    enumerable: false,
    value: controlFilePath,
    writable: false,
  });
  return command as WindowsJobPreparedCommand;
}

function defaultFileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultReadFileString(path: string): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_WINDOWS_PROVIDER_SHIM_BYTES) {
      return undefined;
    }
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultRealPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveRuntimeDirectory(): string {
  return Path.dirname(fileURLToPath(import.meta.url));
}

function resolveLauncherCandidate(candidate: string): string {
  return /^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith("\\\\")
    ? Path.win32.normalize(candidate)
    : Path.resolve(candidate);
}

export function resolveWindowsJobLauncherPath(input: WindowsProviderProcessInput = {}): string {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("The Windows Job launcher is only available on Windows.");
  }
  const arch = input.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Windows provider containment does not support architecture '${arch}'.`);
  }

  const runtimeDirectory = resolveRuntimeDirectory();
  const explicitPath =
    readNonEmpty(input.launcherPath) ??
    readNonEmpty(input.env?.[WINDOWS_JOB_LAUNCHER_ENV]) ??
    readNonEmpty(process.env[WINDOWS_JOB_LAUNCHER_ENV]);
  const candidates = explicitPath
    ? [explicitPath]
    : [
        // Bundled CLI: import.meta.url is apps/server/dist/index.mjs.
        Path.join(runtimeDirectory, "native", `win32-${arch}`, WINDOWS_JOB_LAUNCHER_EXECUTABLE),
        // Source/dev: import.meta.url is apps/server/src/provider/windowsProviderProcess.ts.
        Path.resolve(
          runtimeDirectory,
          "..",
          "..",
          "native",
          "windows-job-launcher",
          "out",
          `win32-${arch}`,
          WINDOWS_JOB_LAUNCHER_EXECUTABLE,
        ),
      ];
  const fileExists = input.fileExists ?? defaultFileExists;
  for (const candidate of candidates) {
    const resolved = resolveLauncherCandidate(candidate);
    if (fileExists(resolved)) {
      return resolved;
    }
  }

  throw new Error(
    [
      `Windows provider containment helper is required for win32-${arch} but was not found.`,
      `Checked: ${candidates.map(resolveLauncherCandidate).join(", ")}.`,
      "Build it with: node apps/server/scripts/build-windows-job-launcher.mjs --arch " + arch,
      `Packaged desktop builds must set ${WINDOWS_JOB_LAUNCHER_ENV} to their signed extraFile.`,
      "Refusing to fall back to a post-spawn, racy process-tree capture.",
    ].join(" "),
  );
}

function resolveAbsolutePreparedCommand(command: string, cwd: string | undefined): string {
  if (/^[A-Za-z]:[\\/]/u.test(command) || command.startsWith("\\\\")) {
    return Path.win32.normalize(command);
  }
  if (/^[\\/](?![\\/])/u.test(command)) {
    const baseDirectory = cwd ?? process.cwd();
    const baseRoot = Path.win32.parse(baseDirectory).root;
    if (!/^[A-Za-z]:[\\/]$/u.test(baseRoot) && !baseRoot.startsWith("\\\\")) {
      throw new Error(
        `Windows provider target '${command}' is drive-rooted but no absolute Windows cwd was available to qualify it.`,
      );
    }
    return Path.win32.resolve(baseDirectory, command);
  }
  if (/[\\/]/.test(command)) {
    return Path.win32.resolve(cwd ?? process.cwd(), command);
  }
  throw new WindowsProviderTargetNotResolvedError(command);
}

function isAbsoluteNativeWindowsExecutable(path: string): boolean {
  return (
    Path.win32.isAbsolute(path) && [".exe", ".com"].includes(Path.win32.extname(path).toLowerCase())
  );
}

function normalizedWindowsPathIdentity(path: string): string {
  return Path.win32.normalize(path).toLowerCase();
}

function windowsPathIsWithinRoot(path: string, root: string): boolean {
  const relative = Path.win32.relative(root, path);
  return (
    relative === "" ||
    (!Path.win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..\\`))
  );
}

function verifiedRealFile(path: string, input: WindowsProviderProcessInput): string | undefined {
  const fileExists = input.fileExists ?? defaultFileExists;
  if (!fileExists(path)) {
    return undefined;
  }
  const canonicalPath = (input.realPath ?? defaultRealPath)(path);
  if (!canonicalPath || !Path.win32.isAbsolute(canonicalPath) || !fileExists(canonicalPath)) {
    return undefined;
  }
  return Path.win32.normalize(canonicalPath);
}

interface CanonicalWindowsNpmShim {
  readonly canonicalTargetPath: string;
  readonly nativeSiblingNodePath?: string | undefined;
}

function inspectCanonicalWindowsNpmShim(
  command: string,
  input: WindowsProviderProcessInput,
  discoveryOutcome?: WindowsCommandDiscoveryOutcome,
): CanonicalWindowsNpmShim {
  const fail = (reason: WindowsProviderBatchShimLaunchFailure): never => {
    throw new WindowsProviderBatchShimLaunchError(command, reason, discoveryOutcome);
  };
  const canonicalShimPath = verifiedRealFile(command, input);
  const shimDirectory = Path.win32.dirname(command);
  const canonicalShimDirectory = (input.realPath ?? defaultRealPath)(shimDirectory);
  if (
    !canonicalShimPath ||
    !canonicalShimDirectory ||
    !Path.win32.isAbsolute(canonicalShimDirectory) ||
    normalizedWindowsPathIdentity(Path.win32.dirname(canonicalShimPath)) !==
      normalizedWindowsPathIdentity(canonicalShimDirectory)
  ) {
    return fail("shim_not_file");
  }

  let shimContents: string | undefined;
  try {
    shimContents = (input.readFileString ?? defaultReadFileString)(command);
  } catch {
    shimContents = undefined;
  }
  const shimTarget = shimContents ? parseCanonicalWindowsNpmNodeShimTarget(shimContents) : null;
  if (!shimTarget) {
    return fail("shim_not_canonical_npm_node");
  }

  const visiblePackageDirectory = Path.win32.join(
    shimDirectory,
    ...shimTarget.relativePackageRoot.split("/"),
  );
  const canonicalPackageDirectory = (input.realPath ?? defaultRealPath)(visiblePackageDirectory);
  const visiblePackageManifestPath = Path.win32.join(visiblePackageDirectory, "package.json");
  const canonicalPackageManifestPath = verifiedRealFile(visiblePackageManifestPath, input);
  if (
    !canonicalPackageDirectory ||
    !Path.win32.isAbsolute(canonicalPackageDirectory) ||
    !canonicalPackageManifestPath ||
    !windowsPathIsWithinRoot(canonicalPackageManifestPath, canonicalPackageDirectory)
  ) {
    return fail("package_manifest_not_file");
  }
  let packageManifestContents: string | undefined;
  try {
    packageManifestContents = (input.readFileString ?? defaultReadFileString)(
      canonicalPackageManifestPath,
    );
  } catch {
    packageManifestContents = undefined;
  }
  if (
    !packageManifestContents ||
    !windowsNpmPackageManifestDeclaresShimTarget({
      target: shimTarget,
      shimName: Path.win32.basename(canonicalShimPath),
      manifestContents: packageManifestContents,
    })
  ) {
    return fail("package_manifest_bin_mismatch");
  }

  const visibleTargetPath = Path.win32.join(shimDirectory, ...shimTarget.relativeTarget.split("/"));
  const canonicalTargetPath = verifiedRealFile(visibleTargetPath, input);
  if (!canonicalTargetPath) {
    return fail("target_not_file");
  }
  const visibleNodeModulesDirectory = Path.win32.join(shimDirectory, "node_modules");
  const canonicalNodeModulesDirectory = (input.realPath ?? defaultRealPath)(
    visibleNodeModulesDirectory,
  );
  if (
    !canonicalNodeModulesDirectory ||
    !Path.win32.isAbsolute(canonicalNodeModulesDirectory) ||
    !windowsPathIsWithinRoot(canonicalTargetPath, canonicalNodeModulesDirectory)
  ) {
    return fail("target_outside_node_modules");
  }
  if (!windowsPathIsWithinRoot(canonicalTargetPath, canonicalPackageDirectory)) {
    return fail("target_outside_package");
  }

  const siblingNodePath = Path.win32.join(shimDirectory, "node.exe");
  const nativeSiblingNodePath = verifiedRealFile(siblingNodePath, input);
  return {
    canonicalTargetPath,
    ...(nativeSiblingNodePath && isAbsoluteNativeWindowsExecutable(nativeSiblingNodePath)
      ? { nativeSiblingNodePath }
      : {}),
  };
}

function prepareDirectWindowsNpmShimProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput,
  discoveryOutcome?: WindowsCommandDiscoveryOutcome,
): WindowsSafeProcessCommand {
  const shim = inspectCanonicalWindowsNpmShim(command, input, discoveryOutcome);
  let nativeNodePath = shim.nativeSiblingNodePath;
  if (!nativeNodePath || !isAbsoluteNativeWindowsExecutable(nativeNodePath)) {
    const resolvedNodeCandidates = resolveWindowsCommandCandidates("node", {
      ...input,
      // Provider discovery observations describe the requested provider
      // command. Do not overwrite them with this internal runtime lookup.
      onCommandDiscovery: undefined,
    });
    nativeNodePath = resolvedNodeCandidates
      .map((candidate) => verifiedRealFile(candidate, input))
      .find(
        (candidate): candidate is string =>
          candidate !== undefined && isAbsoluteNativeWindowsExecutable(candidate),
      );
  }
  if (!nativeNodePath || !isAbsoluteNativeWindowsExecutable(nativeNodePath)) {
    throw new WindowsProviderBatchShimLaunchError(
      command,
      "native_node_not_found",
      discoveryOutcome,
    );
  }

  return {
    command: nativeNodePath,
    args: [shim.canonicalTargetPath, ...args],
    shell: false,
    windowsHide: true,
  };
}

function prepareResolvedWindowsProviderTarget(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput,
  discoveryOutcome?: WindowsCommandDiscoveryOutcome,
): WindowsSafeProcessCommand {
  const platform = input.platform ?? process.platform;
  if (platform === "win32" && isWindowsBatchCommand(command)) {
    return prepareDirectWindowsNpmShimProcess(
      resolveAbsolutePreparedCommand(command, input.cwd),
      args,
      input,
      discoveryOutcome,
    );
  }
  return prepareResolvedWindowsSafeProcess(command, args, input);
}

export function containPreparedWindowsProviderProcess(
  prepared: WindowsSafeProcessCommand,
  input: WindowsProviderProcessInput = {},
): WindowsSafeProcessCommand {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return prepared;
  }

  const target = resolveAbsolutePreparedCommand(prepared.command, input.cwd);
  const targetExtension = Path.win32.extname(target).toLowerCase();
  const targetName = Path.win32.basename(target).toLowerCase();
  if (
    prepared.windowsVerbatimArguments === true ||
    targetExtension === ".cmd" ||
    targetExtension === ".bat" ||
    targetName === "cmd.exe" ||
    targetName === "cmd.com"
  ) {
    throw new WindowsProviderShellLaunchError(target);
  }

  const launcherPath = resolveWindowsJobLauncherPath(input);
  const controlDirectory = input.controlDirectory ?? OS.tmpdir();
  const controlFilePath = Path.win32.join(
    controlDirectory,
    `synara-job-control-${process.pid}-${randomUUID()}.signal`,
  );
  return markWindowsJobPreparedCommand(
    {
      command: launcherPath,
      args: [
        "--protocol",
        WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
        "--argument-mode",
        "argv",
        "--control-file",
        controlFilePath,
        "--",
        target,
        ...prepared.args,
      ],
      shell: false,
      windowsHide: true,
    },
    controlFilePath,
  );
}

const preventColdSynchronousWindowsProviderDiscovery: NonNullable<
  WindowsProviderProcessInput["spawnSync"]
> = () => ({
  error: new Error(
    "Cold synchronous Windows provider command discovery is disabled; asynchronously prewarm the exact discovery cache first.",
  ),
  stdout: "",
  status: null,
});

function applyWindowsProviderDiscoveryMode(
  input: WindowsProviderProcessInput,
): WindowsProviderProcessInput {
  return input.commandDiscoveryMode === "cache-only"
    ? {
        ...input,
        spawnSync: preventColdSynchronousWindowsProviderDiscovery,
      }
    : input;
}

export function prepareWindowsProviderProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput = {},
): WindowsSafeProcessCommand {
  const effectiveInput = applyWindowsProviderDiscoveryMode(input);
  let discoveryOutcome: WindowsCommandDiscoveryOutcome | undefined;
  const observedInput = {
    ...effectiveInput,
    onCommandDiscovery: (observation) => {
      discoveryOutcome = observation.outcome;
      input.onCommandDiscovery?.(observation);
    },
  } satisfies WindowsProviderProcessInput;
  const platform = effectiveInput.platform ?? process.platform;
  const prepared =
    platform === "win32"
      ? prepareResolvedWindowsProviderTarget(
          resolveWindowsCommandPath(command, observedInput),
          args,
          effectiveInput,
          discoveryOutcome,
        )
      : prepareWindowsSafeProcess(command, args, observedInput);
  try {
    return containPreparedWindowsProviderProcess(prepared, effectiveInput);
  } catch (cause) {
    if (cause instanceof WindowsProviderTargetNotResolvedError && discoveryOutcome !== undefined) {
      throw new WindowsProviderTargetNotResolvedError(cause.command, discoveryOutcome);
    }
    throw cause;
  }
}

async function prepareResolvedWindowsProviderProcessWithAsyncRuntime(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput,
  discoveryOutcome?: WindowsCommandDiscoveryOutcome,
): Promise<WindowsSafeProcessCommand> {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return prepareResolvedWindowsSafeProcess(command, args, input);
  }

  const commandDiscoveryCache = input.commandDiscoveryCache ?? createWindowsCommandDiscoveryCache();
  const observedInput = {
    ...input,
    commandDiscoveryCache,
  } satisfies WindowsProviderProcessInput;

  if (isWindowsBatchCommand(command)) {
    const absoluteCommand = resolveAbsolutePreparedCommand(command, input.cwd);
    const shim = inspectCanonicalWindowsNpmShim(absoluteCommand, observedInput, discoveryOutcome);
    if (!shim.nativeSiblingNodePath && input.commandDiscoveryMode !== "cache-only") {
      await resolveWindowsCommandCandidatesAsync("node", {
        ...observedInput,
        // The provider command is already resolved. Internal runtime lookup
        // must not publish a replacement provider discovery observation.
        onCommandDiscovery: undefined,
      });
    }
  }

  const cacheOnlyInput = applyWindowsProviderDiscoveryMode({
    ...input,
    commandDiscoveryCache,
    commandDiscoveryMode: "cache-only",
    // Runtime lookup is internal to an already-resolved provider command.
    onCommandDiscovery: undefined,
  });
  try {
    return containPreparedWindowsProviderProcess(
      prepareResolvedWindowsProviderTarget(command, args, cacheOnlyInput, discoveryOutcome),
      cacheOnlyInput,
    );
  } catch (cause) {
    if (cause instanceof WindowsProviderTargetNotResolvedError && discoveryOutcome !== undefined) {
      throw new WindowsProviderTargetNotResolvedError(cause.command, discoveryOutcome);
    }
    throw cause;
  }
}

/**
 * Resolves provider commands without blocking the JavaScript isolate. Every
 * Windows launch gets an isolated discovery cache unless the caller supplies
 * one explicitly for an exact handoff to a synchronously constrained callback.
 * Canonical npm shims prewarm their native Node lookup asynchronously, then the
 * final cache-only preparation fails closed if any unexpected sync lookup
 * would otherwise occur.
 */
export async function prepareWindowsProviderProcessAsync(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput = {},
): Promise<WindowsSafeProcessCommand> {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return prepareWindowsSafeProcess(command, args, input);
  }

  const commandDiscoveryCache = input.commandDiscoveryCache ?? createWindowsCommandDiscoveryCache();
  let discoveryOutcome: WindowsCommandDiscoveryOutcome | undefined;
  const observedInput = {
    ...input,
    commandDiscoveryCache,
    onCommandDiscovery: (observation) => {
      discoveryOutcome = observation.outcome;
      input.onCommandDiscovery?.(observation);
    },
  } satisfies WindowsProviderProcessInput;
  const resolvedCommand = await resolveWindowsCommandPathAsync(command, observedInput);

  return prepareResolvedWindowsProviderProcessWithAsyncRuntime(
    resolvedCommand,
    args,
    observedInput,
    discoveryOutcome,
  );
}

/**
 * Prepares an already-resolved provider command without re-running provider
 * discovery. Canonical npm shims may still prewarm their native Node runtime
 * asynchronously before cache-only containment.
 */
export async function prepareResolvedWindowsProviderProcessAsync(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput = {},
): Promise<WindowsSafeProcessCommand> {
  return prepareResolvedWindowsProviderProcessWithAsyncRuntime(command, args, input);
}

export function prepareResolvedWindowsProviderProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput = {},
): WindowsSafeProcessCommand {
  const effectiveInput = applyWindowsProviderDiscoveryMode(input);
  return containPreparedWindowsProviderProcess(
    prepareResolvedWindowsProviderTarget(command, args, effectiveInput),
    effectiveInput,
  );
}
