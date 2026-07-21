// FILE: WorkspaceAgentSection.test.ts
// Purpose: Command-boundary regressions for workspace agent interruption.
// Layer: Workspace agent integration tests

import { CommandId, ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Thread } from "../../types";
import type { AgentThreadEntry } from "../../hooks/useWorkspaceAgentActivity";
import { IDLE_AGENT_ACTIVITY_STATE } from "../../lib/agentActivity";
import {
  dispatchWorkspaceAgentInterrupt,
  dispatchWorkspaceAgentInterruptBatch,
  stopAllWorkspaceAgents,
  stopWorkspaceAgent,
  WORKSPACE_AGENT_INTERRUPT_CONCURRENCY,
  type WorkspaceAgentActionDependencies,
  type WorkspaceAgentInterruptDependencies,
  type WorkspaceAgentInterruptThreadView,
} from "./WorkspaceAgentSection";

const THREAD_A = ThreadId.makeUnsafe("workspace-agent-thread-a");
const THREAD_B = ThreadId.makeUnsafe("workspace-agent-thread-b");
const THREAD_C = ThreadId.makeUnsafe("workspace-agent-thread-c");
const PROJECT_ID = ProjectId.makeUnsafe("workspace-agent-project");
const CREATED_AT = "2026-07-20T16:30:00.000Z";
type InterruptCommand = Parameters<WorkspaceAgentInterruptDependencies["dispatchCommand"]>[0];

function latestTurn(state: "running" | "completed"): Thread["latestTurn"] {
  return {
    turnId: TurnId.makeUnsafe("workspace-agent-turn"),
    state,
    requestedAt: CREATED_AT,
    startedAt: CREATED_AT,
    completedAt: state === "completed" ? CREATED_AT : null,
    assistantMessageId: null,
  };
}

function runningThread(): WorkspaceAgentInterruptThreadView {
  return {
    parentThreadId: null,
    session: {
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: TurnId.makeUnsafe("workspace-agent-turn"),
    } as Thread["session"],
    latestTurn: latestTurn("running"),
    hasLiveTailWork: false,
  };
}

function makeDependencies(
  overrides: Partial<WorkspaceAgentInterruptDependencies> = {},
): WorkspaceAgentInterruptDependencies {
  return {
    getThread: () => runningThread(),
    dispatchCommand: async () => ({ sequence: 1 }),
    createCommandId: () => CommandId.makeUnsafe("workspace-agent-command"),
    nowIso: () => CREATED_AT,
    ...overrides,
  };
}

function makeEntry(threadId: ThreadId = THREAD_A): AgentThreadEntry {
  return {
    threadId,
    projectId: PROJECT_ID,
    projectTitle: "Synara",
    projectCwd: "C:/src/synara",
    threadTitle: `Agent ${threadId}`,
    parentThreadId: null,
    isSubagent: false,
    subagentNickname: null,
    subagentRole: null,
    modelLabel: "GPT-5.6",
    effortLabel: "high",
    providerKind: "codex",
    status: "thinking",
    activityState: { ...IDLE_AGENT_ACTIVITY_STATE, phase: "thinking" },
    duration: 1_000,
    latestTool: null,
    streamPreview: null,
    associatedWorktreeBranch: null,
    createdAt: 1,
    lastActivityAt: 2,
    turnId: TurnId.makeUnsafe("workspace-agent-turn"),
  };
}

function makeActionDependencies(
  overrides: Partial<WorkspaceAgentActionDependencies> = {},
): WorkspaceAgentActionDependencies {
  return {
    interrupt: async () => "dispatched",
    interruptBatch: async (threadIds) => ({
      attemptedThreadIds: [...threadIds],
      dispatchedThreadIds: [...threadIds],
      skippedThreadIds: [],
      failures: [],
    }),
    addErrorToast: () => undefined,
    ...overrides,
  };
}

