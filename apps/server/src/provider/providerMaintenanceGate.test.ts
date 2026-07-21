import { Deferred, Effect, Fiber, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeProviderMaintenanceGate,
  type ProviderMaintenanceGate,
  ProviderMaintenanceAlreadyRunningError,
  ProviderMaintenanceBusyError,
  ProviderMaintenanceLatchedError,
} from "./providerMaintenanceGate.ts";

function awaitBusyRejection(
  gate: ProviderMaintenanceGate,
  provider: "codex" | "opencode",
): Effect.Effect<ProviderMaintenanceBusyError> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = yield* gate
        .withOperation({ provider, operation: "test.probe", run: Effect.void })
        .pipe(Effect.result);
      if (Result.isFailure(result)) {
        return result.failure;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`Maintenance admission did not close for '${provider}'.`);
  });
}

describe("providerMaintenanceGate", () => {
  it("drains admitted operations and refuses new work once maintenance is requested", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* makeProviderMaintenanceGate;
          const operationStarted = yield* Deferred.make<void>();
          const releaseOperation = yield* Deferred.make<void>();
          let maintenanceEntered = false;

          const operation = yield* gate
            .withOperation({
              provider: "codex",
              operation: "session.start",
              run: Deferred.succeed(operationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseOperation)),
              ),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(operationStarted);

          const maintenance = yield* gate
            .withExclusiveMaintenance({
              provider: "codex",
              run: Effect.sync(() => {
                maintenanceEntered = true;
              }),
            })
            .pipe(Effect.forkChild);
          const refused = yield* awaitBusyRejection(gate, "codex");

          expect(maintenanceEntered).toBe(false);
          expect(refused).toBeInstanceOf(ProviderMaintenanceBusyError);
          expect(refused).toMatchObject({
            provider: "codex",
            operation: "test.probe",
            latchedReason: null,
          });

          yield* Deferred.succeed(releaseOperation, undefined);
          yield* Fiber.join(operation);
          yield* Fiber.join(maintenance);
          expect(maintenanceEntered).toBe(true);
          expect(
            yield* gate.withOperation({
              provider: "codex",
              operation: "provider.health",
              run: Effect.succeed("released"),
            }),
          ).toBe("released");
        }),
      ),
    );
  });

  it("keeps provider admission and maintenance independent", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* makeProviderMaintenanceGate;
          const codexStarted = yield* Deferred.make<void>();
          const releaseCodex = yield* Deferred.make<void>();

          const codexOperation = yield* gate
            .withOperation({
              provider: "codex",
              operation: "session.start",
              run: Deferred.succeed(codexStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCodex)),
              ),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(codexStarted);

          const codexMaintenance = yield* gate
            .withExclusiveMaintenance({ provider: "codex", run: Effect.void })
            .pipe(Effect.forkChild);
          yield* awaitBusyRejection(gate, "codex");

          expect(
            yield* gate.withOperation({
              provider: "claudeAgent",
              operation: "provider.health",
              run: Effect.succeed("claude-operation"),
            }),
          ).toBe("claude-operation");
          expect(
            yield* gate.withExclusiveMaintenance({
              provider: "claudeAgent",
              run: Effect.succeed("claude-maintenance"),
            }),
          ).toBe("claude-maintenance");

          yield* Deferred.succeed(releaseCodex, undefined);
          yield* Fiber.join(codexOperation);
          yield* Fiber.join(codexMaintenance);
        }),
      ),
    );
  });

  it("returns a typed error for concurrent maintenance on the same provider", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* makeProviderMaintenanceGate;
          const maintenanceStarted = yield* Deferred.make<void>();
          const releaseMaintenance = yield* Deferred.make<void>();
          const maintenance = yield* gate
            .withExclusiveMaintenance({
              provider: "droid",
              run: Deferred.succeed(maintenanceStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseMaintenance)),
              ),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(maintenanceStarted);

          const duplicate = yield* gate
            .withExclusiveMaintenance({ provider: "droid", run: Effect.void })
            .pipe(Effect.result);
          expect(Result.isFailure(duplicate)).toBe(true);
          if (Result.isFailure(duplicate)) {
            expect(duplicate.failure).toBeInstanceOf(ProviderMaintenanceAlreadyRunningError);
            expect(duplicate.failure).toMatchObject({ provider: "droid" });
          }

          yield* Deferred.succeed(releaseMaintenance, undefined);
          yield* Fiber.join(maintenance);
        }),
      ),
    );
  });

  it("releases maintenance admission after failure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* makeProviderMaintenanceGate;
        const failure = new Error("update failed");
        const result = yield* gate
          .withExclusiveMaintenance({ provider: "kilo", run: Effect.fail(failure) })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBe(failure);
        }
        expect(
          yield* gate.withOperation({
            provider: "kilo",
            operation: "session.start",
            run: Effect.succeed("available"),
          }),
        ).toBe("available");
        expect(
          yield* gate.withExclusiveMaintenance({
            provider: "kilo",
            run: Effect.succeed("retry"),
          }),
        ).toBe("retry");
      }),
    );
  });

  it("releases an operation admission after interruption", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* makeProviderMaintenanceGate;
          const operationStarted = yield* Deferred.make<void>();
          const operation = yield* gate
            .withOperation({
              provider: "cursor",
              operation: "provider.discovery",
              run: Deferred.succeed(operationStarted, undefined).pipe(Effect.andThen(Effect.never)),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(operationStarted);

          yield* Fiber.interrupt(operation);
          expect(
            yield* gate.withExclusiveMaintenance({
              provider: "cursor",
              run: Effect.succeed("drained"),
            }),
          ).toBe("drained");
        }),
      ),
    );
  });

  it("releases maintenance admission after interruption", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* makeProviderMaintenanceGate;
          const operationStarted = yield* Deferred.make<void>();
          const releaseOperation = yield* Deferred.make<void>();
          const operation = yield* gate
            .withOperation({
              provider: "opencode",
              operation: "provider.discovery",
              run: Deferred.succeed(operationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseOperation)),
              ),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(operationStarted);

          const maintenance = yield* gate
            .withExclusiveMaintenance({
              provider: "opencode",
              run: Effect.die("Interrupted maintenance must not enter its run effect."),
            })
            .pipe(Effect.forkChild);
          yield* awaitBusyRejection(gate, "opencode");

          yield* Fiber.interrupt(maintenance);
          expect(
            yield* gate.withOperation({
              provider: "opencode",
              operation: "provider.discovery",
              run: Effect.succeed("available"),
            }),
          ).toBe("available");
          yield* Deferred.succeed(releaseOperation, undefined);
          yield* Fiber.join(operation);
          expect(
            yield* gate.withExclusiveMaintenance({
              provider: "opencode",
              run: Effect.succeed("retry"),
            }),
          ).toBe("retry");
        }),
      ),
    );
  });

  it("fails closed after unproven process exit until a new gate is constructed", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* makeProviderMaintenanceGate;
        yield* gate.latchProvider({ provider: "codex", reason: "descendant 42 survived" });

        const operation = yield* gate
          .withOperation({ provider: "codex", operation: "session.start", run: Effect.void })
          .pipe(Effect.result);
        expect(Result.isFailure(operation)).toBe(true);
        if (Result.isFailure(operation)) {
          expect(operation.failure).toBeInstanceOf(ProviderMaintenanceBusyError);
          expect(operation.failure.message).toContain("Restart Synara");
          expect(operation.failure).toMatchObject({
            operation: "session.start",
            latchedReason: "descendant 42 survived",
          });
        }

        const maintenance = yield* gate
          .withExclusiveMaintenance({ provider: "codex", run: Effect.void })
          .pipe(Effect.result);
        expect(Result.isFailure(maintenance)).toBe(true);
        if (Result.isFailure(maintenance)) {
          expect(maintenance.failure).toBeInstanceOf(ProviderMaintenanceLatchedError);
          expect(maintenance.failure.message).toContain("descendant 42 survived");
        }
      }),
    );
  });

  it("latches a maintenance failure before concurrent operations can observe released admission", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* makeProviderMaintenanceGate;
          const failure = new Error("descendant 84 survived");
          let failureClassified = false;
          let maintenanceDone = false;
          let successfulAdmissions = 0;

          const waiter = yield* Effect.gen(function* () {
            while (!failureClassified) yield* Effect.yieldNow;
            while (!maintenanceDone) {
              const admission = yield* gate
                .withOperation({
                  provider: "codex",
                  operation: "concurrent.waiter",
                  run: Effect.void,
                })
                .pipe(Effect.result);
              if (Result.isSuccess(admission)) successfulAdmissions += 1;
              yield* Effect.yieldNow;
            }
          }).pipe(Effect.forkChild);

          const maintenance = yield* gate
            .withExclusiveMaintenance({
              provider: "codex",
              run: Effect.fail(failure),
              latchReasonOnFailure: () => {
                failureClassified = true;
                return failure.message;
              },
            })
            .pipe(Effect.result, Effect.forkChild);
          const result = yield* Fiber.join(maintenance);
          maintenanceDone = true;
          yield* Fiber.join(waiter);

          expect(Result.isFailure(result)).toBe(true);
          expect(successfulAdmissions).toBe(0);
          const blocked = yield* gate
            .withOperation({ provider: "codex", operation: "after.failure", run: Effect.void })
            .pipe(Effect.result);
          expect(Result.isFailure(blocked)).toBe(true);
          if (Result.isFailure(blocked)) {
            expect(blocked.failure.message).toContain("Restart Synara");
            expect(blocked.failure.message).toContain("descendant 84 survived");
          }
        }),
      ),
    );
  });
});
