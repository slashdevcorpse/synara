import { describe, expect, it } from "vitest";

import { createTerminalGroup } from "../terminalPaneLayout";
import {
  activeTerminalGroups,
  archiveTerminalGroupInList,
  inferTerminalGroupRole,
  reorderActiveTerminalGroupInList,
  resolveTerminalGroupStatus,
  restoreTerminalGroupInList,
} from "./terminalGroups";

function groups() {
  return [
    createTerminalGroup("app", "one", { name: "App" }),
    createTerminalGroup("verify", "two", { name: "Verify" }),
    createTerminalGroup("observe", "three", { name: "Observe" }),
  ];
}

describe("terminal group semantics", () => {
  it("infers roles conservatively from stable tokens and explicit CLI identity", () => {
    expect(inferTerminalGroupRole({ token: "Dev server" })).toBe("app");
    expect(inferTerminalGroupRole({ token: "Test and lint" })).toBe("verify");
    expect(inferTerminalGroupRole({ token: "Tail logs" })).toBe("observe");
    expect(inferTerminalGroupRole({ token: "Notebook data" })).toBe("data");
    expect(inferTerminalGroupRole({ token: "Terraform plan" })).toBe("infrastructure");
    expect(inferTerminalGroupRole({ token: "My shell" })).toBe("custom");
    expect(inferTerminalGroupRole({ token: "Shell", cliKinds: ["codex"] })).toBe("agent");
  });

  it("archives and restores at the original active index", () => {
    const archived = archiveTerminalGroupInList({
      groups: groups(),
      groupId: "verify",
      archivedAt: 10,
    });
    expect(activeTerminalGroups(archived).map((group) => group.id)).toEqual(["app", "observe"]);
    expect(archived[1]).toMatchObject({ archivedAt: 10, originalIndex: 1 });

    const restored = restoreTerminalGroupInList({
      groups: archived,
      groupId: "verify",
      restoredAt: 20,
    });
    expect(restored.map((group) => group.id)).toEqual(["app", "verify", "observe"]);
    expect(restored[1]).toMatchObject({ archivedAt: null, originalIndex: null });
  });

  it("reorders active groups without moving archived slots", () => {
    const archived = archiveTerminalGroupInList({
      groups: groups(),
      groupId: "verify",
      archivedAt: 10,
    });
    const reordered = reorderActiveTerminalGroupInList({
      groups: archived,
      groupId: "observe",
      toIndex: 0,
      changedAt: 20,
    });
    expect(reordered.map((group) => group.id)).toEqual(["observe", "verify", "app"]);
    expect(reordered[1]?.archivedAt).toBe(10);
  });

  it("uses failure, attention, running, stopped, idle priority and reports counts", () => {
    expect(
      resolveTerminalGroupStatus({
        archived: false,
        terminalIds: ["failed", "attention", "running"],
        runningTerminalIds: new Set(["running"]),
        attentionStatesById: { attention: "review" },
        exitStatesById: {
          failed: { kind: "failed", exitCode: 1, exitSignal: null },
        },
      }),
    ).toEqual({
      status: "failed",
      failedCount: 1,
      attentionCount: 1,
      runningCount: 1,
      stoppedCount: 0,
      label: "1 failed",
    });

    expect(
      resolveTerminalGroupStatus({
        archived: false,
        terminalIds: ["stopped"],
        runningTerminalIds: new Set(),
        attentionStatesById: {},
        exitStatesById: {
          stopped: { kind: "stopped", exitCode: 0, exitSignal: null },
        },
      }),
    ).toMatchObject({ status: "stopped", stoppedCount: 1, label: "1 stopped" });
  });
});
