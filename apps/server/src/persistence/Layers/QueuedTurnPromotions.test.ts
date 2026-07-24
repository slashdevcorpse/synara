import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { QueuedTurnPromotionRepository } from "../Services/QueuedTurnPromotions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { QueuedTurnPromotionRepositoryLive } from "./QueuedTurnPromotions.ts";

const layer = it.layer(
  QueuedTurnPromotionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("QueuedTurnPromotionRepository", (it) => {
  it.effect("fences a cancelled promotion child but permits an independent later generation", () =>
    Effect.gen(function* () {
      const repository = yield* QueuedTurnPromotionRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-07-24T00:00:00.000Z";
      const insertSourceEvent = (id: number, commandId: string) =>
        sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-cancelled-generation-${id}`}, 'thread',
            'thread-cancelled-generation', ${id - 1},
            'thread.turn-start-requested', ${now}, ${commandId},
            NULL, NULL, 'server', '{}', '{}'
          )
          RETURNING sequence
        `.pipe(Effect.map((rows) => rows[0]!.sequence));

      const cancelledSequence = yield* insertSourceEvent(1, "cmd-cancelled-generation");
      yield* repository.enqueue({
        queuedEventSequence: cancelledSequence,
        threadId: "thread-cancelled-generation",
        messageId: "message-cancelled-generation",
        dispatchMode: "queue",
        createdAt: now,
      });
      yield* repository.claimNext({
        threadId: "thread-cancelled-generation",
        claimOwner: "cancelled-generation-owner",
        claimedAt: now,
        claimExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.isTrue(
        yield* repository.cancelMessage({
          threadId: "thread-cancelled-generation",
          messageId: "message-cancelled-generation",
          updatedAt: now,
        }),
      );

      const directChildSequence = yield* insertSourceEvent(
        2,
        `server:dispatch-queued-turn:${cancelledSequence}`,
      );
      yield* repository.enqueue({
        queuedEventSequence: directChildSequence,
        threadId: "thread-cancelled-generation",
        messageId: "message-cancelled-generation",
        dispatchMode: "queue",
        createdAt: now,
      });
      assert.isTrue(Option.isNone(yield* repository.getBySequence(directChildSequence)));

      const independentSequence = yield* insertSourceEvent(
        3,
        "server:message-edit-resend-turn-start:independent",
      );
      yield* repository.enqueue({
        queuedEventSequence: independentSequence,
        threadId: "thread-cancelled-generation",
        messageId: "message-cancelled-generation",
        dispatchMode: "queue",
        createdAt: now,
      });
      assert.deepInclude(
        (yield* repository.getBySequence(independentSequence)).pipe(Option.getOrThrow),
        {
          state: "queued",
          messageId: "message-cancelled-generation",
        },
      );
    }),
  );

  it.effect("retains a newer handoff that replaces an in-flight promotion", () =>
    Effect.gen(function* () {
      const repository = yield* QueuedTurnPromotionRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-07-24T00:00:00.000Z";
      const insertSourceEvent = (id: number, commandId: string) =>
        sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-promotion-handoff-${id}`}, 'thread', 'thread-promotion-handoff', ${id - 1},
            'thread.turn-start-requested', ${now}, ${commandId},
            NULL, NULL, 'server', '{}', '{}'
          )
          RETURNING sequence
        `.pipe(Effect.map((rows) => rows[0]!.sequence));

      const sourceSequence = yield* insertSourceEvent(1, "cmd-promotion-handoff-1");
      const handoffSequence = yield* insertSourceEvent(
        2,
        `server:dispatch-queued-turn:${sourceSequence}`,
      );
      yield* repository.enqueue({
        queuedEventSequence: sourceSequence,
        threadId: "thread-promotion-handoff",
        messageId: "message-promotion-handoff",
        dispatchMode: "queue",
        createdAt: now,
      });
      yield* repository.claimNext({
        threadId: "thread-promotion-handoff",
        claimOwner: "source-owner",
        claimedAt: now,
        claimExpiresAt: "2099-01-01T00:00:00.000Z",
      });

      yield* repository.enqueue({
        queuedEventSequence: handoffSequence,
        threadId: "thread-promotion-handoff",
        messageId: "message-promotion-handoff",
        dispatchMode: "queue",
        createdAt: now,
      });

      assert.isFalse(
        yield* repository.markPromoted({
          queuedEventSequence: sourceSequence,
          claimOwner: "source-owner",
          promotedAt: now,
        }),
      );
      assert.isTrue(Option.isNone(yield* repository.getBySequence(sourceSequence)));
      assert.deepInclude(
        (yield* repository.getBySequence(handoffSequence)).pipe(Option.getOrThrow),
        {
          state: "queued",
          attemptCount: 0,
        },
      );
      assert.strictEqual(
        (yield* repository.claimNext({
          threadId: "thread-promotion-handoff",
          claimOwner: "handoff-owner",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        })).pipe(Option.getOrThrow).queuedEventSequence,
        handoffSequence,
      );
    }),
  );

  it.effect(
    "preserves priority, reclaims foreign owners, and permits a later message generation",
    () =>
      Effect.gen(function* () {
        const repository = yield* QueuedTurnPromotionRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-07-14T00:00:00.000Z";
        const insertSourceEvent = (id: number) =>
          sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-queued-promotion-${id}`}, 'thread', 'thread-queued-promotion', ${id - 1},
            'thread.turn-queued', ${now}, ${`cmd-queued-promotion-${id}`},
            NULL, NULL, 'server', '{}', '{}'
          )
          RETURNING sequence
        `.pipe(Effect.map((rows) => rows[0]!.sequence));

        const queuedSequence = yield* insertSourceEvent(1);
        const steerSequence = yield* insertSourceEvent(2);
        yield* repository.enqueue({
          queuedEventSequence: queuedSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-queue",
          dispatchMode: "queue",
          createdAt: now,
        });
        yield* repository.enqueue({
          queuedEventSequence: steerSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-steer",
          dispatchMode: "steer",
          createdAt: now,
        });

        const firstClaim = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-before-crash",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(firstClaim.pipe(Option.getOrThrow).queuedEventSequence, steerSequence);

        const reclaimed = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-after-restart",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.deepInclude(reclaimed.pipe(Option.getOrThrow), {
          queuedEventSequence: steerSequence,
          attemptCount: 2,
        });
        assert.isTrue(
          yield* repository.markPromoted({
            queuedEventSequence: steerSequence,
            claimOwner: "owner-after-restart",
            promotedAt: now,
          }),
        );

        const nextClaim = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-after-restart",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(nextClaim.pipe(Option.getOrThrow).queuedEventSequence, queuedSequence);
        yield* repository.releaseClaim({
          queuedEventSequence: queuedSequence,
          claimOwner: "owner-after-restart",
          updatedAt: now,
        });

        const laterSteerSequence = yield* insertSourceEvent(3);
        yield* repository.enqueue({
          queuedEventSequence: laterSteerSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-steer",
          dispatchMode: "steer",
          createdAt: now,
        });
        const laterGeneration = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-later-generation",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(
          laterGeneration.pipe(Option.getOrThrow).queuedEventSequence,
          laterSteerSequence,
        );

        // `laterSteerSequence` is currently claimed ('promoting'). cancelThread now
        // widens to cancel BOTH 'queued' and 'promoting' rows, so the in-flight
        // claim is cancelled immediately -> nothing pending.
        yield* repository.cancelThread({
          threadId: "thread-queued-promotion",
          updatedAt: now,
        });
        assert.isFalse(
          yield* repository.hasPendingMessage({
            threadId: "thread-queued-promotion",
            messageId: "message-steer",
          }),
        );

        // The drain's error path releasing the (now cancelled) claim must NOT
        // resurrect it: releaseClaim only matches state='promoting', which the
        // cancelled row no longer is, so it reports no-op and the row stays dead.
        const released = yield* repository.releaseClaim({
          queuedEventSequence: laterSteerSequence,
          claimOwner: "owner-later-generation",
          updatedAt: now,
        });
        assert.isFalse(released);
        assert.isFalse(
          yield* repository.hasPendingMessage({
            threadId: "thread-queued-promotion",
            messageId: "message-steer",
          }),
        );
      }),
  );
});
