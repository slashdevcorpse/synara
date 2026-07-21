// FILE: TurnReasoningSummaryCard.test.tsx
// Purpose: Server-rendered contract tests for the turn reasoning summary card.
// Layer: Chat transcript UI tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FeedbackThreadContext } from "~/feedback";

import { APP_TOOLTIP_SURFACE_CLASS_NAME } from "./composerPickerStyles";
import { TurnReasoningSummaryCard } from "./TurnReasoningSummaryCard";
import type { TurnReasoningSummary } from "./turnReasoning";

const FEEDBACK_CONTEXT: FeedbackThreadContext = {
  provider: "codex",
  model: "gpt-5.6-sol",
  projectKind: "project",
  environmentMode: "local",
  runtimeMode: "full-access",
  interactionMode: "default",
  sessionStatus: "ready",
  latestTurnState: "completed",
  messageCount: 6,
  activityCount: 18,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  hasThreadError: false,
};

const SUMMARY: TurnReasoningSummary = {
  turnNumber: 3,
  turnIds: ["turn-3" as never],
  terminalAssistantMessageId: "message-3" as never,
  status: "completed",
  isLatestCompleted: true,
  startedAt: "2026-07-21T15:00:00.000Z",
  completedAt: "2026-07-21T15:00:04.200Z",
  durationMs: 4_200,
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  assistantDeliveryMode: "streaming",
  contextUsedTokens: 34_000,
  contextWindowTokens: 128_000,
  inputTokens: 31_000,
  cachedInputTokens: 12_000,
  outputTokens: 3_000,
  reasoningOutputTokens: 1_200,
  totalTokens: 34_000,
  tokenUsageProvider: "codex",
  toolCallCount: 9,
  distinctToolCount: 7,
  distinctToolNames: ["Read", "Search", "Edit", "Shell", "Review"],
  toolNameCounts: [
    { name: "Read", count: 2 },
    { name: "Search", count: 2 },
    { name: "Edit", count: 1 },
    { name: "Shell", count: 1 },
    { name: "Review", count: 1 },
  ],
  toolNameOverflowCount: 2,
  approvalCount: 1,
  rejectionCount: 0,
  filesChangedCount: 3,
  runtimeMode: "full-access",
  interactionMode: "default",
  envMode: "local",
};

function renderCard(summary: TurnReasoningSummary, expanded: boolean): string {
  return renderToStaticMarkup(
    <TurnReasoningSummaryCard
      summary={summary}
      expanded={expanded}
      onExpandedChange={() => undefined}
      feedbackContext={FEEDBACK_CONTEXT}
    />,
  );
}

describe("TurnReasoningSummaryCard", () => {
  it("renders the collapsed facts in their required order on the shared surface", () => {
    const html = renderCard(SUMMARY, false);
    const orderedValues = [
      "Turn 3",
      "gpt-5.6-sol",
      "9 tools",
      "full-access",
      "4.2s",
      "3 files changed",
    ];

    for (const className of APP_TOOLTIP_SURFACE_CLASS_NAME.split(" ")) {
      expect(html).toContain(className);
    }
    expect(html).toContain('data-status="completed"');
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain("duration-220");
    expect(html).toContain("motion-reduce:transition-none");
    orderedValues.reduce((previousIndex, value) => {
      const nextIndex = html.indexOf(value);
      expect(nextIndex).toBeGreaterThan(previousIndex);
      return nextIndex;
    }, -1);
  });

  it("renders all expanded audit fields, capped tool names, and semantic completion state", () => {
    const html = renderCard(SUMMARY, true);

    expect(html).toContain("Turn 3");
    expect(html).toContain("completed");
    expect(html).toContain("text-emerald-700");
    expect(html).toContain("Context");
    expect(html).toContain("128K tokens · 34K used");
    expect(html).toContain("high · streaming");
    expect(html).toContain("9 tools invoked · 7 distinct tools");
    for (const tool of SUMMARY.toolNameCounts) {
      expect(html).toContain(`${tool.name}${tool.count > 1 ? ` ×${tool.count}` : ""}`);
    }
    expect(html).toContain("+2 more");
    expect(html).toContain("1 approval · 0 rejections");
    expect(html).toContain("success</span> · 3 files changed");
    expect(html).toContain("full-access · local workspace");
    expect(html).toContain("size-4 shrink-0");
    expect(html).toContain("Copy summary");
    expect(html).toContain("Feedback");
  });

  it("uses an em dash for unsupported metadata", () => {
    const html = renderCard(
      {
        ...SUMMARY,
        durationMs: null,
        provider: null,
        model: null,
        reasoningEffort: null,
        assistantDeliveryMode: null,
        contextUsedTokens: null,
        contextWindowTokens: null,
        tokenUsageProvider: null,
        runtimeMode: null,
        interactionMode: null,
        envMode: null,
      },
      true,
    );

    expect((html.match(/—/gu) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain("Token tracking requires provider support.");
  });

  it.each([
    [59_600, "1m"],
    [119_600, "2m"],
    [120_600, "2m 1s"],
  ])("carries rounded seconds into minutes for %dms", (durationMs, expected) => {
    const html = renderCard({ ...SUMMARY, durationMs }, false);

    expect(html).toContain(expected);
    expect(html).not.toMatch(/(?:0m|\d+m) 60s/u);
  });

  it.each([
    ["failed", "text-rose-700", "bg-rose-600"],
    ["interrupted", "text-amber-700", "bg-amber-600"],
  ] as const)("uses semantic styles for %s turns", (status, textClassName, dotClassName) => {
    const html = renderCard({ ...SUMMARY, status }, true);

    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(textClassName);
    expect(html).toContain(dotClassName);
  });
});
