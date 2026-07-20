export const TERMINAL_ACK_MAX_BYTES = 8_388_608;

/** Coalesces parsed-byte ACKs while keeping at most one RPC in flight. */
export class TerminalOutputAckQueue {
  private pendingBytes = 0;
  private inFlight = false;
  private disposed = false;
  private pausedForRebase = false;
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
    this.pendingBytes = 0;
    if (!this.inFlight) this.resolveQuiesceWaiters();
  }

  quiesceForRebase(): Promise<void> {
    this.pausedForRebase = true;
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
    this.drain();
  }

  private drain(): void {
    if (this.disposed || this.pausedForRebase || this.inFlight || this.pendingBytes <= 0) return;
    const bytes = Math.min(this.pendingBytes, TERMINAL_ACK_MAX_BYTES);
    this.pendingBytes -= bytes;
    this.inFlight = true;
    void this.send(bytes)
      .catch(() => {
        // ACK flow control is best-effort. Server recovery rebases the window.
      })
      .finally(() => {
        this.inFlight = false;
        this.resolveQuiesceWaiters();
        this.drain();
      });
  }

  private resolveQuiesceWaiters(): void {
    const waiters = this.quiesceWaiters;
    this.quiesceWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
