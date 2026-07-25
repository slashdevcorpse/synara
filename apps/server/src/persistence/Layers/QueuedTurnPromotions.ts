import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  QueuedTurnPromotionRepository,
  type QueuedTurnPromotion,
  type QueuedTurnPromotionRepositoryShape,
} from "../Services/QueuedTurnPromotions.ts";

const columns = (sql: SqlClient.SqlClient) => sql`
  queued_event_sequence AS "queuedEventSequence",
  thread_id AS "threadId",
  message_id AS "messageId",
  dispatch_mode AS "dispatchMode",
  state,
  claim_owner AS "claimOwner",
  attempt_count AS "attemptCount"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getBySequence: QueuedTurnPromotionRepositoryShape["getBySequence"] = (
    queuedEventSequence,
  ) =>
    sql<QueuedTurnPromotion>`
        SELECT ${columns(sql)}
        FROM queued_turn_promotions
        WHERE queued_event_sequence = ${queuedEventSequence}
      `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.getBySequence")),
    );

  const enqueue: QueuedTurnPromotionRepositoryShape["enqueue"] = (input) =>
    sql`
      INSERT INTO queued_turn_promotions (
        queued_event_sequence, thread_id, message_id, dispatch_mode, state,
        claim_owner, claimed_at, claim_expires_at, attempt_count,
        created_at, updated_at, promoted_at
      )
      SELECT
        ${input.queuedEventSequence}, ${input.threadId}, ${input.messageId},
        ${input.dispatchMode}, 'queued', NULL, NULL, NULL, 0,
        ${input.createdAt}, ${input.createdAt}, NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM queued_turn_promotions AS cancelled
        INNER JOIN orchestration_events AS source
          ON source.sequence = ${input.queuedEventSequence}
          AND source.command_id =
            'server:dispatch-queued-turn:' || cancelled.queued_event_sequence
        WHERE cancelled.thread_id = ${input.threadId}
          AND cancelled.message_id = ${input.messageId}
          AND cancelled.state = 'cancelled'
      )
      ON CONFLICT DO UPDATE SET
        queued_event_sequence = excluded.queued_event_sequence,
        dispatch_mode = excluded.dispatch_mode,
        state = 'queued',
        claim_owner = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        attempt_count = 0,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        promoted_at = NULL
      WHERE excluded.queued_event_sequence > queued_turn_promotions.queued_event_sequence
        AND EXISTS (
          SELECT 1
          FROM orchestration_events AS source
          WHERE source.sequence = excluded.queued_event_sequence
            AND source.command_id =
              'server:dispatch-queued-turn:' ||
              queued_turn_promotions.queued_event_sequence
        )
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.enqueue")));

  const claimNextForThreadIds = (input: {
    readonly threadIds: ReadonlyArray<string>;
    readonly claimOwner: string;
    readonly claimedAt: string;
    readonly claimExpiresAt: string;
  }) => {
    const threadIds = [...new Set(input.threadIds)];
    if (threadIds.length === 0) {
      return Effect.succeed(Option.none<QueuedTurnPromotion>());
    }
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          UPDATE queued_turn_promotions
          SET state = 'queued', claim_owner = NULL, claimed_at = NULL,
              claim_expires_at = NULL, updated_at = ${input.claimedAt}
          WHERE thread_id IN ${sql.in(threadIds)}
            AND state = 'promoting'
            AND (
              claim_expires_at <= ${input.claimedAt}
              OR claim_owner <> ${input.claimOwner}
            )
        `;
          const candidates = yield* sql<{ readonly queuedEventSequence: number }>`
          SELECT queued_event_sequence AS "queuedEventSequence"
          FROM queued_turn_promotions
          WHERE thread_id IN ${sql.in(threadIds)} AND state = 'queued'
          ORDER BY
            CASE dispatch_mode WHEN 'steer' THEN 0 ELSE 1 END ASC,
            CASE WHEN dispatch_mode = 'steer' THEN queued_event_sequence END DESC,
            queued_event_sequence ASC
          LIMIT 1
        `;
          const sequence = candidates[0]?.queuedEventSequence;
          if (sequence === undefined) return Option.none<QueuedTurnPromotion>();
          const rows = yield* sql<QueuedTurnPromotion>`
          UPDATE queued_turn_promotions
          SET state = 'promoting', claim_owner = ${input.claimOwner},
              claimed_at = ${input.claimedAt}, claim_expires_at = ${input.claimExpiresAt},
              attempt_count = attempt_count + 1, updated_at = ${input.claimedAt}
          WHERE queued_event_sequence = ${sequence} AND state = 'queued'
          RETURNING ${columns(sql)}
        `;
          return Option.fromNullishOr(rows[0]);
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.claimNextForThreads")));
  };

  const claimNext: QueuedTurnPromotionRepositoryShape["claimNext"] = (input) =>
    claimNextForThreadIds({
      threadIds: [input.threadId],
      claimOwner: input.claimOwner,
      claimedAt: input.claimedAt,
      claimExpiresAt: input.claimExpiresAt,
    });

  const claimNextForThreads: QueuedTurnPromotionRepositoryShape["claimNextForThreads"] =
    claimNextForThreadIds;

  const markPromoted: QueuedTurnPromotionRepositoryShape["markPromoted"] = (input) =>
    sql<{ readonly sequence: number }>`
      UPDATE queued_turn_promotions
      SET state = 'promoted', claim_owner = NULL, claimed_at = NULL,
          claim_expires_at = NULL, promoted_at = ${input.promotedAt},
          updated_at = ${input.promotedAt}
      WHERE queued_event_sequence = ${input.queuedEventSequence}
        AND state = 'promoting' AND claim_owner = ${input.claimOwner}
      RETURNING queued_event_sequence AS sequence
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.markPromoted")),
    );

  const releaseClaim: QueuedTurnPromotionRepositoryShape["releaseClaim"] = (input) =>
    sql<{ readonly sequence: number }>`
      UPDATE queued_turn_promotions
      SET state = 'queued', claim_owner = NULL, claimed_at = NULL,
          claim_expires_at = NULL, updated_at = ${input.updatedAt}
      WHERE queued_event_sequence = ${input.queuedEventSequence}
        AND state = 'promoting' AND claim_owner = ${input.claimOwner}
      RETURNING queued_event_sequence AS sequence
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.releaseClaim")),
    );

  const cancelMessage: QueuedTurnPromotionRepositoryShape["cancelMessage"] = (input) => {
    const sequenceFence =
      input.throughEventSequence === undefined
        ? sql``
        : sql`AND queued_event_sequence <= ${input.throughEventSequence}`;
    return sql<{ readonly sequence: number }>`
      UPDATE queued_turn_promotions
      SET state = 'cancelled', claim_owner = NULL, claimed_at = NULL,
          claim_expires_at = NULL, updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
        AND state IN ('queued', 'promoting', 'promoted')
        ${sequenceFence}
      RETURNING queued_event_sequence AS sequence
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.cancelMessage")),
    );
  };

  const cancelThread: QueuedTurnPromotionRepositoryShape["cancelThread"] = (input) => {
    const sequenceFence =
      input.throughEventSequence === undefined
        ? sql``
        : sql`AND queued_event_sequence <= ${input.throughEventSequence}`;
    // Cancel queued, claimed, and handed-off rows. A promoted source remains
    // the durable lineage for its deterministic derived start until provider
    // execution, so stop/edit barriers must be able to tombstone it too.
    return sql`
      UPDATE queued_turn_promotions
      SET state = 'cancelled', claim_owner = NULL, claimed_at = NULL,
          claim_expires_at = NULL, updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId}
        AND state IN ('queued', 'promoting', 'promoted')
        ${sequenceFence}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.cancelThread")),
    );
  };

  const cancelProviderSessionThrough: QueuedTurnPromotionRepositoryShape["cancelProviderSessionThrough"] =
    (input) => {
      const memberThreadIds = [...new Set(input.memberThreadIds)];
      return sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO queued_turn_promotion_cancellation_fences (
                provider_session_thread_id, through_event_sequence, updated_at
              ) VALUES (
                ${input.providerSessionThreadId}, ${input.throughEventSequence}, ${input.updatedAt}
              )
              ON CONFLICT (provider_session_thread_id) DO UPDATE SET
                through_event_sequence = excluded.through_event_sequence,
                updated_at = excluded.updated_at
              WHERE excluded.through_event_sequence >
                queued_turn_promotion_cancellation_fences.through_event_sequence
            `;
            if (memberThreadIds.length === 0) {
              return;
            }
            yield* sql`
              UPDATE queued_turn_promotions
              SET state = 'cancelled', claim_owner = NULL, claimed_at = NULL,
                  claim_expires_at = NULL, updated_at = ${input.updatedAt}
              WHERE thread_id IN ${sql.in(memberThreadIds)}
                AND state IN ('queued', 'promoting', 'promoted')
                AND queued_event_sequence <= (
                  SELECT through_event_sequence
                  FROM queued_turn_promotion_cancellation_fences
                  WHERE provider_session_thread_id = ${input.providerSessionThreadId}
                )
            `;
          }),
        )
        .pipe(
          Effect.mapError(
            toPersistenceSqlError("QueuedTurnPromotion.cancelProviderSessionThrough"),
          ),
        );
    };

  const isQueuedEventCancelledByProviderSessionFence: QueuedTurnPromotionRepositoryShape["isQueuedEventCancelledByProviderSessionFence"] =
    (input) =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM queued_turn_promotion_cancellation_fences
        WHERE provider_session_thread_id = ${input.providerSessionThreadId}
          AND through_event_sequence >= ${input.queuedEventSequence}
      `.pipe(
        Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
        Effect.mapError(
          toPersistenceSqlError(
            "QueuedTurnPromotion.isQueuedEventCancelledByProviderSessionFence",
          ),
        ),
      );

  const hasPendingMessage: QueuedTurnPromotionRepositoryShape["hasPendingMessage"] = (input) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM queued_turn_promotions
      WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
        AND state IN ('queued', 'promoting')
    `.pipe(
      Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
      Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.hasPendingMessage")),
    );

  const listPendingThreadIds = sql<{ readonly threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId"
    FROM queued_turn_promotions
    WHERE state IN ('queued', 'promoting')
    ORDER BY thread_id ASC
  `.pipe(
    Effect.map((rows) => rows.map((row) => row.threadId)),
    Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.listPendingThreadIds")),
  );

  const listCancellableThreadIds = sql<{ readonly threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId"
    FROM queued_turn_promotions
    WHERE state IN ('queued', 'promoting', 'promoted')
    ORDER BY thread_id ASC
  `.pipe(
    Effect.map((rows) => rows.map((row) => row.threadId)),
    Effect.mapError(toPersistenceSqlError("QueuedTurnPromotion.listCancellableThreadIds")),
  );

  return {
    getBySequence,
    enqueue,
    claimNext,
    claimNextForThreads,
    markPromoted,
    releaseClaim,
    cancelMessage,
    cancelThread,
    cancelProviderSessionThrough,
    isQueuedEventCancelledByProviderSessionFence,
    hasPendingMessage,
    listPendingThreadIds,
    listCancellableThreadIds,
  } satisfies QueuedTurnPromotionRepositoryShape;
});

export const QueuedTurnPromotionRepositoryLive = Layer.effect(QueuedTurnPromotionRepository, make);
