import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PROVIDER_COMMAND_REACTOR_RUNTIME_CONSUMER,
  PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeEventRepositoryLive } from "./ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProviderRuntimeEventRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const runtimeEvent = (eventId: string, delta: string): ProviderRuntimeEvent => ({
  type: "content.delta",
  eventId: EventId.makeUnsafe(eventId),
  provider: "codex",
  createdAt: "2026-07-14T00:00:00.000Z",
  threadId: ThreadId.makeUnsafe("thread-runtime-journal"),
  turnId: TurnId.makeUnsafe("turn-runtime-journal"),
  payload: {
    streamKind: "assistant_text",
    delta,
  },
});

layer("ProviderRuntimeEventRepository", (it) => {
  it.effect("journals exact events and advances its consumer cursor contiguously", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const first = yield* repository.append(runtimeEvent("runtime-event-1", "hello"));
      const duplicate = yield* repository.append(runtimeEvent("runtime-event-1", "hello"));
      const second = yield* repository.append(runtimeEvent("runtime-event-2", " world"));

      assert.strictEqual(duplicate.sequence, first.sequence);
      assert.isAbove(second.sequence, first.sequence);
      assert.strictEqual(yield* repository.getHighWaterSequence, second.sequence);

      const rows = yield* repository.readAfter({
        sequenceExclusive: 0,
        throughSequenceInclusive: second.sequence,
        limit: 10,
      });
      assert.deepStrictEqual(
        rows.map((row) => [row.sequence, row.event.eventId]),
        [
          [first.sequence, "runtime-event-1"],
          [second.sequence, "runtime-event-2"],
        ],
      );

      const skipped = yield* repository.advanceConsumerCursor({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        eventSequence: second.sequence,
        updatedAt: "2026-07-14T00:00:01.000Z",
      });
      assert.isFalse(skipped);
      const advanced = yield* repository.advanceConsumerCursor({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        eventSequence: first.sequence,
        updatedAt: "2026-07-14T00:00:01.000Z",
      });
      assert.isTrue(advanced);
      assert.strictEqual(
        yield* repository.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
        first.sequence,
      );
      assert.deepStrictEqual(
        (yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        })).map((row) => row.event.eventId),
        ["runtime-event-1"],
      );

      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: second.sequence,
          updatedAt: "2026-07-14T00:00:02.000Z",
        }),
      );
      const terminal = yield* repository.append({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("runtime-event-terminal"),
        provider: "codex",
        createdAt: "2026-07-14T00:00:03.000Z",
        threadId: ThreadId.makeUnsafe("thread-runtime-journal"),
        turnId: TurnId.makeUnsafe("turn-runtime-journal"),
        payload: { state: "completed" },
      });
      for (const entry of [first, second, terminal]) {
        assert.isTrue(
          yield* repository.advanceConsumerCursor({
            consumerName: PROVIDER_COMMAND_REACTOR_RUNTIME_CONSUMER,
            eventSequence: entry.sequence,
            updatedAt: "2026-07-14T00:00:02.500Z",
          }),
        );
      }
      assert.deepStrictEqual(
        (yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        })).map((row) => row.event.eventId),
        ["runtime-event-1", "runtime-event-2"],
      );
      assert.isTrue(
        yield* repository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: terminal.sequence,
          updatedAt: "2026-07-14T00:00:03.000Z",
        }),
      );
      assert.lengthOf(
        yield* repository.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 10,
        }),
        0,
      );

      const conflict = yield* Effect.flip(
        repository.append(runtimeEvent("runtime-event-1", "different")),
      );
      assert.strictEqual(conflict._tag, "PersistenceDecodeError");
    }),
  );

  it.effect("retains journal rows until every registered consumer acknowledges them", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const sql = yield* SqlClient.SqlClient;
      const baselineHighWater = yield* repository.getHighWaterSequence;
      const baselineRows = yield* repository.readAfter({
        sequenceExclusive: 0,
        throughSequenceInclusive: baselineHighWater,
        limit: 1_000,
      });
      for (const entry of baselineRows) {
        assert.isTrue(
          yield* repository.advanceConsumerCursor({
            consumerName: PROVIDER_COMMAND_REACTOR_RUNTIME_CONSUMER,
            eventSequence: entry.sequence,
            updatedAt: "2026-07-14T00:00:00.500Z",
          }),
        );
      }
      const entries = yield* Effect.forEach(
        Array.from({ length: PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED + 1 }, (_, index) => index),
        (index) =>
          repository.append({
            type: "session.started",
            eventId: EventId.makeUnsafe(`runtime-retention-${index}`),
            provider: "codex",
            createdAt: "2026-07-14T00:00:00.000Z",
            threadId: ThreadId.makeUnsafe("thread-runtime-retention"),
            payload: {},
          }),
        { concurrency: 1 },
      );
      for (const entry of entries) {
        assert.isTrue(
          yield* repository.advanceConsumerCursor({
            consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
            eventSequence: entry.sequence,
            updatedAt: "2026-07-14T00:00:01.000Z",
          }),
        );
      }

      const last = entries.at(-1);
      const first = entries[0];
      assert.isDefined(first);
      assert.isDefined(last);
      yield* sql`
        INSERT INTO queued_turn_promotion_compatibility_incidents (
          incident_key, runtime_event_sequence, runtime_event_id,
          provider_session_thread_id, through_event_sequence, created_at
        ) VALUES (
          'runtime-retention-incident', ${first.sequence}, ${first.event.eventId},
          'thread-runtime-retention', 0, '2026-07-14T00:00:01.500Z'
        )
      `;
      assert.strictEqual(
        yield* repository.getConsumerCursor(PROVIDER_COMMAND_REACTOR_RUNTIME_CONSUMER),
        baselineHighWater,
      );
      assert.lengthOf(
        yield* repository.readAfter({
          sequenceExclusive: 0,
          throughSequenceInclusive: last.sequence,
          limit: 1_000,
        }),
        PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED + 1,
      );

      for (const entry of entries) {
        assert.isTrue(
          yield* repository.advanceConsumerCursor({
            consumerName: PROVIDER_COMMAND_REACTOR_RUNTIME_CONSUMER,
            eventSequence: entry.sequence,
            updatedAt: "2026-07-14T00:00:02.000Z",
          }),
        );
      }
      const retained = yield* repository.readAfter({
        sequenceExclusive: 0,
        throughSequenceInclusive: last.sequence,
        limit: 1_000,
      });
      assert.lengthOf(retained, PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED);
      assert.strictEqual(retained[0]?.sequence, entries[1]?.sequence);
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM queued_turn_promotion_compatibility_incidents
          WHERE incident_key = 'runtime-retention-incident'
        `,
        [{ count: 1 }],
      );
    }),
  );
});

layer("ProviderRuntimeEventRepository append-time cutoff", (it) => {
  it.effect("captures the orchestration cutoff atomically and keeps it immutable on replay", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRuntimeEventRepository;
      const sql = yield* SqlClient.SqlClient;
      const insertOrchestrationEvent = (suffix: string, streamVersion: number) =>
        sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`runtime-cutoff-${suffix}`}, 'thread', 'thread-runtime-cutoff',
            ${streamVersion}, 'thread.turn-queued', '2026-07-25T00:00:00.000Z',
            ${`cmd-runtime-cutoff-${suffix}`}, NULL, NULL, 'server', '{}', '{}'
          )
          RETURNING sequence
        `.pipe(Effect.map((rows) => rows[0]!.sequence));

      const cutoff = yield* insertOrchestrationEvent("before", 0);
      const event = runtimeEvent("runtime-event-cutoff", "captured");
      const persisted = yield* repository.append(event);
      assert.strictEqual(persisted.orchestrationCutoffSequence, cutoff);

      yield* insertOrchestrationEvent("after", 1);
      const duplicate = yield* repository.append(event);
      assert.strictEqual(duplicate.sequence, persisted.sequence);
      assert.strictEqual(duplicate.orchestrationCutoffSequence, cutoff);

      const replayed = (yield* repository.readAfter({
        sequenceExclusive: persisted.sequence - 1,
        throughSequenceInclusive: persisted.sequence,
        limit: 1,
      }))[0];
      assert.strictEqual(replayed?.orchestrationCutoffSequence, cutoff);
    }),
  );
});
