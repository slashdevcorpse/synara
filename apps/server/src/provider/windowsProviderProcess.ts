// FILE: windowsProviderProcess.ts
// Purpose: Routes Windows provider-only child launches through the atomic Job Object helper.
// Layer: Server provider process supervision

import { randomUUID } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import launcherConfig from "../../native/windows-job-launcher/launcher.config.json" with { type: "json" };

import {
  prepareResolvedWindowsSafeProcess,
  prepareWindowsSafeProcess,
  type WindowsSafeProcessCommand,
  type WindowsSafeProcessInput,
} from "@synara/shared/windowsProcess";

export const WINDOWS_JOB_LAUNCHER_ENV = "SYNARA_WINDOWS_JOB_LAUNCHER_PATH";
export const WINDOWS_JOB_LAUNCHER_EXECUTABLE = launcherConfig.executableName;
export const WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION = launcherConfig.protocolVersion;
/** Parent-side allowance for the native launcher's 30-second Job-empty proof deadline. */
export const WINDOWS_JOB_EMPTY_PROOF_TIMEOUT_MS = 31_000;

export interface WindowsProviderProcessInput extends WindowsSafeProcessInput {
  readonly arch?: NodeJS.Architecture | undefined;
  readonly launcherPath?: string | undefined;
  readonly fileExists?: ((path: string) => boolean) | undefined;
  readonly completionReceipt?: "create" | WindowsJobCompletionReceipt | undefined;
  readonly windowsJobName?: string | undefined;
}

export interface WindowsJobCompletionReceipt {
  readonly path: string;
  readonly token: string;
}

export interface WindowsProviderProcessCommand extends WindowsSafeProcessCommand {
  /** Present only when the returned command is the native kill-on-close Job Object launcher. */
  readonly containment?: "windows-job-object" | undefined;
  /** Present only when a supervised launch requires proof that the native Job became empty. */
  readonly completionReceipt?: WindowsJobCompletionReceipt | undefined;
  /** Optional named Job used for collision rejection; never used as a termination capability. */
  readonly windowsJobName?: string | undefined;
  /** Unguessable event owned by this exact launcher and used as its termination capability. */
  readonly windowsTerminationEventName?: string | undefined;
}

export interface WindowsJobTerminationCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface WindowsJobContainedProcessState {
  readonly completionReceipt: WindowsJobCompletionReceipt | undefined;
  readonly terminationCommand: WindowsJobTerminationCommand | undefined;
  readonly launcherPid: number | undefined;
  launcherExited: boolean;
  cachedExitProof: boolean | undefined;
  receiptCleanupAttempts: number;
  receiptCleanupComplete: boolean;
  receiptCleanupTimer: ReturnType<typeof setTimeout> | undefined;
}

const windowsJobContainedProcesses = new WeakMap<object, WindowsJobContainedProcessState>();

function createWindowsJobCompletionReceipt(): WindowsJobCompletionReceipt {
  const token = randomUUID();
  return {
    path: Path.join(tmpdir(), `synara-windows-job-${token}.receipt`),
    token,
  };
}

/**
 * Records the exact spawned handle whose PID belongs to the native Job Object launcher.
 * Teardown uses this identity marker instead of inferring containment from platform or filename.
 */
