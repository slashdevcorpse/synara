// FILE: processTreeKiller.test.ts
// Purpose: Verifies PTY process-tree capture and safe descendant signaling.
// Layer: Terminal infrastructure tests
// Depends on: Vitest and injectable processTreeKiller dependencies.
import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  collectDescendantProcesses,
  createProcessTreeKiller,
  parseProcessCommandMap,
  type CapturedProcessTree,
  type ProcessChildrenMap,
  type TerminalKillSignal,
} from "./processTreeKiller";

describe("processTreeKiller", () => {
  it("collects nested process-tree descendants in parent-first order", () => {
    const childrenByParentPid: ProcessChildrenMap = new Map([
      [
        100,
        [
          { pid: 101, command: "zsh" },
          { pid: 102, command: "bun run dev" },
        ],
      ],
      [102, [{ pid: 103, command: "tsdown --watch" }]],
    ]);

    expect(collectDescendantProcesses(100, childrenByParentPid)).toEqual([
      { pid: 101, command: "zsh" },
      { pid: 102, command: "bun run dev" },
      { pid: 103, command: "tsdown --watch" },
    ]);
  });

  it("parses current command snapshots with command arguments intact", () => {
    expect(
      parseProcessCommandMap(`
        102 bun run dev -- --watch
        103 /bin/zsh -l
      `),
    ).toEqual(
      new Map([
        [102, "bun run dev -- --watch"],
        [103, "/bin/zsh -l"],
      ]),
    );
  });

  it("captures nested Windows descendants from the shared process snapshot", async () => {
    const killer = createProcessTreeKiller({
      platform: "win32",
      captureWindowsSnapshot: async () => ({
        kind: "ok",
        processCount: 3,
        childrenByParentPid: new Map([
          [100, [{ pid: 101, command: "provider.exe" }]],
          [101, [{ pid: 102, command: "worker.exe --serve" }]],
          [999, [{ pid: 1000, command: "unrelated.exe" }]],
        ]),
      }),
    });

    await expect(killer.capture(100)).resolves.toEqual({
      descendants: [
        { pid: 101, command: "provider.exe" },
        { pid: 102, command: "worker.exe --serve" },
      ],
      captureComplete: true,
      descendantExitProof: "captured-identities",
    });
  });

  it("fails capture closed when the bounded descendant walk is truncated", async () => {
    const children = Array.from({ length: 257 }, (_, index) => ({
      pid: index + 101,
      command: `worker-${index}`,
    }));
    const killer = createProcessTreeKiller({
      platform: "win32",
      captureWindowsSnapshot: async () => ({
        kind: "ok",
        processCount: children.length,
        childrenByParentPid: new Map([[100, children]]),
      }),
    });

    await expect(killer.capture(100)).resolves.toMatchObject({
      descendants: children.slice(0, 256),
      captureComplete: false,
      descendantExitProof: "captured-identities",
    });
  });

  it.each(["capture_failed", "timed_out"] as const)(
    "fails Windows capture closed when the snapshot is %s",
    async (reason) => {
      const killer = createProcessTreeKiller({
        platform: "win32",
        captureWindowsSnapshot: async () => ({ kind: "unknown", reason }),
      });

      await expect(killer.capture(100)).resolves.toEqual({
        descendants: [],
        captureComplete: false,
        descendantExitProof: "captured-identities",
      });
    },
  );

  it("re-inspects Windows descendants by captured command identity", async () => {
    const tree: CapturedProcessTree = {
      descendants: [
        { pid: 101, command: "provider.exe" },
        { pid: 102, command: "worker.exe --serve" },
      ],
      captureComplete: true,
      descendantExitProof: "captured-identities",
    };
    const killer = createProcessTreeKiller({
      platform: "win32",
      captureWindowsSnapshot: async () => ({
        kind: "ok",
        processCount: 2,
        childrenByParentPid: new Map([
          [1, [{ pid: 101, command: "provider.exe" }]],
          [2, [{ pid: 102, command: "reused-pid.exe" }]],
        ]),
      }),
    });

    await expect(killer.inspect?.(tree)).resolves.toEqual({
      verified: true,
      survivors: [{ pid: 101, command: "provider.exe" }],
    });
  });

  it("fails Windows inspection closed when the snapshot is unknown", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 101, command: "provider.exe" }],
      captureComplete: true,
      descendantExitProof: "captured-identities",
    };
    const killer = createProcessTreeKiller({
      platform: "win32",
      captureWindowsSnapshot: async () => ({ kind: "unknown", reason: "capture_failed" }),
    });

    await expect(killer.inspect?.(tree)).resolves.toEqual({
      verified: false,
      survivors: tree.descendants,
    });
  });

  it("revalidates Windows command identities before signaling captured PIDs", async () => {
    const signaledPids: number[] = [];
    const killer = createProcessTreeKiller({
      platform: "win32",
      captureWindowsSnapshot: async () => ({
        kind: "ok",
        processCount: 2,
        childrenByParentPid: new Map([
          [1, [{ pid: 101, command: "provider.exe" }]],
          [2, [{ pid: 102, command: "reused-pid.exe" }]],
        ]),
      }),
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: () => {
        throw new Error("The exited root tree must not be signaled.");
      },
    });

    const result = await killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: false,
      tree: {
        descendants: [
          { pid: 101, command: "provider.exe" },
          { pid: 102, command: "worker.exe" },
        ],
        captureComplete: true,
        descendantExitProof: "captured-identities",
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([101]);
    expect(result).toEqual({ rootTreeSignalSucceeded: false });
  });

  it("rechecks root ownership after delayed Windows identity preparation", async () => {
    const identityPreparationStarted = Promise.withResolvers<void>();
    const releaseIdentityPreparation = Promise.withResolvers<void>();
    const signaledPids: number[] = [];
    const treeSignals: number[] = [];
    let rootOwned = true;
    const killer = createProcessTreeKiller({
      platform: "win32",
      captureWindowsSnapshot: async () => {
        identityPreparationStarted.resolve();
        await releaseIdentityPreparation.promise;
        return {
          kind: "ok",
          processCount: 1,
          childrenByParentPid: new Map([[100, [{ pid: 101, command: "provider.exe" }]]]),
        };
      },
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (rootPid, _signal, callback) => {
        treeSignals.push(rootPid);
        callback(null);
      },
    });
    const signaling = killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: true,
      shouldSignalRootTree: () => rootOwned,
      tree: {
        descendants: [{ pid: 101, command: "provider.exe" }],
        captureComplete: true,
        descendantExitProof: "captured-identities",
      },
      onError: () => undefined,
    });

    await identityPreparationStarted.promise;
    rootOwned = false;
    releaseIdentityPreparation.resolve();
    await expect(signaling).resolves.toEqual({ rootTreeSignalSucceeded: false });

    expect(signaledPids).toEqual([101]);
    expect(treeSignals).toEqual([]);
  });

  it("marks POSIX captures as using identity-verified descendant proof", async () => {
    const killer = createProcessTreeKiller({
      platform: "linux",
      captureChildrenMap: () => new Map([[100, [{ pid: 101, command: "provider-worker" }]]]),
    });

    await expect(killer.capture(100)).resolves.toEqual({
      descendants: [{ pid: 101, command: "provider-worker" }],
      captureComplete: true,
      descendantExitProof: "captured-identities",
    });
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "validates captured child commands before %s",
    async (signal) => {
      const signaledPids: Array<{ pid: number; signal: TerminalKillSignal }> = [];
      const treeSignals: Array<{ rootPid: number; signal: TerminalKillSignal }> = [];
      const commandReadCalls: number[][] = [];
      const tree: CapturedProcessTree = {
        descendants: [
          { pid: 102, command: "bun run dev" },
          { pid: 103, command: "tsdown --watch" },
        ],
        descendantExitProof: "captured-identities",
      };
      const killer = createProcessTreeKiller({
        platform: "linux",
        readCurrentCommands: (pids) => {
          commandReadCalls.push([...pids]);
          return new Map([
            [102, "bun run dev"],
            [103, "node unrelated-process.js"],
          ]);
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

      await killer.signal({
        rootPid: 100,
        signal,
        tree,
        onError: () => undefined,
      });

      expect(signaledPids).toEqual([{ pid: 102, signal }]);
      expect(commandReadCalls).toEqual([[102, 103]]);
      expect(treeSignals).toEqual([{ rootPid: 100, signal }]);
    },
  );

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "does not directly signal captured PIDs when command inspection is unknown for %s",
    async (signal) => {
      const signaledPids: number[] = [];
      const commandReadCalls: number[][] = [];
      const killer = createProcessTreeKiller({
        platform: "linux",
        readCurrentCommands: (pids) => {
          commandReadCalls.push([...pids]);
          return null;
        },
        signalPid: (pid) => {
          signaledPids.push(pid);
          return null;
        },
        signalTree: () => {
          throw new Error("The exited root tree must not be signaled.");
        },
      });

      await expect(
        killer.signal({
          rootPid: 100,
          signal,
          includeRootTree: false,
          tree: {
            descendants: [
              { pid: 102, command: "bun run dev" },
              { pid: 103, command: "tsdown --watch" },
            ],
            descendantExitProof: "captured-identities",
          },
          onError: () => undefined,
        }),
      ).resolves.toEqual({ rootTreeSignalSucceeded: false });

      expect(commandReadCalls).toEqual([[102, 103]]);
      expect(signaledPids).toEqual([]);
    },
  );

  it("can skip root tree signaling while still signaling captured children", async () => {
    const signaledPids: number[] = [];
    const treeSignals: number[] = [];
    const killer = createProcessTreeKiller({
      platform: "linux",
      readCurrentCommands: () => new Map([[103, "tsdown --watch"]]),
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (rootPid, _signal, callback) => {
        treeSignals.push(rootPid);
        callback(null);
      },
    });

    const result = await killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: false,
      tree: {
        descendants: [{ pid: 103, command: "tsdown --watch" }],
        descendantExitProof: "captured-identities",
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([103]);
    expect(treeSignals).toEqual([]);
    expect(result).toEqual({ rootTreeSignalSucceeded: false });
  });

  it("waits for root-tree signal completion before reporting success", async () => {
    let completeSignal!: (error?: Error | null) => void;
    const signalStarted = Promise.withResolvers<void>();
    const errors: Error[] = [];
    const killer = createProcessTreeKiller({
      signalTree: (_rootPid, _signal, callback) => {
        completeSignal = callback;
        signalStarted.resolve();
      },
    });

    const signaling = killer.signal({
      rootPid: 100,
      signal: "SIGTERM",
      tree: { descendants: [], descendantExitProof: "captured-identities" },
      onError: (error) => errors.push(error),
    });
    let settled = false;
    void signaling.finally(() => {
      settled = true;
    });
    await signalStarted.promise;

    expect(settled).toBe(false);
    completeSignal(null);

    await expect(signaling).resolves.toEqual({ rootTreeSignalSucceeded: true });
    expect(errors).toEqual([]);
  });

  it("normalizes callback errors into a failed root-tree signal result", async () => {
    const failure = new Error("taskkill failed");
    const errors: Array<{
      error: Error;
      context: { pid: number; source: "tree-kill" | "captured" };
    }> = [];
    const killer = createProcessTreeKiller({
      signalTree: (_rootPid, _signal, callback) => callback(failure),
    });

    await expect(
      killer.signal({
        rootPid: 100,
        signal: "SIGKILL",
        tree: { descendants: [], descendantExitProof: "captured-identities" },
        onError: (error, context) => errors.push({ error, context }),
      }),
    ).resolves.toEqual({ rootTreeSignalSucceeded: false });
    expect(errors).toEqual([{ error: failure, context: { pid: 100, source: "tree-kill" } }]);
  });

  it("normalizes synchronous root-tree signal failures", async () => {
    const failure = new Error("signalTree threw");
    const onError = vi.fn();
    const killer = createProcessTreeKiller({
      signalTree: () => {
        throw failure;
      },
    });

    await expect(
      killer.signal({
        rootPid: 100,
        signal: "SIGKILL",
        tree: { descendants: [], descendantExitProof: "captured-identities" },
        onError,
      }),
    ).resolves.toEqual({ rootTreeSignalSucceeded: false });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure, { pid: 100, source: "tree-kill" });
  });

  it("settles when reporting a root-tree signal error throws", async () => {
    const reportingFailure = new Error("signal error reporter failed");
    const killer = createProcessTreeKiller({
      signalTree: (_rootPid, _signal, callback) => callback(new Error("taskkill failed")),
    });

    await expect(
      killer.signal({
        rootPid: 100,
        signal: "SIGKILL",
        tree: { descendants: [], descendantExitProof: "captured-identities" },
        onError: () => {
          throw reportingFailure;
        },
      }),
    ).rejects.toBe(reportingFailure);
  });

  it("allows a loaded Windows root-tree signal to complete after two seconds", async () => {
    vi.useFakeTimers();
    try {
      let completeSignal!: (error?: Error | null) => void;
      const onError = vi.fn();
      const killer = createProcessTreeKiller({
        platform: "win32",
        signalTree: (_rootPid, _signal, callback) => {
          completeSignal = callback;
        },
      });
      const signaling = killer.signal({
        rootPid: 100,
        signal: "SIGKILL",
        tree: { descendants: [], descendantExitProof: "root-tree-signal" },
        onError,
      });
      let settled = false;
      void signaling.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(2_001);
      expect(settled).toBe(false);
      expect(onError).not.toHaveBeenCalled();

      completeSignal(null);

      await expect(signaling).resolves.toEqual({ rootTreeSignalSucceeded: true });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stalled Windows root-tree signal and ignores its late callback", async () => {
    vi.useFakeTimers();
    try {
      let completeSignal!: (error?: Error | null) => void;
      const onError = vi.fn();
      const killer = createProcessTreeKiller({
        platform: "win32",
        signalTree: (_rootPid, _signal, callback) => {
          completeSignal = callback;
        },
      });
      const signaling = killer.signal({
        rootPid: 100,
        signal: "SIGKILL",
        tree: { descendants: [], descendantExitProof: "captured-identities" },
        onError,
      });
      let settled = false;
      void signaling.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      await expect(signaling).resolves.toEqual({ rootTreeSignalSucceeded: false });
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]?.[0]).toMatchObject({
        message: expect.stringContaining("Timed out after"),
      });
      completeSignal(new Error("late taskkill failure"));
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

it.runIf(process.platform === "win32")(
  "captures a native Windows child as a descendant of this process",
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");

    try {
      const tree = await createProcessTreeKiller().capture(process.pid);

      expect(tree.descendantExitProof).toBe("captured-identities");

      if (tree.captureComplete) {
        expect(tree.descendants.some((descendant) => descendant.pid === child.pid)).toBe(true);
      } else {
        // A busy shared test runner can legitimately exceed the bounded walk.
        // In that case the important contract is that capture fails closed.
        expect(tree.descendants).toHaveLength(256);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  },
  10_000,
);
