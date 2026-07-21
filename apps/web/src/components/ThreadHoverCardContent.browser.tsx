// FILE: ThreadHoverCardContent.browser.tsx
// Purpose: Focused browser proof for thread hover-card action callbacks and event isolation.
// Layer: Sidebar UI component browser tests

import "../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadHoverCardContent } from "./ThreadHoverCardContent";
import { makeWorkspaceAgentEntry } from "./workspace/WorkspaceAgentPanel.testFixtures";

describe("ThreadHoverCardContent actions", () => {
  it("invokes each action while preventing default and parent-row propagation", async () => {
    const onOpenThread = vi.fn();
    const onInterrupt = vi.fn();
    const onParentClick = vi.fn();
    const mounted = await render(
      <div data-testid="thread-hover-action-card" onClick={onParentClick}>
        <ThreadHoverCardContent
          threadTitle="Active release agent"
          timeLabel="now"
          provider="codex"
          modelLabel="gpt-5.6-sol"
          parentThreadTitle={null}
          status="thinking"
          duration={12_000}
          toolLabel={null}
          permissionMode="full-access"
          subagentCount={0}
          subagentRunningCount={0}
          worktreeLabel={null}
          prTitle={null}
          prState={null}
          onOpenThread={onOpenThread}
          onInterrupt={onInterrupt}
        />
      </div>,
    );

    try {
      const openButton = page.getByRole("button", { name: "Open thread" });
      const interruptButton = page.getByRole("button", { name: "Interrupt" });
      await expect.element(openButton).toBeVisible();
      await expect.element(interruptButton).toBeVisible();
      await expect.element(page.getByText("Active release agent")).toBeVisible();
      expect(document.querySelector('[aria-label="Subagent activity"]')).toBeNull();

      const actionCard = document.querySelector<HTMLElement>(
        '[data-testid="thread-hover-action-card"]',
      );
      const actionButtons = actionCard?.querySelectorAll<HTMLButtonElement>("button");
      const openElement = actionButtons?.item(0) ?? null;
      const interruptElement = actionButtons?.item(1) ?? null;
      expect(openElement).not.toBeNull();
      expect(interruptElement).not.toBeNull();

      const openResult = openElement!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      expect(openResult).toBe(false);
      expect(onOpenThread).toHaveBeenCalledOnce();
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(onParentClick).not.toHaveBeenCalled();

      const interruptResult = interruptElement!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      expect(interruptResult).toBe(false);
      expect(onOpenThread).toHaveBeenCalledOnce();
      expect(onInterrupt).toHaveBeenCalledOnce();
      expect(onParentClick).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("uses the shared accessible disclosure for settled subagent details", async () => {
    const subagentTree = ["completed", "failed"].map((status, index) => ({
      entry: makeWorkspaceAgentEntry({
        threadId: `hover-browser-child-${index}` as never,
        threadTitle: `Child ${index + 1}`,
        status: status as "completed" | "failed",
        activityState: {
          ...makeWorkspaceAgentEntry().activityState,
          phase: status as "completed" | "failed",
        },
      }),
      children: [],
    }));
    const mounted = await render(
      <ThreadHoverCardContent
        threadTitle="Release coordinator"
        timeLabel="now"
        provider="codex"
        modelLabel="gpt-5.6-sol"
        parentThreadTitle={null}
        status="completed"
        duration={12_000}
        toolLabel={null}
        permissionMode="full-access"
        subagentCount={2}
        subagentRunningCount={0}
        subagentTree={subagentTree}
        worktreeLabel={null}
        prTitle={null}
        prState={null}
        onOpenThread={() => undefined}
        onInterrupt={null}
      />,
    );

    try {
      const toggle = page.getByRole("button", {
        name: "2 subagents settled · 1 completed · 1 failed · details",
      });
      const details = document.querySelector<HTMLElement>(
        '[aria-label="Subagent activity details"]',
      );
      expect(details).not.toBeNull();
      const disclosure = details!.closest<HTMLElement>("[aria-hidden]");
      expect(disclosure).not.toBeNull();
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      expect(disclosure!.getAttribute("aria-hidden")).toBe("true");
      expect(disclosure!.inert).toBe(true);

      await toggle.click();

      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
      expect(disclosure!.hasAttribute("aria-hidden")).toBe(false);
      expect(disclosure!.inert).toBe(false);
      await expect.element(details!).toBeVisible();
      await expect.element(page.getByText("Child 1")).toBeVisible();
      await expect.element(page.getByText("Child 2")).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });
});
