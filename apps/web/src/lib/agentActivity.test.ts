import { describe, expect, it } from "vitest";

import {
  deriveAgentActivityState,
  deriveProjectProcessActivity,
  isAnyProcessRunning,
  type AgentActivityDerivationInput,
  type AgentActivityState,
} from "./agentActivity";

const TURN_ID = "turn-activity" as never;

function input(
  overrides: Partial<AgentActivityDerivationInput> = {},
): AgentActivityDerivationInput {
  return {
    threadId: "thread-activity",
    hasMessages: true,
    localDispatchPending: false,
    session: {
      status: "running",
      activeTurnId: TURN_ID,
      updatedAt: "2026-07-21T12:00:01.000Z",
    },
    latestTurn: {
      turnId: TURN_ID,
      state: "running",
      requestedAt: "2026-07-21T12:00:00.000Z",
      startedAt: "2026-07-21T12:00:01.000Z",
      completedAt: null,
    },
    hasLiveTailWork: true,
    hasPendingInteraction: false,
    threadError: null,
    nowMs: Date.parse("2026-07-21T12:00:04.000Z"),
    ...overrides,
  };
}

describe("deriveAgentActivityState", () => {
  it("derives all nine phases from normalized evidence", () => {
    expect(deriveAgentActivityState(input({ threadId: null })).phase).toBe("idle");
    expect(deriveAgentActivityState(input({ localDispatchPending: true })).phase).toBe(
      "connecting",
    );
    expect(deriveAgentActivityState(input()).phase).toBe("thinking");
    expect(deriveAgentActivityState(input({ hasStreamingAssistantMessage: true })).phase).toBe(
      "streaming",
    );
    expect(deriveAgentActivityState(input({ activeToolCount: 1 })).phase).toBe("tool-running");
    expect(
      deriveAgentActivityState(
        input({
          session: { ...input().session!, status: "ready", activeTurnId: null },
          latestTurn: {
            ...input().latestTurn!,
            state: "completed",
            completedAt: "2026-07-21T12:00:04.000Z",
          },
          hasLiveTailWork: false,
        }),
      ).phase,
    ).toBe("completed");
    expect(deriveAgentActivityState(input({ threadError: "boom" })).phase).toBe("failed");
    expect(
      deriveAgentActivityState(
        input({ session: { ...input().session!, status: "interrupted", activeTurnId: null } }),
      ).phase,
    ).toBe("interrupted");
    expect(
      deriveAgentActivityState(
        input({
          session: { ...input().session!, status: "stopped", activeTurnId: null },
          latestTurn: null,
          hasLiveTailWork: false,
        }),
      ).phase,
    ).toBe("stopped");
  });

  it("uses tool, subagent, and streaming precedence while preserving metadata", () => {
    const subagentStates = new Map([
      [
        "child-1",
        {
          id: "child-1",
          phase: "streaming" as const,
          latestToolName: null,
          streamPreview: "child",
        },
      ],
      [
        "child-2",
        { id: "child-2", phase: "completed" as const, latestToolName: null, streamPreview: null },
      ],
    ]);
    const state = deriveAgentActivityState(
      input({
        activeToolCount: 2,
        latestToolName: "Read file",
        hasStreamingAssistantMessage: true,
        streamPreview: "latest output",
        subagentStates,
      }),
    );
    expect(state).toMatchObject({
      phase: "tool-running",
      toolCount: 2,
      subagentCount: 2,
      subagentRunningCount: 1,
      latestToolName: "Read file",
      streamPreview: "latest output",
      durationMs: 3_000,
    });
  });

  it("keeps blocked interactions visually idle without losing turn evidence", () => {
    expect(deriveAgentActivityState(input({ hasPendingInteraction: true }))).toMatchObject({
      phase: "idle",
      turnKey: TURN_ID,
    });
  });

  it("keeps a settled parent live while an actual child thread is still running", () => {
    const completedParent = input({
      hasMessages: false,
      session: { ...input().session!, status: "ready", activeTurnId: null },
      latestTurn: {
        ...input().latestTurn!,
        state: "completed",
        completedAt: "2026-07-21T12:00:03.000Z",
      },
      hasLiveTailWork: false,
      hasPendingInteraction: true,
      subagentStates: new Map([
        [
          "child-live",
          {
            id: "child-live",
            phase: "streaming",
            latestToolName: null,
            streamPreview: "still working",
          },
        ],
      ]),
    });

    expect(deriveAgentActivityState(completedParent)).toMatchObject({
      phase: "tool-running",
      subagentCount: 1,
      subagentRunningCount: 1,
    });
  });
});

describe("project process aggregation", () => {
  const state = (phase: AgentActivityState["phase"], queueCount = 0): AgentActivityState => ({
    ...deriveAgentActivityState(input()),
    phase,
    queueCount,
  });

  it("separates main agents, subagents, and terminal processes", () => {
    const summary = deriveProjectProcessActivity({
      agents: [
        { state: state("thinking"), isSubagent: false },
        { state: state("streaming"), isSubagent: true },
        { state: state("completed"), isSubagent: true },
        { state: state("idle", 1), isSubagent: false },
      ],
      terminalProcessCount: 2,
    });
    expect(summary).toMatchObject({
      agentCount: 2,
      agentRunningCount: 1,
      subagentCount: 1,
      subagentRunningCount: 1,
      terminalProcessCount: 2,
      anyProcessRunning: true,
    });
  });

  it("includes dev-server and git activity in the unified running predicate", () => {
    expect(isAnyProcessRunning({ agents: [], terminalProcessCount: 0 })).toBe(false);
    expect(
      isAnyProcessRunning({ agents: [], terminalProcessCount: 0, devServerRunning: true }),
    ).toBe(true);
    expect(
      isAnyProcessRunning({ agents: [], terminalProcessCount: 0, gitActionRunning: true }),
    ).toBe(true);
  });
});
