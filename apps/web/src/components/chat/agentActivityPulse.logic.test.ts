import { describe, expect, it } from "vitest";

import type { AgentActivityInput } from "./agentActivityPulse.logic";
import { deriveAgentActivityState } from "./agentActivityPulse.logic";

const TURN_ID = "turn-1" as never;
const USER_MESSAGE = {
  role: "user" as const,
  text: "Implement the feature",
  streaming: false,
  turnId: TURN_ID,
  createdAt: "2026-07-20T12:00:00.000Z",
};

function baseInput(overrides: Partial<AgentActivityInput> = {}): AgentActivityInput {
  return {
    threadId: "thread-1",
    hasMessages: true,
    localDispatchPending: false,
    session: {
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: TURN_ID,
      updatedAt: "2026-07-20T12:00:01.000Z",
    },
    latestTurn: {
      turnId: TURN_ID,
      state: "running",
      requestedAt: "2026-07-20T12:00:00.000Z",
      startedAt: "2026-07-20T12:00:01.000Z",
      completedAt: null,
    },
    messages: [USER_MESSAGE],
    activities: [],
    hasPendingApproval: false,
    hasPendingUserInput: false,
    threadError: null,
    ...overrides,
  };
}

function toolActivity(
  kind: "tool.started" | "tool.updated" | "tool.completed",
  payload: AgentActivityInput["activities"][number]["payload"],
  overrides: Partial<AgentActivityInput["activities"][number]> = {},
): AgentActivityInput["activities"][number] {
  return {
    kind,
    payload,
    summary: "Run tool",
    turnId: TURN_ID,
    createdAt: "2026-07-20T12:00:02.000Z",
    ...overrides,
  };
}

