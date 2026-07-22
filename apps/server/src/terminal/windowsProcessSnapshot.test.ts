// FILE: windowsProcessSnapshot.test.ts
// Purpose: Verifies bounded, strict, and non-sensitive Windows process snapshot capture.
// Layer: Terminal infrastructure tests
import { describe, expect, it, vi } from "vitest";

import { runProcess, type ProcessRunResult } from "../processRunner";
import {
  createWindowsProcessSnapshotCollector,
  WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER_BYTES,
  WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
  type WindowsProcessSnapshotCollector,
  type WindowsProcessSnapshotResult,
  type WindowsProcessSnapshotRunner,
} from "./windowsProcessSnapshot";

interface TestProcessRecord {
  ProcessId: unknown;
  ParentProcessId: unknown;
  Name: unknown;
  ExecutablePath: unknown;
  CommandLine: unknown;
}

const SYSTEM_ROOT = String.raw`C:\Windows`;
const POWERSHELL_PATH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const NATIVE_WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 30_000;

// Keep the product's fail-closed five-second deadline while giving the hosted native capability
// proof enough headroom when the full Windows suite contends for PowerShell/CIM resources.
const captureNativeWindowsProcessSnapshot = createWindowsProcessSnapshotCollector({
  runProcess: (command, args, options) =>
    runProcess(command, args, {
      ...(options ?? {}),
      timeoutMs: NATIVE_WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
    }),
});

function record(
  ProcessId: number,
  ParentProcessId: number,
  overrides: Partial<TestProcessRecord> = {},
): TestProcessRecord {
  return {
    ProcessId,
    ParentProcessId,
    Name: `process-${ProcessId}.exe`,
    ExecutablePath: `C:\\tools\\process-${ProcessId}.exe`,
    CommandLine: `process-${ProcessId}.exe --serve`,
    ...overrides,
  };
}

function envelope(records: readonly unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    complete: true,
    recordCount: records.length,
    records,
    ...overrides,
  });
}

function processResult(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    stdout: envelope([record(10, 0)]),
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function fakeCollector(input: {
  readonly result?: ProcessRunResult | undefined;
  readonly runner?: WindowsProcessSnapshotRunner | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}) {
  const runner =
    input.runner ?? vi.fn(async (): Promise<ProcessRunResult> => input.result ?? processResult());
  return {
    capture: createWindowsProcessSnapshotCollector({
      platform: input.platform ?? "win32",
      env: input.env ?? { SystemRoot: SYSTEM_ROOT },
      runProcess: runner,
    }),
    runner,
  };
}

function expectUnknown(
  result: Awaited<ReturnType<ReturnType<typeof createWindowsProcessSnapshotCollector>>>,
  reason: string,
): void {
  expect(result).toEqual({ kind: "unknown", reason });
  expect(Object.keys(result).sort()).toEqual(["kind", "reason"]);
}

async function captureNativeWindowsProcessSnapshotWithTimeoutRetry(
  capture: WindowsProcessSnapshotCollector = captureNativeWindowsProcessSnapshot,
): Promise<{
  result: WindowsProcessSnapshotResult;
  attemptOutcomes: readonly string[];
}> {
  const first = await capture();
  const firstOutcome = first.kind === "ok" ? "ok" : first.reason;
  if (first.kind === "ok" || first.reason !== "timed_out") {
    return { result: first, attemptOutcomes: [firstOutcome] };
  }

  const second = await capture();
  return {
    result: second,
    attemptOutcomes: [firstOutcome, second.kind === "ok" ? "ok" : second.reason],
  };
}

describe("native Windows process snapshot retry policy", () => {
  const successfulSnapshot = (): WindowsProcessSnapshotResult => ({
    kind: "ok",
    processCount: 1,
    childrenByParentPid: new Map([[0, [{ pid: 41, command: "process-41.exe" }]]]),
  });

  it("retries one transient timeout and returns the successful second capture", async () => {
    const capture = vi
      .fn<WindowsProcessSnapshotCollector>()
      .mockResolvedValueOnce({ kind: "unknown", reason: "timed_out" })
      .mockResolvedValueOnce(successfulSnapshot());

    const outcome = await captureNativeWindowsProcessSnapshotWithTimeoutRetry(capture);

    expect(capture).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      result: successfulSnapshot(),
      attemptOutcomes: ["timed_out", "ok"],
    });
  });

  it("stops after the second timeout", async () => {
    const capture = vi
      .fn<WindowsProcessSnapshotCollector>()
      .mockResolvedValue({ kind: "unknown", reason: "timed_out" });

    const outcome = await captureNativeWindowsProcessSnapshotWithTimeoutRetry(capture);

    expect(capture).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      result: { kind: "unknown", reason: "timed_out" },
      attemptOutcomes: ["timed_out", "timed_out"],
    });
  });

  it("does not retry a non-timeout failure", async () => {
    const capture = vi
      .fn<WindowsProcessSnapshotCollector>()
      .mockResolvedValue({ kind: "unknown", reason: "malformed_output" });

    const outcome = await captureNativeWindowsProcessSnapshotWithTimeoutRetry(capture);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      result: { kind: "unknown", reason: "malformed_output" },
      attemptOutcomes: ["malformed_output"],
    });
  });
});

