import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  makeProviderMaintenanceOwnedResourceCoordinator,
  type ProviderMaintenanceOwnedResourceCoordinator,
} from "./providerMaintenanceOwnedResources";
import { makeProviderProcessOwnerTracker } from "./providerProcessOwnerTracker";

function makeSupervisor(input: {
  readonly rootPid: number;
  readonly proveExit?: () => Promise<unknown>;
  readonly teardown?: () => Promise<unknown>;
}) {
  return {
    rootPid: input.rootPid,
    proveExit: input.proveExit ?? (async () => undefined),
    teardown: input.teardown ?? (async () => undefined),
  };
}

describe("provider process owner tracker", () => {
  it("retains a failed maintenance close and succeeds on retry", async () => {
    const coordinator = Effect.runSync(makeProviderMaintenanceOwnedResourceCoordinator);
    const teardown = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first proof failed"))
      .mockResolvedValue(undefined);
    const tracker = makeProviderProcessOwnerTracker({
      provider: "pi",
      resourcePrefix: "test-process",
      maintenanceOwnedResources: coordinator,
    });
    await Effect.runPromise(tracker.register(makeSupervisor({ rootPid: 4101, teardown })));

    await expect(
      Effect.runPromise(coordinator.drainProviderResources({ provider: "pi" })),
    ).rejects.toThrow("first proof failed");
    await expect(
      Effect.runPromise(coordinator.drainProviderResources({ provider: "pi" })),
    ).resolves.toBeUndefined();
    await Effect.runPromise(coordinator.drainProviderResources({ provider: "pi" }));

    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it("attempts every owner and aggregates multiple drain failures", async () => {
    const coordinator = Effect.runSync(makeProviderMaintenanceOwnedResourceCoordinator);
    const firstTeardown = vi.fn(async () => {
      throw new Error("first owner failed");
    });
    const secondTeardown = vi.fn(async () => {
      throw new Error("second owner failed");
    });
    const tracker = makeProviderProcessOwnerTracker({
      provider: "cursor",
      resourcePrefix: "test-process",
      maintenanceOwnedResources: coordinator,
    });
    await Effect.runPromise(
      tracker.register(makeSupervisor({ rootPid: 4201, teardown: firstTeardown })),
    );
    await Effect.runPromise(
      tracker.register(makeSupervisor({ rootPid: 4202, teardown: secondTeardown })),
    );

    const failure = await Effect.runPromise(tracker.drain).catch((cause) => cause);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(firstTeardown).toHaveBeenCalledTimes(1);
    expect(secondTeardown).toHaveBeenCalledTimes(1);
  });

  it("unregisters after successful proof and makes duplicate completion idempotent", async () => {
    const coordinator = Effect.runSync(makeProviderMaintenanceOwnedResourceCoordinator);
    const proveExit = vi.fn(async () => undefined);
    const teardown = vi.fn(async () => undefined);
    const tracker = makeProviderProcessOwnerTracker({
      provider: "grok",
      resourcePrefix: "test-process",
      maintenanceOwnedResources: coordinator,
    });
    const owner = await Effect.runPromise(
      tracker.register(makeSupervisor({ rootPid: 4301, proveExit, teardown })),
    );

    await Promise.all([
      Effect.runPromise(tracker.proveExit(owner)),
      Effect.runPromise(tracker.proveExit(owner)),
    ]);
    await Effect.runPromise(tracker.teardown(owner));
    await Effect.runPromise(coordinator.drainProviderResources({ provider: "grok" }));

    expect(proveExit).toHaveBeenCalledTimes(1);
    expect(teardown).not.toHaveBeenCalled();
  });

  it("serializes concurrent maintenance and adapter drains around one proof", async () => {
    const coordinator = Effect.runSync(makeProviderMaintenanceOwnedResourceCoordinator);
    let releaseTeardown!: () => void;
    const teardownStarted = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    let finishTeardown!: () => void;
    const teardownGate = new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
    const teardown = vi.fn(async () => {
      releaseTeardown();
      await teardownGate;
    });
    const tracker = makeProviderProcessOwnerTracker({
      provider: "command-code",
      resourcePrefix: "test-process",
      maintenanceOwnedResources: coordinator,
    });
    await Effect.runPromise(tracker.register(makeSupervisor({ rootPid: 4401, teardown })));

    const maintenance = Effect.runPromise(
      coordinator.drainProviderResources({ provider: "command-code" }),
    );
    await teardownStarted;
    const adapterDrain = Effect.runPromise(tracker.drain);
    finishTeardown();

    await expect(Promise.all([maintenance, adapterDrain])).resolves.toEqual([undefined, undefined]);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("retains the owner when coordinator registration defects", async () => {
    const teardown = vi.fn(async () => undefined);
    const coordinator = {
      register: () => Effect.die(new Error("registration failed")),
      drainProviderResources: () => Effect.void,
    } as unknown as ProviderMaintenanceOwnedResourceCoordinator;
    const tracker = makeProviderProcessOwnerTracker({
      provider: "antigravity",
      resourcePrefix: "test-process",
      maintenanceOwnedResources: coordinator,
    });

    await expect(
      Effect.runPromise(tracker.register(makeSupervisor({ rootPid: 4501, teardown }))),
    ).rejects.toThrow("registration failed");
    await Effect.runPromise(tracker.drain);

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("keeps an interrupted registration reachable by adapter drain", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registrationStarted = yield* Deferred.make<void>();
        const allowRegistration = yield* Deferred.make<void>();
        const teardown = vi.fn(async () => undefined);
        const coordinator = {
          register: () =>
            Deferred.succeed(registrationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowRegistration)),
              Effect.as({
                provider: "opencode" as const,
                resourceId: "interrupted-registration",
                unregister: Effect.void,
              }),
            ),
          drainProviderResources: () => Effect.void,
        } satisfies ProviderMaintenanceOwnedResourceCoordinator;
        const tracker = makeProviderProcessOwnerTracker({
          provider: "opencode",
          resourcePrefix: "test-process",
          maintenanceOwnedResources: coordinator,
        });
        const registration = yield* tracker
          .register(makeSupervisor({ rootPid: 4601, teardown }))
          .pipe(Effect.forkChild);
        yield* Deferred.await(registrationStarted);
        const interrupting = yield* Fiber.interrupt(registration).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(allowRegistration, undefined);
        yield* Fiber.join(interrupting);
        yield* tracker.drain;

        expect(teardown).toHaveBeenCalledTimes(1);
      }),
    );
  });
});
