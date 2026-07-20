import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV,
  DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS,
  DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS,
  WINDOWS_SMOKE_JOB_READY_PREFIX,
  WINDOWS_SMOKE_JOB_RUN_ID_ENV,
  WINDOWS_SMOKE_JOB_TERMINATE_PREFIX,
  classifyWindowsTaskkillClose,
  createDesktopPersistenceSmokeEnvironment,
  createDesktopSmokeEnvironment,
  createDesktopSmokeSpawnSpec,
  ensureDesktopPersistenceSmokeHome,
  forceStopDesktopSmokeProcessTree,
  resolveWindowsPowerShellPath,
  runDesktopPersistenceSmokeSequence,
  superviseDesktopSmokeProcess,
  validateDesktopPersistenceSmokeEnvironment,
  validateDesktopPersistenceSmokeProfileIsolation,
  waitForDesktopProcessTreeGone,
  waitForDesktopSmokeReadiness,
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

  it("requires the Super flavor for the persistence smoke", () => {
    expect(() =>
      validateDesktopPersistenceSmokeEnvironment({
        environment: {
          SYNARA_DESKTOP_FLAVOR: "production",
          SYNARA_HOME: resolve(homedir(), "desktop-persistence-smoke-test"),
        },
      }),
    ).toThrow("requires SYNARA_DESKTOP_FLAVOR=super");
  });

  it("rejects a missing persistence-smoke home", () => {
    expect(() =>
      validateDesktopPersistenceSmokeEnvironment({
        environment: { SYNARA_DESKTOP_FLAVOR: "super" },
      }),
    ).toThrow("requires an explicit absolute SYNARA_HOME");
  });

  it("rejects a relative persistence-smoke home", () => {
    expect(() =>
      validateDesktopPersistenceSmokeEnvironment({
        environment: {
          SYNARA_DESKTOP_FLAVOR: "super",
          SYNARA_HOME: "relative-persistence-smoke-home",
        },
      }),
    ).toThrow("requires an absolute SYNARA_HOME");
  });

  it.each([".synara", ".synara-canary", ".super-synara"])(
    "rejects the canonical live %s home",
    (liveHomeName) => {
      const homeDirectory = homedir();
      expect(() =>
        validateDesktopPersistenceSmokeEnvironment({
          environment: {
            SYNARA_DESKTOP_FLAVOR: " SUPER ",
            SYNARA_HOME: join(homeDirectory, liveHomeName),
          },
          homeDirectory,
        }),
      ).toThrow("refuses to use live desktop state");
    },
  );

  it("preserves a caller-provided isolated absolute persistence-smoke home", () => {
    const isolatedHome = resolve(homedir(), "desktop-persistence-smoke-test");
    expect(
      validateDesktopPersistenceSmokeEnvironment({
        environment: {
          SYNARA_DESKTOP_FLAVOR: "super",
          SYNARA_DESKTOP_DISABLE_UPDATES: "1",
          SYNARA_HOME: isolatedHome,
        },
      }),
    ).toBe(isolatedHome);
  });

  it("derives an isolated Electron profile inside the validated persistence home", () => {
    const synaraHome = resolve(homedir(), "desktop-persistence-smoke-test");
    const inheritedEnvironment = {
      APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
      Synara_Desktop_Persistence_Smoke_User_Data: resolve(homedir(), "unsafe-profile"),
      VITE_DEV_SERVER_URL: "http://localhost:5173",
    };

    const result = createDesktopPersistenceSmokeEnvironment({
      environment: inheritedEnvironment,
      synaraHome,
    });

    expect(result.userDataPath).toBe(resolve(synaraHome, "electron-user-data"));
    expect(result.environment[DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV]).toBe(
      result.userDataPath,
    );
    expect(result.environment).not.toHaveProperty(
      "Synara_Desktop_Persistence_Smoke_User_Data",
    );
    expect(result.environment.APPDATA).toBe(inheritedEnvironment.APPDATA);
    expect(result.environment).not.toHaveProperty("VITE_DEV_SERVER_URL");
    expect(
      validateDesktopPersistenceSmokeProfileIsolation({
        environment: result.environment,
        synaraHome,
      }),
    ).toBe(result.userDataPath);
  });

  it("fails closed when the isolated Electron profile contract is absent or escapes the home", () => {
    const synaraHome = resolve(homedir(), "desktop-persistence-smoke-test");

    expect(() =>
      validateDesktopPersistenceSmokeProfileIsolation({
        environment: {},
        synaraHome,
      }),
    ).toThrow(`requires ${DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV}`);
    expect(() =>
      validateDesktopPersistenceSmokeProfileIsolation({
        environment: {
          [DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV]: resolve(homedir(), "outside-profile"),
        },
        synaraHome,
      }),
    ).toThrow("to remain inside SYNARA_HOME");
  });

  it.each([undefined, "0", "true"])(
    "requires the exact updater-disable flag for persistence smoke (%s)",
    (disableUpdates) => {
      expect(() =>
        validateDesktopPersistenceSmokeEnvironment({
          environment: {
            SYNARA_DESKTOP_FLAVOR: "super",
            SYNARA_DESKTOP_DISABLE_UPDATES: disableUpdates,
            SYNARA_HOME: resolve(homedir(), "desktop-persistence-smoke-test"),
          },
        }),
      ).toThrow('requires SYNARA_DESKTOP_DISABLE_UPDATES="1"');
    },
  );

  it("creates a missing validated home without deleting caller state", () => {
    const isolatedHome = resolve(homedir(), "desktop-persistence-smoke-created-test");
    const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
    const statPath = vi
      .fn()
      .mockImplementationOnce(() => {
        throw missingError;
      })
      .mockReturnValue({ isDirectory: () => true });
    const makeDirectory = vi.fn();

    expect(
      ensureDesktopPersistenceSmokeHome(isolatedHome, { statPath, makeDirectory }),
    ).toEqual({ homePath: isolatedHome, created: true });
    expect(makeDirectory).toHaveBeenCalledExactlyOnceWith(isolatedHome, { recursive: true });
    expect(statPath).toHaveBeenCalledTimes(2);
  });

  it("preserves an existing validated home", () => {
    const isolatedHome = resolve(homedir(), "desktop-persistence-smoke-existing-test");
    const statPath = vi.fn(() => ({ isDirectory: () => true }));
    const makeDirectory = vi.fn();

    expect(
      ensureDesktopPersistenceSmokeHome(isolatedHome, { statPath, makeDirectory }),
    ).toEqual({ homePath: isolatedHome, created: false });
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(statPath).toHaveBeenCalledExactlyOnceWith(isolatedHome);
  });

  it("rejects an early desktop exit before semantic readiness", async () => {
    const child = new FakeSmokeProcess();
    const readinessPromise = waitForDesktopSmokeReadiness({
      child,
      description: "launch A",
      timeoutMs: 1_000,
    });

    child.exitAndClose(0);

    await expect(readinessPromise).rejects.toThrow(
      "launch A exited before semantic startup readiness",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts semantic readiness evidence split across output chunks", async () => {
    const child = new FakeSmokeProcess();
    const readinessPromise = waitForDesktopSmokeReadiness({
      child,
      description: "launch A",
      timeoutMs: 1_000,
    });

    child.stdout.emit("data", Buffer.from("[server] Synara "));
    child.stdout.emit("data", Buffer.from("running { port: 3773 }\n"));

    await expect(readinessPromise).resolves.toMatchObject({
      evidence: "Synara running",
      output: expect.stringContaining("port: 3773"),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects fatal output even when semantic readiness appears in the same chunk", async () => {
    const child = new FakeSmokeProcess();
    const readinessPromise = waitForDesktopSmokeReadiness({
      child,
      description: "launch A",
      timeoutMs: 1_000,
    });

    child.stderr.emit(
      "data",
      Buffer.from("Uncaught TypeError: startup failed\nSynara running { port: 3773 }\n"),
    );

    await expect(readinessPromise).rejects.toThrow(
      "launch A emitted fatal startup output 'Uncaught TypeError'",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("force-stops the detached POSIX process group without a graceful signal", async () => {
    const child = new FakeSmokeProcess();
    let treeAlive = true;
    const signalProcess = vi.fn((_pid, signal) => {
      treeAlive = false;
      child.exitAndClose(null, signal);
    });

    const result = await forceStopDesktopSmokeProcessTree({
      child,
      description: "launch A",
      platform: "linux",
      signalProcess,
      isPosixTreeAlive: () => treeAlive,
    });

    expect(result).toEqual({ mode: "force", platform: "linux", pid: child.pid });
    expect(signalProcess).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires successful Windows taskkill and root exit proof in force mode", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(async () => {
      child.exitAndClose(null, "SIGKILL");
      return { ok: true };
    });

    const result = await forceStopDesktopSmokeProcessTree({
      child,
      description: "launch A",
      platform: "win32",
      timeoutMs: 500,
      killWindowsTree,
    });

    expect(result).toEqual({ mode: "force", platform: "win32", pid: child.pid });
    expect(killWindowsTree).toHaveBeenCalledExactlyOnceWith(child.pid, { timeoutMs: 500 });
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies only the known unsupported-termination taskkill race for PID proof", () => {
    const output = [
      "SUCCESS: The process with PID 5001 (child process of PID 4312) has been terminated.",
      "ERROR: The process with PID 5002 (child process of PID 4312) could not be terminated.",
      "Reason: The operation attempted is not supported.",
    ].join("\r\n");

    expect(classifyWindowsTaskkillClose({ code: 128, signal: null, output })).toEqual({
      ok: false,
      diagnostic: expect.stringContaining("code=128"),
      verificationPids: [5001, 5002],
    });
    expect(
      classifyWindowsTaskkillClose({
        code: 5,
        signal: null,
        output:
          "ERROR: The process with PID 5002 could not be terminated.\r\nReason: Access is denied.",
      }),
    ).toEqual({
      ok: false,
      diagnostic: expect.stringContaining("Access is denied"),
    });
  });

  it("classifies interleaved taskkill stdout and stderr only when every error has its reason", () => {
    const output = [
      "ERROR: The process with PID 12112 (child process of PID 68156) could not be terminated.\r",
      "SUCCESS: The process with PID 106640 (child process of PID 56436) has been terminated.",
      "Reason: The operation attempted is not supported.",
      "ERROR: The process with PID 60956 (child process of PID 68156) could not be terminated.",
      "SUCCESS: The process with PID 54948 (child process of PID 68156) has been terminated.",
      "Reason: The operation attempted is not supported.",
    ].join("\r\n");

    expect(classifyWindowsTaskkillClose({ code: 128, signal: null, output })).toEqual({
      ok: false,
      diagnostic: expect.stringContaining("code=128"),
      verificationPids: [12112, 106640, 60956, 54948],
    });
    expect(
      classifyWindowsTaskkillClose({
        code: 128,
        signal: null,
        output: output.replace(
          "Reason: The operation attempted is not supported.",
          "Reason: Access is denied.",
        ),
      }),
    ).not.toHaveProperty("verificationPids");
  });

  it("accepts the unsupported-termination race only after every reported PID is gone", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(async () => {
      child.exitAndClose(null, "SIGKILL");
      return {
        ok: false,
        diagnostic: "taskkill encountered already-terminating processes",
        verificationPids: [5001, 5002],
      };
    });
    const isWindowsProcessAlive = vi.fn(() => false);

    const result = await forceStopDesktopSmokeProcessTree({
      child,
      description: "launch A",
      platform: "win32",
      timeoutMs: 500,
      killWindowsTree,
      isWindowsProcessAlive,
    });

    expect(result).toEqual({ mode: "force", platform: "win32", pid: child.pid });
    expect(isWindowsProcessAlive).toHaveBeenCalledWith(child.pid);
    expect(isWindowsProcessAlive).toHaveBeenCalledWith(5001);
    expect(isWindowsProcessAlive).toHaveBeenCalledWith(5002);
  });

  it("fails closed when Windows taskkill does not confirm the full tree", async () => {
    const child = new FakeSmokeProcess();
    const killWindowsTree = vi.fn(async () => ({
      ok: false,
      diagnostic: "taskkill access denied",
    }));

    await expect(
      forceStopDesktopSmokeProcessTree({
        child,
        description: "launch A",
        platform: "win32",
        timeoutMs: 500,
        killWindowsTree,
        waitForExit: async () => true,
      }),
    ).rejects.toThrow(
      "launch A forced process-tree teardown was not confirmed: taskkill access denied",
    );
    expect(killWindowsTree).toHaveBeenCalledExactlyOnceWith(child.pid, { timeoutMs: 500 });
  });

  it("fails closed when POSIX process-tree confirmation times out", async () => {
    const child = new FakeSmokeProcess();
    const signalProcess = vi.fn(() => child.exitAndClose(null, "SIGKILL"));
    const waitForTreeGone = vi.fn(async () => false);

    await expect(
      forceStopDesktopSmokeProcessTree({
        child,
        description: "launch A",
        platform: "linux",
        timeoutMs: 250,
        signalProcess,
        waitForTreeGone,
      }),
    ).rejects.toThrow("POSIX process-tree confirmation timed out after 250ms");
    expect(waitForTreeGone).toHaveBeenCalledOnce();
    expect(signalProcess).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
  });

  it("bounds process-tree polling when the tree never disappears", async () => {
    const isTreeAlive = vi.fn(() => true);
    const treeGonePromise = waitForDesktopProcessTreeGone({
      isTreeAlive,
      timeoutMs: 250,
      pollIntervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(treeGonePromise).resolves.toBe(false);
    expect(isTreeAlive).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not launch B or assert until each force-stop tree proof completes", async () => {
    const events = [];
    const launches = new Map();
    await runDesktopPersistenceSmokeSequence({
      seedFixture: async () => events.push("seed"),
      armFixture: async () => events.push("arm"),
      launchDesktop: async (label) => {
        events.push(`${label}:start`);
        const launch = { label };
        launches.set(label, launch);
        return launch;
      },
      waitForReadiness: async (launch) => events.push(`${launch.label}:ready`),
      forceStopDesktop: async (launch) => {
        events.push(`${launch.label}:force-start`);
        await Promise.resolve();
        events.push(`${launch.label}:tree-gone`);
      },
      assertFixture: async () => events.push("assert"),
      cleanupDesktop: vi.fn(),
    });

    expect(events).toEqual([
      "seed",
      "launch A:start",
      "launch A:ready",
      "arm",
      "launch A:force-start",
      "launch A:tree-gone",
      "launch B:start",
      "launch B:ready",
      "launch B:force-start",
      "launch B:tree-gone",
      "assert",
    ]);
    expect(launches.size).toBe(2);
  });

  it("cleans up launch A and stops the sequence when fixture arming fails", async () => {
    const events = [];
    const launch = { label: "launch A" };
    const forceStopDesktop = vi.fn();

    await expect(
      runDesktopPersistenceSmokeSequence({
        seedFixture: async () => events.push("seed"),
        armFixture: async () => {
          events.push("arm");
          throw new Error("arm failed");
        },
        launchDesktop: async (label) => {
          events.push(`${label}:start`);
          return launch;
        },
        waitForReadiness: async (_activeLaunch, label) => events.push(`${label}:ready`),
        forceStopDesktop,
        assertFixture: vi.fn(),
        cleanupDesktop: async (activeLaunch, label) => {
          expect(activeLaunch).toBe(launch);
          events.push(`${label}:cleanup`);
        },
      }),
    ).rejects.toThrow("arm failed");

    expect(events).toEqual([
      "seed",
      "launch A:start",
      "launch A:ready",
      "arm",
      "launch A:cleanup",
    ]);
    expect(forceStopDesktop).not.toHaveBeenCalled();
  });
});
