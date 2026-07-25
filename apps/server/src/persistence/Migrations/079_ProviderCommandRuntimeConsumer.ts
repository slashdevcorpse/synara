import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROVIDER_COMMAND_REACTOR_RUNTIME_CONSUMER } from "../Services/ProviderRuntimeEvents.ts";

// ProviderCommandReactor consumes the Synara-owned runtime journal independently
// from ProviderRuntimeIngestion. Starting at zero lets upgraded databases replay
// every retained row before provider-intent recovery begins.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const migratedAt = new Date().toISOString();

  yield* sql`
    INSERT INTO provider_runtime_event_consumers (
      consumer_name, last_acked_sequence, created_at, updated_at
    ) VALUES (
      ${PROVIDER_COMMAND_REACTOR_RUNTIME_CONSUMER}, 0, ${migratedAt}, ${migratedAt}
    )
    ON CONFLICT (consumer_name) DO NOTHING
  `;
});
