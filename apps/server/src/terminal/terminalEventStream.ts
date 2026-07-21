import {
  TERMINAL_RESNAPSHOT_REQUIRED_CODE,
  type TerminalEvent,
  type TerminalEventStreamItem,
  WsRpcError,
} from "@synara/contracts";
import { Cause, Effect, Queue, Stream } from "effect";

export const TERMINAL_EVENT_STREAM_CAPACITY = 256;

type SubscribeTerminalEvents = (
  listener: (event: TerminalEvent) => void,
) => Effect.Effect<() => void>;

export function makeTerminalEventStream(
  subscribe: SubscribeTerminalEvents,
  generation: string,
  capacity = TERMINAL_EVENT_STREAM_CAPACITY,
): Stream.Stream<TerminalEventStreamItem, WsRpcError> {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError("Terminal event stream capacity must be a positive safe integer.");
  }

  return Stream.unwrap(
    Effect.gen(function* () {
      // The registration barrier has its own slot; event backlog remains capped
      // at `capacity` even before the client consumes the ready item.
      const queue = yield* Queue.bounded<TerminalEventStreamItem, WsRpcError>(capacity + 1);
      let overflowed = false;
      let registered = false;
      const registeredDuringSubscribe: TerminalEvent[] = [];
      const unsubscribe = yield* subscribe((event) => {
        if (overflowed) return;
        if (!registered) {
          if (registeredDuringSubscribe.length < capacity) {
            registeredDuringSubscribe.push(event);
            return;
          }
          overflowed = true;
        } else if (Queue.offerUnsafe(queue, event)) {
          return;
        } else {
          overflowed = true;
        }
        Queue.failCauseUnsafe(
          queue,
          Cause.fail(
            new WsRpcError({
              message:
                "Terminal event delivery fell behind. Reattach and replace the terminal from its authoritative history snapshot.",
              code: TERMINAL_RESNAPSHOT_REQUIRED_CODE,
              retryable: true,
              retryAfterMs: 0,
            }),
          ),
        );
      });
      if (!overflowed) {
        Queue.offerUnsafe(queue, { type: "ready", generation });
        registered = true;
        for (const event of registeredDuringSubscribe) Queue.offerUnsafe(queue, event);
      }
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      return Stream.fromQueue(queue);
    }),
  );
}
