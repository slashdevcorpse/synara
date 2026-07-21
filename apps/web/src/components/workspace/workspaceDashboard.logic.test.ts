import { describe, expect, it } from "vitest";

import type { ProjectId, ProviderKind, ThreadId } from "@synara/contracts";

import type { Project, SidebarThreadSummary } from "~/types";
import {
  defaultCloneTarget,
  canDragWorkspaceCards,
  canDragWorkspaceCard,
  deriveWorkspaceCards,
  filterAndSortWorkspaceCards,
  githubRepositoryFromUrl,
  orderWorkspaceCardsPinnedFirst,
  type WorkspaceRepositoryState,
  validateCloneInput,
} from "./workspaceDashboard.logic";

const projectId = (value: string) => value as ProjectId;
const threadId = (value: string) => value as ThreadId;

function project(id: string, name: string, updatedAt = "2026-07-18T12:00:00.000Z"): Project {
  return {
    id: projectId(id),
    kind: "project",
    name,
    remoteName: name,
    folderName: name,
    localName: null,
    cwd: `C:\\code\\${name}`,
    defaultModelSelection: null,
    expanded: true,
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt,
    scripts: [],
  };
}

function thread(
  id: string,
  owner: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: threadId(id),
    projectId: projectId(owner),
    title: id,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    session: null,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

const gitState = (
  dirtyFileCount: number,
  hasUnpushedCommits = false,
): WorkspaceRepositoryState => ({
  kind: "git",
  remoteUrl: "https://github.com/acme/repo.git",
  remoteName: "origin",
  branch: "main",
  headState: "branch",
  ahead: hasUnpushedCommits ? 1 : 0,
  behind: 0,
  dirtyFileCount,
  hasUnpushedCommits,
  linkedPr: null,
  githubStatus: "ready",
});

describe("workspace dashboard derivation", () => {
  it("uses an explicit loading repository state until status data arrives", () => {
    const cards = deriveWorkspaceCards({
      projects: [project("pending", "Pending")],
      repositoryByProjectId: new Map(),
      worktreePathPlatform: "windows",
      threads: [],
    });

    expect(cards[0]?.repository).toEqual({ kind: "loading" });
  });

  it("selects actionable activity before working and aggregates unique worktrees/providers", () => {
    const repositoryByProjectId = new Map([[projectId("one"), gitState(2)]]);
    const cards = deriveWorkspaceCards({
      projects: [project("one", "One")],
      repositoryByProjectId,
      worktreePathPlatform: "windows",
      threads: [
        thread("working", "one", {
          hasLiveTailWork: true,
          session: {
            provider: "codex" as ProviderKind,
            status: "running",
            createdAt: "2026-07-19T12:00:00.000Z",
            updatedAt: "2026-07-19T13:00:00.000Z",
            orchestrationStatus: "running",
          },
          worktreePath: "C:\\code\\one-wt",
        }),
        thread("approval", "one", {
          parentThreadId: threadId("working"),
          subagentAgentId: "approval-agent",
          hasPendingApprovals: true,
          session: {
            provider: "claudeAgent" as ProviderKind,
            status: "connecting",
            createdAt: "2026-07-19T12:00:00.000Z",
            updatedAt: "2026-07-19T14:00:00.000Z",
            orchestrationStatus: "starting",
          },
          associatedWorktreePath: "c:/code/one-wt",
          associatedWorktreeBranch: "feature",
          updatedAt: "2026-07-19T14:00:00.000Z",
        }),
      ],
    });

    expect(cards[0]?.activity?.label).toBe("Pending Approval");
    expect(cards[0]?.activity?.threadId).toBe(threadId("approval"));
    expect(cards[0]?.worktrees).toHaveLength(1);
    expect(cards[0]?.worktrees[0]?.branch).toBe("feature");
    expect(cards[0]?.providers).toEqual(["codex", "claudeAgent"]);
  });

  it("excludes idle and stopped sessions from active provider badges", () => {
    const cards = deriveWorkspaceCards({
      projects: [project("one", "One")],
      repositoryByProjectId: new Map([[projectId("one"), gitState(0)]]),
      worktreePathPlatform: "windows",
      threads: [
        thread("idle", "one", {
          session: {
            provider: "codex",
            status: "ready",
            createdAt: "2026-07-19T12:00:00.000Z",
            updatedAt: "2026-07-19T13:00:00.000Z",
            orchestrationStatus: "idle",
          },
        }),
        thread("stopped", "one", {
          session: {
            provider: "cursor",
            status: "closed",
            createdAt: "2026-07-19T12:00:00.000Z",
            updatedAt: "2026-07-19T13:00:00.000Z",
            orchestrationStatus: "stopped",
          },
        }),
        thread("starting", "one", {
          session: {
            provider: "claudeAgent",
            status: "connecting",
            createdAt: "2026-07-19T12:00:00.000Z",
            updatedAt: "2026-07-19T13:00:00.000Z",
            orchestrationStatus: "starting",
          },
        }),
      ],
    });

    expect(cards[0]?.providers).toEqual(["claudeAgent"]);
  });

  it("surfaces child-only live activity and providers without treating it as recent chat history", () => {
    const child = thread("active-child", "one", {
      parentThreadId: threadId("parent-not-loaded"),
      subagentAgentId: "agent-child",
      hasLiveTailWork: true,
      associatedWorktreePath: "C:\\code\\one-worktree",
      associatedWorktreeBranch: "feature/child",
      updatedAt: "2026-07-20T12:01:00.000Z",
      session: {
        provider: "codex",
        status: "running",
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:01:00.000Z",
        orchestrationStatus: "running",
      },
    });
    const cards = deriveWorkspaceCards({
      projects: [project("one", "One")],
      repositoryByProjectId: new Map([[projectId("one"), gitState(0)]]),
      worktreePathPlatform: "windows",
      threads: [
        child,
        thread("archived-child", "one", {
          parentThreadId: threadId("parent-not-loaded"),
          archivedAt: "2026-07-20T12:02:00.000Z",
          hasPendingApprovals: true,
          session: {
            provider: "cursor",
            status: "running",
            createdAt: "2026-07-20T12:00:00.000Z",
            updatedAt: "2026-07-20T12:02:00.000Z",
            orchestrationStatus: "running",
          },
        }),
      ],
    });

    expect(cards[0]?.recentThread).toBeNull();
    expect(cards[0]?.activity).toMatchObject({
      threadId: child.id,
      label: "Working",
      pulse: true,
    });
    expect(cards[0]?.providers).toEqual(["codex"]);
    expect(cards[0]?.recentAt).toBe("2026-07-20T12:01:00.000Z");
    expect(cards[0]?.worktrees).toEqual([
      {
        path: "C:\\code\\one-worktree",
        branch: "feature/child",
        threadId: child.id,
        threadTitle: child.title,
      },
    ]);
    expect(filterAndSortWorkspaceCards(cards, "active", "recent")).toHaveLength(1);
  });

  it("compares worktree paths using the server filesystem platform", () => {
    const threads = [
      thread("older", "one", {
        associatedWorktreePath: "/work/Repo",
        updatedAt: "2026-07-20T12:00:00.000Z",
      }),
      thread("newer", "one", {
        associatedWorktreePath: "/work/repo",
        updatedAt: "2026-07-20T13:00:00.000Z",
      }),
    ];
    const sharedInput = {
      projects: [project("one", "One")],
      repositoryByProjectId: new Map([[projectId("one"), gitState(0)]]),
      threads,
    };

    const posixCards = deriveWorkspaceCards({
      ...sharedInput,
      worktreePathPlatform: "posix",
    });
    const windowsCards = deriveWorkspaceCards({
      ...sharedInput,
      worktreePathPlatform: "windows",
      threads: [
        thread("older", "one", {
          associatedWorktreePath: "C:\\work\\Repo",
          updatedAt: "2026-07-20T12:00:00.000Z",
        }),
        thread("newer", "one", {
          associatedWorktreePath: "c:/work/repo",
          updatedAt: "2026-07-20T13:00:00.000Z",
        }),
      ],
    });

    expect(posixCards[0]?.worktrees.map((worktree) => worktree.path)).toEqual([
      "/work/repo",
      "/work/Repo",
    ]);
    expect(windowsCards[0]?.worktrees).toHaveLength(1);
    expect(windowsCards[0]?.worktrees[0]?.threadId).toBe(threadId("newer"));
  });

  it("filters dashboard categories and sorts by dirty count or name", () => {
    const repositories = new Map<ProjectId, WorkspaceRepositoryState>([
      [projectId("a"), gitState(1, true)],
      [projectId("b"), gitState(5)],
    ]);
    const cards = deriveWorkspaceCards({
      projects: [project("a", "Zulu"), project("b", "Alpha")],
      repositoryByProjectId: repositories,
      worktreePathPlatform: "windows",
      threads: [thread("active", "a", { hasLiveTailWork: true })],
    });

    expect(
      filterAndSortWorkspaceCards(cards, "active", "recent").map((card) => card.project.id),
    ).toEqual([projectId("a")]);
    expect(filterAndSortWorkspaceCards(cards, "unpushed", "recent")).toHaveLength(1);
    expect(filterAndSortWorkspaceCards(cards, "dirty", "recent")).toHaveLength(2);
    expect(
      filterAndSortWorkspaceCards(cards, "all", "dirty").map((card) => card.project.id),
    ).toEqual([projectId("b"), projectId("a")]);
    expect(
      filterAndSortWorkspaceCards(cards, "all", "name").map((card) => card.project.name),
    ).toEqual(["Alpha", "Zulu"]);
  });

  it("preserves store order only for Manual and orders pinned projects first", () => {
    const cards = deriveWorkspaceCards({
      projects: [project("a", "Zulu"), project("b", "Alpha")],
      repositoryByProjectId: new Map([
        [projectId("a"), gitState(0)],
        [projectId("b"), gitState(0)],
      ]),
      worktreePathPlatform: "windows",
      threads: [],
    });
    const manual = filterAndSortWorkspaceCards(cards, "all", "manual");

    expect(manual.map((card) => card.project.id)).toEqual([projectId("a"), projectId("b")]);
    expect(canDragWorkspaceCards("manual")).toBe(true);
    expect(canDragWorkspaceCards("recent")).toBe(false);
    expect(canDragWorkspaceCard("manual", false)).toBe(true);
    expect(canDragWorkspaceCard("manual", true)).toBe(false);
    expect(
      orderWorkspaceCardsPinnedFirst(manual, [projectId("b")]).map((card) => card.project.id),
    ).toEqual([projectId("b"), projectId("a")]);
  });

  it("surfaces the latest automation and lets active automation affect activity filtering", () => {
    const cards = deriveWorkspaceCards({
      projects: [project("one", "One")],
      repositoryByProjectId: new Map([[projectId("one"), gitState(0)]]),
      worktreePathPlatform: "windows",
      threads: [],
      automationRuns: [
        {
          id: "run-1",
          projectId: projectId("one"),
          threadId: threadId("automation-thread"),
          status: "running",
          startedAt: "2026-07-20T12:00:00.000Z",
          finishedAt: null,
          updatedAt: "2026-07-20T12:01:00.000Z",
          createdAt: "2026-07-20T12:00:00.000Z",
        },
      ],
    });

    expect(cards[0]?.automation).toMatchObject({
      label: "Automation running",
      isActive: true,
      threadId: threadId("automation-thread"),
    });
    expect(filterAndSortWorkspaceCards(cards, "active", "recent")).toHaveLength(1);
  });

  it("keeps a live automation visible when a newer run has already finished", () => {
    const cards = deriveWorkspaceCards({
      projects: [project("one", "One")],
      repositoryByProjectId: new Map([[projectId("one"), gitState(0)]]),
      worktreePathPlatform: "windows",
      threads: [],
      automationRuns: [
        {
          id: "run-active",
          projectId: projectId("one"),
          threadId: threadId("active-automation-thread"),
          status: "waiting-for-approval",
          startedAt: "2026-07-20T12:00:00.000Z",
          finishedAt: null,
          updatedAt: "2026-07-20T12:10:00.000Z",
          createdAt: "2026-07-20T12:00:00.000Z",
        },
        {
          id: "run-finished",
          projectId: projectId("one"),
          threadId: threadId("finished-automation-thread"),
          status: "succeeded",
          startedAt: "2026-07-20T12:30:00.000Z",
          finishedAt: "2026-07-20T13:00:00.000Z",
          updatedAt: "2026-07-20T13:00:00.000Z",
          createdAt: "2026-07-20T12:30:00.000Z",
        },
      ],
    });

    expect(cards[0]?.automation).toMatchObject({
      runId: "run-active",
      label: "Automation waiting for approval",
      isActive: true,
    });
    expect(cards[0]?.recentAt).toBe("2026-07-20T13:00:00.000Z");
    expect(filterAndSortWorkspaceCards(cards, "active", "recent")).toHaveLength(1);
  });
});

describe("clone validation", () => {
  it("accepts credential-free GitHub HTTPS and SSH URLs", () => {
    expect(githubRepositoryFromUrl("https://github.com/acme/synara.git")).toBe("acme/synara");
    expect(githubRepositoryFromUrl("git@github.com:acme/synara.git")).toBe("acme/synara");
    expect(githubRepositoryFromUrl("ssh://git@github.com/acme/synara.git")).toBe("acme/synara");
    expect(githubRepositoryFromUrl("ssh://git@github.com:22/acme/synara.git")).toBe("acme/synara");
    expect(githubRepositoryFromUrl("ssh://git@github.com:2222/acme/synara.git")).toBeNull();
    expect(githubRepositoryFromUrl("https://token@github.com/acme/synara.git")).toBeNull();
    expect(githubRepositoryFromUrl("https://gitlab.com/acme/synara.git")).toBeNull();
  });

  it("requires an absolute destination and derives a platform-shaped default", () => {
    expect(
      validateCloneInput({
        url: "https://github.com/acme/synara.git",
        targetPath: "relative/synara",
      }).targetPath,
    ).toMatch(/absolute/);
    expect(defaultCloneTarget("C:\\Users\\Ada", "https://github.com/acme/synara.git")).toBe(
      "C:\\Users\\Ada\\synara",
    );
    expect(
      validateCloneInput({
        url: "ssh://git@github.com/acme/synara.git",
        targetPath: "~/projects/synara",
      }),
    ).toEqual({ url: null, targetPath: null });
    expect(
      validateCloneInput({
        url: "https://github.com/acme/synara.git",
        targetPath: "~other/projects/synara",
      }).targetPath,
    ).toMatch(/absolute/);
  });
});
