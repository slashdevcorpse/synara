import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROVIDER_COMMAND_REACTOR_RUNTIME_CONSUMER } from "../Services/ProviderRuntimeEvents.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const runtimeEventColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('provider_runtime_events')
    WHERE name = 'orchestration_cutoff_sequence'
  `;
  if (runtimeEventColumns.length === 0) {
    yield* sql`
      ALTER TABLE provider_runtime_events
      ADD COLUMN orchestration_cutoff_sequence INTEGER
        CHECK (
          orchestration_cutoff_sequence IS NULL OR
          orchestration_cutoff_sequence >= 0
        )
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS queued_turn_promotion_compatibility_incidents (
      incident_key TEXT PRIMARY KEY,
      runtime_event_sequence INTEGER NOT NULL UNIQUE,
      runtime_event_id TEXT NOT NULL UNIQUE,
      provider_session_thread_id TEXT NOT NULL,
      through_event_sequence INTEGER NOT NULL CHECK (through_event_sequence >= 0),
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_queued_turn_promotion_compatibility_incidents_session
    ON queued_turn_promotion_compatibility_incidents(
      provider_session_thread_id,
      through_event_sequence
    )
  `;

  // Rows retained from migration 066 predate the cross-domain cutoff and
  // cannot be replayed safely: using today's orchestration high-water would
  // cancel work committed after the historical runtime terminal. The released
  // lineage did not emit the OpenCode compatibility reason before this
  // migration. Partial prerelease databases may contain such rows, so baseline
  // only through rows whose historical cutoff is unknowable. Future rows carry
  // a non-null cutoff and remain replayable.
  yield* sql`
    UPDATE provider_runtime_event_consumers
    SET last_acked_sequence = MAX(
          last_acked_sequence,
          COALESCE(
            (
              SELECT MAX(sequence)
              FROM provider_runtime_events
              WHERE orchestration_cutoff_sequence IS NULL
            ),
            0
          )
        ),
        updated_at = ${new Date().toISOString()}
    WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_RUNTIME_CONSUMER}
  `;
});
