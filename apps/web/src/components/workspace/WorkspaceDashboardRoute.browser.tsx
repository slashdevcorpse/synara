// FILE: WorkspaceDashboardRoute.browser.tsx
// Purpose: Browser coverage for the mocked workspace dashboard route states.
// Layer: Browser route test

import "../../index.css";

import type {
  OrchestrationArchivedProjectSummary,
  ProjectId,
  ThreadId,
  WorkspaceGitStateItem,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import type { Project, SidebarThreadSummary } from "~/types";

const mocks = vi.hoisted(() => ({
  automationList: vi.fn(),
  confirm: vi.fn(),
  dispatchCommand: vi.fn(),
  gitItems: [] as WorkspaceGitStateItem[],
  listArchivedProjects: vi.fn(),
  listGitStates: vi.fn(),
  navigate: vi.fn(),
  pinProject: vi.fn(() => true),
  projects: [] as Project[],
  prunePinnedProjects: vi.fn(),
  reorderProjects: vi.fn(),
  syncServerShellSnapshot: vi.fn(),
  threads: [] as SidebarThreadSummary[],
  threadsHydrated: true,
  unpinProject: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock("~/components/SidebarHeaderNavigationControls", () => ({
  SidebarHeaderNavigationControls: () => null,
}));

vi.mock("~/components/workspace/WorkspaceProjectDialogs", () => ({
  AddExistingProjectDialog: () => null,
  CloneRepositoryDialog: () => null,
  hasRestorableWorkspaceClone: () => false,
}));

vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarTrafficLightGutterClassName: () => "",
  useDesktopTopBarWindowControlsGutterClassName: () => "",
}));

vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: vi.fn() }),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    automation: { list: mocks.automationList },
    dialogs: { confirm: mocks.confirm },
    orchestration: { dispatchCommand: mocks.dispatchCommand },
    workspace: {
      listArchivedProjects: mocks.listArchivedProjects,
      listGitStates: mocks.listGitStates,
    },
  }),
}));

vi.mock("~/pinnedProjectsStore", () => {
  const state = {
    pinnedProjectIds: [] as ProjectId[],
    pinProject: mocks.pinProject,
    unpinProject: mocks.unpinProject,
    prunePinnedProjects: mocks.prunePinnedProjects,
  };
  const usePinnedProjectsStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { usePinnedProjectsStore };
});

vi.mock("~/store", () => ({
  useStore: (
    selector: (state: {
      projects: Project[];
      reorderProjects: typeof mocks.reorderProjects;
      syncServerShellSnapshot: typeof mocks.syncServerShellSnapshot;
      threadsHydrated: boolean;
    }) => unknown,
  ) =>
    selector({
      projects: mocks.projects,
      reorderProjects: mocks.reorderProjects,
      syncServerShellSnapshot: mocks.syncServerShellSnapshot,
      threadsHydrated: mocks.threadsHydrated,
    }),
}));

vi.mock("~/storeSelectors", () => ({
  createSidebarThreadSummariesSelector: () => () => mocks.threads,
}));

vi.mock("~/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: { homeDir: string }) => unknown) =>
    selector({ homeDir: "C:\\Users\\Ada" }),
}));

import { WorkspaceDashboardRoute } from "~/routes/_chat.workspace.index";

const refreshedAt = "2026-07-20T12:00:00.000Z";

function project(id: string, name: string): Project {
  return {
    id: id as ProjectId,
    kind: "project",
    name,
    remoteName: name,
    folderName: name,
    localName: null,
    cwd: `C:\\code\\${id}`,
    defaultModelSelection: null,
    expanded: true,
    createdAt: refreshedAt,
    updatedAt: refreshedAt,
    scripts: [],
  };
}

