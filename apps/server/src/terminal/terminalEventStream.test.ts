import { TERMINAL_RESNAPSHOT_REQUIRED_CODE, type TerminalEvent } from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeTerminalEventStream } from "./terminalEventStream";

function outputEvent(index: number): TerminalEvent {
  return {
    type: "output",
    threadId: "thread-1",
    terminalId: "terminal-1",
    createdAt: "2026-07-20T00:00:00.000Z",
    generation: "generation-1",
    sequence: index,
    data: String(index),
    byteLength: 1,
  };
}

describe("makeTerminalEventStream", () => {
  it("delivers queued terminal bytes in order through one bounded queue", async () => {
    const unsubscribe = vi.fn();
    let publish!: (event: TerminalEvent) => void;
    const stream = makeTerminalEventStream(
      (listener) =>
        Effect.sync(() => {
          publish = listener;
          return unsubscribe;
        }),
      "generation-1",
      3,
    );
    const collection = Effect.runPromise(stream.pipe(Stream.take(4), Stream.runCollect));
    await vi.waitFor(() => expect(publish).toBeTypeOf("function"));
    publish(outputEvent(1));
    publish(outputEvent(2));
    publish(outputEvent(3));
    const values = await collection;

    expect(Array.from(values)).toEqual([
      { type: "ready", generation: "generation-1" },
      outputEvent(1),
      outputEvent(2),
      outputEvent(3),
    ]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("fails with typed resnapshot guidance instead of dropping a terminal chunk", async () => {
    const unsubscribe = vi.fn();
    const error = await Effect.runPromise(
      makeTerminalEventStream(
        (listener) =>
          Effect.sync(() => {
            listener(outputEvent(1));
            listener(outputEvent(2));
            listener(outputEvent(3));
            return unsubscribe;
          }),
        "generation-1",
        2,
      ).pipe(Stream.runCollect, Effect.flip),
    );

    expect(error).toMatchObject({
      _tag: "WsRpcError",
      code: TERMINAL_RESNAPSHOT_REQUIRED_CODE,
      retryable: true,
      retryAfterMs: 0,
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
