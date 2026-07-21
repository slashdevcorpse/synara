import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../../workLog";
import type { ChatMessage, TurnDiffSummary } from "../../types";
import {
  buildTurnReasoningSummaryByAssistantMessageId,
  formatTurnReasoningSummaryForClipboard,
  type TurnReasoningDurableTurn,
  type TurnReasoningSummary,
} from "./turnReasoning";

function message(input: {
  id: string;
  role: ChatMessage["role"];
  createdAt: string;
  turnId?: string;
  completedAt?: string;
  streaming?: boolean;
}): ChatMessage {
  return {
    id: MessageId.makeUnsafe(input.id),
    role: input.role,
    text: input.role === "user" ? "Question" : "Answer",
    createdAt: input.createdAt,
    streaming: input.streaming ?? false,
    ...(input.turnId ? { turnId: TurnId.makeUnsafe(input.turnId) } : {}),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
  };
}

function durableTurn(
  turnId: string,
  overrides: Partial<TurnReasoningDurableTurn> = {},
): TurnReasoningDurableTurn {
  return {
    turnId: TurnId.makeUnsafe(turnId),
    state: "completed",
    requestedAt: "2026-07-21T10:00:00.000Z",
    startedAt: "2026-07-21T10:00:01.000Z",
    completedAt: "2026-07-21T10:00:05.000Z",
    assistantMessageId: null,
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.6-sol",
      options: { reasoningEffort: "high" },
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "worktree",
    assistantDeliveryMode: "streaming",
    tokenUsage: null,
    toolCallCount: 0,
    toolNames: [],
    toolNameCounts: [],
    approvalCount: 0,
    rejectionCount: 0,
    ...overrides,
  };
}

function activity(input: {
  id: string;
  kind: string;
  turnId: string;
  createdAt: string;
  summary?: string;
  payload?: OrchestrationThreadActivity["payload"];
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(input.id),
    tone: input.kind.startsWith("approval") ? "approval" : "tool",
    kind: input.kind,
    summary: input.summary ?? input.kind,
    payload: input.payload ?? {},
    turnId: TurnId.makeUnsafe(input.turnId),
    createdAt: input.createdAt,
  };
}

function diff(turnId: string, paths: string[]): TurnDiffSummary {
  return {
    turnId: TurnId.makeUnsafe(turnId),
    completedAt: "2026-07-21T10:00:10.000Z",
    files: paths.map((path) => ({ path })),
  };
}

