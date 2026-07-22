// FILE: projectCreation.ts
// Purpose: Shared project-create flow for UI entrypoints that need duplicate recovery.
// Layer: Web orchestration helper
// Exports: createOrRecoverProjectFromPath

import { type NativeApi, type OrchestrationShellSnapshot, type ProjectId } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";

import {
  extractArchivedProjectCreateProjectId,
  extractDuplicateProjectCreateProjectId,
  isArchivedProjectCreateError,
  isDuplicateProjectCreateError,
  waitForRecoverableProjectForDuplicateCreate,
  waitForRecoverableProjectInReadModel,
} from "./projectCreateRecovery";
import { newCommandId, newProjectId } from "./utils";
import { unarchiveProjectFromClient } from "./projectArchive";

const DEFAULT_PROJECT_CREATE_RECOVERY_MAX_ATTEMPTS = 6;
const DEFAULT_PROJECT_CREATE_RECOVERY_DELAY_MS = 50;
export const PROJECT_CREATE_EXISTING_SYNC_ERROR =
  "This folder is already linked, but the existing project has not synced into the sidebar yet. Try again in a moment.";
export const PROJECT_CREATE_SYNC_ERROR =
  "The project was created, but it has not synced into Synara yet. Try again in a moment.";

function buildProjectTitleFromWorkspaceRoot(workspaceRoot: string): string {
  return workspaceRoot.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? workspaceRoot;
}

// Creates a project row for a folder, recovering the existing server project when
// the create command races an already-linked workspace root.
export async function createOrRecoverProjectFromPath(input: {
  api: NativeApi;
  workspaceRoot: string;
  createIfMissing?: boolean;
  loadSnapshot: () => Promise<OrchestrationShellSnapshot | null>;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<{
  projectId: ProjectId;
  project: OrchestrationShellSnapshot["projects"][number] | null;
  snapshot: OrchestrationShellSnapshot | null;
  created: boolean;
  restored: boolean;
}> {
  const workspaceRoot = input.workspaceRoot.trim();
  if (!workspaceRoot) {
    throw new Error("Project folder path is empty.");
  }

  const maxAttempts = input.maxAttempts ?? DEFAULT_PROJECT_CREATE_RECOVERY_MAX_ATTEMPTS;
  const delayMs = input.delayMs ?? DEFAULT_PROJECT_CREATE_RECOVERY_DELAY_MS;
  const projectId = newProjectId();
  const createdAt = new Date().toISOString();
  const title = buildProjectTitleFromWorkspaceRoot(workspaceRoot);

  let dispatchFailure: { readonly error: unknown } | null = null;
  try {
    await input.api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      kind: "project",
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: input.createIfMissing === true,
      defaultModelSelection: {
        provider: "codex",
        model: getDefaultModel("codex"),
      },
      createdAt,
    });
  } catch (error) {
    dispatchFailure = { error };
  }

  if (dispatchFailure === null) {
    const { project, snapshot } = await waitForRecoverableProjectInReadModel({
      projectId,
      loadSnapshot: input.loadSnapshot,
      maxAttempts,
      delayMs,
    });
    return {
      projectId,
      project,
      snapshot,
      created: true,
      restored: false,
    };
  }

  const { error } = dispatchFailure;
  const description =
    error instanceof Error ? error.message : "An error occurred while adding the project.";
  if (!isArchivedProjectCreateError(description) && !isDuplicateProjectCreateError(description)) {
    // The command can commit immediately before its WebSocket response is interrupted.
    // Resolve that uncertain outcome by observing the exact intended id; never replay the
    // mutation, and preserve the original failure when no committed row appears.
    const committed = await waitForRecoverableProjectInReadModel({
      projectId,
      loadSnapshot: input.loadSnapshot,
      maxAttempts,
      delayMs,
    });
    if (committed.project && committed.snapshot) {
      return {
        projectId,
        project: committed.project,
        snapshot: committed.snapshot,
        created: true,
        restored: false,
      };
    }
    throw error instanceof Error ? error : new Error(description, { cause: error });
  }

  if (isArchivedProjectCreateError(description)) {
    const archivedProjectId = extractArchivedProjectCreateProjectId(
      description,
    ) as ProjectId | null;
    if (!archivedProjectId) {
      throw error instanceof Error ? error : new Error(description, { cause: error });
    }

    try {
      await unarchiveProjectFromClient(input.api.orchestration, archivedProjectId);
    } catch (restoreError) {
      // Another client may have restored the project after our create was rejected.
      // Recover that active row if it has appeared; otherwise preserve the real
      // unarchive failure (pending cleanup, pin cap, etc.) for an actionable UI error.
      const raced = await waitForRecoverableProjectInReadModel({
        projectId: archivedProjectId,
        loadSnapshot: input.loadSnapshot,
        maxAttempts,
        delayMs,
      });
      if (raced.project && raced.snapshot) {
        return {
          projectId: archivedProjectId,
          project: raced.project,
          snapshot: raced.snapshot,
          created: false,
          restored: false,
        };
      }
      throw restoreError;
    }

    const restored = await waitForRecoverableProjectInReadModel({
      projectId: archivedProjectId,
      loadSnapshot: input.loadSnapshot,
      maxAttempts,
      delayMs,
    });
    if (!restored.project || !restored.snapshot) {
      throw new Error(PROJECT_CREATE_EXISTING_SYNC_ERROR, { cause: error });
    }
    return {
      projectId: archivedProjectId,
      project: restored.project,
      snapshot: restored.snapshot,
      created: false,
      restored: true,
    };
  }

  const { project, snapshot } = await waitForRecoverableProjectForDuplicateCreate({
    message: description,
    workspaceRoot,
    loadSnapshot: input.loadSnapshot,
    maxAttempts,
    delayMs,
  });
  if (project && snapshot) {
    return {
      projectId: project.id,
      project,
      snapshot,
      created: false,
      restored: false,
    };
  }

  const duplicateProjectId = extractDuplicateProjectCreateProjectId(description);
  if (duplicateProjectId) {
    return {
      projectId: duplicateProjectId as ProjectId,
      project: null,
      snapshot,
      created: false,
      restored: false,
    };
  }

  throw new Error(PROJECT_CREATE_EXISTING_SYNC_ERROR, { cause: error });
}
