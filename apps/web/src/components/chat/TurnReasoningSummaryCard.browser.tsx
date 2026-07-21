// FILE: TurnReasoningSummaryCard.browser.tsx
// Purpose: Browser interaction proof for expansion, copying, and contextual feedback.
// Layer: Chat transcript UI browser tests

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import type { FeedbackThreadContext } from "~/feedback";
import { useFeedbackDialogStore } from "~/feedbackDialogStore";

import { TurnReasoningSummaryCard } from "./TurnReasoningSummaryCard";
import { formatTurnReasoningSummaryForClipboard, type TurnReasoningSummary } from "./turnReasoning";

const FEEDBACK_CONTEXT: FeedbackThreadContext = {
  provider: "claudeAgent",
  model: "fallback-model",
  projectKind: "project",
  environmentMode: "worktree",
  runtimeMode: "approval-required",
  interactionMode: "plan",
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
  status: "failed",
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

function ControlledCard({
  initiallyExpanded = false,
  summary = SUMMARY,
}: {
  initiallyExpanded?: boolean;
  summary?: TurnReasoningSummary;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return (
    <TurnReasoningSummaryCard
      summary={summary}
      expanded={expanded}
      onExpandedChange={setExpanded}
      feedbackContext={FEEDBACK_CONTEXT}
    />
  );
}

describe("TurnReasoningSummaryCard interactions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useFeedbackDialogStore.setState({ isOpen: false, context: null });
    document.body.innerHTML = "";
  });

  it("keeps expansion controlled and exposes the expanded audit fields", async () => {
    const mounted = await render(<ControlledCard />);
    try {
      const trigger = page.getByRole("button", { name: "Expand Turn 3 execution summary" });
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.click();

      const collapseTrigger = page.getByRole("button", {
        name: "Collapse Turn 3 execution summary",
      });
      await expect.element(collapseTrigger).toHaveAttribute("aria-expanded", "true");
      await expect.element(page.getByText("Reasoning", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Read ×2", { exact: true })).toBeVisible();
      await expect.element(page.getByText("+2 more", { exact: true })).toBeVisible();

      await collapseTrigger.click();
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    } finally {
      await mounted.unmount();
    }
  });

  it("copies the structured summary and opens feedback with turn-specific diagnostics", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const mounted = await render(<ControlledCard initiallyExpanded />);
    try {
      await page.getByRole("button", { name: "Copy Turn 3 execution summary" }).click();
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(formatTurnReasoningSummaryForClipboard(SUMMARY));
      });
      await expect.element(page.getByText("Copied", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Send feedback about Turn 3" }).click();
      expect(useFeedbackDialogStore.getState()).toMatchObject({
        isOpen: true,
        context: {
          provider: "codex",
          model: "gpt-5.6-sol",
          environmentMode: "local",
          runtimeMode: "full-access",
          interactionMode: "default",
          latestTurnState: "failed",
          hasThreadError: true,
        },
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("does not substitute current thread model or access for unavailable historical values", async () => {
    const historicalSummary: TurnReasoningSummary = {
      ...SUMMARY,
      status: "completed",
      provider: null,
      model: null,
      tokenUsageProvider: "codex",
      runtimeMode: null,
      interactionMode: null,
      envMode: null,
    };
    const mounted = await render(<ControlledCard initiallyExpanded summary={historicalSummary} />);
    try {
      await page.getByRole("button", { name: "Send feedback about Turn 3" }).click();

      expect(useFeedbackDialogStore.getState().context).toEqual({
        ...FEEDBACK_CONTEXT,
        provider: "codex",
        model: null,
        environmentMode: null,
        runtimeMode: null,
        interactionMode: null,
        latestTurnState: "completed",
      });
    } finally {
      await mounted.unmount();
    }
  });
});
