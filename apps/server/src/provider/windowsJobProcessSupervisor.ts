// FILE: windowsJobProcessSupervisor.ts
// Purpose: Makes the retained Windows launcher handle the sole owner of Job-contained providers.
// Layer: Server provider process supervision

import type { ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";

import type { WindowsSafeProcessCommand } from "@synara/shared/windowsProcess";
import { Effect } from "effect";

import type { ProcessTreeKiller } from "../terminal/processTreeKiller.ts";
import {
  ProviderProcessExitUnprovenError,
  teardownChildProcessTree,
  superviseEffectProcessTree,
  type EffectProcessExitHandle,
  type EffectProcessTreeSupervisor,
  type SupervisedProcessTeardownResult,
} from "./supervisedProcessTeardown.ts";
import {
  isWindowsJobPreparedCommand,
  windowsJobControlFilePath,
} from "./windowsProviderProcess.ts";

const NATIVE_WINDOWS_JOB_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_WINDOWS_JOB_EXIT_TIMEOUT_MS = NATIVE_WINDOWS_JOB_DRAIN_TIMEOUT_MS + 2_000;
const scheduleTimeout = setTimeout;
const cancelTimeout = clearTimeout;

export class WindowsJobProcessExitUnprovenError extends ProviderProcessExitUnprovenError {
  override readonly cause: unknown;

  constructor(rootPid: number, cause: unknown) {
    super({
      rootPid,
      rootExited: false,
      remainingDescendantPids: null,
      captureComplete: false,
    });
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.name = "WindowsJobProcessExitUnprovenError";
    this.message = `Windows Job wrapper ${rootPid} did not prove complete drain. ${detail}`;
    this.cause = cause;
  }
}

function asWindowsJobExitUnprovenError(rootPid: number, cause: unknown): Error {
  return cause instanceof ProviderProcessExitUnprovenError
    ? cause
    : new WindowsJobProcessExitUnprovenError(rootPid, cause);
}

export interface WindowsJobEffectProcessHandle extends EffectProcessExitHandle {
  readonly isRunning: Effect.Effect<boolean, unknown>;
  readonly synaraTerminateExact?: (() => boolean) | undefined;
}

export interface NodeProviderProcessSupervisor {
  readonly rootPid: number;
  readonly proveExit: () => Promise<SupervisedProcessTeardownResult>;
  readonly requestTermination: (signal?: number | NodeJS.Signals) => boolean;
  readonly teardown: () => Promise<SupervisedProcessTeardownResult>;
}

export type WindowsJobNodeProcessSupervisor = NodeProviderProcessSupervisor;

export type PreparedProcessSupervisorInstallation<Supervisor> =
  | {
      readonly _tag: "Installed";
      readonly supervisor: Supervisor;
    }
  | {
      readonly _tag: "Recovered";
      readonly supervisor: Supervisor;
      readonly requestedSupervisorFailure: unknown;
    };

export class PreparedProcessSupervisorFallbackError extends AggregateError {
  readonly supervisorKind: "Effect" | "Node";
  readonly requestedSupervisorFailure: unknown;
  readonly fallbackSupervisorFailure: unknown;

  constructor(input: {
    readonly supervisorKind: "Effect" | "Node";
    readonly requestedSupervisorFailure: unknown;
    readonly fallbackSupervisorFailure: unknown;
  }) {
    super(
      [input.requestedSupervisorFailure, input.fallbackSupervisorFailure],
      `Injected ${input.supervisorKind} process supervisor construction failed and the default prepared-command fallback could not establish ownership.`,
    );
    this.name = "PreparedProcessSupervisorFallbackError";
    this.supervisorKind = input.supervisorKind;
    this.requestedSupervisorFailure = input.requestedSupervisorFailure;
    this.fallbackSupervisorFailure = input.fallbackSupervisorFailure;
  }
}

export type NodeProviderProcessSpawnOutcome =
  | {
      readonly _tag: "Spawned";
      readonly rootPid: number;
    }
  | {
      readonly _tag: "FailedToSpawn";
      readonly cause: Error;
    }
  | {
      readonly _tag: "Unidentified";
      readonly cause: Error;
    };

export interface SupervisePreparedEffectProcessOptions extends WindowsJobStopRequestOptions {
  readonly platform?: NodeJS.Platform;
  readonly processTreeKiller?: ProcessTreeKiller;
  readonly teardownProcessTree?: Parameters<
    typeof superviseEffectProcessTree
  >[1]["teardownProcessTree"];
  readonly ownedProcessGroupId?: number;
  readonly windowsExitTimeoutMs?: number;
}

export interface WindowsJobStopRequestOptions {
  readonly exitTimeoutMs?: number;
  readonly requestStop?: ((controlFilePath: string) => Promise<void>) | undefined;
  readonly verifyExit?: ((controlFilePath: string) => Promise<void>) | undefined;
}

const nodeProcessSupervisors = new WeakMap<ChildProcess, WindowsJobNodeProcessSupervisor>();

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_WINDOWS_JOB_EXIT_TIMEOUT_MS;
}

