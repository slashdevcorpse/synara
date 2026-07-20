// FILE: WorkspaceAgentPanel.browser.tsx
// Purpose: Browser interaction coverage for workspace agent navigation and disclosures.
// Layer: Workspace agent sidebar browser tests

import "../../index.css";

import { ThreadId, TurnId } from "@synara/contracts";
import { useState } from "react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { AgentThreadEntry } from "../../hooks/useWorkspaceAgentActivity";
import { WorkspaceAgentPanel, type WorkspaceAgentStopAllResult } from "./WorkspaceAgentPanel";
import {
  makeWorkspaceAgentActivity as makeActivity,
  makeWorkspaceAgentEntry as makeEntry,
} from "./WorkspaceAgentPanel.testFixtures";

function successfulBatch(entries: ReadonlyArray<AgentThreadEntry>): WorkspaceAgentStopAllResult {
  const threadIds = entries.map((entry) => entry.threadId);
  return {
    attemptedThreadIds: threadIds,
    dispatchedThreadIds: threadIds,
    skippedThreadIds: [],
    failures: [],
  };
}

describe("WorkspaceAgentPanel interactions", () => {
  it("keeps row navigation, stop, and Stop All as sibling actions at 208px", async () => {
    const parent = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-parent-browser"),
      threadTitle: "Parent activity with a long title",
      duration: 4_000,
    });
    const child = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-child-browser"),
      parentThreadId: parent.threadId,
      isSubagent: true,
      subagentNickname: "Scout",
      subagentRole: "reviewer",
      threadTitle: "Child activity with another long title",
      status: "streaming",
      latestTool: { name: "Read a very long source file", state: "running" },
      streamPreview: "Inspecting the complete responsive presentation without overflow",
      associatedWorktreeBranch: "feature/a-very-long-worktree-branch",
      lastActivityAt: 3,
    });
    const activity = makeActivity(
      [parent, child],
      [{ entry: parent, children: [{ entry: child, children: [] }] }],
    );
    const onOpenThread = vi.fn();
    const onStopThread = vi.fn(async () => "dispatched" as const);
    const onStopAll = vi.fn(async (entries: AgentThreadEntry[]) => successfulBatch(entries));
    const mounted = await render(
      <div style={{ width: 208 }}>
        <WorkspaceAgentPanel
          activity={activity}
          onOpenThread={onOpenThread}
          onStopThread={onStopThread}
          onStopAll={onStopAll}
        />
      </div>,
    );

    try {
      const parentButton = page.getByRole("button", {
        name: "Open agent thread Parent activity with a long title",
      });
      const parentButtonElement = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Open agent thread Parent activity with a long title"]',
      );
      const descriptionId = parentButtonElement?.getAttribute("aria-describedby");
      expect(descriptionId).not.toBeNull();
      expect(document.getElementById(descriptionId!)?.textContent).toContain(
        "Codex. model GPT-5.6. effort high. status Thinking. duration 4s",
      );
      await parentButton.click();
      expect(onOpenThread).toHaveBeenCalledWith(parent.threadId);

      await page
        .getByRole("button", { name: "Open agent thread Child activity with another long title" })
        .hover();
      const stopButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop Scout"]',
      );
      stopButton?.focus();
      expect(document.activeElement).toBe(stopButton);
      await vi.waitFor(() =>
        expect(stopButton ? getComputedStyle(stopButton).opacity : "0").toBe("1"),
      );
      await page.getByRole("button", { name: "Stop Scout" }).click();
      expect(onStopThread).toHaveBeenCalledWith(child);
      expect(onOpenThread).toHaveBeenCalledTimes(1);
      expect(page.getByRole("button", { name: "Stopping Scout" })).toBeDisabled();

      await page.getByRole("button", { name: "Stop all agents" }).click();
      expect(onStopAll).toHaveBeenCalledWith([parent]);
      expect(page.getByRole("button", { name: "Stopping all agents" })).toBeDisabled();

      const childRow = document.querySelector<HTMLElement>(`[data-thread-id="${child.threadId}"]`);
      const panel = document.querySelector<HTMLElement>('[data-testid="workspace-agent-panel"]');
      expect(childRow?.getAttribute("data-agent-depth")).toBe("1");
      expect(childRow?.style.paddingInlineStart).toBe("20px");
      expect(document.querySelector("button button")).toBeNull();
      expect(panel).not.toBeNull();
      expect(panel!.scrollWidth).toBeLessThanOrEqual(panel!.clientWidth);
    } finally {
      await mounted.unmount();
    }
  });

  it("auto-opens and auto-collapses only across live-count transitions", async () => {
    const completed = makeEntry({ status: "completed", threadTitle: "Completed agent" });
    const live = { ...completed, status: "thinking" as const, threadTitle: "Live agent" };
    const queued = { ...completed, status: "queued" as const, threadTitle: "Queued agent" };
    const completedActivity = makeActivity([completed], [{ entry: completed, children: [] }]);
    const liveActivity = makeActivity([live], [{ entry: live, children: [] }]);
    const queuedActivity = makeActivity([queued], [{ entry: queued, children: [] }]);

    function Harness() {
      const [activity, setActivity] = useState(completedActivity);
      return (
        <>
          <button type="button" onClick={() => setActivity(liveActivity)}>
            Set live
          </button>
          <button type="button" onClick={() => setActivity(completedActivity)}>
            Set completed
          </button>
          <button type="button" onClick={() => setActivity(queuedActivity)}>
            Set queued
          </button>
          <WorkspaceAgentPanel
            activity={activity}
            onOpenThread={vi.fn()}
            onStopThread={vi.fn()}
            onStopAll={vi.fn()}
          />
        </>
      );
    }

    const mounted = await render(<Harness />);
    try {
      const panelToggle = () =>
        document.querySelector<HTMLButtonElement>('button[aria-label$="workspace agents"]');

      expect(panelToggle()?.getAttribute("aria-expanded")).toBe("false");
      await page.getByRole("button", { name: "Expand workspace agents" }).click();
      expect(panelToggle()?.getAttribute("aria-expanded")).toBe("true");
      await page.getByRole("button", { name: "Collapse workspace agents" }).click();
      expect(panelToggle()?.getAttribute("aria-expanded")).toBe("false");

      await page.getByRole("button", { name: "Set live" }).click();
      await vi.waitFor(() => expect(panelToggle()?.getAttribute("aria-expanded")).toBe("true"));
      await page.getByRole("button", { name: "Collapse workspace agents" }).click();
      expect(panelToggle()?.getAttribute("aria-expanded")).toBe("false");

      await page.getByRole("button", { name: "Set completed" }).click();
      await vi.waitFor(() => expect(panelToggle()?.getAttribute("aria-expanded")).toBe("false"));
      await page.getByRole("button", { name: "Expand workspace agents" }).click();
      expect(panelToggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(page.getByText("Completed agent")).toBeVisible();

      await page.getByRole("button", { name: "Collapse workspace agents" }).click();
      await page.getByRole("button", { name: "Set queued" }).click();
      await vi.waitFor(() => expect(panelToggle()?.getAttribute("aria-expanded")).toBe("true"));
      expect(page.getByText("Queued agent")).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps same-turn interrupts pending until settlement or the bounded retry window", async () => {
    const now = { value: 100_000 };
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now.value);
    const initial = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-sessionless-live-tail"),
      parentThreadId: ThreadId.makeUnsafe("thread-sessionless-parent"),
      isSubagent: true,
      subagentNickname: "Tail worker",
      duration: 0,
      turnId: TurnId.makeUnsafe("turn-sessionless-live-tail"),
    });
    const onStopThread = vi.fn(async () => "dispatched" as const);
    const renderPanel = (entry: AgentThreadEntry) => (
      <WorkspaceAgentPanel
        activity={makeActivity([entry], [{ entry, children: [] }])}
        onOpenThread={vi.fn()}
        onStopThread={onStopThread}
        onStopAll={async (entries) => successfulBatch(entries)}
      />
    );
    const mounted = await render(renderPanel(initial));

    try {
      await page.getByRole("button", { name: "Stop Tail worker" }).click();
      expect(page.getByRole("button", { name: "Stopping Tail worker" })).toBeDisabled();

      now.value += 14_999;
      const stillWorking = { ...initial, lastActivityAt: initial.lastActivityAt + 1 };
      await mounted.rerender(renderPanel(stillWorking));
      expect(page.getByRole("button", { name: "Stopping Tail worker" })).toBeDisabled();

      now.value += 1;
      await mounted.rerender(
        renderPanel({ ...stillWorking, lastActivityAt: stillWorking.lastActivityAt + 1 }),
      );
      await vi.waitFor(() =>
        expect(page.getByRole("button", { name: "Stop Tail worker" })).toBeEnabled(),
      );

      await page.getByRole("button", { name: "Stop Tail worker" }).click();
      const nextTurn = {
        ...stillWorking,
        turnId: TurnId.makeUnsafe("turn-sessionless-next"),
        duration: 100,
      };
      await mounted.rerender(renderPanel(nextTurn));
      await vi.waitFor(() =>
        expect(page.getByRole("button", { name: "Stop Tail worker" })).toBeEnabled(),
      );

      await page.getByRole("button", { name: "Stop Tail worker" }).click();
      await mounted.rerender(renderPanel({ ...nextTurn, status: "completed" }));
      await vi.waitFor(() => {
        expect(
          document.querySelector('button[aria-label="Expand workspace agents"]'),
        ).not.toBeNull();
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Expand workspace agents");
      });
      expect(onStopThread).toHaveBeenCalledTimes(3);
    } finally {
      dateNow.mockRestore();
      await mounted.unmount();
    }
  });

  it("hands disappearing Stop All focus to the panel toggle without stealing external focus", async () => {
    const live = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-stop-all-focus"),
      threadTitle: "Focus agent",
    });
    const completed = { ...live, status: "completed" as const };
    const onStopAll = vi.fn(async (entries: AgentThreadEntry[]) => successfulBatch(entries));
    const renderPanel = (entry: AgentThreadEntry) => (
      <>
        <button type="button">Outside control</button>
        <WorkspaceAgentPanel
          activity={makeActivity([entry], [{ entry, children: [] }])}
          onOpenThread={vi.fn()}
          onStopThread={async () => "dispatched"}
          onStopAll={onStopAll}
        />
      </>
    );
    const mounted = await render(renderPanel(live));

    try {
      await page.getByRole("button", { name: "Stop all agents" }).click();
      await mounted.rerender(renderPanel(completed));
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Expand workspace agents"),
      );

      await mounted.rerender(renderPanel(live));
      await vi.waitFor(() =>
        expect(
          document.querySelector('button[aria-label="Collapse workspace agents"]'),
        ).not.toBeNull(),
      );
      await page.getByRole("button", { name: "Outside control" }).click();
      expect(document.activeElement?.textContent).toBe("Outside control");

      await mounted.rerender(renderPanel(completed));
      await vi.waitFor(() =>
        expect(
          document.querySelector('button[aria-label="Expand workspace agents"]'),
        ).not.toBeNull(),
      );
      expect(document.activeElement?.textContent).toBe("Outside control");
      expect(onStopAll).toHaveBeenCalledWith([live]);
    } finally {
      await mounted.unmount();
    }
  });

  it("recovers focus when stop actions disappear while queued work remains", async () => {
    const live = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-partial-focus-live"),
      threadTitle: "Partial focus agent",
    });
    const completed = { ...live, status: "completed" as const };
    const queued = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-partial-focus-queued"),
      parentThreadId: live.threadId,
      threadTitle: "Queued companion",
      status: "queued",
      turnId: null,
    });
    const renderPanel = (entry: AgentThreadEntry) => (
      <WorkspaceAgentPanel
        activity={makeActivity(
          [entry, queued],
          [{ entry, children: [{ entry: queued, children: [] }] }],
        )}
        onOpenThread={vi.fn()}
        onStopThread={async () => "dispatched"}
        onStopAll={async (entries) => successfulBatch(entries)}
      />
    );
    const mounted = await render(renderPanel(live));

    try {
      const stopAll = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop all agents"]',
      );
      stopAll?.focus();
      expect(document.activeElement).toBe(stopAll);
      await mounted.rerender(renderPanel(completed));
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-label")).toBe(
          "Collapse workspace agents",
        ),
      );

      await mounted.rerender(renderPanel(live));
      const stopThread = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop Partial focus agent"]',
      );
      expect(stopThread).not.toBeNull();
      stopThread?.focus();
      expect(document.activeElement).toBe(stopThread);
      await mounted.rerender(renderPanel(completed));
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-label")).toBe(
          "Collapse workspace agents",
        ),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("releases rejected, skipped, and failed actions without duplicating dispatched stops", async () => {
    const alpha = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-stop-alpha"),
      threadTitle: "Alpha agent",
      turnId: TurnId.makeUnsafe("turn-stop-alpha"),
    });
    const beta = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-stop-beta"),
      threadTitle: "Beta agent",
      turnId: TurnId.makeUnsafe("turn-stop-beta"),
    });
    const gamma = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-stop-gamma"),
      threadTitle: "Gamma agent",
      turnId: TurnId.makeUnsafe("turn-stop-gamma"),
    });
    const entries = [alpha, beta, gamma];
    const onStopThread = vi.fn(async () => {
      throw new Error("connection closed");
    });
    let batchCall = 0;
    const onStopAll = vi.fn(async (targets: AgentThreadEntry[]) => {
      batchCall += 1;
      if (batchCall > 1) return successfulBatch(targets);
      return {
        attemptedThreadIds: targets.map((entry) => entry.threadId),
        dispatchedThreadIds: [alpha.threadId],
        skippedThreadIds: [beta.threadId],
        failures: [{ threadId: gamma.threadId, reason: new Error("rejected") }],
      };
    });
    const mounted = await render(
      <WorkspaceAgentPanel
        activity={makeActivity(
          entries,
          entries.map((entry) => ({ entry, children: [] })),
        )}
        onOpenThread={vi.fn()}
        onStopThread={onStopThread}
        onStopAll={onStopAll}
      />,
    );

    try {
      await page.getByRole("button", { name: "Stop Beta agent" }).click();
      await vi.waitFor(() =>
        expect(page.getByRole("button", { name: "Stop Beta agent" })).toBeEnabled(),
      );

      await page.getByRole("button", { name: "Stop all agents" }).click();
      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: "Stopping Alpha agent" })).toBeDisabled();
        expect(page.getByRole("button", { name: "Stop Beta agent" })).toBeEnabled();
        expect(page.getByRole("button", { name: "Stop Gamma agent" })).toBeEnabled();
      });

      await page.getByRole("button", { name: "Stop all agents" }).click();
      expect(onStopAll).toHaveBeenNthCalledWith(2, [beta, gamma]);
      expect(onStopThread).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("supports per-project disclosure and local terminal-leaf dismissal", async () => {
    const parent = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-completed-parent"),
      threadTitle: "Completed parent",
      status: "completed",
    });
    const child = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-completed-child"),
      parentThreadId: parent.threadId,
      threadTitle: "Completed child",
      status: "completed",
    });
    const onOpenThread = vi.fn();
    const mounted = await render(
      <WorkspaceAgentPanel
        activity={makeActivity(
          [parent, child],
          [{ entry: parent, children: [{ entry: child, children: [] }] }],
        )}
        onOpenThread={onOpenThread}
        onStopThread={vi.fn()}
        onStopAll={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: "Expand workspace agents" }).click();
      const projectToggle = page.getByRole("button", { name: "Collapse Synara agents" });
      await projectToggle.click();
      expect(
        document
          .querySelector('button[aria-label="Expand Synara agents"]')
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
      await page.getByRole("button", { name: "Expand Synara agents" }).click();

      await page.getByRole("button", { name: "Open agent thread Completed parent" }).click();
      expect(onOpenThread).toHaveBeenCalledWith(parent.threadId);
      expect(document.querySelector('button[aria-label="Dismiss Completed parent"]')).toBeNull();
      await page.getByRole("button", { name: "Open agent thread Completed child" }).hover();
      await page.getByRole("button", { name: "Dismiss Completed child" }).click();
      expect(document.querySelector(`[data-thread-id="${child.threadId}"]`)).toBeNull();
      expect(document.querySelector(`[data-thread-id="${parent.threadId}"]`)).not.toBeNull();
      expect(document.querySelector('button[aria-label="Dismiss Completed parent"]')).toBeNull();
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("1 recent");
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Open agent thread Completed parent",
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("recovers focus when dismissing the only terminal project row", async () => {
    const completed = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-only-terminal"),
      threadTitle: "Only terminal agent",
      status: "completed",
    });
    const mounted = await render(
      <WorkspaceAgentPanel
        activity={makeActivity([completed], [{ entry: completed, children: [] }])}
        onOpenThread={vi.fn()}
        onStopThread={vi.fn()}
        onStopAll={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: "Expand workspace agents" }).click();
      await page.getByRole("button", { name: "Dismiss Only terminal agent" }).click();
      await vi.waitFor(() => {
        expect(document.querySelector(`[data-thread-id="${completed.threadId}"]`)).toBeNull();
        expect(document.activeElement?.getAttribute("aria-label")).toBe(
          "Collapse workspace agents",
        );
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps a failed terminal dismissal stable until a new terminal episode", async () => {
    const terminal = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-sessionless-terminal"),
      threadTitle: "Sessionless terminal agent",
      status: "failed",
      turnId: null,
    });
    const renderPanel = (entry: AgentThreadEntry) => (
      <WorkspaceAgentPanel
        activity={makeActivity([entry], [{ entry, children: [] }])}
        onOpenThread={vi.fn()}
        onStopThread={vi.fn()}
        onStopAll={vi.fn()}
      />
    );
    const mounted = await render(renderPanel(terminal));

    try {
      await page.getByRole("button", { name: "Expand workspace agents" }).click();
      await page.getByRole("button", { name: "Dismiss Sessionless terminal agent" }).click();
      const sameTerminalEpisode = {
        ...terminal,
        turnId: TurnId.makeUnsafe("turn-sessionless-terminal-late"),
        lastActivityAt: terminal.lastActivityAt + 1,
      };
      await mounted.rerender(renderPanel(sameTerminalEpisode));
      expect(document.querySelector(`[data-thread-id="${terminal.threadId}"]`)).toBeNull();

      const live = {
        ...sameTerminalEpisode,
        status: "thinking" as const,
        lastActivityAt: terminal.lastActivityAt + 2,
      };
      await mounted.rerender(renderPanel(live));
      expect(document.querySelector(`[data-thread-id="${terminal.threadId}"]`)).not.toBeNull();

      const nextTerminal = {
        ...live,
        status: "failed" as const,
        lastActivityAt: terminal.lastActivityAt + 3,
      };
      await mounted.rerender(renderPanel(nextTerminal));
      expect(document.querySelector(`[data-thread-id="${terminal.threadId}"]`)).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
