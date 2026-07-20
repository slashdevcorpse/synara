import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopPosixBackendAndWait, type PosixBackendShutdownProcess } from "./posixBackendShutdown";

type ShutdownSignal = "SIGTERM" | "SIGKILL";

class FakePosixBackendProcess implements PosixBackendShutdownProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: ShutdownSignal[] = [];
  onKill: ((signal: ShutdownSignal) => boolean) | null = null;

  readonly #exitListeners = new Set<() => void>();

  once(event: "exit", listener: () => void): this {
    expect(event).toBe("exit");
    this.#exitListeners.add(listener);
    return this;
  }

  off(event: "exit", listener: () => void): this {
    expect(event).toBe("exit");
    this.#exitListeners.delete(listener);
    return this;
  }

  kill(signal: ShutdownSignal): boolean {
    this.signals.push(signal);
    return this.onKill?.(signal) ?? true;
  }

  confirmExit(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    const listeners = [...this.#exitListeners];
    this.#exitListeners.clear();
    for (const listener of listeners) {
      listener();
    }
  }

  markExitedWithoutEvent(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    this.exitCode = exitCode;
    this.signalCode = signalCode;
  }

  get exitListenerCount(): number {
    return this.#exitListeners.size;
  }
}

function stopChild(
  child: FakePosixBackendProcess,
  input: { readonly forceKillDelayMs?: number; readonly timeoutMs?: number } = {},
) {
  return stopPosixBackendAndWait({
    child,
    forceKillDelayMs: input.forceKillDelayMs ?? 100,
    timeoutMs: input.timeoutMs ?? 250,
  });
}

describe("stopPosixBackendAndWait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("returns immediately for an already-exited child", async () => {
    const child = new FakePosixBackendProcess();
    child.markExitedWithoutEvent(0, null);

    await expect(stopChild(child)).resolves.toEqual({
      type: "already-exited",
      exitConfirmed: true,
      forced: false,
    });
    expect(child.signals).toEqual([]);
    expect(child.exitListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("confirms a SIGTERM exit and cancels both pending timers", async () => {
    const child = new FakePosixBackendProcess();
    child.onKill = (signal) => {
      if (signal === "SIGTERM") {
        child.confirmExit(null, "SIGTERM");
      }
      return true;
    };

    const shutdown = stopChild(child);

    await expect(shutdown).resolves.toEqual({
      type: "exited",
      exitConfirmed: true,
      forced: false,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.exitListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("does not send SIGKILL before the force delay or after an earlier exit", async () => {
    const child = new FakePosixBackendProcess();
    const shutdown = stopChild(child);

    await vi.advanceTimersByTimeAsync(99);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.exitListenerCount).toBe(1);
    expect(vi.getTimerCount()).toBe(2);

    child.confirmExit(0, null);
    await expect(shutdown).resolves.toEqual({
      type: "exited",
      exitConfirmed: true,
      forced: false,
    });
    expect(child.exitListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("falls back to one SIGKILL and confirms its exit", async () => {
    const child = new FakePosixBackendProcess();
    child.onKill = (signal) => {
      if (signal === "SIGKILL") {
        child.confirmExit(null, "SIGKILL");
      }
      return true;
    };
    const shutdown = stopChild(child);

    await vi.advanceTimersByTimeAsync(100);

    await expect(shutdown).resolves.toEqual({
      type: "exited",
      exitConfirmed: true,
      forced: true,
    });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("returns an unconfirmed disposition at the absolute timeout", async () => {
    const child = new FakePosixBackendProcess();
    const shutdown = stopChild(child);

    await vi.advanceTimersByTimeAsync(250);

    await expect(shutdown).resolves.toEqual({
      type: "timed-out",
      exitConfirmed: false,
      forced: true,
    });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    child.confirmExit(0, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails synchronously and cleans up when SIGTERM delivery throws", async () => {
    const child = new FakePosixBackendProcess();
    child.onKill = () => {
      throw new Error("SIGTERM unavailable");
    };

    await expect(stopChild(child)).resolves.toEqual({
      type: "failed",
      exitConfirmed: false,
      forced: false,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.exitListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a SIGKILL delivery failure to the absolute deadline", async () => {
    const child = new FakePosixBackendProcess();
    child.onKill = (signal) => {
      if (signal === "SIGKILL") {
        throw new Error("SIGKILL unavailable");
      }
      return true;
    };
    const shutdown = stopChild(child);

    await vi.advanceTimersByTimeAsync(100);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitListenerCount).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(150);
    await expect(shutdown).resolves.toEqual({
      type: "timed-out",
      exitConfirmed: false,
      forced: true,
    });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets observed child state win at the force boundary", async () => {
    const child = new FakePosixBackendProcess();
    const shutdown = stopChild(child);
    child.markExitedWithoutEvent(0, null);

    await vi.advanceTimersByTimeAsync(100);

    await expect(shutdown).resolves.toEqual({
      type: "exited",
      exitConfirmed: true,
      forced: false,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.exitListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets observed child state win at the deadline and prevents a late force", async () => {
    const child = new FakePosixBackendProcess();
    const shutdown = stopChild(child, { forceKillDelayMs: 500, timeoutMs: 100 });
    child.markExitedWithoutEvent(null, "SIGTERM");

    await vi.advanceTimersByTimeAsync(100);

    await expect(shutdown).resolves.toEqual({
      type: "exited",
      exitConfirmed: true,
      forced: false,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.exitListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(["SIGTERM"]);
  });
});
