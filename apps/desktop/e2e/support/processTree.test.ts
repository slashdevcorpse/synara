// FILE: processTree.test.ts
// Purpose: Verifies process identity classification used by packaged desktop teardown.

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ElectronApplication } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import {
  classifyProcessAncestry,
  classifyProcessIdentity,
  closeElectronApplication,
  collectDescendants,
  mergeTrackedProcesses,
  parseLinuxProcessStat,
  type ProcessTreeDependencies,
  type ProcessSnapshotRow,
  type TrackedProcess,
} from "./processTree";

const expectedProcess = {
  pid: 42,
  identity: "windows:start-a",
  commandFingerprint: "command-a",
} satisfies TrackedProcess;

function processRow(overrides: Partial<ProcessSnapshotRow> = {}): ProcessSnapshotRow {
  return {
    pid: expectedProcess.pid,
    parentPid: 1,
    identity: expectedProcess.identity,
    commandFingerprint: expectedProcess.commandFingerprint,
    ...overrides,
  };
}

describe("classifyProcessIdentity", () => {
  it("recognizes the same process identity", () => {
    expect(classifyProcessIdentity(expectedProcess, processRow())).toBe("same");
  });

  it("recognizes an exited process", () => {
    expect(classifyProcessIdentity(expectedProcess, undefined)).toBe("gone");
  });

  it("recognizes a reused pid from a different creation identity", () => {
    expect(
      classifyProcessIdentity(expectedProcess, processRow({ identity: "windows:start-b" })),
    ).toBe("reused");
  });

  it("fails closed when creation identity evidence is missing", () => {
    expect(classifyProcessIdentity(expectedProcess, processRow({ identity: null }))).toBe(
      "unknown",
    );
  });

  it("fails closed when command identity evidence changes", () => {
    expect(
      classifyProcessIdentity(expectedProcess, processRow({ commandFingerprint: "command-b" })),
    ).toBe("unknown");
  });
});

describe("parseLinuxProcessStat", () => {
  it("derives ancestry and creation identity from one proc stat record", () => {
    const statFields = ["S", "7", ...Array.from({ length: 17 }, () => "0"), "12345"];
    const parsed = parseLinuxProcessStat(
      42,
      `42 (electron (renderer)) ${statFields.join(" ")}`,
      "boot-a",
    );

    expect(parsed).toMatchObject({
      pid: 42,
      parentPid: 7,
      identity: "linux:boot-a:12345",
    });
    expect(parsed.commandFingerprint).toMatch(/^[a-f\d]{64}$/u);
  });

  it("rejects a proc stat record for a different pid", () => {
    const statFields = ["S", "7", ...Array.from({ length: 17 }, () => "0"), "12345"];

    expect(() =>
      parseLinuxProcessStat(42, `43 (electron) ${statFields.join(" ")}`, "boot-a"),
    ).toThrow("malformed Linux stat data for pid 42");
  });
});

describe("classifyProcessAncestry", () => {
  it("accepts children created after their Windows parent", () => {
    expect(
      classifyProcessAncestry(
        { identity: "windows:2026-07-20T20:00:00.0000000Z" },
        { identity: "windows:2026-07-20T20:00:00.1000000Z" },
      ),
    ).toBe("valid");
  });

  it("rejects a stale Windows parent-pid relationship", () => {
    expect(
      classifyProcessAncestry(
        { identity: "windows:2026-07-20T20:00:00.1000000Z" },
        { identity: "windows:2026-07-20T20:00:00.0000000Z" },
      ),
    ).toBe("stale");
  });

  it("compares Linux start ticks within the same boot", () => {
    expect(
      classifyProcessAncestry({ identity: "linux:boot-a:100" }, { identity: "linux:boot-a:101" }),
    ).toBe("valid");
    expect(
      classifyProcessAncestry({ identity: "linux:boot-a:101" }, { identity: "linux:boot-a:100" }),
    ).toBe("stale");
  });

  it("fails closed when ancestry identity evidence is incompatible", () => {
    expect(
      classifyProcessAncestry({ identity: "linux:boot-a:100" }, { identity: "linux:boot-b:101" }),
    ).toBe("unknown");
    expect(classifyProcessAncestry({ identity: null }, { identity: "linux:boot-a:101" })).toBe(
      "unknown",
    );
  });
});

class FakeChildProcess extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  });

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

function fakeElectronApplication(
  child: FakeChildProcess,
  closeCalls?: string[],
): ElectronApplication {
  return {
    process: () => child as unknown as ChildProcess,
    close: vi.fn(async () => {
      closeCalls?.push("close");
    }),
  } as unknown as ElectronApplication;
}

