import {
  type ProjectId,
  type WorkspaceGitRepositoryState,
  type WorkspaceGitStateError,
  type WorkspaceGitStateItem,
  type WorkspaceListGitStatesInput,
  type WorkspaceListGitStatesResult,
  type WorkspaceLinkedPullRequest,
} from "@synara/contracts";
import {
  parseGitHubRepositoryNameWithOwnerFromPullRequestUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
} from "@synara/shared/githubRepository";
import { Effect, FileSystem, Layer, Option, Semaphore, ServiceMap } from "effect";

import { GitHubCliError } from "../git/Errors";
import { GitCore, type GitStatusDetails } from "../git/Services/GitCore";
import { GitHubCli } from "../git/Services/GitHubCli";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { makeKeyedSingleFlightCache } from "../pullRequests/KeyedSingleFlightCache";

const WORKSPACE_GIT_STATE_CACHE_TTL_MS = 5_000;
const WORKSPACE_GIT_STATE_CACHE_MAX_ENTRIES = 512;
const WORKSPACE_GIT_STATE_CONCURRENCY = 4;
export const WORKSPACE_REMOTE_ENRICHMENT_BUDGET_MS = 3_000;

export interface MakeWorkspaceGitStatesOptions {
  readonly remoteEnrichmentBudgetMs?: number;
}

class WorkspaceGitStateLoadFailure {
  readonly _tag = "WorkspaceGitStateLoadFailure";

  constructor(
    readonly error: WorkspaceGitStateError,
    readonly workspaceRoot: string | null,
  ) {}
}

function stateError(code: string, cause: unknown, retryable: boolean): WorkspaceGitStateError {
  const message =
    cause instanceof Error && cause.message.trim() ? cause.message.trim() : String(cause);
  return { code, message: message || "Workspace git state is unavailable.", retryable };
}

function unavailable(
  projectId: ProjectId,
  workspaceRoot: string | null,
  error: WorkspaceGitStateError,
): WorkspaceGitStateItem {
  return {
    _tag: "unavailable",
    projectId,
    workspaceRoot,
    refreshedAt: new Date().toISOString(),
    errors: { local: error, remote: null },
  };
}

