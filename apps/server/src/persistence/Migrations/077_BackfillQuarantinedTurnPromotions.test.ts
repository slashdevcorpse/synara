import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import BackfillQuarantinedTurnPromotionsMigration from "./077_BackfillQuarantinedTurnPromotions.ts";

const PROVIDER_COMMAND_REACTOR_CONSUMER = "provider-command-reactor.v1";
const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("077_BackfillQuarantinedTurnPromotions", (it) => {
  it.effect("backfills only provably skipped starts in durable source order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });

      assert.deepStrictEqual(migrationEntries.find(([id]) => id === 77)?.slice(0, 2), [
        77,
        "BackfillQuarantinedTurnPromotions",
      ]);

      const streamVersions = new Map<string, number>();
      const appendEvent = (input: {
        readonly suffix: string;
        readonly threadId: string;
        readonly eventType: string;
        readonly occurredAt: string;
        readonly commandId?: string;
        readonly payload: Readonly<Record<string, unknown>>;
      }) =>
        Effect.gen(function* () {
          const streamVersion = (streamVersions.get(input.threadId) ?? 0) + 1;
          streamVersions.set(input.threadId, streamVersion);
          const rows = yield* sql<{ readonly sequence: number }>`
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
              ${input.commandId ?? `command-${input.suffix}`},
              NULL,
              ${`command-${input.suffix}`},
              'system',
              ${JSON.stringify(input.payload)},
              '{}'
            )
            RETURNING sequence
          `;
          return rows[0]!.sequence;
        });

      const appendBlocker = (input: {
        readonly suffix: string;
        readonly threadId: string;
        readonly createdAt: string;
      }) =>
        appendEvent({
          suffix: input.suffix,
          threadId: input.threadId,
          eventType: "thread.turn-interrupt-requested",
          occurredAt: input.createdAt,
          payload: {
            threadId: input.threadId,
            turnId: `turn-${input.suffix}`,
            createdAt: input.createdAt,
          },
        });

      const appendMessage = (input: {
        readonly suffix: string;
        readonly threadId: string;
        readonly messageId: string;
        readonly createdAt: string;
        readonly role?: "user" | "assistant";
      }) =>
        appendEvent({
          suffix: input.suffix,
          threadId: input.threadId,
          eventType: "thread.message-sent",
          occurredAt: input.createdAt,
          payload: {
            threadId: input.threadId,
            messageId: input.messageId,
            role: input.role ?? "user",
            text: input.suffix,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
        });

      const appendStart = (input: {
        readonly suffix: string;
        readonly threadId: string;
        readonly messageId: string;
        readonly createdAt: string;
        readonly dispatchMode?: "queue" | "steer";
        readonly commandId?: string;
      }) =>
        appendEvent({
          suffix: input.suffix,
          threadId: input.threadId,
          eventType: "thread.turn-start-requested",
          occurredAt: input.createdAt,
          ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
          payload: {
            threadId: input.threadId,
            messageId: input.messageId,
            dispatchMode: input.dispatchMode ?? "queue",
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: input.createdAt,
          },
        });

      const insertDelivery = (input: {
        readonly eventSequence: number;
        readonly threadId: string;
        readonly state: "retry" | "succeeded" | "dead" | "uncertain";
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
            1,
            ${input.state === "succeeded" ? null : "provider acceptance unresolved"},
            ${input.state === "succeeded" ? "2026-07-24T12:59:00.000Z" : null},
            '2026-07-24T12:59:00.000Z'
          )
        `;

      const insertPromotion = (input: {
        readonly sequence: number;
        readonly threadId: string;
        readonly messageId: string;
        readonly state: "queued" | "promoting" | "promoted" | "cancelled";
      }) =>
        sql`
          INSERT INTO queued_turn_promotions (
            queued_event_sequence,
            thread_id,
            message_id,
            dispatch_mode,
            state,
            claim_owner,
            claimed_at,
            claim_expires_at,
            attempt_count,
            created_at,
            updated_at,
            promoted_at
          ) VALUES (
            ${input.sequence},
            ${input.threadId},
            ${input.messageId},
            'queue',
            ${input.state},
            ${input.state === "promoting" ? "legacy-owner" : null},
            ${input.state === "promoting" ? "2026-07-24T12:30:00.000Z" : null},
            ${input.state === "promoting" ? "2099-01-01T00:00:00.000Z" : null},
            ${input.state === "promoting" ? 1 : 0},
            '2026-07-24T12:30:00.000Z',
            '2026-07-24T12:30:00.000Z',
            ${input.state === "promoted" ? "2026-07-24T12:31:00.000Z" : null}
          )
        `;

      const orderedThread = "thread-ordered-steers";
      const orderedBlocker = yield* appendBlocker({
        suffix: "ordered-blocker",
        threadId: orderedThread,
        createdAt: "2026-07-24T12:00:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: orderedBlocker,
        threadId: orderedThread,
        state: "uncertain",
      });
      yield* appendMessage({
        suffix: "ordered-message-one",
        threadId: orderedThread,
        messageId: "message-ordered-one",
        createdAt: "2026-07-24T12:01:00.000Z",
      });
      const orderedStartOne = yield* appendStart({
        suffix: "ordered-start-one",
        threadId: orderedThread,
        messageId: "message-ordered-one",
        dispatchMode: "steer",
        createdAt: "2026-07-24T12:01:00.000Z",
      });
      yield* appendMessage({
        suffix: "ordered-message-two",
        threadId: orderedThread,
        messageId: "message-ordered-two",
        createdAt: "2026-07-24T12:02:00.000Z",
      });
      const orderedStartTwo = yield* appendStart({
        suffix: "ordered-start-two",
        threadId: orderedThread,
        messageId: "message-ordered-two",
        dispatchMode: "steer",
        createdAt: "2026-07-24T12:02:00.000Z",
      });

      const reconciledThread = "thread-reconciled-crash";
      const reconciledBlocker = yield* appendBlocker({
        suffix: "reconciled-blocker",
        threadId: reconciledThread,
        createdAt: "2026-07-24T12:03:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: reconciledBlocker,
        threadId: reconciledThread,
        state: "succeeded",
      });
      yield* appendMessage({
        suffix: "reconciled-message",
        threadId: reconciledThread,
        messageId: "message-reconciled",
        createdAt: "2026-07-24T12:04:00.000Z",
      });
      const reconciledStart = yield* appendStart({
        suffix: "reconciled-start",
        threadId: reconciledThread,
        messageId: "message-reconciled",
        createdAt: "2026-07-24T12:04:00.000Z",
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
          'reconciliation-backfill-crash',
          ${PROVIDER_COMMAND_REACTOR_CONSUMER},
          ${reconciledBlocker},
          ${reconciledThread},
          'uncertain',
          'accepted',
          'test-operator',
          NULL,
          '2026-07-24T12:05:00.000Z'
        )
      `;

      const interleavedThread = "thread-reconciled-interleaved";
      const interleavedBlocker = yield* appendBlocker({
        suffix: "interleaved-blocker",
        threadId: interleavedThread,
        createdAt: "2026-07-24T12:05:10.000Z",
      });
      yield* insertDelivery({
        eventSequence: interleavedBlocker,
        threadId: interleavedThread,
        state: "succeeded",
      });
      yield* appendMessage({
        suffix: "interleaved-message",
        threadId: interleavedThread,
        messageId: "message-reconciled-interleaved-b",
        createdAt: "2026-07-24T12:05:20.000Z",
      });
      const interleavedStartB = yield* appendStart({
        suffix: "interleaved-start-b",
        threadId: interleavedThread,
        messageId: "message-reconciled-interleaved-b",
        createdAt: "2026-07-24T12:05:20.000Z",
      });
      yield* appendEvent({
        suffix: "interleaved-later-side-effect",
        threadId: interleavedThread,
        eventType: "thread.turn-interrupt-requested",
        occurredAt: "2026-07-24T12:05:30.000Z",
        payload: {
          threadId: interleavedThread,
          turnId: "turn-reconciled-interleaved",
          createdAt: "2026-07-24T12:05:30.000Z",
        },
      });
      yield* appendMessage({
        suffix: "interleaved-message-c",
        threadId: interleavedThread,
        messageId: "message-reconciled-interleaved-c",
        createdAt: "2026-07-24T12:05:35.000Z",
      });
      const interleavedStartC = yield* appendStart({
        suffix: "interleaved-start-c",
        threadId: interleavedThread,
        messageId: "message-reconciled-interleaved-c",
        createdAt: "2026-07-24T12:05:35.000Z",
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
          'reconciliation-backfill-interleaved',
          ${PROVIDER_COMMAND_REACTOR_CONSUMER},
          ${interleavedBlocker},
          ${interleavedThread},
          'uncertain',
          'accepted',
          'test-operator',
          NULL,
          '2026-07-24T12:05:40.000Z'
        )
      `;

      const promotedThread = "thread-promoted-source";
      const promotedBlocker = yield* appendBlocker({
        suffix: "promoted-blocker",
        threadId: promotedThread,
        createdAt: "2026-07-24T12:06:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: promotedBlocker,
        threadId: promotedThread,
        state: "dead",
      });
      yield* appendMessage({
        suffix: "promoted-message",
        threadId: promotedThread,
        messageId: "message-promoted-source",
        createdAt: "2026-07-24T12:07:00.000Z",
      });
      const promotedSource = yield* appendEvent({
        suffix: "promoted-source",
        threadId: promotedThread,
        eventType: "thread.turn-queued",
        occurredAt: "2026-07-24T12:07:00.000Z",
        payload: {
          threadId: promotedThread,
          messageId: "message-promoted-source",
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: "2026-07-24T12:07:00.000Z",
        },
      });
      yield* insertPromotion({
        sequence: promotedSource,
        threadId: promotedThread,
        messageId: "message-promoted-source",
        state: "promoted",
      });
      const promotedStart = yield* appendStart({
        suffix: "promoted-start",
        threadId: promotedThread,
        messageId: "message-promoted-source",
        commandId: `server:dispatch-queued-turn:${promotedSource}`,
        createdAt: "2026-07-24T12:08:00.000Z",
      });

      const replacingThread = "thread-active-source";
      const replacingBlocker = yield* appendBlocker({
        suffix: "active-blocker",
        threadId: replacingThread,
        createdAt: "2026-07-24T12:09:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: replacingBlocker,
        threadId: replacingThread,
        state: "uncertain",
      });
      yield* appendMessage({
        suffix: "active-message",
        threadId: replacingThread,
        messageId: "message-active-source",
        createdAt: "2026-07-24T12:10:00.000Z",
      });
      const activeSource = yield* appendEvent({
        suffix: "active-source",
        threadId: replacingThread,
        eventType: "thread.turn-queued",
        occurredAt: "2026-07-24T12:10:00.000Z",
        payload: {
          threadId: replacingThread,
          messageId: "message-active-source",
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: "2026-07-24T12:10:00.000Z",
        },
      });
      yield* insertPromotion({
        sequence: activeSource,
        threadId: replacingThread,
        messageId: "message-active-source",
        state: "promoting",
      });
      const replacingStart = yield* appendStart({
        suffix: "active-start",
        threadId: replacingThread,
        messageId: "message-active-source",
        commandId: `server:dispatch-queued-turn:${activeSource}`,
        createdAt: "2026-07-24T12:11:00.000Z",
      });

      const ownDeliveryThread = "thread-own-delivery";
      const ownDeliveryBlocker = yield* appendBlocker({
        suffix: "own-delivery-blocker",
        threadId: ownDeliveryThread,
        createdAt: "2026-07-24T12:12:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: ownDeliveryBlocker,
        threadId: ownDeliveryThread,
        state: "uncertain",
      });
      yield* appendMessage({
        suffix: "own-delivery-message",
        threadId: ownDeliveryThread,
        messageId: "message-own-delivery",
        createdAt: "2026-07-24T12:13:00.000Z",
      });
      const ownDeliveryStart = yield* appendStart({
        suffix: "own-delivery-start",
        threadId: ownDeliveryThread,
        messageId: "message-own-delivery",
        createdAt: "2026-07-24T12:13:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: ownDeliveryStart,
        threadId: ownDeliveryThread,
        state: "succeeded",
      });

      const failedThread = "thread-exact-failure";
      const failedBlocker = yield* appendBlocker({
        suffix: "failed-blocker",
        threadId: failedThread,
        createdAt: "2026-07-24T12:14:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: failedBlocker,
        threadId: failedThread,
        state: "uncertain",
      });
      yield* appendMessage({
        suffix: "failed-message",
        threadId: failedThread,
        messageId: "message-exact-failure",
        createdAt: "2026-07-24T12:15:00.000Z",
      });
      yield* appendStart({
        suffix: "failed-start",
        threadId: failedThread,
        messageId: "message-exact-failure",
        createdAt: "2026-07-24T12:15:00.000Z",
      });
      yield* appendEvent({
        suffix: "failed-activity",
        threadId: failedThread,
        eventType: "thread.activity-appended",
        occurredAt: "2026-07-24T12:16:00.000Z",
        payload: {
          threadId: failedThread,
          activity: {
            kind: "provider.turn.start.failed",
            payload: { messageId: "message-exact-failure" },
          },
        },
      });

      const concreteThread = "thread-concrete-turn";
      const concreteBlocker = yield* appendBlocker({
        suffix: "concrete-blocker",
        threadId: concreteThread,
        createdAt: "2026-07-24T12:17:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: concreteBlocker,
        threadId: concreteThread,
        state: "uncertain",
      });
      yield* appendMessage({
        suffix: "concrete-message",
        threadId: concreteThread,
        messageId: "message-concrete-turn",
        createdAt: "2026-07-24T12:18:00.000Z",
      });
      yield* appendStart({
        suffix: "concrete-start",
        threadId: concreteThread,
        messageId: "message-concrete-turn",
        createdAt: "2026-07-24T12:18:00.000Z",
      });
      yield* sql`
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
          ${concreteThread},
          'turn-concrete',
          'message-concrete-turn',
          NULL,
          'running',
          '2026-07-24T12:18:00.000Z',
          '2026-07-24T12:18:00.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const cancelledThread = "thread-cancelled-message";
      const cancelledBlocker = yield* appendBlocker({
        suffix: "cancelled-blocker",
        threadId: cancelledThread,
        createdAt: "2026-07-24T12:19:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: cancelledBlocker,
        threadId: cancelledThread,
        state: "uncertain",
      });
      yield* appendMessage({
        suffix: "cancelled-message",
        threadId: cancelledThread,
        messageId: "message-cancelled",
        createdAt: "2026-07-24T12:20:00.000Z",
      });
      const cancelledSource = yield* appendEvent({
        suffix: "cancelled-source",
        threadId: cancelledThread,
        eventType: "thread.turn-queued",
        occurredAt: "2026-07-24T12:20:00.000Z",
        payload: {
          threadId: cancelledThread,
          messageId: "message-cancelled",
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: "2026-07-24T12:20:00.000Z",
        },
      });
      yield* insertPromotion({
        sequence: cancelledSource,
        threadId: cancelledThread,
        messageId: "message-cancelled",
        state: "cancelled",
      });
      const cancelledStart = yield* appendStart({
        suffix: "cancelled-start",
        threadId: cancelledThread,
        messageId: "message-cancelled",
        createdAt: "2026-07-24T12:21:00.000Z",
      });

      const cancelledChildThread = "thread-cancelled-direct-child";
      const cancelledChildBlocker = yield* appendBlocker({
        suffix: "cancelled-child-blocker",
        threadId: cancelledChildThread,
        createdAt: "2026-07-24T12:21:10.000Z",
      });
      yield* insertDelivery({
        eventSequence: cancelledChildBlocker,
        threadId: cancelledChildThread,
        state: "uncertain",
      });
      yield* appendMessage({
        suffix: "cancelled-child-message",
        threadId: cancelledChildThread,
        messageId: "message-cancelled-child",
        createdAt: "2026-07-24T12:21:20.000Z",
      });
      const cancelledChildSource = yield* appendEvent({
        suffix: "cancelled-child-source",
        threadId: cancelledChildThread,
        eventType: "thread.turn-queued",
        occurredAt: "2026-07-24T12:21:20.000Z",
        payload: {
          threadId: cancelledChildThread,
          messageId: "message-cancelled-child",
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: "2026-07-24T12:21:20.000Z",
        },
      });
      yield* insertPromotion({
        sequence: cancelledChildSource,
        threadId: cancelledChildThread,
        messageId: "message-cancelled-child",
        state: "cancelled",
      });
      yield* appendStart({
        suffix: "cancelled-child-start",
        threadId: cancelledChildThread,
        messageId: "message-cancelled-child",
        commandId: `server:dispatch-queued-turn:${cancelledChildSource}`,
        createdAt: "2026-07-24T12:21:30.000Z",
      });

      const noBlockerThread = "thread-no-blocker";
      yield* appendMessage({
        suffix: "no-blocker-message",
        threadId: noBlockerThread,
        messageId: "message-no-blocker",
        createdAt: "2026-07-24T12:22:00.000Z",
      });
      yield* appendStart({
        suffix: "no-blocker-start",
        threadId: noBlockerThread,
        messageId: "message-no-blocker",
        createdAt: "2026-07-24T12:22:00.000Z",
      });

      const lagThread = "thread-cursor-lag";
      const lagBlocker = yield* appendBlocker({
        suffix: "lag-blocker",
        threadId: lagThread,
        createdAt: "2026-07-24T12:23:00.000Z",
      });
      yield* insertDelivery({
        eventSequence: lagBlocker,
        threadId: lagThread,
        state: "uncertain",
      });
      yield* appendMessage({
        suffix: "lag-message",
        threadId: lagThread,
        messageId: "message-cursor-lag",
        createdAt: "2026-07-24T12:24:00.000Z",
      });
      const cursorBeforeLagStart = yield* sql<{ readonly sequence: number }>`
        SELECT MAX(sequence) AS sequence FROM orchestration_events
      `.pipe(Effect.map((rows) => rows[0]!.sequence));
      yield* appendStart({
        suffix: "lag-start",
        threadId: lagThread,
        messageId: "message-cursor-lag",
        createdAt: "2026-07-24T12:24:00.000Z",
      });

      yield* sql`
        UPDATE orchestration_consumer_state
        SET last_acked_sequence = ${cursorBeforeLagStart},
            updated_at = '2026-07-24T13:00:00.000Z'
        WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
      `;

      const eventCountsBefore = yield* sql<{
        readonly eventCount: number;
        readonly messageCount: number;
      }>`
        SELECT
          COUNT(*) AS "eventCount",
          SUM(CASE WHEN event_type = 'thread.message-sent' THEN 1 ELSE 0 END) AS "messageCount"
        FROM orchestration_events
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 77 }), [
        [77, "BackfillQuarantinedTurnPromotions"],
      ]);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 77 }), []);

      const recovered = yield* sql<{
        readonly sequence: number;
        readonly threadId: string;
        readonly messageId: string;
        readonly dispatchMode: string;
        readonly state: string;
      }>`
        SELECT
          queued_event_sequence AS sequence,
          thread_id AS "threadId",
          message_id AS "messageId",
          dispatch_mode AS "dispatchMode",
          state
        FROM queued_turn_promotions
        WHERE state IN ('queued', 'promoting')
        ORDER BY queued_event_sequence ASC
      `;
      assert.deepStrictEqual(recovered, [
        {
          sequence: orderedStartOne,
          threadId: orderedThread,
          messageId: "message-ordered-one",
          dispatchMode: "queue",
          state: "queued",
        },
        {
          sequence: orderedStartTwo,
          threadId: orderedThread,
          messageId: "message-ordered-two",
          dispatchMode: "queue",
          state: "queued",
        },
        {
          sequence: reconciledStart,
          threadId: reconciledThread,
          messageId: "message-reconciled",
          dispatchMode: "queue",
          state: "queued",
        },
        {
          sequence: promotedStart,
          threadId: promotedThread,
          messageId: "message-promoted-source",
          dispatchMode: "queue",
          state: "queued",
        },
        {
          sequence: replacingStart,
          threadId: replacingThread,
          messageId: "message-active-source",
          dispatchMode: "queue",
          state: "queued",
        },
        {
          sequence: cancelledStart,
          threadId: cancelledThread,
          messageId: "message-cancelled",
          dispatchMode: "queue",
          state: "queued",
        },
      ]);

      const unsafeInterleavedBackfills = yield* sql<{
        readonly sequence: number;
        readonly queueRows: number;
        readonly deliveryRows: number;
      }>`
        SELECT
          candidate.sequence,
          (
            SELECT COUNT(*)
            FROM queued_turn_promotions AS queued
            WHERE queued.queued_event_sequence = candidate.sequence
          ) AS "queueRows",
          (
            SELECT COUNT(*)
            FROM orchestration_event_deliveries AS delivery
            WHERE delivery.consumer_name =
              ${PROVIDER_COMMAND_REACTOR_CONSUMER}
              AND delivery.event_sequence = candidate.sequence
          ) AS "deliveryRows"
        FROM (
          SELECT ${interleavedStartB} AS sequence
          UNION ALL
          SELECT ${interleavedStartC} AS sequence
        ) AS candidate
        ORDER BY candidate.sequence ASC
      `;
      assert.deepStrictEqual(unsafeInterleavedBackfills, [
        { sequence: interleavedStartB, queueRows: 0, deliveryRows: 0 },
        { sequence: interleavedStartC, queueRows: 0, deliveryRows: 0 },
      ]);

      const handledDeliveries = yield* sql<{
        readonly sequence: number;
        readonly threadId: string;
        readonly state: string;
        readonly attemptCount: number;
      }>`
        SELECT
          event_sequence AS sequence,
          thread_id AS "threadId",
          state,
          attempt_count AS "attemptCount"
        FROM orchestration_event_deliveries
        WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
          AND event_sequence IN (
            ${orderedStartOne},
            ${orderedStartTwo},
            ${reconciledStart},
            ${promotedStart},
            ${replacingStart},
            ${cancelledStart}
          )
        ORDER BY event_sequence ASC
      `;
      assert.deepStrictEqual(handledDeliveries, [
        {
          sequence: orderedStartOne,
          threadId: orderedThread,
          state: "succeeded",
          attemptCount: 1,
        },
        {
          sequence: orderedStartTwo,
          threadId: orderedThread,
          state: "succeeded",
          attemptCount: 1,
        },
        {
          sequence: reconciledStart,
          threadId: reconciledThread,
          state: "succeeded",
          attemptCount: 1,
        },
        {
          sequence: promotedStart,
          threadId: promotedThread,
          state: "succeeded",
          attemptCount: 1,
        },
        {
          sequence: replacingStart,
          threadId: replacingThread,
          state: "succeeded",
          attemptCount: 1,
        },
        {
          sequence: cancelledStart,
          threadId: cancelledThread,
          state: "succeeded",
          attemptCount: 1,
        },
      ]);

      yield* BackfillQuarantinedTurnPromotionsMigration;
      const recoveredAfterDirectRerun = yield* sql<{
        readonly sequence: number;
        readonly state: string;
      }>`
        SELECT queued_event_sequence AS sequence, state
        FROM queued_turn_promotions
        WHERE state IN ('queued', 'promoting')
        ORDER BY queued_event_sequence ASC
      `;
      assert.deepStrictEqual(
        recoveredAfterDirectRerun,
        recovered.map(({ sequence, state }) => ({ sequence, state })),
      );
      assert.deepStrictEqual(
        yield* sql<{
          readonly eventCount: number;
          readonly messageCount: number;
        }>`
          SELECT
            COUNT(*) AS "eventCount",
            SUM(CASE WHEN event_type = 'thread.message-sent' THEN 1 ELSE 0 END) AS "messageCount"
          FROM orchestration_events
        `,
        eventCountsBefore,
      );
    }),
  );
});

const legacyShapeLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyShapeLayer("077_BackfillQuarantinedTurnPromotions legacy shape", (it) => {
  it.effect("recovers the real quarantined A/B/C legacy shape without rewriting history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });

      const threadId = "thread-legacy-quarantined-fifo";
      let streamVersion = 0;
      const appendEvent = (input: {
        readonly suffix: string;
        readonly eventType: string;
        readonly occurredAt: string;
        readonly payload: Readonly<Record<string, unknown>>;
        readonly causationEventId?: string;
      }) =>
        Effect.gen(function* () {
          streamVersion += 1;
          const rows = yield* sql<{ readonly sequence: number }>`
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
              ${`event-legacy-${input.suffix}`},
              'thread',
              ${threadId},
              ${streamVersion},
              ${input.eventType},
              ${input.occurredAt},
              ${`command-legacy-${input.suffix}`},
              ${input.causationEventId ?? null},
              'correlation-legacy-quarantine',
              'user',
              ${JSON.stringify(input.payload)},
              ${JSON.stringify({ fixture: "legacy-quarantine" })}
            )
            RETURNING sequence
          `;
          return rows[0]!.sequence;
        });

      const appendMessage = (suffix: "a" | "b" | "c", createdAt: string) =>
        appendEvent({
          suffix: `message-${suffix}`,
          eventType: "thread.message-sent",
          occurredAt: createdAt,
          payload: {
            threadId,
            messageId: `message-legacy-${suffix}`,
            role: "user",
            text: `legacy message ${suffix.toUpperCase()}`,
            attachments: [],
            createdAt,
            updatedAt: createdAt,
          },
        });

      const appendStart = (
        suffix: "a" | "b" | "c",
        dispatchMode: "queue" | "steer",
        createdAt: string,
      ) =>
        appendEvent({
          suffix: `start-${suffix}`,
          eventType: "thread.turn-start-requested",
          occurredAt: createdAt,
          causationEventId: `event-legacy-message-${suffix}`,
          payload: {
            threadId,
            messageId: `message-legacy-${suffix}`,
            dispatchMode,
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt,
          },
        });

      const messageASequence = yield* appendMessage("a", "2026-07-24T14:00:00.000Z");
      const startASequence = yield* appendStart("a", "queue", "2026-07-24T14:00:00.000Z");
      const messageBSequence = yield* appendMessage("b", "2026-07-24T14:01:00.000Z");
      const startBSequence = yield* appendStart("b", "steer", "2026-07-24T14:01:00.000Z");
      const messageCSequence = yield* appendMessage("c", "2026-07-24T14:02:00.000Z");
      const startCSequence = yield* appendStart("c", "steer", "2026-07-24T14:02:00.000Z");
      const cursorSequence = yield* appendEvent({
        suffix: "cursor-tail",
        eventType: "thread.meta-updated",
        occurredAt: "2026-07-24T14:03:00.000Z",
        payload: {
          threadId,
          title: "Legacy quarantined FIFO",
          updatedAt: "2026-07-24T14:03:00.000Z",
        },
      });
      assert.strictEqual(cursorSequence > startCSequence, true);

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at,
          attachments_json,
          source,
          skills_json,
          mentions_json,
          dispatch_mode,
          dispatch_origin,
          sequence
        ) VALUES
          (
            'message-legacy-a',
            ${threadId},
            NULL,
            'user',
            'legacy message A',
            0,
            '2026-07-24T14:00:00.000Z',
            '2026-07-24T14:00:00.000Z',
            '[]',
            'native',
            '[]',
            '[]',
            'queue',
            'composer',
            ${messageASequence}
          ),
          (
            'message-legacy-b',
            ${threadId},
            NULL,
            'user',
            'legacy message B',
            0,
            '2026-07-24T14:01:00.000Z',
            '2026-07-24T14:01:00.000Z',
            '[]',
            'native',
            '[]',
            '[]',
            'steer',
            'composer',
            ${messageBSequence}
          ),
          (
            'message-legacy-c',
            ${threadId},
            NULL,
            'user',
            'legacy message C',
            0,
            '2026-07-24T14:02:00.000Z',
            '2026-07-24T14:02:00.000Z',
            '[]',
            'native',
            '[]',
            '[]',
            'steer',
            'composer',
            ${messageCSequence}
          )
      `;
      yield* sql`
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
          ${startASequence},
          ${threadId},
          'uncertain',
          NULL,
          NULL,
          NULL,
          1,
          'connection closed after request write',
          NULL,
          '2026-07-24T14:00:01.000Z'
        )
      `;
      yield* sql`
        UPDATE orchestration_consumer_state
        SET last_acked_sequence = ${cursorSequence},
            updated_at = '2026-07-24T14:03:01.000Z'
        WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
      `;

      const readHistorySnapshots = () =>
        Effect.gen(function* () {
          const events = yield* sql<{
            readonly rowCount: number;
            readonly snapshot: string;
          }>`
            SELECT
              COUNT(*) AS "rowCount",
              json_group_array(json_object(
                'sequence', sequence,
                'eventId', event_id,
                'aggregateKind', aggregate_kind,
                'streamId', stream_id,
                'streamVersion', stream_version,
                'eventType', event_type,
                'occurredAt', occurred_at,
                'commandId', command_id,
                'causationEventId', causation_event_id,
                'correlationId', correlation_id,
                'actorKind', actor_kind,
                'payloadJson', payload_json,
                'metadataJson', metadata_json
              )) AS snapshot
            FROM (
              SELECT *
              FROM orchestration_events
              ORDER BY sequence ASC
            )
          `;
          const messages = yield* sql<{
            readonly rowCount: number;
            readonly snapshot: string;
          }>`
            SELECT
              COUNT(*) AS "rowCount",
              json_group_array(json_object(
                'messageId', message_id,
                'threadId', thread_id,
                'turnId', turn_id,
                'role', role,
                'text', text,
                'isStreaming', is_streaming,
                'createdAt', created_at,
                'updatedAt', updated_at,
                'attachmentsJson', attachments_json,
                'source', source,
                'skillsJson', skills_json,
                'mentionsJson', mentions_json,
                'dispatchMode', dispatch_mode,
                'dispatchOrigin', dispatch_origin,
                'sequence', sequence
              )) AS snapshot
            FROM (
              SELECT *
              FROM projection_thread_messages
              ORDER BY thread_id ASC, sequence ASC, message_id ASC
            )
          `;
          return { events: events[0]!, messages: messages[0]! };
        });
      const historyBefore = yield* readHistorySnapshots();
      assert.deepStrictEqual(
        {
          eventRows: historyBefore.events.rowCount,
          messageRows: historyBefore.messages.rowCount,
        },
        { eventRows: 7, messageRows: 3 },
      );

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 77 }), [
        [77, "BackfillQuarantinedTurnPromotions"],
      ]);

      const promotions = yield* sql<{
        readonly sequence: number;
        readonly messageId: string;
        readonly dispatchMode: string;
        readonly state: string;
        readonly attemptCount: number;
        readonly createdAt: string;
      }>`
        SELECT
          queued_event_sequence AS sequence,
          message_id AS "messageId",
          dispatch_mode AS "dispatchMode",
          state,
          attempt_count AS "attemptCount",
          created_at AS "createdAt"
        FROM queued_turn_promotions
        ORDER BY queued_event_sequence ASC
      `;
      assert.deepStrictEqual(promotions, [
        {
          sequence: startBSequence,
          messageId: "message-legacy-b",
          dispatchMode: "queue",
          state: "queued",
          attemptCount: 0,
          createdAt: "2026-07-24T14:01:00.000Z",
        },
        {
          sequence: startCSequence,
          messageId: "message-legacy-c",
          dispatchMode: "queue",
          state: "queued",
          attemptCount: 0,
          createdAt: "2026-07-24T14:02:00.000Z",
        },
      ]);

      const deliveries = yield* sql<{
        readonly sequence: number;
        readonly state: string;
        readonly attemptCount: number;
        readonly lastError: string | null;
        readonly completedAt: string | null;
      }>`
        SELECT
          event_sequence AS sequence,
          state,
          attempt_count AS "attemptCount",
          last_error AS "lastError",
          completed_at AS "completedAt"
        FROM orchestration_event_deliveries
        WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
        ORDER BY event_sequence ASC
      `;
      assert.deepStrictEqual(deliveries, [
        {
          sequence: startASequence,
          state: "uncertain",
          attemptCount: 1,
          lastError: "connection closed after request write",
          completedAt: null,
        },
        {
          sequence: startBSequence,
          state: "succeeded",
          attemptCount: 1,
          lastError: null,
          completedAt: "2026-07-24T14:01:00.000Z",
        },
        {
          sequence: startCSequence,
          state: "succeeded",
          attemptCount: 1,
          lastError: null,
          completedAt: "2026-07-24T14:02:00.000Z",
        },
      ]);
      assert.deepStrictEqual(yield* readHistorySnapshots(), historyBefore);

      const promotionsBeforeDirectRerun = yield* sql`
        SELECT *
        FROM queued_turn_promotions
        ORDER BY queued_event_sequence ASC
      `;
      const deliveriesBeforeDirectRerun = yield* sql`
        SELECT *
        FROM orchestration_event_deliveries
        WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
        ORDER BY event_sequence ASC
      `;
      yield* BackfillQuarantinedTurnPromotionsMigration;
      assert.deepStrictEqual(
        yield* sql`
          SELECT *
          FROM queued_turn_promotions
          ORDER BY queued_event_sequence ASC
        `,
        promotionsBeforeDirectRerun,
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT *
          FROM orchestration_event_deliveries
          WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
          ORDER BY event_sequence ASC
        `,
        deliveriesBeforeDirectRerun,
      );
      assert.deepStrictEqual(yield* readHistorySnapshots(), historyBefore);
      assert.deepStrictEqual(
        yield* sql<{ readonly integrity_check: string }>`PRAGMA integrity_check`,
        [{ integrity_check: "ok" }],
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }),
  );
});