describe("createWindowsProcessSnapshotCollector", () => {
  it("invokes absolute Windows PowerShell 5.1 once with the exact bounds and caller signal", async () => {
    const runner = vi.fn<WindowsProcessSnapshotRunner>(async () => processResult());
    const capture = createWindowsProcessSnapshotCollector({
      platform: "win32",
      env: { SystemRoot: SYSTEM_ROOT },
      runProcess: runner,
    });
    const controller = new AbortController();

    expect((await capture(controller.signal)).kind).toBe("ok");
    expect(runner).toHaveBeenCalledTimes(1);
    const [command, args, options] = runner.mock.calls[0] ?? [];
    expect(command).toBe(POWERSHELL_PATH);
    expect(args?.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args).toHaveLength(5);
    const script = args?.[4] ?? "";
    expect(script.match(/Get-CimInstance Win32_Process/g)).toHaveLength(1);
    expect(script).toContain(
      "-Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine",
    );
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("System.Text.UTF8Encoding");
    expect(script).toContain(
      "Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine",
    );
    expect(script).toContain("version = 1");
    expect(script).toContain("complete = $true");
    expect(script).toContain("recordCount = $records.Count");
    expect(options).toEqual({
      allowNonZeroExit: true,
      maxBufferBytes: WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER_BYTES,
      outputMode: "truncate",
      signal: controller.signal,
      timeoutMs: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
    });
    expect(WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS).toBe(5_000);
    expect(WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER_BYTES).toBe(8 * 1024 * 1024);
  });

  it("captures a singleton process", async () => {
    const { capture } = fakeCollector({
      result: processResult({ stdout: envelope([record(41, 0)]) }),
    });

    const result = await capture();

    expect(result).toEqual({
      kind: "ok",
      processCount: 1,
      childrenByParentPid: new Map([[0, [{ pid: 41, command: "process-41.exe --serve" }]]]),
    });
  });

  it("captures multiple nested records with non-ASCII and metacharacter command lines", async () => {
    const command = 'C:\\工具\\agent.cmd --label "a&b|(c)^%d!"';
    const { capture } = fakeCollector({
      result: processResult({
        stdout: envelope([
          record(30, 10, { CommandLine: command }),
          record(10, 0, { CommandLine: "root.exe" }),
          record(20, 10, { CommandLine: "child.exe" }),
          record(40, 20, { CommandLine: "grandchild.exe" }),
        ]),
      }),
    });

    const result = await capture();

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.processCount).toBe(4);
    expect(result.childrenByParentPid.get(0)).toEqual([{ pid: 10, command: "root.exe" }]);
    expect(result.childrenByParentPid.get(10)).toEqual([
      { pid: 20, command: "child.exe" },
      { pid: 30, command },
    ]);
    expect(result.childrenByParentPid.get(20)).toEqual([{ pid: 40, command: "grandchild.exe" }]);
  });

  it("prefers command line, then executable path, then name", async () => {
    const { capture } = fakeCollector({
      result: processResult({
        stdout: envelope([
          record(1, 0, {
            CommandLine: " command-line.exe --flag ",
            ExecutablePath: "C:\\fallback.exe",
            Name: "fallback-name.exe",
          }),
          record(2, 1, {
            CommandLine: "   ",
            ExecutablePath: " C:\\chosen-path.exe ",
            Name: "fallback-name.exe",
          }),
          record(3, 2, {
            CommandLine: null,
            ExecutablePath: "",
            Name: " chosen-name.exe ",
          }),
        ]),
      }),
    });

    const result = await capture();

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.processCount).toBe(3);
    expect(result.childrenByParentPid.get(0)?.[0]?.command).toBe("command-line.exe --flag");
    expect(result.childrenByParentPid.get(1)?.[0]?.command).toBe("C:\\chosen-path.exe");
    expect(result.childrenByParentPid.get(2)?.[0]?.command).toBe("chosen-name.exe");
  });

  it("ignores only the PID 0 system sentinel", async () => {
    const { capture } = fakeCollector({
      result: processResult({
        stdout: envelope([
          record(0, 0, { Name: null, ExecutablePath: null, CommandLine: null }),
          record(4, 0, { CommandLine: "System" }),
        ]),
      }),
    });

    const result = await capture();

    expect(result).toEqual({
      kind: "ok",
      processCount: 1,
      childrenByParentPid: new Map([[0, [{ pid: 4, command: "System" }]]]),
    });
  });

  it("accepts whitespace-only stderr and a missing parent that exited during capture", async () => {
    const { capture } = fakeCollector({
      result: processResult({
        stderr: " \r\n\t",
        stdout: envelope([record(101, 100, { CommandLine: "survivor.exe" })]),
      }),
    });

    expect(await capture()).toEqual({
      kind: "ok",
      processCount: 1,
      childrenByParentPid: new Map([[100, [{ pid: 101, command: "survivor.exe" }]]]),
    });
  });

  it("allows a parent-chain depth of exactly 256", async () => {
    const records = Array.from({ length: 257 }, (_, index) => record(index + 1, index));
    const { capture } = fakeCollector({
      result: processResult({ stdout: envelope(records) }),
    });

    expect((await capture()).kind).toBe("ok");
  });

  it("runs a fresh query for every call without retaining a cache", async () => {
    let callCount = 0;
    const runner = vi.fn(async (): Promise<ProcessRunResult> => {
      callCount += 1;
      return processResult({ stdout: envelope([record(callCount, 0)]) });
    });
    const { capture } = fakeCollector({ runner });

    const first = await capture();
    const second = await capture();

    expect(runner).toHaveBeenCalledTimes(2);
    expect(first.kind === "ok" ? first.childrenByParentPid.get(0)?.[0]?.pid : null).toBe(1);
    expect(second.kind === "ok" ? second.childrenByParentPid.get(0)?.[0]?.pid : null).toBe(2);
  });

  it("returns unknown without invoking the runner on unsupported platforms", async () => {
    const { capture, runner } = fakeCollector({ platform: "linux" });

    expectUnknown(await capture(), "unsupported_platform");
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["empty", { SystemRoot: "" }],
    ["relative", { SystemRoot: String.raw`Windows` }],
    ["surrounding whitespace", { SystemRoot: String.raw` C:\Windows` }],
    ["NUL", { SystemRoot: "C:\\Win\0dows" }],
    ["parent traversal", { SystemRoot: String.raw`C:\Windows\..\Temp` }],
  ])("rejects a %s SystemRoot before invoking the runner", async (_label, env) => {
    const { capture, runner } = fakeCollector({ env });

    expectUnknown(await capture(), "invalid_system_root");
    expect(runner).not.toHaveBeenCalled();
  });

  it("classifies spawn failures without exposing their text", async () => {
    const runner = vi.fn(async (): Promise<ProcessRunResult> => {
      throw new Error("SECRET C:\\private\\operator\\powershell.exe failed");
    });
    const { capture } = fakeCollector({ runner });

    const result = await capture();

    expectUnknown(result, "capture_failed");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("operator");
  });

  it("classifies cancellation without exposing abort details", async () => {
    const runner = vi.fn(async (): Promise<ProcessRunResult> => {
      const error = new Error("SECRET cancelled command line");
      error.name = "AbortError";
      throw error;
    });
    const { capture } = fakeCollector({ runner });
    const controller = new AbortController();

    const result = await capture(controller.signal);

    expectUnknown(result, "cancelled");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each([
    ["timeout", processResult({ timedOut: true }), "timed_out"],
    ["signal", processResult({ signal: "SIGTERM" }), "terminated_by_signal"],
    ["nonzero exit", processResult({ code: 17 }), "nonzero_exit"],
    ["null exit", processResult({ code: null }), "nonzero_exit"],
    ["stdout truncation", processResult({ stdoutTruncated: true }), "truncated_output"],
    ["stderr truncation", processResult({ stderrTruncated: true }), "truncated_output"],
    ["stderr output", processResult({ stderr: "SECRET PowerShell path" }), "stderr_output"],
  ])("returns unknown for %s", async (_label, runnerResult, reason) => {
    const { capture } = fakeCollector({ result: runnerResult });

    const result = await capture();

    expectUnknown(result, reason);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each(["", " \r\n\t"])("returns unknown for empty stdout %j", async (stdout) => {
    const { capture } = fakeCollector({ result: processResult({ stdout }) });

    expectUnknown(await capture(), "empty_output");
  });

  it("rejects malformed JSON without returning raw output", async () => {
    const { capture } = fakeCollector({
      result: processResult({ stdout: '{"SECRET":"C:\\\\private\\\\command.cmd"' }),
    });

    const result = await capture();

    expectUnknown(result, "malformed_output");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each([
    ["array root", JSON.stringify([])],
    ["wrong version", envelope([record(1, 0)], { version: 2 })],
    ["incomplete", envelope([record(1, 0)], { complete: false })],
    [
      "missing record count",
      JSON.stringify({ version: 1, complete: true, records: [record(1, 0)] }),
    ],
    ["noninteger record count", envelope([record(1, 0)], { recordCount: 1.5 })],
    ["negative record count", envelope([record(1, 0)], { recordCount: -1 })],
    ["non-array records", envelope([], { records: {} })],
  ])("rejects an invalid envelope: %s", async (_label, stdout) => {
    const { capture } = fakeCollector({ result: processResult({ stdout }) });

    expectUnknown(await capture(), "invalid_envelope");
  });

  it("rejects a record-count mismatch", async () => {
    const { capture } = fakeCollector({
      result: processResult({ stdout: envelope([record(1, 0)], { recordCount: 2 }) }),
    });

    expectUnknown(await capture(), "record_count_mismatch");
  });

  it.each([
    ["no records", envelope([])],
    [
      "only the PID 0 sentinel",
      envelope([record(0, 0, { Name: null, ExecutablePath: null, CommandLine: null })]),
    ],
  ])("rejects an empty system snapshot: %s", async (_label, stdout) => {
    const { capture } = fakeCollector({ result: processResult({ stdout }) });

    expectUnknown(await capture(), "empty_snapshot");
  });

  it.each([
    ["missing record", null],
    ["array record", []],
  ])("rejects a malformed %s", async (_label, invalidRecord) => {
    const { capture } = fakeCollector({
      result: processResult({ stdout: envelope([invalidRecord]) }),
    });

    expectUnknown(await capture(), "malformed_output");
  });

  it.each([
    ["missing", { ...record(1, 0), ProcessId: undefined }],
    ["negative", record(-1, 0)],
    ["fractional", record(1.5, 0)],
    ["string", { ...record(1, 0), ProcessId: "1" }],
    ["too large", record(0x1_0000_0000, 0)],
  ])("rejects an invalid PID: %s", async (_label, invalidRecord) => {
    const { capture } = fakeCollector({
      result: processResult({ stdout: envelope([invalidRecord]) }),
    });

    expectUnknown(await capture(), "invalid_pid");
  });

  it.each([
    ["missing", { ...record(1, 0), ParentProcessId: undefined }],
    ["negative", record(1, -1)],
    ["fractional", record(1, 1.5)],
    ["string", { ...record(1, 0), ParentProcessId: "0" }],
    ["too large", record(1, 0x1_0000_0000)],
    ["PID 0 with a parent", record(0, 1, { Name: null, ExecutablePath: null, CommandLine: null })],
  ])("rejects an invalid parent PID: %s", async (_label, invalidRecord) => {
    const { capture } = fakeCollector({
      result: processResult({ stdout: envelope([invalidRecord]) }),
    });

    expectUnknown(await capture(), "invalid_parent_pid");
  });

  it("rejects duplicate PIDs", async () => {
    const { capture } = fakeCollector({
      result: processResult({ stdout: envelope([record(1, 0), record(1, 0)]) }),
    });

    expectUnknown(await capture(), "duplicate_pid");
  });

  it.each([
    ["all blank", record(1, 0, { Name: " ", ExecutablePath: "", CommandLine: null })],
    ["missing field", { ...record(1, 0), CommandLine: undefined }],
    ["invalid field type", record(1, 0, { CommandLine: 42 })],
  ])("rejects missing command identity: %s", async (_label, invalidRecord) => {
    const { capture } = fakeCollector({
      result: processResult({ stdout: envelope([invalidRecord]) }),
    });

    expectUnknown(await capture(), "missing_command_identity");
  });

  it.each([
    ["self-cycle", [record(1, 1)]],
    ["multi-node cycle", [record(1, 2), record(2, 3), record(3, 1)]],
    [
      "parent chain deeper than 256",
      Array.from({ length: 258 }, (_, index) => record(index + 1, index)),
    ],
  ])("rejects unsafe topology: %s", async (_label, records) => {
    const { capture } = fakeCollector({
      result: processResult({ stdout: envelope(records) }),
    });

    expectUnknown(await capture(), "unsafe_topology");
  });
});

it.runIf(process.platform === "win32")(
  "captures the native process table, includes this test process, and leaves its PowerShell child exited",
  async () => {
    const { result, attemptOutcomes } = await captureNativeWindowsProcessSnapshotWithTimeoutRetry();

    if (result.kind !== "ok") {
      throw new Error(
        `Native Windows process snapshot was unavailable after ${attemptOutcomes.length} attempt(s): ${attemptOutcomes.join(" -> ")}.`,
      );
    }
    const allChildren = [...result.childrenByParentPid.values()].flat();
    expect(result.processCount).toBe(allChildren.length);
    expect(allChildren.some((child) => child.pid === process.pid)).toBe(true);

    const captureChildren = result.childrenByParentPid.get(process.pid) ?? [];
    const powershellChildren = captureChildren.filter((child) =>
      child.command.includes("Get-CimInstance Win32_Process"),
    );
    expect(powershellChildren.length).toBeGreaterThan(0);
    for (const child of powershellChildren) {
      try {
        process.kill(child.pid, 0);
        throw new Error(`PowerShell capture child ${child.pid} was still running.`);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
    }
  },
  NATIVE_WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS * 2 + 5_000,
);
