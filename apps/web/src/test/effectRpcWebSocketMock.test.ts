import { ProjectId, ThreadId, type OrchestrationReadModel } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { createShellSnapshotFromReadModel } from "./effectRpcWebSocketMock";

describe("Effect RPC WebSocket shell mock", () => {
  it("filters archived projects and every child thread from durable snapshots", () => {
    const projectId = ProjectId.makeUnsafe("project-archived-mock");
    const threadId = ThreadId.makeUnsafe("thread-archived-mock");
    const durableSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-07-20T12:00:00.000Z",
      projects: [
        {
          id: projectId,
          kind: "project",
          title: "Archived mock project",
          workspaceRoot: "/tmp/archived-mock",
          defaultModelSelection: null,
          scripts: [],
          isPinned: false,
          createdAt: "2026-07-20T10:00:00.000Z",
          updatedAt: "2026-07-20T11:00:00.000Z",
          archivedAt: "2026-07-20T12:00:00.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: threadId,
          projectId,
          deletedAt: null,
        },
      ],
    } as unknown as OrchestrationReadModel;

    const shellSnapshot = createShellSnapshotFromReadModel(durableSnapshot);

    expect(shellSnapshot.projects).toEqual([]);
    expect(shellSnapshot.threads).toEqual([]);
    expect(shellSnapshot.snapshotSequence).toBe(7);
  });
});
