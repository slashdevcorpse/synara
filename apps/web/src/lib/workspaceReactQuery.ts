// FILE: workspaceReactQuery.ts
// Purpose: React Query adapter for workspace repository summaries and clone progress.
// Layer: Web data access
// Exports: Workspace query keys/options, response normalization, and clone orchestration.

import type {
  ProjectId,
  WorkspaceCloneId,
  WorkspaceCloneJobSnapshot,
  WorkspaceCloneProgressEvent,
  WorkspaceCloneRepositoryResult,
  WorkspaceGitStateItem,
} from "@synara/contracts";
import { WORKSPACE_LIST_GIT_STATES_MAX_PROJECTS } from "@synara/contracts";
import { describeErrorMessage } from "@synara/shared/errorMessages";
import { queryOptions, type QueryClient, type QueryKey } from "@tanstack/react-query";

import type { WorkspaceRepositoryState } from "~/components/workspace/workspaceDashboard.logic";
import { ensureNativeApi } from "~/nativeApi";

function readWorkspaceApi() {
  return ensureNativeApi().workspace;
}

function normalizedProjectIds(projectIds: readonly ProjectId[]): ProjectId[] {
  return [...new Set(projectIds)].toSorted((left, right) => left.localeCompare(right));
}

function abortError(): Error {
  const error = new Error("Workspace status request was cancelled.");
  error.name = "AbortError";
  return error;
}

function awaitWithAbort<A>(start: () => Promise<A>, signal: AbortSignal | undefined): Promise<A> {
  if (!signal) return Promise.resolve().then(start);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<A>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      start().then(
        (value) => finish(() => resolve(value)),
        (cause) => finish(() => reject(cause)),
      );
    } catch (cause) {
      finish(() => reject(cause));
    }
  });
}

const forcedRefreshGenerations = new WeakMap<QueryClient, Map<ProjectId, number>>();

function claimForcedRefreshGenerations(
  queryClient: QueryClient,
  projectIds: readonly ProjectId[],
): ReadonlyMap<ProjectId, number> {
  let current = forcedRefreshGenerations.get(queryClient);
  if (!current) {
    current = new Map();
    forcedRefreshGenerations.set(queryClient, current);
  }
  const claimed = new Map<ProjectId, number>();
  for (const projectId of normalizedProjectIds(projectIds)) {
    const generation = (current.get(projectId) ?? 0) + 1;
    current.set(projectId, generation);
    claimed.set(projectId, generation);
  }
  return claimed;
}

function publishOwnedWorkspaceGitStates(input: {
  readonly queryClient: QueryClient;
  readonly queryKey: QueryKey;
  readonly ownership: ReadonlyMap<ProjectId, number>;
  readonly data: ReadonlyMap<ProjectId, WorkspaceRepositoryState>;
}): void {
  const currentGenerations = forcedRefreshGenerations.get(input.queryClient);
  input.queryClient.setQueryData<ReadonlyMap<ProjectId, WorkspaceRepositoryState>>(
    input.queryKey,
    (current) => {
      let next: Map<ProjectId, WorkspaceRepositoryState> | null = null;
      for (const [projectId, generation] of input.ownership) {
        if (currentGenerations?.get(projectId) !== generation) continue;
        const state = input.data.get(projectId);
        if (!state) continue;
        next ??= new Map(current ?? []);
        next.set(projectId, state);
      }
      return next ?? current;
    },
  );
}

function workspaceStatusFailureMessage(cause: unknown): string {
  return describeErrorMessage(cause, "Workspace status is temporarily unavailable.");
}

export function unavailableWorkspaceGitStates(
  projectIds: readonly ProjectId[],
  cause: unknown,
): ReadonlyMap<ProjectId, WorkspaceRepositoryState> {
  const message = workspaceStatusFailureMessage(cause);
  return new Map(
    normalizedProjectIds(projectIds).map((projectId) => [
      projectId,
      { kind: "unavailable" as const, message, retryable: true },
    ]),
  );
}

export const workspaceQueryKeys = {
  all: ["workspace"] as const,
  archivedProjects: ["workspace", "archived-projects"] as const,
  gitStates: (projectIds: readonly ProjectId[]) =>
    [...workspaceQueryKeys.all, "git-states", normalizedProjectIds(projectIds)] as const,
};

export function workspaceArchivedProjectsQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: workspaceQueryKeys.archivedProjects,
    queryFn: () => readWorkspaceApi().listArchivedProjects(),
    enabled: input.enabled ?? true,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function normalizeWorkspaceGitStates(
  items: readonly WorkspaceGitStateItem[],
): ReadonlyMap<ProjectId, WorkspaceRepositoryState> {
  const states = new Map<ProjectId, WorkspaceRepositoryState>();
  for (const item of items) {
    if (item._tag === "unavailable") {
      const error = item.errors.local ?? item.errors.remote;
      states.set(item.projectId, {
        kind: "unavailable",
        message: error?.message ?? "Repository status is temporarily unavailable.",
        retryable: error?.retryable ?? true,
      });
      continue;
    }
    if (item._tag === "not-git") {
      states.set(item.projectId, { kind: "not-git" });
      continue;
    }
    states.set(item.projectId, {
      kind: "git",
      remoteUrl: item.remoteUrl,
      remoteName: item.remoteName,
      branch: item.branch,
      headState: item.headState,
      ahead: item.ahead,
      behind: item.behind,
      dirtyFileCount: Math.max(0, item.dirtyFileCount),
      hasUnpushedCommits: item.hasUnpushedCommits,
      linkedPr: item.linkedPullRequest,
      githubStatus: item.errors.remote
        ? "unavailable"
        : item.remoteUrl
          ? "ready"
          : "not_applicable",
      githubErrorMessage: item.errors.remote?.message ?? null,
    });
  }
  return states;
}

