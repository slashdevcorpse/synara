import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { classifyWsRequest, makeWsRequestAdmission } from "./wsRequestAdmission";

describe("WsRequestAdmission", () => {
  it("keeps lightweight shell reads out of the expensive lane", () => {
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.getShellSnapshot)).toBe("standard");
    expect(classifyWsRequest(WS_METHODS.workspaceListArchivedProjects)).toBe("standard");
    expect(classifyWsRequest(WS_METHODS.workspaceListGitStates)).toBe("expensive-read");
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.getTurnDiff)).toBe("expensive-read");
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.repairState)).toBe("expensive-read");
    expect(classifyWsRequest(WS_METHODS.terminalAckOutput)).toBe("control");
  });

  it("reserves independent capacity for control traffic during an expensive-read flood", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        const first = yield* admission.acquire(1, ORCHESTRATION_WS_METHODS.getSnapshot);
        const second = yield* admission.acquire(1, WS_METHODS.statsGetProfileStats);
        const rejected = yield* admission
          .acquire(1, WS_METHODS.gitReadWorkingTreeDiff)
          .pipe(Effect.exit);

        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure") {
          expect(String(rejected.cause)).toContain("RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED");
        }

        const control = yield* admission.acquire(1, WS_METHODS.terminalAckOutput);
        expect(control.requestClass).toBe("control");
        yield* admission.release(first);
        yield* admission.release(first);
        yield* admission.release(second);
        yield* admission.release(control);
        expect(yield* admission.snapshot).toMatchObject({
          active: 0,
          admittedTotal: 3,
          releasedTotal: 3,
          rejectedTotal: 1,
        });
      }),
    );
  });

  it("charges concurrent workspace git-state reads to per-client expensive capacity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseGate = yield* Deferred.make<void>();
        const first = yield* admission
          .guard(
            1,
            WS_METHODS.workspaceListGitStates,
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseGate)),
            ),
          )
          .pipe(Effect.forkChild);
        const second = yield* admission
          .guard(
            1,
            WS_METHODS.workspaceListGitStates,
            Deferred.succeed(secondStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseGate)),
            ),
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(firstStarted);
        yield* Deferred.await(secondStarted);
        expect(yield* admission.snapshot).toMatchObject({
          clients: 1,
          active: 2,
          admittedTotal: 2,
          rejectedTotal: 0,
        });

        const rejected = yield* admission
          .guard(1, WS_METHODS.workspaceListGitStates, Effect.succeed("should-not-run"))
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({
          code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
          message: "WebSocket expensive-read request capacity exceeded.",
          retryable: true,
          retryAfterMs: 250,
        });

        const standard = yield* admission.acquire(1, WS_METHODS.workspaceListArchivedProjects);
        expect(standard.requestClass).toBe("standard");
        expect(yield* admission.snapshot).toMatchObject({
          active: 3,
          admittedTotal: 3,
          rejectedTotal: 1,
        });

        yield* Deferred.succeed(releaseGate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        yield* admission.release(standard);
        expect(yield* admission.snapshot).toMatchObject({
          clients: 0,
          active: 0,
          admittedTotal: 3,
          releasedTotal: 3,
          rejectedTotal: 1,
        });
      }),
    );
  });

  it("keeps client budgets independent and releases failed work exactly once", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        const clientOne = yield* admission.acquire(1, ORCHESTRATION_WS_METHODS.getSnapshot);
        const clientTwo = yield* admission.acquire(2, ORCHESTRATION_WS_METHODS.getSnapshot);

        const failed = yield* admission
          .guard(1, WS_METHODS.gitStatus, Effect.fail("expected"))
          .pipe(Effect.exit);
        expect(failed._tag).toBe("Failure");

        yield* admission.release(clientOne);
        yield* admission.release(clientTwo);
        expect(yield* admission.snapshot).toMatchObject({
          clients: 0,
          active: 0,
          admittedTotal: 3,
          releasedTotal: 3,
        });
      }),
    );
  });

  it("releases an interrupted request lease exactly once", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        const started = yield* Deferred.make<void>();
        const fiber = yield* admission
          .guard(
            1,
            ORCHESTRATION_WS_METHODS.getSnapshot,
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(started);
        expect(yield* admission.snapshot).toMatchObject({ active: 1, releasedTotal: 0 });
        yield* Fiber.interrupt(fiber);
        expect(yield* admission.snapshot).toMatchObject({
          active: 0,
          admittedTotal: 1,
          releasedTotal: 1,
        });
      }),
    );
  });
});
