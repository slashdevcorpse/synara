// FILE: WorkspaceProjectCard.browser.tsx
// Purpose: Browser-level interaction coverage for workspace project cards.
// Layer: Browser UI test

import "../../index.css";

import type { ProjectId, ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { WorkspaceCardModel } from "./workspaceDashboard.logic";
import { WorkspaceProjectCard } from "./WorkspaceProjectCard";

const projectId = "project-1" as ProjectId;
const threadId = "thread-1" as ThreadId;

function card(overrides: Partial<WorkspaceCardModel> = {}): WorkspaceCardModel {
  return {
    project: {
      id: projectId,
      kind: "project",
      name: "Demo",
      remoteName: "Demo",
      folderName: "Demo",
      localName: null,
      cwd: "C:\\code\\demo",
      defaultModelSelection: null,
      expanded: true,
      scripts: [],
    },
    repository: {
      kind: "git",
      remoteUrl: "https://github.com/acme/demo.git",
      remoteName: "origin",
      branch: "main",
      headState: "branch",
      ahead: 1,
      behind: 0,
      dirtyFileCount: 2,
      hasUnpushedCommits: true,
      githubStatus: "ready",
      linkedPr: {
        repository: "acme/demo",
        number: 42,
        title: "Ship workspace dashboard",
        url: "https://github.com/acme/demo/pull/42",
        state: "open",
        isDraft: false,
        checks: [{ name: "test", status: "success", url: null }],
      },
    },
    recentThread: null,
    activity: null,
    processActivity: {
      agentCount: 0,
      agentRunningCount: 0,
      subagentCount: 0,
      subagentRunningCount: 0,
      terminalProcessCount: 0,
      devServerRunning: false,
      gitActionRunning: false,
      anyProcessRunning: false,
    },
    worktrees: [],
    providers: [],
    automation: null,
    recentAt: "2026-07-20T12:00:00.000Z",
    recentAtMs: Date.parse("2026-07-20T12:00:00.000Z"),
    ...overrides,
  };
}

function props(model: WorkspaceCardModel) {
  return {
    card: model,
    refreshing: false,
    initializing: false,
    archiving: false,
    isPinned: false,
    onOpenProject: vi.fn(),
    onOpenThread: vi.fn(),
    onOpenTerminal: vi.fn(),
    onRefresh: vi.fn(),
    onInitGit: vi.fn(),
    onOpenPullRequest: vi.fn(),
    onArchive: vi.fn(),
    onTogglePin: vi.fn(),
  };
}

describe("WorkspaceProjectCard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses a full-card sibling target while keeping nested controls independently interactive", async () => {
    const callbacks = props(card());
    await render(<WorkspaceProjectCard {...callbacks} />);

    const openTarget = page.getByRole("button", { name: "Open Demo" });
    const pinTarget = page.getByRole("button", { name: "Pin Demo" });
    const article = document.querySelector("article");
    const openElement = document.querySelector<HTMLButtonElement>('button[aria-label="Open Demo"]');
    const pinElement = document.querySelector<HTMLButtonElement>('button[aria-label="Pin Demo"]');

    expect(article).not.toBeNull();
    expect(openElement?.parentElement).toBe(article);
    expect(openElement?.nextElementSibling?.contains(pinElement ?? null)).toBe(true);
    expect(openElement?.getBoundingClientRect().width).toBe(article?.getBoundingClientRect().width);
    expect(openElement?.getBoundingClientRect().height).toBe(
      article?.getBoundingClientRect().height,
    );

    await openTarget.click({ position: { x: 6, y: 6 } });
    await pinTarget.click();
    await page.getByRole("button", { name: /#42 Ship workspace dashboard/ }).click();

    expect(callbacks.onOpenProject).toHaveBeenCalledOnce();
    expect(callbacks.onTogglePin).toHaveBeenCalledOnce();
    expect(callbacks.onOpenPullRequest).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("offers Git initialization for a non-repository project", async () => {
    const callbacks = props(card({ repository: { kind: "not-git" } }));
    await render(<WorkspaceProjectCard {...callbacks} />);

    await page.getByRole("button", { name: "Initialize Git" }).click();
    expect(callbacks.onInitGit).toHaveBeenCalledOnce();
  });

  it("distinguishes unavailable GitHub status from no linked pull request", async () => {
    const model = card();
    const callbacks = props(
      card({
        repository:
          model.repository.kind === "git"
            ? {
                ...model.repository,
                linkedPr: null,
                githubStatus: "unavailable",
                githubErrorMessage: "GitHub CLI authentication is required.",
              }
            : model.repository,
      }),
    );
    await render(<WorkspaceProjectCard {...callbacks} />);

    const indicator = page.getByText("PR status unavailable");
    await expect.element(indicator).toBeVisible();
    await expect
      .element(indicator)
      .toHaveAttribute("title", "GitHub CLI authentication is required.");
  });

  it("distinguishes an unborn repository from a detached HEAD", async () => {
    const model = card();
    if (model.repository.kind !== "git") throw new Error("Expected a Git card fixture.");
    const unbornCallbacks = props(
      card({
        repository: {
          ...model.repository,
          branch: "main",
          headState: "unborn",
        },
      }),
    );
    const view = await render(<WorkspaceProjectCard {...unbornCallbacks} />);

    await expect.element(page.getByText("No commits", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("Detached HEAD");

    await view.rerender(
      <WorkspaceProjectCard
        {...props(
          card({
            repository: {
              ...model.repository,
              branch: null,
              headState: "detached",
            },
          }),
        )}
      />,
    );
    await expect.element(page.getByText("Detached HEAD", { exact: true })).toBeVisible();
  });

  it("opens the active agent target without hijacking the card target", async () => {
    const callbacks = props(
      card({
        activity: {
          threadId,
          label: "Thinking",
          colorClass: "text-warning",
          dotClass: "bg-warning",
          pulse: true,
        },
      }),
    );
    await render(<WorkspaceProjectCard {...callbacks} />);

    await page.getByRole("button", { name: "Thinking" }).click();
    expect(callbacks.onOpenThread).toHaveBeenCalledWith(threadId);
    expect(callbacks.onOpenProject).not.toHaveBeenCalled();
  });

  it("includes Git work in the visible process summary", async () => {
    await render(
      <WorkspaceProjectCard
        {...props(
          card({
            processActivity: {
              ...card().processActivity,
              gitActionRunning: true,
              anyProcessRunning: true,
            },
          }),
        )}
      />,
    );

    await expect.element(page.getByText(/Git operation running/)).toBeVisible();
  });
});
