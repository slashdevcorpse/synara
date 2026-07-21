import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectId, WorkspaceListGitStatesResult } from "@synara/contracts";

const mocks = vi.hoisted(() => ({
  listGitStates: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    workspace: {
      listGitStates: mocks.listGitStates,
    },
  }),
}));

import {
  normalizeWorkspaceGitStates,
  refreshWorkspaceGitProject,
  refreshWorkspaceGitStates,
  workspaceGitStatesQueryOptions,
  workspaceQueryKeys,
} from "./workspaceReactQuery";

const projectId = (value: string) => value as ProjectId;

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function notGitResult(projectIds: readonly ProjectId[]): WorkspaceListGitStatesResult {
  return {
    items: projectIds.map((id) => ({
      _tag: "not-git" as const,
      projectId: id,
      workspaceRoot: `C:\\code\\${id}`,
      refreshedAt: "2026-07-20T12:01:00.000Z",
      errors: { local: null, remote: null },
    })),
  };
}

function unavailableResult(
  entries: readonly (readonly [ProjectId, string])[],
): WorkspaceListGitStatesResult {
  return {
    items: entries.map(([id, message]) => ({
      _tag: "unavailable" as const,
      projectId: id,
      workspaceRoot: null,
      refreshedAt: "2026-07-20T12:00:00.000Z",
      errors: {
        local: { code: "race", message, retryable: true },
        remote: null,
      },
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workspace React Query adapter", () => {
  it("keeps query keys stable across order and duplicate changes", () => {
    expect(workspaceQueryKeys.gitStates([projectId("b"), projectId("a"), projectId("a")])).toEqual(
      workspaceQueryKeys.gitStates([projectId("a"), projectId("b")]),
    );
  });

  it("matches the server's five-second status cache window", () => {
    expect(workspaceGitStatesQueryOptions({ projectIds: [projectId("a")] }).staleTime).toBe(5_000);
  });

  it("normalizes git, non-git, and partial-error items without dropping projects", () => {
    const states = normalizeWorkspaceGitStates([
      {
        _tag: "git",
        projectId: projectId("git"),
        workspaceRoot: "C:\\code\\repo",
        refreshedAt: "2026-07-20T12:00:00.000Z",
        errors: { local: null, remote: null },
        remoteUrl: "https://github.com/acme/repo.git",
        remoteName: "origin",
        branch: "main",
        headState: "branch",
        dirty: true,
        dirtyFileCount: 3,
        upstream: "origin/main",
        ahead: 2,
        behind: 1,
        hasCommits: true,
        hasUnpushedCommits: true,
        linkedPullRequest: null,
      },
      {
        _tag: "not-git",
        projectId: projectId("folder"),
        workspaceRoot: "C:\\code\\folder",
        refreshedAt: "2026-07-20T12:00:00.000Z",
        errors: { local: null, remote: null },
      },
      {
        _tag: "unavailable",
        projectId: projectId("error"),
        workspaceRoot: null,
        refreshedAt: "2026-07-20T12:00:00.000Z",
        errors: {
          local: { code: "timeout", message: "Timed out", retryable: true },
          remote: null,
        },
      },
    ]);

    expect(states.get(projectId("git"))).toMatchObject({
      kind: "git",
      headState: "branch",
      dirtyFileCount: 3,
      hasUnpushedCommits: true,
      githubErrorMessage: null,
    });
    expect(states.get(projectId("folder"))).toEqual({ kind: "not-git" });
    expect(states.get(projectId("error"))).toEqual({
      kind: "unavailable",
      message: "Timed out",
      retryable: true,
    });
  });

  it("preserves detached and unborn HEAD states for status-card rendering", () => {
    const base = {
      _tag: "git" as const,
      workspaceRoot: "C:\\code\\repo",
      refreshedAt: "2026-07-20T12:00:00.000Z",
      errors: { local: null, remote: null },
      remoteUrl: null,
      remoteName: null,
      dirty: false,
      dirtyFileCount: 0,
      upstream: null,
      ahead: 0,
      behind: 0,
      hasUnpushedCommits: false,
      linkedPullRequest: null,
    };
    const states = normalizeWorkspaceGitStates([
      {
        ...base,
        projectId: projectId("detached"),
        branch: null,
        headState: "detached",
        hasCommits: true,
      },
      {
        ...base,
        projectId: projectId("unborn"),
        branch: "main",
        headState: "unborn",
        hasCommits: false,
      },
    ]);

    expect(states.get(projectId("detached"))).toMatchObject({ headState: "detached" });
    expect(states.get(projectId("unborn"))).toMatchObject({ headState: "unborn" });
  });

  it("keeps remote lookup errors visible even when no remote URL was resolved", () => {
    const states = normalizeWorkspaceGitStates([
      {
        _tag: "git",
        projectId: projectId("remote-error"),
        workspaceRoot: "C:\\code\\repo",
        refreshedAt: "2026-07-20T12:00:00.000Z",
        errors: {
          local: null,
          remote: {
            code: "github-auth",
            message: "GitHub CLI authentication is required.",
            retryable: true,
          },
        },
        remoteUrl: null,
        remoteName: null,
        branch: "main",
        headState: "branch",
        dirty: false,
        dirtyFileCount: 0,
        upstream: null,
        ahead: 0,
        behind: 0,
        hasCommits: true,
        hasUnpushedCommits: false,
        linkedPullRequest: null,
      },
    ]);

    expect(states.get(projectId("remote-error"))).toMatchObject({
      kind: "git",
      githubStatus: "unavailable",
      githubErrorMessage: "GitHub CLI authentication is required.",
    });
  });

  it("loads more than 100 projects in sequential bounded batches and merges the results", async () => {
    const projectIds = Array.from({ length: 201 }, (_, index) => projectId(`project-${index}`));
    let activeRequests = 0;
    let maxActiveRequests = 0;
    mocks.listGitStates.mockImplementation(
      async ({ projectIds: batch }: { projectIds: ProjectId[] }) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await Promise.resolve();
        activeRequests -= 1;
        return {
          items: batch.map((id) => ({
            _tag: "not-git" as const,
            projectId: id,
            workspaceRoot: `C:\\code\\${id}`,
            refreshedAt: "2026-07-20T12:00:00.000Z",
            errors: { local: null, remote: null },
          })),
        };
      },
    );

    const states = await refreshWorkspaceGitStates({
      queryClient: new QueryClient(),
      projectIds,
    });

    expect(mocks.listGitStates).toHaveBeenCalledTimes(3);
    expect(mocks.listGitStates.mock.calls.map(([input]) => input.projectIds.length)).toEqual([
      100, 100, 1,
    ]);
    expect(mocks.listGitStates.mock.calls.every(([input]) => input.forceRefresh === true)).toBe(
      true,
    );
    expect(maxActiveRequests).toBe(1);
    expect(states.size).toBe(201);
  });

  it("keeps successful earlier batches and degrades a failed later batch per project", async () => {
    const projectIds = Array.from({ length: 101 }, (_, index) =>
      projectId(`project-${index.toString().padStart(3, "0")}`),
    );
    mocks.listGitStates
      .mockResolvedValueOnce({
        items: projectIds.slice(0, 100).map((id) => ({
          _tag: "not-git" as const,
          projectId: id,
          workspaceRoot: `C:\\code\\${id}`,
          refreshedAt: "2026-07-20T12:00:00.000Z",
          errors: { local: null, remote: null },
        })),
      })
      .mockRejectedValueOnce(new Error("Workspace transport disconnected."));

    const states = await refreshWorkspaceGitStates({
      queryClient: new QueryClient(),
      projectIds,
    });

    expect(states.get(projectIds[0]!)).toEqual({ kind: "not-git" });
    expect(states.get(projectIds[100]!)).toEqual({
      kind: "unavailable",
      message: "Workspace transport disconnected.",
      retryable: true,
    });
    expect(states.size).toBe(101);
  });

  it("cancels an older normal query before publishing a forced refresh", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const targetId = projectId("superseded");
    let resolveStale: ((value: WorkspaceListGitStatesResult) => void) | undefined;
    mocks.listGitStates
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceListGitStatesResult>((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockResolvedValueOnce({
        items: [
          {
            _tag: "not-git",
            projectId: targetId,
            workspaceRoot: "C:\\code\\superseded",
            refreshedAt: "2026-07-20T12:01:00.000Z",
            errors: { local: null, remote: null },
          },
        ],
      });

    const staleQuery = queryClient
      .fetchQuery(workspaceGitStatesQueryOptions({ projectIds: [targetId] }))
      .catch(() => undefined);
    await vi.waitFor(() => expect(resolveStale).toEqual(expect.any(Function)));

    await refreshWorkspaceGitStates({ queryClient, projectIds: [targetId] });
    resolveStale?.({
      items: [
        {
          _tag: "unavailable",
          projectId: targetId,
          workspaceRoot: null,
          refreshedAt: "2026-07-20T12:00:00.000Z",
          errors: {
            local: { code: "stale", message: "Stale result", retryable: true },
            remote: null,
          },
        },
      ],
    });
    await staleQuery;

    expect(mocks.listGitStates.mock.calls).toEqual([
      [{ projectIds: [targetId] }],
      [{ projectIds: [targetId], forceRefresh: true }],
    ]);
    expect(
      queryClient.getQueryData<ReadonlyMap<ProjectId, unknown>>(
        workspaceQueryKeys.gitStates([targetId]),
      ),
    ).toEqual(new Map([[targetId, { kind: "not-git" }]]));
  });

  it("keeps a forced card refresh when an older dashboard query resolves last", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const targetId = projectId("a-target");
    const otherId = projectId("b-other");
    const dashboardIds = [targetId, otherId];
    const dashboardQueryKey = workspaceQueryKeys.gitStates(dashboardIds);
    queryClient.setQueryData(
      dashboardQueryKey,
      new Map([
        [targetId, { kind: "unavailable" as const, message: "Old", retryable: true }],
        [otherId, { kind: "not-git" as const }],
      ]),
    );
    let resolveStale: ((value: WorkspaceListGitStatesResult) => void) | undefined;
    mocks.listGitStates
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceListGitStatesResult>((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockResolvedValueOnce({
        items: [
          {
            _tag: "not-git",
            projectId: targetId,
            workspaceRoot: "C:\\code\\a-target",
            refreshedAt: "2026-07-20T12:01:00.000Z",
            errors: { local: null, remote: null },
          },
        ],
      });

    const staleQuery = queryClient
      .fetchQuery({
        ...workspaceGitStatesQueryOptions({ projectIds: dashboardIds }),
        staleTime: 0,
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(resolveStale).toEqual(expect.any(Function)));

    await refreshWorkspaceGitProject({
      queryClient,
      dashboardProjectIds: dashboardIds,
      projectId: targetId,
    });
    resolveStale?.({
      items: dashboardIds.map((id) => ({
        _tag: "unavailable" as const,
        projectId: id,
        workspaceRoot: null,
        refreshedAt: "2026-07-20T12:00:00.000Z",
        errors: {
          local: { code: "stale", message: "Stale result", retryable: true },
          remote: null,
        },
      })),
    });
    await staleQuery;

    expect(mocks.listGitStates.mock.calls).toEqual([
      [{ projectIds: dashboardIds }],
      [{ projectIds: [targetId], forceRefresh: true }],
    ]);
    expect(queryClient.getQueryData<ReadonlyMap<ProjectId, unknown>>(dashboardQueryKey)).toEqual(
      new Map([
        [targetId, { kind: "not-git" }],
        [otherId, { kind: "not-git" }],
      ]),
    );
    expect(
      queryClient.getQueryData<ReadonlyMap<ProjectId, unknown>>(
        workspaceQueryKeys.gitStates([targetId]),
      ),
    ).toEqual(new Map([[targetId, { kind: "not-git" }]]));
  });

  it("does not launch a native request when the query signal is already aborted", async () => {
    const targetId = projectId("pre-aborted");
    const controller = new AbortController();
    controller.abort();
    const options = workspaceGitStatesQueryOptions({ projectIds: [targetId] });
    if (typeof options.queryFn !== "function")
      throw new Error("Expected a workspace query function");

    await expect(options.queryFn({ signal: controller.signal } as never)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mocks.listGitStates).not.toHaveBeenCalled();
  });

  it("keeps the newer of two forced global refreshes", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const targetId = projectId("global-race");
    const older = deferred<WorkspaceListGitStatesResult>();
    const newer = deferred<WorkspaceListGitStatesResult>();
    mocks.listGitStates
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const olderRefresh = refreshWorkspaceGitStates({ queryClient, projectIds: [targetId] });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(1));
    const newerRefresh = refreshWorkspaceGitStates({ queryClient, projectIds: [targetId] });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(2));

    newer.resolve(notGitResult([targetId]));
    await newerRefresh;
    older.resolve(unavailableResult([[targetId, "Older global result"]]));
    await olderRefresh;

    expect(
      queryClient.getQueryData<ReadonlyMap<ProjectId, unknown>>(
        workspaceQueryKeys.gitStates([targetId]),
      ),
    ).toEqual(new Map([[targetId, { kind: "not-git" }]]));
  });

  it("keeps the newer of two forced refreshes for the same card", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const targetId = projectId("card-race");
    const dashboardIds = [targetId];
    const older = deferred<WorkspaceListGitStatesResult>();
    const newer = deferred<WorkspaceListGitStatesResult>();
    mocks.listGitStates
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const olderRefresh = refreshWorkspaceGitProject({
      queryClient,
      dashboardProjectIds: dashboardIds,
      projectId: targetId,
    });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(1));
    const newerRefresh = refreshWorkspaceGitProject({
      queryClient,
      dashboardProjectIds: dashboardIds,
      projectId: targetId,
    });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(2));

    newer.resolve(notGitResult([targetId]));
    await newerRefresh;
    older.resolve(unavailableResult([[targetId, "Older card result"]]));
    await olderRefresh;

    const expected = new Map([[targetId, { kind: "not-git" }]]);
    expect(
      queryClient.getQueryData<ReadonlyMap<ProjectId, unknown>>(
        workspaceQueryKeys.gitStates([targetId]),
      ),
    ).toEqual(expected);
  });

  it("preserves a newer card result when an older global refresh resolves last", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const targetId = projectId("a-global-card-target");
    const otherId = projectId("b-global-card-other");
    const dashboardIds = [targetId, otherId];
    const dashboardQueryKey = workspaceQueryKeys.gitStates(dashboardIds);
    queryClient.setQueryData(
      dashboardQueryKey,
      new Map([
        [targetId, { kind: "unavailable" as const, message: "Initial target", retryable: true }],
        [otherId, { kind: "not-git" as const }],
      ]),
    );
    const global = deferred<WorkspaceListGitStatesResult>();
    const card = deferred<WorkspaceListGitStatesResult>();
    mocks.listGitStates
      .mockImplementationOnce(() => global.promise)
      .mockImplementationOnce(() => card.promise);

    const globalRefresh = refreshWorkspaceGitStates({ queryClient, projectIds: dashboardIds });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(1));
    const cardRefresh = refreshWorkspaceGitProject({
      queryClient,
      dashboardProjectIds: dashboardIds,
      projectId: targetId,
    });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(2));

    card.resolve(notGitResult([targetId]));
    await cardRefresh;
    global.resolve(
      unavailableResult([
        [targetId, "Older global target"],
        [otherId, "Global other result"],
      ]),
    );
    await globalRefresh;

    expect(queryClient.getQueryData<ReadonlyMap<ProjectId, unknown>>(dashboardQueryKey)).toEqual(
      new Map([
        [targetId, { kind: "not-git" }],
        [otherId, { kind: "unavailable", message: "Global other result", retryable: true }],
      ]),
    );
  });

  it("does not publish an older card result after a newer global refresh", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const targetId = projectId("a-card-global-target");
    const otherId = projectId("b-card-global-other");
    const dashboardIds = [targetId, otherId];
    const dashboardQueryKey = workspaceQueryKeys.gitStates(dashboardIds);
    const card = deferred<WorkspaceListGitStatesResult>();
    const global = deferred<WorkspaceListGitStatesResult>();
    mocks.listGitStates
      .mockImplementationOnce(() => card.promise)
      .mockImplementationOnce(() => global.promise);

    const cardRefresh = refreshWorkspaceGitProject({
      queryClient,
      dashboardProjectIds: dashboardIds,
      projectId: targetId,
    });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(1));
    const globalRefresh = refreshWorkspaceGitStates({ queryClient, projectIds: dashboardIds });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(2));

    global.resolve(notGitResult(dashboardIds));
    await globalRefresh;
    card.resolve(unavailableResult([[targetId, "Older card result"]]));
    await cardRefresh;

    expect(queryClient.getQueryData<ReadonlyMap<ProjectId, unknown>>(dashboardQueryKey)).toEqual(
      new Map([
        [targetId, { kind: "not-git" }],
        [otherId, { kind: "not-git" }],
      ]),
    );
    expect(queryClient.getQueryData(workspaceQueryKeys.gitStates([targetId]))).toBeUndefined();
  });

  it("merges overlapping refreshes for different cards without losing either result", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const firstId = projectId("different-card-a");
    const secondId = projectId("different-card-b");
    const dashboardIds = [firstId, secondId];
    const dashboardQueryKey = workspaceQueryKeys.gitStates(dashboardIds);
    const first = deferred<WorkspaceListGitStatesResult>();
    const second = deferred<WorkspaceListGitStatesResult>();
    mocks.listGitStates
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const firstRefresh = refreshWorkspaceGitProject({
      queryClient,
      dashboardProjectIds: dashboardIds,
      projectId: firstId,
    });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(1));
    const secondRefresh = refreshWorkspaceGitProject({
      queryClient,
      dashboardProjectIds: dashboardIds,
      projectId: secondId,
    });
    await vi.waitFor(() => expect(mocks.listGitStates).toHaveBeenCalledTimes(2));

    second.resolve(unavailableResult([[secondId, "Fresh second card"]]));
    await secondRefresh;
    first.resolve(unavailableResult([[firstId, "Fresh first card"]]));
    await firstRefresh;

    expect(queryClient.getQueryData<ReadonlyMap<ProjectId, unknown>>(dashboardQueryKey)).toEqual(
      new Map([
        [firstId, { kind: "unavailable", message: "Fresh first card", retryable: true }],
        [secondId, { kind: "unavailable", message: "Fresh second card", retryable: true }],
      ]),
    );
  });

  it("force-refreshes one card and merges it into the full-dashboard cache", async () => {
    const queryClient = new QueryClient();
    const targetId = projectId("target");
    const otherId = projectId("other");
    const dashboardIds = [targetId, otherId];
    queryClient.setQueryData(
      workspaceQueryKeys.gitStates(dashboardIds),
      new Map([
        [targetId, { kind: "unavailable" as const, message: "Stale", retryable: true }],
        [otherId, { kind: "not-git" as const }],
      ]),
    );
    mocks.listGitStates.mockResolvedValue({
      items: [
        {
          _tag: "not-git",
          projectId: targetId,
          workspaceRoot: "C:\\code\\target",
          refreshedAt: "2026-07-20T12:00:00.000Z",
          errors: { local: null, remote: null },
        },
      ],
    });

    await refreshWorkspaceGitProject({
      queryClient,
      dashboardProjectIds: dashboardIds,
      projectId: targetId,
    });

    expect(mocks.listGitStates).toHaveBeenCalledWith({
      projectIds: [targetId],
      forceRefresh: true,
    });
    expect(
      queryClient.getQueryData<ReadonlyMap<ProjectId, unknown>>(
        workspaceQueryKeys.gitStates(dashboardIds),
      ),
    ).toEqual(
      new Map([
        [targetId, { kind: "not-git" }],
        [otherId, { kind: "not-git" }],
      ]),
    );
  });
});