/** Returns a credential-free remote URL suitable for rendering or null when it is not parseable. */
export function sanitizeWorkspaceRemoteUrl(remoteUrl: string | null): string | null {
  const value = remoteUrl?.trim() ?? "";
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;

  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      if (!new Set(["https:", "http:", "ssh:", "git:"]).has(parsed.protocol)) return null;
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  const scp = /^(?:[^@\s/:]+@)?([A-Za-z0-9.-]+):([^\s?#]+)$/.exec(value);
  if (!scp) return null;
  const host = scp[1]?.toLowerCase();
  const repositoryPath = scp[2];
  return host && repositoryPath ? `git@${host}:${repositoryPath}` : null;
}

function isPullRequestNotFound(error: unknown): boolean {
  return (
    error instanceof GitHubCliError &&
    error.reason === "other" &&
    error.detail.toLowerCase().includes("pull request not found")
  );
}

export interface WorkspaceGitStatesShape {
  readonly list: (
    input: WorkspaceListGitStatesInput,
  ) => Effect.Effect<WorkspaceListGitStatesResult>;
}

export class WorkspaceGitStates extends ServiceMap.Service<
  WorkspaceGitStates,
  WorkspaceGitStatesShape
>()("synara/workspace/WorkspaceGitStates") {}

function* makeWorkspaceGitStatesGenerator(options: MakeWorkspaceGitStatesOptions = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitCore;
  const github = yield* GitHubCli;
  const projection = yield* ProjectionSnapshotQuery;
  const localCache = yield* makeKeyedSingleFlightCache<
    WorkspaceGitStateItem,
    WorkspaceGitStateLoadFailure
  >({
    maxEntries: WORKSPACE_GIT_STATE_CACHE_MAX_ENTRIES,
    ttlMs: WORKSPACE_GIT_STATE_CACHE_TTL_MS,
  });
  const remoteCache = yield* makeKeyedSingleFlightCache<WorkspaceGitStateItem, never>({
    maxEntries: WORKSPACE_GIT_STATE_CACHE_MAX_ENTRIES,
    ttlMs: WORKSPACE_GIT_STATE_CACHE_TTL_MS,
  });
  const remoteEnrichmentBudgetMs = Math.max(
    1,
    Math.floor(options.remoteEnrichmentBudgetMs ?? WORKSPACE_REMOTE_ENRICHMENT_BUDGET_MS),
  );
  const remoteEnrichmentSemaphore = yield* Semaphore.make(WORKSPACE_GIT_STATE_CONCURRENCY);
  let lastPrioritizedRemoteProjectId: ProjectId | null = null;

  const scheduleRemoteItems = (
    items: readonly WorkspaceGitRepositoryState[],
  ): readonly WorkspaceGitRepositoryState[] => {
    const canonicalItems = [...items].toSorted((left, right) =>
      left.projectId.localeCompare(right.projectId),
    );
    if (canonicalItems.length === 0) return canonicalItems;

    const previousProjectId = lastPrioritizedRemoteProjectId;
    const successorIndex =
      previousProjectId === null
        ? 0
        : canonicalItems.findIndex((item) => item.projectId.localeCompare(previousProjectId) > 0);
    const start = successorIndex < 0 ? 0 : successorIndex;
    const scheduled = [...canonicalItems.slice(start), ...canonicalItems.slice(0, start)];
    lastPrioritizedRemoteProjectId =
      scheduled[Math.min(WORKSPACE_GIT_STATE_CONCURRENCY, scheduled.length) - 1]!.projectId;
    return scheduled;
  };

  const gitState = (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly details: GitStatusDetails;
    readonly remoteUrl: string | null;
    readonly remoteName: string | null;
    readonly remoteError: WorkspaceGitStateError | null;
    readonly pullRequest: WorkspaceLinkedPullRequest | null;
  }): WorkspaceGitRepositoryState => {
    const headState = !input.details.hasCommits
      ? ("unborn" as const)
      : input.details.isDetached
        ? ("detached" as const)
        : ("branch" as const);
    return {
      _tag: "git",
      projectId: input.projectId,
      workspaceRoot: input.workspaceRoot,
      remoteUrl: input.remoteUrl,
      remoteName: input.remoteName,
      branch: input.details.branch,
      headState,
      dirty: input.details.hasWorkingTreeChanges,
      dirtyFileCount: input.details.workingTree.files.length,
      upstream: input.details.upstreamRef,
      ahead: input.details.aheadCount,
      behind: input.details.behindCount,
      hasCommits: input.details.hasCommits,
      hasUnpushedCommits:
        input.details.hasCommits && (!input.details.hasUpstream || input.details.aheadCount > 0),
      linkedPullRequest: input.pullRequest,
      refreshedAt: new Date().toISOString(),
      errors: { local: null, remote: input.remoteError },
    };
  };

  const loadLocal = (projectId: ProjectId, workspaceRoot: string) =>
    Effect.gen(function* () {
      const stat = yield* fileSystem
        .stat(workspaceRoot)
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceGitStateLoadFailure(
                stateError("PROJECT_ROOT_UNAVAILABLE", cause, true),
                workspaceRoot,
              ),
          ),
        );
      if (stat.type !== "Directory") {
        return yield* Effect.fail(
          new WorkspaceGitStateLoadFailure(
            {
              code: "PROJECT_ROOT_NOT_DIRECTORY",
              message: "The project workspace root is not a directory.",
              retryable: false,
            },
            workspaceRoot,
          ),
        );
      }
      const canonicalRoot = yield* fileSystem
        .realPath(workspaceRoot)
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceGitStateLoadFailure(
                stateError("PROJECT_ROOT_UNAVAILABLE", cause, true),
                workspaceRoot,
              ),
          ),
        );
      const refreshedAt = new Date().toISOString();
      const details = yield* git
        .statusDetails(canonicalRoot, {
          refreshUpstream: false,
          workingTreeMode: "summary",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceGitStateLoadFailure(
                stateError("GIT_STATUS_UNAVAILABLE", cause, true),
                canonicalRoot,
              ),
          ),
        );

      if (!details.isRepo) {
        return {
          _tag: "not-git",
          projectId,
          workspaceRoot: canonicalRoot,
          refreshedAt,
          errors: { local: null, remote: null },
        } satisfies WorkspaceGitStateItem;
      }

      let remoteError: WorkspaceGitStateError | null = null;
      const configuredRemote = yield* git.readConfigValue(canonicalRoot, "remote.origin.url").pipe(
        Effect.catch((cause) => {
          remoteError = stateError("GIT_REMOTE_UNAVAILABLE", cause, true);
          return Effect.succeed(null);
        }),
      );
      const remoteUrl = sanitizeWorkspaceRemoteUrl(configuredRemote);
      const remoteName = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(configuredRemote);

      return gitState({
        projectId,
        workspaceRoot: canonicalRoot,
        details,
        remoteUrl,
        remoteName,
        remoteError,
        pullRequest: null,
      });
    });

  const shouldEnrichRemote = (item: WorkspaceGitStateItem): item is WorkspaceGitRepositoryState =>
    item._tag === "git" &&
    (item.upstream !== null || (item.remoteName !== null && item.headState === "branch"));

  const enrichRemote = (item: WorkspaceGitRepositoryState, forceUpstreamRefresh: boolean) =>
    Effect.gen(function* () {
      let remoteError = item.errors.remote;
      const details = yield* git
        .statusDetails(item.workspaceRoot, {
          refreshUpstream: true,
          forceUpstreamRefresh,
          workingTreeMode: "summary",
        })
        .pipe(
          Effect.catch((cause) => {
            remoteError = stateError("GIT_UPSTREAM_STATUS_UNAVAILABLE", cause, true);
            return Effect.succeed(null);
          }),
        );
      if (details === null) {
        return {
          ...item,
          refreshedAt: new Date().toISOString(),
          errors: { local: null, remote: remoteError },
        } satisfies WorkspaceGitRepositoryState;
      }
      if (!details.isRepo) {
        return {
          _tag: "not-git",
          projectId: item.projectId,
          workspaceRoot: item.workspaceRoot,
          refreshedAt: new Date().toISOString(),
          errors: { local: null, remote: null },
        } satisfies WorkspaceGitStateItem;
      }
      if (details.upstreamRefreshStatus === "failed" && remoteError === null) {
        remoteError = {
          code: "GIT_UPSTREAM_REFRESH_UNAVAILABLE",
          message: "Upstream status could not be refreshed; ahead and behind may be stale.",
          retryable: true,
        };
      }

      const headState = !details.hasCommits
        ? ("unborn" as const)
        : details.isDetached
          ? ("detached" as const)
          : ("branch" as const);
      let pullRequest: WorkspaceLinkedPullRequest | null = null;
      if (item.remoteName && headState === "branch" && details.branch) {
        const result = yield* Effect.result(
          github.getPullRequestWithChecks({
            cwd: item.workspaceRoot,
            reference: details.branch,
          }),
        );
        if (result._tag === "Success") {
          const summary = result.success.summary;
          pullRequest = {
            repository:
              parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(summary.url) ?? item.remoteName,
            number: summary.number,
            title: summary.title,
            url: summary.url,
            state: summary.state ?? "open",
            isDraft: summary.isDraft === true,
            checks: [...result.success.checks],
          };
        } else if (!isPullRequestNotFound(result.failure)) {
          remoteError = stateError("GITHUB_STATUS_UNAVAILABLE", result.failure, true);
        }
      }

      return gitState({
        projectId: item.projectId,
        workspaceRoot: item.workspaceRoot,
        details,
        remoteUrl: item.remoteUrl,
        remoteName: item.remoteName,
        remoteError,
        pullRequest,
      });
    });

  const list: WorkspaceGitStatesShape["list"] = (input) =>
    Effect.gen(function* () {
      const uniqueProjectIds = [...new Set(input.projectIds)];
      const byProjectId = new Map<ProjectId, WorkspaceGitStateItem>();

      yield* Effect.forEach(
        uniqueProjectIds,
        (projectId) =>
          projection.getProjectShellById(projectId).pipe(
            Effect.flatMap((projectOption) => {
              if (Option.isNone(projectOption)) {
                return Effect.succeed(
                  unavailable(projectId, null, {
                    code: "PROJECT_NOT_FOUND",
                    message: "The project is not active or does not exist.",
                    retryable: false,
                  }),
                );
              }
              if (projectOption.value.kind !== "project") {
                return Effect.succeed(
                  unavailable(projectId, null, {
                    code: "PROJECT_KIND_UNSUPPORTED",
                    message: "Workspace git state is only available for project dashboards.",
                    retryable: false,
                  }),
                );
              }
              const workspaceRoot = projectOption.value.workspaceRoot;
              const key = `${projectId}\u0000${workspaceRoot}`;
              const cached = input.forceRefresh
                ? Effect.all([
                    localCache.invalidate(key),
                    remoteCache.invalidateWhere((remoteKey) =>
                      remoteKey.startsWith(`${projectId}\u0000`),
                    ),
                  ]).pipe(Effect.andThen(localCache.get(key, loadLocal(projectId, workspaceRoot))))
                : localCache.get(key, loadLocal(projectId, workspaceRoot));
              return cached.pipe(
                Effect.catch((failure) =>
                  Effect.succeed(unavailable(projectId, failure.workspaceRoot, failure.error)),
                ),
              );
            }),
            Effect.catch((cause) =>
              Effect.succeed(
                unavailable(projectId, null, stateError("PROJECT_LOOKUP_UNAVAILABLE", cause, true)),
              ),
            ),
            Effect.tap((item) => Effect.sync(() => byProjectId.set(projectId, item))),
          ),
        { concurrency: WORKSPACE_GIT_STATE_CONCURRENCY, discard: true },
      );

      const localItems = uniqueProjectIds.flatMap((projectId) => {
        const item = byProjectId.get(projectId);
        return item ? [item] : [];
      });
      const remoteItems = localItems.filter(shouldEnrichRemote);
      if (remoteItems.length > 0) {
        const completedProjectIds = new Set<ProjectId>();
        const scheduledRemoteItems = scheduleRemoteItems(remoteItems);
        const remoteWork = Effect.forEach(
          scheduledRemoteItems,
          (item) => {
            const localKey = `${item.projectId}\u0000${item.workspaceRoot}`;
            const remoteKey = `${localKey}\u0000${item.refreshedAt}`;
            return remoteCache
              .get(
                remoteKey,
                remoteEnrichmentSemaphore.withPermits(1)(
                  enrichRemote(item, input.forceRefresh === true),
                ),
              )
              .pipe(
                Effect.tap((enriched) =>
                  Effect.sync(() => {
                    byProjectId.set(item.projectId, enriched);
                    completedProjectIds.add(item.projectId);
                  }),
                ),
              );
          },
          { concurrency: "unbounded", discard: true },
        );
        const completedWithinBudget = yield* remoteWork.pipe(
          Effect.timeoutOption(remoteEnrichmentBudgetMs),
        );
        if (Option.isNone(completedWithinBudget)) {
          for (const item of remoteItems) {
            if (completedProjectIds.has(item.projectId)) continue;
            byProjectId.set(item.projectId, {
              ...item,
              errors: {
                local: null,
                remote:
                  item.errors.remote ??
                  ({
                    code: "REMOTE_ENRICHMENT_TIMEOUT",
                    message:
                      "Remote status did not finish within the workspace refresh budget; local status is shown.",
                    retryable: true,
                  } satisfies WorkspaceGitStateError),
              },
            });
          }
        }
      }

      return {
        items: input.projectIds.map(
          (projectId) =>
            byProjectId.get(projectId) ??
            unavailable(projectId, null, {
              code: "PROJECT_STATE_MISSING",
              message: "No workspace state was produced for this project.",
              retryable: true,
            }),
        ),
      } satisfies WorkspaceListGitStatesResult;
    });

  return { list } satisfies WorkspaceGitStatesShape;
}

export const makeWorkspaceGitStatesWithOptions = (options: MakeWorkspaceGitStatesOptions = {}) =>
  Effect.gen(() => makeWorkspaceGitStatesGenerator(options));

export const makeWorkspaceGitStates = makeWorkspaceGitStatesWithOptions();

export const WorkspaceGitStatesLive = Layer.effect(WorkspaceGitStates, makeWorkspaceGitStates);