export function markWindowsProviderProcessSpawn<T extends object>(
  process: T,
  prepared: WindowsProviderProcessCommand,
  spawnedPreparedCommand: boolean,
): T {
  if (spawnedPreparedCommand && prepared.containment === "windows-job-object") {
    const pid = "pid" in process ? process.pid : undefined;
    const launcherPid =
      typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    windowsJobContainedProcesses.set(process, {
      completionReceipt: prepared.completionReceipt,
      terminationCommand:
        prepared.windowsTerminationEventName === undefined || launcherPid === undefined
          ? undefined
          : {
              command: prepared.command,
              args: [
                "--protocol",
                WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
                "--signal-termination-event",
                prepared.windowsTerminationEventName,
                "--launcher-pid",
                String(launcherPid),
              ],
            },
      launcherPid,
      launcherExited:
        process instanceof ChildProcess &&
        (process.exitCode !== null || process.signalCode !== null),
      cachedExitProof: undefined,
      receiptCleanupAttempts: 0,
      receiptCleanupComplete: prepared.completionReceipt === undefined,
      receiptCleanupTimer: undefined,
    });
    if (process instanceof ChildProcess) {
      const cacheExitProof = () => {
        recordWindowsProviderProcessExit(process);
      };
      process.once("exit", cacheExitProof);
      if (process.exitCode !== null || process.signalCode !== null) {
        process.removeListener("exit", cacheExitProof);
        cacheExitProof();
      }
    }
  }
  return process;
}

export function isWindowsJobContainedProviderProcess(process: object): boolean {
  return windowsJobContainedProcesses.has(process);
}

const WINDOWS_JOB_RECEIPT_CLEANUP_RETRY_DELAYS_MS = [100, 500, 2_000] as const;

function removeWindowsJobCompletionReceipt(state: WindowsJobContainedProcessState): void {
  const receipt = state.completionReceipt;
  if (!receipt || state.receiptCleanupComplete) return;

  try {
    unlinkSync(receipt.path);
    state.receiptCleanupComplete = true;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      state.receiptCleanupComplete = true;
      return;
    }
    if (state.receiptCleanupTimer !== undefined) return;
    const retryDelay = WINDOWS_JOB_RECEIPT_CLEANUP_RETRY_DELAYS_MS[state.receiptCleanupAttempts];
    if (retryDelay === undefined) return;
    state.receiptCleanupAttempts += 1;
    state.receiptCleanupTimer = setTimeout(() => {
      state.receiptCleanupTimer = undefined;
      removeWindowsJobCompletionReceipt(state);
    }, retryDelay);
    state.receiptCleanupTimer.unref?.();
  }
}

/**
 * Reads and unlinks the one-shot receipt while retaining its result for a later teardown owner.
 * Real Node child handles call this automatically on exit so successful short-lived commands do
 * not leave receipts in the system temp directory.
 */
export function cacheWindowsJobEmptyExitProof(process: object): boolean {
  const state = windowsJobContainedProcesses.get(process);
  if (!state) return false;
  if (state.cachedExitProof !== undefined) {
    removeWindowsJobCompletionReceipt(state);
    return state.cachedExitProof;
  }
  if (!state.launcherExited || state.launcherPid === undefined) return false;

  const receipt = state.completionReceipt;
  if (!receipt) {
    state.cachedExitProof = false;
    return false;
  }

  let proven = false;
  try {
    proven = readFileSync(receipt.path, "utf8") === `${receipt.token}\n${state.launcherPid}\n`;
  } catch {
    proven = false;
  }
  state.cachedExitProof = proven;
  removeWindowsJobCompletionReceipt(state);
  return proven;
}

/** Records that an exact non-Node launcher owner observed exit, then caches its receipt. */
export function recordWindowsProviderProcessExit(process: object): boolean {
  const state = windowsJobContainedProcesses.get(process);
  if (!state) return false;
  state.launcherExited = true;
  return cacheWindowsJobEmptyExitProof(process);
}

/** Returns the cached or on-disk proof after the teardown owner observes launcher exit. */
export function consumeWindowsJobEmptyExitProof(process: object): boolean {
  return cacheWindowsJobEmptyExitProof(process);
}

/** Non-Windows/uncontained exits need no launcher proof; contained exits require a valid receipt. */
export function isWindowsProviderProcessExitProven(process: object): boolean {
  return !isWindowsJobContainedProviderProcess(process) || cacheWindowsJobEmptyExitProof(process);
}

