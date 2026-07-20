import { Cause, Effect, Queue, Stream } from "effect";

// FILE: wsStreamBackpressure.ts
// Purpose: Bound UI-facing websocket stream backlogs without weakening durable event processing.
// Layer: Server websocket transport
// Exports: bufferLiveUiStream, feedback helpers, lag helpers
// Depends on: Effect Cause Queue Stream

export const DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY = 1_024;
const DROP_REPORT_GROWTH_STEP = 500;
const DEFAULT_PRODUCER_FEEDBACK_ACTIVATION_RATIO = 0.75;
const DEFAULT_PRODUCER_FEEDBACK_DELAY_STEP_MS = 1;
const DEFAULT_PRODUCER_FEEDBACK_MAX_DELAY_MS = 8;
const DEFAULT_PRODUCER_FEEDBACK_RECOVERY_STEP_MS = 2;

export interface LiveUiStreamLagState {
  ingressCount: number;
  egressCount: number;
  reportedDroppedAtLeast: number;
}

export interface LiveUiStreamDropReport {
  readonly capacity: number;
  readonly droppedAtLeast: number;
  readonly label: string;
  readonly message: string;
}

export interface LiveUiProducerFeedbackState {
  currentDelayMs: number;
}

export interface LiveUiProducerFeedbackPolicy {
  /** Queue occupancy ratio that starts producer cooperation. */
  readonly activationRatio?: number;
  /** Delay added for each pressure sample. */
  readonly delayStepMs?: number;
  /** Hard upper bound for cooperative delay. */
  readonly maxDelayMs?: number;
  /** Delay removed for each healthy delivery sample. */
  readonly recoveryStepMs?: number;
}

export interface LiveUiProducerFeedbackReport {
  readonly backlog: number;
  readonly capacity: number;
  readonly delayMs: number;
  readonly label: string;
}

export function makeLiveUiStreamLagState(): LiveUiStreamLagState {
  return { ingressCount: 0, egressCount: 0, reportedDroppedAtLeast: 0 };
}

export function makeLiveUiProducerFeedbackState(): LiveUiProducerFeedbackState {
  return { currentDelayMs: 0 };
}

