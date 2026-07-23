import { performance } from "node:perf_hooks";

import {
  defaultProcessTreeKiller,
  type CapturedProcess,
  type CapturedProcessTree,
  type CapturedProcessTreeInspection,
  type ProcessTreeKiller,
  type TerminalKillSignal,
} from "../terminal/processTreeKiller";
import { Effect } from "effect";

const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_FORCE_EXIT_MS = 1_500;
const DEFAULT_POLL_MS = 25;
const DEFAULT_CAPTURE_POLL_MS = 100;
// Keep the real task-boundary primitive even when Vitest installs fake timers after module load.
// Root-exit proof needs a task turn (not a fixed microtask count) to drain deeply wrapped promises.
const scheduleNextTask = setImmediate;

export interface SupervisedProcessTeardownInput {
  readonly rootPid: number;
  /** Must resolve only after the owned root process has emitted its terminal exit. */
  readonly rootExited: Promise<unknown>;
  /** Stable POSIX ownership boundary retained even if the detached root exits before capture. */
  readonly ownedProcessGroupId?: number;
  /** Optional identities captured while the root was alive. */
  readonly capturedTree?: CapturedProcessTree;
  /** Refreshes the additive ownership set after TERM or before escalation. */
  readonly refreshCapturedTree?: (() => Promise<CapturedProcessTree>) | undefined;
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
  /** Handle-owned liveness proof used to distinguish signal exit from a broken exit watcher. */
  readonly isRunning?: Effect.Effect<boolean, unknown>;
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

export interface EffectProcessTreeSupervisorOptions {
  readonly processTreeKiller?: ProcessTreeKiller;
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
  /** Required on POSIX: the isolated process group owned by the spawned updater. */
  readonly ownedProcessGroupId?: number;
  readonly platform?: NodeJS.Platform;
  /** Delay before one bounded post-spawn ownership refresh. This is not a polling interval. */
  readonly capturePollMs?: number;
  readonly proofTimeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface EffectProcessTreeSupervisor {
  readonly rootPid: number;
  /** Resolves only after the initial live-root ownership snapshot is complete. */
  readonly waitForInitialCapture: () => Promise<void>;
  /** Refreshes owned identities immediately, normally just before cooperative shutdown. */
  readonly captureNow: () => Promise<void>;
  /** Proves normal root exit and absence of every descendant captured while it was alive. */
  readonly proveExit: () => Promise<SupervisedProcessTeardownResult>;
  /** Terminates and proves exit using the same live-captured process identities. */
  readonly teardown: () => Promise<SupervisedProcessTeardownResult>;
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

/**
 * Finds an unproven provider-process exit through the error wrappers used by
 * adapters, finalizers, and concurrent teardown aggregation.
 */
export function findProviderProcessExitUnprovenError(
  error: unknown,
): ProviderProcessExitUnprovenError | null {
  const seen = new Set<object>();

  const visit = (candidate: unknown): ProviderProcessExitUnprovenError | null => {
    if (candidate instanceof ProviderProcessExitUnprovenError) {
      return candidate;
    }
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) {
      return null;
    }
    seen.add(candidate);

    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors) {
        const match = visit(nested);
        if (match !== null) return match;
      }
    }

    try {
      if ("failures" in candidate) {
        const failures = (candidate as { readonly failures?: unknown }).failures;
        if (Array.isArray(failures)) {
          for (const failure of failures) {
            const match = visit(failure);
            if (match !== null) return match;
          }
        }
      }
    } catch {
      // Continue with the conventional cause link when a custom failures getter is unusable.
    }

    try {
      return "cause" in candidate ? visit((candidate as { readonly cause?: unknown }).cause) : null;
    } catch {
      return null;
    }
  };

  return visit(error);
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
  signal: PromiseLike<void>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<void | typeof SIGNAL_TIMED_OUT> {
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
  });
}

export function teardownEffectProcessTree(
  process: EffectProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
  options: { readonly ownedProcessGroupId?: number } = {},
): Promise<SupervisedProcessTeardownResult> {
  return teardownProcessTree({
    rootPid: Number(process.pid),
    rootExited: awaitEffectProcessExit(process),
    ...options,
  });
}

function awaitEffectProcessExit(process: EffectProcessExitHandle): Promise<void> {
  return Effect.runPromise(
    process.exitCode.pipe(
      Effect.asVoid,
      Effect.catchCause((exitCause) =>
        process.isRunning === undefined
          ? Effect.failCause(exitCause)
          : process.isRunning.pipe(
              Effect.flatMap((isRunning) =>
                isRunning ? Effect.failCause(exitCause) : Effect.void,
              ),
            ),
      ),
    ),
  );
}

