import { describe, expect, it } from "vitest";

import {
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationEvent,
} from "@synara/contracts";

import {
  WORKSPACE_AGENT_EVENT_BUFFER_LIMIT,
  createInitialWorkspaceAgentEventState,
  deriveAgentDuration,
  deriveAgentStatus,
  deriveWorkspaceAgentActivity,
  deriveWorkspaceAgentThreadActivity,
  modelEffortLabel,
  reduceWorkspaceAgentEventState,
  type WorkspaceAgentShellProject,
  type WorkspaceAgentShellThread,
} from "./workspaceAgentActivity";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const TURN_ID = TurnId.makeUnsafe("turn-1");
const BASE_TIME = "2026-07-20T12:00:00.000Z";
type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;

const project: WorkspaceAgentShellProject = {
  projectId: PROJECT_ID,
  projectTitle: "Synara",
  projectCwd: "C:\\src\\synara",
};

function shellThread(
  overrides: Partial<WorkspaceAgentShellThread> = {},
): WorkspaceAgentShellThread {
  return {
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    threadTitle: "Implement agent status",
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    modelSelection: {
      provider: "codex",
      model: "gpt-5.6-sol",
      options: { reasoningEffort: "high" },
    },
    session: {
      providerKind: "codex",
      status: "running",
      activeTurnId: TURN_ID,
      lastError: null,
      updatedAt: BASE_TIME,
    },
    latestTurn: {
      turnId: TURN_ID,
      state: "running",
      requestedAt: BASE_TIME,
      startedAt: BASE_TIME,
      completedAt: null,
      assistantMessageId: null,
    },
    hasLiveTailWork: true,
    associatedWorktreeBranch: "feature/agents",
    createdAt: BASE_TIME,
    archivedAt: null,
    ...overrides,
  };
}

