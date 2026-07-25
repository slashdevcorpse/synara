import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS queued_turn_promotion_cancellation_fences (
      provider_session_thread_id TEXT PRIMARY KEY,
      through_event_sequence INTEGER NOT NULL CHECK (through_event_sequence >= 0),
      updated_at TEXT NOT NULL
    )
  `;
});