function hangingElectronApplication(child: FakeChildProcess): ElectronApplication {
  return {
    process: () => child as unknown as ChildProcess,
    close: vi.fn(() => new Promise<never>(() => undefined)),
  } as unknown as ElectronApplication;
}

function windowsProcessRow(input: {
  pid: number;
  parentPid: number;
  startedAt: string;
  commandFingerprint: string;
  imageName?: string;
}): ProcessSnapshotRow {
  return {
    pid: input.pid,
    parentPid: input.parentPid,
    identity: `windows:${input.startedAt}`,
    commandFingerprint: input.commandFingerprint,
    ...(input.imageName ? { imageName: input.imageName } : {}),
  };
}

describe("desktop process teardown orchestration", () => {
  it("reports a graceful-close timeout after verified cleanup removes every process", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const child = new FakeChildProcess(91);
      const root = windowsProcessRow({
        pid: child.pid,
        parentPid: 1,
        startedAt: "2026-07-20T20:00:00.0000000Z",
        commandFingerprint: "root-command",
      });
      let terminated = false;
      const dependencies: ProcessTreeDependencies = {
        platform: "win32",
        readProcessSnapshot: vi.fn(() => (terminated ? [] : [root])),
        signalProcess: vi.fn(() => {
          terminated = true;
        }),
      };

      const result = closeElectronApplication(hangingElectronApplication(child), dependencies);
      const rejection = expect(result).rejects.toThrow(
        "Timed out while closing the Electron application.",
      );
      await vi.runAllTimersAsync();

      await rejection;
      expect(dependencies.signalProcess).toHaveBeenCalledWith(root.pid, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("identity-verified forced cleanup completed"),
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retains the graceful-close timeout when verified cleanup fails", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const child = new FakeChildProcess(96);
      const root = windowsProcessRow({
        pid: child.pid,
        parentPid: 1,
        startedAt: "2026-07-20T20:00:00.0000000Z",
        commandFingerprint: "root-command",
      });
      const dependencies: ProcessTreeDependencies = {
        platform: "win32",
        readProcessSnapshot: vi.fn(() => [root]),
        signalProcess: vi.fn(() => {
          throw new Error("signal denied");
        }),
      };

      const result = closeElectronApplication(hangingElectronApplication(child), dependencies).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();

      const error = await result;
      expect(error).toBeInstanceOf(AggregateError);
      const collectMessages = (causes: readonly unknown[]): string[] =>
        causes.flatMap((cause) =>
          cause instanceof AggregateError
            ? [cause.message, ...collectMessages(cause.errors)]
            : [cause instanceof Error ? cause.message : String(cause)],
        );
      const messages = collectMessages((error as AggregateError).errors);
      expect(messages).toContain("Timed out while closing the Electron application.");
      expect(messages.some((message) => message.includes("signal denied"))).toBe(true);
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("identity-verified forced cleanup completed"),
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not signal the child handle when later identity snapshots fail", async () => {
    const child = new FakeChildProcess(101);
    const root = windowsProcessRow({
      pid: child.pid,
      parentPid: 1,
      startedAt: "2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "root-command",
    });
    let snapshotCount = 0;
    const dependencies: ProcessTreeDependencies = {
      platform: "win32",
      readProcessSnapshot: vi.fn(() => {
        snapshotCount += 1;
        if (snapshotCount === 1) return [root];
        throw new Error("identity snapshot unavailable");
      }),
      signalProcess: vi.fn(),
    };

    await expect(
      closeElectronApplication(fakeElectronApplication(child), dependencies),
    ).rejects.toThrow("Electron close and process-tree cleanup");
    expect(child.kill).not.toHaveBeenCalled();
    expect(dependencies.signalProcess).not.toHaveBeenCalled();
  });

  it("continues targeted cleanup when a later full snapshot fails", async () => {
    const child = new FakeChildProcess(151);
    const root = windowsProcessRow({
      pid: child.pid,
      parentPid: 1,
      startedAt: "2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "root-command",
    });
    const descendant = windowsProcessRow({
      pid: 152,
      parentPid: root.pid,
      startedAt: "2026-07-20T20:00:00.1000000Z",
      commandFingerprint: "child-command",
    });
    let fullSnapshotCount = 0;
    const targetedSnapshots: number[][] = [];
    const signaledPids = new Set<number>();
    const signalProcess = vi.fn((pid: number) => {
      signaledPids.add(pid);
    });
    const dependencies: ProcessTreeDependencies = {
      platform: "win32",
      readProcessSnapshot: vi.fn((requestedPids) => {
        if (requestedPids) {
          targetedSnapshots.push([...requestedPids]);
          return [root, descendant].filter(
            ({ pid }) => requestedPids.includes(pid) && !signaledPids.has(pid),
          );
        }
        fullSnapshotCount += 1;
        if (fullSnapshotCount === 1) return [root, descendant];
        if (fullSnapshotCount === 2) throw new Error("late snapshot unavailable");
        return [];
      }),
      signalProcess,
    };

    await expect(
      closeElectronApplication(fakeElectronApplication(child), dependencies),
    ).rejects.toThrow("late snapshot unavailable");
    expect(signalProcess).toHaveBeenCalledWith(descendant.pid, "SIGKILL");
    expect(signalProcess).toHaveBeenCalledWith(root.pid, "SIGKILL");
    expect(targetedSnapshots.slice(0, 2)).toEqual([[descendant.pid], [root.pid]]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not signal the child handle after verification reports the root gone", async () => {
    const child = new FakeChildProcess(181);
    const root = windowsProcessRow({
      pid: child.pid,
      parentPid: 1,
      startedAt: "2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "root-command",
    });
    let fullSnapshotCount = 0;
    const dependencies: ProcessTreeDependencies = {
      platform: "win32",
      readProcessSnapshot: vi.fn((requestedPids) => {
        if (requestedPids) return [];
        fullSnapshotCount += 1;
        return fullSnapshotCount === 1 ? [root] : [];
      }),
      signalProcess: vi.fn(),
    };
    await expect(
      closeElectronApplication(fakeElectronApplication(child), dependencies),
    ).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not signal the child handle when the root pid was reused", async () => {
    const child = new FakeChildProcess(191);
    const root = windowsProcessRow({
      pid: child.pid,
      parentPid: 1,
      startedAt: "2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "root-command",
    });
    const reusedRoot = {
      ...root,
      identity: "windows:2026-07-20T20:00:01.0000000Z",
    };
    const dependencies: ProcessTreeDependencies = {
      platform: "win32",
      readProcessSnapshot: vi.fn((requestedPids) => (requestedPids ? [reusedRoot] : [root])),
      signalProcess: vi.fn(),
    };

    await expect(
      closeElectronApplication(fakeElectronApplication(child), dependencies),
    ).resolves.toBeUndefined();
    expect(dependencies.signalProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not signal the child handle when its command fingerprint changes", async () => {
    const child = new FakeChildProcess(196);
    const root = windowsProcessRow({
      pid: child.pid,
      parentPid: 1,
      startedAt: "2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "root-command",
    });
    const changedRoot = { ...root, commandFingerprint: "different-command" };
    const dependencies: ProcessTreeDependencies = {
      platform: "win32",
      readProcessSnapshot: vi.fn((requestedPids) => (requestedPids ? [changedRoot] : [root])),
      signalProcess: vi.fn(),
    };

    await expect(
      closeElectronApplication(fakeElectronApplication(child), dependencies),
    ).rejects.toThrow("Electron close and process-tree cleanup");
    expect(dependencies.signalProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("revalidates the exact root immediately before signaling the child handle", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess(197);
      const root = windowsProcessRow({
        pid: child.pid,
        parentPid: 1,
        startedAt: "2026-07-20T20:00:00.0000000Z",
        commandFingerprint: "root-command",
      });
      const events: string[] = [];
      const dependencies: ProcessTreeDependencies = {
        platform: "win32",
        readProcessSnapshot: vi.fn((requestedPids) => {
          if (requestedPids) events.push(`snapshot:${requestedPids.join(",")}`);
          return [root];
        }),
        signalProcess: vi.fn((pid) => {
          events.push(`signal-process:${pid}`);
        }),
      };
      child.kill.mockImplementationOnce((signal: NodeJS.Signals = "SIGTERM") => {
        events.push(`signal-child:${child.pid}`);
        child.signalCode = signal;
        child.emit("exit", null, signal);
        return true;
      });

      const result = closeElectronApplication(fakeElectronApplication(child), dependencies).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(result).resolves.toBeInstanceOf(Error);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(events.slice(-2)).toEqual([`snapshot:${root.pid}`, `signal-child:${root.pid}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not signal a descendant whose pid was reused before termination", async () => {
    const childProcess = new FakeChildProcess(201);
    const root = windowsProcessRow({
      pid: childProcess.pid,
      parentPid: 1,
      startedAt: "2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "root-command",
    });
    const descendant = windowsProcessRow({
      pid: 202,
      parentPid: root.pid,
      startedAt: "2026-07-20T20:00:00.1000000Z",
      commandFingerprint: "child-command",
    });
    const reusedDescendant = {
      ...descendant,
      identity: "windows:2026-07-20T20:00:01.0000000Z",
      parentPid: 999,
    };
    let fullSnapshotCount = 0;
    const signaledPids = new Set<number>();
    const signalProcess = vi.fn((pid: number) => {
      signaledPids.add(pid);
    });
    const dependencies: ProcessTreeDependencies = {
      platform: "win32",
      readProcessSnapshot: vi.fn((requestedPids) => {
        if (requestedPids?.includes(descendant.pid)) {
          return requestedPids.includes(root.pid) && !signaledPids.has(root.pid)
            ? [reusedDescendant, root]
            : [reusedDescendant];
        }
        if (requestedPids?.includes(root.pid)) {
          return signaledPids.has(root.pid) ? [] : [root];
        }
        fullSnapshotCount += 1;
        return fullSnapshotCount <= 3 ? [root, descendant] : [];
      }),
      signalProcess,
    };

    await closeElectronApplication(fakeElectronApplication(childProcess), dependencies);

    expect(signalProcess).toHaveBeenCalledTimes(1);
    expect(signalProcess).toHaveBeenCalledWith(root.pid, "SIGKILL");
    expect(signalProcess).not.toHaveBeenCalledWith(descendant.pid, expect.anything());
  });

  it("delegates graceful shutdown to the Playwright context exactly once", async () => {
    const child = new FakeChildProcess(251);
    const root = windowsProcessRow({
      pid: child.pid,
      parentPid: 1,
      startedAt: "2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "root-command",
    });
    const closeCalls: string[] = [];
    let fullSnapshotCount = 0;
    const dependencies: ProcessTreeDependencies = {
      platform: "win32",
      readProcessSnapshot: vi.fn((requestedPids) => {
        if (requestedPids) return [];
        fullSnapshotCount += 1;
        return fullSnapshotCount === 1 ? [root] : [];
      }),
      signalProcess: vi.fn(),
    };

    await closeElectronApplication(fakeElectronApplication(child, closeCalls), dependencies);

    expect(closeCalls).toEqual(["close"]);
  });

  it("ignores stale parent-pid edges while preserving valid descendant branches", () => {
    const root = windowsProcessRow({
      pid: 271,
      parentPid: 1,
      startedAt: "2026-07-20T20:00:00.1000000Z",
      commandFingerprint: "root-command",
    });
    const staleChild = windowsProcessRow({
      pid: 272,
      parentPid: root.pid,
      startedAt: "2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "stale-child-command",
    });
    const staleGrandchild = windowsProcessRow({
      pid: 273,
      parentPid: staleChild.pid,
      startedAt: "2026-07-20T20:00:00.2000000Z",
      commandFingerprint: "stale-grandchild-command",
    });
    const validChild = windowsProcessRow({
      pid: 274,
      parentPid: root.pid,
      startedAt: "2026-07-20T20:00:00.2000000Z",
      commandFingerprint: "valid-child-command",
      imageName: "git.exe",
    });

    const collected = collectDescendants(root.pid, [root, staleChild, staleGrandchild, validChild]);

    expect(collected.processes).toEqual([
      {
        pid: validChild.pid,
        identity: validChild.identity,
        commandFingerprint: validChild.commandFingerprint,
        imageName: "git.exe",
      },
    ]);
    expect(collected.errors).toEqual([]);
  });

  it("preserves valid descendant branches when another branch lacks identity evidence", () => {
    const root = windowsProcessRow({
      pid: 301,
      parentPid: 1,
      startedAt: "2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "root-command",
    });
    const validChild = windowsProcessRow({
      pid: 302,
      parentPid: root.pid,
      startedAt: "2026-07-20T20:00:00.1000000Z",
      commandFingerprint: "valid-child-command",
    });
    const unknownChild = {
      ...validChild,
      pid: 303,
      identity: null,
      commandFingerprint: null,
    };

    const collected = collectDescendants(root.pid, [root, validChild, unknownChild]);

    expect(collected.processes).toEqual([
      {
        pid: validChild.pid,
        identity: validChild.identity,
        commandFingerprint: validChild.commandFingerprint,
      },
    ]);
    expect(collected.errors).toHaveLength(1);
    expect(collected.errors[0]?.message).toContain("lacked creation identity");
  });

  it("keeps the original command fingerprint when late snapshots duplicate an identity", () => {
    const original = {
      pid: 401,
      identity: "windows:2026-07-20T20:00:00.0000000Z",
      commandFingerprint: "original-command",
    } satisfies TrackedProcess;
    const late = { ...original, commandFingerprint: "late-command" };

    expect(mergeTrackedProcesses([original], [late])).toEqual([original]);
  });
});
