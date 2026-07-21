import { performance } from "node:perf_hooks";

import {
  defaultProcessTreeKiller,
  type CapturedProcess,
  type CapturedProcessTreeInspection,
  type ProcessTreeKiller,
  type ProcessTreeDescendantExitProof,
  type ProcessTreeSignalResult,
  type TerminalKillSignal,
  WINDOWS_PROCESS_TREE_SIGNAL_TIMEOUT_MS,
} from "../terminal/processTreeKiller";
import { Effect } from "effect";
import { isWindowsJobContainedProviderProcess } from "./windowsProviderProcess.ts";

const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_FORCE_EXIT_MS = 1_500;
const DEFAULT_POLL_MS = 25;
const ROOT_TREE_SIGNAL_SETTLEMENT_SLACK_MS = 250;

export interface SupervisedProcessTeardownInput {
  readonly rootPid: number;
  /** Must resolve only after the owned root process has emitted its terminal exit. */
  readonly rootExited: Promise<unknown>;
  readonly termGraceMs?: number;
  readonly forceExitMs?: number;
  readonly pollMs?: number;
  /** Trusted spawn-time proof that Windows root-tree signaling replaces PID-based capture. */
  readonly descendantExitProof?: "root-tree-signal" | undefined;
}

export interface ProcessExitHandle {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
}

export interface EffectProcessExitHandle {
  readonly pid: number;
  readonly exitCode: Effect.Effect<unknown, unknown>;
}

export interface SupervisedProcessTeardownResult {
  readonly escalated: boolean;
  readonly signalErrors: ReadonlyArray<Error>;
}

export type ProviderProcessDescendantExitProof = ProcessTreeDescendantExitProof | "not-captured";