function gitState(input: {
  projectId: ProjectId;
  dirtyFileCount: number;
  remoteError?: string;
}): WorkspaceGitStateItem {
  return {
    _tag: "git",
    projectId: input.projectId,
    workspaceRoot: `C:\\code\\${input.projectId}`,
    refreshedAt,
    errors: {
      local: null,
      remote: input.remoteError
        ? { code: "github-auth", message: input.remoteError, retryable: true }
        : null,
    },
    remoteUrl: input.remoteError ? null : `https://github.com/acme/${input.projectId}.git`,
    remoteName: input.remoteError ? null : "origin",
    branch: "main",
    headState: "branch",
    dirty: input.dirtyFileCount > 0,
    dirtyFileCount: input.dirtyFileCount,
    upstream: input.remoteError ? null : "origin/main",
    ahead: 0,
    behind: 0,
    hasCommits: true,
    hasUnpushedCommits: false,
    linkedPullRequest: null,
  };
}

function archivedProject(
  overrides: Partial<OrchestrationArchivedProjectSummary> = {},
): OrchestrationArchivedProjectSummary {
  return {
    id: "archived-project" as ProjectId,
    kind: "project",
    title: "Archived project",
    workspaceRoot: "C:\\code\\archived-project",
    archivedAt: "2026-07-19T12:00:00.000Z",
    threadCount: 3,
    latestThread: {
      id: "latest-thread" as ThreadId,
      title: "Latest preserved chat",
      updatedAt: "2026-07-19T11:00:00.000Z",
    },
    ...overrides,
  };
}

function activeChildThread(projectId: ProjectId): SidebarThreadSummary {
  return {
    id: "active-child" as ThreadId,
    projectId,
    title: "Active child",
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: "feature/child",
    worktreePath: null,
    associatedWorktreePath: "C:\\code\\child-worktree",
    associatedWorktreeBranch: "feature/child",
    session: {
      provider: "codex",
      status: "running",
      createdAt: refreshedAt,
      updatedAt: refreshedAt,
      orchestrationStatus: "running",
    },
    createdAt: refreshedAt,
    updatedAt: refreshedAt,
    latestTurn: null,
    parentThreadId: "parent-thread" as ThreadId,
    subagentAgentId: "agent-child",
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: true,
  };
}

async function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceDashboardRoute />
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  sessionStorage.clear();
  mocks.projects = [];
  mocks.gitItems = [];
  mocks.threads = [];
  mocks.threadsHydrated = true;
  mocks.listGitStates.mockReset();
  mocks.listArchivedProjects.mockReset();
  mocks.confirm.mockReset();
  mocks.dispatchCommand.mockReset();
  mocks.automationList.mockReset();
  mocks.pinProject.mockReset();
  mocks.pinProject.mockReturnValue(true);
  mocks.prunePinnedProjects.mockReset();
  mocks.unpinProject.mockReset();
  mocks.automationList.mockResolvedValue({ definitions: [], runs: [] });
  mocks.listArchivedProjects.mockResolvedValue({ projects: [] });
  mocks.confirm.mockResolvedValue(true);
  mocks.dispatchCommand.mockResolvedValue({ sequence: 1 });
  mocks.listGitStates.mockImplementation(({ projectIds }: { projectIds: ProjectId[] }) =>
    Promise.resolve({
      items: mocks.gitItems.filter((item) => projectIds.includes(item.projectId)),
    }),
  );
});

afterEach(async () => {
  await cleanup();
  sessionStorage.clear();
});

