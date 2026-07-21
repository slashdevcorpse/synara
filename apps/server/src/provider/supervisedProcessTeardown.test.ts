import { describe, expect, it, vi } from "vitest";

import {
  createProcessTreeKiller,
  type CapturedProcess,
  type CapturedProcessTree,
  type ProcessTreeKiller,
  type ProcessTreeSignalResult,
  type TerminalKillSignal,
} from "../terminal/processTreeKiller";
import {
  ProviderProcessExitUnprovenError,
  teardownChildProcessTree,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown";
import { markWindowsProviderProcessSpawn } from "./windowsProviderProcess.ts";

function deterministicClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("teardownProviderProcessTree", () => {
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
            capture: () => ({
              descendants: [],
              captureComplete: true,
              descendantExitProof: "captured-identities",
            }),
            inspect: () => ({ verified: true, survivors: [] }),
            signal: async ({ signal, includeRootTree }) => {
              if (signal === "SIGTERM") resolveRootExit();
              return { rootTreeSignalSucceeded: includeRootTree === true };
            },
          },
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
  });

  it("escalates ignored TERM and returns only after root and descendants prove exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 102, command: "provider-worker" }],
      captureComplete: true,
      descendantExitProof: "captured-identities",
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
      signal: async ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGKILL") {
          runningDescendants.clear();
          resolveRootExit?.();
        }
        return { rootTreeSignalSucceeded: includeRootTree === true };
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
      descendantExitProof: "captured-identities",
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
      signal: async ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGTERM") resolveRootExit?.();
        if (signal === "SIGKILL") descendantsRunning = false;
        return { rootTreeSignalSucceeded: includeRootTree === true };
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
            capture: () => ({
              descendants: [],
              captureComplete: true,
              descendantExitProof: "captured-identities",
            }),
            inspect: () => {
              inspectCalls += 1;
              if (inspectCalls === 1) {
                gracefulInspectionStarted.resolve();
                return new Promise(() => undefined);
              }
              return { verified: true, survivors: [] };
            },
            signal: async ({ signal, includeRootTree }) => {
              signals.push(signal);
              if (signal === "SIGKILL") resolveRootExit?.();
              return { rootTreeSignalSucceeded: includeRootTree === true };
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
      const processTreeKiller = createProcessTreeKiller({
        platform: "linux",
        captureChildrenMap: () => new Map(),
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
        kind: "ok" as const,
        processCount: 2,
        childrenByParentPid: new Map([
          [1, [{ pid: 301, command: "provider-root.exe" }]],
          [301, [{ pid: 302, command: "provider-worker.exe" }]],
        ]),
      };
      let forcePreparationSignal: AbortSignal | undefined;
      let forcedSignaling: Promise<ProcessTreeSignalResult> | undefined;
      let snapshotCalls = 0;
      const windowsProcessTreeKiller = createProcessTreeKiller({
        platform: "win32",
        captureWindowsSnapshot: async (signal) => {
          snapshotCalls += 1;
          if (snapshotCalls === 3) {
            forcePreparationSignal = signal;
            forcePreparationStarted.resolve();
            await releaseForcePreparation.promise;
            return snapshot;
          }
          if (snapshotCalls > 3) {
            return { kind: "unknown", reason: "capture_failed" };
          }
          return snapshot;
        },
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
          const signaling = Promise.resolve(windowsProcessTreeKiller.signal(input));
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
        descendantExitProof: "captured-identities",
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
            signal: async ({ signal, includeRootTree }) => {
              if (signal === "SIGKILL") resolveRootExit?.();
              return { rootTreeSignalSucceeded: includeRootTree === true };
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
        descendantExitProof: "captured-identities",
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
            signal: async ({ signal, includeRootTree }) => {
              signals.push(signal);
              if (signal === "SIGKILL") resolveRootExit?.();
              return { rootTreeSignalSucceeded: includeRootTree === true };
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
      descendantExitProof: "captured-identities",
    };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 301, rootExited: new Promise(() => undefined), termGraceMs: 5, forceExitMs: 5 },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: tree.descendants }),
          signal: async () => ({ rootTreeSignalSucceeded: false }),
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
    const rootExit = deferred<void>();
    const failure = await teardownProviderProcessTree(
      {
        rootPid: 401,
        rootExited: rootExit.promise,
        termGraceMs: 5,
        forceExitMs: 5,
      },
      {
        processTreeKiller: {
          capture: async () => ({
            descendants: [],
            captureComplete: false,
            descendantExitProof: "captured-identities",
          }),
          inspect: async () => ({ verified: true, survivors: [] }),
          signal: async () => {
            rootExit.resolve(undefined);
            return { rootTreeSignalSucceeded: false };
          },
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
      descendantExitProof: "captured-identities",
      rootTreeSignalSucceeded: false,
    });
  });

  it("does not capture or signal a root that exited before teardown starts", async () => {
    let captureCalls = 0;
    let signalCalls = 0;

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 351,
        rootExited: Promise.resolve(),
      },
      {
        processTreeKiller: {
          capture: () => {
            captureCalls += 1;
            throw new Error("capture must not run for an exited root");
          },
          signal: async () => {
            signalCalls += 1;
            throw new Error("signal must not run for an exited root");
          },
        },
      },
    ).catch((error: unknown) => error);

    expect(captureCalls).toBe(0);
    expect(signalCalls).toBe(0);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 351,
      rootExited: true,
      remainingDescendantPids: null,
      captureComplete: false,
      descendantExitProof: "not-captured",
      rootTreeSignalSucceeded: false,
    });
  });

  it("uses root-tree signaling instead of PID capture for an explicitly marked launcher", async () => {
    let captureCalls = 0;
    let signalCalls = 0;
    const rootExit = deferred<void>();

    await expect(
      teardownProviderProcessTree(
        {
          rootPid: 451,
          rootExited: rootExit.promise,
          descendantExitProof: "root-tree-signal",
          termGraceMs: 5,
          forceExitMs: 5,
        },
        {
          processTreeKiller: {
            capture: () => {
              captureCalls += 1;
              throw new Error("capture must not run for a marked Windows launcher");
            },
            inspect: () => ({ verified: true, survivors: [] }),
            signal: async ({ includeRootTree }) => {
              signalCalls += 1;
              rootExit.resolve(undefined);
              return { rootTreeSignalSucceeded: includeRootTree === true };
            },
          },
          ...deterministicClock(),
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(captureCalls).toBe(0);
    expect(signalCalls).toBe(1);
  });

  it("waits beyond the exit grace for delayed root-tree signal proof", async () => {
    let signalCalls = 0;
    const rootExit = deferred<void>();

    await expect(
      teardownProviderProcessTree(
        {
          rootPid: 452,
          rootExited: rootExit.promise,
          descendantExitProof: "root-tree-signal",
          termGraceMs: 5,
          forceExitMs: 5,
        },
        {
          processTreeKiller: {
            capture: () => {
              throw new Error("capture must not run for a marked Windows launcher");
            },
            inspect: () => ({ verified: true, survivors: [] }),
            signal: ({ signal }) => {
              signalCalls += 1;
              if (signal !== "SIGTERM") {
                return Promise.resolve({ rootTreeSignalSucceeded: false });
              }
              return new Promise((resolve) => {
                setTimeout(() => {
                  rootExit.resolve(undefined);
                  resolve({ rootTreeSignalSucceeded: true });
                }, 20);
              });
            },
          },
          ...deterministicClock(),
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(signalCalls).toBe(1);
  });

  it("propagates root-tree signal proof only for the exact marked child handle", async () => {
    const markedChild = {
      pid: 461,
      exitCode: null,
      signalCode: null,
      once: () => undefined,
      removeListener: () => undefined,
    };
    const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
    markWindowsProviderProcessSpawn(
      markedChild,
      {
        command: "C:\\Synara\\synara-windows-job-launcher.exe",
        args: [],
        shell: false,
        containment: "windows-job-object",
      },
      true,
    );

    await expect(teardownChildProcessTree(markedChild, teardown)).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(teardown).toHaveBeenCalledOnce();
    expect(teardown.mock.calls[0]?.[0]).toMatchObject({
      rootPid: 461,
      descendantExitProof: "root-tree-signal",
    });
  });

  it("does not signal when the root exits during asynchronous process-tree capture", async () => {
    const clock = deterministicClock();
    let releaseCapture: (() => void) | undefined;
    let resolveRootExit: (() => void) | undefined;
    const captureStarted = Promise.withResolvers<void>();
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    let signalCalls = 0;
    const processTreeKiller: ProcessTreeKiller = {
      capture: async () => {
        captureStarted.resolve();
        await new Promise<void>((resolve) => {
          releaseCapture = resolve;
        });
        return {
          descendants: [{ pid: 502, command: "unrelated-reused-root-child" }],
          captureComplete: true,
          descendantExitProof: "captured-identities",
        };
      },
      inspect: () => ({ verified: true, survivors: [] }),
      signal: async () => {
        signalCalls += 1;
        return { rootTreeSignalSucceeded: false };
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
      remainingDescendantPids: null,
      captureComplete: false,
      descendantExitProof: "not-captured",
      rootTreeSignalSucceeded: false,
    });
    expect(signalCalls).toBe(0);
  });

  it("waits for completed Windows root-tree signal proof after the root exits", async () => {
    const tree: CapturedProcessTree = {
      descendants: [],
      captureComplete: true,
      descendantExitProof: "root-tree-signal",
    };
    const rootExit = deferred<void>();
    const signalStarted = deferred<void>();
    const signalCompletion = deferred<ProcessTreeSignalResult>();
    let signalCalls = 0;
    const teardown = teardownProviderProcessTree(
      {
        rootPid: 601,
        rootExited: rootExit.promise,
        termGraceMs: 5,
        forceExitMs: 5,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => {
            signalCalls += 1;
            signalStarted.resolve(undefined);
            return signalCompletion.promise;
          },
        },
        ...deterministicClock(),
      },
    );
    let settled = false;
    void teardown.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await signalStarted.promise;

    expect(signalCalls).toBe(1);
    expect(settled).toBe(false);

    rootExit.resolve(undefined);
    signalCompletion.resolve({ rootTreeSignalSucceeded: true });
    await expect(teardown).resolves.toEqual({ escalated: false, signalErrors: [] });
  });

  it("fails closed when Windows root-tree signaling errors despite root exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [],
      captureComplete: true,
      descendantExitProof: "root-tree-signal",
    };
    const rootExit = deferred<void>();
    const signalFailure = new Error("taskkill failed");
    const signaling = createProcessTreeKiller({
      platform: "win32",
      signalTree: (_rootPid, _signal, callback) => {
        rootExit.resolve(undefined);
        callback(signalFailure);
      },
    });
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 701,
        rootExited: rootExit.promise,
        termGraceMs: 5,
        forceExitMs: 5,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: [] }),
          signal: signaling.signal,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 701,
      rootExited: true,
      remainingDescendantPids: [],
      descendantExitProof: "root-tree-signal",
      rootTreeSignalSucceeded: false,
    });
  });

  it("preserves POSIX captured-identity proof when root-tree signaling fails", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 802, command: "provider-worker" }],
      captureComplete: true,
      descendantExitProof: "captured-identities",
    };
    const rootExit = deferred<void>();
    const signalFailure = new Error("root signal failed");
    let descendantsRunning = true;

    await expect(
      teardownProviderProcessTree(
        {
          rootPid: 801,
          rootExited: rootExit.promise,
          termGraceMs: 5,
          forceExitMs: 5,
        },
        {
          processTreeKiller: {
            capture: () => tree,
            inspect: () => ({
              verified: true,
              survivors: descendantsRunning ? tree.descendants : [],
            }),
            signal: async ({ onError }) => {
              descendantsRunning = false;
              rootExit.resolve(undefined);
              onError(signalFailure, { pid: 801, source: "tree-kill" });
              return { rootTreeSignalSucceeded: false };
            },
          },
          ...deterministicClock(),
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [signalFailure] });
  });
});
