// FILE: processTreeKiller.test.ts
// Purpose: Verifies PTY process-tree capture and safe descendant signaling.
// Layer: Terminal infrastructure tests
// Depends on: Vitest and injectable processTreeKiller dependencies.
import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

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

    await killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: false,
      tree: {
        descendants: [
          { pid: 101, command: "provider.exe" },
          { pid: 102, command: "worker.exe" },
        ],
        captureComplete: true,
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([101]);
  });

  it("validates captured child commands before delayed SIGKILL", async () => {
    const signaledPids: Array<{ pid: number; signal: TerminalKillSignal }> = [];
    const treeSignals: Array<{ rootPid: number; signal: TerminalKillSignal }> = [];
    const commandReadCalls: number[][] = [];
    const tree: CapturedProcessTree = {
      descendants: [
        { pid: 102, command: "bun run dev" },
        { pid: 103, command: "tsdown --watch" },
      ],
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
      signal: "SIGKILL",
      tree,
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([{ pid: 102, signal: "SIGKILL" }]);
    expect(commandReadCalls).toEqual([[102, 103]]);
    expect(treeSignals).toEqual([{ rootPid: 100, signal: "SIGKILL" }]);
  });

  it("does not validate captured child commands before initial SIGTERM", async () => {
    const signaledPids: number[] = [];
    const killer = createProcessTreeKiller({
      platform: "linux",
      readCurrentCommands: () => {
        throw new Error("SIGTERM should not read current commands");
      },
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(null),
    });

    await killer.signal({
      rootPid: 100,
      signal: "SIGTERM",
      tree: {
        descendants: [
          { pid: 102, command: "bun run dev" },
          { pid: 103, command: "tsdown --watch" },
        ],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([103, 102]);
  });

  it("waits for root tree signaling while preserving callback error reporting", async () => {
    const treeKillError = new Error("tree kill failed");
    const errors: Array<{
      error: Error;
      context: { pid: number; source: "tree-kill" | "captured" };
    }> = [];
    let completeSignalTree: ((error?: Error | null) => void) | undefined;
    const killer = createProcessTreeKiller({
      platform: "linux",
      signalTree: (_rootPid, _signal, callback) => {
        completeSignalTree = callback;
      },
    });

    let settled = false;
    const signaling = Promise.resolve(
      killer.signal({
        rootPid: 100,
        signal: "SIGTERM",
        tree: { descendants: [] },
        onError: (error, context) => errors.push({ error, context }),
      }),
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(completeSignalTree).toBeTypeOf("function");
    expect(settled).toBe(false);
    completeSignalTree?.(treeKillError);
    await signaling;

    expect(settled).toBe(true);
    expect(errors).toEqual([
      {
        error: treeKillError,
        context: { pid: 100, source: "tree-kill" },
      },
    ]);
  });

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

    await killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: false,
      tree: {
        descendants: [{ pid: 103, command: "tsdown --watch" }],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([103]);
    expect(treeSignals).toEqual([]);
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
