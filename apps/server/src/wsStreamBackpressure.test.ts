import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";

import {
  bufferLiveUiStream,
  makeLiveUiProducerFeedbackState,
  makeLiveUiStreamLagState,
  normalizeLiveUiStreamBufferCapacity,
  recordLiveUiProducerPressure,
  recordLiveUiStreamIngress,
} from "./wsStreamBackpressure";

describe("wsStreamBackpressure", () => {
  it("normalizes invalid buffer capacities to safe positive values", () => {
    expect(normalizeLiveUiStreamBufferCapacity(2.9)).toBe(2);
    expect(normalizeLiveUiStreamBufferCapacity(0)).toBe(1);
    expect(normalizeLiveUiStreamBufferCapacity(Number.NaN)).toBeGreaterThan(1);
  });

  it("keeps the newest live UI events when the buffer overflows", async () => {
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const releaseProducer = yield* Deferred.make<void>();
          const upstreamComplete = yield* Deferred.make<void>();
          const collector = yield* Stream.fromIterable([1, 2, 3, 4, 5]).pipe(
            Stream.ensuring(Deferred.succeed(upstreamComplete, undefined).pipe(Effect.asVoid)),
            (stream) =>
              bufferLiveUiStream(stream, {
                capacity: 2,
                producerFeedbackPolicy: { activationRatio: 0, maxDelayMs: 1 },
                cooperateProducer: () => Deferred.await(releaseProducer),
              }),
            Stream.runCollect,
            Effect.forkScoped,
          );

          yield* Deferred.await(upstreamComplete);
          yield* Deferred.succeed(releaseProducer, undefined);
          return yield* Fiber.join(collector);
        }),
      ),
    );

    const delivered = Array.from(values);
    // One item may already be owned by the outbound producer when ingress
    // slides, but the retained ingress window must always be the newest pair.
    expect(delivered.slice(-2)).toEqual([4, 5]);
    expect(delivered).not.toContain(2);
    expect(delivered).not.toContain(3);
  });

  it("can fail on overflow so snapshot-backed streams restart", async () => {
    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const releaseProducer = yield* Deferred.make<void>();
            const overflowObserved = yield* Deferred.make<void>();
            const collector = yield* Stream.fromIterable([1, 2, 3]).pipe(
              (stream) =>
                bufferLiveUiStream(stream, {
                  capacity: 1,
                  producerFeedbackPolicy: { activationRatio: 0, maxDelayMs: 1 },
                  cooperateProducer: () => Deferred.await(releaseProducer),
                  onDroppedEvents: () =>
                    Deferred.succeed(overflowObserved, undefined).pipe(
                      Effect.andThen(Effect.fail(new Error("resync"))),
                    ),
                }),
              Stream.runCollect,
              Effect.forkScoped,
            );

            yield* Deferred.await(overflowObserved);
            yield* Deferred.succeed(releaseProducer, undefined);
            return yield* Fiber.join(collector);
          }),
        ),
      ),
    ).rejects.toThrow("resync");
  });

  it("reports nothing while the subscriber keeps up", () => {
    const state = makeLiveUiStreamLagState();
    expect(recordLiveUiStreamIngress(state, 2)).toBeNull();
    state.egressCount += 1;
    expect(recordLiveUiStreamIngress(state, 2)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 2)).toBeNull();
  });

  it("reports the first overflow and then only growth past the step", () => {
    const state = makeLiveUiStreamLagState();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBe(1);
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBe(4);
  });

  it("stops reporting once egress catches the lag back up", () => {
    const state = makeLiveUiStreamLagState();
    expect(recordLiveUiStreamIngress(state, 1, 1)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 1)).toBe(1);
    state.egressCount += 2;
    expect(recordLiveUiStreamIngress(state, 1, 1)).toBeNull();
  });

  it("activates producer cooperation at the threshold and caps its delay", () => {
    const state = makeLiveUiProducerFeedbackState();
    const policy = {
      activationRatio: 0.5,
      delayStepMs: 2,
      maxDelayMs: 5,
      recoveryStepMs: 1,
    };

    expect(recordLiveUiProducerPressure(state, 1, 4, policy)).toBe(0);
    expect(recordLiveUiProducerPressure(state, 2, 4, policy)).toBe(2);
    expect(recordLiveUiProducerPressure(state, 3, 4, policy)).toBe(4);
    expect(recordLiveUiProducerPressure(state, 4, 4, policy)).toBe(5);
    expect(recordLiveUiProducerPressure(state, 4, 4, policy)).toBe(5);
  });

  it("decays producer delay after recovery and can activate again", () => {
    const state = makeLiveUiProducerFeedbackState();
    const policy = {
      activationRatio: 0.5,
      delayStepMs: 2,
      maxDelayMs: 6,
      recoveryStepMs: 2,
    };

    expect(recordLiveUiProducerPressure(state, 2, 4, policy)).toBe(2);
    expect(recordLiveUiProducerPressure(state, 3, 4, policy)).toBe(4);
    expect(recordLiveUiProducerPressure(state, 0, 4, policy)).toBe(2);
    expect(recordLiveUiProducerPressure(state, 0, 4, policy)).toBe(0);
    expect(recordLiveUiProducerPressure(state, 2, 4, policy)).toBe(2);
  });

  it("keeps feedback state isolated between subscriptions", () => {
    const lagging = makeLiveUiProducerFeedbackState();
    const healthy = makeLiveUiProducerFeedbackState();
    const policy = { activationRatio: 0.5, delayStepMs: 3, maxDelayMs: 6 };

    expect(recordLiveUiProducerPressure(lagging, 2, 4, policy)).toBe(3);
    expect(recordLiveUiProducerPressure(lagging, 4, 4, policy)).toBe(6);
    expect(recordLiveUiProducerPressure(healthy, 0, 4, policy)).toBe(0);
    expect(healthy.currentDelayMs).toBe(0);
  });

  it("drains upstream while ACK-gated outbound producer cooperation is blocked", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const releaseProducer = yield* Deferred.make<void>();
          const upstreamComplete = yield* Deferred.make<void>();
          const delivered: number[] = [];
          const delays: number[] = [];
          const source = Stream.fromIterable([1, 2, 3, 4, 5]).pipe(
            Stream.ensuring(Deferred.succeed(upstreamComplete, undefined).pipe(Effect.asVoid)),
          );
          const collector = yield* bufferLiveUiStream(source, {
            capacity: 4,
            producerFeedbackPolicy: {
              activationRatio: 0.25,
              delayStepMs: 1,
              maxDelayMs: 1,
            },
            cooperateProducer: (feedback) =>
              Effect.sync(() => delays.push(feedback.delayMs)).pipe(
                Effect.andThen(Deferred.await(releaseProducer)),
              ),
          }).pipe(
            Stream.runForEach((value) =>
              Effect.sync(() => {
                delivered.push(value);
              }),
            ),
            Effect.forkScoped,
          );

          yield* Deferred.await(upstreamComplete);
          const collectorBeforeRelease = collector.pollUnsafe();
          const deliveredBeforeRelease = [...delivered];
          yield* Deferred.succeed(releaseProducer, undefined);
          yield* Fiber.join(collector);

          return {
            collectorWasBlocked: collectorBeforeRelease === undefined,
            deliveredBeforeRelease,
            deliveredAfterRelease: delivered,
            delays,
          };
        }),
      ),
    );

    expect(result.collectorWasBlocked).toBe(true);
    expect(result.deliveredBeforeRelease).toEqual([]);
    expect(result.deliveredAfterRelease.length).toBeGreaterThan(0);
    expect(result.delays).toContain(1);
  });

  it("does not let one stalled subscription delay another", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const releaseLagging = yield* Deferred.make<void>();
          const laggingUpstreamComplete = yield* Deferred.make<void>();
          const lagging = yield* bufferLiveUiStream(
            Stream.fromIterable([1, 2, 3]).pipe(
              Stream.ensuring(
                Deferred.succeed(laggingUpstreamComplete, undefined).pipe(Effect.asVoid),
              ),
            ),
            {
              capacity: 3,
              producerFeedbackPolicy: { activationRatio: 0.25, maxDelayMs: 1 },
              cooperateProducer: () => Deferred.await(releaseLagging),
            },
          ).pipe(Stream.runCollect, Effect.forkScoped);

          yield* Deferred.await(laggingUpstreamComplete);
          const healthy = yield* bufferLiveUiStream(Stream.fromIterable([10, 11]), {
            capacity: 3,
            cooperateProducer: () => Effect.void,
          }).pipe(Stream.runCollect);
          const laggingBeforeRelease = lagging.pollUnsafe();
          yield* Deferred.succeed(releaseLagging, undefined);
          yield* Fiber.join(lagging);

          return {
            healthy: Array.from(healthy),
            laggingWasBlocked: laggingBeforeRelease === undefined,
          };
        }),
      ),
    );

    expect(result.healthy).toEqual([10, 11]);
    expect(result.laggingWasBlocked).toBe(true);
  });

  it("keeps bounded upstream publication prompt while UI delivery is stalled", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const upstream = yield* PubSub.bounded<number>(1);
          const subscription = yield* PubSub.subscribe(upstream);
          const releaseProducer = yield* Deferred.make<void>();
          const publicationComplete = yield* Deferred.make<ReadonlyArray<boolean>>();
          const collector = yield* bufferLiveUiStream(Stream.fromSubscription(subscription), {
            capacity: 2,
            producerFeedbackPolicy: { activationRatio: 0.25, maxDelayMs: 1 },
            cooperateProducer: () => Deferred.await(releaseProducer),
          }).pipe(Stream.runDrain, Effect.forkScoped);

          yield* Effect.forEach([1, 2, 3, 4, 5], (value) => PubSub.publish(upstream, value), {
            concurrency: 1,
          }).pipe(
            Effect.flatMap((published) => Deferred.succeed(publicationComplete, published)),
            Effect.forkScoped,
          );

          const published = yield* Deferred.await(publicationComplete);
          const collectorBeforeRelease = collector.pollUnsafe();
          yield* Deferred.succeed(releaseProducer, undefined);

          return {
            collectorWasBlocked: collectorBeforeRelease === undefined,
            published,
          };
        }),
      ),
    );

    expect(result.published).toEqual([true, true, true, true, true]);
    expect(result.collectorWasBlocked).toBe(true);
  });

  it("interrupts the subscription-owned source pump when delivery ends", async () => {
    let finalized = false;
    const values = await Effect.runPromise(
      Stream.concat(Stream.succeed(1), Stream.never).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
        (stream) =>
          bufferLiveUiStream(stream, {
            capacity: 4,
            cooperateProducer: () => Effect.void,
          }),
        Stream.take(1),
        Stream.runCollect,
      ),
    );

    expect(Array.from(values)).toEqual([1]);
    expect(finalized).toBe(true);
  });
});
