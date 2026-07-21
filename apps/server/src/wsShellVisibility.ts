import type { OrchestrationEvent, OrchestrationShellStreamEvent } from "@synara/contracts";

type ProjectVisibilityEvent = Extract<
  OrchestrationEvent,
  { type: "project.archived" | "project.unarchived" }
>;

export function isProjectVisibilityEvent(
  event: OrchestrationEvent,
): event is ProjectVisibilityEvent {
  return event.type === "project.archived" || event.type === "project.unarchived";
}

export function toProjectVisibilityShellEvent(
  event: ProjectVisibilityEvent,
): Extract<OrchestrationShellStreamEvent, { kind: "snapshot-invalidated" }> {
  return {
    kind: "snapshot-invalidated",
    sequence: event.sequence,
    reason: "project-visibility-changed",
  };
}
