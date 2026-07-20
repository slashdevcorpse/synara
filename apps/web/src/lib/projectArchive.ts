// FILE: projectArchive.ts
// Purpose: Dispatches project archive and restore commands without deletion semantics.
// Layer: Web orchestration helper
// Exports: archiveProjectFromClient and unarchiveProjectFromClient

import type { NativeApi, ProjectId } from "@synara/contracts";

import { newCommandId } from "./utils";

type ProjectCommandDispatcher = Pick<NativeApi["orchestration"], "dispatchCommand">;

export function archiveProjectFromClient(
  api: ProjectCommandDispatcher,
  projectId: ProjectId,
): Promise<{ sequence: number }> {
  return api.dispatchCommand({
    type: "project.archive",
    commandId: newCommandId(),
    projectId,
    createdAt: new Date().toISOString(),
  });
}

export function unarchiveProjectFromClient(
  api: ProjectCommandDispatcher,
  projectId: ProjectId,
): Promise<{ sequence: number }> {
  return api.dispatchCommand({
    type: "project.unarchive",
    commandId: newCommandId(),
    projectId,
    createdAt: new Date().toISOString(),
  });
}