function capturedProcessKey(process: CapturedProcess): string {
  return `${process.pid}:${process.identity ?? process.command}`;
}

/**
 * Captures ownership immediately after spawn and once more after a short startup delay. Callers
 * refresh on demand before shutdown; no per-session background process-table polling is retained.
 */
export function superviseEffectProcessTree(
  process: EffectProcessExitHandle,
  options: EffectProcessTreeSupervisorOptions = {},
): EffectProcessTreeSupervisor {
  const rootPid = Number(process.pid);
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    throw new TypeError(`Provider process root PID must be a positive integer, got ${rootPid}.`);
  }

  const processTreeKiller = options.processTreeKiller ?? defaultProcessTreeKiller;
  const teardownProcessTree =
    options.teardownProcessTree ??
    ((input: SupervisedProcessTeardownInput) =>
      teardownProviderProcessTree(input, { processTreeKiller }));
  const platform = options.platform ?? globalThis.process.platform;
  const hasStableOwnedProcessGroup =
    platform !== "win32" && options.ownedProcessGroupId !== undefined;
  const now = options.now ?? defaultDependencies.now;
  const sleep = options.sleep ?? defaultDependencies.sleep;
  const capturePollMs = positiveDuration(options.capturePollMs, DEFAULT_CAPTURE_POLL_MS);
  const proofTimeoutMs = positiveDuration(options.proofTimeoutMs, DEFAULT_TERM_GRACE_MS);
  const descendants = new Map<string, CapturedProcess>();
  let root: CapturedProcess | undefined;
  let captureComplete = true;
  let initialFastRootDrainEligible = false;
  let ownedProcessGroupDrainProven = false;
  let rootSettled = false;
  let monitorStopped = false;
  let resolveMonitorStop: (() => void) | undefined;
  const monitorStop = new Promise<void>((resolve) => {
    resolveMonitorStop = resolve;
  });

  if (platform !== "win32" && options.ownedProcessGroupId === undefined) {
    // Once a POSIX parent exits its children can be reparented between snapshots. An isolated
    // process group is the only stable enumeration boundary available to this supervisor.
    captureComplete = false;
  }

  const captureOptions =
    options.ownedProcessGroupId !== undefined
      ? { processGroupId: options.ownedProcessGroupId }
      : undefined;
  const captureOwnedTreeAsync = (): Promise<CapturedProcessTree> =>
    Promise.resolve().then(
      () =>
        processTreeKiller.captureAsync?.(rootPid, captureOptions) ??
        processTreeKiller.capture(rootPid, captureOptions),
    );

  const mergeCapture = (
    tree: CapturedProcessTree,
    requireLiveRoot: boolean,
    ownedRootCanAuthorizeCapture: boolean,
  ): void => {
    if (tree.captureComplete === false || (requireLiveRoot && tree.root === undefined)) {
      captureComplete = false;
    }
    const capturedRootMatchesOwned =
      tree.root !== undefined &&
      tree.root.identity !== undefined &&
      root?.identity !== undefined &&
      capturedProcessKey(root) === capturedProcessKey(tree.root);
    const hasNewDescendant = tree.descendants.some(
      (descendant) =>
        descendant.identity === undefined || !descendants.has(capturedProcessKey(descendant)),
    );
    const hasStableRootMismatch =
      tree.root !== undefined &&
      tree.root.identity !== undefined &&
      root?.identity !== undefined &&
      !capturedRootMatchesOwned;
    if (hasStableRootMismatch) {
      // The PID was reused while supervision still owned the original process. Descendants from
      // the mismatched snapshot belong to that new root and must be discarded with it.
      captureComplete = false;
      return;
    }
    const lacksStableRootOwnership =
      tree.root === undefined ? hasNewDescendant : tree.root.identity === undefined;
    const introducesOwnershipWithoutLiveRoot =
      !ownedRootCanAuthorizeCapture &&
      ((tree.root !== undefined && !capturedRootMatchesOwned) || hasNewDescendant);
    const introducesUnprovenRoot =
      !ownedRootCanAuthorizeCapture && tree.root !== undefined && !capturedRootMatchesOwned;
    const hasKnownOwnedIdentity =
      capturedRootMatchesOwned ||
      tree.descendants.some(
        (descendant) =>
          descendant.identity !== undefined && descendants.has(capturedProcessKey(descendant)),
      );
    const stableGroupContinuityMissing =
      hasStableOwnedProcessGroup &&
      !ownedRootCanAuthorizeCapture &&
      hasNewDescendant &&
      !hasKnownOwnedIdentity;
    if (
      introducesUnprovenRoot ||
      stableGroupContinuityMissing ||
      (!hasStableOwnedProcessGroup &&
        (introducesOwnershipWithoutLiveRoot || lacksStableRootOwnership))
    ) {
      // Without an isolated POSIX group, descendants are owned only through the exact root
      // instance. Even with a group, a rootless post-exit snapshot must retain a previously owned
      // identity; otherwise an emptied and subsequently reused numeric PID/PGID could be adopted.
      captureComplete = false;
      return;
    }
    if (!hasStableOwnedProcessGroup && tree.root === undefined) {
      // A rootless Windows snapshot cannot expand or rewrite the retained ownership set. Known
      // identities remain owned from an earlier rooted capture; unknown ones failed closed above.
      return;
    }
    if (tree.root !== undefined) {
      if (root === undefined && tree.root.identity !== undefined) {
        root = tree.root;
      }
      if (tree.root.identity === undefined) captureComplete = false;
    }
    for (const descendant of tree.descendants) {
      if (descendant.identity === undefined) captureComplete = false;
      descendants.set(capturedProcessKey(descendant), descendant);
    }
  };

  const pendingInitialCapture = captureOwnedTreeAsync();
  type RootOutcome =
    | { readonly _tag: "Exited" }
    | { readonly _tag: "WatcherFailed"; readonly error: unknown };
  type RootRunningProof =
    | { readonly _tag: "Running" }
    | { readonly _tag: "Stopped" }
    | { readonly _tag: "Unavailable"; readonly error: unknown };
  let rawRootExitObserved = false;
  const rawRootOutcome: Promise<RootOutcome> = Effect.runPromise(
    process.exitCode.pipe(Effect.asVoid),
  ).then(
    () => {
      rawRootExitObserved = true;
      return { _tag: "Exited" as const };
    },
    (error: unknown) => ({ _tag: "WatcherFailed" as const, error }),
  );
  let rootLivenessUnproven = false;
  const runningProofUnavailable = Symbol("running-proof-unavailable");
  const proveRootRunningBeforeDeadline = async (): Promise<RootRunningProof> => {
    if (process.isRunning === undefined) {
      return {
        _tag: "Unavailable",
        error: new Error(`Provider process ${rootPid} has no running-state proof.`),
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();
    try {
      const running = await Promise.race([
        Effect.runPromise(process.isRunning, { signal: abortController.signal }).then(
          (value) =>
            value === true ? ({ _tag: "Running" } as const) : ({ _tag: "Stopped" } as const),
          (error: unknown) => ({ _tag: "Unavailable" as const, error }),
        ),
        new Promise<typeof runningProofUnavailable>((resolve) => {
          timer = setTimeout(() => {
            abortController.abort();
            resolve(runningProofUnavailable);
          }, proofTimeoutMs);
          timer.unref?.();
        }),
      ]);
      return running === runningProofUnavailable
        ? {
            _tag: "Unavailable",
            error: new Error(
              `Provider process ${rootPid} running-state proof did not settle within ${proofTimeoutMs}ms.`,
            ),
          }
        : running;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abortController.abort();
    }
  };
  const rootOutcome: Promise<RootOutcome> = rawRootOutcome.then(async (outcome) => {
    if (outcome._tag === "Exited") return outcome;
    const runningProof = await proveRootRunningBeforeDeadline();
    if (runningProof._tag === "Running") return outcome;
    if (runningProof._tag === "Stopped") return { _tag: "Exited" };
    rootLivenessUnproven = true;
    return { _tag: "WatcherFailed", error: runningProof.error };
  });
  void rootOutcome.then((outcome) => {
    rootSettled = outcome._tag === "Exited";
  });
  const rawRootOutcomePending = Symbol("raw-root-outcome-pending");
  const ownedRootCanAuthorizeCapture = async (): Promise<boolean> => {
    if (rootSettled || rootLivenessUnproven) return false;
    const rawOutcome = await Promise.race([
      rawRootOutcome,
      new Promise<typeof rawRootOutcomePending>((resolve) => {
        scheduleNextTask(() => resolve(rawRootOutcomePending));
      }),
    ]);
    if (
      (rawOutcome !== rawRootOutcomePending && rawOutcome._tag === "Exited") ||
      process.isRunning === undefined
    ) {
      return false;
    }
    const runningProof = await proveRootRunningBeforeDeadline();
    if (runningProof._tag === "Unavailable") rootLivenessUnproven = true;
    return runningProof._tag === "Running";
  };

  let initialCaptureFailure: unknown;
  let initialCaptureSucceeded = false;
  // Start the ownership boundary immediately without blocking the server event loop. Every proof
  // and teardown operation below awaits this promise before observing or signaling the tree.
  const initialCapture = pendingInitialCapture.then(
    async (tree) => {
      const ownedRootCanAuthorize = await ownedRootCanAuthorizeCapture();
      initialFastRootDrainEligible =
        hasStableOwnedProcessGroup &&
        rawRootExitObserved &&
        !rootLivenessUnproven &&
        tree.root === undefined &&
        tree.descendants.length === 0 &&
        tree.captureComplete !== false;
      mergeCapture(tree, true, ownedRootCanAuthorize);
      initialCaptureSucceeded =
        tree.root !== undefined && tree.captureComplete !== false && captureComplete;
    },
    (error: unknown) => {
      initialCaptureFailure = error;
      captureComplete = false;
    },
  );

  const waitForInitialCapture = async (): Promise<void> => {
    await initialCapture;
    if (initialCaptureSucceeded) return;
    if (initialCaptureFailure !== undefined) throw initialCaptureFailure;
    throw new ProviderProcessExitUnprovenError({
      rootPid,
      rootExited: rootSettled,
      remainingDescendantPids: [...descendants.values()].map((descendant) => descendant.pid),
      captureComplete: false,
    });
  };

  const captureNow = async (): Promise<void> => {
    await initialCapture;
    try {
      // Windows retains parent PIDs after root exit, while POSIX callers provide the isolated
      // process group. Captures stay additive so a vanished wrapper never erases prior identities.
      const tree = await captureOwnedTreeAsync();
      const ownedRootCanAuthorize = await ownedRootCanAuthorizeCapture();
      if (
        initialFastRootDrainEligible &&
        hasStableOwnedProcessGroup &&
        rootSettled &&
        !rootLivenessUnproven &&
        tree.root === undefined &&
        tree.descendants.length === 0 &&
        tree.captureComplete !== false
      ) {
        // A detached POSIX group cannot be reused until it is empty. A complete post-exit
        // snapshot with neither the numeric root nor any group member therefore proves that the
        // owned group drained, even when a short-lived root beat the initial live-root capture.
        // Any reused root or surviving group member remains fail-closed through mergeCapture.
        ownedProcessGroupDrainProven = true;
      }
      mergeCapture(tree, false, ownedRootCanAuthorize);
    } catch {
      captureComplete = false;
    }
  };

  const monitor = (async () => {
    await Promise.race([rootOutcome, sleep(capturePollMs), monitorStop]);
    if (!monitorStopped && !rootSettled && !rootLivenessUnproven) {
      // One delayed refresh catches the usual package-manager/batch-wrapper handoff without
      // launching a whole-system Windows CIM query continuously for every live provider session.
      await captureNow();
    }
  })();

  let stopMonitorPromise: Promise<void> | null = null;
  const stopMonitor = (): Promise<void> => {
    if (stopMonitorPromise === null) {
      monitorStopped = true;
      resolveMonitorStop?.();
      stopMonitorPromise = monitor;
    }
    return stopMonitorPromise;
  };

  const capturedTree = (): CapturedProcessTree => ({
    ...(root !== undefined ? { root } : {}),
    descendants: [...descendants.values()],
    captureComplete,
  });

  const inspectUntil = async (
    tree: CapturedProcessTree,
  ): Promise<ReadonlyArray<CapturedProcess> | null> => {
    const deadline = now() + proofTimeoutMs;
    let remaining: ReadonlyArray<CapturedProcess> | null = null;
    do {
      const inspectionBudgetMs = deadline - now();
      if (inspectionBudgetMs <= 0) break;
      let inspection: CapturedProcessTreeInspection | typeof INSPECTION_TIMED_OUT | undefined;
      try {
        const pendingInspection = processTreeKiller.inspectAsync
          ? processTreeKiller.inspectAsync(tree)
          : processTreeKiller.inspect?.(tree);
        inspection = isPromiseLike(pendingInspection)
          ? await inspectBeforeDeadline(pendingInspection, inspectionBudgetMs)
          : pendingInspection;
      } catch {
        inspection = undefined;
      }
      if (inspection === INSPECTION_TIMED_OUT) return null;
      remaining = inspection?.verified === true ? inspection.survivors : null;
      if (tree.captureComplete !== false && remaining !== null && remaining.length === 0) {
        return remaining;
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(DEFAULT_POLL_MS, remainingMs));
    } while (now() <= deadline);
    return remaining;
  };

  const proveExit = async (): Promise<SupervisedProcessTeardownResult> => {
    await initialCapture;
    const outcome = await rootOutcome;
    await stopMonitor();
    if (outcome._tag === "WatcherFailed") {
      throw new ProviderProcessExitUnprovenError({
        rootPid,
        rootExited: false,
        remainingDescendantPids: null,
        captureComplete: false,
      });
    }
    rootSettled = true;
    await captureNow();
    const tree = capturedTree();
    const inspectionTree = ownedProcessGroupDrainProven ? { ...tree, captureComplete: true } : tree;
    const remaining = await inspectUntil(inspectionTree);
    if (
      (tree.captureComplete !== false || ownedProcessGroupDrainProven) &&
      remaining !== null &&
      remaining.length === 0
    ) {
      return { escalated: false, signalErrors: [] };
    }
    throw new ProviderProcessExitUnprovenError({
      rootPid,
      rootExited: true,
      remainingDescendantPids: remaining?.map((descendant) => descendant.pid) ?? null,
      captureComplete: tree.captureComplete !== false,
    });
  };

  let teardownPromise: Promise<SupervisedProcessTeardownResult> | null = null;
  const teardown = (): Promise<SupervisedProcessTeardownResult> => {
    if (teardownPromise === null) {
      const attempt = (async () => {
        await initialCapture;
        await stopMonitor();
        // Preserve one last live snapshot before signalling. Never replace earlier identities.
        await captureNow();
        return teardownProcessTree({
          rootPid,
          rootExited: rootOutcome.then((outcome) => {
            if (outcome._tag === "WatcherFailed") throw outcome.error;
          }),
          capturedTree: capturedTree(),
          refreshCapturedTree: async () => {
            await captureNow();
            return capturedTree();
          },
          ...(options.ownedProcessGroupId === undefined
            ? {}
            : { ownedProcessGroupId: options.ownedProcessGroupId }),
        });
      })();
      teardownPromise = attempt;
      void attempt.catch(() => {
        // Preserve single-flight behavior while an attempt is pending, but allow a later caller to
        // retry proof with the same retained process identities after an unproven exit.
        if (teardownPromise === attempt) {
          teardownPromise = null;
        }
      });
    }
    return teardownPromise;
  };

  return { rootPid, waitForInitialCapture, captureNow, proveExit, teardown };
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
  if (
    input.ownedProcessGroupId !== undefined &&
    (!Number.isInteger(input.ownedProcessGroupId) || input.ownedProcessGroupId <= 0)
  ) {
    throw new TypeError(
      `Provider process group ID must be a positive integer, got ${input.ownedProcessGroupId}.`,
    );
  }

  const deps = { ...defaultDependencies, ...dependencies };
  const signalErrors: Error[] = [];
  const captureOptions =
    input.ownedProcessGroupId === undefined
      ? undefined
      : { processGroupId: input.ownedProcessGroupId };
  let rootExited = false;
  let captureFinished = input.capturedTree !== undefined;
  let rootExitedBeforeCaptureFinished = false;
  const rootExitObservation = input.rootExited.then(
    () => {
      rootExited = true;
      if (!captureFinished) rootExitedBeforeCaptureFinished = true;
      return true;
    },
    () => false,
  );
  let capturedTree = input.capturedTree;
  if (capturedTree === undefined) {
    capturedTree =
      deps.processTreeKiller.captureAsync === undefined
        ? await Promise.resolve().then(() =>
            deps.processTreeKiller.capture(input.rootPid, captureOptions),
          )
        : await deps.processTreeKiller.captureAsync(input.rootPid, captureOptions);
  }
  captureFinished = true;
  // Flush a root-exit resolution queued in the same turn as capture completion. Then allow every
  // already-queued wrapper reaction to settle before deciding whether the numeric root is safe.
  await Promise.resolve();
  rootExited = await Promise.race([
    rootExitObservation,
    new Promise<boolean>((resolve) => scheduleNextTask(() => resolve(rootExited))),
  ]);
  void rootExitObservation.then((exited) => {
    if (exited) rootExited = true;
  });
  // A capture that starts without a caller-supplied ownership snapshot and finishes after root exit
  // cannot prove continuity. Even an explicitly selected numeric POSIX group could have emptied and
  // been reused before the snapshot completed. An invalid capture implementation that returns no
  // tree is likewise incomplete and must never become successful exit proof.
  const capturedAfterUnsafeRootExit =
    input.capturedTree === undefined && rootExitedBeforeCaptureFinished;
  let tree: CapturedProcessTree =
    capturedAfterUnsafeRootExit || capturedTree === undefined
      ? { descendants: [], captureComplete: false }
      : capturedTree;

  const signal = async (
    killSignal: TerminalKillSignal,
    includeRootTree: boolean,
    timeoutMs: number,
  ): Promise<void> => {
    let acceptsCallbackErrors = true;
    const abortController = new AbortController();
    try {
      const signalInput: Parameters<ProcessTreeKiller["signal"]>[0] = {
        rootPid: input.rootPid,
        signal: killSignal,
        tree,
        includeRootTree,
        shouldSignalRootTree: () => !rootExited,
        abortSignal: abortController.signal,
        onError: (error) => {
          if (acceptsCallbackErrors) signalErrors.push(error);
        },
      };
      const signaling = Promise.resolve().then(() =>
        deps.processTreeKiller.signalAsync !== undefined
          ? deps.processTreeKiller.signalAsync(signalInput)
          : deps.processTreeKiller.signal(signalInput),
      );
      const outcome = await signalBeforeDeadline(signaling, timeoutMs, abortController);
      if (outcome === SIGNAL_TIMED_OUT) {
        signalErrors.push(
          new Error(
            `Provider process tree ${input.rootPid} ${killSignal} signaling did not settle within ${timeoutMs}ms.`,
          ),
        );
      }
    } catch (cause) {
      signalErrors.push(signalFailure(cause, { rootPid: input.rootPid, signal: killSignal }));
    } finally {
      acceptsCallbackErrors = false;
    }
  };

  let refreshedAfterRootExit = false;
  const refreshCapturedTree = async (): Promise<void> => {
    if (input.refreshCapturedTree === undefined) return;
    try {
      tree = await input.refreshCapturedTree();
    } catch {
      tree = { ...tree, captureComplete: false };
    }
  };

  const waitForExitProof = async (timeoutMs: number) => {
    const deadline = deps.now() + timeoutMs;
    let remainingDescendants: ReadonlyArray<CapturedProcess> | null = null;
    do {
      // Flush a root-exit resolution caused synchronously by a signal test double.
      await Promise.resolve();
      if (rootExited && !refreshedAfterRootExit) {
        refreshedAfterRootExit = true;
        // A TERM handler can create a child immediately before the root exits. Refreshing after
        // owned-root settlement prevents a frozen pre-signal tree from proving a false success.
        await refreshCapturedTree();
      }
      const inspectionBudgetMs = deadline - deps.now();
      if (inspectionBudgetMs <= 0) break;
      let inspection: CapturedProcessTreeInspection | typeof INSPECTION_TIMED_OUT | undefined;
      try {
        const pendingInspection = deps.processTreeKiller.inspectAsync
          ? deps.processTreeKiller.inspectAsync(tree)
          : deps.processTreeKiller.inspect?.(tree);
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
        tree.captureComplete !== false &&
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
  const termGraceMs = positiveDuration(input.termGraceMs, DEFAULT_TERM_GRACE_MS);
  await signal("SIGTERM", !rootExited, termGraceMs);
  const graceful = await waitForExitProof(termGraceMs);
  if (graceful.proven) {
    return { escalated: false, signalErrors };
  }

  // A root can exit while descendants ignore TERM and become reparented. Preserve the captured
  // identities and force only those descendants rather than re-signalling a potentially reused PID.
  await refreshCapturedTree();
  const forceExitMs = positiveDuration(input.forceExitMs, DEFAULT_FORCE_EXIT_MS);
  await signal("SIGKILL", !rootExited, forceExitMs);
  const forced = await waitForExitProof(forceExitMs);
  if (forced.proven) {
    return { escalated: true, signalErrors };
  }

  throw new ProviderProcessExitUnprovenError({
    rootPid: input.rootPid,
    rootExited,
    remainingDescendantPids:
      forced.remainingDescendants?.map((descendant) => descendant.pid) ?? null,
    captureComplete: tree.captureComplete !== false,
  });
}
