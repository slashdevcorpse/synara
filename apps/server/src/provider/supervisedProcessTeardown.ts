import {
  defaultProcessTreeKiller,
  type CapturedProcess,
  type CapturedProcessTree,
  type ProcessTreeKiller,
  type TerminalKillSignal,
} from "../terminal/processTreeKiller";
import { Effect } from "effect";

const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_FORCE_EXIT_MS = 1_500;
const DEFAULT_POLL_MS = 25;
const DEFAULT_CAPTURE_POLL_MS = 100;

export interface SupervisedProcessTeardownInput {
  readonly rootPid: number;
  /** Must resolve only after the owned root process has emitted its terminal exit. */
  readonly rootExited: Promise<unknown>;
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

const defaultDependencies: SupervisedProcessTeardownDependencies = {
  processTreeKiller: defaultProcessTreeKiller,
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
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
    rootExited: awaitEffectProcessExit(process),
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
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultDependencies.sleep;
  const capturePollMs = positiveDuration(options.capturePollMs, DEFAULT_CAPTURE_POLL_MS);
  const proofTimeoutMs = positiveDuration(options.proofTimeoutMs, DEFAULT_TERM_GRACE_MS);
  const descendants = new Map<string, CapturedProcess>();
  let root: CapturedProcess | undefined;
  let captureComplete = true;
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

  const captureOwnedTree = (): CapturedProcessTree =>
    processTreeKiller.capture(rootPid, {
      ...(options.ownedProcessGroupId !== undefined
        ? { processGroupId: options.ownedProcessGroupId }
        : {}),
    });

  const captureOwnedTreeAsync = (): Promise<CapturedProcessTree> =>
    processTreeKiller.captureAsync?.(rootPid, {
      ...(options.ownedProcessGroupId !== undefined
        ? { processGroupId: options.ownedProcessGroupId }
        : {}),
    }) ?? Promise.resolve(captureOwnedTree());

  const mergeCapture = (tree: CapturedProcessTree, requireLiveRoot: boolean): void => {
    if (tree.captureComplete === false || (requireLiveRoot && tree.root === undefined)) {
      captureComplete = false;
    }
    if (tree.root !== undefined) {
      if (root === undefined) {
        root = tree.root;
      } else if (capturedProcessKey(root) !== capturedProcessKey(tree.root)) {
        // The PID was reused while supervision still owned the original process.
        captureComplete = false;
      }
      if (tree.root.identity === undefined) captureComplete = false;
    }
    for (const descendant of tree.descendants) {
      if (descendant.identity === undefined) captureComplete = false;
      descendants.set(capturedProcessKey(descendant), descendant);
    }
  };

  // This synchronous first snapshot is the ownership boundary. If the root is already absent,
  // normal completion is deliberately unprovable rather than assuming it had no children.
  mergeCapture(captureOwnedTree(), true);

  const rootOutcome = awaitEffectProcessExit(process).then(
    () => ({ _tag: "Exited" as const }),
    (error: unknown) => ({ _tag: "WatcherFailed" as const, error }),
  );
  void rootOutcome.then(() => {
    rootSettled = true;
  });

  const captureNow = async (): Promise<void> => {
    try {
      // Windows retains parent PIDs after root exit, while POSIX callers provide the isolated
      // process group. Captures stay additive so a vanished wrapper never erases prior identities.
      mergeCapture(await captureOwnedTreeAsync(), false);
    } catch {
      captureComplete = false;
    }
  };

  const monitor = (async () => {
    await Promise.race([rootOutcome, sleep(capturePollMs), monitorStop]);
    if (!monitorStopped && !rootSettled) {
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
      const inspection = processTreeKiller.inspectAsync
        ? await processTreeKiller.inspectAsync(tree)
        : processTreeKiller.inspect?.(tree);
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
    const outcome = await rootOutcome;
    await stopMonitor();
    await captureNow();
    const tree = capturedTree();
    const remaining = await inspectUntil(tree);
    if (
      outcome._tag === "Exited" &&
      tree.captureComplete !== false &&
      remaining !== null &&
      remaining.length === 0
    ) {
      return { escalated: false, signalErrors: [] };
    }
    throw new ProviderProcessExitUnprovenError({
      rootPid,
      rootExited: outcome._tag === "Exited",
      remainingDescendantPids: remaining?.map((descendant) => descendant.pid) ?? null,
      captureComplete: tree.captureComplete !== false,
    });
  };

  let teardownPromise: Promise<SupervisedProcessTeardownResult> | null = null;
  const teardown = (): Promise<SupervisedProcessTeardownResult> => {
    if (teardownPromise === null) {
      const attempt = (async () => {
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

  return { rootPid, captureNow, proveExit, teardown };
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
  let tree = input.capturedTree ?? deps.processTreeKiller.capture(input.rootPid);
  const signalErrors: Error[] = [];
  let rootExited = false;
  void input.rootExited.then(
    () => {
      rootExited = true;
    },
    () => {
      // A rejected watcher is not evidence that the owned process exited.
    },
  );

  const signal = (killSignal: TerminalKillSignal, includeRootTree: boolean): void => {
    deps.processTreeKiller.signal({
      rootPid: input.rootPid,
      signal: killSignal,
      tree,
      includeRootTree,
      onError: (error) => signalErrors.push(error),
    });
  };

  // Observe an already-settled watcher before deciding whether it is safe to address the root PID.
  // This prevents a normal-exit proof failure from signalling an unrelated process that reused it.
  await Promise.resolve();

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
      const inspection = deps.processTreeKiller.inspectAsync
        ? await deps.processTreeKiller.inspectAsync(tree)
        : deps.processTreeKiller.inspect?.(tree);
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

  signal("SIGTERM", !rootExited);
  const graceful = await waitForExitProof(
    positiveDuration(input.termGraceMs, DEFAULT_TERM_GRACE_MS),
  );
  if (graceful.proven) {
    return { escalated: false, signalErrors };
  }

  // A root can exit while descendants ignore TERM and become reparented. Preserve the captured
  // identities and force only those descendants rather than re-signalling a potentially reused PID.
  await refreshCapturedTree();
  signal("SIGKILL", !rootExited);
  const forced = await waitForExitProof(positiveDuration(input.forceExitMs, DEFAULT_FORCE_EXIT_MS));
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