describe("buildTurnReasoningSummaryByAssistantMessageId", () => {
  it("aggregates provider mini-turns into one auditable user-visible response", () => {
    const messages = [
      message({ id: "u1", role: "user", createdAt: "2026-07-21T10:00:00.000Z" }),
      message({
        id: "a1",
        role: "assistant",
        turnId: "t1",
        createdAt: "2026-07-21T10:00:03.000Z",
        completedAt: "2026-07-21T10:00:04.000Z",
      }),
      message({
        id: "a2",
        role: "assistant",
        turnId: "t2",
        createdAt: "2026-07-21T10:00:08.000Z",
        completedAt: "2026-07-21T10:00:10.000Z",
      }),
    ];
    const turns = [
      durableTurn("t1", {
        assistantMessageId: MessageId.makeUnsafe("a1"),
        tokenUsage: {
          provider: "codex",
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 120,
          contextUsedTokens: 50,
          contextWindowTokens: 200,
          updatedAt: "2026-07-21T10:00:04.000Z",
        },
      }),
      durableTurn("t2", {
        state: "error",
        startedAt: "2026-07-21T10:00:05.000Z",
        completedAt: "2026-07-21T10:00:10.000Z",
        assistantMessageId: MessageId.makeUnsafe("a2"),
        tokenUsage: {
          provider: "codex",
          inputTokens: 50,
          cachedInputTokens: 5,
          outputTokens: 10,
          reasoningOutputTokens: 2,
          totalTokens: 60,
          contextUsedTokens: 80,
          contextWindowTokens: 200,
          updatedAt: "2026-07-21T10:00:09.000Z",
        },
      }),
    ].map(
      ({
        toolCallCount: _toolCallCount,
        toolNames: _toolNames,
        toolNameCounts: _toolNameCounts,
        approvalCount: _approvalCount,
        rejectionCount: _rejectionCount,
        ...turn
      }) => turn as TurnReasoningDurableTurn,
    );
    const activities: OrchestrationThreadActivity[] = [];
    const toolNames = ["Read", "Read", "Search", "Shell", "Edit", "Browser", "GitHub"];
    toolNames.forEach((toolName, index) => {
      const turnId = index < 3 ? "t1" : "t2";
      for (const [offset, kind] of ["tool.started", "tool.updated", "tool.completed"].entries()) {
        activities.push(
          activity({
            id: `tool-${index}-${offset}`,
            kind,
            turnId,
            createdAt: `2026-07-21T10:00:0${Math.min(9, index + 1)}.${offset}00Z`,
            summary: toolName,
            payload: { data: { toolCallId: `call-${index}`, toolName } },
          }),
        );
      }
    });
    activities.push(
      activity({
        id: "approval-1-requested",
        kind: "approval.requested",
        turnId: "t1",
        createdAt: "2026-07-21T10:00:02.000Z",
        payload: { requestId: "approval-1" },
      }),
      activity({
        id: "approval-1-resolved",
        kind: "approval.resolved",
        turnId: "t1",
        createdAt: "2026-07-21T10:00:03.000Z",
        payload: { requestId: "approval-1", decision: "accept" },
      }),
      activity({
        id: "approval-2-requested",
        kind: "approval.requested",
        turnId: "t2",
        createdAt: "2026-07-21T10:00:06.000Z",
        payload: { requestId: "approval-2" },
      }),
      activity({
        id: "approval-2-resolved",
        kind: "approval.resolved",
        turnId: "t2",
        createdAt: "2026-07-21T10:00:07.000Z",
        payload: { requestId: "approval-2", decision: "decline" },
      }),
      activity({
        id: "approval-2-resolved-duplicate",
        kind: "approval.resolved",
        turnId: "t2",
        createdAt: "2026-07-21T10:00:08.000Z",
        payload: { requestId: "approval-2", decision: "cancel" },
      }),
    );

    const result = buildTurnReasoningSummaryByAssistantMessageId({
      messages,
      turns,
      activities,
      turnDiffSummaries: [diff("t1", ["src/a.ts"]), diff("t2", ["src/a.ts", "src/b.ts"])],
    });
    const summary = result.get(MessageId.makeUnsafe("a2"));

    expect([...result.keys()].map(String)).toEqual(["a2"]);
    expect(summary).toMatchObject({
      turnNumber: 1,
      status: "failed",
      isLatestCompleted: true,
      startedAt: "2026-07-21T10:00:01.000Z",
      completedAt: "2026-07-21T10:00:10.000Z",
      durationMs: 9_000,
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      assistantDeliveryMode: "streaming",
      contextUsedTokens: 80,
      contextWindowTokens: 200,
      inputTokens: 150,
      cachedInputTokens: 25,
      outputTokens: 30,
      reasoningOutputTokens: 7,
      totalTokens: 180,
      tokenUsageProvider: "codex",
      toolCallCount: 7,
      distinctToolCount: 6,
      toolNameCounts: [
        { name: "Read", count: 2 },
        { name: "Search", count: 1 },
        { name: "Shell", count: 1 },
        { name: "Edit", count: 1 },
        { name: "Browser", count: 1 },
      ],
      distinctToolNames: ["Read", "Search", "Shell", "Edit", "Browser"],
      toolNameOverflowCount: 1,
      approvalCount: 2,
      rejectionCount: 1,
      filesChangedCount: 2,
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "worktree",
    });
    expect(summary?.turnIds.map(String)).toEqual(["t1", "t2"]);
  });

  it("numbers responses by their user turn, marks only the newest settled response, and omits live tails", () => {
    const messages = [
      message({ id: "u1", role: "user", createdAt: "2026-07-21T10:00:00.000Z" }),
      message({
        id: "a1",
        role: "assistant",
        turnId: "t1",
        createdAt: "2026-07-21T10:00:01.000Z",
        completedAt: "2026-07-21T10:00:02.000Z",
      }),
      message({ id: "u2", role: "user", createdAt: "2026-07-21T10:01:00.000Z" }),
      message({
        id: "a2",
        role: "assistant",
        turnId: "t2",
        createdAt: "2026-07-21T10:01:01.000Z",
        completedAt: "2026-07-21T10:01:02.000Z",
      }),
      message({ id: "u3", role: "user", createdAt: "2026-07-21T10:02:00.000Z" }),
      message({
        id: "a3",
        role: "assistant",
        turnId: "third-turn",
        createdAt: "2026-07-21T10:02:01.000Z",
        streaming: true,
      }),
    ];

    const result = buildTurnReasoningSummaryByAssistantMessageId({ messages });
    const first = result.get(MessageId.makeUnsafe("a1"));
    const second = result.get(MessageId.makeUnsafe("a2"));

    expect([...result.keys()].map(String)).toEqual(["a1", "a2"]);
    expect(first).toMatchObject({ turnNumber: 1, isLatestCompleted: false });
    expect(second).toMatchObject({
      turnNumber: 2,
      isLatestCompleted: true,
      provider: null,
      model: null,
      reasoningEffort: null,
      contextUsedTokens: null,
      inputTokens: null,
      runtimeMode: null,
    });
    expect(result.has(MessageId.makeUnsafe("a3"))).toBe(false);
  });

  it("prefers durable aggregates and caps only the displayed unique tool names", () => {
    const messages = [
      message({ id: "u1", role: "user", createdAt: "2026-07-21T10:00:00.000Z" }),
      message({
        id: "a1",
        role: "assistant",
        turnId: "t1",
        createdAt: "2026-07-21T10:00:01.000Z",
        completedAt: "2026-07-21T10:00:02.000Z",
      }),
    ];
    const turn = durableTurn("t1", {
      toolCallCount: 12,
      toolNames: ["Read", "Search", "Shell", "Edit", "Browser", "GitHub", "Workflow"],
      toolNameCounts: [
        { name: "Read", count: 6 },
        { name: "Search", count: 1 },
        { name: "Shell", count: 1 },
        { name: "Edit", count: 1 },
        { name: "Browser", count: 1 },
        { name: "GitHub", count: 1 },
        { name: "Workflow", count: 1 },
      ],
      approvalCount: 4,
      rejectionCount: 2,
    });
    const activities = [
      activity({
        id: "fallback-tool",
        kind: "tool.completed",
        turnId: "t1",
        createdAt: "2026-07-21T10:00:01.000Z",
        summary: "Ignored activity fallback",
        payload: { data: { toolCallId: "fallback" } },
      }),
    ];

    const summary = buildTurnReasoningSummaryByAssistantMessageId({
      messages,
      turns: [turn],
      activities,
    }).get(MessageId.makeUnsafe("a1"));

    expect(summary).toMatchObject({
      toolCallCount: 12,
      distinctToolCount: 7,
      toolNameCounts: [
        { name: "Read", count: 6 },
        { name: "Search", count: 1 },
        { name: "Shell", count: 1 },
        { name: "Edit", count: 1 },
        { name: "Browser", count: 1 },
      ],
      distinctToolNames: ["Read", "Search", "Shell", "Edit", "Browser"],
      toolNameOverflowCount: 2,
      approvalCount: 4,
      rejectionCount: 2,
    });
  });

  it("derives the durable tool total when only per-name counts are available", () => {
    const assistant = message({
      id: "a1",
      role: "assistant",
      turnId: "t1",
      createdAt: "2026-07-21T10:00:01.000Z",
      completedAt: "2026-07-21T10:00:02.000Z",
    });
    const { toolCallCount: _toolCallCount, ...turnWithoutTotal } = durableTurn("t1", {
      assistantMessageId: assistant.id,
      toolNameCounts: [
        { name: "Read", count: 2 },
        { name: "Bash", count: 1 },
      ],
    });

    const summary = buildTurnReasoningSummaryByAssistantMessageId({
      messages: [
        message({ id: "u1", role: "user", createdAt: "2026-07-21T10:00:00.000Z" }),
        assistant,
      ],
      turns: [turnWithoutTotal],
    }).get(assistant.id);

    expect(summary).toMatchObject({
      toolCallCount: 3,
      toolNameCounts: [
        { name: "Read", count: 2 },
        { name: "Bash", count: 1 },
      ],
    });
  });

  it("falls back to already-collapsed timeline work when raw activities are unavailable", () => {
    const user = message({
      id: "u1",
      role: "user",
      createdAt: "2026-07-21T10:00:00.000Z",
    });
    const assistant = message({
      id: "a1",
      role: "assistant",
      turnId: "t1",
      createdAt: "2026-07-21T10:00:01.000Z",
      completedAt: "2026-07-21T10:00:02.000Z",
    });
    const timelineEntries: TimelineEntry[] = [
      { id: "entry-u1", kind: "message", createdAt: user.createdAt, message: user },
      {
        id: "entry-tool-1",
        kind: "work",
        createdAt: "2026-07-21T10:00:01.000Z",
        entry: {
          id: "tool-1",
          createdAt: "2026-07-21T10:00:01.000Z",
          turnId: TurnId.makeUnsafe("t1"),
          label: "Read file",
          toolName: "Read",
          toolCallId: "call-1",
          tone: "tool",
          activityKind: "tool.completed",
        },
      },
      { id: "entry-a1", kind: "message", createdAt: assistant.createdAt, message: assistant },
    ];

    const summary = buildTurnReasoningSummaryByAssistantMessageId({
      messages: [user, assistant],
      timelineEntries,
    }).get(assistant.id);

    expect(summary).toMatchObject({
      toolCallCount: 1,
      distinctToolCount: 1,
      toolNameCounts: [{ name: "Read", count: 1 }],
      distinctToolNames: ["Read"],
      toolNameOverflowCount: 0,
    });
  });

  it("maps cancelled/interrupted durable turns to the interrupted card status", () => {
    const messages = [
      message({ id: "u1", role: "user", createdAt: "2026-07-21T10:00:00.000Z" }),
      message({
        id: "a1",
        role: "assistant",
        turnId: "t1",
        createdAt: "2026-07-21T10:00:01.000Z",
        completedAt: "2026-07-21T10:00:02.000Z",
      }),
    ];

    const summary = buildTurnReasoningSummaryByAssistantMessageId({
      messages,
      turns: [durableTurn("t1", { state: "interrupted" })],
    }).get(MessageId.makeUnsafe("a1"));

    expect(summary?.status).toBe("interrupted");
  });

  it("uses the token usage provider when historical turn provider metadata is unavailable", () => {
    const messages = [
      message({ id: "u1", role: "user", createdAt: "2026-07-21T10:00:00.000Z" }),
      message({
        id: "a1",
        role: "assistant",
        turnId: "t1",
        createdAt: "2026-07-21T10:00:01.000Z",
        completedAt: "2026-07-21T10:00:02.000Z",
      }),
    ];

    const summary = buildTurnReasoningSummaryByAssistantMessageId({
      messages,
      turns: [
        durableTurn("t1", {
          provider: null,
          model: null,
          modelSelection: null,
          tokenUsage: {
            provider: "codex",
            inputTokens: 100,
            cachedInputTokens: 25,
            outputTokens: 20,
            reasoningOutputTokens: 5,
            totalTokens: 120,
            contextUsedTokens: 100,
            contextWindowTokens: 200,
            updatedAt: "2026-07-21T10:00:02.000Z",
          },
        }),
      ],
    }).get(MessageId.makeUnsafe("a1"));

    expect(summary).toMatchObject({
      provider: "codex",
      model: null,
      tokenUsageProvider: "codex",
    });
    expect(summary && formatTurnReasoningSummaryForClipboard(summary)).toContain(
      "Model: codex · —",
    );
  });

  it("indexes long transcripts without rescanning every turn and activity per response", () => {
    const responseCount = 40;
    const messages: ChatMessage[] = [];
    const turns: TurnReasoningDurableTurn[] = [];
    const activities: OrchestrationThreadActivity[] = [];
    const fallbackResponseIndex = 20;

    const iso = (responseIndex: number, offsetMs: number) =>
      new Date(Date.UTC(2026, 6, 21, 10, responseIndex, 0) + offsetMs).toISOString();
    const withoutDurableCounts = (turn: TurnReasoningDurableTurn): TurnReasoningDurableTurn => {
      const {
        toolCallCount: _toolCallCount,
        toolNames: _toolNames,
        toolNameCounts: _toolNameCounts,
        approvalCount: _approvalCount,
        rejectionCount: _rejectionCount,
        ...withoutCounts
      } = turn;
      return withoutCounts;
    };

    for (let responseIndex = 0; responseIndex < responseCount; responseIndex += 1) {
      const firstTurnId = `long-turn-${responseIndex}-first`;
      const secondTurnId = `long-turn-${responseIndex}-second`;
      const firstAssistantId = `long-assistant-${responseIndex}-first`;
      const secondAssistantId = `long-assistant-${responseIndex}-second`;
      const usesTimeWindowFallback = responseIndex === fallbackResponseIndex;

      messages.push(
        message({
          id: `long-user-${responseIndex}`,
          role: "user",
          createdAt: iso(responseIndex, 0),
        }),
        message({
          id: firstAssistantId,
          role: "assistant",
          createdAt: iso(responseIndex, 10_000),
          completedAt: iso(responseIndex, 20_000),
          ...(usesTimeWindowFallback ? {} : { turnId: firstTurnId }),
        }),
        message({
          id: secondAssistantId,
          role: "assistant",
          createdAt: iso(responseIndex, 30_000),
          completedAt: iso(responseIndex, 50_000),
          ...(usesTimeWindowFallback ? {} : { turnId: secondTurnId }),
        }),
      );

      turns.push(
        withoutDurableCounts(
          durableTurn(secondTurnId, {
            requestedAt: iso(responseIndex, 21_000),
            startedAt: iso(responseIndex, 22_000),
            completedAt: iso(responseIndex, 50_000),
            assistantMessageId: MessageId.makeUnsafe(secondAssistantId),
            provider: "codex",
            model: `codex-model-${responseIndex}`,
          }),
        ),
        withoutDurableCounts(
          durableTurn(firstTurnId, {
            requestedAt: iso(responseIndex, 1_000),
            startedAt: iso(responseIndex, 2_000),
            completedAt: iso(responseIndex, 20_000),
            assistantMessageId: MessageId.makeUnsafe(firstAssistantId),
            provider: "claudeAgent",
            model: `claude-model-${responseIndex}`,
            modelSelection: {
              provider: "claudeAgent",
              model: `claude-model-${responseIndex}`,
              options: { effort: "high" },
            },
          }),
        ),
      );

      const activityTurnId = usesTimeWindowFallback
        ? `unrelated-turn-${responseIndex}`
        : firstTurnId;
      const sequenced = (
        id: string,
        kind: string,
        offsetMs: number,
        sequence: number,
        payload: OrchestrationThreadActivity["payload"],
      ): OrchestrationThreadActivity => ({
        ...activity({
          id,
          kind,
          turnId: activityTurnId,
          createdAt: iso(responseIndex, offsetMs),
          summary: kind.startsWith("tool.") ? "Read" : kind,
          payload,
        }),
        sequence,
      });
      const sequenceBase = responseIndex * 10;
      activities.push(
        sequenced(
          `long-tool-${responseIndex}-second-completed`,
          "tool.completed",
          35_000,
          sequenceBase + 4,
          {},
        ),
        sequenced(
          `long-approval-${responseIndex}-resolved`,
          "approval.resolved",
          41_000,
          sequenceBase + 6,
          { requestId: `approval-${responseIndex}`, decision: "decline" },
        ),
        sequenced(
          `long-tool-${responseIndex}-first-started`,
          "tool.started",
          12_000,
          sequenceBase + 1,
          {},
        ),
        sequenced(
          `long-approval-${responseIndex}-requested`,
          "approval.requested",
          40_000,
          sequenceBase + 5,
          { requestId: `approval-${responseIndex}` },
        ),
        sequenced(
          `long-tool-${responseIndex}-first-completed`,
          "tool.completed",
          15_000,
          sequenceBase + 2,
          {},
        ),
        sequenced(
          `long-approval-${responseIndex}-duplicate`,
          "approval.resolved",
          42_000,
          sequenceBase + 7,
          { requestId: `approval-${responseIndex}`, decision: "cancel" },
        ),
        sequenced(
          `long-tool-${responseIndex}-second-started`,
          "tool.started",
          32_000,
          sequenceBase + 3,
          {},
        ),
      );
    }

    const trackIndexedReads = <T>(values: T[]) => {
      let indexedReads = 0;
      return {
        values: new Proxy(values, {
          get(target, property, receiver) {
            if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) {
              indexedReads += 1;
            }
            return Reflect.get(target, property, receiver);
          },
        }) as ReadonlyArray<T>,
        indexedReads: () => indexedReads,
      };
    };
    const trackedTurns = trackIndexedReads(turns);
    const trackedActivities = trackIndexedReads(activities);

    const result = buildTurnReasoningSummaryByAssistantMessageId({
      messages,
      turns: trackedTurns.values,
      activities: trackedActivities.values,
    });

    expect(result).toHaveLength(responseCount);
    expect(result.get(MessageId.makeUnsafe("long-assistant-39-second"))).toMatchObject({
      turnNumber: 40,
      provider: "codex",
      model: "codex-model-39",
      toolCallCount: 2,
      distinctToolCount: 1,
      toolNameCounts: [{ name: "Read", count: 2 }],
      approvalCount: 1,
      rejectionCount: 1,
    });
    expect(
      result.get(MessageId.makeUnsafe(`long-assistant-${fallbackResponseIndex}-second`)),
    ).toMatchObject({
      turnIds: [],
      provider: "codex",
      model: `codex-model-${fallbackResponseIndex}`,
      toolCallCount: 2,
      approvalCount: 1,
      rejectionCount: 1,
    });
    expect(trackedTurns.indexedReads()).toBeLessThanOrEqual(turns.length * 3);
    expect(trackedActivities.indexedReads()).toBeLessThanOrEqual(activities.length * 3);
  });
});