async function fetchWorkspaceGitStates(input: {
  projectIds: readonly ProjectId[];
  forceRefresh?: boolean;
  signal?: AbortSignal;
}): Promise<ReadonlyMap<ProjectId, WorkspaceRepositoryState>> {
  const projectIds = normalizedProjectIds(input.projectIds);
  if (projectIds.length === 0) return new Map();
  const states = new Map<ProjectId, WorkspaceRepositoryState>();
  for (
    let offset = 0;
    offset < projectIds.length;
    offset += WORKSPACE_LIST_GIT_STATES_MAX_PROJECTS
  ) {
    const batch = projectIds.slice(offset, offset + WORKSPACE_LIST_GIT_STATES_MAX_PROJECTS);
    try {
      const result = await awaitWithAbort(
        () =>
          readWorkspaceApi().listGitStates({
            projectIds: batch,
            ...(input.forceRefresh ? { forceRefresh: true } : {}),
          }),
        input.signal,
      );
      const normalized = normalizeWorkspaceGitStates(result.items);
      for (const projectId of batch) {
        states.set(
          projectId,
          normalized.get(projectId) ?? {
            kind: "unavailable",
            message: "No workspace status was returned for this project.",
            retryable: true,
          },
        );
      }
    } catch (cause) {
      if (input.signal?.aborted) {
        throw cause;
      }
      for (const [projectId, state] of unavailableWorkspaceGitStates(batch, cause)) {
        states.set(projectId, state);
      }
    }
  }
  return states;
}

export function workspaceGitStatesQueryOptions(input: {
  projectIds: readonly ProjectId[];
  enabled?: boolean;
}) {
  const projectIds = normalizedProjectIds(input.projectIds);
  return queryOptions({
    queryKey: workspaceQueryKeys.gitStates(projectIds),
    queryFn: ({ signal }) => fetchWorkspaceGitStates({ projectIds, signal }),
    enabled: (input.enabled ?? true) && projectIds.length > 0,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export async function refreshWorkspaceGitStates(input: {
  queryClient: QueryClient;
  projectIds: readonly ProjectId[];
}): Promise<ReadonlyMap<ProjectId, WorkspaceRepositoryState>> {
  const projectIds = normalizedProjectIds(input.projectIds);
  const queryKey = workspaceQueryKeys.gitStates(projectIds);
  const ownership = claimForcedRefreshGenerations(input.queryClient, projectIds);
  await input.queryClient.cancelQueries({ queryKey, exact: true });
  const data = await fetchWorkspaceGitStates({ projectIds, forceRefresh: true });
  publishOwnedWorkspaceGitStates({
    queryClient: input.queryClient,
    queryKey,
    ownership,
    data,
  });
  return data;
}

export async function refreshWorkspaceGitProject(input: {
  queryClient: QueryClient;
  dashboardProjectIds: readonly ProjectId[];
  projectId: ProjectId;
}): Promise<WorkspaceRepositoryState | undefined> {
  const projectQueryKey = workspaceQueryKeys.gitStates([input.projectId]);
  const dashboardQueryKey = workspaceQueryKeys.gitStates(input.dashboardProjectIds);
  const ownership = claimForcedRefreshGenerations(input.queryClient, [input.projectId]);
  await Promise.all([
    input.queryClient.cancelQueries({ queryKey: projectQueryKey, exact: true }),
    input.queryClient.cancelQueries({ queryKey: dashboardQueryKey, exact: true }),
  ]);
  const data = await fetchWorkspaceGitStates({
    projectIds: [input.projectId],
    forceRefresh: true,
  });
  const state = data.get(input.projectId);
  publishOwnedWorkspaceGitStates({
    queryClient: input.queryClient,
    queryKey: projectQueryKey,
    ownership,
    data,
  });
  publishOwnedWorkspaceGitStates({
    queryClient: input.queryClient,
    queryKey: dashboardQueryKey,
    ownership,
    data,
  });
  return state;
}

export async function cloneWorkspaceRepository(input: {
  cloneId: WorkspaceCloneId;
  url: string;
  targetPath: string;
  onProgress: (event: WorkspaceCloneProgressEvent) => void;
}): Promise<WorkspaceCloneRepositoryResult> {
  const workspace = readWorkspaceApi();
  const unsubscribe = workspace.onCloneProgress((event) => {
    if (event.snapshot.cloneId === input.cloneId) input.onProgress(event);
  });
  try {
    return await workspace.cloneRepository({
      cloneId: input.cloneId,
      url: input.url,
      targetPath: input.targetPath,
      createProject: true,
      createParentDirectories: true,
    });
  } finally {
    unsubscribe();
  }
}

export function retryWorkspaceCloneProjectCreation(
  cloneId: WorkspaceCloneId,
): Promise<WorkspaceCloneRepositoryResult> {
  return readWorkspaceApi().retryCloneProjectCreation({ cloneId });
}

export async function getWorkspaceCloneStatus(
  cloneId: WorkspaceCloneId,
): Promise<WorkspaceCloneJobSnapshot | null> {
  return (await readWorkspaceApi().getCloneStatus({ cloneId })).job;
}

export function subscribeWorkspaceCloneProgress(
  cloneId: WorkspaceCloneId,
  listener: (event: WorkspaceCloneProgressEvent) => void,
): () => void {
  return readWorkspaceApi().onCloneProgress((event) => {
    if (event.snapshot.cloneId === cloneId) listener(event);
  });
}
