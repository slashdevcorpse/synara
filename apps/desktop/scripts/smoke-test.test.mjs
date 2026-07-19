import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopSmokeEnvironment,
  superviseDesktopSmokeProcess,
} from "./smoke-test-lifecycle.mjs";

class FakeSmokeProcess extends EventEmitter {
  constructor(pid = 4312) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kill = vi.fn(() => true);
  }

  exit(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  close(code = this.exitCode, signal = this.signalCode) {
    this.emit("close", code, signal);
  }

  exitAndClose(code, signal = null) {
    this.exit(code, signal);
    this.close(code, signal);
  }
}

async function expectSettled(resultPromise, expected) {
  await expect(resultPromise).resolves.toMatchObject(expected);
  expect(vi.getTimerCount()).toBe(0);
}

describe("desktop smoke process lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes dev-server environment keys case-insensitively", () => {
    const smokeEnvironment = createDesktopSmokeEnvironment({
      Path: "C:\\tools",
      Vite_Dev_Server_Url: "http://localhost:5173",
      vite_dev_server_url: "http://localhost:5174",
      ELECTRON_ENABLE_LOGGING: "0",
    });

    expect(smokeEnvironment).toEqual({
      Path: "C:\\tools",
      ELECTRON_ENABLE_LOGGING: "1",
    });
    expect(
      Object.keys(smokeEnvironment).some((key) => key.toLowerCase() === "vite_dev_server_url"),
    ).toBe(false);
  });

  it("passes after the full observation window and a graceful POSIX tree close", async () => {
    const child = new FakeSmokeProcess();
    const signalProcess = vi.fn((_pid, signal) => {
      if (signal === "SIGTERM") child.exitAndClose(null, "SIGTERM");
      if (signal === "SIGKILL") {
        throw Object.assign(new Error("process group no longer exists"), { code: "ESRCH" });
      }
    });
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    await vi.advanceTimersByTimeAsync(13_000);

    await expectSettled(resultPromise, { ok: true, failures: [], teardownDiagnostics: [] });
    expect(signalProcess.mock.calls).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("keeps POSIX teardown active through the force stage after the root closes", async () => {
    const child = new FakeSmokeProcess();
    let helperAlive = true;
    const signalProcess = vi.fn((_pid, signal) => {
      if (signal === "SIGTERM") child.exitAndClose(null, "SIGTERM");
      if (signal === "SIGKILL") helperAlive = false;
    });
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(8_000);

    expect(resolved).toBe(false);
    expect(helperAlive).toBe(true);
    expect(signalProcess).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGTERM");

    await vi.advanceTimersByTimeAsync(5_000);

    await expectSettled(resultPromise, { ok: true, failures: [], teardownDiagnostics: [] });
    expect(helperAlive).toBe(false);
    expect(signalProcess.mock.calls).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
  });

  it("fails when the desktop exits before proving the observation window", async () => {
    const child = new FakeSmokeProcess();
    const signalProcess = vi.fn();
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    child.exitAndClose(0);
    await vi.advanceTimersByTimeAsync(5_000);

    await expectSettled(resultPromise, {
      ok: false,
      failures: [expect.stringContaining("exited before the 8000ms observation window")],
    });
    expect(signalProcess).toHaveBeenCalledWith(-child.pid, "SIGTERM");
  });

  it("captures fatal output that arrives after exit and before close", async () => {
    const child = new FakeSmokeProcess();
    const signalProcess = vi.fn(() => {
      child.exit(null, "SIGTERM");
      child.stderr.emit("data", Buffer.from("Uncaught TypeError: broken startup\n"));
      child.close(null, "SIGTERM");
    });
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    await vi.advanceTimersByTimeAsync(13_000);

    await expectSettled(resultPromise, {
      ok: false,
      failures: ["Uncaught TypeError"],
      output: expect.stringContaining("broken startup"),
    });
  });

  it("fails immediately when spawning fails without a process pid", async () => {
    const child = new FakeSmokeProcess(undefined);
    child.pid = undefined;
    const resultPromise = superviseDesktopSmokeProcess({ child });

    child.emit("error", new Error("spawn denied"));

    await expectSettled(resultPromise, {
      ok: false,
      failures: ["Desktop process error: spawn denied"],
    });
  });

  it("tears down a valid process tree after a child-process error", async () => {
    const child = new FakeSmokeProcess();
    const signalProcess = vi.fn(() => child.exitAndClose(null, "SIGTERM"));
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    child.emit("error", new Error("stream aborted"));
    await vi.advanceTimersByTimeAsync(5_000);

    await expectSettled(resultPromise, {
      ok: false,
      failures: ["Desktop process error: stream aborted"],
    });
    expect(signalProcess).toHaveBeenCalledWith(-child.pid, "SIGTERM");
  });

  it("force-kills the POSIX process group after graceful shutdown stalls", async () => {
    const child = new FakeSmokeProcess();
    const signalProcess = vi.fn((_pid, signal) => {
      if (signal === "SIGKILL") child.exitAndClose(null, "SIGKILL");
    });
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    await vi.advanceTimersByTimeAsync(13_000);

    await expectSettled(resultPromise, { ok: true });
    expect(signalProcess.mock.calls).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("requires confirmed taskkill tree teardown on Windows", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(() => {
      child.exitAndClose(null, "SIGTERM");
      return true;
    });
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "win32",
      killWindowsTree,
    });

    await vi.advanceTimersByTimeAsync(8_000);

    await expectSettled(resultPromise, { ok: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(killWindowsTree).toHaveBeenCalledOnce();
    expect(killWindowsTree).toHaveBeenCalledWith(child.pid, { timeoutMs: 1_900 });
  });

  it("waits for asynchronous Windows tree confirmation after the root closes", async () => {
    const child = new FakeSmokeProcess();
    let confirmTree;
    const killWindowsTree = vi.fn(
      () =>
        new Promise((resolve) => {
          confirmTree = resolve;
        }),
    );
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "win32",
      killWindowsTree,
    });
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(8_000);
    child.exitAndClose(null, "SIGKILL");
    await Promise.resolve();

    expect(resolved).toBe(false);

    confirmTree(true);
    await Promise.resolve();

    await expectSettled(resultPromise, { ok: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(killWindowsTree).toHaveBeenCalledWith(child.pid, { timeoutMs: 1_900 });
  });

  it("cannot pass when POSIX graceful group signaling throws", async () => {
    const child = new FakeSmokeProcess();
    child.kill.mockImplementation(() => {
      child.exitAndClose(null, "SIGTERM");
      return true;
    });
    const signalProcess = vi.fn((_pid, signal) => {
      if (signal === "SIGTERM") throw new Error("group missing");
      throw Object.assign(new Error("process group no longer exists"), { code: "ESRCH" });
    });
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    await vi.advanceTimersByTimeAsync(13_000);

    await expectSettled(resultPromise, {
      ok: false,
      teardownDiagnostics: ["Process-group SIGTERM failed: group missing"],
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cannot pass when POSIX forced group signaling throws", async () => {
    const child = new FakeSmokeProcess();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") child.exitAndClose(null, "SIGKILL");
      return true;
    });
    const signalProcess = vi.fn((_pid, signal) => {
      if (signal === "SIGKILL") throw new Error("kill denied");
    });
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    await vi.advanceTimersByTimeAsync(13_000);

    await expectSettled(resultPromise, {
      ok: false,
      teardownDiagnostics: ["Process-group SIGKILL failed: kill denied"],
    });
  });

  it("cannot pass process-group teardown without a valid pid", async () => {
    const child = new FakeSmokeProcess();
    child.pid = 0;
    child.kill.mockImplementation(() => {
      child.exitAndClose(null, "SIGTERM");
      return true;
    });
    const signalProcess = vi.fn();
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    await vi.advanceTimersByTimeAsync(13_000);

    await expectSettled(resultPromise, {
      ok: false,
      teardownDiagnostics: ["Cannot signal process group without a valid pid (0)."],
    });
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["returns false", () => false, "Windows taskkill did not confirm process-tree teardown."],
    [
      "throws",
      () => {
        throw new Error("access denied");
      },
      "Windows taskkill failed: access denied",
    ],
  ])("cannot pass when Windows taskkill %s", async (_label, taskkillBehavior, diagnostic) => {
    const child = new FakeSmokeProcess();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") child.exitAndClose(null, "SIGKILL");
      return true;
    });
    const killWindowsTree = vi.fn(taskkillBehavior);
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "win32",
      killWindowsTree,
    });

    await vi.advanceTimersByTimeAsync(8_000);

    await expectSettled(resultPromise, {
      ok: false,
      teardownDiagnostics: [diagnostic],
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not pass when the Windows root closes before tree teardown is confirmed", async () => {
    const child = new FakeSmokeProcess();
    let rejectTreeProof;
    const killWindowsTree = vi.fn(
      () =>
        new Promise((resolve) => {
          rejectTreeProof = () => resolve(false);
        }),
    );
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "win32",
      killWindowsTree,
    });
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(8_000);
    child.exitAndClose(null, "SIGTERM");
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();

    rejectTreeProof();
    await Promise.resolve();

    await expectSettled(resultPromise, {
      ok: false,
      teardownDiagnostics: ["Windows taskkill did not confirm process-tree teardown."],
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("settles at the hard deadline when asynchronous taskkill never returns", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(() => new Promise(() => {}));
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "win32",
      killWindowsTree,
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await expectSettled(resultPromise, {
      ok: false,
      failures: [expect.stringContaining("15000ms supervision deadline")],
    });
    expect(killWindowsTree).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("arms an independent hard deadline at supervision start", async () => {
    const child = new FakeSmokeProcess();
    const scheduled = [];
    const setTimer = vi.fn((callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    });
    const clearTimer = vi.fn();
    const signalProcess = vi.fn();
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
      setTimer,
      clearTimer,
    });

    expect(scheduled.map(({ delay }) => delay)).toEqual([15_000, 8_000]);
    scheduled[0].callback();

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      failures: [expect.stringContaining("15000ms supervision deadline")],
    });
    expect(signalProcess).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  });

  it("fails at the hard deadline when forced teardown produces no close proof", async () => {
    const child = new FakeSmokeProcess();
    const signalProcess = vi.fn();
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await expectSettled(resultPromise, {
      ok: false,
      failures: [expect.stringContaining("15000ms supervision deadline")],
    });
    expect(signalProcess.mock.calls).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
  });

  it("handles duplicate exit and close events without rearming timers", async () => {
    const child = new FakeSmokeProcess();
    const signalProcess = vi.fn(() => {
      child.exitAndClose(null, "SIGTERM");
      child.exit(null, "SIGTERM");
      child.close(null, "SIGTERM");
    });
    const resultPromise = superviseDesktopSmokeProcess({
      child,
      platform: "darwin",
      signalProcess,
    });

    await vi.advanceTimersByTimeAsync(13_000);

    await expectSettled(resultPromise, { ok: true });
    expect(signalProcess).toHaveBeenCalledTimes(2);
  });
});
