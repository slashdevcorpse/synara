import { ApprovalRequestId, EventId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderRequestAdmissionRepositoryLive } from "../Layers/ProviderRequestAdmissions.ts";
import { ProviderRequestAdmissionRepository } from "../Services/ProviderRequestAdmissions.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProviderRequestAdmissionsMigration from "./074_ProviderRequestAdmissions.ts";

const layer = it.layer(
  ProviderRequestAdmissionRepositoryLive.pipe(
    Layer.provideMerge(Layer.mergeAll(NodeSqliteClient.layerMemory())),
  ),
);

layer("074_ProviderRequestAdmissions", (it) => {
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
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES
        (
          'activity-upgrade-pending-missing-generation', ${threadId}, 'approval',
          'approval.requested', 'Approval requested with no generation',
          ${JSON.stringify({
            requestId: "request-upgrade-pending",
            requestType: "wrong_missing_generation",
          })},
          '2026-07-20T12:00:04.000Z'
        ),
        (
          'activity-upgrade-pending-wrong-generation', ${threadId}, 'approval',
          'approval.requested', 'Approval requested with another generation',
          ${JSON.stringify({
            requestId: "request-upgrade-pending",
            requestType: "wrong_other_generation",
            lifecycleGeneration: "generation-other",
          })},
          '2026-07-20T12:00:05.000Z'
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
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES
        (
          'activity-generation-absent-match', ${parentThreadId}, 'approval',
          'approval.requested', 'Approval requested without a generation',
          ${JSON.stringify({
            requestId: "request-generation-absent",
            requestType: "absent_generation_match",
          })},
          '2026-07-20T13:00:01.000Z'
        ),
        (
          'activity-generation-absent-wrong', ${parentThreadId}, 'approval',
          'approval.requested', 'Approval requested with a generation',
          ${JSON.stringify({
            requestId: "request-generation-absent",
            requestType: "wrong_present_generation",
            lifecycleGeneration: "generation-present",
          })},
          '2026-07-20T13:00:02.000Z'
        ),
        (
          'activity-generation-absent-teardown', ${parentThreadId}, 'approval',
          'user-input.requested', 'User input requested without a generation',
          ${JSON.stringify({
            requestId: "request-generation-absent-teardown",
            requestType: "structured_user_input",
          })},
          '2026-07-20T13:00:02.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_pending_interactions (
          interaction_kind, request_id, thread_id, lifecycle_generation,
          status, response_requested_at, created_at
        ) VALUES
        (
          'approval', 'request-generation-absent', ${parentThreadId}, NULL,
          'pending', NULL, '2026-07-20T13:00:03.000Z'
        ),
        (
          'userInput', 'request-generation-absent-teardown', ${parentThreadId}, NULL,
          'pending', NULL, '2026-07-20T13:00:04.000Z'
        )
      `;
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
        [73, "ProjectionProjectsArchivedAt"],
        [74, "ProviderRequestAdmissions"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

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

      const absentGenerationHydrated = yield* sql<{
        readonly requestType: string | null;
        readonly openedEventId: string;
      }>`
        SELECT
          request_type AS "requestType",
          opened_event_id AS "openedEventId"
        FROM provider_request_admissions
        WHERE thread_id = ${parentThreadId}
          AND request_id = 'request-generation-absent'
      `;
      assert.deepStrictEqual(absentGenerationHydrated, [
        {
          requestType: "absent_generation_match",
          openedEventId: "activity-generation-absent-match",
        },
      ]);

      const legacyHydrated = yield* sql<{
        readonly requestId: string;
        readonly lifecycleGeneration: string;
      }>`
        SELECT
          request_id AS "requestId",
          lifecycle_generation AS "lifecycleGeneration"
        FROM provider_request_admissions
        WHERE thread_id = ${parentThreadId}
          AND request_id IN (
            'request-generation-absent',
            'request-generation-absent-teardown'
          )
        ORDER BY request_id ASC
      `;
      assert.deepStrictEqual(legacyHydrated, [
        {
          requestId: "request-generation-absent",
          lifecycleGeneration: "legacy",
        },
        {
          requestId: "request-generation-absent-teardown",
          lifecycleGeneration: "legacy",
        },
      ]);

      const legacyCapacityFillResults = [];
      for (let index = 0; index < 8; index++) {
        legacyCapacityFillResults.push(
          yield* admissions.admit({
            threadId: parentThreadId,
            providerSessionThreadId: parentThreadId,
            interactionKind: "approval",
            requestId: ApprovalRequestId.makeUnsafe(`request-legacy-capacity-${index}`),
            lifecycleGeneration: "generation-capacity",
            provider: "opencode",
            requestType: "command_execution_approval",
            eventId: EventId.makeUnsafe(`event-legacy-capacity-${index}`),
            createdAt: `2026-07-20T13:00:${String(10 + index).padStart(2, "0")}.000Z`,
          }),
        );
      }
      assert.deepStrictEqual(
        legacyCapacityFillResults.map((result) => result._tag),
        Array.from({ length: 8 }, () => "Accepted"),
      );
      assert.deepStrictEqual(
        yield* admissions.admit({
          threadId: parentThreadId,
          providerSessionThreadId: parentThreadId,
          interactionKind: "approval",
          requestId: ApprovalRequestId.makeUnsafe("request-legacy-capacity-overflow"),
          lifecycleGeneration: "generation-capacity",
          provider: "opencode",
          requestType: "command_execution_approval",
          eventId: EventId.makeUnsafe("event-legacy-capacity-overflow"),
          createdAt: "2026-07-20T13:00:18.000Z",
        }),
        { _tag: "Overflow" },
      );

      const legacyResolutionEventId = EventId.makeUnsafe("event-generation-absent-resolved");
      const legacyResolution = yield* admissions.beginResolution({
        threadId: parentThreadId,
        interactionKind: "approval",
        requestId: ApprovalRequestId.makeUnsafe("request-generation-absent"),
        eventId: legacyResolutionEventId,
        resolvedAt: "2026-07-20T13:01:00.000Z",
      });
      assert.deepStrictEqual(legacyResolution, { _tag: "Project" });
      yield* admissions.markResolutionProjected({
        threadId: parentThreadId,
        interactionKind: "approval",
        requestId: ApprovalRequestId.makeUnsafe("request-generation-absent"),
        eventId: legacyResolutionEventId,
        updatedAt: "2026-07-20T13:01:01.000Z",
      });

      const legacyTeardownEventId = EventId.makeUnsafe("event-generation-absent-exited");
      const legacyTerminalRecords = yield* admissions.beginTerminalTeardown({
        providerSessionThreadId: parentThreadId,
        lifecycleGeneration: "legacy",
        eventId: legacyTeardownEventId,
        occurredAt: "2026-07-20T13:01:02.000Z",
      });
      assert.deepStrictEqual(
        legacyTerminalRecords.map((record) => ({
          requestId: record.requestId,
          lifecycleGeneration: record.lifecycleGeneration,
        })),
        [
          {
            requestId: "request-generation-absent-teardown",
            lifecycleGeneration: "legacy",
          },
        ],
      );
      yield* admissions.markTerminalProjected({
        threadId: parentThreadId,
        interactionKind: "userInput",
        requestId: ApprovalRequestId.makeUnsafe("request-generation-absent-teardown"),
        lifecycleGeneration: "legacy",
        eventId: legacyTeardownEventId,
        updatedAt: "2026-07-20T13:01:03.000Z",
      });

      const settledLegacyRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
      }>`
        SELECT request_id AS "requestId", status
        FROM provider_request_admissions
        WHERE thread_id = ${parentThreadId}
          AND request_id IN (
            'request-generation-absent',
            'request-generation-absent-teardown'
          )
        ORDER BY request_id ASC
      `;
      assert.deepStrictEqual(settledLegacyRows, [
        { requestId: "request-generation-absent", status: "resolved" },
        { requestId: "request-generation-absent-teardown", status: "cancelled" },
      ]);

      const releasedLegacyCapacityResults = [];
      for (let index = 8; index < 10; index++) {
        releasedLegacyCapacityResults.push(
          yield* admissions.admit({
            threadId: parentThreadId,
            providerSessionThreadId: parentThreadId,
            interactionKind: "approval",
            requestId: ApprovalRequestId.makeUnsafe(`request-legacy-capacity-${index}`),
            lifecycleGeneration: "generation-capacity",
            provider: "opencode",
            requestType: "command_execution_approval",
            eventId: EventId.makeUnsafe(`event-legacy-capacity-${index}`),
            createdAt: `2026-07-20T13:01:0${index}.000Z`,
          }),
        );
      }
      assert.deepStrictEqual(
        releasedLegacyCapacityResults.map((result) => result._tag),
        ["Accepted", "Accepted"],
      );

      yield* ProviderRequestAdmissionsMigration;
      const legacyRowsAfterRerun = yield* sql<{
        readonly requestId: string;
        readonly status: string;
      }>`
        SELECT request_id AS "requestId", status
        FROM provider_request_admissions
        WHERE thread_id = ${parentThreadId}
          AND request_id IN (
            'request-generation-absent',
            'request-generation-absent-teardown'
          )
        ORDER BY request_id ASC
      `;
      assert.deepStrictEqual(legacyRowsAfterRerun, settledLegacyRows);

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
