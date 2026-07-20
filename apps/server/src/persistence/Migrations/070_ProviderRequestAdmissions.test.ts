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

layer("070_ProviderRequestAdmissions", (it) => {
  it.effect("hydrates unresolved v69 interactions and counts them against the hard cap", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const admissions = yield* ProviderRequestAdmissionRepository;
      const threadId = ThreadId.makeUnsafe("thread-upgrade-admissions");
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

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [[70, "ProviderRequestAdmissions"]]);

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
    }),
  );
});
