import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Migration values are historical evidence, not runtime configuration. Keep
// the consumer identity stable if the live provider reactor is renamed later.
const PROVIDER_COMMAND_REACTOR_CONSUMER = "provider-command-reactor.v1";

/**
 * Removes only projection placeholders that a completed provider delivery
 * proved could never bind to a concrete turn.
 *
 * Releases before migration 76 persisted provider-start failure activities
 * without the originating message id. Correlating by session status would be
 * unsafe because a late failure can race a newer start. The source timestamp is
 * safe only when it identifies exactly one start request for the thread, the
 * exact request delivery succeeded, the failure and terminal error retained
 * that same source timestamp, no concrete turn already owns the message, and
 * no newer start exists. Ambiguous histories are preserved.
 *
 * The orchestration event log remains immutable; this repairs projection data
 * only and deliberately does not reset the turn projector cursor.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_turns
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND checkpoint_turn_count IS NULL
      AND pending_message_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM projection_turns AS concrete
        WHERE concrete.thread_id = projection_turns.thread_id
          AND concrete.pending_message_id = projection_turns.pending_message_id
          AND concrete.turn_id IS NOT NULL
      )
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS requested
        WHERE requested.aggregate_kind = 'thread'
          AND requested.stream_id = projection_turns.thread_id
          AND requested.event_type = 'thread.turn-start-requested'
          AND requested.occurred_at = projection_turns.requested_at
          AND json_type(requested.payload_json, '$.threadId') = 'text'
          AND json_extract(requested.payload_json, '$.threadId') =
            projection_turns.thread_id
          AND json_type(requested.payload_json, '$.messageId') = 'text'
          AND json_extract(requested.payload_json, '$.messageId') =
            projection_turns.pending_message_id
          AND json_type(requested.payload_json, '$.createdAt') = 'text'
          AND json_extract(requested.payload_json, '$.createdAt') =
            projection_turns.requested_at
          AND 1 = (
            SELECT COUNT(*)
            FROM orchestration_events AS same_source_time
            WHERE same_source_time.aggregate_kind = 'thread'
              AND same_source_time.stream_id = requested.stream_id
              AND same_source_time.event_type = 'thread.turn-start-requested'
              AND (
                same_source_time.occurred_at = projection_turns.requested_at
                OR json_extract(same_source_time.payload_json, '$.createdAt') =
                  projection_turns.requested_at
              )
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_event_deliveries AS delivery
            WHERE delivery.consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
              AND delivery.event_sequence = requested.sequence
              AND delivery.thread_id = requested.stream_id
              AND delivery.state = 'succeeded'
              AND delivery.attempt_count = 1
              AND delivery.completed_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM provider_delivery_reconciliations AS reconciliation
                WHERE reconciliation.consumer_name = delivery.consumer_name
                  AND reconciliation.event_sequence = delivery.event_sequence
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS newer_start
            WHERE newer_start.aggregate_kind = 'thread'
              AND newer_start.stream_id = requested.stream_id
              AND newer_start.event_type = 'thread.turn-start-requested'
              AND newer_start.sequence > requested.sequence
          )
          AND EXISTS (
            SELECT 1
            FROM orchestration_events AS failed
            WHERE failed.aggregate_kind = 'thread'
              AND failed.stream_id = requested.stream_id
              AND failed.event_type = 'thread.activity-appended'
              AND failed.sequence > requested.sequence
              AND failed.occurred_at = projection_turns.requested_at
              AND json_type(failed.payload_json, '$.threadId') = 'text'
              AND json_extract(failed.payload_json, '$.threadId') =
                projection_turns.thread_id
              AND json_extract(failed.payload_json, '$.activity.kind') =
                'provider.turn.start.failed'
              AND json_type(failed.payload_json, '$.activity.turnId') = 'null'
              AND json_type(failed.payload_json, '$.activity.createdAt') = 'text'
              AND json_extract(failed.payload_json, '$.activity.createdAt') =
                projection_turns.requested_at
              AND (
                json_type(
                  failed.payload_json,
                  '$.activity.payload.messageId'
                ) IS NULL
                OR (
                  json_type(
                    failed.payload_json,
                    '$.activity.payload.messageId'
                  ) = 'text'
                  AND json_extract(
                    failed.payload_json,
                    '$.activity.payload.messageId'
                  ) = projection_turns.pending_message_id
                )
              )
              AND EXISTS (
                SELECT 1
                FROM orchestration_events AS terminal_error
                WHERE terminal_error.aggregate_kind = 'thread'
                  AND terminal_error.stream_id = requested.stream_id
                  AND terminal_error.event_type = 'thread.session-set'
                  AND terminal_error.sequence > failed.sequence
                  AND terminal_error.occurred_at = projection_turns.requested_at
                  AND json_type(terminal_error.payload_json, '$.threadId') = 'text'
                  AND json_extract(terminal_error.payload_json, '$.threadId') =
                    projection_turns.thread_id
                  AND json_extract(
                    terminal_error.payload_json,
                    '$.session.status'
                  ) = 'error'
                  AND json_type(
                    terminal_error.payload_json,
                    '$.session.activeTurnId'
                  ) = 'null'
                  AND json_type(
                    terminal_error.payload_json,
                    '$.session.updatedAt'
                  ) = 'text'
                  AND json_extract(
                    terminal_error.payload_json,
                    '$.session.updatedAt'
                  ) = projection_turns.requested_at
              )
          )
      )
  `;
});
