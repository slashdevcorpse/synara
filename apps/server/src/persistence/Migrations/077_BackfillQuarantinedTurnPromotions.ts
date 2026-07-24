import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Historical migration evidence must keep the consumer identity that owned the
// cursor and delivery rows when these starts were skipped.
const PROVIDER_COMMAND_REACTOR_CONSUMER = "provider-command-reactor.v1";

/**
 * Preserves turn starts that the durable provider consumer acknowledged while
 * their thread was quarantined.
 *
 * The legacy quarantine gate advanced its cursor without creating the claimed
 * intent's delivery row. That missing delivery is safe evidence only when it is
 * combined with an earlier same-thread blocker (or its later reconciliation),
 * the exact immutable user-message lineage, and the absence of any concrete
 * turn or exact start-failure evidence.
 *
 * The queue row is written before a succeeded consumer-delivery handoff in one
 * transaction. "Succeeded" means the consumer durably handled the intent by
 * queueing it; it does not claim that the provider was invoked. No event,
 * message, or pending projection is deleted.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DROP TABLE IF EXISTS temp.migration_077_quarantined_turn_starts`;
      yield* sql`
        CREATE TEMP TABLE migration_077_quarantined_turn_starts AS
        SELECT
          requested.sequence AS queued_event_sequence,
          requested.stream_id AS thread_id,
          json_extract(requested.payload_json, '$.messageId') AS message_id,
          json_extract(requested.payload_json, '$.createdAt') AS created_at
        FROM orchestration_events AS requested
        WHERE requested.aggregate_kind = 'thread'
          AND requested.event_type = 'thread.turn-start-requested'
          AND json_type(requested.payload_json, '$.threadId') = 'text'
          AND json_extract(requested.payload_json, '$.threadId') = requested.stream_id
          AND json_type(requested.payload_json, '$.messageId') = 'text'
          AND length(json_extract(requested.payload_json, '$.messageId')) > 0
          AND json_type(requested.payload_json, '$.dispatchMode') = 'text'
          AND json_extract(requested.payload_json, '$.dispatchMode') IN ('queue', 'steer')
          AND json_type(requested.payload_json, '$.createdAt') = 'text'
          AND EXISTS (
            SELECT 1
            FROM orchestration_consumer_state AS consumer
            WHERE consumer.consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
              AND consumer.last_acked_sequence >= requested.sequence
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_event_deliveries AS own_delivery
            WHERE own_delivery.consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
              AND own_delivery.event_sequence = requested.sequence
          )
          AND (
            EXISTS (
              SELECT 1
              FROM orchestration_event_deliveries AS unresolved_blocker
              WHERE unresolved_blocker.consumer_name =
                  ${PROVIDER_COMMAND_REACTOR_CONSUMER}
                AND unresolved_blocker.thread_id = requested.stream_id
                AND unresolved_blocker.event_sequence < requested.sequence
                AND unresolved_blocker.state IN ('dead', 'uncertain')
            )
            OR EXISTS (
              SELECT 1
              FROM orchestration_event_deliveries AS reconciled_blocker
              INNER JOIN provider_delivery_reconciliations AS reconciliation
                ON reconciliation.consumer_name =
                  reconciled_blocker.consumer_name
                AND reconciliation.event_sequence =
                  reconciled_blocker.event_sequence
                AND reconciliation.thread_id = reconciled_blocker.thread_id
              WHERE reconciled_blocker.consumer_name =
                  ${PROVIDER_COMMAND_REACTOR_CONSUMER}
                AND reconciled_blocker.thread_id = requested.stream_id
                AND reconciled_blocker.event_sequence < requested.sequence
                AND reconciliation.reconciled_at >= requested.occurred_at
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS later_side_effect
            WHERE later_side_effect.aggregate_kind = 'thread'
              AND later_side_effect.stream_id = requested.stream_id
              AND later_side_effect.sequence > requested.sequence
              AND later_side_effect.event_type IN (
                'thread.meta-updated',
                'thread.runtime-mode-set',
                'thread.turn-interrupt-requested',
                'thread.task-stop-requested',
                'thread.task-background-requested',
                'thread.approval-response-requested',
                'thread.user-input-response-requested',
                'thread.conversation-rollback-requested',
                'thread.message-edit-resend-requested',
                'thread.session-stop-requested'
              )
          )
          AND 1 = (
            SELECT COUNT(*)
            FROM orchestration_events AS user_message
            WHERE user_message.aggregate_kind = 'thread'
              AND user_message.stream_id = requested.stream_id
              AND user_message.event_type = 'thread.message-sent'
              AND user_message.sequence < requested.sequence
              AND json_type(user_message.payload_json, '$.threadId') = 'text'
              AND json_extract(user_message.payload_json, '$.threadId') =
                requested.stream_id
              AND json_type(user_message.payload_json, '$.messageId') = 'text'
              AND json_extract(user_message.payload_json, '$.messageId') =
                json_extract(requested.payload_json, '$.messageId')
              AND json_extract(user_message.payload_json, '$.role') = 'user'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM projection_turns AS concrete
            WHERE concrete.thread_id = requested.stream_id
              AND concrete.pending_message_id =
                json_extract(requested.payload_json, '$.messageId')
              AND concrete.turn_id IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS failed
            WHERE failed.aggregate_kind = 'thread'
              AND failed.stream_id = requested.stream_id
              AND failed.event_type = 'thread.activity-appended'
              AND failed.sequence > requested.sequence
              AND json_extract(failed.payload_json, '$.activity.kind') =
                'provider.turn.start.failed'
              AND json_type(
                failed.payload_json,
                '$.activity.payload.messageId'
              ) = 'text'
              AND json_extract(
                failed.payload_json,
                '$.activity.payload.messageId'
              ) = json_extract(requested.payload_json, '$.messageId')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS deleted
            WHERE deleted.aggregate_kind = 'thread'
              AND deleted.stream_id = requested.stream_id
              AND deleted.event_type = 'thread.deleted'
              AND deleted.sequence > requested.sequence
          )
          AND NOT EXISTS (
            SELECT 1
            FROM queued_turn_promotions AS cancelled
            WHERE cancelled.thread_id = requested.stream_id
              AND cancelled.message_id =
                json_extract(requested.payload_json, '$.messageId')
              AND cancelled.state = 'cancelled'
              AND requested.command_id =
                'server:dispatch-queued-turn:' ||
                cancelled.queued_event_sequence
          )
        ORDER BY requested.sequence ASC
      `;

      yield* sql`
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
        )
        SELECT
          queued_event_sequence,
          thread_id,
          message_id,
          'queue',
          'queued',
          NULL,
          NULL,
          NULL,
          0,
          created_at,
          created_at,
          NULL
        FROM migration_077_quarantined_turn_starts
        WHERE true
        ORDER BY queued_event_sequence ASC
        ON CONFLICT DO UPDATE SET
          queued_event_sequence = excluded.queued_event_sequence,
          dispatch_mode = 'queue',
          state = 'queued',
          claim_owner = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          attempt_count = 0,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          promoted_at = NULL
        WHERE excluded.queued_event_sequence >
            queued_turn_promotions.queued_event_sequence
          AND EXISTS (
            SELECT 1
            FROM orchestration_events AS source
            WHERE source.sequence = excluded.queued_event_sequence
              AND source.command_id =
                'server:dispatch-queued-turn:' ||
                queued_turn_promotions.queued_event_sequence
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
        )
        SELECT
          ${PROVIDER_COMMAND_REACTOR_CONSUMER},
          eligible.queued_event_sequence,
          eligible.thread_id,
          'succeeded',
          NULL,
          NULL,
          NULL,
          1,
          NULL,
          eligible.created_at,
          eligible.created_at
        FROM migration_077_quarantined_turn_starts AS eligible
        INNER JOIN queued_turn_promotions AS queued
          ON queued.queued_event_sequence = eligible.queued_event_sequence
          AND queued.thread_id = eligible.thread_id
          AND queued.message_id = eligible.message_id
        WHERE true
        ON CONFLICT DO NOTHING
      `;

      yield* sql`DROP TABLE temp.migration_077_quarantined_turn_starts`;
    }),
  );
});
