import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

async function createSystem() {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-project-archive-projection-test-",
  });
  const layer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    engine: await runtime.runPromise(Effect.service(OrchestrationEngineService)),
    query: await runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    sql: await runtime.runPromise(Effect.service(SqlClient.SqlClient)),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

describe("project archive projection round-trip", () => {
  it("hides archived projects from the live shell and restores the same project and chats", async () => {
    const system = await createSystem();
    const projectId = ProjectId.makeUnsafe("project-archive-round-trip");
    const threadId = ThreadId.makeUnsafe("thread-archive-round-trip");
    const subagentThreadId = ThreadId.makeUnsafe("subagent:thread-archive-round-trip:1");
    const userMessageId = MessageId.makeUnsafe("message-user-archive-round-trip");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-archive-round-trip");
    const userMessageText = "Keep this exact user request through archive and restore.";
    const assistantMessageText = "Keep this exact assistant response through archive and restore.";
    const workspaceRoot = "C:\\work\\archive-round-trip";
    const expectedPreservedThread = {
      projectId,
      threadId,
      messages: [
        {
          id: userMessageId,
          role: "user",
          text: userMessageText,
        },
        {
          id: assistantMessageId,
          role: "assistant",
          text: assistantMessageText,
        },
      ],
    };

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-archive-round-trip"),
          projectId,
          title: "Archived project",
          workspaceRoot,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt: "2026-07-20T10:00:00.000Z",
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-archive-round-trip"),
          threadId,
          projectId,
          title: "Preserved chat",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: "2026-07-20T10:01:00.000Z",
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-subagent-archive-round-trip"),
          threadId: subagentThreadId,
          projectId,
          title: "Newer subagent",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          parentThreadId: threadId,
          subagentAgentId: "agent-1",
          branch: null,
          worktreePath: null,
          createdAt: "2026-07-20T10:02:00.000Z",
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe("cmd-messages-archive-round-trip"),
          threadId,
          messages: [
            {
              messageId: userMessageId,
              role: "user",
              text: userMessageText,
              createdAt: "2026-07-20T10:02:10.000Z",
              updatedAt: "2026-07-20T10:02:10.000Z",
            },
            {
              messageId: assistantMessageId,
              role: "assistant",
              text: assistantMessageText,
              createdAt: "2026-07-20T10:02:20.000Z",
              updatedAt: "2026-07-20T10:02:20.000Z",
            },
          ],
          createdAt: "2026-07-20T10:02:30.000Z",
        }),
      );
      const readPreservedThread = async () => {
        const detail = Option.getOrThrow(
          await system.run(system.query.getThreadDetailForExportById(threadId)),
        );
        return {
          projectId: detail.projectId,
          threadId: detail.id,
          messages: detail.messages.map(({ id, role, text }) => ({ id, role, text })),
        };
      };
      expect(await readPreservedThread()).toEqual(expectedPreservedThread);
      await system.run(
        system.engine.dispatch({
          type: "project.archive",
          commandId: CommandId.makeUnsafe("cmd-archive-round-trip"),
          projectId,
          createdAt: "2026-07-20T10:03:00.000Z",
        }),
      );
      expect(await readPreservedThread()).toEqual(expectedPreservedThread);
      const archivedShell = await system.run(system.query.getShellSnapshot());
      expect(archivedShell.projects).toEqual([]);
      expect(archivedShell.threads).toEqual([]);
      expect(Option.isNone(await system.run(system.query.getProjectShellById(projectId)))).toBe(
        true,
      );
      expect(
        Option.isNone(
          await system.run(system.query.getActiveProjectByWorkspaceRoot(workspaceRoot)),
        ),
      ).toBe(true);

      const durableSnapshot = await system.run(system.query.getSnapshot());
      expect(durableSnapshot.projects.find((project) => project.id === projectId)?.archivedAt).toBe(
        "2026-07-20T10:03:00.000Z",
      );
      expect(
        durableSnapshot.threads
          .filter((thread) => thread.projectId === projectId)
          .map((thread) => thread.id),
      ).toEqual(expect.arrayContaining([threadId, subagentThreadId]));

      expect(await system.run(system.query.listArchivedProjects())).toEqual([
        {
          id: projectId,
          kind: "project",
          title: "Archived project",
          workspaceRoot,
          archivedAt: "2026-07-20T10:03:00.000Z",
          threadCount: 1,
          latestThread: {
            id: threadId,
            title: "Preserved chat",
            updatedAt: "2026-07-20T10:02:30.000Z",
          },
        },
      ]);

      await system.run(
        system.engine.dispatch({
          type: "project.unarchive",
          commandId: CommandId.makeUnsafe("cmd-unarchive-round-trip"),
          projectId,
          createdAt: "2026-07-20T10:04:00.000Z",
        }),
      );

      const restoredShell = await system.run(system.query.getShellSnapshot());
      expect(restoredShell.projects.map((project) => project.id)).toEqual([projectId]);
      expect(restoredShell.threads.map((thread) => thread.id)).toEqual(
        expect.arrayContaining([threadId, subagentThreadId]),
      );
      expect(await readPreservedThread()).toEqual(expectedPreservedThread);
      expect(await system.run(system.query.listArchivedProjects())).toEqual([]);

      const pendingRuntimeEvents = await system.run(system.sql<{ readonly sequence: number }>`
        INSERT INTO provider_runtime_events (
          event_id, thread_id, turn_id, lifecycle_generation,
          event_type, event_json, persisted_at
        ) VALUES (
          'runtime-event-before-archive', ${threadId}, NULL, NULL,
          'session.updated', '{}', '2026-07-20T10:04:30.000Z'
        )
        RETURNING sequence
      `);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.archive",
            commandId: CommandId.makeUnsafe("cmd-archive-pending-runtime-event"),
            projectId,
            createdAt: "2026-07-20T10:04:45.000Z",
          }),
        ),
      ).rejects.toThrow(/cannot be archived while thread/);
      await system.run(system.sql`
        UPDATE provider_runtime_event_consumers
        SET last_acked_sequence = ${pendingRuntimeEvents[0]!.sequence},
            updated_at = '2026-07-20T10:04:50.000Z'
        WHERE consumer_name = 'provider-runtime-ingestion.v1'
      `);

      await system.run(system.sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled, next_run_at,
          model_selection_json, runtime_mode, interaction_mode, worktree_mode, mode,
          stop_on_error, minimum_interval_seconds, retry_policy_json, misfire_policy,
          acknowledged_risks_json, iteration_count, created_at, updated_at, archived_at
        ) VALUES (
          'automation-archive-gate', ${projectId}, 'Archive gate', 'Do work',
          '{"type":"manual"}', 1, NULL, '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required', 'approval-required', 'auto', 'standalone',
          1, 60, '{"type":"none"}', 'skip', '[]', 0,
          '2026-07-20T10:05:00.000Z', '2026-07-20T10:05:00.000Z', NULL
        )
      `);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.archive",
            commandId: CommandId.makeUnsafe("cmd-archive-enabled-automation"),
            projectId,
            createdAt: "2026-07-20T10:06:00.000Z",
          }),
        ),
      ).rejects.toThrow(/Disable its automations/);

      await system.run(system.sql`
        UPDATE automation_definitions
        SET enabled = 0, next_run_at = NULL
        WHERE automation_id = 'automation-archive-gate'
      `);
      await system.run(system.sql`
        INSERT INTO automation_runs (
          run_id, automation_id, project_id, thread_id, trigger_type, status,
          scheduled_for, permission_snapshot_json, created_at, updated_at
        ) VALUES (
          'automation-run-archive-gate', 'automation-archive-gate', ${projectId}, ${threadId},
          'manual', 'pending', '2026-07-20T10:06:00.000Z', '{}',
          '2026-07-20T10:06:00.000Z', '2026-07-20T10:06:00.000Z'
        )
      `);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.archive",
            commandId: CommandId.makeUnsafe("cmd-archive-pending-automation-run"),
            projectId,
            createdAt: "2026-07-20T10:07:00.000Z",
          }),
        ),
      ).rejects.toThrow(/active automation runs/);

      const definitions = await system.run(system.sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM automation_definitions
        WHERE automation_id = 'automation-archive-gate'
      `);
      expect(definitions[0]?.count).toBe(1);
    } finally {
      await system.dispose();
    }
  });

  it("does not expose a late archive stop settlement as a live thread shell", async () => {
    const system = await createSystem();
    const projectId = ProjectId.makeUnsafe("project-late-archive-stop");
    const threadId = ThreadId.makeUnsafe("thread-late-archive-stop");

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-late-archive-stop"),
          projectId,
          title: "Late archive stop",
          workspaceRoot: "C:\\work\\late-archive-stop",
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt: "2026-07-20T11:00:00.000Z",
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-late-archive-stop"),
          threadId,
          projectId,
          title: "Late settlement chat",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: "2026-07-20T11:01:00.000Z",
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-ready-before-late-archive-stop"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-07-20T11:02:00.000Z",
          },
          createdAt: "2026-07-20T11:02:00.000Z",
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "project.archive",
          commandId: CommandId.makeUnsafe("cmd-archive-before-late-stop"),
          projectId,
          createdAt: "2026-07-20T11:03:00.000Z",
        }),
      );

      const archivedShell = await system.run(system.query.getShellSnapshot());
      expect(archivedShell.projects).toEqual([]);
      expect(archivedShell.threads).toEqual([]);

      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-stopped-after-archive-snapshot"),
          threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-07-20T11:04:00.000Z",
          },
          createdAt: "2026-07-20T11:04:00.000Z",
        }),
      );

      expect(Option.isNone(await system.run(system.query.getThreadShellById(threadId)))).toBe(true);
      expect(
        Option.isNone(await system.run(system.query.getThreadDetailSnapshotById(threadId))),
      ).toBe(true);
      const durableThread = await system.run(system.query.getThreadDetailById(threadId));
      expect(Option.getOrUndefined(durableThread)?.session?.status).toBe("stopped");
      const settledArchivedShell = await system.run(system.query.getShellSnapshot());
      expect(settledArchivedShell.projects).toEqual([]);
      expect(settledArchivedShell.threads).toEqual([]);
    } finally {
      await system.dispose();
    }
  });
});
