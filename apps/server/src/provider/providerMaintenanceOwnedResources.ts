import type { ProviderKind } from "@synara/contracts";
import { Cause, Data, Effect, Ref, Result } from "effect";
import * as Semaphore from "effect/Semaphore";

export interface ProviderMaintenanceOwnedResourceCloseFailure {
  readonly resourceId: string;
  readonly cause: unknown;
}

export class ProviderMaintenanceOwnedResourceCloseError extends Data.TaggedError(
  "ProviderMaintenanceOwnedResourceCloseError",
)<{
  readonly provider: ProviderKind;
  readonly resourceId: string;
  readonly cause: unknown;
  readonly failures: ReadonlyArray<ProviderMaintenanceOwnedResourceCloseFailure>;
}> {
  override get message(): string {
    if (this.failures.length > 1) {
      const details = this.failures
        .map((failure) => {
          const detail =
            failure.cause instanceof Error ? failure.cause.message : String(failure.cause);
          return `'${failure.resourceId}': ${detail}`;
        })
        .join("; ");
      return `Failed to close ${this.failures.length} provider-owned resources for '${this.provider}': ${details}`;
    }
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Failed to close provider-owned resource '${this.resourceId}' for '${this.provider}': ${detail}`;
  }
}

export interface ProviderMaintenanceOwnedResourceRegistration {
  readonly provider: ProviderKind;
  readonly resourceId: string;
  readonly unregister: Effect.Effect<void>;
}

export interface ProviderMaintenanceOwnedResourceCoordinator {
  /**
   * Registers one exact Synara-owned resource. The close effect must be bounded, retryable, and
   * idempotent: a failed close remains registered, while a proven successful close is removed
   * automatically. Once a drain claims a close, interruption waits for every claimed close to settle.
   */
  readonly register: (input: {
    readonly provider: ProviderKind;
    readonly resourceId: string;
    readonly close: () => Effect.Effect<void, unknown>;
  }) => Effect.Effect<ProviderMaintenanceOwnedResourceRegistration>;
  /** Closes every currently registered resource for one provider before its updater may run. */
  readonly drainProviderResources: (input: {
    readonly provider: ProviderKind;
  }) => Effect.Effect<void, ProviderMaintenanceOwnedResourceCloseError>;
}

interface OwnedResourceRecord {
  readonly token: number;
  readonly provider: ProviderKind;
  readonly resourceId: string;
  readonly close: () => Effect.Effect<void, unknown>;
  readonly closeMutex: Semaphore.Semaphore;
}

type OwnedResourceRecords = ReadonlyMap<number, OwnedResourceRecord>;

/**
 * Coordinates non-session processes that are owned by Synara and may keep a provider CLI binary
 * in use. ProviderMaintenanceGate supplies the provider-level admission barrier; this coordinator
 * supplies exact resource ownership and retryable shutdown inside that barrier.
 */
export const makeProviderMaintenanceOwnedResourceCoordinator = Effect.gen(function* () {
  const recordsRef = yield* Ref.make<OwnedResourceRecords>(new Map());
  const nextTokenRef = yield* Ref.make(1);

  const removeRecord = (record: OwnedResourceRecord) =>
    Ref.update(recordsRef, (records) => {
      if (records.get(record.token) !== record) {
        return records;
      }
      const next = new Map(records);
      next.delete(record.token);
      return next;
    });

  const register: ProviderMaintenanceOwnedResourceCoordinator["register"] = (input) =>
    Effect.gen(function* () {
      const token = yield* Ref.getAndUpdate(nextTokenRef, (current) => current + 1);
      const closeMutex = yield* Semaphore.make(1);
      const record: OwnedResourceRecord = {
        token,
        provider: input.provider,
        resourceId: input.resourceId,
        close: input.close,
        closeMutex,
      };
      yield* Ref.update(recordsRef, (records) => {
        const next = new Map(records);
        next.set(token, record);
        return next;
      });
      return {
        provider: input.provider,
        resourceId: input.resourceId,
        unregister: removeRecord(record),
      } satisfies ProviderMaintenanceOwnedResourceRegistration;
    });

  const closeRecord = (record: OwnedResourceRecord) =>
    record.closeMutex.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const records = yield* Ref.get(recordsRef);
          if (records.get(record.token) !== record) {
            return;
          }
          yield* Effect.suspend(record.close).pipe(
            Effect.catchCause((cause) => {
              const failure = {
                resourceId: record.resourceId,
                cause: Cause.squash(cause),
              } satisfies ProviderMaintenanceOwnedResourceCloseFailure;
              return Effect.fail(
                new ProviderMaintenanceOwnedResourceCloseError({
                  provider: record.provider,
                  resourceId: failure.resourceId,
                  cause: failure.cause,
                  failures: [failure],
                }),
              );
            }),
          );
          yield* removeRecord(record);
        }),
      ),
    );

  const drainProviderResources: ProviderMaintenanceOwnedResourceCoordinator["drainProviderResources"] =
    (input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const records = yield* Ref.get(recordsRef);
          const providerRecords = Array.from(records.values()).filter(
            (record) => record.provider === input.provider,
          );
          const closeResults = yield* Effect.forEach(
            providerRecords,
            (record) => closeRecord(record).pipe(Effect.result),
            { concurrency: 1 },
          );
          const failures = closeResults.flatMap((result) =>
            Result.isFailure(result) ? result.failure.failures : [],
          );
          const firstFailure = failures[0];
          if (firstFailure === undefined) {
            return;
          }
          return yield* new ProviderMaintenanceOwnedResourceCloseError({
            provider: input.provider,
            resourceId: firstFailure.resourceId,
            cause: firstFailure.cause,
            failures,
          });
        }),
      );

  return {
    register,
    drainProviderResources,
  } satisfies ProviderMaintenanceOwnedResourceCoordinator;
});
