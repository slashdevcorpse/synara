import "../../index.css";

import { MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { TimelineEntry } from "../../session-logic";
import type { AgentActivityState } from "./agentActivityPulse.logic";
import { ChatTranscriptPane } from "./ChatTranscriptPane";

const NOOP = () => {};
const EMPTY_REVERT_COUNTS = new Map();
const EMPTY_TURN_DIFFS = new Map();
const TIMELINE_ENTRIES = Array.from(
  { length: 80 },
  (_, index): TimelineEntry => ({
    id: `assistant-entry-${index}`,
    kind: "message",
    createdAt: `2026-07-20T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
    message: {
      id: MessageId.makeUnsafe(`assistant-message-${index}`),
      role: "assistant",
      text: `Stable transcript message ${index + 1} keeps overflow geometry measurable.`,
      createdAt: `2026-07-20T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
      streaming: false,
    },
  }),
);

function state(phase: AgentActivityState["phase"]): AgentActivityState {
  return {
    phase,
    toolCount: phase === "tool-running" ? 1 : 0,
    subagentCount: 0,
    lastEventTimestamp: "2026-07-20T12:00:01.000Z",
    turnKey: phase === "idle" ? null : "turn-1",
  };
}

function TranscriptHarness({ phase }: { phase: AgentActivityState["phase"] }) {
  const listRef = useRef<LegendListRef | null>(null);
  return (
    <div className="flex h-[480px] w-[640px] overflow-hidden">
      <ChatTranscriptPane
        activeThreadId="thread-activity"
        agentActivityState={state(phase)}
        activeTurnInProgress={phase !== "idle"}
        activeTurnStartedAt="2026-07-20T12:00:00.000Z"
        chatFontSizePx={14}
        emptyStateProjectName={undefined}
        hasMessages
        isRevertingCheckpoint={false}
        isWorking={phase !== "idle"}
        followLiveOutput={phase === "streaming"}
        listRef={listRef}
        markdownCwd={undefined}
        onExpandTimelineImage={NOOP}
        onMessagesClickCapture={NOOP}
        onMessagesMouseUp={NOOP}
        onMessagesPointerCancel={NOOP}
        onMessagesPointerDown={NOOP}
        onMessagesPointerUp={NOOP}
        onMessagesScroll={NOOP}
        onMessagesTouchEnd={NOOP}
        onMessagesTouchMove={NOOP}
        onMessagesTouchStart={NOOP}
        onMessagesWheel={NOOP}
        onIsAtEndChange={NOOP}
        onOpenTurnDiff={NOOP}
        onOpenThread={NOOP}
        onRevertUserMessage={NOOP}
        onScrollToBottom={NOOP}
        resolvedTheme="dark"
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        scrollButtonVisible={false}
        terminalWorkspaceTerminalTabActive={false}
        timelineEntries={TIMELINE_ENTRIES}
        timestampFormat="locale"
        turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
        workspaceRoot={undefined}
        worktreeSetup={null}
      />
    </div>
  );
}

describe("ChatTranscriptPane agent activity", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("overlays a 3px bar above the timeline without changing scroll geometry", async () => {
    const screen = await render(<TranscriptHarness phase="thinking" />);
    try {
      await vi.waitFor(() => {
        expect(
          screen.container.querySelector("[data-chat-scroll-container='true']"),
        ).not.toBeNull();
        expect(
          screen.container.querySelector("[data-agent-activity-variant='bar']"),
        ).not.toBeNull();
      });
      const pane = screen.container.querySelector<HTMLElement>(
        "[data-chat-transcript-pane='true']",
      )!;
      const scroll = screen.container.querySelector<HTMLElement>(
        "[data-chat-scroll-container='true']",
      )!;
      const pulse = screen.container.querySelector<HTMLElement>(
        "[data-agent-activity-variant='bar']",
      )!;
      const paneRect = pane.getBoundingClientRect();
      const pulseRect = pulse.getBoundingClientRect();
      await vi.waitFor(() => expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight));
      scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
      const scrollToSpy = vi.spyOn(scroll, "scrollTo");
      scrollToSpy.mockClear();
      const before = {
        clientHeight: scroll.clientHeight,
        scrollHeight: scroll.scrollHeight,
        bottomDistance: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
      };

      expect(pulseRect.height).toBeCloseTo(3, 0);
      expect(Math.abs(pulseRect.top - paneRect.top)).toBeLessThanOrEqual(1);

      await screen.rerender(<TranscriptHarness phase="tool-running" />);
      await vi.waitFor(() => {
        expect(
          screen.container
            .querySelector("[data-agent-activity-variant='bar']")
            ?.getAttribute("data-agent-activity-phase"),
        ).toBe("tool-running");
      });

      expect(scroll.clientHeight).toBe(before.clientHeight);
      expect(scroll.scrollHeight).toBe(before.scrollHeight);
      expect(
        Math.abs(
          scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop - before.bottomDistance,
        ),
      ).toBeLessThanOrEqual(1);
      expect(scrollToSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("leaves no pulse DOM or layout box while idle", async () => {
    const screen = await render(<TranscriptHarness phase="idle" />);
    try {
      expect(screen.container.querySelector("[data-agent-activity-variant='bar']")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
