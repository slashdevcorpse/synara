import type { TerminalEvent } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { TERMINAL_RECOVERY_EVENT_CAPACITY, TerminalEventRecovery } from "./terminalEventRecovery";

function output(
  sequence: number,
  terminalId = "terminal-1",
  generation = "generation-1",
): TerminalEvent {
  return {
    type: "output",
    threadId: "thread-1",
    terminalId,
    createdAt: "2026-07-20T00:00:00.000Z",
    sequence,
    generation,
    data: String(sequence),
    byteLength: 1,
  };
}

describe("TerminalEventRecovery", () => {
  it("discards a pre-snapshot event delivered late", () => {
    const tracker = new TerminalEventRecovery();
    tracker.begin();
    tracker.prepareGeneration("generation-1");
    expect(tracker.commitSnapshot("generation-1", 4)).toEqual([]);
    tracker.finish(vi.fn(), vi.fn());

    expect(tracker.ingest(output(4))).toBe("discard");
  });

  it("retains a post-snapshot event delivered before the snapshot response", () => {
    const tracker = new TerminalEventRecovery();
    const apply = vi.fn();
    tracker.begin();
    expect(tracker.ingest(output(5))).toBe("buffer");
    expect(tracker.commitSnapshot("generation-1", 4)).toEqual([]);
    tracker.finish(apply, vi.fn());

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(output(5));
  });

  it("deduplicates replayed events across reconnect delivery", () => {
    const tracker = new TerminalEventRecovery();
    expect(tracker.ingest(output(1))).toBe("apply");
    expect(tracker.ingest(output(1))).toBe("discard");
    expect(tracker.ingest(output(2))).toBe("apply");
  });

  it("keeps sequence clocks isolated per terminal runtime", () => {
    const first = new TerminalEventRecovery();
    const second = new TerminalEventRecovery();
    expect(first.ingest(output(7, "terminal-1"))).toBe("apply");
    expect(second.ingest(output(1, "terminal-2"))).toBe("apply");
  });

  it("rebases sequence numbers when the server generation changes", () => {
    const tracker = new TerminalEventRecovery();
    const apply = vi.fn();
    expect(tracker.ingest(output(9))).toBe("apply");
    expect(tracker.ingest(output(1, "terminal-1", "generation-2"))).toBe("generation-change");
    expect(tracker.commitSnapshot("generation-2", 1)).toEqual([
      output(1, "terminal-1", "generation-2"),
    ]);
    tracker.finish(apply, vi.fn());
    expect(tracker.ingest(output(2, "terminal-1", "generation-2"))).toBe("apply");
  });

  it("bounds recovery buffering and can restart from a newer snapshot", () => {
    const tracker = new TerminalEventRecovery();
    tracker.begin();
    for (let sequence = 1; sequence <= TERMINAL_RECOVERY_EVENT_CAPACITY; sequence += 1) {
      expect(tracker.ingest(output(sequence))).toBe("buffer");
    }
    expect(tracker.ingest(output(TERMINAL_RECOVERY_EVENT_CAPACITY + 1))).toBe("overflow");
    tracker.restart();
    expect(tracker.ingest(output(TERMINAL_RECOVERY_EVENT_CAPACITY + 2))).toBe("buffer");
  });
});
