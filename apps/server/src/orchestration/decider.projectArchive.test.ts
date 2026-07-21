import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MAX_PINNED_PROJECTS,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-07-20T12:00:00.000Z";
const archivedAt = "2026-07-20T12:05:00.000Z";
const unarchivedAt = "2026-07-20T12:10:00.000Z";
const projectId = ProjectId.makeUnsafe("project-archive-test");
const threadId = ThreadId.makeUnsafe("thread-archive-test");

function event(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly aggregateKind: OrchestrationEvent["aggregateKind"];
  readonly aggregateId: string;
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.makeUnsafe(input.aggregateId)
        : ThreadId.makeUnsafe(input.aggregateId),
    type: input.type,
    occurredAt: now,
    commandId: CommandId.makeUnsafe(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

async function makeProjectWithThread(input?: {
  readonly kind?: "project" | "chat" | "studio";
  readonly isPinned?: boolean;
  readonly workspaceRoot?: string;
}): Promise<OrchestrationReadModel> {
  const withProject = await Effect.runPromise(
    projectEvent(
      createEmptyReadModel(now),
      event({
        sequence: 1,
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        payload: {
          projectId,
          kind: input?.kind ?? "project",
          title: "Archive test",
          workspaceRoot: input?.workspaceRoot ?? "C:\\work\\archive-test",
          defaultModelSelection: null,
          scripts: [],
          isPinned: input?.isPinned ?? false,
          createdAt: now,
          updatedAt: now,
        },
      }),
    ),
  );
  return Effect.runPromise(
    projectEvent(
      withProject,
      event({
        sequence: 2,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          projectId,
          title: "Preserved chat",
          modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    ),
  );
}

async function archive(readModel: OrchestrationReadModel) {
  return Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        type: "project.archive",
        commandId: CommandId.makeUnsafe("command-archive"),
        projectId,
        createdAt: archivedAt,
      },
      readModel,
    }),
  );
}

async function projectEvents(
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  let next = readModel;
  for (const nextEvent of events) {
    const sequencedEvent = {
      ...nextEvent,
      sequence: next.snapshotSequence + 1,
    } as OrchestrationEvent;
    next = await Effect.runPromise(projectEvent(next, sequencedEvent));
  }
  return next;
}

