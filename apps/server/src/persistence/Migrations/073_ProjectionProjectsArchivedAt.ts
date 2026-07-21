import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

/** Adds durable, nullable archive state without changing historical project rows. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (yield* columnExists(sql, "projection_projects", "archived_at")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN archived_at TEXT
  `;
});
