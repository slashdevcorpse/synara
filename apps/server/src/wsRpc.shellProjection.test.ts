import { EventId, ThreadId, TurnId, WsRpcError } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  awaitThreadDetailProjectionReady,
  ensureShellProjectionReady,
  shouldRefreshThreadDetailSnapshotAfterEvent,
} from "./wsRpc";

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

describe("thread detail projection refresh", () => {
  it("waits until the projection fence covers the terminal event", async () => {
    const observedSequences = [8, 9];

    await expect(
      Effect.runPromise(
        awaitThreadDetailProjectionReady(
          () => Effect.succeed({ snapshotSequence: observedSequences.shift() ?? 9 }),
          9,
          [0],
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("maps persistent projection lag to a retryable stream restart error", async () => {
    const failure = await Effect.runPromise(
      awaitThreadDetailProjectionReady(
        () => Effect.succeed({ snapshotSequence: 8 }),
        9,
        [],
      ).pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: "WsRpcError",
      code: "ORCHESTRATION_THREAD_PROJECTION_NOT_READY",
      retryable: true,
    });
  });

  it("refreshes durable turn summaries only after terminal turn activities", () => {
    const makeActivityEvent = (kind: string, turnId: TurnId | null) =>
      ({
        sequence: 9,
        eventId: EventId.makeUnsafe(`event-${kind}`),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: "2026-07-25T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          activity: {
            id: EventId.makeUnsafe(`activity-${kind}`),
            tone: "info",
            kind,
            summary: kind,
            payload: {},
            turnId,
            createdAt: "2026-07-25T00:00:00.000Z",
          },
        },
      }) as Parameters<typeof shouldRefreshThreadDetailSnapshotAfterEvent>[0];

    expect(
      shouldRefreshThreadDetailSnapshotAfterEvent(
        makeActivityEvent("turn.completed", TurnId.makeUnsafe("turn-1")),
      ),
    ).toBe(true);
    expect(
      shouldRefreshThreadDetailSnapshotAfterEvent(
        makeActivityEvent("turn.aborted", TurnId.makeUnsafe("turn-1")),
      ),
    ).toBe(true);
    expect(
      shouldRefreshThreadDetailSnapshotAfterEvent(
        makeActivityEvent("context-window.updated", TurnId.makeUnsafe("turn-1")),
      ),
    ).toBe(false);
    expect(shouldRefreshThreadDetailSnapshotAfterEvent(makeActivityEvent("turn.completed", null))).toBe(
      false,
    );
  });
});