async function beforeTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = scheduleTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) cancelTimeout(timeout);
  }
}

function successfulProof(escalated: boolean): SupervisedProcessTeardownResult {
  return { escalated, signalErrors: [] };
}

async function requestWindowsJobStop(controlFilePath: string): Promise<void> {
  try {
    await writeFile(controlFilePath, "stop\n", { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw cause;
  }
}

async function removeFileIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw cause;
  }
}

async function verifyWindowsJobDrain(controlFilePath: string): Promise<void> {
  const acknowledgementPath = `${controlFilePath}.drained`;
  const acknowledgement = await readFile(acknowledgementPath, "utf8");
  if (acknowledgement !== "drained\n") {
    throw new Error(`Invalid Windows Job drain acknowledgement at ${acknowledgementPath}.`);
  }
  await removeFileIfPresent(controlFilePath);
  await unlink(acknowledgementPath);
}

async function bestEffortCleanupCompromisedProof(controlFilePath: string): Promise<void> {
  await Promise.all(
    [controlFilePath, `${controlFilePath}.drained`, `${controlFilePath}.drained.tmp`].map(
      async (path) => {
        try {
          await removeFileIfPresent(path);
        } catch {
          // Emergency termination has already made proof unavailable; cleanup cannot restore it.
        }
      },
    ),
  );
}

function removeFileIfPresentSync(path: string): void {
  try {
    unlinkSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw cause;
  }
}