describe("dispatchWorkspaceAgentInterrupt", () => {
  it("re-reads the thread and dispatches the exact interrupt command", async () => {
    const getThread = vi.fn(() => runningThread());
    const dispatchCommand = vi.fn(async () => ({ sequence: 42 }));
    const result = await dispatchWorkspaceAgentInterrupt(
      THREAD_A,
      makeDependencies({ getThread, dispatchCommand }),
    );

    expect(result).toBe("dispatched");
    expect(getThread).toHaveBeenCalledWith(THREAD_A);
    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.turn.interrupt",
      commandId: CommandId.makeUnsafe("workspace-agent-command"),
      threadId: THREAD_A,
      turnId: TurnId.makeUnsafe("workspace-agent-turn"),
      createdAt: CREATED_AT,
    });
  });

  it.each(["starting", "running"] as const)(
    "dispatches the exact active turn while the bound session is %s",
    async (status) => {
      const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
      const result = await dispatchWorkspaceAgentInterrupt(
        THREAD_A,
        makeDependencies({
          getThread: () => ({
            ...runningThread(),
            session: {
              ...runningThread().session!,
              status: status === "starting" ? "connecting" : "running",
              orchestrationStatus: status,
            } as Thread["session"],
          }),
          dispatchCommand,
        }),
      );

      expect(result).toBe("dispatched");
      expect(dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: TurnId.makeUnsafe("workspace-agent-turn") }),
      );
    },
  );

  it("dispatches an exact ready-session live-tail turn", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
    const result = await dispatchWorkspaceAgentInterrupt(
      THREAD_A,
      makeDependencies({
        getThread: () => ({
          parentThreadId: null,
          session: {
            ...runningThread().session!,
            status: "ready",
            orchestrationStatus: "ready",
            activeTurnId: undefined,
          } as Thread["session"],
          latestTurn: latestTurn("running"),
          hasLiveTailWork: true,
        }),
        dispatchCommand,
      }),
    );

    expect(result).toBe("dispatched");
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: TurnId.makeUnsafe("workspace-agent-turn") }),
    );
  });

  it.each([
    ["missing", undefined],
    [
      "stale",
      {
        parentThreadId: null,
        session: null,
        latestTurn: latestTurn("completed"),
        hasLiveTailWork: false,
      },
    ],
    [
      "terminal-session stale-tail",
      {
        parentThreadId: null,
        session: {
          ...runningThread().session!,
          status: "error",
          orchestrationStatus: "error",
          activeTurnId: undefined,
        } as Thread["session"],
        latestTurn: latestTurn("running"),
        hasLiveTailWork: true,
      },
    ],
    ...(["interrupted", "stopped"] as const).map(
      (orchestrationStatus) =>
        [
          `${orchestrationStatus} orchestration session`,
          {
            parentThreadId: null,
            session: {
              ...runningThread().session!,
              status: orchestrationStatus === "interrupted" ? "ready" : "closed",
              orchestrationStatus,
              activeTurnId: undefined,
            } as Thread["session"],
            latestTurn: latestTurn("running"),
            hasLiveTailWork: true,
          },
        ] as const,
    ),
    [
      "genuine sessionless root",
      {
        parentThreadId: null,
        session: null,
        latestTurn: latestTurn("running"),
        hasLiveTailWork: true,
      },
    ],
  ] as const)("does not dispatch for a %s thread", async (_label, thread) => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
    const createCommandId = vi.fn(() => CommandId.makeUnsafe("unused-command"));
    const result = await dispatchWorkspaceAgentInterrupt(
      THREAD_A,
      makeDependencies({
        getThread: () => thread,
        dispatchCommand,
        createCommandId,
      }),
    );

    expect(result).toBe("not-running");
    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(createCommandId).not.toHaveBeenCalled();
  });

  it("dispatches an exact turn for a sessionless child with a running latest turn", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
    const result = await dispatchWorkspaceAgentInterrupt(
      THREAD_B,
      makeDependencies({
        getThread: () => ({
          parentThreadId: THREAD_A,
          session: null,
          latestTurn: latestTurn("running"),
          hasLiveTailWork: false,
        }),
        dispatchCommand,
      }),
    );

    expect(result).toBe("dispatched");
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.interrupt",
        threadId: THREAD_B,
        turnId: TurnId.makeUnsafe("workspace-agent-turn"),
      }),
    );
  });

  it("dispatches an exact turn for a canonical sessionless child with missing parent metadata", async () => {
    const syntheticThreadId = ThreadId.makeUnsafe(
      "subagent:workspace-agent-thread-a:child-provider",
    );
    const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
    const result = await dispatchWorkspaceAgentInterrupt(
      syntheticThreadId,
      makeDependencies({
        getThread: () => ({
          parentThreadId: null,
          session: null,
          latestTurn: latestTurn("running"),
          hasLiveTailWork: true,
        }),
        dispatchCommand,
      }),
    );

    expect(result).toBe("dispatched");
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: syntheticThreadId,
        turnId: TurnId.makeUnsafe("workspace-agent-turn"),
      }),
    );
  });

  it("does not dispatch for a completed sessionless child", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
    const result = await dispatchWorkspaceAgentInterrupt(
      THREAD_B,
      makeDependencies({
        getThread: () => ({
          parentThreadId: THREAD_A,
          session: null,
          latestTurn: latestTurn("completed"),
          hasLiveTailWork: false,
        }),
        dispatchCommand,
      }),
    );

    expect(result).toBe("not-running");
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});

