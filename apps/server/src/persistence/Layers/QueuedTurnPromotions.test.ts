import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import { QueuedTurnPromotionRepository } from "../Services/QueuedTurnPromotions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { QueuedTurnPromotionRepositoryLive } from "./QueuedTurnPromotions.ts";

const layer = it.layer(
  QueuedTurnPromotionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("QueuedTurnPromotionRepository", (it) => {
  it.effect(
    "persists a provider-session cancellation fence without suppressing later user turns",
    () =>
      Effect.gen(function* () {
        const repository = yield* QueuedTurnPromotionRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-07-25T00:00:00.000Z";
        const insertSourceEvent = (id: number) =>
          sql<{ readonly sequence: number }>`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id,
              actor_kind, payload_json, metadata_json
            ) VALUES (
              ${`evt-provider-session-fence-${id}`}, 'thread',
              'thread-provider-session-fence', ${id - 1},
              'thread.turn-queued', ${now}, ${`cmd-provider-session-fence-${id}`},
              NULL, NULL, 'server', '{}', '{}'
            )
            RETURNING sequence
          `.pipe(Effect.map((rows) => rows[0]!.sequence));
        const insertRuntimeEvent = (id: number) =>
          sql<{ readonly sequence: number }>`
            INSERT INTO provider_runtime_events (
              event_id, thread_id, turn_id, lifecycle_generation, event_type,
              event_json, persisted_at, orchestration_cutoff_sequence
            ) VALUES (
              ${`runtime-provider-session-fence-${id}`},
              'thread-provider-session-fence', 'turn-provider-session-fence',
              'generation-provider-session-fence', 'turn.completed', '{}', ${now}, 0
            )
            RETURNING sequence
          `.pipe(Effect.map((rows) => rows[0]!.sequence));

        const materializedSequence = yield* insertSourceEvent(1);
        const notYetMaterializedSequence = yield* insertSourceEvent(2);
        yield* repository.enqueue({
          providerSessionThreadId: "thread-provider-session-fence",
          queuedEventSequence: materializedSequence,
          threadId: "thread-provider-session-fence",
          messageId: "message-provider-session-fence-existing",
          dispatchMode: "queue",
          createdAt: now,
        });

        const firstRuntimeSequence = yield* insertRuntimeEvent(1);
        yield* repository.cancelProviderSessionThrough({
          compatibilityIncidentKey:
            '["opencode","thread-provider-session-fence","generation-provider-session-fence","turn-provider-session-fence","opencode_storage_schema_incompatible"]',
          runtimeEventSequence: firstRuntimeSequence,
          runtimeEventId: "runtime-provider-session-fence-1",
          providerSessionThreadId: "thread-provider-session-fence",
          memberThreadIds: ["thread-provider-session-fence"],
          throughEventSequence: notYetMaterializedSequence,
          updatedAt: now,
        });

        assert.deepInclude(
          (yield* repository.getBySequence(materializedSequence)).pipe(Option.getOrThrow),
          { state: "cancelled" },
        );
        assert.isTrue(
          yield* repository.isQueuedEventCancelledByProviderSessionFence({
            providerSessionThreadId: "thread-provider-session-fence",
            queuedEventSequence: notYetMaterializedSequence,
          }),
        );
        const laterSequence = yield* insertSourceEvent(3);
        const duplicateRuntimeSequence = yield* insertRuntimeEvent(2);
        yield* repository.cancelProviderSessionThrough({
          compatibilityIncidentKey:
            '["opencode","thread-provider-session-fence","generation-provider-session-fence","turn-provider-session-fence","opencode_storage_schema_incompatible"]',
          runtimeEventSequence: duplicateRuntimeSequence,
          runtimeEventId: "runtime-provider-session-fence-2",
          providerSessionThreadId: "thread-provider-session-fence",
          memberThreadIds: [],
          throughEventSequence: laterSequence,
          updatedAt: "2026-07-25T00:01:00.000Z",
        });
        assert.isTrue(
          yield* repository.isQueuedEventCancelledByProviderSessionFence({
            providerSessionThreadId: "thread-provider-session-fence",
            queuedEventSequence: notYetMaterializedSequence,
          }),
        );
        assert.isFalse(
          yield* repository.isQueuedEventCancelledByProviderSessionFence({
            providerSessionThreadId: "thread-provider-session-fence",
            queuedEventSequence: laterSequence,
          }),
        );
        yield* repository.enqueue({
          providerSessionThreadId: "thread-provider-session-fence",
          queuedEventSequence: laterSequence,
          threadId: "thread-provider-session-fence",
          messageId: "message-provider-session-fence-later",
          dispatchMode: "queue",
          createdAt: now,
        });
        assert.deepInclude(
          (yield* repository.getBySequence(laterSequence)).pipe(Option.getOrThrow),
          { state: "queued" },
        );
      }),
  );

  it.effect("fails closed when a runtime identity is reused for another incident", () =>
    Effect.gen(function* () {
      const repository = yield* QueuedTurnPromotionRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-07-25T00:02:00.000Z";
      const runtimeRows = yield* sql<{ readonly sequence: number }>`
        INSERT INTO provider_runtime_events (
          event_id, thread_id, turn_id, lifecycle_generation, event_type,
          event_json, persisted_at, orchestration_cutoff_sequence
        ) VALUES (
          'runtime-provider-session-identity-conflict',
          'thread-provider-session-identity-conflict',
          'turn-provider-session-identity-conflict',
          'generation-provider-session-identity-conflict',
          'turn.completed', '{}', ${now}, 0
        )
        RETURNING sequence
      `;
      const runtimeEventSequence = runtimeRows[0]!.sequence;
      yield* repository.cancelProviderSessionThrough({
        compatibilityIncidentKey:
          '["opencode","thread-provider-session-identity-conflict","generation-provider-session-identity-conflict","turn-provider-session-identity-conflict","opencode_storage_schema_incompatible"]',
        runtimeEventSequence,
        runtimeEventId: "runtime-provider-session-identity-conflict",
        providerSessionThreadId: "thread-provider-session-identity-conflict",
        memberThreadIds: [],
        throughEventSequence: 0,
        updatedAt: now,
      });

      const conflicting = yield* Effect.exit(
        repository.cancelProviderSessionThrough({
          compatibilityIncidentKey:
            '["opencode","thread-provider-session-identity-conflict-other","generation-provider-session-identity-conflict","turn-provider-session-identity-conflict","opencode_storage_schema_incompatible"]',
          runtimeEventSequence,
          runtimeEventId: "runtime-provider-session-identity-conflict",
          providerSessionThreadId: "thread-provider-session-identity-conflict-other",
          memberThreadIds: [],
          throughEventSequence: 99,
          updatedAt: "2026-07-25T00:03:00.000Z",
        }),
      );
      assert.isTrue(Exit.isFailure(conflicting));
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM queued_turn_promotion_compatibility_incidents
          WHERE provider_session_thread_id =
            'thread-provider-session-identity-conflict-other'
        `,
        [{ count: 0 }],
      );
      assert.isFalse(
        yield* repository.isQueuedEventCancelledByProviderSessionFence({
          providerSessionThreadId: "thread-provider-session-identity-conflict-other",
          queuedEventSequence: 1,
        }),
      );
    }),
  );

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
        providerSessionThreadId: "thread-cancelled-generation",
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
        providerSessionThreadId: "thread-cancelled-generation",
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
        providerSessionThreadId: "thread-cancelled-generation",
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
        providerSessionThreadId: "thread-promotion-handoff",
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
        providerSessionThreadId: "thread-promotion-handoff",
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
          providerSessionThreadId: "thread-queued-promotion",
          queuedEventSequence: queuedSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-queue",
          dispatchMode: "queue",
          createdAt: now,
        });
        yield* repository.enqueue({
          providerSessionThreadId: "thread-queued-promotion",
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
          providerSessionThreadId: "thread-queued-promotion",
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

type ConcurrentFence = {
  readonly locked: Promise<void>;
  readonly committed: Promise<void>;
  readonly worker: Worker;
};

const beginConcurrentFence = (input: {
  readonly dbPath: string;
  readonly providerSessionThreadId: string;
  readonly throughEventSequence: number;
  readonly updatedAt: string;
}): ConcurrentFence => {
  const worker = new Worker(
    `
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const db = new DatabaseSync(workerData.dbPath);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
      db.prepare(
        "INSERT INTO queued_turn_promotion_cancellation_fences " +
          "(provider_session_thread_id, through_event_sequence, updated_at) " +
          "VALUES (?, ?, ?) " +
          "ON CONFLICT (provider_session_thread_id) DO UPDATE SET " +
          "through_event_sequence = MAX(through_event_sequence, excluded.through_event_sequence), " +
          "updated_at = excluded.updated_at"
      ).run(
        workerData.providerSessionThreadId,
        workerData.throughEventSequence,
        workerData.updatedAt
      );
      parentPort.postMessage("locked");
      setTimeout(() => {
        try {
          db.exec("COMMIT;");
          parentPort.postMessage("committed");
        } catch (cause) {
          parentPort.postMessage({
            type: "error",
            message: cause instanceof Error ? cause.stack ?? cause.message : String(cause)
          });
        } finally {
          db.close();
        }
      }, 150);
    `,
    { eval: true, workerData: input },
  );
  let resolveLocked!: () => void;
  let resolveCommitted!: () => void;
  let rejectLocked!: (cause: unknown) => void;
  let rejectCommitted!: (cause: unknown) => void;
  const locked = new Promise<void>((resolve, reject) => {
    resolveLocked = resolve;
    rejectLocked = reject;
  });
  const committed = new Promise<void>((resolve, reject) => {
    resolveCommitted = resolve;
    rejectCommitted = reject;
  });
  worker.on("message", (message: unknown) => {
    if (message === "locked") {
      resolveLocked();
    } else if (message === "committed") {
      resolveCommitted();
    } else if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "error"
    ) {
      const cause = new Error(
        "message" in message && typeof message.message === "string"
          ? message.message
          : "Concurrent SQLite fence worker failed.",
      );
      rejectLocked(cause);
      rejectCommitted(cause);
    }
  });
  worker.on("error", (cause) => {
    rejectLocked(cause);
    rejectCommitted(cause);
  });
  return { locked, committed, worker };
};

it("serializes enqueue and claim behind a concurrently committed durable fence", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synara-queued-fence-race-"));
  const dbPath = path.join(tempRoot, "state.sqlite");
  const persistence = NodeSqliteClient.layer({ filename: dbPath });
  const runtime = ManagedRuntime.make(
    QueuedTurnPromotionRepositoryLive.pipe(Layer.provideMerge(persistence)),
  );
  const workers: Worker[] = [];
  try {
    await runtime.runPromise(runMigrations());
    const repository = await runtime.runPromise(Effect.service(QueuedTurnPromotionRepository));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    await runtime.runPromise(sql`PRAGMA journal_mode = WAL`);
    await runtime.runPromise(sql`PRAGMA synchronous = NORMAL`);
    await runtime.runPromise(sql`PRAGMA busy_timeout = 5000`);
    const now = "2026-07-25T00:04:00.000Z";
    const insertSourceEvent = (suffix: string, streamVersion: number) =>
      runtime.runPromise(
        sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-two-connection-fence-${suffix}`}, 'thread',
            ${`thread-two-connection-fence-${suffix}`}, ${streamVersion},
            'thread.turn-queued', ${now}, ${`cmd-two-connection-fence-${suffix}`},
            NULL, NULL, 'server', '{}', '{}'
          )
          RETURNING sequence
        `.pipe(Effect.map((rows) => rows[0]!.sequence)),
      );

    const enqueueSequence = await insertSourceEvent("enqueue", 0);
    const enqueueFence = beginConcurrentFence({
      dbPath,
      providerSessionThreadId: "thread-two-connection-fence-enqueue",
      throughEventSequence: enqueueSequence,
      updatedAt: now,
    });
    workers.push(enqueueFence.worker);
    await enqueueFence.locked;
    const enqueued = await runtime.runPromise(
      repository.enqueue({
        providerSessionThreadId: "thread-two-connection-fence-enqueue",
        queuedEventSequence: enqueueSequence,
        threadId: "thread-two-connection-fence-enqueue",
        messageId: "message-two-connection-fence-enqueue",
        dispatchMode: "queue",
        createdAt: now,
      }),
    );
    await enqueueFence.committed;
    assert.isFalse(enqueued);
    assert.isTrue(
      Option.isNone(await runtime.runPromise(repository.getBySequence(enqueueSequence))),
    );

    const claimSequence = await insertSourceEvent("claim", 0);
    assert.isTrue(
      await runtime.runPromise(
        repository.enqueue({
          providerSessionThreadId: "thread-two-connection-fence-claim",
          queuedEventSequence: claimSequence,
          threadId: "thread-two-connection-fence-claim",
          messageId: "message-two-connection-fence-claim",
          dispatchMode: "queue",
          createdAt: now,
        }),
      ),
    );
    const claimFence = beginConcurrentFence({
      dbPath,
      providerSessionThreadId: "thread-two-connection-fence-claim",
      throughEventSequence: claimSequence,
      updatedAt: "2026-07-25T00:05:00.000Z",
    });
    workers.push(claimFence.worker);
    await claimFence.locked;
    const claimed = await runtime.runPromise(
      repository.claimNextForThreads({
        providerSessionThreadId: "thread-two-connection-fence-claim",
        threadIds: ["thread-two-connection-fence-claim"],
        claimOwner: "two-connection-claim-owner",
        claimedAt: "2026-07-25T00:05:01.000Z",
        claimExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    await claimFence.committed;
    assert.isTrue(Option.isNone(claimed));
    assert.deepInclude(
      (await runtime.runPromise(repository.getBySequence(claimSequence))).pipe(Option.getOrThrow),
      { state: "cancelled" },
    );
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    await runtime.dispose();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