export function finalizeSynchronousWindowsJobExit(
  prepared: WindowsSafeProcessCommand,
  options: { readonly proofRequired?: boolean } = {},
): void {
  if (!isWindowsJobPreparedCommand(prepared)) return;
  const controlFilePath = windowsJobControlFilePath(prepared);
  const acknowledgementPath = `${controlFilePath}.drained`;
  let proofFailure: unknown;
  try {
    const acknowledgement = readFileSync(acknowledgementPath, "utf8");
    if (acknowledgement !== "drained\n") {
      throw new Error(`Invalid Windows Job drain acknowledgement at ${acknowledgementPath}.`);
    }
  } catch (cause) {
    proofFailure = cause;
  }

  const cleanupFailures: unknown[] = [];
  for (const path of [controlFilePath, acknowledgementPath, `${acknowledgementPath}.tmp`]) {
    try {
      removeFileIfPresentSync(path);
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  const missingProofWasAllowed =
    options.proofRequired === false &&
    (proofFailure as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const failures = [
    ...(proofFailure === undefined || missingProofWasAllowed ? [] : [proofFailure]),
    ...cleanupFailures,
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Windows Job synchronous proof finalization failed.");
  }
}

async function runEffectBeforeTimeout<A>(
  effect: Effect.Effect<A, unknown>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<A> {
  const abortController = new AbortController();
  try {
    return await beforeTimeout(
      Effect.runPromise(effect, { signal: abortController.signal }),
      timeoutMs,
      timeoutMessage,
    );
  } finally {
    abortController.abort();
  }
}

export function superviseWindowsJobEffectProcess(
  prepared: WindowsSafeProcessCommand,
  process: WindowsJobEffectProcessHandle,
  options: WindowsJobStopRequestOptions = {},
): EffectProcessTreeSupervisor {
  if (!isWindowsJobPreparedCommand(prepared)) {
    throw new Error("Exact Windows Job supervision requires a Job-prepared provider command.");
  }
  const terminateExact = process.synaraTerminateExact;
  if (typeof terminateExact !== "function") {
    throw new Error("Windows Job wrapper is missing exact native-handle termination support.");
  }
  const rootPid = Number(process.pid);
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    throw new TypeError(`Windows Job wrapper PID must be a positive integer, got ${rootPid}.`);
  }
  const exitTimeoutMs = positiveTimeout(options.exitTimeoutMs);
  const controlFilePath = windowsJobControlFilePath(prepared);
  const requestStop = options.requestStop ?? requestWindowsJobStop;
  const verifyExit = options.verifyExit ?? verifyWindowsJobDrain;
  let proofCompromised: Error | undefined;
  const assertProofAvailable = (): void => {
    if (proofCompromised) throw proofCompromised;
  };
  const compromiseProof = (): void => {
    proofCompromised ??= new Error(
      `Windows Job wrapper ${rootPid} drain proof is permanently unavailable after emergency exact termination.`,
    );
  };
  let exitPromise: Promise<void> | null = null;
  const awaitExit = (): Promise<void> => {
    if (exitPromise === null) {
      const attempt = runEffectBeforeTimeout(
        process.exitCode.pipe(Effect.exit, Effect.asVoid),
        exitTimeoutMs,
        `Timed out waiting for Windows Job wrapper ${rootPid} to exit.`,
      );
      exitPromise = attempt;
      void attempt.catch(() => {
        if (exitPromise === attempt) exitPromise = null;
      });
    }
    return exitPromise;
  };
  const readRunning = () =>
    runEffectBeforeTimeout(
      process.isRunning,
      exitTimeoutMs,
      `Timed out checking whether Windows Job wrapper ${rootPid} is running.`,
    );
  let stopRequestPromise: Promise<void> | null = null;
  const requestControlledStop = (): Promise<void> => {
    if (stopRequestPromise === null) {
      const attempt = beforeTimeout(
        requestStop(controlFilePath),
        exitTimeoutMs,
        `Timed out requesting controlled stop for Windows Job wrapper ${rootPid}.`,
      );
      stopRequestPromise = attempt;
      void attempt.catch(() => {
        if (stopRequestPromise === attempt) stopRequestPromise = null;
      });
    }
    return stopRequestPromise;
  };
  let proofPromise: Promise<void> | null = null;
  const verifyDrainProof = (): Promise<void> => {
    assertProofAvailable();
    if (proofPromise === null) {
      const attempt = beforeTimeout(
        verifyExit(controlFilePath),
        exitTimeoutMs,
        `Timed out verifying drain proof for Windows Job wrapper ${rootPid}.`,
      );
      proofPromise = attempt;
      void attempt.catch(() => {
        if (proofPromise === attempt) proofPromise = null;
      });
    }
    return proofPromise;
  };
  const proveExit = async (): Promise<SupervisedProcessTeardownResult> => {
    try {
      assertProofAvailable();
      await awaitExit();
      assertProofAvailable();
      if (await readRunning()) {
        throw new Error(`Windows Job wrapper ${rootPid} still reports running.`);
      }
      assertProofAvailable();
      await verifyDrainProof();
      assertProofAvailable();
      return successfulProof(false);
    } catch (cause) {
      throw asWindowsJobExitUnprovenError(rootPid, cause);
    }
  };
  let teardownPromise: Promise<SupervisedProcessTeardownResult> | null = null;
  const teardown = (): Promise<SupervisedProcessTeardownResult> => {
    if (teardownPromise === null) {
      const attempt = (async () => {
        let wasRunning = false;
        try {
          assertProofAvailable();
          wasRunning = await readRunning();
          if (wasRunning) await requestControlledStop();
          await awaitExit();
          if (await readRunning()) {
            throw new Error(`Windows Job wrapper ${rootPid} still reports running.`);
          }
          assertProofAvailable();
          await verifyDrainProof();
          assertProofAvailable();
          return successfulProof(wasRunning);
        } catch (cause) {
          // The retained native handle is an emergency containment fallback only. Its asynchronous
          // Job close cannot satisfy the file-unlock proof, so preserve the original failure.
          let shouldTerminate = true;
          try {
            shouldTerminate = await readRunning();
          } catch {
            // Liveness uncertainty still requires emergency containment.
          }
          if (shouldTerminate) {
            try {
              if (terminateExact()) {
                compromiseProof();
                try {
                  await awaitExit();
                } catch {
                  // Cleanup remains best effort after accepted emergency termination.
                }
                await bestEffortCleanupCompromisedProof(controlFilePath);
              }
            } catch {
              // The primary proof failure remains authoritative.
            }
          }
          throw asWindowsJobExitUnprovenError(rootPid, cause);
        }
      })();
      teardownPromise = attempt;
      void attempt.catch(() => {
        if (teardownPromise === attempt) teardownPromise = null;
      });
    }
    return teardownPromise;
  };
  return {
    rootPid,
    waitForInitialCapture: () => Promise.resolve(),
    captureNow: () => Promise.resolve(),
    proveExit,
    teardown,
  };
}

export function supervisePreparedEffectProcess(
  prepared: WindowsSafeProcessCommand,
  process: WindowsJobEffectProcessHandle,
  options: SupervisePreparedEffectProcessOptions = {},
): EffectProcessTreeSupervisor {
  const platform = options.platform ?? globalThis.process.platform;
  if (isWindowsJobPreparedCommand(prepared)) {
    return superviseWindowsJobEffectProcess(prepared, process, {
      ...(options.windowsExitTimeoutMs === undefined
        ? {}
        : { exitTimeoutMs: options.windowsExitTimeoutMs }),
      ...(options.requestStop ? { requestStop: options.requestStop } : {}),
      ...(options.verifyExit ? { verifyExit: options.verifyExit } : {}),
    });
  }
  if (platform === "win32") {
    throw new Error(
      "Windows provider process was spawned without Job-prepared command provenance.",
    );
  }
  return superviseEffectProcessTree(process, {
    platform,
    ...(options.processTreeKiller ? { processTreeKiller: options.processTreeKiller } : {}),
    ...(options.teardownProcessTree ? { teardownProcessTree: options.teardownProcessTree } : {}),
    ...(options.ownedProcessGroupId === undefined
      ? {}
      : { ownedProcessGroupId: options.ownedProcessGroupId }),
  });
}

function nodeProcessExited(process: ChildProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

function waitForNodeProcessExit(process: ChildProcess): Promise<void> {
  if (nodeProcessExited(process)) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => resolve();
    process.once("exit", onExit);
    if (nodeProcessExited(process)) {
      process.removeListener("exit", onExit);
      resolve();
    }
  });
}

/**
 * Installs the error/close listeners needed to classify a PID-less Node spawn without inventing a
 * process identity. Call this immediately after `spawn`, before any synchronous supervisor factory.
 */
export function observeNodeProviderProcessSpawn(
  process: ChildProcess,
): Promise<NodeProviderProcessSpawnOutcome> {
  const initialRootPid = Number(process.pid);
  if (Number.isInteger(initialRootPid) && initialRootPid > 0) {
    return Promise.resolve({ _tag: "Spawned", rootPid: initialRootPid });
  }

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      process.removeListener("spawn", onSpawn);
      process.removeListener("error", onError);
      process.removeListener("close", onClose);
    };
    const finish = (outcome: NodeProviderProcessSpawnOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const onSpawn = () => {
      const rootPid = Number(process.pid);
      if (Number.isInteger(rootPid) && rootPid > 0) {
        finish({ _tag: "Spawned", rootPid });
      }
    };
    const onError = (cause: Error) => {
      finish({ _tag: "FailedToSpawn", cause });
    };
    const onClose = () => {
      finish({
        _tag: "Unidentified",
        cause: new Error("Provider process closed without establishing a positive root PID."),
      });
    };

    process.once("spawn", onSpawn);
    process.once("error", onError);
    process.once("close", onClose);

    // A successful spawn can become observable between the initial PID read and listener setup.
    const rootPid = Number(process.pid);
    if (Number.isInteger(rootPid) && rootPid > 0) {
      finish({ _tag: "Spawned", rootPid });
    }
  });
}

