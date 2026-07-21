import type { ProviderKind } from "@synara/contracts";
import { Cause, Data, Deferred, Effect, Ref } from "effect";

export class ProviderMaintenanceBusyError extends Data.TaggedError("ProviderMaintenanceBusyError")<{
  readonly provider: ProviderKind;
  readonly operation: string;
  readonly latchedReason: string | null;
}> {
  override get message(): string {
    if (this.latchedReason !== null) {
      return `Provider '${this.provider}' remains unavailable because updater process exit could not be proven. Restart Synara before retrying '${this.operation}'. ${this.latchedReason}`;
    }
    return `Provider '${this.provider}' is unavailable while its CLI is being updated (${this.operation}).`;
  }
}

export class ProviderMaintenanceAlreadyRunningError extends Data.TaggedError(
  "ProviderMaintenanceAlreadyRunningError",
)<{
  readonly provider: ProviderKind;
}> {
  override get message(): string {
    return `Provider maintenance is already running for '${this.provider}'.`;
  }
}

export class ProviderMaintenanceLatchedError extends Data.TaggedError(
  "ProviderMaintenanceLatchedError",
)<{
  readonly provider: ProviderKind;
  readonly reason: string;
}> {
  override get message(): string {
    return `Provider '${this.provider}' remains unavailable because process exit could not be proven: ${this.reason}`;
  }
}

export interface ProviderMaintenanceGate {
  readonly withOperation: <A, E, R>(input: {
    readonly provider: ProviderKind;
    readonly operation: string;
    readonly run: Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E | ProviderMaintenanceBusyError, R>;
  readonly withExclusiveMaintenance: <A, E, R>(input: {
    readonly provider: ProviderKind;
    readonly run: Effect.Effect<A, E, R>;
    /** Returning a reason atomically latches the provider before exclusive admission is released. */
    readonly latchReasonOnFailure?: (cause: Cause.Cause<E>) => string | null;
  }) => Effect.Effect<
    A,
    E | ProviderMaintenanceAlreadyRunningError | ProviderMaintenanceLatchedError,
    R
  >;
  /** Fail closed until process restart when a maintenance process tree cannot prove exit. */
  readonly latchProvider: (input: {
    readonly provider: ProviderKind;
    readonly reason: string;
  }) => Effect.Effect<void>;
}

interface ProviderMaintenanceGateState {
  readonly activeOperations: number;
  readonly drain: Deferred.Deferred<void> | null;
  readonly latchedReason: string | null;
}

type ProviderMaintenanceGateStates = ReadonlyMap<ProviderKind, ProviderMaintenanceGateState>;

/**
 * Creates an isolated, dependency-free gate for coordinating short provider
 * operations with exclusive CLI maintenance.
 */
export const makeProviderMaintenanceGate = Effect.gen(function* () {
  const statesRef = yield* Ref.make<ProviderMaintenanceGateStates>(new Map());

  const acquireOperation = (provider: ProviderKind) =>
    Ref.modify(statesRef, (states) => {
      const current = states.get(provider);
      if (current !== undefined && (current.drain !== null || current.latchedReason !== null)) {
        return [{ acquired: false as const, reason: current.latchedReason }, states] as const;
      }

      const next = new Map(states);
      next.set(provider, {
        activeOperations: (current?.activeOperations ?? 0) + 1,
        drain: null,
        latchedReason: null,
      });
      return [{ acquired: true as const, reason: null }, next] as const;
    });

  const releaseOperation = (provider: ProviderKind) =>
    Ref.modify(statesRef, (states) => {
      const current = states.get(provider);
      if (current === undefined || current.activeOperations === 0) {
        return [
          Effect.die(`Provider maintenance admission underflow for '${provider}'.`),
          states,
        ] as const;
      }

      const activeOperations = current.activeOperations - 1;
      const next = new Map(states);
      if (activeOperations === 0 && current.drain === null && current.latchedReason === null) {
        next.delete(provider);
      } else {
        next.set(provider, { ...current, activeOperations });
      }

      const completeDrain =
        activeOperations === 0 && current.drain !== null
          ? Deferred.succeed(current.drain, undefined).pipe(Effect.asVoid)
          : Effect.void;
      return [completeDrain, next] as const;
    }).pipe(Effect.flatten);

  const requestMaintenance = (provider: ProviderKind, drain: Deferred.Deferred<void>) =>
    Ref.modify(statesRef, (states) => {
      const current = states.get(provider);
      if (current?.latchedReason !== null && current?.latchedReason !== undefined) {
        return [
          {
            acquired: false as const,
            activeOperations: 0,
            latchedReason: current.latchedReason,
          },
          states,
        ] as const;
      }
      if (current !== undefined && current.drain !== null) {
        return [
          { acquired: false as const, activeOperations: 0, latchedReason: null },
          states,
        ] as const;
      }

      const activeOperations = current?.activeOperations ?? 0;
      const next = new Map(states);
      next.set(provider, { activeOperations, drain, latchedReason: null });
      return [{ acquired: true as const, activeOperations, latchedReason: null }, next] as const;
    });

  const releaseMaintenance = (provider: ProviderKind, drain: Deferred.Deferred<void>) =>
    Ref.update(statesRef, (states) => {
      const current = states.get(provider);
      if (current?.drain !== drain) {
        return states;
      }

      const next = new Map(states);
      if (current.activeOperations === 0 && current.latchedReason === null) {
        next.delete(provider);
      } else {
        next.set(provider, { ...current, drain: null });
      }
      return next;
    });

  const latchProvider: ProviderMaintenanceGate["latchProvider"] = (input) =>
    Ref.update(statesRef, (states) => {
      const current = states.get(input.provider);
      const next = new Map(states);
      next.set(input.provider, {
        activeOperations: current?.activeOperations ?? 0,
        drain: current?.drain ?? null,
        latchedReason: input.reason,
      });
      return next;
    });

  const withOperation: ProviderMaintenanceGate["withOperation"] = (input) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const acquisition = yield* acquireOperation(input.provider);
        if (!acquisition.acquired) {
          return yield* new ProviderMaintenanceBusyError({
            provider: input.provider,
            operation: input.operation,
            latchedReason: acquisition.reason,
          });
        }

        return yield* restore(input.run).pipe(Effect.ensuring(releaseOperation(input.provider)));
      }),
    );

  const withExclusiveMaintenance: ProviderMaintenanceGate["withExclusiveMaintenance"] = (input) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const drain = yield* Deferred.make<void>();
        const request = yield* requestMaintenance(input.provider, drain);
        if (!request.acquired) {
          if (request.latchedReason !== null) {
            return yield* new ProviderMaintenanceLatchedError({
              provider: input.provider,
              reason: request.latchedReason,
            });
          }
          return yield* new ProviderMaintenanceAlreadyRunningError({ provider: input.provider });
        }

        if (request.activeOperations === 0) {
          yield* Deferred.succeed(drain, undefined);
        }

        const run = restore(Deferred.await(drain).pipe(Effect.andThen(input.run)));
        const latchBeforeRelease =
          input.latchReasonOnFailure === undefined
            ? run
            : run.pipe(
                Effect.onError((cause) => {
                  const reason = input.latchReasonOnFailure?.(cause) ?? null;
                  return reason === null
                    ? Effect.void
                    : latchProvider({ provider: input.provider, reason });
                }),
              );
        return yield* latchBeforeRelease.pipe(
          Effect.ensuring(releaseMaintenance(input.provider, drain)),
        );
      }),
    );

  return {
    withOperation,
    withExclusiveMaintenance,
    latchProvider,
  } satisfies ProviderMaintenanceGate;
});
