import { describe, expect, it, vi } from "vitest";

import { TERMINAL_ACK_MAX_BYTES, TerminalOutputAckQueue } from "./terminalOutputAckQueue";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = () => onReject(new Error("ack failed"));
  });
  return { promise, resolve, reject };
}

describe("TerminalOutputAckQueue", () => {
  it("coalesces while one ACK is in flight and splits the protocol maximum", async () => {
    const first = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const queue = new TerminalOutputAckQueue(send);

    queue.enqueue(1);
    queue.enqueue(TERMINAL_ACK_MAX_BYTES);
    queue.enqueue(7);
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve();
    await first.promise;
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls.map(([bytes]) => bytes)).toEqual([1, TERMINAL_ACK_MAX_BYTES, 7]);
  });

  it("contains rejection and continues draining without an unhandled promise", async () => {
    const first = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const queue = new TerminalOutputAckQueue(send);
    queue.enqueue(3);
    queue.enqueue(4);
    first.reject();
    await expect(first.promise).rejects.toThrow("ack failed");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });

  it("keeps terminals independent", () => {
    const firstSend = vi.fn(() => new Promise<void>(() => undefined));
    const secondSend = vi.fn(() => new Promise<void>(() => undefined));
    new TerminalOutputAckQueue(firstSend).enqueue(1);
    new TerminalOutputAckQueue(secondSend).enqueue(2);
    expect(firstSend).toHaveBeenCalledWith(1);
    expect(secondSend).toHaveBeenCalledWith(2);
  });

  it("lets only the in-flight ACK settle and drops queued work after disposal", async () => {
    const first = deferred();
    const send = vi.fn().mockReturnValue(first.promise);
    const queue = new TerminalOutputAckQueue(send);
    queue.enqueue(1);
    queue.enqueue(2);
    queue.dispose();
    first.resolve();
    await first.promise;
    await Promise.resolve();
    queue.enqueue(3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("waits for a stale in-flight ACK and sends no old credit across a rebase", async () => {
    const stale = deferred();
    const send = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(undefined);
    const queue = new TerminalOutputAckQueue(send);
    queue.enqueue(11);
    queue.enqueue(12);

    let quiesced = false;
    const barrier = queue.quiesceForRebase().then(() => {
      quiesced = true;
    });
    queue.enqueue(13);
    await Promise.resolve();
    expect(quiesced).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    stale.resolve();
    await barrier;
    expect(send).toHaveBeenCalledTimes(1);
    queue.resumeAfterRebase();
    queue.enqueue(14);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([bytes]) => bytes)).toEqual([11, 14]);
  });
});
