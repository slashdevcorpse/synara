import { describe, expect, it, vi } from "vitest";

import {
  type PosixProcessGroupPresence,
  type PosixProcessGroupSignal,
  teardownPosixProcessGroup,
} from "./posixProcessGroup.ts";

describe("teardownPosixProcessGroup", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects invalid group id %s without signaling", async (id) => {
    const signalProcessGroup =
      vi.fn<
        (processGroupId: number, signal: PosixProcessGroupSignal) => PosixProcessGroupPresence
      >();

    await expect(
      teardownPosixProcessGroup(id, { displayName: "Test", signalProcessGroup }),
    ).rejects.toThrow(`Test POSIX process-group id must be a positive integer, got ${String(id)}.`);
    expect(signalProcessGroup).not.toHaveBeenCalled();
  });

  it("returns immediately when the group is already empty at TERM", async () => {
    const signalProcessGroup = vi.fn(() => "empty" as const);
    const sleep = vi.fn(async () => undefined);

    await teardownPosixProcessGroup(42, { displayName: "Test", signalProcessGroup, sleep });

    expect(signalProcessGroup).toHaveBeenCalledExactlyOnceWith(42, "SIGTERM");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("polls until TERM proves the group empty without escalating", async () => {
    const signals: PosixProcessGroupSignal[] = [];
    const results: PosixProcessGroupPresence[] = ["present", "present", "empty"];
    const signalProcessGroup = vi.fn((_processGroupId: number, signal: PosixProcessGroupSignal) => {
      signals.push(signal);
      return results.shift() ?? "empty";
    });
    let clock = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      clock += delayMs;
    });

    await teardownPosixProcessGroup(43, {
      displayName: "Test",
      signalProcessGroup,
      sleep,
      now: () => clock,
    });

    expect(signals).toEqual(["SIGTERM", 0, 0]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(25);
  });

  it("escalates after the TERM deadline and accepts empty proof after KILL", async () => {
    const signals: PosixProcessGroupSignal[] = [];
    const results: PosixProcessGroupPresence[] = [
      "present",
      "present",
      "present",
      "present",
      "present",
      "empty",
    ];
    const signalProcessGroup = vi.fn((_processGroupId: number, signal: PosixProcessGroupSignal) => {
      signals.push(signal);
      return results.shift() ?? "empty";
    });
    let clock = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      clock += delayMs;
    });

    await teardownPosixProcessGroup(44, {
      displayName: "Test",
      termGraceMs: 50,
      forceExitMs: 50,
      pollMs: 25,
      signalProcessGroup,
      sleep,
      now: () => clock,
    });

    expect(signals).toEqual(["SIGTERM", 0, 0, 0, "SIGKILL", 0]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the group remains present after KILL", async () => {
    const signalProcessGroup = vi.fn(() => "present" as const);

    await expect(
      teardownPosixProcessGroup(45, {
        displayName: "Test",
        termGraceMs: 0,
        forceExitMs: 0,
        signalProcessGroup,
      }),
    ).rejects.toThrow("Test POSIX process group 45 did not prove exit.");
    expect(signalProcessGroup.mock.calls).toEqual([
      [45, "SIGTERM"],
      [45, 0],
      [45, "SIGKILL"],
      [45, 0],
    ]);
  });

  it("maps ESRCH from the default signaler to already-empty proof", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ESRCH" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw missing;
    });

    try {
      await teardownPosixProcessGroup(46, { displayName: "Test" });
      expect(kill).toHaveBeenCalledExactlyOnceWith(-46, "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });
});
