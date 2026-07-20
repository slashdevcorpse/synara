import { ApprovalRequestId, EventId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderRequestAdmissionRepositoryLive } from "../Layers/ProviderRequestAdmissions.ts";
import { ProviderRequestAdmissionRepository } from "../Services/ProviderRequestAdmissions.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(
  ProviderRequestAdmissionRepositoryLive.pipe(
    Layer.provideMerge(Layer.mergeAll(NodeSqliteClient.layerMemory())),
  ),
);

layer("073_ProviderRequestAdmissions", (it) => {
  it.effect("hydrates unresolved v69 interactions and counts them against the hard cap", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const admissions = yield* ProviderRequestAdmissionRepository;
      const threadId = ThreadId.makeUnsafe("thread-upgrade-admissions");
      const parentThreadId = ThreadId.makeUnsafe("thread-upgrade-parent");
      const childThreadId = ThreadId.makeUnsafe(
        "subagent:thread-upgrade-parent:child-provider-thread",
      );
      const wildcardParentThreadId = ThreadId.makeUnsafe("Case_Parent%");
      const caseCollisionParentThreadId = ThreadId.makeUnsafe("case_parent%");
      const wildcardChildThreadId = ThreadId.makeUnsafe("subagent:Case_Parent%:wildcard-child");
      const shortNestedParentThreadId = ThreadId.makeUnsafe("nested");
      const nestedParentThreadId = ThreadId.makeUnsafe("nested:parent");
      const nestedChildThreadId = ThreadId.makeUnsafe("subagent:nested:parent:nested-child");
      yield* runMigrations({ toMigrationInclusive: 69 });

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, updated_at, runtime_mode
        ) VALUES (
          ${threadId}, 'running', 'claudeAgent', '2026-07-20T12:00:00.000Z', 'approval-required'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'activity-upgrade-pending', ${threadId}, 'approval', 'approval.requested',
          'Approval requested',
          ${JSON.stringify({
            requestId: "request-upgrade-pending",
            requestType: "command_execution_approval",
            lifecycleGeneration: "generation-upgrade",
          })},
          '2026-07-20T12:00:01.000Z'
        )
      `;

      for (const row of [
        ["approval", "request-upgrade-pending", "pending"],
        ["userInput", "request-upgrade-responding", "responding"],
        ["approval", "request-upgrade-retryable", "retryable"],
        ["approval", "request-upgrade-uncertain", "uncertain"],
        ["approval", "request-upgrade-confirmed", "confirmed"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_pending_interactions (
            interaction_kind, request_id, thread_id, lifecycle_generation,
            status, response_requested_at, created_at
          ) VALUES (
            ${row[0]}, ${row[1]}, ${threadId}, 'generation-upgrade', ${row[2]},
            ${row[2] === "responding" ? "2026-07-20T12:00:03.000Z" : null},
            '2026-07-20T12:00:02.000Z'
          )
        `;
      }

      for (const [syntheticThreadId, createdAt] of [
        [parentThreadId, "2026-07-20T13:00:00.000Z"],
        [childThreadId, "2026-07-20T13:00:00.000Z"],
        [wildcardParentThreadId, "2026-07-20T13:00:00.000Z"],
        [caseCollisionParentThreadId, "2026-07-20T12:59:00.000Z"],
        [wildcardChildThreadId, "2026-07-20T13:00:00.000Z"],
        [shortNestedParentThreadId, "2026-07-20T12:58:00.000Z"],
        [nestedParentThreadId, "2026-07-20T13:00:00.000Z"],
        [nestedChildThreadId, "2026-07-20T13:00:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, env_mode, created_at, updated_at, deleted_at
          ) VALUES (
            ${syntheticThreadId}, 'project-upgrade-parent', ${syntheticThreadId},
            '{"provider":"opencode","model":"openai/gpt-5.4"}',
            'approval-required', 'default', 'local',
            ${createdAt}, ${createdAt}, NULL
          )
        `;
      }
      for (const sessionThreadId of [
        parentThreadId,
        wildcardParentThreadId,
        nestedParentThreadId,
      ]) {
        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, updated_at, runtime_mode
        ) VALUES (
          ${sessionThreadId}, 'running', 'opencode',
          '2026-07-20T13:00:00.000Z', 'approval-required'
        )
        `;
      }
      for (const [requestId, syntheticChildThreadId] of [
        ["request-synthetic-child", childThreadId],
        ["request-wildcard-child", wildcardChildThreadId],
        ["request-nested-child", nestedChildThreadId],
      ] as const) {
        yield* sql`
          INSERT INTO projection_pending_interactions (
            interaction_kind, request_id, thread_id, lifecycle_generation,
            status, response_requested_at, created_at
          ) VALUES (
            'approval', ${requestId}, ${syntheticChildThreadId}, 'generation-parent',
            'pending', NULL, '2026-07-20T13:00:01.000Z'
          )
        `;
      }

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [70, "AgentGatewayOperations"],
        [71, "ProjectionThreadsGatewayProvenance"],
        [72, "AgentGatewayOperationRetention"],
        [73, "ProviderRequestAdmissions"],
      ]);

      const hydrated = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly provider: string;
        readonly requestType: string | null;
        readonly openedEventId: string;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          provider,
          request_type AS "requestType",
          opened_event_id AS "openedEventId"
        FROM provider_request_admissions
        WHERE thread_id = ${threadId}
        ORDER BY request_id ASC
      `;
      assert.deepStrictEqual(
        hydrated.map((row) => row.requestId),
        [
          "request-upgrade-pending",
          "request-upgrade-responding",
          "request-upgrade-retryable",
          "request-upgrade-uncertain",
        ],
      );
      assert.isTrue(hydrated.every((row) => row.status === "open"));
      assert.isTrue(hydrated.every((row) => row.provider === "claudeAgent"));
      assert.deepStrictEqual(hydrated[0], {
        requestId: "request-upgrade-pending",
        status: "open",
        provider: "claudeAgent",
        requestType: "command_execution_approval",
        openedEventId: "activity-upgrade-pending",
      });

      const freshResults = [];
      for (let index = 0; index < 7; index++) {
        freshResults.push(
          yield* admissions.admit({
            threadId,
            providerSessionThreadId: threadId,
            interactionKind: "approval",
            requestId: ApprovalRequestId.makeUnsafe(`request-upgrade-fresh-${index}`),
            lifecycleGeneration: "generation-upgrade",
            provider: "codex",
            requestType: "command_execution_approval",
            eventId: EventId.makeUnsafe(`event-upgrade-fresh-${index}`),
            createdAt: `2026-07-20T12:01:0${index}.000Z`,
          }),
        );
      }
      assert.deepStrictEqual(
        freshResults.map((result) => result._tag),
        ["Accepted", "Accepted", "Accepted", "Accepted", "Accepted", "Accepted", "Overflow"],
      );

      const rows = yield* sql<{
        readonly providerSessionThreadId: string;
        readonly provider: string;
      }>`
        SELECT
          provider_session_thread_id AS "providerSessionThreadId",
          provider
        FROM provider_request_admissions
        WHERE thread_id IN (${childThreadId}, ${wildcardChildThreadId}, ${nestedChildThreadId})
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { providerSessionThreadId: wildcardParentThreadId, provider: "opencode" },
        { providerSessionThreadId: nestedParentThreadId, provider: "opencode" },
        { providerSessionThreadId: parentThreadId, provider: "opencode" },
      ]);

      const terminalRecords = yield* admissions.beginTerminalTeardown({
        providerSessionThreadId: parentThreadId,
        lifecycleGeneration: "generation-parent",
        eventId: EventId.makeUnsafe("event-parent-exited"),
        occurredAt: "2026-07-20T13:01:00.000Z",
      });
      assert.deepStrictEqual(terminalRecords.map((record) => record.threadId).sort(), [
        childThreadId,
      ]);
    }),
  );
});
