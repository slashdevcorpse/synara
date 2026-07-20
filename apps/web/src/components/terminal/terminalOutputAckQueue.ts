export const TERMINAL_ACK_MAX_BYTES = 8_388_608;
export const TERMINAL_ACK_RETRY_INITIAL_MS = 100;
export const TERMINAL_ACK_RETRY_MAX_MS = 2_000;

/** Coalesces parsed-byte ACKs while keeping at most one RPC in flight. */
export class TerminalOutputAckQueue {
  private pendingBytes = 0;
  private inFlight = false;
  private disposed = false;
  private pausedForRebase = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private lifecycleEpoch = 0;
  private quiesceWaiters: Array<() => void> = [];

  constructor(private readonly send: (bytes: number) => Promise<void>) {}

  enqueue(bytes: number): void {
    if (this.disposed || this.pausedForRebase || !Number.isSafeInteger(bytes) || bytes <= 0) {
      return;
    }
    this.pendingBytes = Math.min(Number.MAX_SAFE_INTEGER, this.pendingBytes + bytes);
    this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleEpoch += 1;
    this.clearRetryTimer();
    this.pendingBytes = 0;
    if (!this.inFlight) this.resolveQuiesceWaiters();
  }

  quiesceForRebase(): Promise<void> {
    this.pausedForRebase = true;
    this.lifecycleEpoch += 1;
    this.retryAttempt = 0;
    this.clearRetryTimer();
    // The authoritative snapshot will forgive all pre-watermark bytes. Never
    // send credit that was queued before that reset, because it could arrive
    // afterward and incorrectly acknowledge newer output.
    this.pendingBytes = 0;
    if (!this.inFlight) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.quiesceWaiters.push(resolve);
    });
  }

  resumeAfterRebase(): void {
    if (this.disposed) return;
    this.pausedForRebase = false;
    this.retryAttempt = 0;
    this.drain();
  }

  private drain(): void {
    if (
      this.disposed ||
      this.pausedForRebase ||
      this.inFlight ||
      this.retryTimer !== null ||
      this.pendingBytes <= 0
    ) {
      return;
    }
    const bytes = Math.min(this.pendingBytes, TERMINAL_ACK_MAX_BYTES);
    this.pendingBytes -= bytes;
    this.inFlight = true;
    const lifecycleEpoch = this.lifecycleEpoch;
    let request: Promise<void>;
    try {
      request = this.send(bytes);
    } catch {
      this.restoreFailedBytes(bytes, lifecycleEpoch);
      this.inFlight = false;
      this.resolveQuiesceWaiters();
      this.drain();
      return;
    }
    void request
      .then(
        () => {
          this.retryAttempt = 0;
        },
        () => {
          this.restoreFailedBytes(bytes, lifecycleEpoch);
        },
      )
      .finally(() => {
        this.inFlight = false;
        this.resolveQuiesceWaiters();
        this.drain();
      });
  }

  private restoreFailedBytes(bytes: number, lifecycleEpoch: number): void {
    if (this.disposed || this.pausedForRebase || lifecycleEpoch !== this.lifecycleEpoch) {
      return;
    }
    this.pendingBytes = Math.min(Number.MAX_SAFE_INTEGER, this.pendingBytes + bytes);
    const delay = Math.min(
      TERMINAL_ACK_RETRY_INITIAL_MS * 2 ** this.retryAttempt,
      TERMINAL_ACK_RETRY_MAX_MS,
    );
    this.retryAttempt += 1;
    this.retryTimer = globalThis.setTimeout(() => {
      this.retryTimer = null;
      this.drain();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private resolveQuiesceWaiters(): void {
    const waiters = this.quiesceWaiters;
    this.quiesceWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
