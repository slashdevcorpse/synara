import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Migration values are historical data, not runtime configuration. Keep this
// literal embedded so lineage reconciliation cannot change migration 74 by
// loading a future admission-service default.
const LEGACY_LIFECYCLE_GENERATION = "legacy";

/** Durable provider-request admission authority used before requests reach the transcript. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_request_admissions (
      thread_id TEXT NOT NULL,
      provider_session_thread_id TEXT NOT NULL,
      interaction_kind TEXT NOT NULL CHECK (interaction_kind IN ('approval', 'userInput')),
      request_id TEXT NOT NULL,
      lifecycle_generation TEXT NOT NULL,
      provider TEXT NOT NULL,
      request_type TEXT,
      turn_id TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'admitted', 'open', 'resolutionPending', 'resolved', 'cancelPending', 'cancelled',
        'overflowPending', 'overflowSettled', 'overflowFailed'
      )),
      opened_event_id TEXT NOT NULL,
      settlement_event_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, interaction_kind, request_id, lifecycle_generation)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_request_admissions_thread_open
    ON provider_request_admissions(thread_id, status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_request_admissions_session_generation
    ON provider_request_admissions(provider_session_thread_id, lifecycle_generation, status)
  `;
  yield* sql`
    INSERT INTO provider_request_admissions (
      thread_id, provider_session_thread_id, interaction_kind, request_id,
      lifecycle_generation, provider, request_type, turn_id, status,
      opened_event_id, settlement_event_id, created_at, updated_at
    )
    SELECT
      pending.thread_id,
      COALESCE(
        thread.parent_thread_id,
        (
          SELECT parent.thread_id
          FROM projection_threads AS parent
          WHERE substr(pending.thread_id, 1, length(parent.thread_id) + 10) =
              ('subagent:' || parent.thread_id || ':') COLLATE BINARY
            AND parent.deleted_at IS NULL
          ORDER BY length(parent.thread_id) DESC, parent.created_at ASC, parent.thread_id ASC
          LIMIT 1
        ),
        pending.thread_id
      ),
      pending.interaction_kind,
      pending.request_id,
      COALESCE(pending.lifecycle_generation, ${LEGACY_LIFECYCLE_GENERATION}),
      COALESCE(
        session.provider_name,
        json_extract(thread.model_selection_json, '$.provider'),
        'codex'
      ),
      (
        SELECT json_extract(activity.payload_json, '$.requestType')
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = pending.thread_id
          AND activity.kind = CASE
            WHEN pending.interaction_kind = 'approval' THEN 'approval.requested'
            ELSE 'user-input.requested'
          END
          AND json_extract(activity.payload_json, '$.requestId') = pending.request_id
          AND (
            (
              pending.lifecycle_generation IS NULL
              AND json_extract(activity.payload_json, '$.lifecycleGeneration') IS NULL
            )
            OR json_extract(activity.payload_json, '$.lifecycleGeneration') =
              pending.lifecycle_generation
          )
        ORDER BY activity.created_at DESC, activity.activity_id DESC
        LIMIT 1
      ),
      pending.turn_id,
      'open',
      COALESCE(
        (
          SELECT activity.activity_id
          FROM projection_thread_activities AS activity
          WHERE activity.thread_id = pending.thread_id
            AND activity.kind = CASE
              WHEN pending.interaction_kind = 'approval' THEN 'approval.requested'
              ELSE 'user-input.requested'
            END
            AND json_extract(activity.payload_json, '$.requestId') = pending.request_id
            AND (
              (
                pending.lifecycle_generation IS NULL
                AND json_extract(activity.payload_json, '$.lifecycleGeneration') IS NULL
              )
              OR json_extract(activity.payload_json, '$.lifecycleGeneration') =
                pending.lifecycle_generation
            )
          ORDER BY activity.created_at DESC, activity.activity_id DESC
          LIMIT 1
        ),
        'migration74:' || pending.interaction_kind || ':' || pending.request_id
      ),
      NULL,
      pending.created_at,
      COALESCE(pending.response_requested_at, pending.created_at)
    FROM projection_pending_interactions AS pending
    LEFT JOIN projection_threads AS thread
      ON thread.thread_id = pending.thread_id
    LEFT JOIN projection_thread_sessions AS session
      ON session.thread_id = COALESCE(
        thread.parent_thread_id,
        (
          SELECT parent.thread_id
          FROM projection_threads AS parent
          WHERE substr(pending.thread_id, 1, length(parent.thread_id) + 10) =
              ('subagent:' || parent.thread_id || ':') COLLATE BINARY
            AND parent.deleted_at IS NULL
          ORDER BY length(parent.thread_id) DESC, parent.created_at ASC, parent.thread_id ASC
          LIMIT 1
        ),
        pending.thread_id
      )
    WHERE pending.status IN ('pending', 'responding', 'retryable', 'uncertain')
    ON CONFLICT (thread_id, interaction_kind, request_id, lifecycle_generation)
    DO NOTHING
  `;
});