export function superviseWindowsJobNodeProcess(
  prepared: WindowsSafeProcessCommand,
  process: ChildProcess,
  options: WindowsJobStopRequestOptions = {},
): WindowsJobNodeProcessSupervisor {
  if (!isWindowsJobPreparedCommand(prepared)) {
    throw new Error("Exact Windows Job supervision requires a Job-prepared provider command.");
  }
  const existing = nodeProcessSupervisors.get(process);
  if (existing) return existing;
  const rootPid = Number(process.pid);
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    throw new TypeError(`Windows Job wrapper PID must be a positive integer, got ${rootPid}.`);
  }
  const exitTimeoutMs = positiveTimeout(options.exitTimeoutMs);
  const controlFilePath = windowsJobControlFilePath(prepared);
  const requestStop = options.requestStop ?? requestWindowsJobStop;
  const verifyExit = options.verifyExit ?? verifyWindowsJobDrain;
  const terminateExact = process.kill.bind(process);
  let proofCompromised: Error | undefined;
  const assertProofAvailable = (): void => {
    if (proofCompromised) throw proofCompromised;
  };
  const compromiseProof = (): void => {
    proofCompromised ??= new Error(
      `Windows Job wrapper ${rootPid} drain proof is permanently unavailable after emergency exact termination.`,
    );
  };
  let stopRequestPromise: Promise<void> | null = null;
  const requestControlledStop = (): Promise<void> => {
    if (stopRequestPromise === null) {
      const attempt = beforeTimeout(
        requestStop(controlFilePath),
        exitTimeoutMs,
        `Timed out requesting controlled stop for Windows Job wrapper ${rootPid}.`,
      );
      stopRequestPromise = attempt;
      void attempt.catch(() => {
        if (stopRequestPromise === attempt) stopRequestPromise = null;
      });
    }
    return stopRequestPromise;
  };
  const requestTermination = (signal?: number | NodeJS.Signals): boolean => {
    if (signal === 0) return terminateExact(0);
    if (nodeProcessExited(process)) return false;
    void requestControlledStop().catch(() => undefined);
    Reflect.set(process, "killed", true);
    return true;
  };
  const exitPromise = waitForNodeProcessExit(process);
  const awaitExit = () =>
    beforeTimeout(
      exitPromise,
      exitTimeoutMs,
      `Timed out waiting for Windows Job wrapper ${rootPid} to exit.`,
    );
  let proofPromise: Promise<void> | null = null;
  const verifyDrainProof = (): Promise<void> => {
    assertProofAvailable();
    if (proofPromise === null) {
      const attempt = beforeTimeout(
        verifyExit(controlFilePath),
        exitTimeoutMs,
        `Timed out verifying drain proof for Windows Job wrapper ${rootPid}.`,
      );
      proofPromise = attempt;
      void attempt.catch(() => {
        if (proofPromise === attempt) proofPromise = null;
      });
    }
    return proofPromise;
  };
  const proveExit = async (): Promise<SupervisedProcessTeardownResult> => {
    try {
      assertProofAvailable();
      await awaitExit();
      assertProofAvailable();
      if (!nodeProcessExited(process)) {
        throw new Error(`Windows Job wrapper ${rootPid} still reports running.`);
      }
      await verifyDrainProof();
      assertProofAvailable();
      return successfulProof(false);
    } catch (cause) {
      throw asWindowsJobExitUnprovenError(rootPid, cause);
    }
  };
  let teardownPromise: Promise<SupervisedProcessTeardownResult> | null = null;
  const teardown = (): Promise<SupervisedProcessTeardownResult> => {
    if (teardownPromise === null) {
      const attempt = (async () => {
        let wasRunning = false;
        try {
          assertProofAvailable();
          wasRunning = !nodeProcessExited(process);
          if (wasRunning) {
            await requestControlledStop();
          }
          await awaitExit();
          if (!nodeProcessExited(process)) {
            throw new Error(`Windows Job wrapper ${rootPid} still reports running.`);
          }
          assertProofAvailable();
          await verifyDrainProof();
          assertProofAvailable();
          return successfulProof(wasRunning);
        } catch (cause) {
          if (!nodeProcessExited(process)) {
            try {
              if (terminateExact()) {
                compromiseProof();
                try {
                  await awaitExit();
                } catch {
                  // Cleanup remains best effort after accepted emergency termination.
                }
                await bestEffortCleanupCompromisedProof(controlFilePath);
              }
            } catch {
              // The primary proof failure remains authoritative.
            }
          }
          throw asWindowsJobExitUnprovenError(rootPid, cause);
        }
      })();
      teardownPromise = attempt;
      void attempt.catch(() => {
        if (teardownPromise === attempt) teardownPromise = null;
      });
    }
    return teardownPromise;
  };
  const supervisor = { rootPid, proveExit, requestTermination, teardown };
  nodeProcessSupervisors.set(process, supervisor);
  process.kill = requestTermination as ChildProcess["kill"];
  return supervisor;
}

