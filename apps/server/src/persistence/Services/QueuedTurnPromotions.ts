import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface QueuedTurnPromotion {
  readonly queuedEventSequence: number;
  readonly threadId: string;
  readonly messageId: string;
  readonly dispatchMode: "queue" | "steer";
  readonly state: "queued" | "promoting" | "promoted" | "cancelled";
  readonly claimOwner: string | null;
  readonly attemptCount: number;
}

export interface QueuedTurnPromotionRepositoryShape {
  readonly getBySequence: (
    queuedEventSequence: number,
  ) => Effect.Effect<Option.Option<QueuedTurnPromotion>, PersistenceSqlError>;
  readonly enqueue: (input: {
    readonly queuedEventSequence: number;
    readonly threadId: string;
    readonly messageId: string;
    readonly dispatchMode: "queue" | "steer";
    readonly createdAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly claimNext: (input: {
    readonly threadId: string;
    readonly claimOwner: string;
    readonly claimedAt: string;
    readonly claimExpiresAt: string;
  }) => Effect.Effect<Option.Option<QueuedTurnPromotion>, PersistenceSqlError>;
  /**
   * Claim the next promotion across every thread sharing one provider session.
   * Ordering matches the ordinary queue policy globally: newest steer first,
   * then queued work in durable source order. Quarantine recovery stores its
   * rows as `queue`, so those rows remain strict FIFO.
   */
  readonly claimNextForThreads: (input: {
    readonly threadIds: ReadonlyArray<string>;
    readonly claimOwner: string;
    readonly claimedAt: string;
    readonly claimExpiresAt: string;
  }) => Effect.Effect<Option.Option<QueuedTurnPromotion>, PersistenceSqlError>;
  readonly markPromoted: (input: {
    readonly queuedEventSequence: number;
    readonly claimOwner: string;
    readonly promotedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly releaseClaim: (input: {
    readonly queuedEventSequence: number;
    readonly claimOwner: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly cancelMessage: (input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly updatedAt: string;
    readonly throughEventSequence?: number | undefined;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  /**
   * Cancel all in-flight promotions for a thread. Matches both 'queued' and
   * 'promoting' rows so that a cancellation racing an in-flight drain cannot be
   * resurrected: a cancelled 'promoting' row no longer matches `releaseClaim`
   * (WHERE state='promoting'), so the drain's error path leaves it dead.
   */
  readonly cancelThread: (input: {
    readonly threadId: string;
    readonly updatedAt: string;
    readonly throughEventSequence?: number | undefined;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly hasPendingMessage: (input: {
    readonly threadId: string;
    readonly messageId: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly listPendingThreadIds: Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
  /**
   * Includes promoted source rows because they remain the durable cancellation
   * proof for a deterministic derived start that may not have executed yet.
   */
  readonly listCancellableThreadIds: Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
}

export class QueuedTurnPromotionRepository extends ServiceMap.Service<
  QueuedTurnPromotionRepository,
  QueuedTurnPromotionRepositoryShape
>()("synara/persistence/Services/QueuedTurnPromotions/QueuedTurnPromotionRepository") {}
