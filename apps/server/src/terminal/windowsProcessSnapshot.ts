// FILE: windowsProcessSnapshot.ts
// Purpose: Captures one bounded whole-system Windows process snapshot for terminal polling.
// Layer: Terminal infrastructure utility

import path from "node:path";

import {
  runProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../processRunner";

export const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 1_500;
export const WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

const WINDOWS_PROCESS_SNAPSHOT_VERSION = 1;
const WINDOWS_PROCESS_MAX_PID = 0xffff_ffff;
const WINDOWS_PROCESS_MAX_PARENT_DEPTH = 256;

const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$utf8 = New-Object System.Text.UTF8Encoding($false)",
  "[Console]::OutputEncoding = $utf8",
  "$OutputEncoding = $utf8",
  "$records = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)",
  "$envelope = [ordered]@{ version = 1; complete = $true; recordCount = $records.Count; records = $records }",
  "$envelope | ConvertTo-Json -Compress -Depth 4",
].join("; ");

const WINDOWS_POWERSHELL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  WINDOWS_PROCESS_SNAPSHOT_SCRIPT,
] as const;

export interface WindowsProcessChild {
  readonly pid: number;
  readonly command: string;
}

export type WindowsProcessChildrenMap = ReadonlyMap<
  number,
  readonly WindowsProcessChild[]
>;

export type WindowsProcessSnapshotUnknownReason =
  | "unsupported_platform"
  | "invalid_system_root"
  | "cancelled"
  | "capture_failed"
  | "timed_out"
  | "terminated_by_signal"
  | "nonzero_exit"
  | "truncated_output"
  | "stderr_output"
  | "empty_output"
  | "malformed_output"
  | "invalid_envelope"
  | "record_count_mismatch"
  | "empty_snapshot"
  | "invalid_pid"
  | "invalid_parent_pid"
  | "duplicate_pid"
  | "missing_command_identity"
  | "unsafe_topology";

export type WindowsProcessSnapshotResult =
  | {
      readonly kind: "ok";
      readonly processCount: number;
      readonly childrenByParentPid: WindowsProcessChildrenMap;
    }
  | {
      readonly kind: "unknown";
      readonly reason: WindowsProcessSnapshotUnknownReason;
    };

export type WindowsProcessSnapshotRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessRunResult>;

export interface WindowsProcessSnapshotCollectorDependencies {
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly runProcess?: WindowsProcessSnapshotRunner | undefined;
}

export type WindowsProcessSnapshotCollector = (
  signal?: AbortSignal,
) => Promise<WindowsProcessSnapshotResult>;

interface ParsedWindowsProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
}

function unknown(reason: WindowsProcessSnapshotUnknownReason): WindowsProcessSnapshotResult {
  return { kind: "unknown", reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidWindowsPid(value: unknown, allowZero: boolean): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value <= WINDOWS_PROCESS_MAX_PID &&
    (allowZero ? value >= 0 : value > 0)
  );
}

