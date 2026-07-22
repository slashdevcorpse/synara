import type { ProviderKind } from "@synara/contracts";
import { Cause, Effect, Exit } from "effect";
import * as Semaphore from "effect/Semaphore";

import type {
  ProviderMaintenanceOwnedResourceCoordinator,
  ProviderMaintenanceOwnedResourceRegistration,
} from "./providerMaintenanceOwnedResources.ts";

export interface RetryableProviderProcessSupervisor {
  readonly rootPid: number;
  readonly proveExit: () => Promise<unknown>;
  readonly teardown: () => Promise<unknown>;
}

export interface TrackedProviderProcessOwner {
  readonly resourceId: string;
  readonly supervisor: RetryableProviderProcessSupervisor;
}

interface MutableTrackedProviderProcessOwner extends TrackedProviderProcessOwner {
  registration: ProviderMaintenanceOwnedResourceRegistration | null;
  readonly closeMutex: Semaphore.Semaphore;
}

export interface ProviderProcessOwnerTracker {
  readonly register: (
    supervisor: RetryableProviderProcessSupervisor,
  ) => Effect.Effect<TrackedProviderProcessOwner>;
  readonly proveExit: (owner: TrackedProviderProcessOwner) => Effect.Effect<void, unknown>;
  readonly teardown: (owner: TrackedProviderProcessOwner) => Effect.Effect<void, unknown>;
  readonly drain: Effect.Effect<void, unknown>;
  readonly drainExcluding: (
    owners: Iterable<TrackedProviderProcessOwner>,
  ) => Effect.Effect<void, unknown>;
  readonly findOwner: (
    supervisor: RetryableProviderProcessSupervisor,
  ) => TrackedProviderProcessOwner | undefined;
}

/**
 * Retains exact process supervisors beyond request-local scopes. Failed proof remains registered
 * for provider maintenance and adapter shutdown; only successful proof releases ownership.
 */
export function makeProviderProcessOwnerTracker(input: {
  readonly provider: ProviderKind;
  readonly resourcePrefix: string;
  readonly maintenanceOwnedResources: ProviderMaintenanceOwnedResourceCoordinator;
}): ProviderProcessOwnerTracker {
  const owners = new Set<MutableTrackedProviderProcessOwner>();
  let nextResourceId = 1;

  const asMutableOwner = (owner: TrackedProviderProcessOwner) =>
    owner as MutableTrackedProviderProcessOwner;

  const release = (owner: MutableTrackedProviderProcessOwner) =>
    Effect.gen(function* () {
      if (!owners.has(owner)) return;
      if (owner.registration !== null) {
        yield* owner.registration.unregister;
        owner.registration = null;
      }
      owners.delete(owner);
    });

  const complete = (owner: TrackedProviderProcessOwner, operation: "proveExit" | "teardown") =>
    asMutableOwner(owner).closeMutex.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const tracked = asMutableOwner(owner);
          if (!owners.has(tracked)) return;
          yield* Effect.tryPromise({
            try: tracked.supervisor[operation],
            catch: (cause) => cause,
          });
          yield* release(tracked);
        }),
      ),
    );

  const teardown = (owner: TrackedProviderProcessOwner) => complete(owner, "teardown");

  const register: ProviderProcessOwnerTracker["register"] = (supervisor) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const resourceId = `${input.resourcePrefix}:${String(supervisor.rootPid)}:${String(nextResourceId)}`;
        nextResourceId += 1;
        const closeMutex = yield* Semaphore.make(1);
        const owner: MutableTrackedProviderProcessOwner = {
          resourceId,
          supervisor,
          registration: null,
          closeMutex,
        };
        // Retain first. If registration defects, the adapter-level tracker can still drain the
        // exact owner instead of losing it with the failed acquisition.
        owners.add(owner);
        owner.registration = yield* input.maintenanceOwnedResources.register({
          provider: input.provider,
          resourceId,
          close: () => teardown(owner),
        });
        return owner;
      }),
    );

  const drainExcluding: ProviderProcessOwnerTracker["drainExcluding"] = (excludedOwners) =>
    Effect.gen(function* () {
      const excluded = new Set(excludedOwners);
      const failures: unknown[] = [];
      for (const owner of Array.from(owners)) {
        if (excluded.has(owner)) continue;
        const exit = yield* Effect.exit(teardown(owner));
        if (Exit.isFailure(exit)) failures.push(Cause.squash(exit.cause));
      }
      if (failures.length === 1) return yield* Effect.fail(failures[0]);
      if (failures.length > 1) {
        return yield* Effect.fail(
          new AggregateError(
            failures,
            `Failed to prove exit for ${String(failures.length)} ${input.provider} process owners.`,
          ),
        );
      }
    }).pipe(Effect.uninterruptible);

  const drain = drainExcluding([]);

  return {
    register,
    proveExit: (owner) => complete(owner, "proveExit"),
    teardown,
    drain,
    drainExcluding,
    findOwner: (supervisor) => Array.from(owners).find((owner) => owner.supervisor === supervisor),
  };
}
