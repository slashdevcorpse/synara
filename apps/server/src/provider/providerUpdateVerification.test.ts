import type { ServerProviderStatus } from "@synara/contracts";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  PROVIDER_UPDATE_POST_PROBE_RETRY_DELAYS_MS,
  shouldRetryDelayedProviderUpdateVersion,
  verifyDelayedProviderUpdateVersion,
  type ProviderUpdateVerificationSnapshot,
} from "./providerUpdateVerification.ts";

function snapshot(
  version: string | null,
  options?: {
    readonly available?: boolean;
    readonly targetChanged?: boolean;
  },
): ProviderUpdateVerificationSnapshot {
  return {
    status: {
      provider: "droid",
      status: options?.available === false ? "error" : "ready",
      available: options?.available ?? true,
      authStatus: "unknown",
      checkedAt: "2026-07-23T20:00:00.000Z",
      ...(version === null ? {} : { version }),
    } satisfies ServerProviderStatus,
    targetChanged: options?.targetChanged ?? false,
  };
}

describe("verifyDelayedProviderUpdateVersion", () => {
  it("limits delayed replacement retries to Windows", () => {
    assert.strictEqual(shouldRetryDelayedProviderUpdateVersion("win32"), true);
    assert.strictEqual(shouldRetryDelayedProviderUpdateVersion("linux"), false);
    assert.strictEqual(shouldRetryDelayedProviderUpdateVersion("darwin"), false);
  });

  it.effect("observes a delayed self-replacement without waiting past the successful probe", () =>
    Effect.gen(function* () {
      let probeCount = 0;
      const verification = yield* verifyDelayedProviderUpdateVersion({
        beforeVersion: "0.174.0",
        initialSnapshot: { ...snapshot("0.174.0"), generation: 1 },
        probe: Effect.sync(() => {
          probeCount += 1;
          return {
            ...snapshot(probeCount === 1 ? "0.174.0" : "0.178.0"),
            generation: probeCount + 1,
          };
        }),
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.strictEqual(probeCount, 0);

      yield* TestClock.adjust(PROVIDER_UPDATE_POST_PROBE_RETRY_DELAYS_MS[0]);
      assert.strictEqual(probeCount, 1);

      yield* TestClock.adjust(PROVIDER_UPDATE_POST_PROBE_RETRY_DELAYS_MS[1]);
      const result = yield* Fiber.join(verification);

      assert.strictEqual(probeCount, 2);
      assert.strictEqual(result.status.version, "0.178.0");
      assert.strictEqual(result.targetChanged, false);
      assert.strictEqual(result.generation, 3);
    }),
  );

  it.effect("stops after the bounded retry budget when the version stays unchanged", () =>
    Effect.gen(function* () {
      let probeCount = 0;
      const verification = yield* verifyDelayedProviderUpdateVersion({
        beforeVersion: "0.174.0",
        initialSnapshot: snapshot("0.174.0"),
        probe: Effect.sync(() => {
          probeCount += 1;
          return snapshot("0.174.0");
        }),
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(
        PROVIDER_UPDATE_POST_PROBE_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0),
      );
      const result = yield* Fiber.join(verification);

      assert.strictEqual(probeCount, PROVIDER_UPDATE_POST_PROBE_RETRY_DELAYS_MS.length);
      assert.strictEqual(result.status.version, "0.174.0");
    }),
  );

  it.effect("does not delay conclusive success, failure, or target drift", () =>
    Effect.gen(function* () {
      const conclusiveCases = [
        { beforeVersion: "0.174.0", initialSnapshot: snapshot("0.178.0") },
        { beforeVersion: "0.174.0", initialSnapshot: snapshot("0.173.0") },
        {
          beforeVersion: "0.174.0",
          initialSnapshot: snapshot(null, { available: false }),
        },
        {
          beforeVersion: "0.174.0",
          initialSnapshot: snapshot("0.174.0", { targetChanged: true }),
        },
        { beforeVersion: null, initialSnapshot: snapshot("0.174.0") },
      ];

      for (const testCase of conclusiveCases) {
        let probeCount = 0;
        const result = yield* verifyDelayedProviderUpdateVersion({
          beforeVersion: testCase.beforeVersion,
          initialSnapshot: testCase.initialSnapshot,
          probe: Effect.sync(() => {
            probeCount += 1;
            return snapshot("0.178.0");
          }),
        });

        assert.strictEqual(probeCount, 0);
        assert.strictEqual(result, testCase.initialSnapshot);
      }
    }),
  );
});