describe("dispatchWorkspaceAgentInterruptBatch", () => {
  it("deduplicates ids and attempts every target when one dispatch fails", async () => {
    let commandIndex = 0;
    const dispatchedThreadIds: ThreadId[] = [];
    const dispatchCommand = vi.fn(async (command: InterruptCommand) => {
      dispatchedThreadIds.push(command.threadId);
      if (command.threadId === THREAD_B) {
        throw new Error("provider rejected interrupt");
      }
      return { sequence: dispatchedThreadIds.length };
    });
    const result = await dispatchWorkspaceAgentInterruptBatch(
      [THREAD_A, THREAD_A, THREAD_B, THREAD_C],
      makeDependencies({
        dispatchCommand,
        createCommandId: () => CommandId.makeUnsafe(`workspace-agent-command-${commandIndex++}`),
      }),
    );

    expect(dispatchCommand).toHaveBeenCalledTimes(3);
    expect(dispatchedThreadIds).toEqual([THREAD_A, THREAD_B, THREAD_C]);
    expect(result.attemptedThreadIds).toEqual([THREAD_A, THREAD_B, THREAD_C]);
    expect(result.dispatchedThreadIds).toEqual([THREAD_A, THREAD_C]);
    expect(result.skippedThreadIds).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.threadId).toBe(THREAD_B);
    expect(result.failures[0]?.reason).toBeInstanceOf(Error);
    expect((result.failures[0]?.reason as Error).message).toBe("provider rejected interrupt");
  });

  it("bounds concurrency below control admission while classifying every target", async () => {
    const threadIds = Array.from({ length: 21 }, (_, index) =>
      ThreadId.makeUnsafe(`workspace-agent-bulk-${index}`),
    );
    const failedThreadIds = new Set([threadIds[7]!, threadIds[18]!]);
    const threadIndex = new Map(threadIds.map((threadId, index) => [threadId, index]));
    const releases: Array<() => void> = [];
    const gates = threadIds.map(() => new Promise<void>((resolve) => releases.push(resolve)));
    const dispatchedCommands: ThreadId[] = [];
    let activeDispatches = 0;
    let peakDispatches = 0;
    let commandIndex = 0;
    const dispatchCommand = vi.fn(async (command: InterruptCommand) => {
      dispatchedCommands.push(command.threadId);
      activeDispatches += 1;
      peakDispatches = Math.max(peakDispatches, activeDispatches);
      try {
        await gates[threadIndex.get(command.threadId)!];
        if (failedThreadIds.has(command.threadId)) {
          throw new Error(`rejected ${command.threadId}`);
        }
        return { sequence: dispatchedCommands.length };
      } finally {
        activeDispatches -= 1;
      }
    });

    const resultPromise = dispatchWorkspaceAgentInterruptBatch(
      threadIds,
      makeDependencies({
        dispatchCommand,
        createCommandId: () => CommandId.makeUnsafe(`workspace-agent-bulk-${commandIndex++}`),
      }),
    );

    await vi.waitFor(() =>
      expect(dispatchedCommands).toEqual(threadIds.slice(0, WORKSPACE_AGENT_INTERRUPT_CONCURRENCY)),
    );
    releases[0]!();
    await vi.waitFor(() =>
      expect(dispatchedCommands).toContain(threadIds[WORKSPACE_AGENT_INTERRUPT_CONCURRENCY]),
    );
    expect(activeDispatches).toBe(WORKSPACE_AGENT_INTERRUPT_CONCURRENCY);

    releases.slice(1).forEach((release) => release());
    const result = await resultPromise;

    expect(peakDispatches).toBe(WORKSPACE_AGENT_INTERRUPT_CONCURRENCY);
    expect(peakDispatches).toBeLessThan(16);
    expect(result.attemptedThreadIds).toEqual(threadIds);
    expect(result.skippedThreadIds).toEqual([]);
    expect(result.failures.map(({ threadId }) => threadId)).toEqual([threadIds[7], threadIds[18]]);
    expect(result.dispatchedThreadIds).toEqual(
      threadIds.filter((threadId) => !failedThreadIds.has(threadId)),
    );
    expect(dispatchedCommands).toEqual(threadIds);
  });
});

