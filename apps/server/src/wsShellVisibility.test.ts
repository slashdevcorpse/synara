import type { OrchestrationEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { isProjectVisibilityEvent, toProjectVisibilityShellEvent } from "./wsShellVisibility";

const visibilityEvent = (type: "project.archived" | "project.unarchived", sequence: number) =>
  ({ type, sequence }) as Extract<OrchestrationEvent, { type: typeof type }>;

describe("workspace shell visibility events", () => {
  it.each(["project.archived", "project.unarchived"] as const)(
    "maps %s to a non-tombstoning snapshot invalidation",
    (type) => {
      const event = visibilityEvent(type, 42);

      expect(isProjectVisibilityEvent(event)).toBe(true);
      expect(toProjectVisibilityShellEvent(event)).toEqual({
        kind: "snapshot-invalidated",
        sequence: 42,
        reason: "project-visibility-changed",
      });
      expect(toProjectVisibilityShellEvent(event).kind).not.toBe("project-removed");
    },
  );
});
