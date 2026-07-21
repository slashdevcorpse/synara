import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  type OrchestrationProjectShell,
  type WorkspaceListGitStatesInput,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { GitCommandError, GitHubCliError } from "../git/Errors";
import {
  GitCore,
  type GitCoreShape,
  type GitStatusDetails,
  type GitStatusDetailsOptions,
} from "../git/Services/GitCore";
import { GitHubCli, type GitHubCliShape } from "../git/Services/GitHubCli";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery";
import {
  type MakeWorkspaceGitStatesOptions,
  makeWorkspaceGitStates,
  makeWorkspaceGitStatesWithOptions,
  sanitizeWorkspaceRemoteUrl,
  type WorkspaceGitStatesShape,
} from "./workspaceGitStates";

const tempDirs: string[] = [];

async function makeTempDir(name: string): Promise<string> {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), `synara-git-state-${name}-`));
  tempDirs.push(root);
  return NodeFs.realpath(root);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => NodeFs.rm(dir, { recursive: true, force: true })),
  );
});

function shell(
  id: ProjectId,
  workspaceRoot: string,
  kind: OrchestrationProjectShell["kind"] = "project",
): OrchestrationProjectShell {
  return {
    id,
    kind,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    archivedAt: null,
  };
}

function details(overrides: Partial<GitStatusDetails> = {}): GitStatusDetails {
  return {
    isRepo: true,
    hasOriginRemote: true,
    isDefaultBranch: false,
    hasCommits: true,
    isDetached: false,
    branch: "feature/workspace",
    upstreamRef: "origin/feature/workspace",
    upstreamRefreshStatus: "succeeded",
    upstreamBranch: "feature/workspace",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    ...overrides,
  };
}

function gitCommandError(cwd: string, detail: string): GitCommandError {
  return new GitCommandError({
    operation: "workspace git state test",
    command: "git status",
    cwd,
    detail,
  });
}

function runWithWorkspaceGitStates<A>(input: {
  readonly shells: ReadonlyMap<ProjectId, OrchestrationProjectShell>;
  readonly git: Pick<GitCoreShape, "statusDetails" | "readConfigValue">;
  readonly github: Pick<GitHubCliShape, "getPullRequestWithChecks">;
  readonly serviceOptions?: MakeWorkspaceGitStatesOptions;
  readonly run: (service: WorkspaceGitStatesShape) => Effect.Effect<A>;
}): Promise<A> {
  const projection = {
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(
        input.shells.has(projectId) ? Option.some(input.shells.get(projectId)!) : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQueryShape;

  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* input.serviceOptions
        ? makeWorkspaceGitStatesWithOptions(input.serviceOptions)
        : makeWorkspaceGitStates;
      return yield* input.run(service);
    }).pipe(
      Effect.provideService(GitCore, input.git as unknown as GitCoreShape),
      Effect.provideService(GitHubCli, input.github as unknown as GitHubCliShape),
      Effect.provideService(ProjectionSnapshotQuery, projection),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  );
}