/** Returns a fail-closed error only for a contained launcher exit without Job-empty proof. */
export function windowsProviderProcessExitProofError(process: object): Error | undefined {
  return isWindowsProviderProcessExitProven(process)
    ? undefined
    : new Error(
        "Windows provider launcher exited without proving that its Job reached zero active processes.",
      );
}

export function prepareWindowsJobTerminationCommand(
  process: object,
): WindowsJobTerminationCommand | undefined {
  return windowsJobContainedProcesses.get(process)?.terminationCommand;
}

/** Signals the exact owner launcher to terminate its own proof-bearing Job. */
export function requestWindowsJobTermination(
  process: object,
  abortSignal?: AbortSignal,
): Promise<void> {
  const termination = prepareWindowsJobTerminationCommand(process);
  if (!termination) {
    return Promise.reject(new Error("Windows Job termination metadata is unavailable."));
  }

  return new Promise<void>((resolve, reject) => {
    const helper = spawn(termination.command, termination.args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener("abort", onAbort);
      helper.removeListener("error", onError);
      helper.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      helper.kill();
      finish(new Error("Windows Job termination request was aborted."));
    };
    const onError = (cause: Error) => finish(cause);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        finish();
      } else {
        finish(
          new Error(
            `Windows Job termination helper exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
          ),
        );
      }
    };
    helper.once("error", onError);
    helper.once("exit", onExit);
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultFileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
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
  throw new Error(
    `Windows provider target '${command}' was not resolved to an absolute executable path; containment refuses PATH/CWD fallback.`,
  );
}

export function containPreparedWindowsProviderProcess(
  prepared: WindowsSafeProcessCommand,
  input: WindowsProviderProcessInput = {},
): WindowsProviderProcessCommand {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return prepared;
  }

  const launcherPath = resolveWindowsJobLauncherPath(input);
  const target = resolveAbsolutePreparedCommand(prepared.command, input.cwd);
  const argumentMode = prepared.windowsVerbatimArguments ? "verbatim" : "argv";
  const completionReceipt =
    input.completionReceipt === "create"
      ? createWindowsJobCompletionReceipt()
      : input.completionReceipt;
  const windowsJobName = completionReceipt
    ? (input.windowsJobName ?? `synara-windows-job-${randomUUID()}`)
    : undefined;
  const windowsTerminationEventName = completionReceipt
    ? `synara-windows-job-termination-${randomUUID()}`
    : undefined;
  if (
    windowsJobName &&
    (windowsJobName.length > 128 || !/^[A-Za-z0-9._-]+$/u.test(windowsJobName))
  ) {
    throw new Error(
      "Windows Job names must contain 1-128 ASCII letters, digits, dots, underscores, or hyphens.",
    );
  }
  return {
    command: launcherPath,
    args: [
      "--protocol",
      WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
      "--argument-mode",
      argumentMode,
      ...(completionReceipt
        ? [
            "--job-name",
            windowsJobName!,
            "--termination-event",
            windowsTerminationEventName!,
            "--completion-receipt",
            completionReceipt.path,
            "--receipt-token",
            completionReceipt.token,
          ]
        : []),
      "--",
      target,
      ...prepared.args,
    ],
    shell: false,
    windowsHide: true,
    containment: "windows-job-object",
    ...(completionReceipt ? { completionReceipt } : {}),
    ...(windowsJobName ? { windowsJobName } : {}),
    ...(windowsTerminationEventName ? { windowsTerminationEventName } : {}),
  };
}

export function prepareWindowsProviderProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput = {},
): WindowsProviderProcessCommand {
  return containPreparedWindowsProviderProcess(
    prepareWindowsSafeProcess(command, args, input),
    input,
  );
}

export function prepareResolvedWindowsProviderProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput = {},
): WindowsProviderProcessCommand {
  return containPreparedWindowsProviderProcess(
    prepareResolvedWindowsSafeProcess(command, args, input),
    input,
  );
}
