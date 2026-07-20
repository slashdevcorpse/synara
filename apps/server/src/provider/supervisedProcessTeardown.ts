import { performance } from "node:perf_hooks";

import {
  defaultProcessTreeKiller,
  type CapturedProcess,
  type CapturedProcessTreeInspection,
  type ProcessTreeKiller,
  type TerminalKillSignal,
} from "../terminal/processTreeKiller";
import { Effect } from "effect";

const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_FORCE_EXIT_MS = 1_500;
const DEFAULT_POLL_MS = 25;

export interface SupervisedProcessTeardownInput {
  readonly rootPid: number;
  /** Must resolve only after the owned root process has emitted its terminal exit. */
  readonly rootExited: Promise<unknown>;
  readonly termGraceMs?: number;
  readonly forceExitMs?: number;
  readonly pollMs?: number;
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

  constructor(input: {
    readonly rootPid: number;
    readonly rootExited: boolean;
    readonly remainingDescendantPids: ReadonlyArray<number> | null;
    readonly captureComplete: boolean;
  }) {
    const descendantDetail =
      input.remainingDescendantPids === null
        ? "descendant state could not be verified"
        : input.remainingDescendantPids.length > 0
          ? `descendants still running: ${input.remainingDescendantPids.join(", ")}`
          : "no captured descendants remain";
    super(
      `Provider process tree ${input.rootPid} did not prove exit ` +
        `(rootExited=${String(input.rootExited)}, captureComplete=${String(input.captureComplete)}; ${descendantDetail}).`,
    );
    this.name = "ProviderProcessExitUnprovenError";
    this.rootPid = input.rootPid;
    this.rootExited = input.rootExited;
    this.remainingDescendantPids = input.remainingDescendantPids;
    this.captureComplete = input.captureComplete;
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
  });
}

export function teardownEffectProcessTree(
  process: EffectProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
): Promise<SupervisedProcessTeardownResult> {
  return teardownProcessTree({
    rootPid: Number(process.pid),
    rootExited: Effect.runPromise(Effect.exit(process.exitCode)),
  });
}

/**
 * Owns the complete provider process-tree stop sequence. Success means the exact root emitted exit
 * and every identity-matched descendant captured before TERM is gone; sending a signal is not
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
  const tree = await deps.processTreeKiller.capture(input.rootPid);
  captureFinished = true;
  // Flush a root-exit resolution queued in the same turn as capture completion.
  await Promise.resolve();
  const captureComplete = tree.captureComplete !== false && !rootExitedBeforeCaptureFinished;

  const signal = async (
    killSignal: TerminalKillSignal,
    includeRootTree: boolean,
  ): Promise<void> => {
    await deps.processTreeKiller.signal({
      rootPid: input.rootPid,
      signal: killSignal,
      tree,
      includeRootTree,
      onError: (error) => signalErrors.push(error),
    });
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
      if (
        rootExited &&
        captureComplete &&
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
  // PID may already identify an unrelated process. Signal only captured identities
  // and keep the result unproven because reparenting may have hidden descendants.
  await signal("SIGTERM", !rootExited);
  const graceful = await waitForExitProof(
    positiveDuration(input.termGraceMs, DEFAULT_TERM_GRACE_MS),
  );
  if (graceful.proven) {
    return { escalated: false, signalErrors };
  }

  // A root can exit while descendants ignore TERM and become reparented. Preserve the captured
  // identities and force only those descendants rather than re-signalling a potentially reused PID.
  await signal("SIGKILL", !rootExited);
  const forced = await waitForExitProof(positiveDuration(input.forceExitMs, DEFAULT_FORCE_EXIT_MS));
  if (forced.proven) {
    return { escalated: true, signalErrors };
  }

  throw new ProviderProcessExitUnprovenError({
    rootPid: input.rootPid,
    rootExited,
    remainingDescendantPids:
      forced.remainingDescendants?.map((descendant) => descendant.pid) ?? null,
    captureComplete,
  });
}