describe("formatTurnReasoningSummaryForClipboard", () => {
  it("formats all auditable fields and keeps unsupported data explicit", () => {
    const summary: TurnReasoningSummary = {
      turnNumber: 4,
      turnIds: [TurnId.makeUnsafe("t4")],
      terminalAssistantMessageId: MessageId.makeUnsafe("a4"),
      status: "completed",
      isLatestCompleted: true,
      startedAt: null,
      completedAt: null,
      durationMs: 12_300,
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      assistantDeliveryMode: "streaming",
      contextUsedTokens: 43_201,
      contextWindowTokens: 200_000,
      inputTokens: 24_802,
      cachedInputTokens: 17_921,
      outputTokens: 1_482,
      reasoningOutputTokens: null,
      totalTokens: null,
      tokenUsageProvider: "codex",
      toolCallCount: 7,
      distinctToolCount: 6,
      toolNameCounts: [
        { name: "Read", count: 2 },
        { name: "Search", count: 1 },
        { name: "Shell", count: 1 },
        { name: "Edit", count: 1 },
        { name: "Browser", count: 1 },
      ],
      distinctToolNames: ["Read", "Search", "Shell", "Edit", "Browser"],
      toolNameOverflowCount: 1,
      approvalCount: 0,
      rejectionCount: 0,
      filesChangedCount: 3,
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "worktree",
    };

    expect(formatTurnReasoningSummaryForClipboard(summary)).toBe(
      [
        "Turn #4 · Completed · 12.3s",
        "Model: codex · gpt-5.6-sol",
        "Context: 43,201 / 200,000 used",
        "Tokens: input 24,802 · output 1,482 · cached 17,921 · total —",
        "Reasoning: high · streaming",
        "Tools: 7 total · 6 distinct · Read ×2, Search, Shell, Edit, Browser, +1",
        "Approvals: 0 · Rejections: 0",
        "Completion: 3 files changed",
        "Access: full-access · worktree",
      ].join("\n"),
    );
  });

  it("explains fully unsupported token telemetry", () => {
    const summary: TurnReasoningSummary = {
      turnNumber: 1,
      turnIds: [TurnId.makeUnsafe("unsupported-turn")],
      terminalAssistantMessageId: MessageId.makeUnsafe("unsupported-assistant"),
      status: "completed",
      isLatestCompleted: true,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      provider: "pi",
      model: "gpt-5",
      reasoningEffort: null,
      assistantDeliveryMode: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      tokenUsageProvider: null,
      toolCallCount: 0,
      distinctToolCount: 0,
      toolNameCounts: [],
      distinctToolNames: [],
      toolNameOverflowCount: 0,
      approvalCount: 0,
      rejectionCount: 0,
      filesChangedCount: 0,
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "local",
    };

    expect(formatTurnReasoningSummaryForClipboard(summary)).toContain(
      "Context: — / — used\nToken tracking requires provider support.",
    );
  });
});
