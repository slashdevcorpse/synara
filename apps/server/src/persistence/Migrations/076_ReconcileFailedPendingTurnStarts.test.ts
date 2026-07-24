import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ReconcileFailedPendingTurnStartsMigration from "./076_ReconcileFailedPendingTurnStarts.ts";

const PROVIDER_COMMAND_REACTOR_CONSUMER = "provider-command-reactor.v1";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("076_ReconcileFailedPendingTurnStarts", (it) => {
  it.effect("removes only causally proven failed pending starts without rewriting events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });

      assert.deepStrictEqual(migrationEntries.at(-1)?.slice(0, 2), [
        76,
        "ReconcileFailedPendingTurnStarts",
      ]);

      const streamVersions = new Map<string, number>();
      const appendEvent = (input: {
        readonly suffix: string;
        readonly threadId: string;
        readonly eventType: string;
        readonly occurredAt: string;
        readonly payload: Readonly<Record<string, unknown>>;
      }) =>
        Effect.gen(function* () {
          const streamVersion = (streamVersions.get(input.threadId) ?? 0) + 1;
          streamVersions.set(input.threadId, streamVersion);
          yield* sql`
            INSERT INTO orchestration_events (
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json
            ) VALUES (
              ${`event-${input.suffix}`},
              'thread',
              ${input.threadId},
              ${streamVersion},
              ${input.eventType},
              ${input.occurredAt},
              ${`command-${input.suffix}`},
              NULL,
              ${`command-${input.suffix}`},
              'system',
              ${JSON.stringify(input.payload)},
              '{}'
            )
          `;
          const rows = yield* sql<{ readonly sequence: number }>`
            SELECT sequence
            FROM orchestration_events
            WHERE event_id = ${`event-${input.suffix}`}
          `;
          assert.strictEqual(rows.length, 1);
          return rows[0]!.sequence;
        });

      const appendTurnStart = (input: {
        readonly suffix: string;
        readonly threadId: string;
        readonly messageId: string;
        readonly createdAt: string;
      }) =>
        appendEvent({
          suffix: input.suffix,
          threadId: input.threadId,
          eventType: "thread.turn-start-requested",
          occurredAt: input.createdAt,
          payload: {
            threadId: input.threadId,
            messageId: input.messageId,
            runtimeMode: "approval-required",
            createdAt: input.createdAt,
          },
        });

      const appendStartFailure = (input: {
        readonly suffix: string;
        readonly threadId: string;
        readonly sourceCreatedAt: string;
        readonly messageId?: string;
      }) =>
        appendEvent({
          suffix: input.suffix,
          threadId: input.threadId,
          eventType: "thread.activity-appended",
          occurredAt: input.sourceCreatedAt,
          payload: {
            threadId: input.threadId,
            activity: {
              id: `activity-${input.suffix}`,
              tone: "error",
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              payload: {
                detail: "provider start failed",
                ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
              },
              turnId: null,
              createdAt: input.sourceCreatedAt,
            },
          },
        });

      const appendTerminalError = (input: {
        readonly suffix: string;
        readonly threadId: string;
        readonly sourceCreatedAt: string;
      }) =>
        appendEvent({
          suffix: input.suffix,
          threadId: input.threadId,
          eventType: "thread.session-set",
          occurredAt: input.sourceCreatedAt,
          payload: {
            threadId: input.threadId,
            session: {
              threadId: input.threadId,
              status: "error",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: "provider start failed",
              updatedAt: input.sourceCreatedAt,
            },
          },
        });

      const insertDelivery = (input: {
        readonly eventSequence: number;
        readonly threadId: string;
        readonly state: "retry" | "succeeded";
        readonly completedAt: string | null;
        readonly attemptCount?: number;
      }) =>
        sql`
          INSERT INTO orchestration_event_deliveries (
            consumer_name,
            event_sequence,
            thread_id,
            state,
            claim_owner,
            claimed_at,
            claim_expires_at,
            attempt_count,
            last_error,
            completed_at,
            updated_at
          ) VALUES (
            ${PROVIDER_COMMAND_REACTOR_CONSUMER},
            ${input.eventSequence},
            ${input.threadId},
            ${input.state},
            NULL,
            NULL,
            NULL,
            ${input.attemptCount ?? 1},
            ${input.state === "succeeded" ? null : "retryable failure"},
            ${input.completedAt},
            '2026-07-24T13:00:00.000Z'
          )
        `;

      const insertPendingTurn = (input: {
        readonly threadId: string;
        readonly messageId: string;
        readonly requestedAt: string;
      }) =>
        sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            pending_message_id,
            assistant_message_id,
            state,
            requested_at,
            started_at,
            completed_at,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json
          ) VALUES (
            ${input.threadId},
            NULL,
            ${input.messageId},
            NULL,
            'pending',
            ${input.requestedAt},
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
        `;

      const insertConcreteTurn = (input: {
        readonly threadId: string;
        readonly messageId: string;
        readonly turnId: string;
        readonly requestedAt: string;
      }) =>
        sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            pending_message_id,
            assistant_message_id,
            state,
            requested_at,
            started_at,
            completed_at,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json
          ) VALUES (
            ${input.threadId},
            ${input.turnId},
            ${input.messageId},
            NULL,
            'error',
            ${input.requestedAt},
            ${input.requestedAt},
            ${input.requestedAt},
            NULL,
            NULL,
            NULL,
            '[]'
          )
        `;

      const legacyThread = "thread-proven-legacy-failure";
      const legacyMessage = "message-proven-legacy-failure";
      const legacyAt = "2026-07-24T12:00:00.000Z";
      const legacyStartSequence = yield* appendTurnStart({
        suffix: "proven-legacy-start",
        threadId: legacyThread,
        messageId: legacyMessage,
        createdAt: legacyAt,
      });
      yield* insertDelivery({
        eventSequence: legacyStartSequence,
        threadId: legacyThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:00:01.000Z",
      });
      yield* appendStartFailure({
        suffix: "proven-legacy-failure",
        threadId: legacyThread,
        sourceCreatedAt: legacyAt,
      });
      yield* appendTerminalError({
        suffix: "proven-legacy-terminal-error",
        threadId: legacyThread,
        sourceCreatedAt: legacyAt,
      });
      yield* insertPendingTurn({
        threadId: legacyThread,
        messageId: legacyMessage,
        requestedAt: legacyAt,
      });

      const currentThread = "thread-proven-current-failure";
      const currentMessage = "message-proven-current-failure";
      const currentAt = "2026-07-24T12:01:00.000Z";
      const currentStartSequence = yield* appendTurnStart({
        suffix: "proven-current-start",
        threadId: currentThread,
        messageId: currentMessage,
        createdAt: currentAt,
      });
      yield* insertDelivery({
        eventSequence: currentStartSequence,
        threadId: currentThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:01:01.000Z",
      });
      yield* appendStartFailure({
        suffix: "proven-current-failure",
        threadId: currentThread,
        sourceCreatedAt: currentAt,
        messageId: currentMessage,
      });
      yield* appendTerminalError({
        suffix: "proven-current-terminal-error",
        threadId: currentThread,
        sourceCreatedAt: currentAt,
      });
      yield* insertPendingTurn({
        threadId: currentThread,
        messageId: currentMessage,
        requestedAt: currentAt,
      });

      const newerPendingThread = "thread-newer-pending-after-old-failure";
      const olderMessage = "message-older-failed-start";
      const olderAt = "2026-07-24T12:02:00.000Z";
      const olderStartSequence = yield* appendTurnStart({
        suffix: "newer-pending-old-start",
        threadId: newerPendingThread,
        messageId: olderMessage,
        createdAt: olderAt,
      });
      yield* insertDelivery({
        eventSequence: olderStartSequence,
        threadId: newerPendingThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:02:01.000Z",
      });
      yield* appendStartFailure({
        suffix: "newer-pending-old-failure",
        threadId: newerPendingThread,
        sourceCreatedAt: olderAt,
      });
      yield* appendTerminalError({
        suffix: "newer-pending-old-terminal-error",
        threadId: newerPendingThread,
        sourceCreatedAt: olderAt,
      });
      const newerMessage = "message-newer-pending-start";
      const newerAt = "2026-07-24T12:03:00.000Z";
      yield* appendTurnStart({
        suffix: "newer-pending-new-start",
        threadId: newerPendingThread,
        messageId: newerMessage,
        createdAt: newerAt,
      });
      yield* insertPendingTurn({
        threadId: newerPendingThread,
        messageId: newerMessage,
        requestedAt: newerAt,
      });

      const lateFailureThread = "thread-late-old-failure";
      const lateOlderMessage = "message-late-old-start";
      const lateOlderAt = "2026-07-24T12:04:00.000Z";
      const lateOlderSequence = yield* appendTurnStart({
        suffix: "late-old-start",
        threadId: lateFailureThread,
        messageId: lateOlderMessage,
        createdAt: lateOlderAt,
      });
      yield* insertDelivery({
        eventSequence: lateOlderSequence,
        threadId: lateFailureThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:04:01.000Z",
      });
      const lateNewerMessage = "message-late-newer-start";
      const lateNewerAt = "2026-07-24T12:05:00.000Z";
      const lateNewerSequence = yield* appendTurnStart({
        suffix: "late-newer-start",
        threadId: lateFailureThread,
        messageId: lateNewerMessage,
        createdAt: lateNewerAt,
      });
      yield* insertDelivery({
        eventSequence: lateNewerSequence,
        threadId: lateFailureThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:05:01.000Z",
      });
      yield* appendStartFailure({
        suffix: "late-old-failure",
        threadId: lateFailureThread,
        sourceCreatedAt: lateOlderAt,
      });
      yield* appendTerminalError({
        suffix: "late-old-terminal-error",
        threadId: lateFailureThread,
        sourceCreatedAt: lateOlderAt,
      });
      yield* insertPendingTurn({
        threadId: lateFailureThread,
        messageId: lateNewerMessage,
        requestedAt: lateNewerAt,
      });

      const ambiguousThread = "thread-ambiguous-source-time";
      const ambiguousAt = "2026-07-24T12:06:00.000Z";
      yield* appendTurnStart({
        suffix: "ambiguous-first-start",
        threadId: ambiguousThread,
        messageId: "message-ambiguous-first",
        createdAt: ambiguousAt,
      });
      const ambiguousMessage = "message-ambiguous-second";
      const ambiguousSecondSequence = yield* appendTurnStart({
        suffix: "ambiguous-second-start",
        threadId: ambiguousThread,
        messageId: ambiguousMessage,
        createdAt: ambiguousAt,
      });
      yield* insertDelivery({
        eventSequence: ambiguousSecondSequence,
        threadId: ambiguousThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:06:01.000Z",
      });
      yield* appendStartFailure({
        suffix: "ambiguous-second-failure",
        threadId: ambiguousThread,
        sourceCreatedAt: ambiguousAt,
        messageId: ambiguousMessage,
      });
      yield* appendTerminalError({
        suffix: "ambiguous-terminal-error",
        threadId: ambiguousThread,
        sourceCreatedAt: ambiguousAt,
      });
      yield* insertPendingTurn({
        threadId: ambiguousThread,
        messageId: ambiguousMessage,
        requestedAt: ambiguousAt,
      });

      const missingDeliveryThread = "thread-missing-delivery";
      const missingDeliveryMessage = "message-missing-delivery";
      const missingDeliveryAt = "2026-07-24T12:07:00.000Z";
      yield* appendTurnStart({
        suffix: "missing-delivery-start",
        threadId: missingDeliveryThread,
        messageId: missingDeliveryMessage,
        createdAt: missingDeliveryAt,
      });
      yield* appendStartFailure({
        suffix: "missing-delivery-failure",
        threadId: missingDeliveryThread,
        sourceCreatedAt: missingDeliveryAt,
      });
      yield* appendTerminalError({
        suffix: "missing-delivery-terminal-error",
        threadId: missingDeliveryThread,
        sourceCreatedAt: missingDeliveryAt,
      });
      yield* insertPendingTurn({
        threadId: missingDeliveryThread,
        messageId: missingDeliveryMessage,
        requestedAt: missingDeliveryAt,
      });

      const retryDeliveryThread = "thread-retry-delivery";
      const retryDeliveryMessage = "message-retry-delivery";
      const retryDeliveryAt = "2026-07-24T12:08:00.000Z";
      const retryDeliverySequence = yield* appendTurnStart({
        suffix: "retry-delivery-start",
        threadId: retryDeliveryThread,
        messageId: retryDeliveryMessage,
        createdAt: retryDeliveryAt,
      });
      yield* insertDelivery({
        eventSequence: retryDeliverySequence,
        threadId: retryDeliveryThread,
        state: "retry",
        completedAt: null,
      });
      yield* appendStartFailure({
        suffix: "retry-delivery-failure",
        threadId: retryDeliveryThread,
        sourceCreatedAt: retryDeliveryAt,
      });
      yield* appendTerminalError({
        suffix: "retry-delivery-terminal-error",
        threadId: retryDeliveryThread,
        sourceCreatedAt: retryDeliveryAt,
      });
      yield* insertPendingTurn({
        threadId: retryDeliveryThread,
        messageId: retryDeliveryMessage,
        requestedAt: retryDeliveryAt,
      });

      const reconciledDeliveryThread = "thread-reconciled-succeeded-delivery";
      const reconciledDeliveryMessage = "message-reconciled-succeeded-delivery";
      const reconciledDeliveryAt = "2026-07-24T12:08:30.000Z";
      const reconciledDeliverySequence = yield* appendTurnStart({
        suffix: "reconciled-delivery-start",
        threadId: reconciledDeliveryThread,
        messageId: reconciledDeliveryMessage,
        createdAt: reconciledDeliveryAt,
      });
      yield* insertDelivery({
        eventSequence: reconciledDeliverySequence,
        threadId: reconciledDeliveryThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:08:31.000Z",
      });
      yield* sql`
        INSERT INTO provider_delivery_reconciliations (
          reconciliation_id,
          consumer_name,
          event_sequence,
          thread_id,
          previous_state,
          outcome,
          reconciled_by,
          note,
          reconciled_at
        ) VALUES (
          'reconciliation-accepted-provider-start',
          ${PROVIDER_COMMAND_REACTOR_CONSUMER},
          ${reconciledDeliverySequence},
          ${reconciledDeliveryThread},
          'uncertain',
          'accepted',
          'migration-test',
          'Operator accepted an uncertain delivery',
          '2026-07-24T12:08:31.000Z'
        )
      `;
      yield* appendStartFailure({
        suffix: "reconciled-delivery-failure",
        threadId: reconciledDeliveryThread,
        sourceCreatedAt: reconciledDeliveryAt,
      });
      yield* appendTerminalError({
        suffix: "reconciled-delivery-terminal-error",
        threadId: reconciledDeliveryThread,
        sourceCreatedAt: reconciledDeliveryAt,
      });
      yield* insertPendingTurn({
        threadId: reconciledDeliveryThread,
        messageId: reconciledDeliveryMessage,
        requestedAt: reconciledDeliveryAt,
      });

      const retriedDeliveryThread = "thread-retried-succeeded-delivery";
      const retriedDeliveryMessage = "message-retried-succeeded-delivery";
      const retriedDeliveryAt = "2026-07-24T12:08:45.000Z";
      const retriedDeliverySequence = yield* appendTurnStart({
        suffix: "retried-delivery-start",
        threadId: retriedDeliveryThread,
        messageId: retriedDeliveryMessage,
        createdAt: retriedDeliveryAt,
      });
      yield* insertDelivery({
        eventSequence: retriedDeliverySequence,
        threadId: retriedDeliveryThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:08:46.000Z",
        attemptCount: 2,
      });
      yield* appendStartFailure({
        suffix: "retried-delivery-failure",
        threadId: retriedDeliveryThread,
        sourceCreatedAt: retriedDeliveryAt,
      });
      yield* appendTerminalError({
        suffix: "retried-delivery-terminal-error",
        threadId: retriedDeliveryThread,
        sourceCreatedAt: retriedDeliveryAt,
      });
      yield* insertPendingTurn({
        threadId: retriedDeliveryThread,
        messageId: retriedDeliveryMessage,
        requestedAt: retriedDeliveryAt,
      });

      const mismatchedMessageThread = "thread-mismatched-failure-message";
      const mismatchedMessage = "message-mismatched-failure";
      const mismatchedAt = "2026-07-24T12:09:00.000Z";
      const mismatchedSequence = yield* appendTurnStart({
        suffix: "mismatched-message-start",
        threadId: mismatchedMessageThread,
        messageId: mismatchedMessage,
        createdAt: mismatchedAt,
      });
      yield* insertDelivery({
        eventSequence: mismatchedSequence,
        threadId: mismatchedMessageThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:09:01.000Z",
      });
      yield* appendStartFailure({
        suffix: "mismatched-message-failure",
        threadId: mismatchedMessageThread,
        sourceCreatedAt: mismatchedAt,
        messageId: "message-other-request",
      });
      yield* appendTerminalError({
        suffix: "mismatched-message-terminal-error",
        threadId: mismatchedMessageThread,
        sourceCreatedAt: mismatchedAt,
      });
      yield* insertPendingTurn({
        threadId: mismatchedMessageThread,
        messageId: mismatchedMessage,
        requestedAt: mismatchedAt,
      });

      const unprojectedNewerThread = "thread-unprojected-newer-start";
      const unprojectedOlderMessage = "message-unprojected-older";
      const unprojectedOlderAt = "2026-07-24T12:10:00.000Z";
      const unprojectedOlderSequence = yield* appendTurnStart({
        suffix: "unprojected-older-start",
        threadId: unprojectedNewerThread,
        messageId: unprojectedOlderMessage,
        createdAt: unprojectedOlderAt,
      });
      yield* insertDelivery({
        eventSequence: unprojectedOlderSequence,
        threadId: unprojectedNewerThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:10:01.000Z",
      });
      yield* appendStartFailure({
        suffix: "unprojected-older-failure",
        threadId: unprojectedNewerThread,
        sourceCreatedAt: unprojectedOlderAt,
      });
      yield* appendTerminalError({
        suffix: "unprojected-older-terminal-error",
        threadId: unprojectedNewerThread,
        sourceCreatedAt: unprojectedOlderAt,
      });
      yield* appendTurnStart({
        suffix: "unprojected-newer-start",
        threadId: unprojectedNewerThread,
        messageId: "message-unprojected-newer",
        createdAt: "2026-07-24T12:11:00.000Z",
      });
      yield* insertPendingTurn({
        threadId: unprojectedNewerThread,
        messageId: unprojectedOlderMessage,
        requestedAt: unprojectedOlderAt,
      });

      const missingTerminalThread = "thread-missing-terminal-error";
      const missingTerminalMessage = "message-missing-terminal-error";
      const missingTerminalAt = "2026-07-24T12:12:00.000Z";
      const missingTerminalSequence = yield* appendTurnStart({
        suffix: "missing-terminal-start",
        threadId: missingTerminalThread,
        messageId: missingTerminalMessage,
        createdAt: missingTerminalAt,
      });
      yield* insertDelivery({
        eventSequence: missingTerminalSequence,
        threadId: missingTerminalThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:12:01.000Z",
      });
      yield* appendStartFailure({
        suffix: "missing-terminal-failure",
        threadId: missingTerminalThread,
        sourceCreatedAt: missingTerminalAt,
      });
      yield* insertPendingTurn({
        threadId: missingTerminalThread,
        messageId: missingTerminalMessage,
        requestedAt: missingTerminalAt,
      });

      const concreteTurnThread = "thread-existing-concrete-turn";
      const concreteTurnMessage = "message-existing-concrete-turn";
      const concreteTurnAt = "2026-07-24T12:13:00.000Z";
      const concreteTurnSequence = yield* appendTurnStart({
        suffix: "existing-concrete-start",
        threadId: concreteTurnThread,
        messageId: concreteTurnMessage,
        createdAt: concreteTurnAt,
      });
      yield* insertDelivery({
        eventSequence: concreteTurnSequence,
        threadId: concreteTurnThread,
        state: "succeeded",
        completedAt: "2026-07-24T12:13:01.000Z",
      });
      yield* appendStartFailure({
        suffix: "existing-concrete-failure",
        threadId: concreteTurnThread,
        sourceCreatedAt: concreteTurnAt,
      });
      yield* appendTerminalError({
        suffix: "existing-concrete-terminal-error",
        threadId: concreteTurnThread,
        sourceCreatedAt: concreteTurnAt,
      });
      yield* insertPendingTurn({
        threadId: concreteTurnThread,
        messageId: concreteTurnMessage,
        requestedAt: concreteTurnAt,
      });
      yield* insertConcreteTurn({
        threadId: concreteTurnThread,
        messageId: concreteTurnMessage,
        turnId: "turn-existing-concrete-turn",
        requestedAt: concreteTurnAt,
      });

      const eventRowsBefore = yield* sql<{
        readonly sequence: number;
        readonly eventId: string;
        readonly streamId: string;
        readonly eventType: string;
        readonly occurredAt: string;
        readonly payloadJson: string;
      }>`
        SELECT
          sequence,
          event_id AS "eventId",
          stream_id AS "streamId",
          event_type AS "eventType",
          occurred_at AS "occurredAt",
          payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY sequence ASC
      `;
      const highWaterSequence = eventRowsBefore.at(-1)!.sequence;
      yield* sql`
        INSERT INTO projection_state (
          projector,
          last_applied_sequence,
          updated_at
        ) VALUES (
          'projection.thread-turns',
          ${highWaterSequence},
          '2026-07-24T13:00:00.000Z'
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 76 });
      assert.deepStrictEqual(executed, [[76, "ReconcileFailedPendingTurnStarts"]]);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 76 }), []);

      const remainingRows = yield* sql<{
        readonly threadId: string;
        readonly messageId: string;
      }>`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId"
        FROM projection_turns
        WHERE turn_id IS NULL
          AND state = 'pending'
          AND checkpoint_turn_count IS NULL
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(remainingRows, [
        {
          threadId: ambiguousThread,
          messageId: ambiguousMessage,
        },
        {
          threadId: concreteTurnThread,
          messageId: concreteTurnMessage,
        },
        {
          threadId: lateFailureThread,
          messageId: lateNewerMessage,
        },
        {
          threadId: mismatchedMessageThread,
          messageId: mismatchedMessage,
        },
        {
          threadId: missingDeliveryThread,
          messageId: missingDeliveryMessage,
        },
        {
          threadId: missingTerminalThread,
          messageId: missingTerminalMessage,
        },
        {
          threadId: newerPendingThread,
          messageId: newerMessage,
        },
        {
          threadId: reconciledDeliveryThread,
          messageId: reconciledDeliveryMessage,
        },
        {
          threadId: retriedDeliveryThread,
          messageId: retriedDeliveryMessage,
        },
        {
          threadId: retryDeliveryThread,
          messageId: retryDeliveryMessage,
        },
        {
          threadId: unprojectedNewerThread,
          messageId: unprojectedOlderMessage,
        },
      ]);

      const projectorRows = yield* sql<{
        readonly lastAppliedSequence: number;
      }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.thread-turns'
      `;
      assert.deepStrictEqual(projectorRows, [{ lastAppliedSequence: highWaterSequence }]);

      yield* ReconcileFailedPendingTurnStartsMigration;
      const rowsAfterDirectRerun = yield* sql<{
        readonly threadId: string;
        readonly messageId: string;
      }>`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId"
        FROM projection_turns
        WHERE turn_id IS NULL
          AND state = 'pending'
          AND checkpoint_turn_count IS NULL
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(rowsAfterDirectRerun, remainingRows);

      const eventRowsAfter = yield* sql<{
        readonly sequence: number;
        readonly eventId: string;
        readonly streamId: string;
        readonly eventType: string;
        readonly occurredAt: string;
        readonly payloadJson: string;
      }>`
        SELECT
          sequence,
          event_id AS "eventId",
          stream_id AS "streamId",
          event_type AS "eventType",
          occurred_at AS "occurredAt",
          payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(eventRowsAfter, eventRowsBefore);
    }),
  );
});