describe("deriveAgentActivityState", () => {
  it("shows first-send thinking before the optimistic message is persisted", () => {
    expect(
      deriveAgentActivityState(
        baseInput({ hasMessages: false, messages: [], localDispatchPending: true }),
      ),
    ).toMatchObject({ phase: "thinking", turnKey: "pending:thread-1" });
  });

  it("stays unmounted for user-blocked threads", () => {
    expect(deriveAgentActivityState(baseInput({ hasPendingApproval: true })).phase).toBe("idle");
    expect(deriveAgentActivityState(baseInput({ hasPendingUserInput: true })).phase).toBe("idle");
  });

  it("shows thinking immediately for local dispatch and live turns without output", () => {
    const pending = deriveAgentActivityState(
      baseInput({
        localDispatchPending: true,
        session: null,
        latestTurn: null,
        messages: [{ ...USER_MESSAGE, turnId: null }],
      }),
    );
    expect(pending).toMatchObject({ phase: "thinking", turnKey: "pending:thread-1" });
    expect(deriveAgentActivityState(baseInput()).phase).toBe("thinking");
  });

  it.each(["completed", "interrupted"] as const)(
    "lets a new local lifecycle override a stale %s latest turn",
    (state) => {
      const latestTurn = {
        ...baseInput().latestTurn!,
        state,
        completedAt: "2026-07-20T12:00:03.000Z",
      };
      const session = {
        ...baseInput().session!,
        status: "ready" as const,
        orchestrationStatus: "ready" as const,
        activeTurnId: undefined,
      };

      expect(
        deriveAgentActivityState(baseInput({ latestTurn, session, localDispatchPending: true })),
      ).toMatchObject({ phase: "thinking", turnKey: "pending:thread-1" });
      expect(
        deriveAgentActivityState(
          baseInput({
            latestTurn,
            session: { ...session, status: "connecting", orchestrationStatus: "starting" },
          }),
        ),
      ).toMatchObject({ phase: "thinking", turnKey: "pending:thread-1" });
    },
  );

  it("treats a running session without a projected turn id as a new lifecycle", () => {
    const latestTurn = {
      ...baseInput().latestTurn!,
      state: "completed" as const,
      completedAt: "2026-07-20T12:00:03.000Z",
    };
    const session = {
      ...baseInput().session!,
      activeTurnId: undefined,
    };

    expect(deriveAgentActivityState(baseInput({ latestTurn, session }))).toMatchObject({
      phase: "thinking",
      turnKey: "pending:thread-1",
    });
    expect(
      deriveAgentActivityState(baseInput({ latestTurn, session, hasPendingApproval: true })),
    ).toMatchObject({ phase: "idle", turnKey: "pending:thread-1" });
  });

  it("maps live assistant output to streaming but ignores stale completed output", () => {
    const streamingMessage = {
      role: "assistant" as const,
      text: "Working on it",
      streaming: true,
      turnId: TURN_ID,
      createdAt: "2026-07-20T12:00:02.000Z",
    };
    expect(
      deriveAgentActivityState(baseInput({ messages: [USER_MESSAGE, streamingMessage] })).phase,
    ).toBe("streaming");
    expect(
      deriveAgentActivityState(
        baseInput({
          messages: [USER_MESSAGE, streamingMessage],
          latestTurn: {
            ...baseInput().latestTurn!,
            state: "completed",
            completedAt: "2026-07-20T12:00:03.000Z",
          },
          session: {
            ...baseInput().session!,
            status: "ready",
            orchestrationStatus: "ready",
            activeTurnId: undefined,
          },
        }),
      ).phase,
    ).toBe("completed");
  });

  it("gives active tools precedence over streaming and returns after completion", () => {
    const streamingMessage = {
      role: "assistant" as const,
      text: "Checking files",
      streaming: true,
      turnId: TURN_ID,
      createdAt: "2026-07-20T12:00:02.000Z",
    };
    const started = toolActivity("tool.started", { data: { toolCallId: "call-1" } });
    const completed = toolActivity(
      "tool.completed",
      { data: { toolCallId: "call-1" } },
      {
        createdAt: "2026-07-20T12:00:03.000Z",
      },
    );

    expect(
      deriveAgentActivityState(
        baseInput({ messages: [USER_MESSAGE, streamingMessage], activities: [started] }),
      ),
    ).toMatchObject({ phase: "tool-running", toolCount: 1 });
    expect(
      deriveAgentActivityState(
        baseInput({ messages: [USER_MESSAGE, streamingMessage], activities: [started, completed] }),
      ).phase,
    ).toBe("streaming");
    expect(deriveAgentActivityState(baseInput({ activities: [started, completed] })).phase).toBe(
      "thinking",
    );
  });

  it("counts parallel stable IDs and counted semantic fallbacks", () => {
    const stable = deriveAgentActivityState(
      baseInput({
        activities: [
          toolActivity("tool.started", { data: { toolCallId: "call-a" } }),
          toolActivity("tool.started", { data: { toolCallId: "call-b" } }),
          toolActivity("tool.completed", { data: { toolCallId: "call-a" } }),
        ],
      }),
    );
    expect(stable).toMatchObject({ phase: "tool-running", toolCount: 1 });

    const fallbackPayload = { itemType: "dynamic_tool_call", data: { toolName: "Search" } };
    const fallback = deriveAgentActivityState(
      baseInput({
        activities: [
          toolActivity("tool.started", fallbackPayload),
          toolActivity("tool.started", fallbackPayload),
          toolActivity("tool.completed", fallbackPayload),
        ],
      }),
    );
    expect(fallback).toMatchObject({ phase: "tool-running", toolCount: 1 });
  });

  it("correlates canonical no-ID tool summaries through the top-level title", () => {
    const started = toolActivity(
      "tool.started",
      { itemType: "command_execution", title: "Read file", status: "inProgress" },
      { summary: "Read file started" },
    );
    const completed = toolActivity(
      "tool.completed",
      { itemType: "command_execution", title: "Read file", status: "completed" },
      { summary: "Read file", createdAt: "2026-07-20T12:00:03.000Z" },
    );

    expect(deriveAgentActivityState(baseInput({ activities: [started] }))).toMatchObject({
      phase: "tool-running",
      toolCount: 1,
    });
    expect(deriveAgentActivityState(baseInput({ activities: [started, completed] }))).toMatchObject(
      { phase: "thinking", toolCount: 0 },
    );
  });

  it("orders lifecycle edges by orchestration sequence before reducing them", () => {
    const started = toolActivity(
      "tool.started",
      { data: { toolCallId: "ordered-call" } },
      { sequence: 10, createdAt: "2026-07-20T12:00:03.000Z" },
    );
    const completed = toolActivity(
      "tool.completed",
      { data: { toolCallId: "ordered-call" } },
      { sequence: 11, createdAt: "2026-07-20T12:00:02.000Z" },
    );

    expect(deriveAgentActivityState(baseInput({ activities: [completed, started] }))).toMatchObject(
      { phase: "thinking", toolCount: 0 },
    );
  });

  it.each([
    ["Codex", { data: { toolCallId: "codex-call" } }],
    ["Claude", { data: { callID: "claude-call" } }],
    ["Cursor", { data: { item: { id: "cursor-call" } } }],
    ["OpenCode", { data: { toolUseId: "opencode-call" } }],
  ] as const)("recognizes normalized %s tool identity", (_provider, payload) => {
    const state = deriveAgentActivityState(
      baseInput({ activities: [toolActivity("tool.updated", payload)] }),
    );
    expect(state).toMatchObject({ phase: "tool-running", toolCount: 1 });
  });

  it("ignores stale tool activity from another turn", () => {
    const state = deriveAgentActivityState(
      baseInput({
        activities: [
          toolActivity(
            "tool.started",
            { data: { toolCallId: "old-call" } },
            {
              turnId: "turn-old" as never,
            },
          ),
        ],
      }),
    );
    expect(state).toMatchObject({ phase: "thinking", toolCount: 0 });
  });

  it("keeps a new active turn live when an older terminal turn arrives late", () => {
    const activeTurnId = "turn-new" as never;
    const state = deriveAgentActivityState(
      baseInput({
        session: {
          ...baseInput().session!,
          activeTurnId,
        },
        latestTurn: {
          ...baseInput().latestTurn!,
          turnId: "turn-old" as never,
          state: "completed",
          completedAt: "2026-07-20T12:00:03.000Z",
        },
      }),
    );

    expect(state).toMatchObject({ phase: "thinking", turnKey: "turn-new" });
  });

  it("counts active subagents reported by normalized tool activity", () => {
    const state = deriveAgentActivityState(
      baseInput({
        activities: [
          toolActivity("tool.updated", {
            data: {
              toolCallId: "collab-call",
              subagents: [
                { threadId: "child-1", status: "running" },
                { threadId: "child-2", status: "completed" },
              ],
            },
          }),
        ],
      }),
    );
    expect(state).toMatchObject({ phase: "tool-running", subagentCount: 1 });
  });

  it("retires subagents from nested canonical state snapshots", () => {
    const started = toolActivity("tool.updated", {
      itemType: "collab_agent_tool_call",
      data: {
        item: {
          id: "collab-call",
          statuses: { "child-1": { status: "in_progress" } },
        },
      },
    });
    const completed = toolActivity(
      "tool.completed",
      {
        itemType: "collab_agent_tool_call",
        status: "completed",
        data: {
          item: {
            id: "collab-call",
            statuses: { "child-1": { status: "completed" } },
          },
        },
      },
      { createdAt: "2026-07-20T12:00:03.000Z" },
    );

    expect(deriveAgentActivityState(baseInput({ activities: [started] }))).toMatchObject({
      phase: "tool-running",
      subagentCount: 1,
    });
    expect(deriveAgentActivityState(baseInput({ activities: [started, completed] }))).toMatchObject(
      { phase: "thinking", subagentCount: 0 },
    );
  });

  it("tracks subagent-only work until its nested state completes", () => {
    const running = toolActivity("tool.completed", {
      itemType: "collab_agent_tool_call",
      status: "completed",
      data: {
        item: {
          id: "collab-call",
          statuses: { "child-1": { status: "running" } },
        },
      },
    });
    const completed = toolActivity(
      "tool.completed",
      {
        itemType: "collab_agent_tool_call",
        status: "completed",
        data: {
          item: {
            id: "collab-call",
            statuses: { "child-1": { status: "completed" } },
          },
        },
      },
      { createdAt: "2026-07-20T12:00:03.000Z" },
    );

    expect(deriveAgentActivityState(baseInput({ activities: [running] }))).toMatchObject({
      phase: "tool-running",
      toolCount: 0,
      subagentCount: 1,
    });
    expect(deriveAgentActivityState(baseInput({ activities: [running, completed] }))).toMatchObject(
      { phase: "thinking", toolCount: 0, subagentCount: 0 },
    );
  });

  it("ignores a legacy null-turn streaming message during a concrete live turn", () => {
    expect(
      deriveAgentActivityState(
        baseInput({
          messages: [
            USER_MESSAGE,
            {
              role: "assistant",
              text: "Stale output",
              streaming: true,
              turnId: null,
              createdAt: "2026-07-20T12:00:02.000Z",
            },
          ],
        }),
      ).phase,
    ).toBe("thinking");
  });

  it.each([
    ["completed", { latestTurn: { ...baseInput().latestTurn!, state: "completed" as const } }],
    ["interrupted", { latestTurn: { ...baseInput().latestTurn!, state: "interrupted" as const } }],
    ["failed", { latestTurn: { ...baseInput().latestTurn!, state: "error" as const } }],
    ["failed", { threadError: "Provider crashed" }],
  ] as const)("derives the %s terminal target", (phase, overrides) => {
    expect(deriveAgentActivityState(baseInput(overrides)).phase).toBe(phase);
  });

  it.each(["interrupted", "cancelled"] as const)(
    "uses the terminal activity payload to preserve a %s completion",
    (state) => {
      const terminal = toolActivity(
        "tool.completed",
        {},
        {
          kind: "turn.completed",
          payload: { state },
          summary: "Turn completed",
          createdAt: "2026-07-20T12:00:04.000Z",
        },
      );
      const latestTurn = {
        ...baseInput().latestTurn!,
        state: "completed" as const,
        completedAt: "2026-07-20T12:00:04.000Z",
      };
      const session = {
        ...baseInput().session!,
        status: "ready" as const,
        orchestrationStatus: "ready" as const,
        activeTurnId: undefined,
      };

      expect(
        deriveAgentActivityState(baseInput({ activities: [terminal], latestTurn, session })).phase,
      ).toBe("interrupted");
    },
  );

  it("reports the latest normalized event timestamp", () => {
    const state = deriveAgentActivityState(
      baseInput({
        activities: [
          toolActivity(
            "tool.updated",
            { data: { toolCallId: "call-1" } },
            {
              createdAt: "2026-07-20T12:05:00.000Z",
            },
          ),
        ],
      }),
    );
    expect(state.lastEventTimestamp).toBe("2026-07-20T12:05:00.000Z");
  });
});
