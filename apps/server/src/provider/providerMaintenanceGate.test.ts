import { Deferred, Effect, Fiber, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeProviderMaintenanceGate,
  type ProviderMaintenanceGate,
  ProviderMaintenanceAlreadyRunningError,
  ProviderMaintenanceBusyError,
  ProviderMaintenanceLatchedError,
} from "./providerMaintenanceGate.ts";
import { ProviderProcessExitUnprovenError } from "./supervisedProcessTeardown.ts";
import { ProviderMaintenanceOwnedResourceCloseError } from "./providerMaintenanceOwnedResources.ts";

function unprovenExit(rootPid: number): ProviderProcessExitUnprovenError {
  return new ProviderProcessExitUnprovenError({
    rootPid,
    rootExited: false,
    remainingDescendantPids: null,
    captureComplete: false,
  });
}

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

  it("releases an operation admission after an ordinary failure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* makeProviderMaintenanceGate;
        const failure = new Error("ordinary provider failure");
        const result = yield* gate
          .withOperation({
            provider: "cursor",
            operation: "provider.discovery",
            run: Effect.fail(failure),
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        expect(
          yield* gate.withExclusiveMaintenance({
            provider: "cursor",
            run: Effect.succeed("released"),
          }),
        ).toBe("released");
      }),
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

  it("refuses queued maintenance when the draining operation latches before release", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* makeProviderMaintenanceGate;
          const operationStarted = yield* Deferred.make<void>();
          const releaseOperation = yield* Deferred.make<void>();
          let maintenanceRuns = 0;

          const operation = yield* gate
            .withOperation({
              provider: "opencode",
              operation: "provider.health",
              run: Deferred.succeed(operationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseOperation)),
              ),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(operationStarted);

          const maintenance = yield* gate
            .withExclusiveMaintenance({
              provider: "opencode",
              run: Effect.sync(() => maintenanceRuns++),
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* awaitBusyRejection(gate, "opencode");

          yield* gate.latchProvider({
            provider: "opencode",
            reason: "Windows Job drain acknowledgement is unavailable",
          });
          yield* Deferred.succeed(releaseOperation, undefined);
          yield* Fiber.join(operation);
          const result = yield* Fiber.join(maintenance);

          expect(maintenanceRuns).toBe(0);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(ProviderMaintenanceLatchedError);
            expect(result.failure.message).toContain("drain acknowledgement is unavailable");
          }
        }),
      ),
    );
  });

  it("automatically latches a wrapped unproven operation failure before queued maintenance runs", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* makeProviderMaintenanceGate;
          const operationStarted = yield* Deferred.make<void>();
          const releaseOperation = yield* Deferred.make<void>();
          const processFailure = unprovenExit(4_201);
          const wrappedFailure = new Error("adapter discovery failed", {
            cause: new AggregateError(
              [
                new Error("inventory failed"),
                new Error("finalizer failed", { cause: processFailure }),
              ],
              "discovery aggregate",
            ),
          });
          let maintenanceRuns = 0;

          const operation = yield* gate
            .withOperation({
              provider: "opencode",
              operation: "provider.discovery",
              run: Deferred.succeed(operationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseOperation)),
                Effect.andThen(Effect.fail(wrappedFailure)),
              ),
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(operationStarted);

          const maintenance = yield* gate
            .withExclusiveMaintenance({
              provider: "opencode",
              run: Effect.sync(() => maintenanceRuns++),
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* awaitBusyRejection(gate, "opencode");
          yield* Deferred.succeed(releaseOperation, undefined);

          const operationResult = yield* Fiber.join(operation);
          const maintenanceResult = yield* Fiber.join(maintenance);
          expect(Result.isFailure(operationResult)).toBe(true);
          expect(maintenanceRuns).toBe(0);
          expect(Result.isFailure(maintenanceResult)).toBe(true);
          if (Result.isFailure(maintenanceResult)) {
            expect(maintenanceResult.failure).toBeInstanceOf(ProviderMaintenanceLatchedError);
            expect(maintenanceResult.failure.message).toContain(processFailure.message);
          }
        }),
      ),
    );
  });

  it("automatically latches an unproven defect and blocks future operations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* makeProviderMaintenanceGate;
        const processFailure = unprovenExit(4_202);

        yield* gate
          .withOperation({
            provider: "codex",
            operation: "provider.discovery",
            run: Effect.die(new AggregateError([new Error("ordinary"), processFailure])),
          })
          .pipe(Effect.exit);

        const blocked = yield* gate
          .withOperation({ provider: "codex", operation: "session.start", run: Effect.void })
          .pipe(Effect.result);
        expect(Result.isFailure(blocked)).toBe(true);
        if (Result.isFailure(blocked)) {
          expect(blocked.failure).toBeInstanceOf(ProviderMaintenanceBusyError);
          expect(blocked.failure.message).toContain(processFailure.message);
        }
      }),
    );
  });

  it("automatically latches an unproven exclusive-maintenance failure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* makeProviderMaintenanceGate;
        const processFailure = unprovenExit(4_203);
        yield* gate
          .withExclusiveMaintenance({
            provider: "codex",
            run: Effect.fail(new AggregateError([new Error("update failed"), processFailure])),
          })
          .pipe(Effect.result);

        const blocked = yield* gate
          .withOperation({ provider: "codex", operation: "session.start", run: Effect.void })
          .pipe(Effect.result);
        expect(Result.isFailure(blocked)).toBe(true);
        if (Result.isFailure(blocked)) {
          expect(blocked.failure.message).toContain(processFailure.message);
        }
      }),
    );
  });

  it("finds a later unproven owned-resource close failure before releasing maintenance", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* makeProviderMaintenanceGate;
        const ordinaryFailure = new Error("first close failed ordinarily");
        const processFailure = unprovenExit(4_204);
        const closeFailure = new ProviderMaintenanceOwnedResourceCloseError({
          provider: "codex",
          resourceId: "first-resource",
          cause: ordinaryFailure,
          failures: [
            { resourceId: "first-resource", cause: ordinaryFailure },
            { resourceId: "second-resource", cause: processFailure },
          ],
        });

        yield* gate
          .withExclusiveMaintenance({ provider: "codex", run: Effect.fail(closeFailure) })
          .pipe(Effect.result);

        const blocked = yield* gate
          .withOperation({ provider: "codex", operation: "session.start", run: Effect.void })
          .pipe(Effect.result);
        expect(Result.isFailure(blocked)).toBe(true);
        if (Result.isFailure(blocked)) {
          expect(blocked.failure.message).toContain(processFailure.message);
        }
      }),
    );
  });
});