function commandIdentity(record: Record<string, unknown>): string | null {
  const identityFields = ["CommandLine", "ExecutablePath", "Name"] as const;
  for (const field of identityFields) {
    if (!hasOwn(record, field)) return null;
    const value = record[field];
    if (value !== null && typeof value !== "string") return null;
  }

  for (const field of identityFields) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function validateTopology(processes: readonly ParsedWindowsProcess[]): boolean {
  const parentsByPid = new Map(processes.map((process) => [process.pid, process.parentPid]));

  for (const process of processes) {
    const visited = new Set<number>([process.pid]);
    let currentPid = process.pid;
    let depth = 0;

    while (true) {
      const parentPid = parentsByPid.get(currentPid);
      if (parentPid === undefined || parentPid === 0) break;
      if (visited.has(parentPid)) return false;
      depth += 1;
      if (depth > WINDOWS_PROCESS_MAX_PARENT_DEPTH) return false;
      visited.add(parentPid);
      currentPid = parentPid;
    }
  }

  return true;
}

function buildChildrenMap(
  processes: readonly ParsedWindowsProcess[],
): WindowsProcessChildrenMap {
  const mutableChildren = new Map<number, WindowsProcessChild[]>();
  for (const process of processes) {
    const children = mutableChildren.get(process.parentPid) ?? [];
    children.push(Object.freeze({ pid: process.pid, command: process.command }));
    mutableChildren.set(process.parentPid, children);
  }

  const childrenByParentPid = new Map<number, readonly WindowsProcessChild[]>();
  for (const [parentPid, children] of mutableChildren) {
    children.sort((left, right) => left.pid - right.pid);
    childrenByParentPid.set(parentPid, Object.freeze(children));
  }
  return childrenByParentPid;
}

function parseSnapshot(stdout: string): WindowsProcessSnapshotResult {
  const output = stdout.trim();
  if (output.length === 0) return unknown("empty_output");

  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    return unknown("malformed_output");
  }

  if (!isObject(decoded)) return unknown("invalid_envelope");
  if (
    decoded.version !== WINDOWS_PROCESS_SNAPSHOT_VERSION ||
    decoded.complete !== true ||
    !Number.isSafeInteger(decoded.recordCount) ||
    (decoded.recordCount as number) < 0 ||
    !Array.isArray(decoded.records)
  ) {
    return unknown("invalid_envelope");
  }
  if (decoded.recordCount !== decoded.records.length) {
    return unknown("record_count_mismatch");
  }
  if (decoded.records.length === 0) return unknown("empty_snapshot");

  const seenPids = new Set<number>();
  const processes: ParsedWindowsProcess[] = [];
  for (const value of decoded.records) {
    if (!isObject(value)) return unknown("malformed_output");
    if (!hasOwn(value, "ProcessId") || !isValidWindowsPid(value.ProcessId, true)) {
      return unknown("invalid_pid");
    }
    if (!hasOwn(value, "ParentProcessId") || !isValidWindowsPid(value.ParentProcessId, true)) {
      return unknown("invalid_parent_pid");
    }

    const pid = value.ProcessId;
    const parentPid = value.ParentProcessId;
    if (seenPids.has(pid)) return unknown("duplicate_pid");
    seenPids.add(pid);

    if (pid === 0) {
      if (parentPid !== 0) return unknown("invalid_parent_pid");
      continue;
    }

    const command = commandIdentity(value);
    if (command === null) return unknown("missing_command_identity");
    processes.push({ pid, parentPid, command });
  }

  if (processes.length === 0) return unknown("empty_snapshot");
  if (!validateTopology(processes)) return unknown("unsafe_topology");
  return {
    kind: "ok",
    processCount: processes.length,
    childrenByParentPid: buildChildrenMap(processes),
  };
}

function systemRootFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (
    typeof systemRoot !== "string" ||
    systemRoot.length === 0 ||
    systemRoot.trim() !== systemRoot ||
    /[\0\r\n]/.test(systemRoot) ||
    !path.win32.isAbsolute(systemRoot)
  ) {
    return null;
  }

  const rootLength = path.win32.parse(systemRoot).root.length;
  const segments = systemRoot.slice(rootLength).split(/[\\/]+/g);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return systemRoot;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createWindowsProcessSnapshotCollector(
  dependencies: WindowsProcessSnapshotCollectorDependencies = {},
): WindowsProcessSnapshotCollector {
  const platform = dependencies.platform ?? globalThis.process.platform;
  const env = dependencies.env ?? globalThis.process.env;
  const execute = dependencies.runProcess ?? runProcess;

  return async (signal) => {
    if (platform !== "win32") return unknown("unsupported_platform");

    const systemRoot = systemRootFromEnvironment(env);
    if (systemRoot === null) return unknown("invalid_system_root");
    const powershellPath = path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );

    let result: ProcessRunResult;
    try {
      result = await execute(powershellPath, WINDOWS_POWERSHELL_ARGS, {
        allowNonZeroExit: true,
        maxBufferBytes: WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER_BYTES,
        outputMode: "truncate",
        signal,
        timeoutMs: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
      });
    } catch (error) {
      return unknown(isAbortError(error) || signal?.aborted ? "cancelled" : "capture_failed");
    }

    if (result.timedOut) return unknown("timed_out");
    if (result.signal !== null) return unknown("terminated_by_signal");
    if (result.code !== 0) return unknown("nonzero_exit");
    if (result.stdoutTruncated || result.stderrTruncated) return unknown("truncated_output");
    if (result.stderr.trim().length > 0) return unknown("stderr_output");
    return parseSnapshot(result.stdout);
  };
}

export const captureWindowsProcessSnapshot = createWindowsProcessSnapshotCollector();