export interface SupervisedProcessTeardownDependencies {
  readonly processTreeKiller: ProcessTreeKiller;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export class ProviderProcessExitUnprovenError extends Error {
  readonly rootPid: number;
  readonly rootExited: boolean;
  readonly remainingDescendantPids: ReadonlyArray<number> | null;
  readonly captureComplete: boolean;
  readonly descendantExitProof: ProviderProcessDescendantExitProof;
  readonly rootTreeSignalSucceeded: boolean;

  constructor(input: {
    readonly rootPid: number;
    readonly rootExited: boolean;
    readonly remainingDescendantPids: ReadonlyArray<number> | null;
    readonly captureComplete: boolean;
    readonly descendantExitProof: ProviderProcessDescendantExitProof;
    readonly rootTreeSignalSucceeded: boolean;
  }) {
    const descendantDetail =
      input.remainingDescendantPids === null
        ? "descendant state could not be verified"
        : input.remainingDescendantPids.length > 0
          ? `descendants still running: ${input.remainingDescendantPids.join(", ")}`
          : "no captured descendants remain";
    super(
      `Provider process tree ${input.rootPid} did not prove exit ` +
        `(rootExited=${String(input.rootExited)}, captureComplete=${String(input.captureComplete)}, ` +
        `descendantExitProof=${input.descendantExitProof}, ` +
        `rootTreeSignalSucceeded=${String(input.rootTreeSignalSucceeded)}; ${descendantDetail}).`,
    );
    this.name = "ProviderProcessExitUnprovenError";
    this.rootPid = input.rootPid;
    this.rootExited = input.rootExited;
    this.remainingDescendantPids = input.remainingDescendantPids;
    this.captureComplete = input.captureComplete;
    this.descendantExitProof = input.descendantExitProof;
    this.rootTreeSignalSucceeded = input.rootTreeSignalSucceeded;
  }
}

const defaultDependencies: SupervisedProcessTeardownDependencies = {
  processTreeKiller: defaultProcessTreeKiller,
  now: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

const INSPECTION_TIMED_OUT = Symbol("inspection-timed-out");
const SIGNAL_TIMED_OUT = Symbol("signal-timed-out");

function isPromiseLike<T>(value: T | PromiseLike<T> | undefined): value is PromiseLike<T> {
  return value !== undefined && typeof (value as PromiseLike<T>).then === "function";
}

async function inspectBeforeDeadline(
  inspection: PromiseLike<CapturedProcessTreeInspection>,
  timeoutMs: number,
): Promise<CapturedProcessTreeInspection | typeof INSPECTION_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(inspection),
      new Promise<typeof INSPECTION_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(INSPECTION_TIMED_OUT), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function signalBeforeDeadline(
  signal: PromiseLike<ProcessTreeSignalResult>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<ProcessTreeSignalResult | typeof SIGNAL_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(signal),
      new Promise<typeof SIGNAL_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => {
          resolve(SIGNAL_TIMED_OUT);
          abortController.abort();
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function signalFailure(
  cause: unknown,
  input: {
    readonly rootPid: number;
    readonly signal: TerminalKillSignal;
  },
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Provider process tree ${input.rootPid} ${input.signal} signaling failed: ${detail}`,
    cause instanceof Error ? { cause } : undefined,
  );
}

function waitForOwnedProcessExit(process: ProcessExitHandle): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onExit = () => resolve();
    process.once("exit", onExit);
    if (process.exitCode !== null || process.signalCode !== null) {
      process.removeListener("exit", onExit);
      resolve();
    }
  });
}

export async function teardownChildProcessTree(
  process: ProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
): Promise<SupervisedProcessTeardownResult> {
  if (process.pid === undefined) {
    throw new Error("Cannot prove process exit because the spawned process has no PID.");
  }
  return teardownProcessTree({
    rootPid: process.pid,
    rootExited: waitForOwnedProcessExit(process),
    ...(isWindowsJobContainedProviderProcess(process)
      ? { descendantExitProof: "root-tree-signal" as const }
      : {}),
  });
}

export function teardownEffectProcessTree(
  process: EffectProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
): Promise<SupervisedProcessTeardownResult> {
  return teardownProcessTree({
    rootPid: Number(process.pid),
    rootExited: Effect.runPromise(Effect.exit(process.exitCode)),
    ...(isWindowsJobContainedProviderProcess(process)
      ? { descendantExitProof: "root-tree-signal" as const }
      : {}),
  });
}

/**
 * Owns the complete provider process-tree stop sequence. Success means the exact root emitted exit
 * and every identity-matched descendant captured before TERM is gone, or an explicitly marked
 * Windows launcher completed root-tree signaling and exited. Sending a signal alone is not
 * considered completion.
 */
export async function teardownProviderProcessTree(
  input: SupervisedProcessTeardownInput,
  dependencies: Partial<SupervisedProcessTeardownDependencies> = {},
): Promise<SupervisedProcessTeardownResult> {
  if (!Number.isInteger(input.rootPid) || input.rootPid <= 0) {
    throw new TypeError(
      `Provider process root PID must be a positive integer, got ${input.rootPid}.`,
    );
  }

  const deps = { ...defaultDependencies, ...dependencies };
  const signalErrors: Error[] = [];
  let rootExited = false;
  let captureFinished = false;
  let rootExitedBeforeCaptureFinished = false;
  let rootTreeSignalSucceeded = false;
  void input.rootExited.then(
    () => {
      rootExited = true;
      if (!captureFinished) {
        rootExitedBeforeCaptureFinished = true;
      }
    },
    () => {
      // A rejected watcher is not evidence that the owned process exited.
    },
  );

  const failUncapturedExit = (): never => {
    throw new ProviderProcessExitUnprovenError({
      rootPid: input.rootPid,
      rootExited: true,
      remainingDescendantPids: null,
      captureComplete: false,
      descendantExitProof: "not-captured",
      rootTreeSignalSucceeded: false,
    });
  };

  // Observe an already-settled exit before using the PID. Once the owned root is gone, that PID
  // may identify an unrelated process, so neither capture nor signaling is safe.
  await Promise.resolve();
  if (rootExited) failUncapturedExit();

  const capturedTree =
    input.descendantExitProof === "root-tree-signal"
      ? ({
          descendants: [],
          captureComplete: true,
          descendantExitProof: "root-tree-signal",
        } as const)
      : await deps.processTreeKiller.capture(input.rootPid);
  captureFinished = true;

  // An asynchronous process-table scan can overlap root exit. Flush an exit
  // resolution queued in the same turn as capture completion, then discard the
  // PID-keyed result if the owned root exited before capture finished.
  await Promise.resolve();
  if (rootExitedBeforeCaptureFinished) failUncapturedExit();

  const captureComplete = capturedTree.captureComplete !== false;
  const tree = capturedTree;

  const signal = async (
    killSignal: TerminalKillSignal,
    includeRootTree: boolean,
    timeoutMs: number,
  ): Promise<void> => {
    let acceptsCallbackErrors = true;
    const abortController = new AbortController();
    try {
      const signaling = Promise.resolve().then(() =>
        deps.processTreeKiller.signal({
          rootPid: input.rootPid,
          signal: killSignal,
          tree,
          includeRootTree,
          shouldSignalRootTree: () => !rootExited,
          abortSignal: abortController.signal,
          onError: (error) => {
            if (acceptsCallbackErrors) signalErrors.push(error);
          },
        }),
      );
      const outcome = await signalBeforeDeadline(signaling, timeoutMs, abortController);
      if (outcome === SIGNAL_TIMED_OUT) {
        signalErrors.push(
          new Error(
            `Provider process tree ${input.rootPid} ${killSignal} signaling did not settle within ${timeoutMs}ms.`,
          ),
        );
      } else {
        rootTreeSignalSucceeded ||= outcome.rootTreeSignalSucceeded;
      }
    } catch (cause) {
      signalErrors.push(signalFailure(cause, { rootPid: input.rootPid, signal: killSignal }));
    } finally {
      acceptsCallbackErrors = false;
    }
  };

  const waitForExitProof = async (timeoutMs: number) => {
    const deadline = deps.now() + timeoutMs;
    let remainingDescendants: ReadonlyArray<CapturedProcess> | null = null;
    do {
      // Flush a root-exit resolution caused synchronously by a signal test double.
      await Promise.resolve();
      const inspectionBudgetMs = deadline - deps.now();
      if (inspectionBudgetMs <= 0) break;
      let inspection: CapturedProcessTreeInspection | typeof INSPECTION_TIMED_OUT | undefined;
      try {
        const pendingInspection = deps.processTreeKiller.inspect?.(tree);
        inspection = isPromiseLike(pendingInspection)
          ? await inspectBeforeDeadline(pendingInspection, inspectionBudgetMs)
          : pendingInspection;
      } catch {
        inspection = undefined;
      }
      if (inspection === INSPECTION_TIMED_OUT) {
        return { proven: false as const, remainingDescendants: null };
      }
      remainingDescendants = inspection?.verified === true ? inspection.survivors : null;
      const requiredDescendantProofCompleted =
        tree.descendantExitProof !== "root-tree-signal" || rootTreeSignalSucceeded;
      if (
        rootExited &&
        captureComplete &&
        requiredDescendantProofCompleted &&
        remainingDescendants !== null &&
        remainingDescendants.length === 0
      ) {
        return { proven: true as const, remainingDescendants };
      }
      const remainingMs = deadline - deps.now();
      if (remainingMs <= 0) break;
      await deps.sleep(Math.min(positiveDuration(input.pollMs, DEFAULT_POLL_MS), remainingMs));
    } while (deps.now() <= deadline);
    return { proven: false as const, remainingDescendants };
  };

  // If the owned root exited while descendants were being captured, its numeric
  // PID may already identify an unrelated process. The untrusted capture was
  // discarded above; skip the root tree and keep the result unproven.
  const signalDeadlineMs = (exitWaitMs: number): number =>
    input.descendantExitProof === "root-tree-signal"
      ? Math.max(
          exitWaitMs,
          WINDOWS_PROCESS_TREE_SIGNAL_TIMEOUT_MS + ROOT_TREE_SIGNAL_SETTLEMENT_SLACK_MS,
        )
      : exitWaitMs;
  const termGraceMs = positiveDuration(input.termGraceMs, DEFAULT_TERM_GRACE_MS);
  await signal("SIGTERM", !rootExited, signalDeadlineMs(termGraceMs));
  const graceful = await waitForExitProof(termGraceMs);
  if (graceful.proven) {
    return { escalated: false, signalErrors };
  }

  // A root can exit while descendants ignore TERM and become reparented. Preserve the captured
  // identities and force only those descendants rather than re-signalling a potentially reused PID.
  const forceExitMs = positiveDuration(input.forceExitMs, DEFAULT_FORCE_EXIT_MS);
  await signal("SIGKILL", !rootExited, signalDeadlineMs(forceExitMs));
  const forced = await waitForExitProof(forceExitMs);
  if (forced.proven) {
    return { escalated: true, signalErrors };
  }

  throw new ProviderProcessExitUnprovenError({
    rootPid: input.rootPid,
    rootExited,
    remainingDescendantPids:
      forced.remainingDescendants?.map((descendant) => descendant.pid) ?? null,
    captureComplete,
    descendantExitProof: tree.descendantExitProof,
    rootTreeSignalSucceeded,
  });
}