export function supervisePreparedNodeProcess(
  prepared: WindowsSafeProcessCommand,
  process: ChildProcess,
  options: SupervisePreparedEffectProcessOptions = {},
): NodeProviderProcessSupervisor {
  if (isWindowsJobPreparedCommand(prepared)) {
    return superviseWindowsJobNodeProcess(prepared, process, options);
  }
  const platform = options.platform ?? globalThis.process.platform;
  if (platform === "win32") {
    throw new Error(
      "Windows provider process was spawned without Job-prepared command provenance.",
    );
  }
  const existing = nodeProcessSupervisors.get(process);
  if (existing) return existing;
  const rootPid = Number(process.pid);
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    throw new TypeError(`Provider process PID must be a positive integer, got ${rootPid}.`);
  }
  if (options.ownedProcessGroupId === undefined) {
    const terminateExact = process.kill.bind(process);
    const teardownProcessTree = options.teardownProcessTree;
    let successfulTeardown: SupervisedProcessTeardownResult | undefined;
    let teardownPromise: Promise<SupervisedProcessTeardownResult> | null = null;
    const teardown = (): Promise<SupervisedProcessTeardownResult> => {
      if (successfulTeardown !== undefined) return Promise.resolve(successfulTeardown);
      if (teardownPromise === null) {
        const attempt = (
          teardownProcessTree
            ? teardownChildProcessTree(process, teardownProcessTree)
            : teardownChildProcessTree(process)
        ).then((result) => {
          successfulTeardown = result;
          return result;
        });
        teardownPromise = attempt;
        void attempt.catch(() => {
          if (teardownPromise === attempt) teardownPromise = null;
        });
      }
      return teardownPromise;
    };
    const proveExit = async (): Promise<SupervisedProcessTeardownResult> => {
      if (successfulTeardown !== undefined) return successfulTeardown;
      await waitForNodeProcessExit(process);
      return teardown();
    };
    const supervisor: NodeProviderProcessSupervisor = {
      rootPid,
      proveExit,
      teardown,
      requestTermination: (signal) => terminateExact(signal),
    };
    nodeProcessSupervisors.set(process, supervisor);
    return supervisor;
  }
  const processTreeSupervisor = superviseEffectProcessTree(
    {
      pid: rootPid,
      exitCode: Effect.promise(() => waitForNodeProcessExit(process)),
      isRunning: Effect.sync(() => !nodeProcessExited(process)),
    },
    {
      platform,
      ...(options.processTreeKiller ? { processTreeKiller: options.processTreeKiller } : {}),
      ...(options.teardownProcessTree ? { teardownProcessTree: options.teardownProcessTree } : {}),
      ownedProcessGroupId: options.ownedProcessGroupId,
    },
  );
  const terminateExact = process.kill.bind(process);
  const supervisor: NodeProviderProcessSupervisor = {
    rootPid,
    proveExit: processTreeSupervisor.proveExit,
    teardown: processTreeSupervisor.teardown,
    requestTermination: (signal) => terminateExact(signal),
  };
  nodeProcessSupervisors.set(process, supervisor);
  return supervisor;
}

