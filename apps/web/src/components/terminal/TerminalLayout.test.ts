import { describe, expect, it } from "vitest";

import { createTerminalGroup } from "../../terminalPaneLayout";
import {
  findMostRecentlyArchivedTerminalGroup,
  resolveThreadTerminalLayout,
} from "./TerminalLayout";

function resolve(groups: ReturnType<typeof createTerminalGroup>[]) {
  return resolveThreadTerminalLayout({
    activeTerminalGroupId: groups[0]?.id ?? "missing",
    activeTerminalId: groups[0]?.activeTerminalId ?? "one",
    runningTerminalIds: [],
    terminalAttentionStatesById: {},
    terminalExitStatesById: {},
    terminalCliKindsById: {},
    terminalGroups: groups,
    terminalIds: groups.map((group) => group.activeTerminalId),
    terminalLabelsById: {},
    terminalTitleOverridesById: {},
  });
}

describe("resolveThreadTerminalLayout", () => {
  it("partitions archived groups and excludes them from active resolution", () => {
    const active = createTerminalGroup("active", "one", { name: "App" });
    const archived = createTerminalGroup("archived", "two", {
      name: "Logs",
      archivedAt: 12,
      originalIndex: 1,
    });
    const result = resolve([active, archived]);

    expect(result.resolvedTerminalGroups.map((group) => group.id)).toEqual(["active"]);
    expect(result.resolvedArchivedTerminalGroups.map((group) => group.id)).toEqual(["archived"]);
    expect(result.resolvedActiveGroupId).toBe("active");
    expect(result.visibleTerminalIds).toEqual(["one"]);
    expect(result.showGroupHeaders).toBe(true);
  });

  it("finds the newest archived group independently of resolver order", () => {
    const older = createTerminalGroup("older", "one", { archivedAt: 10, originalIndex: 0 });
    const newest = createTerminalGroup("newest", "two", { archivedAt: 30, originalIndex: 1 });
    const middle = createTerminalGroup("middle", "three", { archivedAt: 20, originalIndex: 2 });
    const result = resolve([older, newest, middle]);

    expect(findMostRecentlyArchivedTerminalGroup(result.resolvedArchivedTerminalGroups)?.id).toBe(
      "newest",
    );
  });

  it("returns an empty active viewport when every group is archived", () => {
    const archived = createTerminalGroup("archived", "one", {
      archivedAt: 12,
      originalIndex: 0,
    });
    const result = resolve([archived]);

    expect(result.resolvedActiveGroupId).toBeNull();
    expect(result.activeGroupLayout).toBeNull();
    expect(result.visibleTerminalIds).toEqual([]);
    expect(result.resolvedArchivedTerminalGroups).toHaveLength(1);
  });

  it("preserves a deliberately empty terminal workspace", () => {
    const result = resolveThreadTerminalLayout({
      activeTerminalGroupId: "",
      activeTerminalId: "",
      runningTerminalIds: [],
      terminalAttentionStatesById: {},
      terminalExitStatesById: {},
      terminalCliKindsById: {},
      terminalGroups: [],
      terminalIds: [],
      terminalLabelsById: {},
      terminalTitleOverridesById: {},
    });

    expect(result.normalizedTerminalIds).toEqual([]);
    expect(result.resolvedTerminalGroups).toEqual([]);
    expect(result.resolvedActiveGroupId).toBeNull();
    expect(result.activeGroupLayout).toBeNull();
    expect(result.showGroupHeaders).toBe(false);
  });

  it("projects persisted terminal exit state into tab visual identity", () => {
    const group = createTerminalGroup("failed-group", "failed-terminal");
    const result = resolveThreadTerminalLayout({
      activeTerminalGroupId: group.id,
      activeTerminalId: group.activeTerminalId,
      runningTerminalIds: [],
      terminalAttentionStatesById: {},
      terminalExitStatesById: {
        "failed-terminal": { kind: "failed", exitCode: null, exitSignal: "9" },
      },
      terminalCliKindsById: {},
      terminalGroups: [group],
      terminalIds: ["failed-terminal"],
      terminalLabelsById: { "failed-terminal": "Build" },
      terminalTitleOverridesById: {},
    });

    expect(result.terminalVisualIdentityById.get("failed-terminal")).toMatchObject({
      state: "failed",
      title: "Build",
    });
  });
});