describe("WorkspaceGitStates", () => {
  it("isolates project failures and classifies missing, non-git, remote-less, detached, and unborn states", async () => {
    const ids = {
      missing: ProjectId.makeUnsafe("project-missing"),
      nonGit: ProjectId.makeUnsafe("project-not-git"),
      noRemote: ProjectId.makeUnsafe("project-no-remote"),
      detached: ProjectId.makeUnsafe("project-detached"),
      unborn: ProjectId.makeUnsafe("project-unborn"),
      localFailure: ProjectId.makeUnsafe("project-local-failure"),
      remoteFailure: ProjectId.makeUnsafe("project-remote-failure"),
      chat: ProjectId.makeUnsafe("project-chat"),
      noPullRequest: ProjectId.makeUnsafe("project-no-pr"),
    };
    const roots = {
      nonGit: await makeTempDir("not-git"),
      noRemote: await makeTempDir("no-remote"),
      detached: await makeTempDir("detached"),
      unborn: await makeTempDir("unborn"),
      localFailure: await makeTempDir("local-failure"),
      remoteFailure: await makeTempDir("remote-failure"),
      noPullRequest: await makeTempDir("no-pr"),
    };
    const shells = new Map<ProjectId, OrchestrationProjectShell>([
      [ids.nonGit, shell(ids.nonGit, roots.nonGit)],
      [ids.noRemote, shell(ids.noRemote, roots.noRemote)],
      [ids.detached, shell(ids.detached, roots.detached)],
      [ids.unborn, shell(ids.unborn, roots.unborn)],
      [ids.localFailure, shell(ids.localFailure, roots.localFailure)],
      [ids.remoteFailure, shell(ids.remoteFailure, roots.remoteFailure)],
      [ids.chat, shell(ids.chat, NodePath.join(NodeOs.tmpdir(), "private-chat-root"), "chat")],
      [ids.noPullRequest, shell(ids.noPullRequest, roots.noPullRequest)],
    ]);
    const byRoot = new Map<string, GitStatusDetails>([
      [roots.nonGit, details({ isRepo: false, hasOriginRemote: false })],
      [
        roots.noRemote,
        details({
          hasWorkingTreeChanges: true,
          workingTree: {
            files: [
              { path: "README.md", insertions: 0, deletions: 0 },
              { path: "nested/new-file.ts", insertions: 0, deletions: 0 },
            ],
            insertions: 0,
            deletions: 0,
          },
        }),
      ],
      [roots.detached, details({ branch: null, isDetached: true })],
      [
        roots.unborn,
        details({
          branch: "main",
          hasCommits: false,
          hasUpstream: false,
          upstreamRef: null,
          upstreamBranch: null,
        }),
      ],
      [roots.remoteFailure, details()],
      [roots.noPullRequest, details({ branch: "feature/no-pr" })],
    ]);
    let githubCalls = 0;

    const result = await runWithWorkspaceGitStates({
      shells,
      git: {
        statusDetails: (cwd) => {
          if (cwd === roots.localFailure) {
            return Effect.fail(gitCommandError(cwd, "git process unavailable"));
          }
          const value = byRoot.get(cwd);
          return value
            ? Effect.succeed(value)
            : Effect.fail(gitCommandError(cwd, "unexpected workspace root"));
        },
        readConfigValue: (cwd) => {
          if (cwd === roots.noRemote) return Effect.succeed(null);
          if (cwd === roots.remoteFailure) {
            return Effect.fail(gitCommandError(cwd, "remote config unreadable"));
          }
          return Effect.succeed("https://github.com/example/repo.git");
        },
      },
      github: {
        getPullRequestWithChecks: () => {
          githubCalls += 1;
          return Effect.fail(
            new GitHubCliError({
              operation: "getPullRequestWithChecks",
              detail: "Pull request not found. Check the PR number or URL and try again.",
              reason: "other",
            }),
          );
        },
      },
      run: (service) =>
        service.list({
          projectIds: [
            ids.missing,
            ids.nonGit,
            ids.noRemote,
            ids.detached,
            ids.unborn,
            ids.localFailure,
            ids.remoteFailure,
            ids.chat,
            ids.noPullRequest,
          ],
          forceRefresh: false,
        }),
    });
    const byId = new Map(result.items.map((item) => [item.projectId, item]));

    expect(byId.get(ids.missing)).toMatchObject({
      _tag: "unavailable",
      workspaceRoot: null,
      errors: { local: { code: "PROJECT_NOT_FOUND", retryable: false } },
    });
    expect(byId.get(ids.nonGit)).toMatchObject({ _tag: "not-git", workspaceRoot: roots.nonGit });
    expect(byId.get(ids.noRemote)).toMatchObject({
      _tag: "git",
      remoteUrl: null,
      remoteName: null,
      dirty: true,
      dirtyFileCount: 2,
      errors: { remote: null },
    });
    expect(byId.get(ids.detached)).toMatchObject({
      _tag: "git",
      headState: "detached",
      branch: null,
    });
    expect(byId.get(ids.unborn)).toMatchObject({
      _tag: "git",
      headState: "unborn",
      hasCommits: false,
      hasUnpushedCommits: false,
    });
    expect(byId.get(ids.localFailure)).toMatchObject({
      _tag: "unavailable",
      errors: { local: { code: "GIT_STATUS_UNAVAILABLE", retryable: true } },
    });
    expect(byId.get(ids.remoteFailure)).toMatchObject({
      _tag: "git",
      remoteUrl: null,
      errors: { remote: { code: "GIT_REMOTE_UNAVAILABLE", retryable: true } },
    });
    expect(byId.get(ids.chat)).toMatchObject({
      _tag: "unavailable",
      workspaceRoot: null,
      errors: { local: { code: "PROJECT_KIND_UNSUPPORTED", retryable: false } },
    });
    expect(byId.get(ids.noPullRequest)).toMatchObject({
      _tag: "git",
      headState: "branch",
      linkedPullRequest: null,
      errors: { remote: null },
    });
    expect(githubCalls).toBe(1);
  });

  it("deduplicates work, preserves requested ordering, and bypasses the five-second cache on force", async () => {
    const firstId = ProjectId.makeUnsafe("project-first");
    const secondId = ProjectId.makeUnsafe("project-second");
    const firstRoot = await makeTempDir("cache-first");
    const secondRoot = await makeTempDir("cache-second");
    const shells = new Map<ProjectId, OrchestrationProjectShell>([
      [firstId, shell(firstId, firstRoot)],
      [secondId, shell(secondId, secondRoot)],
    ]);
    const statusCalls = new Map<string, number>();
    const statusOptions = new Map<string, GitStatusDetailsOptions[]>();

    const results = await runWithWorkspaceGitStates({
      shells,
      git: {
        statusDetails: (cwd, options = {}) =>
          Effect.sync(() => {
            statusCalls.set(cwd, (statusCalls.get(cwd) ?? 0) + 1);
            statusOptions.set(cwd, [...(statusOptions.get(cwd) ?? []), options]);
            return details({
              branch: cwd === firstRoot ? "first" : "second",
              upstreamRef: null,
              upstreamBranch: null,
              upstreamRefreshStatus: "not-configured",
              hasUpstream: false,
            });
          }),
        readConfigValue: () => Effect.succeed(null),
      },
      github: {
        getPullRequestWithChecks: () => Effect.die("GitHub should not be queried without a remote"),
      },
      run: (service) =>
        Effect.gen(function* () {
          const request: WorkspaceListGitStatesInput = {
            projectIds: [firstId, secondId, firstId],
            forceRefresh: false,
          };
          const first = yield* service.list(request);
          const cached = yield* service.list(request);
          const forced = yield* service.list({
            projectIds: [firstId, firstId],
            forceRefresh: true,
          });
          return { first, cached, forced };
        }),
    });

    expect(results.first.items.map((item) => item.projectId)).toEqual([firstId, secondId, firstId]);
    expect(results.cached.items.map((item) => item.projectId)).toEqual([
      firstId,
      secondId,
      firstId,
    ]);
    expect(results.forced.items.map((item) => item.projectId)).toEqual([firstId, firstId]);
    expect(statusCalls.get(firstRoot)).toBe(2);
    expect(statusCalls.get(secondRoot)).toBe(1);
    expect(statusOptions.get(firstRoot)).toEqual([
      { refreshUpstream: false, workingTreeMode: "summary" },
      { refreshUpstream: false, workingTreeMode: "summary" },
    ]);
  });

  it("returns complete local cards within one remote batch budget and keeps fast PR enrichment", async () => {
    const slowId = ProjectId.makeUnsafe("project-slow-remote");
    const fastId = ProjectId.makeUnsafe("project-fast-remote");
    const slowRoot = await makeTempDir("slow-remote");
    const fastRoot = await makeTempDir("fast-remote");
    const statusOptions = new Map<string, GitStatusDetailsOptions[]>();
    let githubCalls = 0;

    const startedAt = Date.now();
    const results = await runWithWorkspaceGitStates({
      shells: new Map([
        [slowId, shell(slowId, slowRoot)],
        [fastId, shell(fastId, fastRoot)],
      ]),
      serviceOptions: { remoteEnrichmentBudgetMs: 50 },
      git: {
        statusDetails: (cwd, options = {}) => {
          statusOptions.set(cwd, [...(statusOptions.get(cwd) ?? []), options]);
          if (options.refreshUpstream === false) {
            return Effect.succeed(
              details({
                branch: cwd === slowRoot ? "slow-local" : "fast-local",
                aheadCount: cwd === slowRoot ? 1 : 0,
              }),
            );
          }
          if (cwd === slowRoot) return Effect.never;
          return Effect.succeed(details({ branch: "fast-local", aheadCount: 2 }));
        },
        readConfigValue: () => Effect.succeed("https://github.com/example/repo.git"),
      },
      github: {
        getPullRequestWithChecks: ({ cwd }) => {
          githubCalls += 1;
          return cwd === slowRoot
            ? Effect.die("Slow repository must not reach GitHub before upstream status")
            : Effect.succeed({
                summary: {
                  number: 17,
                  title: "Fast pull request",
                  url: "https://github.com/example/repo/pull/17",
                  baseRefName: "main",
                  headRefName: "fast-local",
                  state: "open" as const,
                  isDraft: false,
                },
                checks: [{ name: "CI", status: "success" as const, url: null }],
              });
        },
      },
      run: (service) =>
        Effect.gen(function* () {
          const request: WorkspaceListGitStatesInput = {
            projectIds: [slowId, fastId],
            forceRefresh: false,
          };
          const first = yield* service.list(request);
          const cachedLocalRetry = yield* service.list(request);
          const forcedFast = yield* service.list({ projectIds: [fastId], forceRefresh: true });
          return { first, cachedLocalRetry, forcedFast };
        }),
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const byId = new Map(results.first.items.map((item) => [item.projectId, item]));
    expect(byId.get(slowId)).toMatchObject({
      _tag: "git",
      branch: "slow-local",
      ahead: 1,
      linkedPullRequest: null,
      errors: { remote: { code: "REMOTE_ENRICHMENT_TIMEOUT", retryable: true } },
    });
    expect(byId.get(fastId)).toMatchObject({
      _tag: "git",
      branch: "fast-local",
      ahead: 2,
      linkedPullRequest: {
        number: 17,
        title: "Fast pull request",
        checks: [{ name: "CI", status: "success", url: null }],
      },
      errors: { remote: null },
    });
    expect(results.cachedLocalRetry.items).toMatchObject(results.first.items);
    expect(results.forcedFast.items[0]).toMatchObject({
      _tag: "git",
      projectId: fastId,
      linkedPullRequest: { number: 17 },
    });
    expect(githubCalls).toBe(2);
    expect(statusOptions.get(slowRoot)).toEqual([
      { refreshUpstream: false, workingTreeMode: "summary" },
      {
        refreshUpstream: true,
        forceUpstreamRefresh: false,
        workingTreeMode: "summary",
      },
      {
        refreshUpstream: true,
        forceUpstreamRefresh: false,
        workingTreeMode: "summary",
      },
    ]);
    expect(statusOptions.get(fastRoot)).toEqual([
      { refreshUpstream: false, workingTreeMode: "summary" },
      {
        refreshUpstream: true,
        forceUpstreamRefresh: false,
        workingTreeMode: "summary",
      },
      { refreshUpstream: false, workingTreeMode: "summary" },
      {
        refreshUpstream: true,
        forceUpstreamRefresh: true,
        workingTreeMode: "summary",
      },
    ]);
  });

  it("fairly schedules remote projects by identity as request order and membership change", async () => {
    const projectIds = Array.from({ length: 12 }, (_, index) =>
      ProjectId.makeUnsafe(`project-fair-${index.toString().padStart(2, "0")}`),
    );
    const roots = await Promise.all(
      projectIds.map((_, index) => makeTempDir(`fair-remote-${index}`)),
    );
    const rootIndex = new Map(roots.map((root, index) => [root, index]));
    const remoteStarts = new Map<number, number>();
    let activeRemote = 0;
    let maxActiveRemote = 0;

    const firstRequest = [7, 6, 5, 4, 3, 2, 1, 0].map((index) => projectIds[index]!);
    const secondRequest = [9, 8, 7, 6, 5, 4, 2, 1, 0].map((index) => projectIds[index]!);
    const thirdRequest = [11, 10, 7, 6, 5, 4, 3, 2, 1, 0].map((index) => projectIds[index]!);

    const results = await runWithWorkspaceGitStates({
      shells: new Map(
        projectIds.map((projectId, index) => [projectId, shell(projectId, roots[index]!)]),
      ),
      serviceOptions: { remoteEnrichmentBudgetMs: 50 },
      git: {
        statusDetails: (cwd, options = {}) => {
          const index = rootIndex.get(cwd);
          if (index === undefined) return Effect.die("Unexpected workspace root");
          if (options.refreshUpstream === false) {
            return Effect.succeed(details({ branch: `feature/fair-${index}` }));
          }
          return Effect.sync(() => {
            remoteStarts.set(index, (remoteStarts.get(index) ?? 0) + 1);
            activeRemote += 1;
            maxActiveRemote = Math.max(maxActiveRemote, activeRemote);
          }).pipe(
            Effect.andThen(
              index < 4
                ? Effect.never
                : Effect.succeed(details({ branch: `feature/fair-${index}`, aheadCount: index })),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                activeRemote -= 1;
              }),
            ),
          );
        },
        readConfigValue: () => Effect.succeed("https://github.com/example/repo.git"),
      },
      github: {
        getPullRequestWithChecks: ({ cwd }) => {
          const index = rootIndex.get(cwd);
          if (index === undefined || index < 4) {
            return Effect.die("Only the fast second queue window should reach GitHub");
          }
          return Effect.succeed({
            summary: {
              number: index + 1,
              title: `Fair pull request ${index}`,
              url: `https://github.com/example/repo/pull/${index + 1}`,
              baseRefName: "main",
              headRefName: `feature/fair-${index}`,
              state: "open" as const,
              isDraft: false,
            },
            checks: [],
          });
        },
      },
      run: (service) =>
        Effect.gen(function* () {
          const first = yield* service.list({ projectIds: firstRequest, forceRefresh: false });
          const second = yield* service.list({ projectIds: secondRequest, forceRefresh: false });
          const third = yield* service.list({ projectIds: thirdRequest, forceRefresh: false });
          return { first, second, third };
        }),
    });

    expect(results.first.items.map((item) => item.projectId)).toEqual(firstRequest);
    expect(results.second.items.map((item) => item.projectId)).toEqual(secondRequest);
    expect(results.third.items.map((item) => item.projectId)).toEqual(thirdRequest);
    for (const item of results.first.items) {
      expect(item).toMatchObject({
        linkedPullRequest: null,
        errors: { remote: { code: "REMOTE_ENRICHMENT_TIMEOUT", retryable: true } },
      });
    }

    for (let index = 4; index <= 9; index += 1) {
      expect(
        results.second.items.find((item) => item.projectId === projectIds[index]),
      ).toMatchObject({
        _tag: "git",
        ahead: index,
        linkedPullRequest: { number: index + 1 },
        errors: { remote: null },
      });
    }
    for (let index = 4; index <= 7; index += 1) {
      expect(
        results.third.items.find((item) => item.projectId === projectIds[index]),
      ).toMatchObject({
        _tag: "git",
        ahead: index,
        linkedPullRequest: { number: index + 1 },
        errors: { remote: null },
      });
      expect(remoteStarts.get(index)).toBe(1);
    }
    for (let index = 10; index <= 11; index += 1) {
      expect(
        results.third.items.find((item) => item.projectId === projectIds[index]),
      ).toMatchObject({
        _tag: "git",
        ahead: index,
        linkedPullRequest: { number: index + 1 },
        errors: { remote: null },
      });
      expect(remoteStarts.get(index)).toBe(1);
    }
    expect(maxActiveRemote).toBeLessThanOrEqual(4);
  });

  it("surfaces a nonfatal upstream refresh failure with otherwise usable local status", async () => {
    const projectId = ProjectId.makeUnsafe("project-upstream-refresh-failed");
    const workspaceRoot = await makeTempDir("upstream-refresh-failed");
    const result = await runWithWorkspaceGitStates({
      shells: new Map([[projectId, shell(projectId, workspaceRoot)]]),
      git: {
        statusDetails: () =>
          Effect.succeed(details({ upstreamRefreshStatus: "failed", behindCount: 2 })),
        readConfigValue: () => Effect.succeed("https://github.com/example/repo.git"),
      },
      github: {
        getPullRequestWithChecks: () =>
          Effect.fail(
            new GitHubCliError({
              operation: "getPullRequestWithChecks",
              detail: "Pull request not found.",
              reason: "other",
            }),
          ),
      },
      run: (service) => service.list({ projectIds: [projectId], forceRefresh: true }),
    });

    expect(result.items[0]).toMatchObject({
      _tag: "git",
      branch: "feature/workspace",
      behind: 2,
      errors: {
        local: null,
        remote: {
          code: "GIT_UPSTREAM_REFRESH_UNAVAILABLE",
          retryable: true,
        },
      },
    });
  });

  it("redacts credentials and query fragments from renderable remotes", () => {
    expect(sanitizeWorkspaceRemoteUrl("https://github.com/example/repo.git")).toBe(
      "https://github.com/example/repo.git",
    );
    expect(
      sanitizeWorkspaceRemoteUrl("https://token:secret@github.com/example/repo.git?q=x#x"),
    ).toBe("https://github.com/example/repo.git");
    expect(sanitizeWorkspaceRemoteUrl("ssh://git@github.com/example/repo.git")).toBe(
      "ssh://github.com/example/repo.git",
    );
    expect(sanitizeWorkspaceRemoteUrl("deploy@github.com:example/repo.git")).toBe(
      "git@github.com:example/repo.git",
    );
    expect(sanitizeWorkspaceRemoteUrl("file:///tmp/private-repo")).toBeNull();
  });
});
