import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopSmokeEnvironment,
  createDesktopSmokeSpawnSpec,
  DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS,
  DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS,
  resolveWindowsPowerShellPath,
  superviseDesktopSmokeProcess,
  WINDOWS_SMOKE_JOB_READY_PREFIX,
  WINDOWS_SMOKE_JOB_RUN_ID_ENV,
  WINDOWS_SMOKE_JOB_TERMINATE_PREFIX,
} from "./smoke-test-lifecycle.mjs";

const WINDOWS_JOB_RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

class FakeSmokeProcess extends EventEmitter {
  constructor(pid = 4312) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.write = vi.fn(() => true);
    this.stdin.end = vi.fn();
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

function emitWindowsJobReady(child, chunks = 1) {
  const marker = WINDOWS_SMOKE_JOB_READY_PREFIX + WINDOWS_JOB_RUN_ID + "\n";
  if (chunks === 1) {
    child.stdout.emit("data", marker);
    return;
  }
  const chunkSize = Math.ceil(marker.length / chunks);
  for (let index = 0; index < marker.length; index += chunkSize) {
    child.stdout.emit("data", marker.slice(index, index + chunkSize));
  }
}

function superviseWindowsSmoke(child, overrides = {}) {
  return superviseDesktopSmokeProcess({
    child,
    platform: "win32",
    windowsJobRunId: WINDOWS_JOB_RUN_ID,
    ...overrides,
  });
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

  it("selects the checked-in Windows wrapper with discrete path-safe arguments", () => {
    const environment = {
      SystemRoot: "D:\\Windows",
      Path: "C:\\Tools",
      ELECTRON_ENABLE_LOGGING: "1",
    };
    const spec = createDesktopSmokeSpawnSpec({
      platform: "win32",
      executable: "C:\\Program Files\\Electron\\electron.exe",
      args: ['C:\\repo with spaces\\dist-electron\\main "quoted".js'],
      environment,
      windowsHelperPath: "C:\\repo with spaces\\scripts\\smoke-test-windows-job.ps1",
      windowsJobRunId: WINDOWS_JOB_RUN_ID,
      workingDirectory: "C:\\repo with spaces\\apps\\desktop",
    });

    expect(resolveWindowsPowerShellPath({ sYsTeMrOoT: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(() => resolveWindowsPowerShellPath({ Path: "C:\\Tools" })).toThrow(
      "absolute, clean SystemRoot",
    );
    expect(() => resolveWindowsPowerShellPath({ SystemRoot: "\\Windows" })).toThrow(
      "absolute, clean SystemRoot",
    );
    expect(spec.command).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(spec.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\repo with spaces\\scripts\\smoke-test-windows-job.ps1",
      "--",
      "C:\\Program Files\\Electron\\electron.exe",
      'C:\\repo with spaces\\dist-electron\\main "quoted".js',
    ]);
    expect(spec.options.cwd).toBe("C:\\repo with spaces\\apps\\desktop");
    expect(spec.options.env[WINDOWS_SMOKE_JOB_RUN_ID_ENV]).toBe(WINDOWS_JOB_RUN_ID);
  });

  it("rejects drive-root-relative Windows launch paths while accepting UNC paths", () => {
    const launchInput = {
      platform: "win32",
      executable: "C:\\Tools\\electron.exe",
      args: [],
      environment: { SystemRoot: "C:\\Windows" },
      windowsHelperPath: "C:\\repo\\scripts\\smoke-test-windows-job.ps1",
      windowsJobRunId: WINDOWS_JOB_RUN_ID,
      workingDirectory: "C:\\repo\\apps\\desktop",
    };
    const rootRelativePaths = [
      ["executable", "\\tools\\electron.exe", "executable path"],
      ["windowsHelperPath", "\\repo\\smoke-test-windows-job.ps1", "helper path"],
      ["workingDirectory", "\\repo\\apps\\desktop", "working directory"],
    ];

    for (const [field, value, expectedMessage] of rootRelativePaths) {
      expect(() => createDesktopSmokeSpawnSpec({ ...launchInput, [field]: value })).toThrow(
        expectedMessage,
      );
    }

    const uncSpec = createDesktopSmokeSpawnSpec({
      ...launchInput,
      executable: "\\\\server\\share\\electron.exe",
      windowsHelperPath: "\\\\server\\share\\scripts\\smoke-test-windows-job.ps1",
      workingDirectory: "\\\\server\\share\\apps\\desktop",
    });
    expect(uncSpec.args).toContain("\\\\server\\share\\electron.exe");
    expect(uncSpec.options.cwd).toBe("\\\\server\\share\\apps\\desktop");
  });

  it("keeps the direct detached Electron launch on non-Windows platforms", () => {
    const spec = createDesktopSmokeSpawnSpec({
      platform: "linux",
      executable: "/opt/Electron/electron",
      args: ["/repo/apps/desktop/dist-electron/main.js"],
      environment: { PATH: "/usr/bin" },
    });

    expect(spec).toEqual({
      command: "/opt/Electron/electron",
      args: ["/repo/apps/desktop/dist-electron/main.js"],
      options: {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: { PATH: "/usr/bin" },
      },
    });
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
    const resultPromise = superviseDesktopSmokeProcess({ child, platform: "linux" });

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

  it("starts the full Windows observation only after a chunked Job Object ready marker", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn();
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(child.stdin.write).not.toHaveBeenCalled();
    emitWindowsJobReady(child, 4);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(child.stdin.write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(child.stdin.write).toHaveBeenCalledOnce();
    expect(child.stdin.write).toHaveBeenCalledWith(
      WINDOWS_SMOKE_JOB_TERMINATE_PREFIX + WINDOWS_JOB_RUN_ID + "\n",
    );
    expect(child.stdin.end).toHaveBeenCalledOnce();
    child.exitAndClose(137);
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS);

    await expectSettled(resultPromise, {
      ok: true,
      failures: [],
      teardownDiagnostics: [],
    });
    expect(killWindowsTree).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("keeps Windows output guarded until the post-close settlement interval completes", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn();
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree });
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });

    emitWindowsJobReady(child);
    await vi.advanceTimersByTimeAsync(8_000);
    child.exitAndClose(137);
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.stderr.emit("data", "late relay: Uncaught TypeError: teardown race\n");
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expectSettled(resultPromise, {
      ok: false,
      failures: ["Uncaught TypeError"],
      output: expect.stringContaining("teardown race"),
    });
    expect(killWindowsTree).not.toHaveBeenCalled();
  });

  it("allows a late in-budget wrapper close to finish settlement past the force boundary", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn();
    const resultPromise = superviseWindowsSmoke(child, {
      killWindowsTree,
      windowsFallbackDelayMs: 10_900,
    });
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });

