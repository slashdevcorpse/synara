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
          },
        ],
      ]),
    );
  });

  it("validates captured child commands before delayed SIGKILL", () => {
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
      readCurrentProcesses: (pids) => {
        commandReadCalls.push([...pids]);
        return new Map([
          [102, { pid: 102, parentPid: 100, command: "bun run dev" }],
          [103, { pid: 103, parentPid: 100, command: "node unrelated-process.js" }],
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
    expect(treeSignals).toEqual([{ rootPid: 100, signal: "SIGKILL" }]);
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

  it("does not validate captured child commands before initial SIGTERM", () => {
    const signaledPids: number[] = [];
    const killer = createProcessTreeKiller({
      readCurrentProcesses: () => {
        throw new Error("SIGTERM should not read current commands");
      },
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
          { pid: 102, command: "bun run dev" },
          { pid: 103, command: "tsdown --watch" },
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
        new Map([[103, { pid: 103, parentPid: 100, command: "tsdown --watch" }]]),
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
        descendants: [{ pid: 103, command: "tsdown --watch" }],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([103]);
    expect(treeSignals).toEqual([]);
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
