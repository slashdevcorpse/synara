import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds nullable durable per-turn metadata without rewriting historical rows. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_turns')
  `;
  const existing = new Set(columns.map(({ name }) => name));

  const additions = [
    ["provider", "TEXT"],
    ["model", "TEXT"],
    ["reasoning_effort", "TEXT"],
    ["model_selection_json", "TEXT"],
    ["runtime_mode", "TEXT"],
    ["interaction_mode", "TEXT"],
    ["env_mode", "TEXT"],
    ["assistant_delivery_mode", "TEXT"],
    ["token_usage_json", "TEXT"],
    ["tool_calls_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["approval_request_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["rejected_approval_request_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
  ] as const;

  for (const [name, type] of additions) {
    if (!existing.has(name)) {
      yield* sql.unsafe(`ALTER TABLE projection_turns ADD COLUMN ${name} ${type}`);
    }
  }

  // Existing installs have already advanced this projector beyond historical
  // runtime activities. Replay it once so the new metadata and aggregates are
  // rebuilt from the durable orchestration log rather than starting empty.
  yield* sql`
    DELETE FROM projection_state
    WHERE projector = 'projection.thread-turns'
  `;
});
