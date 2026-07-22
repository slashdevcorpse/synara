// FILE: projectCreation.test.ts
// Purpose: Verifies shared project creation and duplicate-project recovery.
// Layer: Web helper tests
// Depends on: projectCreation helper plus mocked NativeApi orchestration calls.

import { type NativeApi, type OrchestrationShellSnapshot, type ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createOrRecoverProjectFromPath,
  PROJECT_CREATE_EXISTING_SYNC_ERROR,
} from "./projectCreation";

const NOW_ISO = "2026-06-26T20:00:00.000Z";
const WORKSPACE_ROOT = "/Users/tester/Developer/synara";

function makeProject(id: string, workspaceRoot = WORKSPACE_ROOT) {
  return {
    id: id as ProjectId,
    kind: "project" as const,
    title: "synara",
    workspaceRoot,
    defaultModelSelection: {
      provider: "codex" as const,
      model: "gpt-5",
    },
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

function makeSnapshot(
  projects: OrchestrationShellSnapshot["projects"],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 2,
    projects,
    threads: [],
    updatedAt: NOW_ISO,
  };
}

function makeApi(dispatchCommand: ReturnType<typeof vi.fn>): NativeApi {
  return {
    orchestration: {
      dispatchCommand,
    },
  } as unknown as NativeApi;
}

describe("createOrRecoverProjectFromPath", () => {
  it("dispatches project.create and returns the synced project", async () => {
    let createdProjectId: ProjectId | null = null;
    const dispatchCommand = vi.fn(async (command: { projectId?: ProjectId }) => {
      createdProjectId = command.projectId ?? null;
      return { sequence: 2 };
    });
    const loadSnapshot = vi.fn(async () =>
      makeSnapshot(createdProjectId ? [makeProject(createdProjectId)] : []),
    );

    const result = await createOrRecoverProjectFromPath({
      api: makeApi(dispatchCommand),
      workspaceRoot: WORKSPACE_ROOT,
      loadSnapshot,
    });

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.create",
        kind: "project",
        title: "synara",
        workspaceRoot: WORKSPACE_ROOT,
        createWorkspaceRootIfMissing: false,
      }),
    );
    expect(createdProjectId).not.toBeNull();
    expect(result).toMatchObject({
      projectId: createdProjectId,
      project: expect.objectContaining({ id: createdProjectId }),
      created: true,
      restored: false,
    });
  });

  it("recovers the intended project when the command commits before its response fails", async () => {
    let committedProjectId: ProjectId | null = null;
    const transportFailure = { _tag: "RpcClientError", reason: { _tag: "SocketCloseError" } };
    const dispatchCommand = vi.fn(async (command: { projectId?: ProjectId }) => {
      committedProjectId = command.projectId ?? null;
      throw transportFailure;
    });
    const loadSnapshot = vi.fn(async () =>
      makeSnapshot(committedProjectId ? [makeProject(committedProjectId)] : []),
    );

    const result = await createOrRecoverProjectFromPath({
      api: makeApi(dispatchCommand),
      workspaceRoot: WORKSPACE_ROOT,
      loadSnapshot,
      maxAttempts: 1,
      delayMs: 0,
    });

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      projectId: committedProjectId,
      project: expect.objectContaining({ id: committedProjectId }),
      created: true,
      restored: false,
    });
  });

  it("polls for a delayed intended project after an unclassified command failure", async () => {
    let committedProjectId: ProjectId | null = null;
    let snapshotAttempts = 0;
    const dispatchFailure = new Error("WebSocket response closed before it was observed.");
    const dispatchCommand = vi.fn(async (command: { projectId?: ProjectId }) => {
      committedProjectId = command.projectId ?? null;
      throw dispatchFailure;
    });
    const loadSnapshot = vi.fn(async () => {
      snapshotAttempts += 1;
      return makeSnapshot(
        snapshotAttempts >= 2 && committedProjectId ? [makeProject(committedProjectId)] : [],
      );
    });

    const result = await createOrRecoverProjectFromPath({
      api: makeApi(dispatchCommand),
      workspaceRoot: WORKSPACE_ROOT,
      loadSnapshot,
      maxAttempts: 2,
      delayMs: 0,
    });

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      projectId: committedProjectId,
      project: expect.objectContaining({ id: committedProjectId }),
      created: true,
      restored: false,
    });
  });

  it("does not recover another project that only shares the intended workspace root", async () => {
    const dispatchFailure = new Error("WebSocket response closed before it was observed.");
    const dispatchCommand = vi.fn(async () => {
      throw dispatchFailure;
    });
    const loadSnapshot = vi.fn(async () => makeSnapshot([makeProject("project-other")]));

    await expect(
      createOrRecoverProjectFromPath({
        api: makeApi(dispatchCommand),
        workspaceRoot: WORKSPACE_ROOT,
        loadSnapshot,
        maxAttempts: 1,
        delayMs: 0,
      }),
    ).rejects.toBe(dispatchFailure);

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledOnce();
  });

  it("preserves a post-dispatch snapshot failure without reclassifying the command", async () => {
    const snapshotFailure = new Error("Snapshot read failed.");
    const dispatchCommand = vi.fn(async () => ({ sequence: 2 }));
    const loadSnapshot = vi.fn(async () => {
      throw snapshotFailure;
    });

    await expect(
      createOrRecoverProjectFromPath({
        api: makeApi(dispatchCommand),
        workspaceRoot: WORKSPACE_ROOT,
        loadSnapshot,
        maxAttempts: 2,
        delayMs: 0,
      }),
    ).rejects.toBe(snapshotFailure);

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledOnce();
  });

  it("preserves an unclassified create failure when the intended project did not commit", async () => {
    const dispatchFailure = new Error("Project creation was rejected.");
    const dispatchCommand = vi.fn(async () => {
      throw dispatchFailure;
    });
    const loadSnapshot = vi.fn(async () => makeSnapshot([]));

    await expect(
      createOrRecoverProjectFromPath({
        api: makeApi(dispatchCommand),
        workspaceRoot: WORKSPACE_ROOT,
        loadSnapshot,
        maxAttempts: 1,
        delayMs: 0,
      }),
    ).rejects.toBe(dispatchFailure);

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledOnce();
  });

  it("recovers the existing project when project.create reports a duplicate workspace root", async () => {
    const existingProject = makeProject("project-existing");
    const dispatchCommand = vi.fn(async () => {
      throw new Error(
        "Orchestration command invariant failed (project.create): Project 'project-existing' already uses workspace root '/Users/tester/Developer/synara'.",
      );
    });
    const loadSnapshot = vi.fn(async () => makeSnapshot([existingProject]));

    const result = await createOrRecoverProjectFromPath({
      api: makeApi(dispatchCommand),
      workspaceRoot: WORKSPACE_ROOT,
      loadSnapshot,
    });

    expect(result).toMatchObject({
      projectId: existingProject.id,
      project: existingProject,
      created: false,
      restored: false,
    });
  });

  it("restores an archived workspace owner and preserves its original project id", async () => {
    const archivedProject = makeProject("project-archived");
    let restored = false;
    const dispatchCommand = vi.fn(async (command: { type: string; projectId?: ProjectId }) => {
      if (command.type === "project.create") {
        throw new Error(
          "Orchestration command invariant failed (project.create): Project 'project-archived' is archived and reserves workspace root '/Users/tester/Developer/synara'. Restore project 'project-archived' instead of creating a new project.",
        );
      }
      restored = true;
      return { sequence: 3 };
    });
    const loadSnapshot = vi.fn(async () => makeSnapshot(restored ? [archivedProject] : []));

    const result = await createOrRecoverProjectFromPath({
      api: makeApi(dispatchCommand),
      workspaceRoot: WORKSPACE_ROOT,
      loadSnapshot,
      delayMs: 0,
    });

    expect(dispatchCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "project.unarchive",
        projectId: archivedProject.id,
      }),
    );
    expect(result).toMatchObject({
      projectId: archivedProject.id,
      project: archivedProject,
      created: false,
      restored: true,
    });
  });

  it("does not report a successful restore until the project appears in the read model", async () => {
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.create") {
        throw new Error(
          "Orchestration command invariant failed (project.create): Project 'project-archived' is archived and reserves workspace root '/Users/tester/Developer/synara'. Restore project 'project-archived' instead of creating a new project.",
        );
      }
      return { sequence: 3 };
    });
    const loadSnapshot = vi.fn(async () => makeSnapshot([]));

    await expect(
      createOrRecoverProjectFromPath({
        api: makeApi(dispatchCommand),
        workspaceRoot: WORKSPACE_ROOT,
        loadSnapshot,
        maxAttempts: 1,
        delayMs: 0,
      }),
    ).rejects.toThrow(PROJECT_CREATE_EXISTING_SYNC_ERROR);

    expect(dispatchCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "project.unarchive",
        projectId: "project-archived",
      }),
    );
    expect(loadSnapshot).toHaveBeenCalledOnce();
  });

  it("recovers the same id when another client wins the archived-project restore race", async () => {
    const archivedProject = makeProject("project-archived-race");
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.create") {
        throw new Error(
          "Orchestration command invariant failed (project.create): Project 'project-archived-race' is archived and reserves workspace root '/Users/tester/Developer/synara'. Restore project 'project-archived-race' instead of creating a new project.",
        );
      }
      throw new Error("Project 'project-archived-race' is not archived.");
    });

    const result = await createOrRecoverProjectFromPath({
      api: makeApi(dispatchCommand),
      workspaceRoot: WORKSPACE_ROOT,
      loadSnapshot: async () => makeSnapshot([archivedProject]),
      maxAttempts: 1,
      delayMs: 0,
    });

    expect(result).toMatchObject({
      projectId: archivedProject.id,
      project: archivedProject,
      created: false,
      restored: false,
    });
  });

  it("surfaces an actionable unarchive failure when the original project is still hidden", async () => {
    const dispatchCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "project.create") {
        throw new Error(
          "Orchestration command invariant failed (project.create): Project 'project-archived' is archived and reserves workspace root '/Users/tester/Developer/synara'. Restore project 'project-archived' instead of creating a new project.",
        );
      }
      throw new Error("Wait for archive session cleanup to settle before restoring this project.");
    });

    await expect(
      createOrRecoverProjectFromPath({
        api: makeApi(dispatchCommand),
        workspaceRoot: WORKSPACE_ROOT,
        loadSnapshot: async () => makeSnapshot([]),
        maxAttempts: 1,
        delayMs: 0,
      }),
    ).rejects.toThrow(/archive session cleanup/);
  });
});
