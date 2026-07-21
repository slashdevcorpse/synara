// FILE: projectArchive.ts
// Purpose: Dispatches project archive and restore commands without deletion semantics.
// Layer: Web orchestration helper
// Exports: archiveProjectFromClient and unarchiveProjectFromClient

import type { NativeApi, ProjectId } from "@synara/contracts";

import { newCommandId } from "./utils";

type ProjectCommandDispatcher = Pick<NativeApi["orchestration"], "dispatchCommand">;

function dispatchProjectArchiveCommand(
  api: ProjectCommandDispatcher,
  projectId: ProjectId,
  type: "project.archive" | "project.unarchive",
): Promise<{ sequence: number }> {
  return api.dispatchCommand({
    type,
    commandId: newCommandId(),
    projectId,
    createdAt: new Date().toISOString(),
  });
}

export function archiveProjectFromClient(
  api: ProjectCommandDispatcher,
  projectId: ProjectId,
): Promise<{ sequence: number }> {
  return dispatchProjectArchiveCommand(api, projectId, "project.archive");
}

export function unarchiveProjectFromClient(
  api: ProjectCommandDispatcher,
  projectId: ProjectId,
): Promise<{ sequence: number }> {
  return dispatchProjectArchiveCommand(api, projectId, "project.unarchive");
}