    emitWindowsJobReady(child);
    await vi.advanceTimersByTimeAsync(18_500);
    child.exitAndClose(137);
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);

    await expectSettled(resultPromise, {
      ok: true,
      failures: [],
      teardownDiagnostics: [],
    });
    expect(killWindowsTree).not.toHaveBeenCalled();
  });

  it("never sends Windows Job Object shutdown control more than once", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(() => {
      child.exitAndClose(null, "SIGKILL");
      return { ok: true };
    });
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree });
    emitWindowsJobReady(child);
    await vi.advanceTimersByTimeAsync(8_000);
    child.stdin.emit("error", new Error("late pipe close"));
    child.stdin.emit("error", new Error("duplicate late pipe close"));
    child.exitAndClose(137);
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS);

    await expectSettled(resultPromise, { ok: false });
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an unexpected Windows Job Object ready marker", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(() => {
      child.exitAndClose(null, "SIGKILL");
      return { ok: true };
    });
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree });
    child.stdout.emit(
      "data",
      WINDOWS_SMOKE_JOB_READY_PREFIX + "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n",
    );
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS);

    await expectSettled(resultPromise, {
      ok: false,
      failures: expect.arrayContaining([
        "Windows Job Object helper emitted an unexpected ready marker.",
      ]),
    });
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(killWindowsTree).toHaveBeenCalledOnce();
  });

  it("fails closed on a duplicate Windows Job Object ready marker", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(() => {
      child.exitAndClose(null, "SIGKILL");
      return { ok: true };
    });
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree });
    emitWindowsJobReady(child);
    emitWindowsJobReady(child);
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS);

    await expectSettled(resultPromise, {
      ok: false,
      failures: expect.arrayContaining([
        "Windows Job Object helper emitted its ready marker more than once.",
      ]),
    });
    expect(child.stdin.write).toHaveBeenCalledOnce();
    expect(killWindowsTree).toHaveBeenCalledOnce();
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

  it("fails closed when the Windows Job Object helper exits before initialization", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn();
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree });
    child.stderr.emit("data", "SYNARA_SMOKE_JOB_ERROR Add-Type is blocked\n");
    child.exitAndClose(70);
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS);

    await expectSettled(resultPromise, {
      ok: false,
      failures: expect.arrayContaining([
        expect.stringContaining("exited before its ready marker"),
        expect.stringContaining("closed before its ready marker"),
        "SYNARA_SMOKE_JOB_ERROR",
      ]),
      output: expect.stringContaining("Add-Type is blocked"),
    });
    expect(killWindowsTree).not.toHaveBeenCalled();
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it("fails a missing Windows Job Object marker at the bounded startup deadline", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(() => {
      child.exitAndClose(null, "SIGKILL");
      return { ok: true };
    });
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree });

    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS);
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS);

    await expectSettled(resultPromise, {
      ok: false,
      failures: expect.arrayContaining([
        expect.stringContaining(DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS + "ms startup deadline"),
        expect.stringContaining("closed before its ready marker"),
      ]),
      teardownDiagnostics: [
        expect.stringContaining("startup was unconfirmed; taskkill cleanup was required"),
      ],
    });
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(killWindowsTree).toHaveBeenCalledOnce();
  });

  it("treats taskkill as failure-only cleanup even when fallback succeeds", async () => {
    const child = new FakeSmokeProcess();
    const windowsEnvironment = {
      SystemRoot: "Q:\\Sanitized Windows",
      Path: "Q:\\Tools",
    };
    const killWindowsTree = vi.fn(() => {
      child.exitAndClose(null, "SIGKILL");
      return { ok: true };
    });
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree, windowsEnvironment });
    emitWindowsJobReady(child);

    await vi.advanceTimersByTimeAsync(15_000);

    await expectSettled(resultPromise, {
      ok: false,
      teardownDiagnostics: [expect.stringContaining("did not close after the shutdown token")],
    });
    expect(killWindowsTree).toHaveBeenCalledOnce();
    expect(killWindowsTree).toHaveBeenCalledWith(child.pid, {
      timeoutMs: 5_900,
      environment: windowsEnvironment,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("preserves live fatal output relayed after the Job Object ready marker", async () => {
    const child = new FakeSmokeProcess();
    const resultPromise = superviseWindowsSmoke(child);
    emitWindowsJobReady(child);
    child.stderr.emit("data", "renderer: Uncaught TypeError: broken startup\n");
    await vi.advanceTimersByTimeAsync(8_000);
    child.exitAndClose(137);
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS);

    await expectSettled(resultPromise, {
      ok: false,
      failures: ["Uncaught TypeError"],
      output: expect.stringContaining("broken startup"),
    });
  });

  it("cannot pass a helper protocol error emitted after READY", async () => {
    const child = new FakeSmokeProcess();
    const resultPromise = superviseWindowsSmoke(child);
    emitWindowsJobReady(child);
    child.stderr.emit("data", "SYNARA_SMOKE_JOB_ERROR TerminateJobObject failed: 5\n");
    await vi.advanceTimersByTimeAsync(8_000);
    child.exitAndClose(5);
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS);

    await expectSettled(resultPromise, {
      ok: false,
      failures: ["SYNARA_SMOKE_JOB_ERROR"],
      output: expect.stringContaining("TerminateJobObject failed"),
    });
  });

  it("settles at the Windows teardown deadline when cleanup never returns", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(() => new Promise(() => {}));
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree });
    emitWindowsJobReady(child);

    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(resolved).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(2_000);

    await expectSettled(resultPromise, {
      ok: false,
      failures: [expect.stringContaining("13000ms teardown deadline")],
      teardownDiagnostics: expect.arrayContaining([
        expect.stringContaining("did not close after the shutdown token"),
        expect.stringContaining("did not settle before the final cleanup reserve"),
        expect.stringContaining("did not produce wrapper close proof"),
      ]),
    });
    expect(killWindowsTree).toHaveBeenCalledOnce();
    expect(child.stdin.write).toHaveBeenCalledOnce();
  });

  it("keeps the teardown deadline when the wrapper closes during pending cleanup", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(() => new Promise(() => {}));
    const resultPromise = superviseWindowsSmoke(child, { killWindowsTree });
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });

    emitWindowsJobReady(child);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(killWindowsTree).toHaveBeenCalledOnce();
    child.exitAndClose(137);
    await vi.advanceTimersByTimeAsync(DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expectSettled(resultPromise, {
      ok: false,
      failures: [expect.stringContaining("13000ms teardown deadline")],
      teardownDiagnostics: expect.arrayContaining([
        expect.stringContaining("did not close after the shutdown token"),
        expect.stringContaining("did not settle before the final cleanup reserve"),
      ]),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
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