describe("WorkspaceDashboardRoute", () => {
  it("does not prune persisted pins before the shell snapshot hydrates", async () => {
    mocks.threadsHydrated = false;

    await renderDashboard();

    await expect.element(page.getByText("Build your workspace")).toBeVisible();
    expect(mocks.prunePinnedProjects).not.toHaveBeenCalled();
  });

  it("does not prune persisted pins from a hydrated empty startup snapshot", async () => {
    await renderDashboard();

    await expect.element(page.getByText("Build your workspace")).toBeVisible();
    expect(mocks.prunePinnedProjects).not.toHaveBeenCalled();
  });

  it("reconciles persisted pins after the shell snapshot hydrates", async () => {
    const pinnedProject = {
      ...project("pinned-project", "Pinned project"),
      isPinned: true,
    };
    const unpinnedProject = project("unpinned-project", "Unpinned project");
    mocks.projects = [pinnedProject, unpinnedProject];
    mocks.gitItems = [
      gitState({ projectId: pinnedProject.id, dirtyFileCount: 0 }),
      gitState({ projectId: unpinnedProject.id, dirtyFileCount: 0 }),
    ];

    await renderDashboard();

    await vi.waitFor(() => {
      expect(mocks.prunePinnedProjects).toHaveBeenCalledWith([
        pinnedProject.id,
        unpinnedProject.id,
      ]);
      expect(mocks.pinProject).toHaveBeenCalledWith(pinnedProject.id);
      expect(mocks.unpinProject).toHaveBeenCalledWith(unpinnedProject.id);
    });
  });

  it("renders project cards while the batched repository status request is still pending", async () => {
    const pendingProject = project("pending-status", "Pending status");
    let resolveGitStates: ((value: { items: WorkspaceGitStateItem[] }) => void) | undefined;
    mocks.projects = [pendingProject];
    mocks.gitItems = [gitState({ projectId: pendingProject.id, dirtyFileCount: 0 })];
    mocks.listGitStates.mockImplementationOnce(
      () =>
        new Promise<{ items: WorkspaceGitStateItem[] }>((resolve) => {
          resolveGitStates = resolve;
        }),
    );

    await renderDashboard();

    await expect.element(page.getByRole("button", { name: "Open Pending status" })).toBeVisible();
    await expect.element(page.getByText("Loading status…")).toBeVisible();
    expect(document.body.textContent).not.toContain("Status unavailable");
    expect(document.body.textContent).not.toContain("Retry");
    expect(resolveGitStates).toEqual(expect.any(Function));

    resolveGitStates?.({ items: mocks.gitItems });
    await expect.element(page.getByText("Clean")).toBeVisible();
  });

  it("keeps project cards and retries per-card after a workspace transport failure", async () => {
    const disconnectedProject = project("transport-failure", "Transport failure");
    mocks.projects = [disconnectedProject];
    mocks.gitItems = [gitState({ projectId: disconnectedProject.id, dirtyFileCount: 0 })];
    mocks.listGitStates.mockRejectedValueOnce(new Error("Workspace transport disconnected."));

    await renderDashboard();

    await expect
      .element(page.getByRole("button", { name: "Open Transport failure" }))
      .toBeVisible();
    await expect.element(page.getByText("Status unavailable")).toBeVisible();
    expect(document.body.textContent).not.toContain("Workspace status is unavailable");

    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.element(page.getByText("Clean")).toBeVisible();
    expect(mocks.listGitStates).toHaveBeenLastCalledWith({
      projectIds: [disconnectedProject.id],
      forceRefresh: true,
    });
  });

  it("renders repository status cards and filters them by dirty state", async () => {
    const dirtyProject = project("dirty-project", "Dirty project");
    const remoteErrorProject = project("remote-error-project", "Remote error project");
    mocks.projects = [dirtyProject, remoteErrorProject];
    mocks.gitItems = [
      gitState({ projectId: dirtyProject.id, dirtyFileCount: 3 }),
      gitState({
        projectId: remoteErrorProject.id,
        dirtyFileCount: 0,
        remoteError: "GitHub CLI authentication is required.",
      }),
    ];
    await renderDashboard();

    await expect.element(page.getByRole("button", { name: "Open Dirty project" })).toBeVisible();
    await expect.element(page.getByText("3 dirty")).toBeVisible();
    await expect.element(page.getByText("PR status unavailable")).toBeVisible();

    await page.getByRole("button", { name: "Dirty", exact: true }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Open Dirty project"]')).not.toBeNull();
      expect(document.querySelector('[aria-label="Open Remote error project"]')).toBeNull();
    });
  });

  it("renders the project-free workspace state", async () => {
    await renderDashboard();

    await expect.element(page.getByText("Build your workspace")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add existing" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Clone repository" })).toBeVisible();
    expect(mocks.listGitStates).not.toHaveBeenCalled();
  });

  it("renders child-only live agent activity without promoting it to recent chat history", async () => {
    const activeProject = project("child-project", "Child project");
    mocks.projects = [activeProject];
    mocks.gitItems = [gitState({ projectId: activeProject.id, dirtyFileCount: 0 })];
    mocks.threads = [activeChildThread(activeProject.id)];
    await renderDashboard();

    await expect.element(page.getByRole("button", { name: "Working" })).toBeVisible();
    await expect.element(page.getByText("No recent chats")).toBeVisible();
    expect(
      document.querySelector('[aria-label="Active providers"] [title="Codex"]'),
    ).not.toBeNull();
  });

  it("refreshes only the selected project from a card action", async () => {
    const first = project("first-project", "First project");
    const second = project("second-project", "Second project");
    mocks.projects = [first, second];
    mocks.gitItems = [
      gitState({ projectId: first.id, dirtyFileCount: 0 }),
      gitState({ projectId: second.id, dirtyFileCount: 0 }),
    ];
    await renderDashboard();

    await expect.element(page.getByRole("button", { name: "Open First project" })).toBeVisible();
    await page.getByRole("button", { name: "Project actions for First project" }).click();
    await page.getByRole("menuitem", { name: "Refresh status" }).click();

    await vi.waitFor(() => {
      expect(mocks.listGitStates).toHaveBeenCalledWith({
        projectIds: [first.id],
        forceRefresh: true,
      });
    });
    expect(mocks.listGitStates.mock.calls.filter(([input]) => input.forceRefresh === true)).toEqual(
      [[{ projectIds: [first.id], forceRefresh: true }]],
    );
  });

  it("disables every refresh control while one project refresh is in flight", async () => {
    const first = project("guard-first", "Guard first");
    const second = project("guard-second", "Guard second");
    mocks.projects = [first, second];
    mocks.gitItems = [
      gitState({ projectId: first.id, dirtyFileCount: 0 }),
      gitState({ projectId: second.id, dirtyFileCount: 0 }),
    ];
    await renderDashboard();
    await expect.element(page.getByRole("button", { name: "Open Guard first" })).toBeVisible();

    let resolveRefresh: ((value: { items: WorkspaceGitStateItem[] }) => void) | undefined;
    mocks.listGitStates.mockImplementationOnce(
      () =>
        new Promise<{ items: WorkspaceGitStateItem[] }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    await page.getByRole("button", { name: "Project actions for Guard first" }).click();
    await page.getByRole("menuitem", { name: "Refresh status" }).click();
    await vi.waitFor(() => expect(resolveRefresh).toEqual(expect.any(Function)));

    await expect
      .element(page.getByRole("button", { name: "Refresh workspace status" }))
      .toBeDisabled();
    await page.getByRole("button", { name: "Project actions for Guard second" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Refresh status" })).toBeDisabled();

    resolveRefresh?.({ items: [gitState({ projectId: first.id, dirtyFileCount: 0 })] });
    await expect
      .element(page.getByRole("button", { name: "Refresh workspace status" }))
      .toBeEnabled();
    expect(
      mocks.listGitStates.mock.calls.filter(([input]) => input.forceRefresh === true),
    ).toHaveLength(1);
  });

  it("requires confirmation, preserves files and chats, and archives without delete semantics", async () => {
    const activeProject = project("archive-me", "Archive me");
    mocks.projects = [activeProject];
    mocks.gitItems = [gitState({ projectId: activeProject.id, dirtyFileCount: 0 })];
    await renderDashboard();

    await expect.element(page.getByRole("button", { name: "Open Archive me" })).toBeVisible();
    await page.getByRole("button", { name: "Project actions for Archive me" }).click();
    await page.getByRole("menuitem", { name: "Remove from workspace" }).click();

    await vi.waitFor(() => expect(mocks.dispatchCommand).toHaveBeenCalledOnce());
    expect(mocks.confirm).toHaveBeenCalledWith(
      "Remove Archive me from this workspace?\n\nRepository files and all chats will be preserved. You can restore this project from Archived projects.",
    );
    const command = mocks.dispatchCommand.mock.calls[0]?.[0];
    expect(command).toMatchObject({ type: "project.archive", projectId: activeProject.id });
    expect(command.commandId).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(command.createdAt))).toBe(false);
    expect(
      mocks.dispatchCommand.mock.calls.some(([entry]) => entry.type === "project.delete"),
    ).toBe(false);
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Open Archive me"]')).toBeNull();
    });
  });

  it("keeps the project visible when removal is cancelled", async () => {
    const activeProject = project("keep-me", "Keep me");
    mocks.projects = [activeProject];
    mocks.gitItems = [gitState({ projectId: activeProject.id, dirtyFileCount: 0 })];
    mocks.confirm.mockResolvedValue(false);
    await renderDashboard();

    await expect.element(page.getByRole("button", { name: "Open Keep me" })).toBeVisible();
    await page.getByRole("button", { name: "Project actions for Keep me" }).click();
    await page.getByRole("menuitem", { name: "Remove from workspace" }).click();

    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    expect(mocks.dispatchCommand).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Open Keep me" })).toBeVisible();
  });

  it("shows archive metadata and restores the same project ID with an in-flight state", async () => {
    const archived = archivedProject();
    let resolveRestore: ((value: { sequence: number }) => void) | undefined;
    mocks.listArchivedProjects.mockResolvedValue({ projects: [archived] });
    mocks.dispatchCommand.mockImplementationOnce(
      () =>
        new Promise<{ sequence: number }>((resolve) => {
          resolveRestore = resolve;
        }),
    );
    await renderDashboard();

    await page.getByRole("button", { name: "Archived projects" }).click();
    await expect.element(page.getByRole("heading", { name: "Archived projects" })).toBeVisible();
    await expect.element(page.getByText(archived.workspaceRoot)).toBeVisible();
    await expect.element(page.getByText("3 top-level chats")).toBeVisible();
    await expect.element(page.getByText("Latest preserved chat")).toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();

    await vi.waitFor(() => expect(resolveRestore).toEqual(expect.any(Function)));
    await expect.element(page.getByRole("button", { name: "Restore" })).toBeDisabled();
    const command = mocks.dispatchCommand.mock.calls[0]?.[0];
    expect(command).toMatchObject({ type: "project.unarchive", projectId: archived.id });
    expect(command.commandId).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(command.createdAt))).toBe(false);

    resolveRestore?.({ sequence: 2 });
    await expect.element(page.getByText("No archived projects")).toBeVisible();
  });

  it("shows restore failures verbatim and retries the same archived project", async () => {
    const archived = archivedProject({ id: "conflicting-project" as ProjectId });
    const failure = `Workspace root ${archived.workspaceRoot} is already used by an active project.`;
    mocks.listArchivedProjects.mockResolvedValue({ projects: [archived] });
    mocks.dispatchCommand
      .mockRejectedValueOnce(new Error(failure))
      .mockResolvedValueOnce({ sequence: 3 });
    await renderDashboard();

    await page.getByRole("button", { name: "Archived projects" }).click();
    await expect
      .element(page.getByRole("heading", { name: archived.title, exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent(failure);
    await page.getByRole("button", { name: "Retry restore" }).click();
    await expect.element(page.getByText("No archived projects")).toBeVisible();
    expect(mocks.dispatchCommand).toHaveBeenCalledTimes(2);
    for (const [command] of mocks.dispatchCommand.mock.calls) {
      expect(command).toMatchObject({ type: "project.unarchive", projectId: archived.id });
    }
  });

  it("shows archived-project loading and retries a failed listing", async () => {
    let rejectListing: ((reason?: unknown) => void) | undefined;
    mocks.listArchivedProjects.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectListing = reject;
        }),
    );
    await renderDashboard();

    await page.getByRole("button", { name: "Archived projects" }).click();
    await expect.element(page.getByLabelText("Loading archived projects")).toBeVisible();
    await vi.waitFor(() => expect(rejectListing).toEqual(expect.any(Function)));
    mocks.listArchivedProjects.mockResolvedValue({ projects: [] });
    rejectListing?.(new Error("Archive projection is temporarily unavailable."));

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Archive projection is temporarily unavailable.");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByText("No archived projects")).toBeVisible();
  });
});
