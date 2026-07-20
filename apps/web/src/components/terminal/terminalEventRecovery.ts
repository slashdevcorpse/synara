import type { TerminalEvent } from "@synara/contracts";

export const TERMINAL_RECOVERY_EVENT_CAPACITY = 256;

export type TerminalEventDisposition =
  | "apply"
  | "buffer"
  | "discard"
  | "overflow"
  | "generation-change";

/**
 * Orders a terminal's live events around an authoritative snapshot watermark.
 * One tracker is owned by one terminal runtime, so equal sequence numbers from
 * other threads or terminal ids never interfere.
 */
export class TerminalEventRecovery {
  private appliedThrough = 0;
  private generation: string | null = null;
  private recoveryInProgress = false;
  private bufferedEvents: TerminalEvent[] = [];

  begin(): void {
    this.recoveryInProgress = true;
  }

  ingest(event: TerminalEvent): TerminalEventDisposition {
    if (this.generation === null) {
      this.generation = event.generation;
    } else if (event.generation !== this.generation) {
      this.generation = event.generation;
      this.appliedThrough = 0;
      this.recoveryInProgress = true;
      this.bufferedEvents = [event];
      return "generation-change";
    }
    if (event.sequence <= this.appliedThrough) {
      return "discard";
    }
    if (this.recoveryInProgress) {
      if (this.bufferedEvents.length >= TERMINAL_RECOVERY_EVENT_CAPACITY) {
        return "overflow";
      }
      this.bufferedEvents.push(event);
      return "buffer";
    }
    this.appliedThrough = event.sequence;
    return "apply";
  }

  prepareGeneration(generation: string): void {
    if (this.generation === generation) return;
    this.generation = generation;
    this.appliedThrough = 0;
    this.bufferedEvents = this.bufferedEvents.filter((event) => event.generation === generation);
  }

  commitSnapshot(generation: string, watermark: number): TerminalEvent[] | null {
    if (this.generation !== generation) return null;
    this.appliedThrough = Math.max(this.appliedThrough, watermark);
    const discarded: TerminalEvent[] = [];
    this.bufferedEvents = this.bufferedEvents.filter((event) => {
      if (event.generation === generation && event.sequence > this.appliedThrough) return true;
      discarded.push(event);
      return false;
    });
    return discarded;
  }

  finish(apply: (event: TerminalEvent) => void, discard: (event: TerminalEvent) => void): void {
    this.bufferedEvents.sort((left, right) => left.sequence - right.sequence);
    for (const event of this.bufferedEvents) {
      if (event.generation !== this.generation || event.sequence <= this.appliedThrough) {
        discard(event);
        continue;
      }
      this.appliedThrough = event.sequence;
      apply(event);
    }
    this.bufferedEvents = [];
    this.recoveryInProgress = false;
  }

  isRecovering(): boolean {
    return this.recoveryInProgress;
  }

  restart(): void {
    this.recoveryInProgress = true;
    this.bufferedEvents = [];
  }
}
