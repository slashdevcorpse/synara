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
  gitInit: vi.fn(),
  gitItems: [] as WorkspaceGitStateItem[],
  listArchivedProjects: vi.fn(),
  listGitStates: vi.fn(),
  navigate: vi.fn(),
  projects: [] as Project[],
  reorderProjects: vi.fn(),
  syncServerShellSnapshot: vi.fn(),
  threads: [] as SidebarThreadSummary[],
  threadsHydrated: true,
  toastAdd: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock("~/components/SidebarHeaderNavigationControls", () => ({
  SidebarHeaderNavigationControls: () => null,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.toastAdd },
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
    git: { init: mocks.gitInit },
    orchestration: { dispatchCommand: mocks.dispatchCommand },
    workspace: {
      listArchivedProjects: mocks.listArchivedProjects,
      listGitStates: mocks.listGitStates,
    },
  }),
  readNativeApi: () => ({
    automation: { list: mocks.automationList },
    dialogs: { confirm: mocks.confirm },
    git: { init: mocks.gitInit },
    orchestration: { dispatchCommand: mocks.dispatchCommand },
    workspace: {
      listArchivedProjects: mocks.listArchivedProjects,
      listGitStates: mocks.listGitStates,
    },
  }),
}));

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
import { usePinnedProjectsStore } from "~/pinnedProjectsStore";

const refreshedAt = "2026-07-20T12:00:00.000Z";

