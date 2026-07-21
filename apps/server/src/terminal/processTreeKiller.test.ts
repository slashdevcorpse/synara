// FILE: processTreeKiller.test.ts
// Purpose: Verifies PTY process-tree capture and safe descendant signaling.
// Layer: Terminal infrastructure tests
// Depends on: Vitest and injectable processTreeKiller dependencies.
import { describe, expect, it } from "vitest";

import {
  collectDescendantProcesses,
  createProcessTreeKiller,
  parseProcessCommandMap,
  parsePosixProcessSnapshot,
  parseWindowsProcessSnapshot,
  type CapturedProcess,
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

  it("captures Windows-style children that retain an exited root as their parent", () => {
    const killer = createProcessTreeKiller({
      captureProcessSnapshot: () =>
        new Map([
          [
            202,
            {
              pid: 202,
              parentPid: 201,
              command: "node updater-child.js",
              identity: "202:20260720120000.000000-240",
            },
          ],
        ]),
    });

    expect(killer.capture(201)).toEqual({
      descendants: [
        {
          pid: 202,
          parentPid: 201,
          command: "node updater-child.js",
          identity: "202:20260720120000.000000-240",
        },
      ],
      captureComplete: true,
    });
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

  it("parses stable POSIX creation-time and process-group identities", () => {
    expect(
      parsePosixProcessSnapshot(
        "  101  100  101 Mon Jul 20 12:34:56 2026 node updater.js --child\n",
      ),
    ).toEqual(
      new Map([
        [
          101,
          {
            pid: 101,
            parentPid: 100,
            groupId: 101,
            command: "node updater.js --child",
            identity: "101:Mon Jul 20 12:34:56 2026",
            identityPrecision: "seconds",
          },
        ],
      ]),
    );
  });

  it("parses stable Windows CIM creation identities", () => {
    expect(
      parseWindowsProcessSnapshot(
        JSON.stringify({
          ProcessId: 202,
          ParentProcessId: 201,
          CreationDate: "2026-07-20T12:34:56.000000-04:00",
          CommandLine: "node updater-child.js",
          ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
          Name: "node.exe",
        }),
      ),
    ).toEqual(
      new Map([
        [
          202,
          {
            pid: 202,
            parentPid: 201,
            command: "node updater-child.js",
            identity: "202:2026-07-20T12:34:56.000000-04:00",
            identityPrecision: "exact",
          },
        ],
      ]),
    );
  });

  it("validates captured children without signalling an uncaptured root", () => {
    const signaledPids: Array<{ pid: number; signal: TerminalKillSignal }> = [];
    const treeSignals: Array<{ rootPid: number; signal: TerminalKillSignal }> = [];
    const commandReadCalls: number[][] = [];
    const tree: CapturedProcessTree = {
      descendants: [
        { pid: 102, command: "bun run dev", identity: "102:owned-start" },
        { pid: 103, command: "tsdown --watch", identity: "103:owned-start" },
      ],
    };
    const killer = createProcessTreeKiller({
      readCurrentProcesses: (pids) => {
        commandReadCalls.push([...pids]);
        return new Map([
          [
            102,
            {
              pid: 102,
              parentPid: 100,
              command: "bun run dev",
              identity: "102:owned-start",
            },
          ],
          [
            103,
            {
              pid: 103,
              parentPid: 100,
              command: "node unrelated-process.js",
              identity: "103:owned-start",
            },
          ],
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

    killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      tree,
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([{ pid: 102, signal: "SIGKILL" }]);
    expect(commandReadCalls).toEqual([[102, 103]]);
    expect(treeSignals).toEqual([]);
  });

  it("reports an exec-replaced POSIX process instance as a live survivor", () => {
    const captured: CapturedProcess = {
      pid: 103,
      groupId: 100,
      command: "node updater-wrapper.js",
      identity: "103:Mon Jul 20 12:34:56 2026",
      identityPrecision: "seconds",
    };
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () =>
        new Map([
          [
            captured.pid,
            {
              pid: captured.pid,
              parentPid: 1,
              groupId: captured.groupId,
              command: "provider updater --apply",
              identity: captured.identity,
              identityPrecision: captured.identityPrecision,
            },
          ],
        ]),
    });

    expect(killer.inspect?.({ descendants: [captured] })).toEqual({
      verified: true,
      survivors: [captured],
    });
  });

  it("refuses to signal an exec-replaced command for the same POSIX process instance", () => {
    const signaledPids: number[] = [];
    const captured: CapturedProcess = {
      pid: 103,
      groupId: 100,
      command: "node updater-wrapper.js",
      identity: "103:Mon Jul 20 12:34:56 2026",
      identityPrecision: "seconds",
    };
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () =>
        new Map([
          [
            captured.pid,
            {
              pid: captured.pid,
              parentPid: 1,
              groupId: captured.groupId,
              command: "provider updater --apply",
              identity: captured.identity,
              identityPrecision: captured.identityPrecision,
            },
          ],
        ]),
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(null),
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: false,
      tree: { descendants: [captured] },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([]);
  });

  it("does not TERM a reused PID whose stable creation identity changed", () => {
    const signaledPids: number[] = [];
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () =>
        new Map([
          [
            102,
            {
              pid: 102,
              parentPid: 100,
              command: "provider worker",
              identity: "102:new-process-start",
            },
          ],
        ]),
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(null),
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGTERM",
      includeRootTree: false,
      tree: {
        descendants: [
          {
            pid: 102,
            command: "provider worker",
            identity: "102:owned-process-start",
          },
        ],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([]);
  });

  it("does not signal a reused root PID whose stable creation identity changed", () => {
    const treeSignals: number[] = [];
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () =>
        new Map([
          [
            100,
            {
              pid: 100,
              parentPid: 1,
              command: "unrelated root",
              identity: "100:new-process-start",
            },
          ],
        ]),
      signalTree: (rootPid, _signal, callback) => {
        treeSignals.push(rootPid);
        callback(null);
      },
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGTERM",
      tree: {
        root: {
          pid: 100,
          command: "provider root",
          identity: "100:owned-process-start",
        },
        descendants: [],
      },
      onError: () => undefined,
    });

    expect(treeSignals).toEqual([]);
  });

  it("validates captured child identity and command before initial SIGTERM", () => {
    const signaledPids: number[] = [];
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () =>
        new Map([
          [
            102,
            {
              pid: 102,
              parentPid: 100,
              command: "bun run dev",
              identity: "102:owned-start",
            },
          ],
          [
            103,
            {
              pid: 103,
              parentPid: 100,
              command: "tsdown --watch",
              identity: "103:owned-start",
            },
          ],
        ]),
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(null),
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGTERM",
      tree: {
        descendants: [
          { pid: 102, command: "bun run dev", identity: "102:owned-start" },
          { pid: 103, command: "tsdown --watch", identity: "103:owned-start" },
        ],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([103, 102]);
  });

  it("can skip root tree signaling while still signaling captured children", () => {
    const signaledPids: number[] = [];
    const treeSignals: number[] = [];
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () =>
        new Map([
          [
            103,
            {
              pid: 103,
              parentPid: 100,
              command: "tsdown --watch",
              identity: "103:owned-start",
            },
          ],
        ]),
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (rootPid, _signal, callback) => {
        treeSignals.push(rootPid);
        callback(null);
      },
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: false,
      tree: {
        descendants: [{ pid: 103, command: "tsdown --watch", identity: "103:owned-start" }],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([103]);
    expect(treeSignals).toEqual([]);
  });

  it("refuses same-second POSIX PID reuse outside the captured process group", () => {
    const signaledPids: number[] = [];
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () =>
        new Map([
          [
            103,
            {
              pid: 103,
              parentPid: 1,
              groupId: 999,
              command: "provider worker",
              identity: "103:Mon Jul 20 12:34:56 2026",
              identityPrecision: "seconds",
            },
          ],
        ]),
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(null),
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGTERM",
      includeRootTree: false,
      tree: {
        descendants: [
          {
            pid: 103,
            groupId: 100,
            command: "provider worker",
            identity: "103:Mon Jul 20 12:34:56 2026",
            identityPrecision: "seconds",
          },
        ],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([]);
  });

  it("refuses to signal a captured PID without a stable creation identity", () => {
    const signaledPids: number[] = [];
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () =>
        new Map([[103, { pid: 103, parentPid: 100, command: "provider worker" }]]),
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(null),
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: false,
      tree: { descendants: [{ pid: 103, command: "provider worker" }] },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([]);
  });

  it("uses the asynchronous snapshot path for asynchronous signaling", async () => {
    const signaledPids: number[] = [];
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () => {
        throw new Error("synchronous process-table read must not run");
      },
      captureProcessSnapshotAsync: async () =>
        new Map([
          [
            103,
            {
              pid: 103,
              parentPid: 100,
              command: "provider worker",
              identity: "103:owned-start",
            },
          ],
        ]),
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(null),
    });

    await killer.signalAsync?.({
      rootPid: 100,
      signal: "SIGTERM",
      includeRootTree: false,
      tree: {
        descendants: [{ pid: 103, command: "provider worker", identity: "103:owned-start" }],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([103]);
  });

  it("waits for asynchronous root-tree signaling to invoke its completion callback", async () => {
    const root = {
      pid: 100,
      parentPid: 1,
      command: "provider root",
      identity: "100:owned-start",
    };
    let completeTreeSignal!: () => void;
    let markTreeSignalStarted!: () => void;
    const treeSignalStarted = new Promise<void>((resolve) => {
      markTreeSignalStarted = resolve;
    });
    const killer = createProcessTreeKiller({
      captureProcessSnapshotAsync: async () => new Map([[root.pid, root]]),
      signalTree: (_rootPid, _signal, callback) => {
        completeTreeSignal = () => callback(null);
        markTreeSignalStarted();
      },
    });
    let signalSettled = false;

    const signaling = killer.signalAsync!({
      rootPid: root.pid,
      signal: "SIGKILL",
      tree: { root, descendants: [], captureComplete: true },
      onError: () => undefined,
    }).then(() => {
      signalSettled = true;
    });

    await treeSignalStarted;
    expect(signalSettled).toBe(false);
    completeTreeSignal();
    await signaling;
    expect(signalSettled).toBe(true);
  });

  it("captures reparented POSIX members through an explicitly owned process group", () => {
    const killer = createProcessTreeKiller({
      captureProcessSnapshot: () =>
        new Map([
          [
            302,
            {
              pid: 302,
              parentPid: 1,
              groupId: 301,
              command: "node postinstall.js",
              identity: "302:Mon Jul 20 12:34:56 2026",
            },
          ],
        ]),
    });

    expect(killer.capture(301, { processGroupId: 301 })).toMatchObject({
      descendants: [
        {
          pid: 302,
          groupId: 301,
          identity: "302:Mon Jul 20 12:34:56 2026",
        },
      ],
      captureComplete: true,
    });
  });

  it("marks capture incomplete when descendant traversal reaches its safety cap", () => {
    const snapshot = new Map();
    snapshot.set(401, {
      pid: 401,
      parentPid: 1,
      command: "provider root",
      identity: "401:root-start",
    });
    for (let offset = 1; offset <= 257; offset += 1) {
      const pid = 401 + offset;
      snapshot.set(pid, {
        pid,
        parentPid: pid - 1,
        command: `provider child ${offset}`,
        identity: `${pid}:child-start`,
      });
    }
    const killer = createProcessTreeKiller({ captureProcessSnapshot: () => snapshot });

    expect(killer.capture(401)).toMatchObject({
      captureComplete: false,
      descendants: expect.arrayContaining([
        expect.objectContaining({ pid: 402 }),
        expect.objectContaining({ pid: 657 }),
      ]),
    });
  });
});