function installPreparedProcessSupervisor<Supervisor>(input: {
  readonly supervisorKind: "Effect" | "Node";
  readonly requestedIsDefault: boolean;
  readonly constructRequested: () => Supervisor;
  readonly constructFallback: () => Supervisor;
}): PreparedProcessSupervisorInstallation<Supervisor> {
  try {
    return { _tag: "Installed", supervisor: input.constructRequested() };
  } catch (requestedSupervisorFailure) {
    if (input.requestedIsDefault) throw requestedSupervisorFailure;
    try {
      return {
        _tag: "Recovered",
        supervisor: input.constructFallback(),
        requestedSupervisorFailure,
      };
    } catch (fallbackSupervisorFailure) {
      throw new PreparedProcessSupervisorFallbackError({
        supervisorKind: input.supervisorKind,
        requestedSupervisorFailure,
        fallbackSupervisorFailure,
      });
    }
  }
}

/**
 * Recovers an injected Effect supervisor construction failure with the default prepared-command
 * owner. Callers must publish the returned owner before surfacing a `Recovered` failure.
 */
export function installPreparedEffectProcessSupervisor(
  prepared: WindowsSafeProcessCommand,
  process: WindowsJobEffectProcessHandle,
  options: SupervisePreparedEffectProcessOptions = {},
  superviseProcess?: typeof supervisePreparedEffectProcess,
): PreparedProcessSupervisorInstallation<EffectProcessTreeSupervisor> {
  const requestedSupervisor = superviseProcess ?? supervisePreparedEffectProcess;
  return installPreparedProcessSupervisor({
    supervisorKind: "Effect",
    requestedIsDefault: requestedSupervisor === supervisePreparedEffectProcess,
    constructRequested: () => requestedSupervisor(prepared, process, options),
    constructFallback: () => supervisePreparedEffectProcess(prepared, process, options),
  });
}