function eventBase(sequence: number, type: OrchestrationEvent["type"]) {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}-${type}`),
    aggregateKind: "thread" as const,
    aggregateId: THREAD_ID,
    occurredAt: new Date(Date.parse(BASE_TIME) + sequence * 100).toISOString(),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

function assistantEvent(input: {
  sequence: number;
  turnId?: TurnId;
  text?: string;
  streaming?: boolean;
}): OrchestrationEvent {
  return {
    ...eventBase(input.sequence, "thread.message-sent"),
    type: "thread.message-sent",
    payload: {
      threadId: THREAD_ID,
      messageId: MessageId.makeUnsafe("assistant-1"),
      role: "assistant",
      text: input.text ?? "Working",
      turnId: input.turnId ?? TURN_ID,
      streaming: input.streaming ?? true,
      source: "native",
      createdAt: BASE_TIME,
      updatedAt: new Date(Date.parse(BASE_TIME) + input.sequence * 100).toISOString(),
    },
  };
}

function toolEvent(input: {
  sequence: number;
  kind: "tool.started" | "tool.updated" | "tool.completed";
  providerItemId?: string;
  metadataProviderItemId?: string;
  turnId?: TurnId;
  title?: string;
}): ThreadActivityAppendedEvent {
  return {
    ...eventBase(input.sequence, "thread.activity-appended"),
    metadata: input.metadataProviderItemId
      ? { providerItemId: ProviderItemId.makeUnsafe(input.metadataProviderItemId) }
      : {},
    type: "thread.activity-appended",
    payload: {
      threadId: THREAD_ID,
      activity: {
        id: EventId.makeUnsafe(`activity-${input.sequence}`),
        tone: "tool",
        kind: input.kind,
        summary: input.title ?? "Read file",
        payload: {
          itemType: "command_execution",
          title: input.title ?? "Read file",
          ...(input.providerItemId ? { providerItemId: input.providerItemId } : {}),
        },
        turnId: input.turnId ?? TURN_ID,
        createdAt: new Date(Date.parse(BASE_TIME) + input.sequence * 100).toISOString(),
      },
    },
  };
}

function queuedEvent(sequence: number): OrchestrationEvent {
  return {
    ...eventBase(sequence, "thread.turn-queued"),
    type: "thread.turn-queued",
    payload: {
      threadId: THREAD_ID,
      messageId: MessageId.makeUnsafe("queued-message"),
      assistantDeliveryMode: "streaming",
      dispatchMode: "queue",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: BASE_TIME,
    },
  };
}

function reduce(...events: OrchestrationEvent[]) {
  return events.reduce(reduceWorkspaceAgentEventState, createInitialWorkspaceAgentEventState());
}

function derive(input: {
  thread?: WorkspaceAgentShellThread;
  state?: ReturnType<typeof createInitialWorkspaceAgentEventState>;
  projects?: readonly WorkspaceAgentShellProject[];
  threads?: readonly WorkspaceAgentShellThread[];
}) {
  return deriveWorkspaceAgentActivity({
    projects: input.projects ?? [project],
    threads: input.threads ?? [input.thread ?? shellThread()],
    eventState: input.state ?? createInitialWorkspaceAgentEventState(),
    nowMs: Date.parse(BASE_TIME) + 10_000,
  });
}

describe("workspace agent event reducer", () => {
  it("rejects duplicate and out-of-order sequences", () => {
    const latest = assistantEvent({ sequence: 3, text: "latest" });
    const duplicate = { ...latest, eventId: EventId.makeUnsafe("duplicate") };
    const stale = assistantEvent({ sequence: 2, text: "stale" });

    const state = reduce(latest, duplicate, stale);

    expect(state.lastSequence).toBe(3);
    expect(state.events).toHaveLength(1);
    expect(state.threads[THREAD_ID]?.streamingMessages["assistant-1"]?.text).toBe("latest");
  });

  it("accepts ordered sparse durable sequences without discarding prior telemetry", () => {
    const beforeGap = reduce(
      toolEvent({ sequence: 1, kind: "tool.started", providerItemId: "stale-tool" }),
    );
    const afterGap = reduceWorkspaceAgentEventState(
      beforeGap,
      assistantEvent({ sequence: 3, text: "fresh" }),
    );

    expect(afterGap.generation).toBe(0);
    expect(afterGap.events.map((event) => event.sequence)).toEqual([1, 3]);
    expect(afterGap.threads[THREAD_ID]?.openTools).toHaveProperty(`${TURN_ID}:provider:stale-tool`);
    expect(afterGap.threads[THREAD_ID]?.streamingMessages["assistant-1"]?.text).toBe("fresh");
  });

  it("bounds the global event ring", () => {
    const events = Array.from({ length: WORKSPACE_AGENT_EVENT_BUFFER_LIMIT + 17 }, (_, index) =>
      assistantEvent({ sequence: index + 1, text: String(index) }),
    );

    const state = reduce(...events);

    expect(state.events).toHaveLength(WORKSPACE_AGENT_EVENT_BUFFER_LIMIT);
    expect(state.events[0]?.sequence).toBe(18);
    expect(state.events.at(-1)?.sequence).toBe(WORKSPACE_AGENT_EVENT_BUFFER_LIMIT + 17);
  });

  it("bounds per-thread telemetry to threads still represented by the event ring", () => {
    const events = Array.from({ length: WORKSPACE_AGENT_EVENT_BUFFER_LIMIT + 17 }, (_, index) => {
      const threadId = ThreadId.makeUnsafe(`bounded-thread-${index}`);
      const event = assistantEvent({
        sequence: index + 1,
        text: String(index),
        streaming: false,
      });
      return {
        ...event,
        aggregateId: threadId,
        payload: { ...event.payload, threadId },
      } as ThreadActivityAppendedEvent;
    });

    const state = reduce(...events);

    expect(Object.keys(state.threads)).toHaveLength(WORKSPACE_AGENT_EVENT_BUFFER_LIMIT);
    expect(state.threads["bounded-thread-0"]).toBeUndefined();
    expect(state.threads["bounded-thread-17"]).toBeDefined();
  });

  it("retains authoritative live telemetry when unrelated traffic rolls off its history", () => {
    const busyThreadId = ThreadId.makeUnsafe("busy-thread");
    const liveEvents = [
      queuedEvent(1),
      assistantEvent({ sequence: 2, text: "still streaming" }),
      toolEvent({ sequence: 3, kind: "tool.started", providerItemId: "long-tool" }),
    ].map(
      (event) =>
        ({
          ...event,
          aggregateId: busyThreadId,
          payload: { ...event.payload, threadId: busyThreadId },
        }) as OrchestrationEvent,
    );
    const unrelatedEvents = Array.from(
      { length: WORKSPACE_AGENT_EVENT_BUFFER_LIMIT },
      (_, index) => {
        const event = assistantEvent({ sequence: index + 4, text: String(index) });
        const threadId = ThreadId.makeUnsafe("noisy-thread");
        return {
          ...event,
          aggregateId: threadId,
          payload: { ...event.payload, threadId },
        } as OrchestrationEvent;
      },
    );

    const state = reduce(...liveEvents, ...unrelatedEvents);
    const busy = state.threads[busyThreadId];

    expect(state.events.some((event) => event.aggregateId === busyThreadId)).toBe(false);
    expect(Object.keys(busy?.queuedMessages ?? {})).toEqual(["queued-message"]);
    expect(Object.keys(busy?.streamingMessages ?? {})).toEqual(["assistant-1"]);
    expect(Object.keys(busy?.openTools ?? {})).toEqual([`${TURN_ID}:provider:long-tool`]);
  });

  it("tracks two concurrent tools independently by provider item identity", () => {
    const afterStarts = reduce(
      toolEvent({ sequence: 1, kind: "tool.started", providerItemId: "tool-a", title: "Read" }),
      toolEvent({ sequence: 2, kind: "tool.started", providerItemId: "tool-b", title: "Search" }),
    );
    const afterOneCompletes = reduceWorkspaceAgentEventState(
      afterStarts,
      toolEvent({ sequence: 3, kind: "tool.completed", providerItemId: "tool-a", title: "Read" }),
    );
    const afterBothComplete = reduceWorkspaceAgentEventState(
      afterOneCompletes,
      toolEvent({ sequence: 4, kind: "tool.completed", providerItemId: "tool-b", title: "Search" }),
    );

    expect(derive({ state: afterStarts }).threads[0]?.status).toBe("tool-running");
    expect(derive({ state: afterOneCompletes }).threads[0]).toMatchObject({
      status: "tool-running",
      latestTool: { name: "Search", state: "running" },
    });
    expect(afterOneCompletes.threads[THREAD_ID]?.openTools).toHaveProperty(
      `${TURN_ID}:provider:tool-b`,
    );
    expect(derive({ state: afterBothComplete }).threads[0]?.status).toBe("thinking");
    expect(derive({ state: afterBothComplete }).threads[0]?.latestTool).toEqual({
      name: "Search",
      state: "done",
    });
  });

  it("prefers provider item identity carried in event metadata", () => {
    const state = reduce(
      toolEvent({ sequence: 1, kind: "tool.started", metadataProviderItemId: "tool-a" }),
      toolEvent({ sequence: 2, kind: "tool.started", metadataProviderItemId: "tool-b" }),
      toolEvent({ sequence: 3, kind: "tool.completed", metadataProviderItemId: "tool-a" }),
    );

    expect(state.threads[THREAD_ID]?.openTools).not.toHaveProperty(`${TURN_ID}:provider:tool-a`);
    expect(state.threads[THREAD_ID]?.openTools).toHaveProperty(`${TURN_ID}:provider:tool-b`);
    expect(derive({ state }).threads[0]?.status).toBe("tool-running");
  });

  it("upgrades an anonymous tool to late provider identity without leaking running state", () => {
    const anonymousStarts = reduce(
      toolEvent({ sequence: 1, kind: "tool.started" }),
      toolEvent({ sequence: 2, kind: "tool.started" }),
    );
    const upgraded = reduceWorkspaceAgentEventState(
      anonymousStarts,
      toolEvent({ sequence: 3, kind: "tool.updated", providerItemId: "tool-a" }),
    );
    const completed = reduceWorkspaceAgentEventState(
      upgraded,
      toolEvent({ sequence: 4, kind: "tool.completed", providerItemId: "tool-a" }),
    );

    expect(Object.values(upgraded.threads[THREAD_ID]?.openTools ?? {})).toMatchObject([
      { count: 1 },
      { key: `${TURN_ID}:provider:tool-a`, count: 1 },
    ]);
    expect(Object.values(completed.threads[THREAD_ID]?.openTools ?? {})).toMatchObject([
      { count: 1 },
    ]);
  });

  it("completes an anonymous tool when provider identity first appears at completion", () => {
    const state = reduce(
      toolEvent({ sequence: 1, kind: "tool.started" }),
      toolEvent({ sequence: 2, kind: "tool.completed", providerItemId: "tool-late" }),
    );

    expect(state.threads[THREAD_ID]?.openTools).toEqual({});
    expect(derive({ state }).threads[0]?.status).toBe("thinking");
  });

  it("uses a deterministic counted fallback for identity-less legacy tools", () => {
    const state = reduce(
      toolEvent({ sequence: 1, kind: "tool.started", title: "Read file" }),
      toolEvent({ sequence: 2, kind: "tool.started", title: "Read file" }),
      toolEvent({ sequence: 3, kind: "tool.completed", title: "Read file" }),
    );

    expect(Object.values(state.threads[THREAD_ID]?.openTools ?? {})).toMatchObject([
      { name: "Read file", count: 1 },
    ]);
    expect(derive({ state }).threads[0]?.status).toBe("tool-running");
  });

  it("correlates anonymous lifecycle events independently of changing display summaries", () => {
    const anonymous = (
      sequence: number,
      kind: "tool.started" | "tool.completed",
      summary: string,
    ) => {
      const event = toolEvent({ sequence, kind });
      return {
        ...event,
        payload: {
          ...event.payload,
          activity: {
            ...event.payload.activity,
            summary,
            payload: { itemType: "command_execution" },
          },
        },
      } as OrchestrationEvent;
    };

    const state = reduce(
      anonymous(1, "tool.started", "Tool started"),
      anonymous(2, "tool.completed", "Tool"),
    );

    expect(state.threads[THREAD_ID]?.openTools).toEqual({});
    expect(state.threads[THREAD_ID]?.latestCompletedToolByTurn[TURN_ID]?.name).toBe("Tool");
  });

  it("preserves anonymous concurrency on updates and prefers a concrete toolName", () => {
    const first = toolEvent({ sequence: 1, kind: "tool.started", title: "MCP tool call" });
    const second = toolEvent({ sequence: 2, kind: "tool.started", title: "MCP tool call" });
    const updated = toolEvent({ sequence: 3, kind: "tool.updated", title: "MCP tool call" });
    const withToolNames = [first, second, updated].map((event) => ({
      ...event,
      payload: {
        ...event.payload,
        activity: {
          ...event.payload.activity,
          payload: {
            itemType: "command_execution",
            title: "MCP tool call",
            toolName: "Read file",
          },
        },
      },
    })) as ThreadActivityAppendedEvent[];

    const state = reduce(...withToolNames);
    expect(Object.values(state.threads[THREAD_ID]?.openTools ?? {})).toMatchObject([
      { name: "Read file", count: 2 },
    ]);
  });

  it("clears current-turn live telemetry when the session becomes terminal", () => {
    const running = reduce(
      assistantEvent({ sequence: 1 }),
      toolEvent({ sequence: 2, kind: "tool.started", providerItemId: "tool-a" }),
    );
    const terminal = reduceWorkspaceAgentEventState(running, {
      ...eventBase(3, "thread.session-set"),
      type: "thread.session-set",
      payload: {
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: new Date(Date.parse(BASE_TIME) + 300).toISOString(),
        },
      },
    });

    expect(terminal.threads[THREAD_ID]?.openTools).toEqual({});
    expect(terminal.threads[THREAD_ID]?.streamingMessages).toEqual({});
    expect(terminal.threads[THREAD_ID]?.queuedMessages).toEqual({});
  });

  it("drops prior-turn completed tool history when a new running turn starts", () => {
    const priorTurn = TurnId.makeUnsafe("turn-prior");
    const old = reduce(
      toolEvent({
        sequence: 1,
        kind: "tool.completed",
        providerItemId: "old-tool",
        turnId: priorTurn,
      }),
    );
    const next = reduceWorkspaceAgentEventState(old, {
      ...eventBase(2, "thread.session-set"),
      type: "thread.session-set",
      payload: {
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: TURN_ID,
          lastError: null,
          updatedAt: new Date(Date.parse(BASE_TIME) + 200).toISOString(),
        },
      },
    });

    expect(next.threads[THREAD_ID]?.latestCompletedToolByTurn).toEqual({});
  });

  it("clears a streaming preview when its non-streaming assistant completion arrives", () => {
    const streaming = reduce(assistantEvent({ sequence: 1, text: "partial" }));
    const complete = reduceWorkspaceAgentEventState(streaming, {
      ...assistantEvent({ sequence: 2, text: "complete", streaming: false }),
    });

    expect(complete.threads[THREAD_ID]?.streamingMessages).toEqual({});
  });
});

describe("deriveAgentStatus", () => {
  const withoutLiveTurn = (overrides: Partial<WorkspaceAgentShellThread> = {}) =>
    shellThread({
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: null,
      hasLiveTailWork: false,
      ...overrides,
    });

  it("derives every public agent status from shell and event state", () => {
    const streamingState = reduce(assistantEvent({ sequence: 1 }));
    const toolState = reduce(
      assistantEvent({ sequence: 1 }),
      toolEvent({ sequence: 2, kind: "tool.started", providerItemId: "tool-status" }),
    );
    const queuedState = reduce(queuedEvent(1));
    const completed = withoutLiveTurn({
      latestTurn: {
        ...shellThread().latestTurn!,
        state: "completed",
        completedAt: new Date(Date.parse(BASE_TIME) + 5_000).toISOString(),
      },
    });
    const failed = withoutLiveTurn({
      session: {
        ...shellThread().session!,
        status: "error",
        activeTurnId: null,
        lastError: "failed",
      },
      latestTurn: { ...shellThread().latestTurn!, state: "error" },
    });
    const stopped = withoutLiveTurn({
      session: { ...shellThread().session!, status: "stopped", activeTurnId: null },
      latestTurn: { ...shellThread().latestTurn!, state: "interrupted" },
    });
    const starting = withoutLiveTurn({
      session: { ...shellThread().session!, status: "starting", activeTurnId: null },
    });

    expect(deriveAgentStatus(shellThread(), undefined)).toBe("thinking");
    expect(deriveAgentStatus(shellThread(), streamingState.threads[THREAD_ID])).toBe("streaming");
    expect(deriveAgentStatus(shellThread(), toolState.threads[THREAD_ID])).toBe("tool-running");
    expect(deriveAgentStatus(starting, undefined)).toBe("connecting");
    expect(deriveAgentStatus(starting, queuedState.threads[THREAD_ID])).toBe("queued");
    expect(deriveAgentStatus(withoutLiveTurn(), queuedState.threads[THREAD_ID])).toBe("queued");
    expect(deriveAgentStatus(completed, undefined)).toBe("completed");
    expect(deriveAgentStatus(failed, undefined)).toBe("failed");
    expect(deriveAgentStatus(stopped, undefined)).toBe("stopped");
    expect(deriveAgentStatus(withoutLiveTurn(), undefined)).toBe("idle");
  });
});

describe("deriveWorkspaceAgentActivity", () => {
  it("uses failed and interrupted terminal shell states before buffered activity", () => {
    const childId = ThreadId.makeUnsafe("live-child");
    const activity = reduce(
      assistantEvent({ sequence: 1 }),
      toolEvent({ sequence: 2, kind: "tool.started", providerItemId: "tool-a" }),
    );

    expect(
      derive({
        state: activity,
        threads: [
          shellThread({
            session: { ...shellThread().session!, status: "error", lastError: "boom" },
          }),
          shellThread({ threadId: childId, parentThreadId: THREAD_ID }),
        ],
      }).threads[0]?.status,
    ).toBe("failed");
    expect(
      derive({
        state: activity,
        threads: [
          shellThread({
            session: { ...shellThread().session!, status: "ready", activeTurnId: null },
            latestTurn: { ...shellThread().latestTurn!, state: "interrupted" },
          }),
          shellThread({ threadId: childId, parentThreadId: THREAD_ID }),
        ],
      }).threads[0]?.status,
    ).toBe("interrupted");
  });

  it("gives strict live work precedence over queued follow-ups", () => {
    expect(derive({ state: reduce(queuedEvent(1)) }).threads[0]?.status).toBe("thinking");
  });

  it("does not let stale terminal turns mask queued work or provider startup", () => {
    const readyAfterFailure = shellThread({
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: { ...shellThread().latestTurn!, state: "error" },
      hasLiveTailWork: false,
    });
    const startingAfterInterruption = shellThread({
      session: { ...shellThread().session!, status: "starting", activeTurnId: null },
      latestTurn: { ...shellThread().latestTurn!, state: "interrupted" },
      hasLiveTailWork: false,
    });

    expect(
      derive({ thread: readyAfterFailure, state: reduce(queuedEvent(1)) }).threads[0]?.status,
    ).toBe("queued");
    expect(derive({ thread: startingAfterInterruption }).threads[0]?.status).toBe("connecting");
  });

  it("lets a newer surviving queue outrank terminal shell history", () => {
    const terminalEvent = {
      ...eventBase(1, "thread.session-set"),
      type: "thread.session-set",
      payload: {
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: "error",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "old failure",
          updatedAt: BASE_TIME,
        },
      },
    } as OrchestrationEvent;
    const terminalShell = shellThread({
      session: {
        ...shellThread().session!,
        status: "error",
        activeTurnId: null,
        lastError: "old failure",
      },
      latestTurn: { ...shellThread().latestTurn!, state: "error" },
      hasLiveTailWork: false,
    });

    const newerQueue = reduce(terminalEvent, queuedEvent(2));
    expect(derive({ thread: terminalShell, state: newerQueue }).threads[0]?.status).toBe("queued");

    const terminalAfterQueue = reduce(queuedEvent(1), {
      ...terminalEvent,
      sequence: 2,
      eventId: EventId.makeUnsafe("terminal-after-queue"),
    });
    expect(terminalAfterQueue.threads[THREAD_ID]?.queuedMessages).toEqual({});
  });

  it("honors live-tail work for a ready session without reviving terminal sessions", () => {
    const streaming = reduce(assistantEvent({ sequence: 1, text: "live tail" }));
    const readyTail = shellThread({
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      hasLiveTailWork: true,
    });
    const failedTail = shellThread({
      session: {
        ...shellThread().session!,
        status: "error",
        activeTurnId: null,
        lastError: "failed",
      },
      hasLiveTailWork: true,
    });

    expect(derive({ thread: readyTail, state: streaming }).threads[0]).toMatchObject({
      status: "streaming",
      streamPreview: "live tail",
    });
    expect(
      derive({
        state: streaming,
        threads: [
          failedTail,
          shellThread({ threadId: ThreadId.makeUnsafe("live-child"), parentThreadId: THREAD_ID }),
        ],
      }).threads.find((entry) => entry.threadId === THREAD_ID)?.status,
    ).toBe("failed");
  });

  it("does not let stale terminal turn history mask an authoritative running session", () => {
    const running = shellThread({
      latestTurn: { ...shellThread().latestTurn!, state: "interrupted" },
    });

    expect(derive({ thread: running }).threads[0]?.status).toBe("thinking");
  });

  it("prefers current-turn tools over current-turn streaming and ignores prior turns", () => {
    const priorTurn = TurnId.makeUnsafe("turn-prior");
    const streaming = reduce(
      assistantEvent({ sequence: 1, turnId: TURN_ID, text: "Current output" }),
      toolEvent({
        sequence: 2,
        kind: "tool.started",
        providerItemId: "old-tool",
        turnId: priorTurn,
      }),
    );
    const currentTool = reduceWorkspaceAgentEventState(
      streaming,
      toolEvent({ sequence: 3, kind: "tool.started", providerItemId: "new-tool" }),
    );

    expect(derive({ state: streaming }).threads[0]).toMatchObject({
      status: "streaming",
      streamPreview: "Current output",
    });
    expect(derive({ state: currentTool }).threads[0]?.status).toBe("tool-running");
  });

  it("limits the visible stream preview to the latest 80 characters", () => {
    const text = `discard-${"x".repeat(90)}`;
    const preview = derive({ state: reduce(assistantEvent({ sequence: 1, text })) }).threads[0]
      ?.streamPreview;

    expect(preview).toBe("x".repeat(80));
  });

  it("derives starting, unresolved queue, completed, and idle states", () => {
    const starting = shellThread({
      session: { ...shellThread().session!, status: "starting", activeTurnId: null },
      latestTurn: null,
    });
    const startingActiveTurn = shellThread({
      session: { ...shellThread().session!, status: "starting", activeTurnId: TURN_ID },
      hasLiveTailWork: false,
    });
    const ready = shellThread({
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: null,
      hasLiveTailWork: false,
    });
    const completed = shellThread({
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: {
        ...shellThread().latestTurn!,
        state: "completed",
        completedAt: new Date(Date.parse(BASE_TIME) + 5_000).toISOString(),
      },
    });

    expect(derive({ thread: starting }).threads[0]?.status).toBe("connecting");
    expect(derive({ thread: startingActiveTurn }).threads[0]).toMatchObject({
      status: "connecting",
      turnId: TURN_ID,
    });
    expect(derive({ thread: ready, state: reduce(queuedEvent(1)) }).threads[0]?.status).toBe(
      "queued",
    );
    expect(
      derive({
        threads: [
          completed,
          shellThread({
            threadId: ThreadId.makeUnsafe("thread-live"),
            parentThreadId: THREAD_ID,
          }),
        ],
      }).threads.find((entry) => entry.threadId === THREAD_ID)?.status,
    ).toBe("tool-running");
    expect(derive({ thread: ready }).threads).toEqual([]);
  });

  it("retires terminal rows when no live or queued family remains", () => {
    const completed = shellThread({
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: {
        ...shellThread().latestTurn!,
        state: "completed",
        completedAt: new Date(Date.parse(BASE_TIME) + 5_000).toISOString(),
      },
    });

    expect(derive({ thread: completed })).toEqual({
      threads: [],
      groups: [],
      summary: { total: 0, running: 0, queued: 0, completed: 0, failed: 0 },
    });
  });

  it("keeps terminal siblings and idle ancestors only while their family has live work", () => {
    const rootId = ThreadId.makeUnsafe("root");
    const liveId = ThreadId.makeUnsafe("child-live");
    const doneId = ThreadId.makeUnsafe("child-done");
    const root = shellThread({
      threadId: rootId,
      session: null,
      latestTurn: null,
      hasLiveTailWork: false,
    });
    const live = shellThread({ threadId: liveId, parentThreadId: rootId });
    const done = shellThread({
      threadId: doneId,
      parentThreadId: rootId,
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: {
        ...shellThread().latestTurn!,
        state: "completed",
        completedAt: new Date(Date.parse(BASE_TIME) + 5_000).toISOString(),
      },
    });

    const result = derive({ threads: [root, live, done] });

    expect(result.threads.map((entry) => [entry.threadId, entry.status])).toEqual([
      [rootId, "tool-running"],
      [liveId, "thinking"],
      [doneId, "completed"],
    ]);
    expect(result.groups[0]?.nodes[0]?.children.map((node) => node.entry.threadId)).toEqual([
      liveId,
      doneId,
    ]);
  });

  it("protects arbitrary-depth trees from orphans and cycles", () => {
    const orphan = shellThread({
      threadId: ThreadId.makeUnsafe("orphan"),
      parentThreadId: ThreadId.makeUnsafe("missing"),
    });
    const cycleA = shellThread({
      threadId: ThreadId.makeUnsafe("cycle-a"),
      parentThreadId: ThreadId.makeUnsafe("cycle-b"),
    });
    const cycleB = shellThread({
      threadId: ThreadId.makeUnsafe("cycle-b"),
      parentThreadId: ThreadId.makeUnsafe("cycle-a"),
    });

    const result = derive({ threads: [orphan, cycleB, cycleA] });
    const roots = result.groups[0]?.nodes.map((node) => node.entry.threadId);

    expect(roots).toContain(ThreadId.makeUnsafe("orphan"));
    expect(roots).toContain(ThreadId.makeUnsafe("cycle-a"));
    expect(result.threads).toHaveLength(3);
    expect(new Set(result.threads.map((entry) => entry.threadId)).size).toBe(3);
  });

  it("keeps more than eight live shell threads visible", () => {
    const threads = Array.from({ length: 12 }, (_, index) =>
      shellThread({ threadId: ThreadId.makeUnsafe(`thread-${index}`) }),
    );

    const result = derive({ threads });

    expect(result.threads).toHaveLength(12);
    expect(result.summary).toMatchObject({ total: 12, running: 12 });
  });

  it("classifies a canonical sessionless child with a running tail as live", () => {
    const child = shellThread({
      session: null,
      hasLiveTailWork: true,
      parentThreadId: ThreadId.makeUnsafe("missing-parent"),
    });

    expect(derive({ thread: child }).threads[0]).toMatchObject({
      status: "thinking",
      turnId: TURN_ID,
    });
  });

  it("keeps a genuine sessionless root visible without exposing an unroutable interrupt", () => {
    const root = shellThread({
      threadId: ThreadId.makeUnsafe("genuine-sessionless-root"),
      session: null,
      hasLiveTailWork: true,
      parentThreadId: null,
    });

    expect(derive({ thread: root }).threads[0]).toMatchObject({
      status: "thinking",
      turnId: null,
    });
  });

  it("keeps a sessionless live-tail shell visible before a latest turn record arrives", () => {
    const child = shellThread({
      session: null,
      latestTurn: null,
      hasLiveTailWork: true,
      parentThreadId: ThreadId.makeUnsafe("missing-parent"),
    });

    expect(derive({ thread: child }).threads[0]).toMatchObject({
      status: "thinking",
      turnId: null,
    });
  });

  it("excludes terminal siblings from an older family run", () => {
    const rootId = ThreadId.makeUnsafe("root-current");
    const liveId = ThreadId.makeUnsafe("live-current");
    const historicalId = ThreadId.makeUnsafe("done-old");
    const root = shellThread({
      threadId: rootId,
      session: null,
      latestTurn: null,
      hasLiveTailWork: false,
    });
    const live = shellThread({
      threadId: liveId,
      parentThreadId: rootId,
      latestTurn: {
        ...shellThread().latestTurn!,
        requestedAt: new Date(Date.parse(BASE_TIME) + 8_000).toISOString(),
        startedAt: new Date(Date.parse(BASE_TIME) + 8_000).toISOString(),
      },
      session: {
        ...shellThread().session!,
        updatedAt: new Date(Date.parse(BASE_TIME) + 8_000).toISOString(),
      },
    });
    const historical = shellThread({
      threadId: historicalId,
      parentThreadId: rootId,
      session: {
        ...shellThread().session!,
        status: "ready",
        activeTurnId: null,
        updatedAt: new Date(Date.parse(BASE_TIME) + 2_000).toISOString(),
      },
      latestTurn: {
        ...shellThread().latestTurn!,
        state: "completed",
        completedAt: new Date(Date.parse(BASE_TIME) + 2_000).toISOString(),
      },
    });

    expect(
      derive({ threads: [root, live, historical] }).threads.map((entry) => entry.threadId),
    ).toEqual([rootId, liveId]);
  });

  it("uses a new queued timestamp instead of an old latest turn for family recency", () => {
    const rootId = ThreadId.makeUnsafe("root-queued");
    const queuedId = ThreadId.makeUnsafe("queued-current");
    const historicalId = ThreadId.makeUnsafe("done-between-runs");
    const queuedAt = new Date(Date.parse(BASE_TIME) + 8_000).toISOString();
    const root = shellThread({
      threadId: rootId,
      session: null,
      latestTurn: null,
      hasLiveTailWork: false,
    });
    const queued = shellThread({
      threadId: queuedId,
      parentThreadId: rootId,
      session: {
        ...shellThread().session!,
        status: "ready",
        activeTurnId: null,
        updatedAt: new Date(Date.parse(BASE_TIME) + 9_000).toISOString(),
      },
      latestTurn: {
        ...shellThread().latestTurn!,
        state: "completed",
        completedAt: new Date(Date.parse(BASE_TIME) + 1_000).toISOString(),
      },
      hasLiveTailWork: false,
    });
    const historical = shellThread({
      threadId: historicalId,
      parentThreadId: rootId,
      session: {
        ...shellThread().session!,
        status: "ready",
        activeTurnId: null,
        updatedAt: new Date(Date.parse(BASE_TIME) + 5_000).toISOString(),
      },
      latestTurn: {
        ...shellThread().latestTurn!,
        state: "completed",
        completedAt: new Date(Date.parse(BASE_TIME) + 5_000).toISOString(),
      },
      hasLiveTailWork: false,
    });
    const queuedActivity = {
      ...queuedEvent(1),
      aggregateId: queuedId,
      payload: {
        ...queuedEvent(1).payload,
        threadId: queuedId,
        createdAt: queuedAt,
      },
    } as OrchestrationEvent;

    expect(
      derive({ threads: [root, queued, historical], state: reduce(queuedActivity) }).threads.map(
        (entry) => entry.threadId,
      ),
    ).toEqual([rootId, queuedId]);
  });
});

describe("workspace agent labels and timing", () => {
  it("derives parent context and running counts from direct children only", () => {
    const rootId = ThreadId.makeUnsafe("thread-hover-root");
    const runningId = ThreadId.makeUnsafe("thread-hover-running");
    const connectingId = ThreadId.makeUnsafe("thread-hover-connecting");
    const completedId = ThreadId.makeUnsafe("thread-hover-completed");
    const grandchildId = ThreadId.makeUnsafe("thread-hover-grandchild");
    const greatGrandchildId = ThreadId.makeUnsafe("thread-hover-great-grandchild");
    const archivedId = ThreadId.makeUnsafe("thread-hover-archived");
    const root = shellThread({
      threadId: rootId,
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: null,
      hasLiveTailWork: false,
    });
    const running = shellThread({ threadId: runningId, parentThreadId: rootId });
    const connecting = shellThread({
      threadId: connectingId,
      parentThreadId: rootId,
      session: { ...shellThread().session!, status: "starting", activeTurnId: null },
      latestTurn: null,
      hasLiveTailWork: false,
    });
    const completed = shellThread({
      threadId: completedId,
      parentThreadId: rootId,
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: {
        ...shellThread().latestTurn!,
        state: "completed",
        completedAt: new Date(Date.parse(BASE_TIME) + 5_000).toISOString(),
      },
      hasLiveTailWork: false,
    });
    const grandchild = shellThread({ threadId: grandchildId, parentThreadId: runningId });
    const greatGrandchild = shellThread({
      threadId: greatGrandchildId,
      parentThreadId: grandchildId,
    });
    const archived = shellThread({
      threadId: archivedId,
      parentThreadId: rootId,
      archivedAt: BASE_TIME,
    });
    const threads = [root, running, connecting, completed, grandchild, greatGrandchild, archived];
    const rootActivity = deriveWorkspaceAgentThreadActivity({
      threadId: rootId,
      projects: [project],
      threads,
      eventState: createInitialWorkspaceAgentEventState(),
      nowMs: Date.parse(BASE_TIME) + 10_000,
    });
    const childActivity = deriveWorkspaceAgentThreadActivity({
      threadId: runningId,
      projects: [project],
      threads,
      eventState: createInitialWorkspaceAgentEventState(),
      nowMs: Date.parse(BASE_TIME) + 10_000,
    });

    expect(rootActivity).toMatchObject({
      entry: {
        threadId: rootId,
        status: "tool-running",
        activityState: { subagentCount: 3, subagentRunningCount: 2 },
      },
      parentEntry: null,
      subagentCount: 3,
      subagentRunningCount: 2,
    });
    expect(childActivity).toMatchObject({
      entry: { threadId: runningId },
      parentEntry: { threadId: rootId },
      subagentCount: 1,
      subagentRunningCount: 1,
    });
    const runningTreeNode = rootActivity.subagentTree.find(
      (node) => node.entry.threadId === runningId,
    );
    expect(runningTreeNode?.children.map((node) => node.entry.threadId)).toEqual([grandchildId]);
    expect(runningTreeNode?.children[0]?.children).toEqual([]);
  });

  it("keeps idle and terminal targets available to the per-thread activity hook", () => {
    const idle = shellThread({
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: null,
      hasLiveTailWork: false,
    });
    const completed = shellThread({
      session: { ...shellThread().session!, status: "ready", activeTurnId: null },
      latestTurn: {
        ...shellThread().latestTurn!,
        state: "completed",
        completedAt: new Date(Date.parse(BASE_TIME) + 5_000).toISOString(),
      },
      hasLiveTailWork: false,
    });
    const baseInput = {
      threadId: THREAD_ID,
      projects: [project],
      eventState: createInitialWorkspaceAgentEventState(),
      nowMs: Date.parse(BASE_TIME) + 50_000,
    };

    expect(
      deriveWorkspaceAgentThreadActivity({ ...baseInput, threads: [idle] }).entry,
    ).toMatchObject({ status: "idle" });
    expect(
      deriveWorkspaceAgentThreadActivity({ ...baseInput, threads: [completed] }).entry,
    ).toMatchObject({ status: "completed", duration: 5_000 });
  });

  it.each<[ModelSelection, string | null]>([
    [{ provider: "codex", model: "gpt", options: { reasoningEffort: "high" } }, "high"],
    [{ provider: "claudeAgent", model: "claude", options: { effort: "medium" } }, "medium"],
    [{ provider: "cursor", model: "cursor", options: { reasoningEffort: "low" } }, "low"],
    [{ provider: "antigravity", model: "gemini", options: { reasoningEffort: "high" } }, "high"],
    [{ provider: "grok", model: "grok", options: { reasoningEffort: "high" } }, "high"],
    [{ provider: "droid", model: "droid", options: { reasoningEffort: "medium" } }, "medium"],
    [{ provider: "pi", model: "pi", options: { thinkingLevel: "high" } }, "high"],
    [{ provider: "opencode", model: "open", options: { variant: "review" } }, "review"],
    [{ provider: "kilo", model: "kilo", options: { agent: "architect" } }, "architect"],
    [{ provider: "commandCode", model: "gpt-5.6-sol", options: {} }, null],
  ])("reads effort-like metadata for $provider", (selection, expected) => {
    expect(modelEffortLabel(selection)).toBe(expected);
  });

  it("uses started/requested timing, terminal completion, and clamps malformed values", () => {
    const start = Date.parse(BASE_TIME);
    const turn = shellThread().latestTurn!;

    expect(
      deriveAgentDuration({ status: "thinking", latestTurn: turn, nowMs: start + 3_500 }),
    ).toBe(3_500);
    expect(
      deriveAgentDuration({
        status: "completed",
        latestTurn: { ...turn, completedAt: new Date(start + 2_000).toISOString() },
        nowMs: start + 9_000,
      }),
    ).toBe(2_000);
    expect(
      deriveAgentDuration({
        status: "completed",
        latestTurn: { ...turn, startedAt: "bad", requestedAt: "bad", completedAt: BASE_TIME },
        nowMs: start,
      }),
    ).toBe(0);
    expect(
      deriveAgentDuration({
        status: "thinking",
        latestTurn: { ...turn, startedAt: new Date(start + 10_000).toISOString() },
        nowMs: start,
      }),
    ).toBe(0);
  });

  it("freezes terminal duration at the session update when completion time is absent", () => {
    const start = Date.parse(BASE_TIME);
    expect(
      deriveAgentDuration({
        status: "failed",
        latestTurn: { ...shellThread().latestTurn!, completedAt: null },
        sessionUpdatedAt: new Date(start + 2_500).toISOString(),
        nowMs: start + 50_000,
      }),
    ).toBe(2_500);
  });

  it("measures a new queue from its queue timestamp instead of an older turn", () => {
    const start = Date.parse(BASE_TIME);
    expect(
      deriveAgentDuration({
        status: "queued",
        latestTurn: {
          ...shellThread().latestTurn!,
          state: "completed",
          completedAt: new Date(start + 1_000).toISOString(),
        },
        queuedAt: new Date(start + 8_000).toISOString(),
        sessionUpdatedAt: new Date(start + 9_000).toISOString(),
        nowMs: start + 10_000,
      }),
    ).toBe(2_000);
  });

  it("measures a new connection from its session timestamp instead of an older turn", () => {
    const start = Date.parse(BASE_TIME);
    const activity = deriveWorkspaceAgentThreadActivity({
      threadId: THREAD_ID,
      projects: [project],
      threads: [
        shellThread({
          session: {
            ...shellThread().session!,
            status: "starting",
            activeTurnId: null,
            updatedAt: new Date(start + 8_000).toISOString(),
          },
          latestTurn: {
            ...shellThread().latestTurn!,
            state: "completed",
            completedAt: new Date(start + 1_000).toISOString(),
          },
          hasLiveTailWork: false,
        }),
      ],
      eventState: createInitialWorkspaceAgentEventState(),
      nowMs: start + 10_000,
    });

    expect(activity.entry).toMatchObject({ status: "connecting", duration: 2_000 });
  });
});
