import { WsRpcError } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ensureShellProjectionReady } from "./wsRpc";

describe("shell projection readiness", () => {
  it("accepts a projection fence that covers the coalesced event batch", async () => {
    await expect(
      Effect.runPromise(
        ensureShellProjectionReady(() => Effect.succeed({ snapshotSequence: 9 }), 9),
      ),
    ).resolves.toBeUndefined();
  });

  it("maps projection lag to a retryable stream restart error", async () => {
    const failure = await Effect.runPromise(
      ensureShellProjectionReady(() => Effect.succeed({ snapshotSequence: 8 }), 9).pipe(
        Effect.flip,
      ),
    );

    expect(failure).toMatchObject({
      _tag: "WsRpcError",
      code: "ORCHESTRATION_SHELL_PROJECTION_NOT_READY",
      retryable: true,
    });
    expect(failure).toBeInstanceOf(WsRpcError);
  });

  it("maps a projection fence read failure to a retryable typed error", async () => {
    const cause = new Error("projection state unavailable");
    const failure = await Effect.runPromise(
      ensureShellProjectionReady(() => Effect.fail(cause), 9).pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: "WsRpcError",
      code: "ORCHESTRATION_SHELL_PROJECTION_FENCE_READ_FAILED",
      retryable: true,
    });
    expect(failure).toBeInstanceOf(WsRpcError);
    expect(failure.cause).toBe(cause);
  });
});
