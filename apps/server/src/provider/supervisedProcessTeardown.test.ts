import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type {
  CapturedProcess,
  CapturedProcessTree,
  ProcessTreeKiller,
  TerminalKillSignal,
} from "../terminal/processTreeKiller";
import { createProcessTreeKiller } from "../terminal/processTreeKiller";
import {
  findProviderProcessExitUnprovenError,
  ProviderProcessExitUnprovenError,
  superviseEffectProcessTree,
  teardownEffectProcessTree,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown";

function unprovenExit(rootPid: number): ProviderProcessExitUnprovenError {
  return new ProviderProcessExitUnprovenError({
    rootPid,
    rootExited: false,
    remainingDescendantPids: null,
    captureComplete: false,
  });
}

describe("findProviderProcessExitUnprovenError", () => {
  it("returns a direct unproven-exit error", () => {
    const failure = unprovenExit(91);

    expect(findProviderProcessExitUnprovenError(failure)).toBe(failure);
  });

  it("traverses nested causes and every AggregateError entry deterministically", () => {
    const first = unprovenExit(92);
    const second = unprovenExit(93);
    const wrapped = new Error("adapter request failed", {
      cause: new AggregateError(
        [new Error("ordinary failure"), new Error("finalizer failed", { cause: first }), second],
        "provider discovery failed",
      ),
    });

    expect(findProviderProcessExitUnprovenError(wrapped)).toBe(first);
  });

  it("handles cyclic error graphs and ordinary failures", () => {
    const cyclic = new Error("cyclic") as Error & { cause?: unknown };
    cyclic.cause = new AggregateError([cyclic, new Error("ordinary")], "cycle");

    expect(findProviderProcessExitUnprovenError(cyclic)).toBeNull();
    expect(findProviderProcessExitUnprovenError("ordinary")).toBeNull();
  });
});

function deterministicClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("teardownProviderProcessTree", () => {
  it("does not convert a failed Effect exit watcher into false exit proof", async () => {
    const watcherFailure = new Error("provider exit watcher failed");

    await expect(
      teardownEffectProcessTree(
        {
          pid: 91,
          exitCode: Effect.die(watcherFailure),
        },
        async ({ rootExited }) => {
          await expect(rootExited).rejects.toBe(watcherFailure);
          return { escalated: false, signalErrors: [] };
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
  });

  it("uses the default monotonic clock with its required receiver intact", async () => {
    let resolveRootExit!: () => void;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });

    await expect(
      teardownProviderProcessTree(
        { rootPid: 91, rootExited, termGraceMs: 50, forceExitMs: 50, pollMs: 5 },
        {
          processTreeKiller: {
            capture: () => ({ descendants: [], captureComplete: true }),
            inspect: () => ({ verified: true, survivors: [] }),
            signal: ({ signal }) => {
              if (signal === "SIGTERM") resolveRootExit();
            },
          },
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
  });

  it("accepts signal-driven exit failure only when the owned handle proves it stopped", async () => {
    const signalExit = new Error("Process interrupted due to receipt of signal: 'SIGTERM'");

    await expect(
      teardownEffectProcessTree(
        {
          pid: 92,
          exitCode: Effect.fail(signalExit),
          isRunning: Effect.succeed(false),
        },
        async ({ rootExited }) => {
          await expect(rootExited).resolves.toBeUndefined();
          return { escalated: false, signalErrors: [] };
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
  });

  it("retains a detached POSIX group when the root exits before fallback capture", async () => {
    const groupDescendant: CapturedProcess = {
      pid: 94,
      command: "provider-worker",
      identity: "94:worker-start",
      groupId: 93,
    };
    let descendantRunning = true;
    let captureOptions: { readonly processGroupId?: number } | undefined;
    const signalledTrees: CapturedProcessTree[] = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      captureAsync: async (_rootPid, options) => {
        captureOptions = options;
        return options?.processGroupId === 93
          ? { descendants: [groupDescendant], captureComplete: true }
          : { descendants: [], captureComplete: true };
      },
      inspect: (tree) => ({
        verified: true,
        survivors: descendantRunning ? tree.descendants : [],
      }),
      signal: ({ tree }) => {
        signalledTrees.push(tree);
        descendantRunning = false;
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownEffectProcessTree(
        {
          pid: 93,
          exitCode: Effect.succeed(0),
          isRunning: Effect.succeed(false),
        },
        (input) => teardownProviderProcessTree(input, { processTreeKiller, ...clock }),
        { ownedProcessGroupId: 93 },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(captureOptions).toEqual({ processGroupId: 93 });
    expect(signalledTrees).toEqual([{ descendants: [groupDescendant], captureComplete: true }]);
  });

  it("escalates ignored TERM and returns only after root and descendants prove exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 102, command: "provider-worker" }],
      captureComplete: true,
    };
    const runningDescendants = new Map<number, CapturedProcess>([[102, tree.descendants[0]!]]);
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({ verified: true, survivors: [...runningDescendants.values()] }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGKILL") {
          runningDescendants.clear();
          resolveRootExit?.();
        }
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 101, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: true },
      { signal: "SIGKILL", includeRootTree: true },
    ]);
  });

  it("force-kills captured descendants without re-signalling a root that exited after TERM", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 202, command: "provider-grandchild" }],
      captureComplete: true,
    };
    let descendantsRunning = true;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({
        verified: true,
        survivors: descendantsRunning ? tree.descendants : [],
      }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGTERM") resolveRootExit?.();
        if (signal === "SIGKILL") descendantsRunning = false;
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 201, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(signals.at(-1)).toEqual({ signal: "SIGKILL", includeRootTree: false });
  });

  it("does not signal a root PID whose exit was already proven before teardown", async () => {
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      inspect: () => ({ verified: true, survivors: [] }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
      },
    };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 251, rootExited: Promise.resolve(), termGraceMs: 5, forceExitMs: 5 },
      { processTreeKiller, ...clock },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 251,
      rootExited: true,
      remainingDescendantPids: [],
      captureComplete: false,
    });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: false },
      { signal: "SIGKILL", includeRootTree: false },
    ]);
  });

  it("refreshes ownership after TERM before proving a late child exited", async () => {
    const lateChild: CapturedProcess = {
      pid: 272,
      command: "provider-late-child",
      identity: "272:late-start",
    };
    let lateChildRunning = false;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: TerminalKillSignal[] = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      inspect: (tree) => ({
        verified: true,
        survivors: lateChildRunning
          ? tree.descendants.filter(({ pid }) => pid === lateChild.pid)
          : [],
      }),
      signal: ({ signal }) => {
        signals.push(signal);
        if (signal === "SIGTERM") {
          lateChildRunning = true;
          resolveRootExit?.();
        } else {
          lateChildRunning = false;
        }
      },
    };
    const clock = deterministicClock();
    let refreshes = 0;

    await expect(
      teardownProviderProcessTree(
        {
          rootPid: 271,
          rootExited,
          capturedTree: { descendants: [], captureComplete: true },
          refreshCapturedTree: async () => {
            refreshes += 1;
            return {
              descendants: lateChildRunning ? [lateChild] : [],
              captureComplete: true,
            };
          },
          termGraceMs: 5,
          forceExitMs: 5,
        },
        { processTreeKiller, ...clock },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(refreshes).toBeGreaterThanOrEqual(2);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("bounds a hanging graceful inspection by the TERM deadline and escalates", async () => {
    vi.useFakeTimers();
    try {
      const gracefulInspectionStarted = Promise.withResolvers<void>();
      const signals: TerminalKillSignal[] = [];
      let inspectCalls = 0;
      let resolveRootExit: (() => void) | undefined;
      const rootExited = new Promise<void>((resolve) => {
        resolveRootExit = resolve;
      });
      const teardown = teardownProviderProcessTree(
        { rootPid: 251, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller: {
            capture: () => ({ descendants: [], captureComplete: true }),
            inspect: () => {
              inspectCalls += 1;
              if (inspectCalls === 1) {
                gracefulInspectionStarted.resolve();
                return new Promise(() => undefined);
              }
              return { verified: true, survivors: [] };
            },
            signal: ({ signal }) => {
              signals.push(signal);
              if (signal === "SIGKILL") resolveRootExit?.();
            },
          },
          ...deterministicClock(),
        },
      );

      await gracefulInspectionStarted.promise;
      await vi.advanceTimersByTimeAsync(10);

      await expect(teardown).resolves.toEqual({ escalated: true, signalErrors: [] });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(inspectCalls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hanging callback-based TERM signal and still escalates to exit proof", async () => {
    vi.useFakeTimers();
    try {
      const termSignalStarted = Promise.withResolvers<void>();
      const signals: TerminalKillSignal[] = [];
      let resolveRootExit!: () => void;
      const rootExited = new Promise<void>((resolve) => {
        resolveRootExit = resolve;
      });
      const snapshot = new Map([
        [
          271,
          {
            pid: 271,
            parentPid: 1,
            command: "provider-root",
            identity: "271:root-start",
            identityPrecision: "exact" as const,
          },
        ],
      ]);
      const processTreeKiller = createProcessTreeKiller({
        captureProcessSnapshot: () => snapshot,
        captureProcessSnapshotAsync: async () => snapshot,
        readCurrentProcesses: () => snapshot,
        signalTree: (_rootPid, signal, callback) => {
          signals.push(signal);
          if (signal === "SIGTERM") {
            termSignalStarted.resolve();
            return;
          }
          resolveRootExit();
          callback(null);
        },
      });
      const teardown = teardownProviderProcessTree(
        { rootPid: 271, rootExited, termGraceMs: 5, forceExitMs: 5, pollMs: 5 },
        { processTreeKiller, ...deterministicClock() },
      );

      await termSignalStarted.promise;
      await vi.advanceTimersByTimeAsync(5);

      const result = await teardown;
      expect(result.escalated).toBe(true);
      expect(result.signalErrors).toHaveLength(1);
      expect(result.signalErrors[0]?.message).toContain(
        "SIGTERM signaling did not settle within 5ms",
      );
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts timed-out Windows identity preparation before any late forced signal", async () => {
    vi.useFakeTimers();
    try {
      const forcePreparationStarted = Promise.withResolvers<void>();
      const releaseForcePreparation = Promise.withResolvers<void>();
      const signaledPids: Array<{ pid: number; signal: TerminalKillSignal }> = [];
      const treeSignals: Array<{ rootPid: number; signal: TerminalKillSignal }> = [];
      const snapshot = {
        root: {
          pid: 301,
          parentPid: 1,
          command: "provider-root.exe",
          identity: "301:root-start",
          identityPrecision: "exact" as const,
        },
        child: {
          pid: 302,
          parentPid: 301,
          command: "provider-worker.exe",
          identity: "302:worker-start",
          identityPrecision: "exact" as const,
        },
      } as const;
      const snapshotMap = new Map([
        [snapshot.root.pid, snapshot.root],
        [snapshot.child.pid, snapshot.child],
      ]);
      let forcePreparationSignal: AbortSignal | undefined;
      let forcedSignaling: Promise<void> | undefined;
      let snapshotCalls = 0;
      const windowsProcessTreeKiller = createProcessTreeKiller({
        captureProcessSnapshot: () => snapshotMap,
        captureProcessSnapshotAsync: async (signal) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            forcePreparationSignal = signal;
            forcePreparationStarted.resolve();
            await releaseForcePreparation.promise;
            return snapshotMap;
          }
          if (snapshotCalls > 2) {
            return null;
          }
          return snapshotMap;
        },
        readCurrentProcesses: () => snapshotMap,
        signalPid: (pid, signal) => {
          signaledPids.push({ pid, signal });
          return null;
        },
        signalTree: (rootPid, signal, callback) => {
          treeSignals.push({ rootPid, signal });
          callback(null);
        },
      });
      const phaseAbortSignals = new Map<TerminalKillSignal, AbortSignal | undefined>();
      const processTreeKiller: ProcessTreeKiller = {
        capture: windowsProcessTreeKiller.capture,
        inspect: (tree) => {
          if (!windowsProcessTreeKiller.inspect) {
            throw new Error("Expected the concrete process-tree killer to support inspection.");
          }
          return windowsProcessTreeKiller.inspect(tree);
        },
        signal: (input) => {
          phaseAbortSignals.set(input.signal, input.abortSignal);
          if (windowsProcessTreeKiller.signalAsync === undefined) {
            throw new Error(
              "Expected the concrete process-tree killer to support async signaling.",
            );
          }
          const signaling = windowsProcessTreeKiller.signalAsync(input);
          if (input.signal === "SIGKILL") {
            forcedSignaling = signaling;
          }
          return signaling;
        },
      };
      const teardown = teardownProviderProcessTree(
        {
          rootPid: 301,
          rootExited: new Promise(() => undefined),
          termGraceMs: 5,
          forceExitMs: 5,
          pollMs: 5,
        },
        { processTreeKiller, ...deterministicClock() },
      ).catch((error: unknown) => error);

      await forcePreparationStarted.promise;
      await vi.advanceTimersByTimeAsync(5);
      const failure = await teardown;

      expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
      expect(forcePreparationSignal?.aborted).toBe(true);
      expect(phaseAbortSignals.get("SIGTERM")?.aborted).toBe(false);
      expect(phaseAbortSignals.get("SIGKILL")).toBe(forcePreparationSignal);
      expect(phaseAbortSignals.get("SIGTERM")).not.toBe(forcePreparationSignal);
      expect(signaledPids).toEqual([{ pid: 302, signal: "SIGTERM" }]);
      expect(treeSignals).toEqual([{ rootPid: 301, signal: "SIGTERM" }]);

      if (!forcedSignaling) {
        throw new Error("Expected forced signaling to start before its preparation deadline.");
      }
      const forcedSignalingFailure = forcedSignaling.catch((error: unknown) => error);
      releaseForcePreparation.resolve();
      await expect(forcedSignalingFailure).resolves.toMatchObject({ name: "AbortError" });

      expect(signaledPids).toEqual([{ pid: 302, signal: "SIGTERM" }]);
      expect(treeSignals).toEqual([{ rootPid: 301, signal: "SIGTERM" }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a forced-inspection timeout as unverified and fails closed", async () => {
    vi.useFakeTimers();
    try {
      const forcedInspectionStarted = Promise.withResolvers<void>();
      const tree: CapturedProcessTree = {
        descendants: [{ pid: 282, command: "provider-worker" }],
        captureComplete: true,
      };
      let inspectCalls = 0;
      let resolveRootExit: (() => void) | undefined;
      const rootExited = new Promise<void>((resolve) => {
        resolveRootExit = resolve;
      });
      const teardown = teardownProviderProcessTree(
        {
          rootPid: 281,
          rootExited,
          termGraceMs: 5,
          forceExitMs: 10,
          pollMs: 5,
        },
        {
          processTreeKiller: {
            capture: () => tree,
            inspect: () => {
              inspectCalls += 1;
              if (inspectCalls === 1) {
                return { verified: true, survivors: tree.descendants };
              }
              forcedInspectionStarted.resolve();
              return new Promise(() => undefined);
            },
            signal: ({ signal }) => {
              if (signal === "SIGKILL") resolveRootExit?.();
            },
          },
          ...deterministicClock(),
        },
      );
      const failurePromise = teardown.catch((error: unknown) => error);

      await forcedInspectionStarted.promise;
      await vi.advanceTimersByTimeAsync(10);
      const failure = await failurePromise;

      expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
      expect(failure).toMatchObject({
        rootPid: 281,
        rootExited: true,
        remainingDescendantPids: null,
        captureComplete: true,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats rejected inspections as unverified, escalates, and fails closed", async () => {
    vi.useFakeTimers();
    try {
      const tree: CapturedProcessTree = {
        descendants: [{ pid: 292, command: "provider-worker" }],
        captureComplete: true,
      };
      const signals: TerminalKillSignal[] = [];
      let resolveRootExit: (() => void) | undefined;
      const rootExited = new Promise<void>((resolve) => {
        resolveRootExit = resolve;
      });

      const failure = await teardownProviderProcessTree(
        {
          rootPid: 291,
          rootExited,
          termGraceMs: 5,
          forceExitMs: 5,
          pollMs: 5,
        },
        {
          processTreeKiller: {
            capture: () => tree,
            inspect: () => Promise.reject(new Error("inspection failed")),
            signal: ({ signal }) => {
              signals.push(signal);
              if (signal === "SIGKILL") resolveRootExit?.();
            },
          },
          ...deterministicClock(),
        },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
      expect(failure).toMatchObject({
        rootPid: 291,
        rootExited: true,
        remainingDescendantPids: null,
        captureComplete: true,
      });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when forced termination cannot prove process-tree exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 302, command: "stuck-provider" }],
      captureComplete: true,
    };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 301, rootExited: new Promise(() => undefined), termGraceMs: 5, forceExitMs: 5 },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: tree.descendants }),
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      name: "ProviderProcessExitUnprovenError",
      rootPid: 301,
      rootExited: false,
      remainingDescendantPids: [302],
    });
  });

  it("fails closed when asynchronous descendant capture is incomplete", async () => {
    const clock = deterministicClock();
    const failure = await teardownProviderProcessTree(
      {
        rootPid: 401,
        rootExited: Promise.resolve(),
        termGraceMs: 5,
        forceExitMs: 5,
      },
      {
        processTreeKiller: {
          capture: async () => ({ descendants: [], captureComplete: false }),
          inspect: async () => ({ verified: true, survivors: [] }),
          signal: async () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 401,
      rootExited: true,
      remainingDescendantPids: [],
      captureComplete: false,
    });
  });

  it("observes root exit during capture, avoids stale-PID signalling, and fails closed", async () => {
    const clock = deterministicClock();
    let releaseCapture: (() => void) | undefined;
    let resolveRootExit: (() => void) | undefined;
    const captureStarted = Promise.withResolvers<void>();
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: Array<{
      signal: TerminalKillSignal;
      includeRootTree: boolean | undefined;
      descendantPids: number[];
    }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: async () => {
        captureStarted.resolve();
        await new Promise<void>((resolve) => {
          releaseCapture = resolve;
        });
        return {
          descendants: [{ pid: 502, command: "unrelated-reused-root-child" }],
          captureComplete: true,
        };
      },
      inspect: () => ({ verified: true, survivors: [] }),
      signal: ({ signal, includeRootTree, tree }) => {
        signals.push({
          signal,
          includeRootTree,
          descendantPids: tree.descendants.map(({ pid }) => pid),
        });
      },
    };

    const teardown = teardownProviderProcessTree(
      { rootPid: 501, rootExited, termGraceMs: 5, forceExitMs: 5, pollMs: 5 },
      { processTreeKiller, ...clock },
    );
    await captureStarted.promise;
    resolveRootExit?.();
    await Promise.resolve();
    releaseCapture?.();

    const failure = await teardown.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 501,
      rootExited: true,
      remainingDescendantPids: [],
      captureComplete: false,
    });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: false, descendantPids: [] },
      { signal: "SIGKILL", includeRootTree: false, descendantPids: [] },
    ]);
  });

  it("does not signal an already-exited root through a deeply wrapped exit promise", async () => {
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    let wrappedExit: Promise<void> = Promise.resolve();
    for (let depth = 0; depth < 25; depth += 1) {
      wrappedExit = wrappedExit.then(() => undefined);
    }

    await expect(
      teardownProviderProcessTree(
        {
          rootPid: 351,
          rootExited: wrappedExit,
          capturedTree: {
            root: {
              pid: 351,
              command: "provider wrapper",
              identity: "351:root-start",
            },
            descendants: [],
            captureComplete: true,
          },
          termGraceMs: 5,
          forceExitMs: 5,
        },
        {
          processTreeKiller: {
            capture: () => {
              throw new Error("pre-captured teardown must not recapture synchronously");
            },
            inspect: () => ({ verified: true, survivors: [] }),
            signal: ({ signal, includeRootTree }) => {
              signals.push({ signal, includeRootTree });
            },
          },
          ...deterministicClock(),
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(signals).toEqual([{ signal: "SIGTERM", includeRootTree: false }]);
  });

  it("uses asynchronous capture and signaling without invoking synchronous process-table paths", async () => {
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: TerminalKillSignal[] = [];
    let synchronousCalls = 0;

    await expect(
      teardownProviderProcessTree(
        { rootPid: 401, rootExited, termGraceMs: 5, forceExitMs: 5 },
        {
          processTreeKiller: {
            capture: () => {
              synchronousCalls += 1;
              throw new Error("synchronous capture must not run");
            },
            captureAsync: async () => ({
              root: {
                pid: 401,
                command: "provider root",
                identity: "401:root-start",
              },
              descendants: [],
              captureComplete: true,
            }),
            inspect: () => ({ verified: true, survivors: [] }),
            signal: () => {
              synchronousCalls += 1;
              throw new Error("synchronous signal must not run");
            },
            signalAsync: async ({ signal }) => {
              signals.push(signal);
              resolveRootExit?.();
            },
          },
          ...deterministicClock(),
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(synchronousCalls).toBe(0);
    expect(signals).toEqual(["SIGTERM"]);
  });
});

describe("superviseEffectProcessTree", () => {
  function controllableEffectProcess(pid: number) {
    let resolveExit: (() => void) | undefined;
    let running = true;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    return {
      process: {
        pid,
        exitCode: Effect.promise(() => exited),
        isRunning: Effect.sync(() => running),
      },
      exit: () => {
        running = false;
        resolveExit?.();
      },
    };
  }

  it("proves normal root success only after every live-captured descendant exits", async () => {
    const owned = controllableEffectProcess(501);
    const root: CapturedProcess = {
      pid: 501,
      command: "provider updater",
      identity: "501:root-start",
    };
    const child: CapturedProcess = {
      pid: 502,
      command: "provider postinstall",
      identity: "502:child-start",
    };
    let rootAlive = true;
    let childAlive = true;
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({
        ...(rootAlive ? { root } : {}),
        descendants: childAlive ? [child] : [],
        captureComplete: true,
      }),
      captureAsync: async () => ({
        ...(rootAlive ? { root } : {}),
        descendants: childAlive ? [child] : [],
        captureComplete: true,
      }),
      inspect: (tree) => ({
        verified: true,
        survivors: childAlive ? tree.descendants.filter(({ pid }) => pid === child.pid) : [],
      }),
      signal: () => undefined,
    };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller,
      platform: "win32",
      capturePollMs: 1,
      proofTimeoutMs: 5,
    });

    await supervisor.waitForInitialCapture();
    rootAlive = false;
    owned.exit();
    const failure = await supervisor.proveExit().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 501,
      rootExited: true,
      remainingDescendantPids: [502],
      captureComplete: true,
    });

    childAlive = false;
  });

  it("discards a later reused-root capture before signalling unrelated descendants", async () => {
    const owned = controllableEffectProcess(521);
    const ownedRoot: CapturedProcess = {
      pid: 521,
      command: "provider updater",
      identity: "521:owned-start",
    };
    const reusedRoot: CapturedProcess = {
      pid: 521,
      command: "unrelated process",
      identity: "521:reused-start",
    };
    const unrelatedDescendant: CapturedProcess = {
      pid: 522,
      command: "unrelated child",
      identity: "522:unrelated-start",
    };
    const signalledTrees: Array<{
      signal: TerminalKillSignal;
      descendantPids: number[];
    }> = [];
    let captureCalls = 0;
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => {
        throw new Error("synchronous capture must not run");
      },
      captureAsync: async () => {
        captureCalls += 1;
        return captureCalls === 1
          ? { root: ownedRoot, descendants: [], captureComplete: true }
          : {
              root: reusedRoot,
              descendants: [unrelatedDescendant],
              captureComplete: true,
            };
      },
      inspect: () => ({ verified: true, survivors: [] }),
      signal: ({ signal, tree }) => {
        signalledTrees.push({
          signal,
          descendantPids: tree.descendants.map(({ pid }) => pid),
        });
        if (signal === "SIGTERM") owned.exit();
      },
    };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller,
      teardownProcessTree: (input) =>
        teardownProviderProcessTree(
          { ...input, termGraceMs: 5, forceExitMs: 5, pollMs: 5 },
          { processTreeKiller, ...deterministicClock() },
        ),
      platform: "win32",
      capturePollMs: 60_000,
    });

    const failure = await supervisor.teardown().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({ captureComplete: false });
    expect(signalledTrees).toEqual([
      { signal: "SIGTERM", descendantPids: [] },
      { signal: "SIGKILL", descendantPids: [] },
    ]);
  });

  it("discards an initial reused-root capture that completes after owned root exit", async () => {
    const owned = controllableEffectProcess(531);
    const captureStarted = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const unrelatedDescendant: CapturedProcess = {
      pid: 532,
      command: "unrelated child",
      identity: "532:unrelated-start",
    };
    const signalledDescendantPids: number[][] = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => {
        throw new Error("synchronous capture must not run");
      },
      captureAsync: async () => {
        captureStarted.resolve();
        await releaseCapture.promise;
        return {
          root: {
            pid: 531,
            command: "reused process",
            identity: "531:reused-start",
          },
          descendants: [unrelatedDescendant],
          captureComplete: true,
        };
      },
      inspect: () => ({ verified: true, survivors: [] }),
      signal: ({ tree }) => {
        signalledDescendantPids.push(tree.descendants.map(({ pid }) => pid));
      },
    };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller,
      teardownProcessTree: (input) =>
        teardownProviderProcessTree(
          { ...input, termGraceMs: 5, forceExitMs: 5, pollMs: 5 },
          { processTreeKiller, ...deterministicClock() },
        ),
      platform: "win32",
      capturePollMs: 60_000,
    });

    await captureStarted.promise;
    owned.exit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseCapture.resolve();

    await expect(supervisor.waitForInitialCapture()).rejects.toMatchObject({
      captureComplete: false,
    });
    const failure = await supervisor.teardown().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(signalledDescendantPids).toEqual([[], []]);
  });

  it("rejects initial ownership expansion after an exit watcher fails without liveness proof", async () => {
    const captureStarted = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<never>();
    const supervisor = superviseEffectProcessTree(
      {
        pid: 536,
        exitCode: Effect.promise(() => exit.promise),
      },
      {
        processTreeKiller: {
          capture: () => {
            throw new Error("synchronous capture must not run");
          },
          captureAsync: async () => {
            captureStarted.resolve();
            await releaseCapture.promise;
            return {
              root: {
                pid: 536,
                command: "reused process",
                identity: "536:reused-start",
              },
              descendants: [
                {
                  pid: 537,
                  command: "unrelated child",
                  identity: "537:unrelated-start",
                },
              ],
              captureComplete: true,
            };
          },
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        platform: "win32",
        capturePollMs: 60_000,
        proofTimeoutMs: 5,
      },
    );

    await captureStarted.promise;
    exit.reject(new Error("exit watcher failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseCapture.resolve();

    await expect(supervisor.waitForInitialCapture()).rejects.toMatchObject({
      remainingDescendantPids: [],
      captureComplete: false,
    });
  });

  it("rejects initial ownership expansion when the running-state proof fails", async () => {
    const captureStarted = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<never>();
    const supervisor = superviseEffectProcessTree(
      {
        pid: 538,
        exitCode: Effect.promise(() => exit.promise),
        isRunning: Effect.fail(new Error("running-state query failed")),
      },
      {
        processTreeKiller: {
          capture: () => {
            throw new Error("synchronous capture must not run");
          },
          captureAsync: async () => {
            captureStarted.resolve();
            await releaseCapture.promise;
            return {
              root: {
                pid: 538,
                command: "reused process",
                identity: "538:reused-start",
              },
              descendants: [
                {
                  pid: 539,
                  command: "unrelated child",
                  identity: "539:unrelated-start",
                },
              ],
              captureComplete: true,
            };
          },
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        platform: "win32",
        capturePollMs: 60_000,
        proofTimeoutMs: 5,
      },
    );

    await captureStarted.promise;
    exit.reject(new Error("exit watcher failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseCapture.resolve();

    await expect(supervisor.waitForInitialCapture()).rejects.toMatchObject({
      remainingDescendantPids: [],
      captureComplete: false,
    });
  });

  it("bounds an unusable running-state proof and rejects initial ownership expansion", async () => {
    const captureStarted = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<never>();
    const supervisor = superviseEffectProcessTree(
      {
        pid: 543,
        exitCode: Effect.promise(() => exit.promise),
        isRunning: Effect.never,
      },
      {
        processTreeKiller: {
          capture: () => {
            throw new Error("synchronous capture must not run");
          },
          captureAsync: async () => {
            captureStarted.resolve();
            await releaseCapture.promise;
            return {
              root: {
                pid: 543,
                command: "reused process",
                identity: "543:reused-start",
              },
              descendants: [
                {
                  pid: 544,
                  command: "unrelated child",
                  identity: "544:unrelated-start",
                },
              ],
              captureComplete: true,
            };
          },
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        platform: "win32",
        capturePollMs: 60_000,
        proofTimeoutMs: 5,
      },
    );

    await captureStarted.promise;
    exit.reject(new Error("exit watcher failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseCapture.resolve();

    await expect(supervisor.waitForInitialCapture()).rejects.toMatchObject({
      remainingDescendantPids: [],
      captureComplete: false,
    });
  });

  it("bounds proveExit when a failed exit watcher has a non-settling liveness proof", async () => {
    vi.useFakeTimers();
    try {
      const timeout = Symbol("prove-exit-timeout");
      const supervisor = superviseEffectProcessTree(
        {
          pid: 547,
          exitCode: Effect.fail(new Error("exit watcher failed")),
          isRunning: Effect.never,
        },
        {
          processTreeKiller: {
            capture: () => ({
              root: {
                pid: 547,
                command: "provider process",
                identity: "547:owned-start",
              },
              descendants: [],
              captureComplete: true,
            }),
            inspect: () => ({ verified: true, survivors: [] }),
            signal: () => undefined,
          },
          platform: "win32",
          capturePollMs: 60_000,
          proofTimeoutMs: 5,
          sleep: () => new Promise(() => undefined),
        },
      );
      const result = Promise.race([
        supervisor.proveExit().catch((error: unknown) => error),
        new Promise<typeof timeout>((resolve) => {
          setTimeout(() => resolve(timeout), 6);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(6);
      const failure = await result;

      expect(failure).not.toBe(timeout);
      expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
      expect(failure).toMatchObject({
        rootPid: 547,
        rootExited: false,
        captureComplete: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects initial ownership expansion when a pending exit watcher proves the root stopped", async () => {
    const captureStarted = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const supervisor = superviseEffectProcessTree(
      {
        pid: 545,
        exitCode: Effect.never,
        isRunning: Effect.succeed(false),
      },
      {
        processTreeKiller: {
          capture: () => {
            throw new Error("synchronous capture must not run");
          },
          captureAsync: async () => {
            captureStarted.resolve();
            await releaseCapture.promise;
            return {
              root: {
                pid: 545,
                command: "reused process",
                identity: "545:reused-start",
              },
              descendants: [
                {
                  pid: 546,
                  command: "unrelated child",
                  identity: "546:unrelated-start",
                },
              ],
              captureComplete: true,
            };
          },
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        platform: "win32",
        capturePollMs: 60_000,
        proofTimeoutMs: 5,
      },
    );

    await captureStarted.promise;
    releaseCapture.resolve();

    await expect(supervisor.waitForInitialCapture()).rejects.toMatchObject({
      remainingDescendantPids: [],
      captureComplete: false,
    });
  });

  it("accepts initial ownership when a failed exit watcher still proves the root is running", async () => {
    const captureStarted = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<never>();
    const root: CapturedProcess = {
      pid: 540,
      command: "owned process",
      identity: "540:owned-start",
    };
    const supervisor = superviseEffectProcessTree(
      {
        pid: 540,
        exitCode: Effect.promise(() => exit.promise),
        isRunning: Effect.succeed(true),
      },
      {
        processTreeKiller: {
          capture: () => {
            throw new Error("synchronous capture must not run");
          },
          captureAsync: async () => {
            captureStarted.resolve();
            await releaseCapture.promise;
            return { root, descendants: [], captureComplete: true };
          },
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        platform: "win32",
        capturePollMs: 60_000,
        proofTimeoutMs: 5,
      },
    );

    await captureStarted.promise;
    exit.reject(new Error("exit watcher failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseCapture.resolve();

    await expect(supervisor.waitForInitialCapture()).resolves.toBeUndefined();
  });

  it("discards rootless Windows captures instead of adopting unproven descendants", async () => {
    const owned = controllableEffectProcess(541);
    const ownedRoot: CapturedProcess = {
      pid: 541,
      command: "provider updater",
      identity: "541:owned-start",
    };
    const unrelatedDescendant: CapturedProcess = {
      pid: 542,
      command: "unrelated child",
      identity: "542:unrelated-start",
    };
    let captureCalls = 0;
    let teardownTree: CapturedProcessTree | undefined;
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => {
          throw new Error("synchronous capture must not run");
        },
        captureAsync: async () => {
          captureCalls += 1;
          return captureCalls === 1
            ? { root: ownedRoot, descendants: [], captureComplete: true }
            : { descendants: [unrelatedDescendant], captureComplete: true };
        },
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      teardownProcessTree: async (input) => {
        teardownTree = input.capturedTree;
        return { escalated: false, signalErrors: [] };
      },
      platform: "win32",
      capturePollMs: 60_000,
    });

    await supervisor.waitForInitialCapture();
    await supervisor.captureNow();
    await supervisor.teardown();

    expect(teardownTree).toEqual({
      root: ownedRoot,
      descendants: [],
      captureComplete: false,
    });
  });

  it("retains rootless descendants captured through an explicitly owned POSIX group", async () => {
    const owned = controllableEffectProcess(551);
    const ownedRoot: CapturedProcess = {
      pid: 551,
      command: "provider updater",
      identity: "551:owned-start",
      groupId: 551,
    };
    const groupDescendant: CapturedProcess = {
      pid: 552,
      command: "provider worker",
      identity: "552:worker-start",
      groupId: 551,
    };
    let captureCalls = 0;
    let teardownTree: CapturedProcessTree | undefined;
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => {
          throw new Error("synchronous capture must not run");
        },
        captureAsync: async (_rootPid, options) => {
          expect(options).toEqual({ processGroupId: 551 });
          captureCalls += 1;
          return captureCalls === 1
            ? { root: ownedRoot, descendants: [], captureComplete: true }
            : { descendants: [groupDescendant], captureComplete: true };
        },
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      teardownProcessTree: async (input) => {
        teardownTree = input.capturedTree;
        return { escalated: false, signalErrors: [] };
      },
      platform: "linux",
      ownedProcessGroupId: 551,
      capturePollMs: 60_000,
    });

    await supervisor.waitForInitialCapture();
    await supervisor.captureNow();
    await supervisor.teardown();

    expect(teardownTree).toEqual({
      root: ownedRoot,
      descendants: [groupDescendant],
      captureComplete: true,
    });
  });

  it("does not adopt a rootless POSIX group after identity continuity is lost", async () => {
    const owned = controllableEffectProcess(561);
    const ownedRoot: CapturedProcess = {
      pid: 561,
      command: "provider updater",
      identity: "561:owned-start",
      groupId: 561,
    };
    const reusedGroupMember: CapturedProcess = {
      pid: 562,
      command: "unrelated process",
      identity: "562:unrelated-start",
      groupId: 561,
    };
    let captureCalls = 0;
    let teardownTree: CapturedProcessTree | undefined;
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => {
          throw new Error("synchronous capture must not run");
        },
        captureAsync: async () => {
          captureCalls += 1;
          return captureCalls === 1
            ? { root: ownedRoot, descendants: [], captureComplete: true }
            : { descendants: [reusedGroupMember], captureComplete: true };
        },
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      teardownProcessTree: async (input) => {
        teardownTree = input.capturedTree;
        return { escalated: false, signalErrors: [] };
      },
      platform: "linux",
      ownedProcessGroupId: 561,
      capturePollMs: 60_000,
    });

    await supervisor.waitForInitialCapture();
    owned.exit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await supervisor.captureNow();
    await supervisor.teardown();

    expect(teardownTree).toEqual({
      root: ownedRoot,
      descendants: [],
      captureComplete: false,
    });
  });

  it("bounds background ownership capture to one delayed startup refresh", async () => {
    const owned = controllableEffectProcess(551);
    const root: CapturedProcess = {
      pid: 551,
      command: "provider session",
      identity: "551:root-start",
    };
    let releaseStartupCapture: (() => void) | undefined;
    const startupCaptureDelay = new Promise<void>((resolve) => {
      releaseStartupCapture = resolve;
    });
    let asynchronousCaptures = 0;
    const tree = { root, descendants: [], captureComplete: true };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => tree,
        captureAsync: async () => {
          asynchronousCaptures += 1;
          return tree;
        },
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      platform: "win32",
      sleep: () => startupCaptureDelay,
    });

    await supervisor.waitForInitialCapture();
    expect(asynchronousCaptures).toBe(1);
    releaseStartupCapture?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(asynchronousCaptures).toBe(2);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(asynchronousCaptures).toBe(2);
    owned.exit();
    await expect(supervisor.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(asynchronousCaptures).toBe(3);
  });

  it("starts ownership capture asynchronously and makes teardown await its completion", async () => {
    const owned = controllableEffectProcess(575);
    const root: CapturedProcess = {
      pid: 575,
      command: "provider session",
      identity: "575:root-start",
    };
    let releaseCapture: (() => void) | undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let synchronousCaptures = 0;
    let teardownCalls = 0;
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => {
          synchronousCaptures += 1;
          throw new Error("synchronous capture must not run");
        },
        captureAsync: async () => {
          await captureGate;
          return { root, descendants: [], captureComplete: true };
        },
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      teardownProcessTree: async () => {
        teardownCalls += 1;
        return { escalated: false, signalErrors: [] };
      },
      platform: "win32",
      capturePollMs: 60_000,
    });

    const teardown = supervisor.teardown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(synchronousCaptures).toBe(0);
    expect(teardownCalls).toBe(0);

    releaseCapture?.();
    await expect(teardown).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(teardownCalls).toBe(1);
  });

  it("retains incomplete ownership after an initial asynchronous capture failure", async () => {
    const owned = controllableEffectProcess(576);
    const initialFailure = new Error("initial snapshot failed");
    let captureCalls = 0;
    let teardownTree: CapturedProcessTree | undefined;
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => {
          throw new Error("synchronous capture must not run");
        },
        captureAsync: async () => {
          captureCalls += 1;
          if (captureCalls === 1) throw initialFailure;
          return {
            root: {
              pid: 576,
              command: "provider session",
              identity: "576:root-start",
            },
            descendants: [],
            captureComplete: true,
          };
        },
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      teardownProcessTree: async (input) => {
        teardownTree = input.capturedTree;
        return { escalated: false, signalErrors: [] };
      },
      platform: "win32",
      capturePollMs: 60_000,
    });

    await expect(supervisor.waitForInitialCapture()).rejects.toBe(initialFailure);
    await expect(supervisor.teardown()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(teardownTree).toMatchObject({ captureComplete: false });
  });

  it("retains incomplete ownership when asynchronous capture throws synchronously", async () => {
    const owned = controllableEffectProcess(577);
    const initialFailure = new Error("synchronous initial snapshot failure");
    let captureCalls = 0;
    let teardownTree: CapturedProcessTree | undefined;
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => {
          throw new Error("synchronous capture fallback must not run");
        },
        captureAsync: () => {
          captureCalls += 1;
          throw initialFailure;
        },
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      teardownProcessTree: async (input) => {
        teardownTree = input.capturedTree;
        return { escalated: false, signalErrors: [] };
      },
      platform: "win32",
      capturePollMs: 60_000,
    });

    expect(captureCalls).toBe(0);
    await expect(supervisor.waitForInitialCapture()).rejects.toBe(initialFailure);
    await expect(supervisor.teardown()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(captureCalls).toBe(2);
    expect(teardownTree).toMatchObject({ captureComplete: false });
  });

  it("uses the injected process-tree killer for default teardown signalling", async () => {
    const owned = controllableEffectProcess(2_147_483_647);
    const root: CapturedProcess = {
      pid: 2_147_483_647,
      command: "synthetic provider",
      identity: "2147483647:root-start",
    };
    const signals: TerminalKillSignal[] = [];
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => ({ root, descendants: [], captureComplete: true }),
        inspect: () => ({ verified: true, survivors: [] }),
        signal: ({ signal }) => {
          signals.push(signal);
          owned.exit();
        },
      },
      platform: "win32",
      capturePollMs: 60_000,
    });

    await expect(supervisor.teardown()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("accepts normal root success when every live-captured descendant is gone", async () => {
    const owned = controllableEffectProcess(601);
    const root: CapturedProcess = {
      pid: 601,
      command: "provider updater",
      identity: "601:root-start",
    };
    const child: CapturedProcess = {
      pid: 602,
      command: "provider postinstall",
      identity: "602:child-start",
    };
    let rootAlive = true;
    let childAlive = true;
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({
        ...(rootAlive ? { root } : {}),
        descendants: childAlive ? [child] : [],
        captureComplete: true,
      }),
      captureAsync: async () => ({
        ...(rootAlive ? { root } : {}),
        descendants: childAlive ? [child] : [],
        captureComplete: true,
      }),
      inspect: (tree) => ({
        verified: true,
        survivors: childAlive ? tree.descendants.filter(({ pid }) => pid === child.pid) : [],
      }),
      signal: () => undefined,
    };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller,
      platform: "win32",
      capturePollMs: 1,
      proofTimeoutMs: 5,
    });

    await supervisor.waitForInitialCapture();
    rootAlive = false;
    childAlive = false;
    owned.exit();

    await expect(supervisor.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
  });

  it("proves a signal-driven exit after the owned handle reports it stopped", async () => {
    const root: CapturedProcess = {
      pid: 651,
      command: "provider updater",
      identity: "651:root-start",
    };
    let rootAlive = true;
    let rejectExit!: (reason: Error) => void;
    const exitCode = new Promise<never>((_resolve, reject) => {
      rejectExit = reject;
    });
    const supervisor = superviseEffectProcessTree(
      {
        pid: 651,
        exitCode: Effect.promise(() => exitCode),
        isRunning: Effect.sync(() => rootAlive),
      },
      {
        processTreeKiller: {
          capture: () => ({ ...(rootAlive ? { root } : {}), descendants: [] }),
          captureAsync: async () => ({ ...(rootAlive ? { root } : {}), descendants: [] }),
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        platform: "win32",
        capturePollMs: 1,
        proofTimeoutMs: 5,
      },
    );

    await supervisor.waitForInitialCapture();
    rootAlive = false;
    rejectExit(new Error("Process interrupted due to receipt of signal: 'SIGTERM'"));
    await expect(supervisor.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
  });

  it("fails closed on POSIX when the updater has no explicitly owned process group", async () => {
    const owned = controllableEffectProcess(701);
    let rootAlive = true;
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({
        ...(rootAlive
          ? {
              root: {
                pid: 701,
                command: "provider updater",
                identity: "701:root-start",
              },
            }
          : {}),
        descendants: [],
        captureComplete: true,
      }),
      inspect: () => ({ verified: true, survivors: [] }),
      signal: () => undefined,
    };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller,
      platform: "linux",
      capturePollMs: 1,
      proofTimeoutMs: 5,
    });

    rootAlive = false;
    owned.exit();
    const failure = await supervisor.proveExit().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 701,
      rootExited: true,
      remainingDescendantPids: [],
      captureComplete: false,
    });
  });

  it("keeps teardown single-flight while pending and retries a rejected proof", async () => {
    const owned = controllableEffectProcess(801);
    const root: CapturedProcess = {
      pid: 801,
      command: "provider updater",
      identity: "801:root-start",
    };
    const child: CapturedProcess = {
      pid: 802,
      command: "provider postinstall",
      identity: "802:child-start",
    };
    const capturedTrees: CapturedProcessTree[] = [];
    let releaseFirstAttempt: (() => void) | undefined;
    const firstAttemptGate = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    let teardownAttempts = 0;
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => ({ root, descendants: [child], captureComplete: true }),
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      teardownProcessTree: async (input) => {
        teardownAttempts += 1;
        capturedTrees.push(input.capturedTree ?? { descendants: [], captureComplete: false });
        if (teardownAttempts === 1) {
          await firstAttemptGate;
          throw new ProviderProcessExitUnprovenError({
            rootPid: 801,
            rootExited: false,
            remainingDescendantPids: [802],
            captureComplete: true,
          });
        }
        return { escalated: false, signalErrors: [] };
      },
      platform: "win32",
      capturePollMs: 1,
    });

    const first = supervisor.teardown();
    const concurrent = supervisor.teardown();
    expect(concurrent).toBe(first);
    releaseFirstAttempt?.();
    await expect(first).rejects.toBeInstanceOf(ProviderProcessExitUnprovenError);
    await expect(concurrent).rejects.toBeInstanceOf(ProviderProcessExitUnprovenError);

    const retry = supervisor.teardown();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(supervisor.teardown()).toBe(retry);
    expect(teardownAttempts).toBe(2);
    expect(capturedTrees).toHaveLength(2);
    expect(capturedTrees[0]?.descendants).toContainEqual(child);
    expect(capturedTrees[1]?.descendants).toContainEqual(child);
  });
});
