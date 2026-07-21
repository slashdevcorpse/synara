import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { collectTerminalIdsFromLayout } from "./terminalPaneLayout";
import {
  normalizeThreadTerminalState,
  sanitizePersistedTerminalStateByThreadId,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "./terminalStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function summarizeTerminalGroups(
  terminalGroups: ReturnType<typeof selectThreadTerminalState>["terminalGroups"],
) {
  return terminalGroups.map((group) => ({
    id: group.id,
    activeTerminalId: group.activeTerminalId,
    terminalIds: collectTerminalIdsFromLayout(group.layout),
  }));
}

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState).toMatchObject({
      entryPoint: "chat",
      terminalOpen: false,
      presentationMode: "drawer",
      workspaceLayout: "both",
      workspaceActiveTab: "terminal",
      terminalHeight: 280,
      terminalIds: ["default"],
      terminalLabelsById: { default: "Terminal 1" },
      terminalTitleOverridesById: {},
      terminalCliKindsById: {},
      terminalAttentionStatesById: {},
      runningTerminalIds: [],
      activeTerminalId: "default",
      activeTerminalGroupId: "group-default",
    });
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "default",
        terminalIds: ["default"],
      },
    ]);
  });

  it("marks chat-first threads without forcing open terminal UI", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });
    store.openChatThreadPage(THREAD_ID);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.entryPoint).toBe("chat");
    expect(terminalState.workspaceLayout).toBe("both");
    expect(terminalState.workspaceActiveTab).toBe("chat");
  });

  it("opens terminal-first threads in the workspace terminal tab", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.splitTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "terminal-2",
        terminalIds: ["default", "terminal-2"],
      },
    ]);
  });

  it("restores the last-used presentation mode when reopened", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(THREAD_ID, "workspace");
    store.setTerminalOpen(THREAD_ID, false);
    store.setTerminalOpen(THREAD_ID, true);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
  });

  it("enters workspace mode on the terminal tab by default", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(THREAD_ID, "workspace");
    store.setTerminalWorkspaceTab(THREAD_ID, "chat");
    store.setTerminalPresentationMode(THREAD_ID, "drawer");
    store.setTerminalPresentationMode(THREAD_ID, "workspace");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("opens a new full-width terminal in terminal-only workspace mode", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
  });

  it("restores chat when selecting the chat workspace tab from terminal-only mode", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(THREAD_ID, "terminal-2");
    store.setTerminalWorkspaceTab(THREAD_ID, "chat");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.workspaceLayout).toBe("both");
    expect(terminalState.workspaceActiveTab).toBe("chat");
  });

  it("closes workspace chat into terminal-only mode without closing terminals", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(THREAD_ID, "workspace");
    store.setTerminalWorkspaceTab(THREAD_ID, "chat");
    store.closeWorkspaceChat(THREAD_ID);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
    expect(terminalState.terminalIds).toEqual(["default"]);
  });

  it("preserves terminal-only workspace layout when collapsing to drawer and reopening", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(THREAD_ID, "terminal-2");
    store.setTerminalPresentationMode(THREAD_ID, "drawer");
    store.setTerminalPresentationMode(THREAD_ID, "workspace");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("keeps split terminals in the same group up to the current group limit", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.splitTerminal(THREAD_ID, "terminal-5");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "terminal-5",
        terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalStateStore.getState().newTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      { id: "group-default", activeTerminalId: "default", terminalIds: ["default"] },
      { id: "group-terminal-2", activeTerminalId: "terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("stores terminal labels and removes them when a terminal closes", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: "codex",
      label: "Codex CLI",
    });

    let terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById).toEqual({
      default: "Terminal 1",
      "terminal-2": "Codex 1",
    });
    expect(terminalState.terminalCliKindsById).toEqual({ "terminal-2": "codex" });

    store.closeTerminal(THREAD_ID, "terminal-2");

    terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById).toEqual({ default: "Terminal 1" });
    expect(terminalState.terminalCliKindsById).toEqual({});
  });

  it("persists Antigravity CLI terminal identity", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: "antigravity",
      label: "Antigravity CLI",
    });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById["terminal-2"]).toBe("Antigravity 1");
    expect(terminalState.terminalCliKindsById).toEqual({
      "terminal-2": "antigravity",
    });
  });

  it("clears terminal provider identity when metadata cliKind is null", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: "codex",
      label: "Codex CLI",
    });
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: null,
      label: "bun dev",
    });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById["terminal-2"]).toBe("bun dev");
    expect(terminalState.terminalCliKindsById).toEqual({});
  });

  it("allows unlimited groups while keeping each group capped at four terminals", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.newTerminal(THREAD_ID, "terminal-5");
    store.newTerminal(THREAD_ID, "terminal-6");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
      "terminal-6",
    ]);
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "terminal-4",
        terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4"],
      },
      { id: "group-terminal-5", activeTerminalId: "terminal-5", terminalIds: ["terminal-5"] },
      { id: "group-terminal-6", activeTerminalId: "terminal-6", terminalIds: ["terminal-6"] },
    ]);
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.setTerminalActivity(THREAD_ID, "terminal-2", {
      hasRunningSubprocess: true,
      agentState: null,
    });
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(THREAD_ID, "terminal-2", {
      hasRunningSubprocess: false,
      agentState: null,
    });
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual([]);
  });

  it("strips volatile runtime flags from persisted terminal state", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.setTerminalTitleOverride(THREAD_ID, "terminal-2", "New keybinds set");
    store.setTerminalActivity(THREAD_ID, "terminal-2", {
      hasRunningSubprocess: false,
      agentState: "attention",
    });

    const sanitized = sanitizePersistedTerminalStateByThreadId(
      useTerminalStateStore.getState().terminalStateByThreadId,
    );

    expect(sanitized[THREAD_ID]?.terminalTitleOverridesById).toEqual({
      "terminal-2": "New keybinds set",
    });
    expect(sanitized[THREAD_ID]?.terminalAttentionStatesById).toEqual({});
    expect(sanitized[THREAD_ID]?.runningTerminalIds).toEqual([]);
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_ID, "default");

    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeUndefined();
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .terminalIds,
    ).toEqual(["default"]);
  });

  it("keeps terminal-first threads terminal-first after closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });
    store.closeTerminal(THREAD_ID, "default");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeDefined();
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(false);
    expect(terminalState.terminalIds).toEqual(["default"]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.closeTerminal(THREAD_ID, "terminal-3");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(summarizeTerminalGroups(terminalState.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "terminal-2",
        terminalIds: ["default", "terminal-2"],
      },
    ]);
  });

  it("refreshes inferred group presentation from runtime metadata but preserves user names", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalMetadata(THREAD_ID, "default", {
      cliKind: null,
      label: "Dev server",
    });

    let terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalGroups[0]).toMatchObject({
      name: "Dev server",
      role: "app",
      icon: "app-window",
      accent: "blue",
      userNamed: false,
    });

    store.renameTerminalGroup(THREAD_ID, "group-default", "Local stack");
    store.setTerminalMetadata(THREAD_ID, "default", {
      cliKind: "codex",
      label: "Codex CLI",
    });
    terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalGroups[0]).toMatchObject({
      name: "Local stack",
      role: "app",
      icon: "app-window",
      accent: "blue",
      userNamed: true,
    });
  });

  it("assigns deterministic distinct names to newly created groups", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.newTerminal(THREAD_ID, "terminal-3");

    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.terminalGroups.map((group) => group.name)).toEqual([
      "Terminal 1",
      "Terminal 2",
      "Terminal 3",
    ]);
  });

  it("migrates legacy structural groups without changing ids, pane weights, or order", () => {
    const defaultState = selectThreadTerminalState({}, THREAD_ID);
    const migrated = normalizeThreadTerminalState({
      ...defaultState,
      terminalIds: ["terminal-a", "terminal-b", "terminal-c"],
      terminalLabelsById: {
        "terminal-a": "Dev server",
        "terminal-b": "Tests",
        "terminal-c": "Codex 1",
      },
      terminalCliKindsById: { "terminal-c": "codex" },
      activeTerminalId: "terminal-c",
      activeTerminalGroupId: "legacy-agent",
      terminalGroups: [
        {
          id: "legacy-app",
          activeTerminalId: "terminal-a",
          layout: {
            type: "split",
            id: "legacy-split",
            direction: "horizontal",
            children: [
              {
                type: "terminal",
                paneId: "pane-a",
                terminalIds: ["terminal-a"],
                activeTerminalId: "terminal-a",
              },
              {
                type: "terminal",
                paneId: "pane-b",
                terminalIds: ["terminal-b"],
                activeTerminalId: "terminal-b",
              },
            ],
            weights: [3, 2],
          },
        },
        {
          id: "legacy-agent",
          activeTerminalId: "terminal-c",
          layout: {
            type: "terminal",
            paneId: "pane-c",
            terminalIds: ["terminal-c"],
            activeTerminalId: "terminal-c",
          },
        },
      ],
    });

    expect(migrated.terminalGroups.map((group) => group.id)).toEqual([
      "legacy-app",
      "legacy-agent",
    ]);
    expect(migrated.terminalGroups[0]?.layout).toEqual({
      type: "split",
      id: "legacy-split",
      direction: "horizontal",
      children: [
        {
          type: "terminal",
          paneId: "pane-a",
          terminalIds: ["terminal-a"],
          activeTerminalId: "terminal-a",
        },
        {
          type: "terminal",
          paneId: "pane-b",
          terminalIds: ["terminal-b"],
          activeTerminalId: "terminal-b",
        },
      ],
      weights: [3, 2],
    });
    expect(migrated.terminalGroups[0]).toMatchObject({
      name: "Dev server",
      role: "app",
      archivedAt: null,
      originalIndex: null,
      createdAt: 0,
      updatedAt: 0,
      userNamed: false,
    });
    expect(migrated.terminalGroups[1]).toMatchObject({ name: "Codex 1", role: "agent" });
    expect(migrated.activeTerminalGroupId).toBe("legacy-agent");
    expect(normalizeThreadTerminalState(migrated)).toBe(migrated);
  });

  it("normalizes corrupted persisted exit and launch metadata without throwing", () => {
    const defaultState = selectThreadTerminalState({}, THREAD_ID);
    const corruptedState = {
      ...defaultState,
      terminalExitStatesById: {
        default: { kind: "failed", exitCode: "not-a-number", exitSignal: 9 },
      },
      terminalLaunchMetadataById: { default: null },
    } as unknown as typeof defaultState;

    expect(normalizeThreadTerminalState(corruptedState)).toMatchObject({
      terminalExitStatesById: {
        default: { kind: "failed", exitCode: null, exitSignal: null },
      },
      terminalLaunchMetadataById: { default: { cwd: null } },
    });
  });

  it("archives, restores, renames, and changes roles without losing group contents", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    const before = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    const target = before.terminalGroups.find((group) => group.id === "group-terminal-2");
    expect(target).toBeDefined();

    store.renameTerminalGroup(THREAD_ID, "group-terminal-2", "Development");
    store.setTerminalGroupRole(THREAD_ID, "group-terminal-2", "app");
    store.archiveTerminalGroup(THREAD_ID, "group-terminal-2");

    let state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.activeTerminalGroupId).toBe("group-default");
    expect(state.terminalGroups[1]).toMatchObject({
      id: "group-terminal-2",
      name: "Development",
      role: "app",
      userNamed: true,
      originalIndex: 1,
    });
    expect(state.terminalGroups[1]?.archivedAt).toEqual(expect.any(Number));
    expect(collectTerminalIdsFromLayout(state.terminalGroups[1]!.layout)).toEqual(["terminal-2"]);

    store.restoreTerminalGroup(THREAD_ID, "group-terminal-2");
    state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.terminalGroups.map((group) => group.id)).toEqual([
      "group-default",
      "group-terminal-2",
    ]);
    expect(state.activeTerminalGroupId).toBe("group-terminal-2");
    expect(state.terminalGroups[1]).toMatchObject({
      name: "Development",
      role: "app",
      archivedAt: null,
      originalIndex: null,
    });
  });

  it("keeps archived slots fixed while reordering active groups", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.newTerminal(THREAD_ID, "terminal-3");
    store.newTerminal(THREAD_ID, "terminal-4");
    store.archiveTerminalGroup(THREAD_ID, "group-terminal-2");
    store.reorderTerminalGroup(THREAD_ID, "group-terminal-4", 0);

    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.terminalGroups.map((group) => group.id)).toEqual([
      "group-terminal-4",
      "group-terminal-2",
      "group-default",
      "group-terminal-3",
    ]);
    expect(state.terminalGroups[1]?.archivedAt).toEqual(expect.any(Number));
  });

  it("moves selected terminals together through one transactional store action", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.renameTerminalGroup(THREAD_ID, "group-default", "Source");
    store.newTerminal(THREAD_ID, "terminal-4");
    store.renameTerminalGroup(THREAD_ID, "group-terminal-4", "Destination");
    store.setTerminalGroupRole(THREAD_ID, "group-terminal-4", "verify");

    const before = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    const destinationBefore = before.terminalGroups.find(
      (group) => group.id === "group-terminal-4",
    );
    expect(destinationBefore).toBeDefined();

    store.moveTerminals(THREAD_ID, ["terminal-2", "terminal-3"], {
      kind: "group",
      groupId: "group-terminal-4",
    });

    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(summarizeTerminalGroups(state.terminalGroups)).toEqual([
      { id: "group-default", activeTerminalId: "default", terminalIds: ["default"] },
      {
        id: "group-terminal-4",
        activeTerminalId: "terminal-3",
        terminalIds: ["terminal-4", "terminal-2", "terminal-3"],
      },
    ]);
    expect(state.terminalGroups[0]).toMatchObject({ name: "Source", userNamed: true });
    expect(state.terminalGroups[1]).toMatchObject({
      name: "Destination",
      role: "verify",
      createdAt: destinationBefore?.createdAt,
      updatedAt: destinationBefore?.updatedAt,
      userNamed: true,
    });
    expect(state.activeTerminalGroupId).toBe("group-terminal-4");
    expect(state.activeTerminalId).toBe("terminal-3");
  });

  it("moves a terminal onto the exact target tab pane and rejects self drops", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");

    store.moveTerminals(THREAD_ID, ["terminal-3"], {
      kind: "group",
      groupId: "group-default",
      targetTerminalId: "default",
    });

    const moved = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(moved.terminalGroups[0]?.layout).toMatchObject({
      type: "split",
      children: [
        {
          type: "terminal",
          activeTerminalId: "terminal-3",
          terminalIds: ["default", "terminal-3"],
        },
        { type: "terminal", terminalIds: ["terminal-2"] },
      ],
    });

    store.moveTerminals(THREAD_ID, ["default"], {
      kind: "group",
      groupId: "group-default",
      targetTerminalId: "default",
    });
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadId,
        THREAD_ID,
      ),
    ).toBe(moved);
  });

  it("creates a new group for a multi-terminal move without changing terminal metadata", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.setTerminalLaunchMetadata(THREAD_ID, "terminal-2", { cwd: "C:/two" });
    store.setTerminalLaunchMetadata(THREAD_ID, "terminal-3", { cwd: "C:/three" });

    store.moveTerminals(THREAD_ID, ["terminal-2", "terminal-3"], {
      kind: "new-group",
      toIndex: 0,
    });

    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(summarizeTerminalGroups(state.terminalGroups)).toEqual([
      {
        id: "group-terminal-2",
        activeTerminalId: "terminal-3",
        terminalIds: ["terminal-2", "terminal-3"],
      },
      { id: "group-default", activeTerminalId: "default", terminalIds: ["default"] },
    ]);
    expect(state.terminalLaunchMetadataById).toMatchObject({
      "terminal-2": { cwd: "C:/two" },
      "terminal-3": { cwd: "C:/three" },
    });
  });

  it("rejects terminal moves to or from archived groups", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.archiveTerminalGroup(THREAD_ID, "group-terminal-2");
    const before = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );

    store.moveTerminals(THREAD_ID, ["default"], {
      kind: "group",
      groupId: "group-terminal-2",
    });
    store.moveTerminals(THREAD_ID, ["terminal-2"], { kind: "new-group" });

    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state).toBe(before);
  });

  it("rejects an entire multi-terminal move when the destination would exceed its limit", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.splitTerminal(THREAD_ID, "terminal-5");
    store.newTerminal(THREAD_ID, "terminal-6");
    store.splitTerminal(THREAD_ID, "terminal-7");
    const before = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );

    store.moveTerminals(THREAD_ID, ["terminal-6", "terminal-7"], {
      kind: "group",
      groupId: "group-default",
    });

    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state).toBe(before);
    expect(summarizeTerminalGroups(state.terminalGroups)).toEqual([
      {
        id: "group-default",
        activeTerminalId: "terminal-5",
        terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
      {
        id: "group-terminal-6",
        activeTerminalId: "terminal-7",
        terminalIds: ["terminal-6", "terminal-7"],
      },
    ]);
  });

  it("allows the last active group to be archived without recreating a visible default", () => {
    const store = useTerminalStateStore.getState();
    store.archiveTerminalGroup(THREAD_ID, "group-default");

    let state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.terminalGroups).toHaveLength(1);
    expect(state.terminalGroups[0]?.archivedAt).toEqual(expect.any(Number));
    expect(state.terminalIds).toEqual(["default"]);

    store.newTerminal(THREAD_ID, "terminal-2");
    state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.terminalGroups).toHaveLength(2);
    expect(state.terminalGroups[0]?.archivedAt).toEqual(expect.any(Number));
    expect(state.terminalGroups[1]).toMatchObject({
      id: "group-terminal-2",
      name: "Terminal 2",
      archivedAt: null,
    });
    expect(state.activeTerminalGroupId).toBe("group-terminal-2");
  });

  it("keeps a true empty workspace after destructively removing the final group", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminalGroup(THREAD_ID, "group-default");

    let state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.terminalOpen).toBe(true);
    expect(state.terminalIds).toEqual([]);
    expect(state.terminalGroups).toEqual([]);
    expect(state.activeTerminalId).toBe("");
    expect(state.activeTerminalGroupId).toBe("");
    expect(normalizeThreadTerminalState(state)).toBe(state);

    store.newTerminal(THREAD_ID, "terminal-new");
    state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(summarizeTerminalGroups(state.terminalGroups)).toEqual([
      {
        id: "group-terminal-new",
        activeTerminalId: "terminal-new",
        terminalIds: ["terminal-new"],
      },
    ]);
  });

  it("persists restart and exit lifecycle state while stripping only live activity", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalLaunchMetadata(THREAD_ID, "default", {
      cwd: "C:/work/project",
    });
    store.setTerminalExitState(THREAD_ID, "default", {
      kind: "failed",
      exitCode: 1,
      exitSignal: null,
    });
    store.setShowArchivedTerminalGroups(THREAD_ID, true);

    const sanitized = sanitizePersistedTerminalStateByThreadId(
      useTerminalStateStore.getState().terminalStateByThreadId,
    );
    expect(sanitized[THREAD_ID]?.terminalLaunchMetadataById.default).toEqual({
      cwd: "C:/work/project",
      reattachOnly: true,
    });
    expect(sanitized[THREAD_ID]?.terminalExitStatesById.default).toEqual({
      kind: "failed",
      exitCode: 1,
      exitSignal: null,
    });
    expect(sanitized[THREAD_ID]?.showArchivedTerminalGroups).toBe(true);
  });
});
