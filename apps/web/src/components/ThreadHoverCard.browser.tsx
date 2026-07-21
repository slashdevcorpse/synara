// FILE: ThreadHoverCard.browser.tsx
// Purpose: Verifies the real interactive hover boundary without mounting the full Sidebar.
// Layer: Browser UI test

import "../index.css";

import { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type {
  AgentThreadEntry,
  WorkspaceAgentThreadActivity,
} from "../hooks/useWorkspaceAgentActivity";
import type { SidebarThreadSummary } from "../types";
import { ThreadHoverCardActivityContent, ThreadHoverCardFrame } from "./ThreadHoverCard";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "./ui/sidebar";

const PROJECT_ID = ProjectId.makeUnsafe("project-thread-hover-browser");
const THREAD_ID = ThreadId.makeUnsafe("thread-hover-browser");
const PARENT_THREAD_ID = ThreadId.makeUnsafe("thread-hover-parent-browser");
const TURN_ID = TurnId.makeUnsafe("turn-thread-hover-browser");

const ACTIVE_ENTRY: AgentThreadEntry = {
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  projectTitle: "Synara",
  projectCwd: "C:/src/synara",
  threadTitle: "Hovered subagent thread",
  parentThreadId: PARENT_THREAD_ID,
  isSubagent: true,
  subagentNickname: "Builder",
  subagentRole: "implementation",
  modelLabel: "openrouter/gpt-5.4",
  effortLabel: null,
  providerKind: "opencode",
  status: "tool-running",
  duration: 480_000,
  latestTool: { name: "bun run test", state: "running" },
  streamPreview: null,
  associatedWorktreeBranch: "feature/thread-hover",
  createdAt: Date.parse("2026-07-20T12:00:00.000Z"),
  lastActivityAt: Date.parse("2026-07-20T12:08:00.000Z"),
  turnId: TURN_ID,
};

const PARENT_ENTRY: AgentThreadEntry = {
  ...ACTIVE_ENTRY,
  threadId: PARENT_THREAD_ID,
  threadTitle: "Parent thread",
  parentThreadId: null,
  isSubagent: false,
  subagentNickname: null,
  subagentRole: null,
  modelLabel: "Claude Opus 4.8",
  providerKind: "claudeAgent",
  status: "completed",
  latestTool: null,
  turnId: null,
};

const THREAD: SidebarThreadSummary = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Hovered subagent thread",
  modelSelection: { provider: "opencode", model: "openrouter/gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "plan",
  branch: null,
  worktreePath: null,
  associatedWorktreePath: "C:/src/.worktrees/thread-hover",
  associatedWorktreeBranch: "feature/thread-hover",
  session: null,
  createdAt: "2026-07-20T12:00:00.000Z",
  updatedAt: "2026-07-20T12:08:00.000Z",
  latestTurn: null,
  parentThreadId: PARENT_THREAD_ID,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  hasLiveTailWork: true,
};

const ACTIVITY: WorkspaceAgentThreadActivity = {
  entry: ACTIVE_ENTRY,
  parentEntry: PARENT_ENTRY,
  subagentCount: 3,
  subagentRunningCount: 2,
};

describe("ThreadHoverCardFrame", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts content only while open and keeps the popup reachable from the row", async () => {
    const onOpenThread = vi.fn();
    const onInterruptEntry = vi.fn(async () => undefined);
    const renderContent = vi.fn((close: () => void) => (
      <div data-testid="thread-hover-content">
        <ThreadHoverCardActivityContent
          thread={THREAD}
          project={{ folderName: "synara", name: "Synara" }}
          pullRequest={{
            number: 22,
            title: "fix(release): preserve hover state",
            url: "https://github.com/slashdevcorpse/synara/pull/22",
            baseBranch: "main",
            headBranch: "feature/thread-hover",
            state: "open",
            isDraft: false,
            mergeability: "mergeable",
            additions: 24,
            deletions: 3,
            changedFiles: 4,
          }}
          activity={ACTIVITY}
          close={close}
          onOpenThread={onOpenThread}
          onInterruptEntry={onInterruptEntry}
        />
      </div>
    ));
    const mounted = await render(
      <div>
        <div
          data-slot="sidebar-container"
          data-testid="sidebar-shell"
          style={{ width: 240, height: 120, overflow: "auto" }}
        >
          <SidebarMenuSubItem data-thread-hover-anchor="project:thread-hover-browser">
            <ThreadHoverCardFrame
              anchorId="project:thread-hover-browser"
              trigger={
                <SidebarMenuSubButton
                  render={<div role="button" tabIndex={0} data-testid="thread-row" />}
                  size="sm"
                />
              }
              renderContent={renderContent}
            >
              Hovered subagent thread
            </ThreadHoverCardFrame>
          </SidebarMenuSubItem>
        </div>
        <button type="button" data-testid="outside-target">
          Outside
        </button>
      </div>,
    );

    try {
      const row = page.getByTestId("thread-row");
      const shell = document.querySelector<HTMLElement>('[data-testid="sidebar-shell"]')!;
      const rowElement = document.querySelector<HTMLElement>('[data-testid="thread-row"]')!;
      const rowRect = rowElement.getBoundingClientRect();
      const initialRowGeometry = {
        x: rowRect.x,
        y: rowRect.y,
        width: rowRect.width,
        height: rowRect.height,
      };
      const initialScrollTop = shell.scrollTop;
      const initialScrollWidth = shell.scrollWidth;

      expect(renderContent).not.toHaveBeenCalled();
      await row.hover();
      await expect.element(page.getByTestId("thread-hover-content")).toBeVisible();
      expect(renderContent).toHaveBeenCalled();

      const popup = document.querySelector<HTMLElement>('[data-slot="preview-card-popup"]')!;
      expect(popup).not.toBeNull();
      expect(getComputedStyle(popup).width).toBe("256px");
      const openRowRect = rowElement.getBoundingClientRect();
      expect({
        x: openRowRect.x,
        y: openRowRect.y,
        width: openRowRect.width,
        height: openRowRect.height,
      }).toEqual(initialRowGeometry);
      expect(shell.scrollTop).toBe(initialScrollTop);
      expect(shell.scrollWidth).toBe(initialScrollWidth);

      await page.getByTestId("thread-hover-content").hover();
      await expect.element(page.getByText("GPT-5.4")).toBeVisible();
      await expect.element(page.getByText("subagent of Parent thread")).toBeVisible();
      await expect.element(page.getByText("tool: bun run test · 8m")).toBeVisible();
      await expect.element(page.getByText("plan · 2 of 3 subagents running")).toBeVisible();
      await expect.element(page.getByText("workspace: feature/thread-hover")).toBeVisible();
      await expect.element(page.getByText("#22: fix(release): preserve hover state")).toBeVisible();
      expect(document.body.textContent).toContain("Claude: ");

      await page.getByRole("button", { name: "Interrupt" }).click();
      expect(onInterruptEntry).toHaveBeenCalledWith(ACTIVE_ENTRY);
      await expect.element(page.getByTestId("thread-hover-content")).not.toBeInTheDocument();

      await row.hover();
      await expect.element(page.getByTestId("thread-hover-content")).toBeVisible();
      await page.getByRole("button", { name: "Open thread" }).click();
      expect(onOpenThread).toHaveBeenCalledWith(THREAD_ID);
      await expect.element(page.getByTestId("thread-hover-content")).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("uses zero close delay when the pointer leaves both trigger and popup", async () => {
    const mounted = await render(
      <div>
        <div data-slot="sidebar-container" style={{ width: 240, height: 120 }}>
          <ThreadHoverCardFrame
            anchorId="pinned:thread-hover-dismiss"
            trigger={
              <div
                data-thread-hover-anchor="pinned:thread-hover-dismiss"
                data-testid="dismiss-row"
                className="group/thread-row relative w-full"
              />
            }
            renderContent={() => (
              <div data-testid="dismiss-content">workspace: feature/thread-hover</div>
            )}
          >
            <div role="button" tabIndex={0}>
              Pinned forked thread
              <button type="button" data-testid="nested-pr-control">
                PR
              </button>
            </div>
          </ThreadHoverCardFrame>
        </div>
        <button type="button" data-testid="dismiss-outside">
          Outside
        </button>
      </div>,
    );

    try {
      await page.getByTestId("dismiss-outside").hover();
      await expect.element(page.getByTestId("dismiss-content")).not.toBeInTheDocument();
      await page.getByTestId("dismiss-row").hover();
      await expect.element(page.getByTestId("dismiss-content")).toBeVisible();
      await expect.element(page.getByTestId("nested-pr-control")).toBeVisible();
      await page.getByTestId("dismiss-outside").hover();
      const closingPopup = document.querySelector<HTMLElement>('[data-slot="preview-card-popup"]');
      expect(closingPopup?.hasAttribute("data-ending-style")).toBe(true);
      expect(document.querySelector('[data-testid="dismiss-content"]')).not.toBeNull();
      await expect.element(page.getByTestId("dismiss-content")).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });
});
