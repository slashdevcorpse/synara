// FILE: projectVisibility.ts
// Purpose: Defines durable project visibility consistently across web projections and recovery.
// Exports: Predicate for active projects from orchestration read models.

import type { OrchestrationProject } from "@synara/contracts";

export function isActiveReadModelProject(
  project: Pick<OrchestrationProject, "deletedAt" | "archivedAt">,
): boolean {
  return project.deletedAt === null && (project.archivedAt ?? null) === null;
}
