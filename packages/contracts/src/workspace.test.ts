import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectId,
  WORKSPACE_LIST_GIT_STATES_MAX_PROJECTS,
  WorkspaceCloneProgressEvent,
  WorkspaceCloneRepositoryInput,
  WorkspaceGitStateItem,
  WorkspaceListArchivedProjectsResult,
  WorkspaceListGitStatesInput,
} from "./index";

describe("workspace contracts", () => {
  it("reuses the orchestration archived-project summary schema", () => {
    const result = Schema.decodeUnknownSync(WorkspaceListArchivedProjectsResult)({
      projects: [
        {
          id: "project-archived",
          kind: "project",
          title: "Archived project",
          workspaceRoot: "/repo/archived",
          archivedAt: "2026-07-20T12:00:00.000Z",
          threadCount: 1,
          latestThread: {
            id: "thread-archived",
            title: "Preserved thread",
            updatedAt: "2026-07-20T11:00:00.000Z",
          },
        },
      ],
    });

    expect(result.projects[0]).toMatchObject({
      id: "project-archived",
      threadCount: 1,
      latestThread: { id: "thread-archived" },
    });
  });

  it("decodes every per-project git-state discriminant", () => {
    const decode = Schema.decodeUnknownSync(WorkspaceGitStateItem);
    const base = {
      projectId: ProjectId.makeUnsafe("project-1"),
      workspaceRoot: "/repo",
      refreshedAt: "2026-07-20T12:00:00.000Z",
      errors: { local: null, remote: null },
    };

    expect(
      decode({
        ...base,
        _tag: "git",
        remoteUrl: "https://github.com/example/repo.git",
        remoteName: "example/repo",
        branch: "main",
        headState: "branch",
        dirty: false,
        dirtyFileCount: 0,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        hasCommits: true,
        hasUnpushedCommits: false,
        linkedPullRequest: null,
      })._tag,
    ).toBe("git");
    expect(decode({ ...base, _tag: "not-git" })._tag).toBe("not-git");
    expect(
      decode({
        ...base,
        _tag: "unavailable",
        errors: {
          local: { code: "PROJECT_ROOT_UNAVAILABLE", message: "Missing", retryable: true },
          remote: null,
        },
      })._tag,
    ).toBe("unavailable");
  });

  it("bounds list requests", () => {
    const decode = Schema.decodeUnknownSync(WorkspaceListGitStatesInput);
    expect(decode({ projectIds: [] }).forceRefresh).toBe(false);
    expect(() =>
      decode({
        projectIds: Array.from(
          { length: WORKSPACE_LIST_GIT_STATES_MAX_PROJECTS + 1 },
          (_, index) => `project-${index}`,
        ),
      }),
    ).toThrow();
  });

  it("defaults clone project creation and carries a terminal result", () => {
    const input = Schema.decodeUnknownSync(WorkspaceCloneRepositoryInput)({
      cloneId: "clone-1",
      url: "https://github.com/example/repo.git",
      targetPath: "/repos/repo",
    });
    expect(input.createProject).toBe(true);
    expect(input.createParentDirectories).toBe(true);

    const event = Schema.decodeUnknownSync(WorkspaceCloneProgressEvent)({
      _tag: "clone_finished",
      snapshot: {
        cloneId: "clone-1",
        status: "succeeded",
        stage: "complete",
        percent: 100,
        message: "Clone complete.",
        updatedAt: "2026-07-20T12:00:00.000Z",
        result: {
          cloneId: "clone-1",
          clonedPath: "/repos/repo",
          projectId: "project-1",
          failure: null,
        },
      },
      result: {
        cloneId: "clone-1",
        clonedPath: "/repos/repo",
        projectId: "project-1",
        failure: null,
      },
    });
    expect(event._tag).toBe("clone_finished");
  });
});