function project(id: string, name: string, serverSequence = 1): Project {
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
    serverSequence,
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

function notGitState(projectId: ProjectId): WorkspaceGitStateItem {
  return {
    _tag: "not-git",
    projectId,
    workspaceRoot: `C:\\code\\${projectId}`,
    refreshedAt,
    errors: { local: null, remote: null },
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
    runtimeMode: "full-access",
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

function dashboardView(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceDashboardRoute />
    </QueryClientProvider>
  );
}

async function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const mounted = await render(dashboardView(queryClient));
  return {
    queryClient,
    rerender: () => mounted.rerender(dashboardView(queryClient)),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  sessionStorage.clear();
  usePinnedProjectsStore.persist.clearStorage();
  usePinnedProjectsStore.setState({
    pinnedProjectIds: [],
    optimisticPinnedStateByProjectId: new Map(),
    latestPinnedMutationVersionByProjectId: new Map(),
    projectPinLifecycleByProjectId: new Map(),
    observedProjectPinStateByProjectId: new Map(),
  });
  mocks.projects = [];
  mocks.gitItems = [];
  mocks.threads = [];
  mocks.threadsHydrated = true;
  mocks.listGitStates.mockReset();
  mocks.listArchivedProjects.mockReset();
  mocks.confirm.mockReset();
  mocks.dispatchCommand.mockReset();
  mocks.gitInit.mockReset();
  mocks.automationList.mockReset();
  mocks.toastAdd.mockReset();
  mocks.automationList.mockResolvedValue({ definitions: [], runs: [] });
  mocks.listArchivedProjects.mockResolvedValue({ projects: [] });
  mocks.confirm.mockResolvedValue(true);
  mocks.dispatchCommand.mockResolvedValue({ sequence: 1 });
  mocks.gitInit.mockResolvedValue(undefined);
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
    const persistedProject = project("persisted-project", "Persisted project");
    mocks.threadsHydrated = false;
    mocks.projects = [persistedProject];
    mocks.gitItems = [notGitState(persistedProject.id)];
    usePinnedProjectsStore.setState({ pinnedProjectIds: [persistedProject.id] });

    await renderDashboard();

    await expect.element(page.getByText(persistedProject.name)).toBeVisible();
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([persistedProject.id]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
  });

  it("does not prune persisted pins from a hydrated empty startup snapshot", async () => {
    const persistedProjectId = "persisted-project" as ProjectId;
    usePinnedProjectsStore.setState({ pinnedProjectIds: [persistedProjectId] });

    await renderDashboard();

    await expect.element(page.getByText("Build your workspace")).toBeVisible();
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([persistedProjectId]);
  });

  it("prunes missing persisted pins and appends server-only pins after hydration", async () => {
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
    usePinnedProjectsStore.setState({
      pinnedProjectIds: [unpinnedProject.id, "removed-project" as ProjectId],
    });

    await renderDashboard();

    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([
        unpinnedProject.id,
        pinnedProject.id,
      ]);
    });
  });

  it("keeps an optimistic pin through an unrelated stale project update until settlement", async () => {
    const pinTarget = project("pin-target", "Pin target");
    const unrelatedProject = project("pin-unrelated", "Pin unrelated");
    mocks.projects = [pinTarget, unrelatedProject];
    mocks.gitItems = [
      gitState({ projectId: pinTarget.id, dirtyFileCount: 0 }),
      gitState({ projectId: unrelatedProject.id, dirtyFileCount: 0 }),
    ];
    const dispatch = deferred<{ sequence: number }>();
    mocks.dispatchCommand.mockImplementationOnce(() => dispatch.promise);

    const dashboard = await renderDashboard();
    await expect.element(page.getByRole("button", { name: "Pin Pin target" })).toBeVisible();
    await page.getByRole("button", { name: "Pin Pin target" }).click();

    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([pinTarget.id]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[pinTarget.id, true]]),
      );
    });

    mocks.projects = [pinTarget, { ...unrelatedProject, updatedAt: "2026-07-20T12:05:00.000Z" }];
    await dashboard.rerender();

    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([pinTarget.id]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[pinTarget.id, true]]),
      );
    });
    await expect.element(page.getByRole("button", { name: "Unpin Pin target" })).toBeVisible();

    mocks.projects = [{ ...pinTarget, isPinned: true, serverSequence: 2 }, unrelatedProject];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([pinTarget.id]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[pinTarget.id, true]]),
      );
    });

    dispatch.resolve({ sequence: 2 });
    await dispatch.promise;
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
    });
  });

  it("adopts a newer pin observation before the deferred pin command rejects", async () => {
    const target = project("observed-before-rejection", "Observed before rejection", 10);
    mocks.projects = [target];
    mocks.gitItems = [gitState({ projectId: target.id, dirtyFileCount: 0 })];
    const dispatch = deferred<{ sequence: number }>();
    mocks.dispatchCommand.mockImplementationOnce(() => dispatch.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const dashboard = await renderDashboard();
    await page.getByRole("button", { name: "Pin Observed before rejection" }).click();
    await expect
      .element(page.getByRole("button", { name: "Unpin Observed before rejection" }))
      .toBeVisible();

    mocks.projects = [{ ...target, isPinned: true, serverSequence: 11 }];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(
        usePinnedProjectsStore.getState().projectPinLifecycleByProjectId.get(target.id),
      ).toEqual(
        expect.objectContaining({
          appliedPinned: true,
          appliedSequence: 11,
          inFlightRequestVersion: 1,
          latestSettled: false,
        }),
      );
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[target.id, true]]),
      );
    });

    dispatch.reject(new Error("pin failed after observation"));
    await dispatch.promise.catch(() => undefined);
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([target.id]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
      expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId).toEqual(new Map());
    });
    expect(mocks.toastAdd).not.toHaveBeenCalled();

    mocks.projects = [{ ...target, isPinned: false, serverSequence: 10 }];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([target.id]);
      expect(
        usePinnedProjectsStore.getState().observedProjectPinStateByProjectId.get(target.id),
      ).toEqual({ id: target.id, isPinned: true, serverSequence: 11 });
    });
    await expect
      .element(page.getByRole("button", { name: "Unpin Observed before rejection" }))
      .toBeVisible();
    consoleError.mockRestore();
  });

  it("dispatches a queued unpin after a newer observation and deferred pin rejection", async () => {
    const target = project("queued-unpin-after-rejection", "Queued unpin after rejection", 10);
    mocks.projects = [target];
    mocks.gitItems = [gitState({ projectId: target.id, dirtyFileCount: 0 })];
    const firstDispatch = deferred<{ sequence: number }>();
    const secondDispatch = deferred<{ sequence: number }>();
    mocks.dispatchCommand
      .mockImplementationOnce(() => firstDispatch.promise)
      .mockImplementationOnce(() => secondDispatch.promise);

    const dashboard = await renderDashboard();
    await page.getByRole("button", { name: "Pin Queued unpin after rejection" }).click();
    await expect
      .element(page.getByRole("button", { name: "Unpin Queued unpin after rejection" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Unpin Queued unpin after rejection" }).click();

    mocks.projects = [{ ...target, isPinned: true, serverSequence: 11 }];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(
        usePinnedProjectsStore.getState().projectPinLifecycleByProjectId.get(target.id),
      ).toEqual(
        expect.objectContaining({
          appliedPinned: true,
          appliedSequence: 11,
          desiredPinned: false,
          inFlightRequestVersion: 1,
        }),
      );
    });

    firstDispatch.reject(new Error("superseded pin failed"));
    await firstDispatch.promise.catch(() => undefined);
    await vi.waitFor(() => expect(mocks.dispatchCommand).toHaveBeenCalledTimes(2));
    expect(mocks.dispatchCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId: target.id,
        isPinned: false,
      }),
    );
    expect(mocks.toastAdd).not.toHaveBeenCalled();
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[target.id, false]]),
    );

    secondDispatch.resolve({ sequence: 12 });
    await secondDispatch.promise;
    mocks.projects = [{ ...target, isPinned: false, serverSequence: 12 }];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
      expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId).toEqual(new Map());
    });
    await expect
      .element(page.getByRole("button", { name: "Pin Queued unpin after rejection" }))
      .toBeVisible();
  });

  it("keeps a newer conflicting observation when an older deferred pin succeeds", async () => {
    const target = project("observation-before-success", "Observation before success", 10);
    mocks.projects = [target];
    mocks.gitItems = [gitState({ projectId: target.id, dirtyFileCount: 0 })];
    const dispatch = deferred<{ sequence: number }>();
    mocks.dispatchCommand.mockImplementationOnce(() => dispatch.promise);

    const dashboard = await renderDashboard();
    await page.getByRole("button", { name: "Pin Observation before success" }).click();
    await expect
      .element(page.getByRole("button", { name: "Unpin Observation before success" }))
      .toBeVisible();

    mocks.projects = [{ ...target, isPinned: false, serverSequence: 12 }];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(
        usePinnedProjectsStore.getState().projectPinLifecycleByProjectId.get(target.id),
      ).toEqual(
        expect.objectContaining({
          appliedPinned: false,
          appliedSequence: 12,
          desiredPinned: true,
          inFlightRequestVersion: 1,
        }),
      );
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[target.id, true]]),
      );
    });

    dispatch.resolve({ sequence: 11 });
    await dispatch.promise;
    await vi.waitFor(() => {
      expect(mocks.dispatchCommand).toHaveBeenCalledTimes(1);
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
      expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId).toEqual(new Map());
      expect(
        usePinnedProjectsStore.getState().observedProjectPinStateByProjectId.get(target.id),
      ).toEqual({ id: target.id, isPinned: false, serverSequence: 12 });
    });
    expect(mocks.toastAdd).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Pin Observation before success" }))
      .toBeVisible();
  });

  it("keeps an optimistic unpin through an unrelated stale project update until settlement", async () => {
    const unpinTarget = { ...project("unpin-target", "Unpin target"), isPinned: true };
    const unrelatedProject = project("unpin-unrelated", "Unpin unrelated");
    mocks.projects = [unpinTarget, unrelatedProject];
    mocks.gitItems = [
      gitState({ projectId: unpinTarget.id, dirtyFileCount: 0 }),
      gitState({ projectId: unrelatedProject.id, dirtyFileCount: 0 }),
    ];
    const dispatch = deferred<{ sequence: number }>();
    mocks.dispatchCommand.mockImplementationOnce(() => dispatch.promise);

    const dashboard = await renderDashboard();
    await expect.element(page.getByRole("button", { name: "Unpin Unpin target" })).toBeVisible();
    await page.getByRole("button", { name: "Unpin Unpin target" }).click();

    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[unpinTarget.id, false]]),
      );
    });

    mocks.projects = [unpinTarget, { ...unrelatedProject, updatedAt: "2026-07-20T12:05:00.000Z" }];
    await dashboard.rerender();

    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[unpinTarget.id, false]]),
      );
    });
    await expect.element(page.getByRole("button", { name: "Pin Unpin target" })).toBeVisible();

    mocks.projects = [{ ...unpinTarget, isPinned: false, serverSequence: 3 }, unrelatedProject];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[unpinTarget.id, false]]),
      );
    });

    dispatch.resolve({ sequence: 3 });
    await dispatch.promise;
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
    });
  });

  it("keeps the latest rapid unpin through a stale match and delayed pin confirmation", async () => {
    const target = project("rapid-unpin", "Rapid unpin", 10);
    mocks.projects = [target];
    mocks.gitItems = [gitState({ projectId: target.id, dirtyFileCount: 0 })];
    const firstDispatch = deferred<{ sequence: number }>();
    const secondDispatch = deferred<{ sequence: number }>();
    mocks.dispatchCommand
      .mockImplementationOnce(() => firstDispatch.promise)
      .mockImplementationOnce(() => secondDispatch.promise);

    const dashboard = await renderDashboard();
    await page.getByRole("button", { name: "Pin Rapid unpin" }).click();
    await expect.element(page.getByRole("button", { name: "Unpin Rapid unpin" })).toBeVisible();
    await page.getByRole("button", { name: "Unpin Rapid unpin" }).click();

    mocks.projects = [{ ...target, updatedAt: "2026-07-20T12:01:00.000Z" }];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(mocks.dispatchCommand).toHaveBeenCalledTimes(1);
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[target.id, false]]),
      );
    });

    firstDispatch.resolve({ sequence: 11 });
    await vi.waitFor(() => expect(mocks.dispatchCommand).toHaveBeenCalledTimes(2));
    mocks.projects = [{ ...target, isPinned: true, serverSequence: 11 }];
    await dashboard.rerender();
    await expect.element(page.getByRole("button", { name: "Pin Rapid unpin" })).toBeVisible();
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[target.id, false]]),
    );

    secondDispatch.resolve({ sequence: 12 });
    await secondDispatch.promise;
    mocks.projects = [{ ...target, isPinned: false, serverSequence: 12 }];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
    });
  });

  it("rolls a failed rapid unpin back to the preceding successful pin", async () => {
    const target = project("failed-rapid-unpin", "Failed rapid unpin", 20);
    mocks.projects = [target];
    mocks.gitItems = [gitState({ projectId: target.id, dirtyFileCount: 0 })];
    const firstDispatch = deferred<{ sequence: number }>();
    const secondDispatch = deferred<{ sequence: number }>();
    mocks.dispatchCommand
      .mockImplementationOnce(() => firstDispatch.promise)
      .mockImplementationOnce(() => secondDispatch.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const dashboard = await renderDashboard();
    await page.getByRole("button", { name: "Pin Failed rapid unpin" }).click();
    await expect
      .element(page.getByRole("button", { name: "Unpin Failed rapid unpin" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Unpin Failed rapid unpin" }).click();

    firstDispatch.resolve({ sequence: 21 });
    await vi.waitFor(() => expect(mocks.dispatchCommand).toHaveBeenCalledTimes(2));
    secondDispatch.reject(new Error("unpin failed"));
    await secondDispatch.promise.catch(() => undefined);

    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([target.id]);
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
        new Map([[target.id, true]]),
      );
      expect(mocks.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Unable to unpin project" }),
      );
    });
    await expect
      .element(page.getByRole("button", { name: "Unpin Failed rapid unpin" }))
      .toBeVisible();

    mocks.projects = [{ ...target, isPinned: true, serverSequence: 21 }];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
    });
    consoleError.mockRestore();
  });

  it("coalesces pin then unpin then pin while the first command is pending", async () => {
    const target = project("coalesced-pin", "Coalesced pin", 30);
    mocks.projects = [target];
    mocks.gitItems = [gitState({ projectId: target.id, dirtyFileCount: 0 })];
    const dispatch = deferred<{ sequence: number }>();
    mocks.dispatchCommand.mockImplementationOnce(() => dispatch.promise);

    const dashboard = await renderDashboard();
    await page.getByRole("button", { name: "Pin Coalesced pin" }).click();
    await expect.element(page.getByRole("button", { name: "Unpin Coalesced pin" })).toBeVisible();
    await page.getByRole("button", { name: "Unpin Coalesced pin" }).click();
    await expect.element(page.getByRole("button", { name: "Pin Coalesced pin" })).toBeVisible();
    await page.getByRole("button", { name: "Pin Coalesced pin" }).click();

    expect(mocks.dispatchCommand).toHaveBeenCalledTimes(1);
    dispatch.resolve({ sequence: 31 });
    await dispatch.promise;
    await vi.waitFor(() => expect(mocks.dispatchCommand).toHaveBeenCalledTimes(1));

    mocks.projects = [{ ...target, isPinned: true, serverSequence: 31 }];
    await dashboard.rerender();
    await vi.waitFor(() => {
      expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
      expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([target.id]);
    });
    await expect.element(page.getByRole("button", { name: "Unpin Coalesced pin" })).toBeVisible();
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

  it("shows Git initialization success only after status refresh succeeds", async () => {
    const uninitialized = project("initialize-success", "Initialize success");
    mocks.projects = [uninitialized];
    mocks.gitItems = [notGitState(uninitialized.id)];
    await renderDashboard();

    await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
    mocks.gitItems = [gitState({ projectId: uninitialized.id, dirtyFileCount: 0 })];
    await page.getByRole("button", { name: "Initialize Git" }).click();

    await vi.waitFor(() => {
      expect(mocks.gitInit).toHaveBeenCalledWith({ cwd: uninitialized.cwd });
      expect(mocks.listGitStates).toHaveBeenCalledWith({
        projectIds: [uninitialized.id],
        forceRefresh: true,
      });
      expect(mocks.toastAdd).toHaveBeenCalledWith({
        type: "success",
        title: "Initialized Git in Initialize success",
      });
    });
    expect(mocks.toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("reports one postcondition error when refreshed status remains not-git", async () => {
    const uninitialized = project("initialize-still-not-git", "Initialize still not Git");
    mocks.projects = [uninitialized];
    mocks.gitItems = [notGitState(uninitialized.id)];
    await renderDashboard();

    await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
    await page.getByRole("button", { name: "Initialize Git" }).click();

    await vi.waitFor(() => {
      expect(mocks.gitInit).toHaveBeenCalledWith({ cwd: uninitialized.cwd });
      expect(mocks.listGitStates).toHaveBeenCalledWith({
        projectIds: [uninitialized.id],
        forceRefresh: true,
      });
      expect(mocks.toastAdd).toHaveBeenCalledWith({
        type: "error",
        title: "Could not confirm Git initialization",
        description: "The refreshed workspace status did not report a Git repository.",
      });
    });
    expect(mocks.toastAdd).toHaveBeenCalledTimes(1);
    expect(mocks.toastAdd).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: expect.stringContaining("Initialized Git"),
      }),
    );
    expect(mocks.toastAdd).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not initialize Git" }),
    );
  });

  it("reports a status refresh failure once and suppresses Git initialization success", async () => {
    const uninitialized = project("initialize-refresh-failure", "Initialize refresh failure");
    mocks.projects = [uninitialized];
    mocks.gitItems = [notGitState(uninitialized.id)];
    await renderDashboard();

    await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
    mocks.listGitStates.mockRejectedValueOnce(new Error("Status refresh failed"));
    await page.getByRole("button", { name: "Initialize Git" }).click();

    await vi.waitFor(() => {
      expect(mocks.gitInit).toHaveBeenCalledWith({ cwd: uninitialized.cwd });
      expect(mocks.toastAdd).toHaveBeenCalledWith({
        type: "error",
        title: "Could not refresh workspace status",
        description: "Status refresh failed",
      });
    });
    expect(mocks.toastAdd).toHaveBeenCalledTimes(1);
    expect(mocks.toastAdd).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: expect.stringContaining("Initialized Git"),
      }),
    );
    expect(mocks.toastAdd).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not initialize Git" }),
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
