// FILE: cloneProjectCreation.test.ts
// Purpose: Verifies wsRpc's production clone-to-project recovery path.
// Layer: Server workspace orchestration tests

import {
  ProjectId,
  type ClientOrchestrationCommand,
  type OrchestrationArchivedProjectSummary,
  type OrchestrationCommand,
  type OrchestrationProject,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeWorkspaceCloneProjectCreator } from "./cloneProjectCreation";

const NOW = "2026-07-20T12:00:00.000Z";
const ALIAS_ROOT = "C:\\Users\\ADA\\REPO-L~1";
const CANONICAL_ROOT = "C:\\Users\\Ada\\repo-long";
const ORIGINAL_PROJECT_ID = ProjectId.makeUnsafe("project-archived-original");
const REPLACEMENT_PROJECT_ID = ProjectId.makeUnsafe("project-active-replacement");

function archivedProject(): OrchestrationArchivedProjectSummary {
  return {
    id: ORIGINAL_PROJECT_ID,
    kind: "project",
    title: "Original project",
    workspaceRoot: CANONICAL_ROOT,
    archivedAt: NOW,
    threadCount: 3,
    latestThread: null,
  };
}

function activeProject(id: ProjectId): OrchestrationProject {
  return {
    id,
    kind: "project",
    title: id === ORIGINAL_PROJECT_ID ? "Original project" : "Replacement project",
    workspaceRoot: CANONICAL_ROOT,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
  };
}

function normalizedCreateCommand(command: ClientOrchestrationCommand): OrchestrationCommand {
  if (command.type !== "project.create") {
    throw new Error(`Expected project.create, received ${command.type}.`);
  }
  return { ...command, workspaceRoot: CANONICAL_ROOT };
}

describe("makeWorkspaceCloneProjectCreator", () => {
  it("canonicalizes an alias and restores the archived project's original id", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const normalizeDispatchCommand = vi.fn((input: { command: ClientOrchestrationCommand }) =>
      Effect.succeed({
        command: normalizedCreateCommand(input.command),
        prepareWorkspaceRoot: null,
      }),
    );
    const getActiveProjectByWorkspaceRoot = vi.fn(() =>
      Effect.succeed(Option.none<OrchestrationProject>()),
    );
    const creator = makeWorkspaceCloneProjectCreator({
      basename: (workspaceRoot) => workspaceRoot.split(/[/\\]/).at(-1) ?? workspaceRoot,
      defaultCodexModel: "gpt-test",
      dispatchCommand: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 12 };
        }),
      normalizeDispatchCommand,
      platform: "win32",
      projectionSnapshotQuery: {
        listArchivedProjects: () => Effect.succeed([archivedProject()]),
        getActiveProjectByWorkspaceRoot,
      },
    });

    await expect(Effect.runPromise(creator(ALIAS_ROOT))).resolves.toBe(ORIGINAL_PROJECT_ID);
    expect(normalizeDispatchCommand).toHaveBeenCalledWith({
      command: expect.objectContaining({
        type: "project.create",
        workspaceRoot: ALIAS_ROOT,
      }),
    });
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "project.unarchive",
        projectId: ORIGINAL_PROJECT_ID,
      }),
    ]);
    expect(getActiveProjectByWorkspaceRoot).not.toHaveBeenCalled();
  });

  it("accepts a concurrent restore only when the active project has the same original id", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const creator = makeWorkspaceCloneProjectCreator({
      basename: () => "repo-long",
      defaultCodexModel: "gpt-test",
      dispatchCommand: (command) => {
        dispatched.push(command);
        return Effect.fail(new Error("Project is no longer archived."));
      },
      normalizeDispatchCommand: ({ command }) =>
        Effect.succeed({
          command: normalizedCreateCommand(command),
          prepareWorkspaceRoot: null,
        }),
      platform: "win32",
      projectionSnapshotQuery: {
        listArchivedProjects: () => Effect.succeed([archivedProject()]),
        getActiveProjectByWorkspaceRoot: (workspaceRoot) => {
          expect(workspaceRoot).toBe(CANONICAL_ROOT);
          return Effect.succeed(Option.some(activeProject(ORIGINAL_PROJECT_ID)));
        },
      },
    });

    await expect(Effect.runPromise(creator(ALIAS_ROOT))).resolves.toBe(ORIGINAL_PROJECT_ID);
    expect(dispatched.map((command) => command.type)).toEqual(["project.unarchive"]);
  });

  it.each([
    {
      name: "pending archive cleanup",
      message: "Archive session cleanup has not settled.",
      activeProjectId: null,
    },
    {
      name: "the active pin cap",
      message: "Unpin another project first.",
      activeProjectId: null,
    },
    {
      name: "an active workspace-root collision",
      message: "Another project already uses this workspace root.",
      activeProjectId: REPLACEMENT_PROJECT_ID,
    },
  ])("does not create or reuse a replacement id after $name blocks restore", async (failure) => {
    const dispatched: OrchestrationCommand[] = [];
    const creator = makeWorkspaceCloneProjectCreator({
      basename: () => "repo-long",
      defaultCodexModel: "gpt-test",
      dispatchCommand: (command) => {
        dispatched.push(command);
        return Effect.fail(new Error(failure.message));
      },
      normalizeDispatchCommand: ({ command }) =>
        Effect.succeed({
          command: normalizedCreateCommand(command),
          prepareWorkspaceRoot: null,
        }),
      platform: "win32",
      projectionSnapshotQuery: {
        listArchivedProjects: () => Effect.succeed([archivedProject()]),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            failure.activeProjectId === null
              ? Option.none<OrchestrationProject>()
              : Option.some(activeProject(failure.activeProjectId)),
          ),
      },
    });

    await expect(Effect.runPromise(creator(ALIAS_ROOT))).rejects.toThrow(failure.message);
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "project.unarchive",
        projectId: ORIGINAL_PROJECT_ID,
      }),
    ]);
  });
});