describe("workspace agent interruption feedback", () => {
  it("releases a stale row without showing a dispatch-failure toast", async () => {
    const addErrorToast = vi.fn();
    await expect(
      stopWorkspaceAgent(
        makeEntry(),
        makeActionDependencies({
          interrupt: async () => "not-running",
          addErrorToast,
        }),
      ),
    ).resolves.toBe("not-running");

    expect(addErrorToast).not.toHaveBeenCalled();
  });

  it("surfaces a per-row dispatch failure with agent context", async () => {
    const addErrorToast = vi.fn();
    await expect(
      stopWorkspaceAgent(
        makeEntry(),
        makeActionDependencies({
          interrupt: async () => {
            throw new Error("connection closed");
          },
          addErrorToast,
        }),
      ),
    ).rejects.toThrow("connection closed");

    expect(addErrorToast).toHaveBeenCalledWith({
      title: "Unable to stop agent",
      description: "Agent workspace-agent-thread-a: connection closed",
    });
  });

  it("surfaces one aggregate toast for a partial Stop All failure", async () => {
    const addErrorToast = vi.fn();
    const entries = [makeEntry(THREAD_A), makeEntry(THREAD_B), makeEntry(THREAD_C)];
    await expect(
      stopAllWorkspaceAgents(
        entries,
        makeActionDependencies({
          interruptBatch: async (threadIds) => ({
            attemptedThreadIds: [...threadIds],
            dispatchedThreadIds: [THREAD_A, THREAD_C],
            skippedThreadIds: [],
            failures: [{ threadId: THREAD_B, reason: new Error("rejected") }],
          }),
          addErrorToast,
        }),
      ),
    ).resolves.toMatchObject({
      attemptedThreadIds: [THREAD_A, THREAD_B, THREAD_C],
      dispatchedThreadIds: [THREAD_A, THREAD_C],
      skippedThreadIds: [],
      failures: [{ threadId: THREAD_B, reason: expect.any(Error) }],
    });

    expect(addErrorToast).toHaveBeenCalledOnce();
    expect(addErrorToast).toHaveBeenCalledWith({
      title: "Some agents could not be stopped",
      description: "1 of 3 stop requests failed.",
    });
  });
});