/**
 * Recovers an injected Node supervisor construction failure with the default prepared-command
 * owner. Callers must publish the returned owner before surfacing a `Recovered` failure.
 */
export function installPreparedNodeProcessSupervisor(
  prepared: WindowsSafeProcessCommand,
  process: ChildProcess,
  options: SupervisePreparedEffectProcessOptions = {},
  superviseProcess?: typeof supervisePreparedNodeProcess,
): PreparedProcessSupervisorInstallation<NodeProviderProcessSupervisor> {
  const requestedSupervisor = superviseProcess ?? supervisePreparedNodeProcess;
  return installPreparedProcessSupervisor({
    supervisorKind: "Node",
    requestedIsDefault: requestedSupervisor === supervisePreparedNodeProcess,
    constructRequested: () => requestedSupervisor(prepared, process, options),
    constructFallback: () => supervisePreparedNodeProcess(prepared, process, options),
  });
}

export function nodeProviderProcessSupervisor(
  process: ChildProcess,
): NodeProviderProcessSupervisor | undefined {
  return nodeProcessSupervisors.get(process);
}

export const windowsJobNodeProcessSupervisor = nodeProviderProcessSupervisor;

export async function teardownNodeProviderProcess(
  process: ChildProcess,
  fallback: () => Promise<unknown>,
): Promise<unknown> {
  const supervisor = nodeProviderProcessSupervisor(process);
  return supervisor ? supervisor.teardown() : fallback();
}