export function normalizeLiveUiStreamBufferCapacity(capacity: number): number {
  if (!Number.isFinite(capacity)) {
    return DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY;
  }
  return Math.max(1, Math.floor(capacity));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeActivationRatio(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PRODUCER_FEEDBACK_ACTIVATION_RATIO;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Advances one subscription's bounded producer-feedback state. Pressure raises
 * the delay by a fixed step up to a hard cap; healthy samples decay it back to
 * zero. The state is intentionally tiny and owned by one stream run.
 */
export function recordLiveUiProducerPressure(
  state: LiveUiProducerFeedbackState,
  backlog: number,
  capacity: number,
  policy?: LiveUiProducerFeedbackPolicy,
): number {
  const normalizedCapacity = normalizeLiveUiStreamBufferCapacity(capacity);
  const activationLag = Math.max(
    1,
    Math.ceil(normalizedCapacity * normalizeActivationRatio(policy?.activationRatio)),
  );
  const delayStepMs = normalizePositiveInteger(
    policy?.delayStepMs,
    DEFAULT_PRODUCER_FEEDBACK_DELAY_STEP_MS,
  );
  const maxDelayMs = normalizePositiveInteger(
    policy?.maxDelayMs,
    DEFAULT_PRODUCER_FEEDBACK_MAX_DELAY_MS,
  );
  const recoveryStepMs = normalizePositiveInteger(
    policy?.recoveryStepMs,
    DEFAULT_PRODUCER_FEEDBACK_RECOVERY_STEP_MS,
  );

  if (backlog >= activationLag) {
    state.currentDelayMs = Math.min(maxDelayMs, state.currentDelayMs + delayStepMs);
  } else {
    state.currentDelayMs = Math.max(0, state.currentDelayMs - recoveryStepMs);
  }
  return state.currentDelayMs;
}

/**
 * Records one buffered-stream ingress and returns the minimum number of dropped
 * events when that figure should be reported, or null when no report is due.
 * The figure is a lower bound: the sliding buffer may still deliver up to
 * `capacity` of the lagging events. Reports are gated so a stalled subscriber
 * logs once up front and then only as the loss keeps growing.
 */
export function recordLiveUiStreamIngress(
  state: LiveUiStreamLagState,
  capacity: number,
  reportGrowthStep = DROP_REPORT_GROWTH_STEP,
): number | null {
  state.ingressCount += 1;
  const droppedAtLeast = state.ingressCount - state.egressCount - capacity;
  if (droppedAtLeast <= 0) {
    return null;
  }
  if (
    state.reportedDroppedAtLeast > 0 &&
    droppedAtLeast - state.reportedDroppedAtLeast < reportGrowthStep
  ) {
    return null;
  }
  state.reportedDroppedAtLeast = droppedAtLeast;
  return droppedAtLeast;
}

export interface BufferLiveUiStreamOptions<E2 = never, R2 = never> {
  readonly capacity?: number;
  /** Identifies the stream in dropped-event warnings. */
  readonly label?: string;
  /** Optional recovery hook. Snapshot-backed streams use this to restart/resubscribe. */
  readonly onDroppedEvents?: (report: LiveUiStreamDropReport) => Effect.Effect<void, E2, R2>;
  /** Adaptive policy for the isolated outbound producer. */
  readonly producerFeedbackPolicy?: LiveUiProducerFeedbackPolicy;
  /**
   * Test/telemetry seam for producer cooperation. Production defaults to an
   * interruptible sleep for the requested bounded delay.
   */
  readonly cooperateProducer?: (
    report: LiveUiProducerFeedbackReport,
  ) => Effect.Effect<void, never, never>;
}

export function bufferLiveUiStream<A, E, R, E2 = never, R2 = never>(
  stream: Stream.Stream<A, E, R>,
  options?: BufferLiveUiStreamOptions<E2, R2>,
): Stream.Stream<A, E | E2, R | R2> {
  const capacity = normalizeLiveUiStreamBufferCapacity(
    options?.capacity ?? DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY,
  );
  const label = options?.label ?? "live-ui-stream";
  const cooperateProducer =
    options?.cooperateProducer ??
    ((report: LiveUiProducerFeedbackReport) => Effect.sleep(`${report.delayMs} millis`));

  return Stream.callback<A, E | E2, R | R2>(
    (outbound) =>
      Effect.gen(function* () {
        // These queues and counters belong to this subscription only. The
        // source pump keeps shared publishers draining into a bounded sliding
        // queue; it never waits for the browser or the adaptive delay.
        const ingress = yield* Queue.sliding<A, E | E2 | Cause.Done<void>>(capacity);
        const lagState = makeLiveUiStreamLagState();
        const feedbackState = makeLiveUiProducerFeedbackState();

        const pumpSource = stream.pipe(
          Stream.runForEach((value) => {
            const offered = Queue.offerUnsafe(ingress, value);
            if (!offered) return Effect.interrupt;

            const droppedAtLeast = recordLiveUiStreamIngress(lagState, capacity);
            if (droppedAtLeast === null) return Effect.void;

            const report: LiveUiStreamDropReport = {
              capacity,
              droppedAtLeast,
              label,
              message: `[ws-stream] slow "${label}" subscriber: dropped at least ${droppedAtLeast} oldest events (capacity=${capacity})`,
            };
            const recover = options?.onDroppedEvents ?? (() => Effect.void);
            return Effect.logWarning(report.message).pipe(Effect.andThen(recover(report)));
          }),
          Effect.matchCauseEffect({
            onFailure: (cause) => Queue.failCause(ingress, cause).pipe(Effect.asVoid),
            onSuccess: () => Queue.end(ingress).pipe(Effect.asVoid),
          }),
        );
        yield* Effect.forkScoped(pumpSource);

        const producerExit = yield* Stream.fromQueue(ingress).pipe(
          Stream.runForEach((value) =>
            Effect.gen(function* () {
              lagState.egressCount += 1;
              const backlog = Math.min(capacity, Queue.sizeUnsafe(ingress) + 1);
              const delayMs = recordLiveUiProducerPressure(
                feedbackState,
                backlog,
                capacity,
                options?.producerFeedbackPolicy,
              );
              if (delayMs > 0) {
                yield* cooperateProducer({ backlog, capacity, delayMs, label });
              }

              // Effect RPC pulls the next element only after its previous
              // stream chunk is acknowledged. With a one-item suspended
              // outbound queue, consumer lag therefore blocks this producer
              // fiber while the independent source pump keeps ingress bounded.
              yield* Queue.offer(outbound, value).pipe(Effect.asVoid);
            }),
          ),
          Effect.exit,
        );
        if (producerExit._tag === "Failure") {
          yield* Queue.failCause(outbound, producerExit.cause);
          return;
        }
        yield* Queue.end(outbound);
      }),
    { bufferSize: 1, strategy: "suspend" },
  );
}