describe("project archive decider", () => {
  it("archives a sessionless regular project without pointless cleanup and preserves its child", async () => {
    const readModel = await makeProjectWithThread();
    const decided = await archive(readModel);
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((entry) => entry.type)).toEqual(["project.archived"]);
    const projected = await projectEvents(readModel, events);
    expect(projected.projects[0]?.archivedAt).toBe(archivedAt);
    expect(projected.threads.map((thread) => thread.id)).toEqual([threadId]);
  });

  it("rejects archive while the project's dev server is running", async () => {
    const readModel = await makeProjectWithThread();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.archive",
            commandId: CommandId.makeUnsafe("command-archive-active-dev-server"),
            projectId,
            createdAt: archivedAt,
          },
          readModel,
          hasActiveProjectDevServer: true,
        }),
      ),
    ).rejects.toThrow(/cannot be archived while its dev server is running/);
  });

  it.each(["starting", "running"] as const)(
    "rejects a child session in %s state",
    async (status) => {
      const readModel = await makeProjectWithThread();
      const blocked: OrchestrationReadModel = {
        ...readModel,
        threads: readModel.threads.map((thread) => ({
          ...thread,
          session: {
            threadId,
            status,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: status === "running" ? TurnId.makeUnsafe("turn-active") : null,
            lastError: null,
            updatedAt: now,
          },
        })),
      };
      await expect(archive(blocked)).rejects.toThrow(/cannot be archived while thread/);
    },
  );

  it("archives an errored session whose active turn id is stale", async () => {
    const readModel = await makeProjectWithThread();
    const staleTurnId = TurnId.makeUnsafe("turn-stale-error");
    const withErroredSession: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) => ({
        ...thread,
        session: {
          threadId,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: staleTurnId,
          lastError: "Provider failed",
          updatedAt: now,
        },
        latestTurn: {
          turnId: staleTurnId,
          state: "error",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: null,
        },
      })),
    };

    const decided = await archive(withErroredSession);
    expect((Array.isArray(decided) ? decided : [decided]).map((entry) => entry.type)).toEqual([
      "project.archived",
    ]);
  });

  it("rejects active turns, pending interactions, and durable queued/provider work", async () => {
    const readModel = await makeProjectWithThread();
    const activeTurn: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) => ({
        ...thread,
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
      })),
    };
    await expect(archive(activeTurn)).rejects.toThrow(/cannot be archived while thread/);

    const pendingApproval: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) => ({ ...thread, hasPendingApprovals: true })),
    };
    await expect(archive(pendingApproval)).rejects.toThrow(/cannot be archived while thread/);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.archive",
            commandId: CommandId.makeUnsafe("command-archive-queued"),
            projectId,
            createdAt: archivedAt,
          },
          readModel,
          pendingArchiveWorkThreadIds: new Set([threadId]),
        }),
      ),
    ).rejects.toThrow(/cannot be archived while thread/);
  });

  it("rejects enabled or unsettled automation work without deleting its definition", async () => {
    const readModel = await makeProjectWithThread();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.archive",
            commandId: CommandId.makeUnsafe("command-archive-automation"),
            projectId,
            createdAt: archivedAt,
          },
          readModel,
          hasPendingArchiveAutomationWork: true,
        }),
      ),
    ).rejects.toThrow(/Disable its automations and wait for active work to settle first/);
  });

  it.each(["idle", "ready", "interrupted"] as const)(
    "emits cleanup before archive for a %s provider session",
    async (status) => {
      const readModel = await makeProjectWithThread();
      const withSession: OrchestrationReadModel = {
        ...readModel,
        threads: readModel.threads.map((thread) => ({
          ...thread,
          session: {
            threadId,
            status,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        })),
      };
      const decided = await archive(withSession);
      expect((Array.isArray(decided) ? decided : [decided]).map((event) => event.type)).toEqual([
        "thread.session-stop-requested",
        "project.archived",
      ]);
    },
  );

  it.each(["stopped", "error"] as const)(
    "does not emit redundant cleanup for a %s provider session",
    async (status) => {
      const readModel = await makeProjectWithThread();
      const withTerminalSession: OrchestrationReadModel = {
        ...readModel,
        threads: readModel.threads.map((thread) => ({
          ...thread,
          session: {
            threadId,
            status,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: status === "error" ? "provider exited" : null,
            updatedAt: now,
          },
        })),
      };
      const decided = await archive(withTerminalSession);
      expect((Array.isArray(decided) ? decided : [decided]).map((event) => event.type)).toEqual([
        "project.archived",
      ]);
    },
  );

  it("emits cleanup only for stoppable sessions in a mixed large-project slice", async () => {
    const readModel = await makeProjectWithThread();
    const baseThread = readModel.threads[0]!;
    const statuses = [null, "stopped", "error", "idle", "ready", "interrupted"] as const;
    const mixed: OrchestrationReadModel = {
      ...readModel,
      threads: statuses.map((status, index) => {
        const id = ThreadId.makeUnsafe(`thread-archive-mixed-${index}`);
        return {
          ...baseThread,
          id,
          session:
            status === null
              ? null
              : {
                  threadId: id,
                  status,
                  providerName: "codex",
                  runtimeMode: "full-access" as const,
                  activeTurnId: null,
                  lastError: status === "error" ? "provider exited" : null,
                  updatedAt: now,
                },
        };
      }),
    };

    const decided = await archive(mixed);
    const events = Array.isArray(decided) ? decided : [decided];
    expect(events.map((event) => [event.type, event.aggregateId])).toEqual([
      ["thread.session-stop-requested", ThreadId.makeUnsafe("thread-archive-mixed-3")],
      ["thread.session-stop-requested", ThreadId.makeUnsafe("thread-archive-mixed-4")],
      ["thread.session-stop-requested", ThreadId.makeUnsafe("thread-archive-mixed-5")],
      ["project.archived", projectId],
    ]);
    const projected = await projectEvents(mixed, events);
    expect(projected.threads).toHaveLength(statuses.length);
  });

  it("rejects duplicate archive/unarchive and preserves the same id and children on restore", async () => {
    const readModel = await makeProjectWithThread();
    const archivedEvents = await archive(readModel);
    const archived = await projectEvents(
      readModel,
      Array.isArray(archivedEvents) ? archivedEvents : [archivedEvents],
    );
    await expect(archive(archived)).rejects.toThrow(/already archived/);

    const unarchiveEvent = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.unarchive",
          commandId: CommandId.makeUnsafe("command-unarchive"),
          projectId,
          createdAt: unarchivedAt,
        },
        readModel: archived,
      }),
    );
    const restored = await projectEvents(archived, [
      ...(Array.isArray(unarchiveEvent) ? unarchiveEvent : [unarchiveEvent]),
    ]);
    expect(restored.projects[0]?.id).toBe(projectId);
    expect(restored.projects[0]?.archivedAt).toBeNull();
    expect(restored.threads[0]?.projectId).toBe(projectId);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.unarchive",
            commandId: CommandId.makeUnsafe("command-unarchive-again"),
            projectId,
            createdAt: unarchivedAt,
          },
          readModel: restored,
        }),
      ),
    ).rejects.toThrow(/is not archived/);
  });

  it("rejects restore until archive-generated provider cleanup has settled", async () => {
    const readModel = await makeProjectWithThread();
    const archivedEvents = await archive(readModel);
    const archived = await projectEvents(
      readModel,
      Array.isArray(archivedEvents) ? archivedEvents : [archivedEvents],
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.unarchive",
            commandId: CommandId.makeUnsafe("command-unarchive-before-cleanup"),
            projectId,
            createdAt: unarchivedAt,
          },
          readModel: archived,
          pendingArchiveWorkThreadIds: new Set([threadId]),
        }),
      ),
    ).rejects.toThrow(/archive session cleanup have settled/);
  });

  it("reserves the canonical workspace root while archived so create restores the original id", async () => {
    const readModel = await makeProjectWithThread({ workspaceRoot: "C:\\Work\\Repo" });
    const archivedEvents = await archive(readModel);
    const archived = await projectEvents(
      readModel,
      Array.isArray(archivedEvents) ? archivedEvents : [archivedEvents],
    );
    const replacementId = ProjectId.makeUnsafe("replacement-project");
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.makeUnsafe("command-create-replacement"),
            projectId: replacementId,
            title: "Replacement",
            workspaceRoot: "C:/Work/Repo/",
            createdAt: unarchivedAt,
          },
          readModel: archived,
        }),
      ),
    ).rejects.toThrow(
      /Project 'project-archive-test' is archived and reserves workspace root 'C:\\Work\\Repo'. Restore project 'project-archive-test'/,
    );

    expect(archived.projects.map((project) => project.id)).toEqual([projectId]);
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.unarchive",
            commandId: CommandId.makeUnsafe("command-restore-reserved-root"),
            projectId,
            createdAt: unarchivedAt,
          },
          readModel: archived,
        }),
      ),
    ).resolves.toMatchObject({ type: "project.unarchived" });
  });

  it("does not count archived pins toward the active pin cap", async () => {
    const projects = Array.from({ length: MAX_PINNED_PROJECTS }, (_, index) => ({
      id: ProjectId.makeUnsafe(`archived-pin-${index}`),
      kind: "project" as const,
      title: `Archived pin ${index}`,
      workspaceRoot: `C:\\work\\archived-${index}`,
      defaultModelSelection: null,
      scripts: [],
      isPinned: true,
      createdAt: now,
      updatedAt: archivedAt,
      archivedAt,
      deletedAt: null,
    }));
    const readModel: OrchestrationReadModel = {
      ...createEmptyReadModel(now),
      projects,
    };
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.makeUnsafe("command-new-active-pin"),
            projectId: ProjectId.makeUnsafe("new-active-pin"),
            title: "New pin",
            workspaceRoot: "C:\\work\\new-active-pin",
            isPinned: true,
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("does not restore a pinned project when the active pin cap is already full", async () => {
    const readModel = await makeProjectWithThread({ isPinned: true });
    const archivedEvents = await archive(readModel);
    const archived = await projectEvents(
      readModel,
      Array.isArray(archivedEvents) ? archivedEvents : [archivedEvents],
    );
    const activePins = Array.from({ length: MAX_PINNED_PROJECTS }, (_, index) => ({
      id: ProjectId.makeUnsafe(`active-pin-${index}`),
      kind: "project" as const,
      title: `Active pin ${index}`,
      workspaceRoot: `C:\\work\\active-${index}`,
      defaultModelSelection: null,
      scripts: [],
      isPinned: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    }));
    const saturated: OrchestrationReadModel = {
      ...archived,
      projects: [...archived.projects, ...activePins],
    };
    const command = {
      type: "project.unarchive" as const,
      commandId: CommandId.makeUnsafe("command-unarchive-pinned-at-cap"),
      projectId,
      createdAt: unarchivedAt,
    };

    await expect(
      Effect.runPromise(decideOrchestrationCommand({ command, readModel: saturated })),
    ).rejects.toThrow(/Unpin another project first/);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: { ...command, commandId: CommandId.makeUnsafe("command-unarchive-pin-room") },
          readModel: {
            ...saturated,
            projects: saturated.projects.map((project) =>
              project.id === activePins[0]?.id ? { ...project, isPinned: false } : project,
            ),
          },
        }),
      ),
    ).resolves.toMatchObject({ type: "project.unarchived" });
  });

  it("blocks direct client and provider mutations under an archived parent", async () => {
    const readModel = await makeProjectWithThread();
    const archivedEvents = await archive(readModel);
    const archived = await projectEvents(
      readModel,
      Array.isArray(archivedEvents) ? archivedEvents : [archivedEvents],
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("command-hidden-thread"),
            projectId,
            threadId: ThreadId.makeUnsafe("hidden-thread"),
            title: "Hidden",
            modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          readModel: archived,
        }),
      ),
    ).rejects.toThrow(/is archived/);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("command-hidden-provider-session"),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          },
          readModel: archived,
        }),
      ),
    ).rejects.toThrow(/is archived/);

    const stoppedSettlement = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("command-archive-cleanup-settled"),
          threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        },
        readModel: archived,
      }),
    );
    const stoppedEvent = "type" in stoppedSettlement ? stoppedSettlement : stoppedSettlement[0];
    expect(stoppedEvent?.type).toBe("thread.session-set");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("command-archive-cleanup-active-turn"),
            threadId,
            session: {
              threadId,
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("still-active"),
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          },
          readModel: archived,
        }),
      ),
    ).rejects.toThrow(/is archived/);
  });

  it("retains terminal project.delete semantics after archive", async () => {
    const readModel = await makeProjectWithThread();
    const archivedEvents = await archive(readModel);
    const archived = await projectEvents(
      readModel,
      Array.isArray(archivedEvents) ? archivedEvents : [archivedEvents],
    );
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: CommandId.makeUnsafe("command-delete-archived"),
            projectId,
          },
          readModel: archived,
        }),
      ),
    ).rejects.toThrow(/still has 1 thread/);
  });
});
