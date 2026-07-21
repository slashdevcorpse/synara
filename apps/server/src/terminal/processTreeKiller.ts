// FILE: processTreeKiller.ts
// Purpose: Captures and terminates PTY process trees without losing reparented children.
// Layer: Terminal infrastructure utility
// Depends on: node child_process, process signals, and tree-kill.
import { execFile, spawnSync } from "node:child_process";

import treeKill from "tree-kill";

// PowerShell CIM startup is close to one second on a typical Windows host, and command lines can
// push a complete process-table snapshot beyond one MiB. These bounds still fail closed while
// leaving enough headroom for a real snapshot instead of timing out in normal operation.
const PROCESS_TREE_SCAN_TIMEOUT_MS = 5_000;
const PROCESS_TREE_SCAN_MAX_BUFFER_BYTES = 4 * 1_024 * 1_024;
const POSIX_TREE_WALK_MAX_VISITED = 256;

export type ProcessChildrenMap = Map<number, Array<CapturedProcess>>;
export type ProcessCommandMap = Map<number, string>;
export type ProcessSnapshotMap = Map<number, CapturedProcessSnapshot>;

export interface CapturedProcess {
  pid: number;
  command: string;
  /** Stable process-instance identity, normally derived from the process creation time. */
  identity?: string;
  /** Precision of the creation-time component used by `identity`. */
  identityPrecision?: "exact" | "seconds";
  /** POSIX process group; absent on Windows. */
  groupId?: number;
}

export interface CapturedProcessSnapshot extends CapturedProcess {
  parentPid: number;
}

export interface CapturedProcessTree {
  root?: CapturedProcess;
  descendants: CapturedProcess[];
  /** False when the platform process snapshot failed and descendant absence is unproven. */
  captureComplete?: boolean;
}

export interface CapturedProcessTreeInspection {
  /** False when the process table could not be read, so exit cannot be proven. */
  verified: boolean;
  survivors: CapturedProcess[];
}

export type TerminalKillSignal = "SIGTERM" | "SIGKILL";

export interface ProcessTreeKiller {
  capture(rootPid: number, options?: { readonly processGroupId?: number }): CapturedProcessTree;
  captureAsync?(
    rootPid: number,
    options?: { readonly processGroupId?: number },
  ): Promise<CapturedProcessTree>;
  inspect?(tree: CapturedProcessTree): CapturedProcessTreeInspection;
  inspectAsync?(tree: CapturedProcessTree): Promise<CapturedProcessTreeInspection>;
  signal(input: {
    rootPid: number;
    signal: TerminalKillSignal;
    tree: CapturedProcessTree;
    includeRootTree?: boolean | undefined;
    onError: (error: Error, context: { pid: number; source: "tree-kill" | "captured" }) => void;
  }): void;
  signalAsync?(input: {
    rootPid: number;
    signal: TerminalKillSignal;
    tree: CapturedProcessTree;
    includeRootTree?: boolean | undefined;
    onError: (error: Error, context: { pid: number; source: "tree-kill" | "captured" }) => void;
  }): Promise<void>;
}

export interface ProcessTreeKillerDependencies {
  captureProcessSnapshot: () => ProcessSnapshotMap | null;
  captureProcessSnapshotAsync: () => Promise<ProcessSnapshotMap | null>;
  readCurrentProcesses: (pids: readonly number[]) => ProcessSnapshotMap | null;
  signalPid: (pid: number, signal: TerminalKillSignal) => Error | null;
  signalTree: (
    rootPid: number,
    signal: TerminalKillSignal,
    callback: (error?: Error | null) => void,
  ) => void;
}

export function parseProcessChildrenMap(psOutput: string): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, ...commandParts] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const command = commandParts.join(" ").trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (command.length === 0) continue;
    const siblings = childrenByParentPid.get(ppid) ?? [];
    siblings.push({ pid, command });
    childrenByParentPid.set(ppid, siblings);
  }
  return childrenByParentPid;
}

export function parseProcessCommandMap(psOutput: string): ProcessCommandMap {
  const commandsByPid: ProcessCommandMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]?.trim() ?? "";
    if (!Number.isInteger(pid) || command.length === 0) continue;
    commandsByPid.set(pid, command);
  }
  return commandsByPid;
}

/** Parses `ps -eo pid=,ppid=,pgid=,lstart=,command=` into stable process identities. */
export function parsePosixProcessSnapshot(psOutput: string): ProcessSnapshotMap {
  const snapshot: ProcessSnapshotMap = new Map();
  const linePattern =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*\S)\s*$/u;
  for (const line of psOutput.split(/\r?\n/gu)) {
    const match = linePattern.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const groupId = Number(match[3]);
    const startedAt = match[4]?.trim() ?? "";
    const command = match[5]?.trim() ?? "";
    if (
      !Number.isInteger(pid) ||
      !Number.isInteger(parentPid) ||
      !Number.isInteger(groupId) ||
      startedAt.length === 0 ||
      command.length === 0
    ) {
      continue;
    }
    snapshot.set(pid, {
      pid,
      parentPid,
      groupId,
      command,
      identity: `${pid}:${startedAt}`,
      identityPrecision: "seconds",
    });
  }
  return snapshot;
}

/** Parses the compact JSON emitted by the Windows CIM process snapshot command. */
export function parseWindowsProcessSnapshot(json: string): ProcessSnapshotMap | null {
  try {
    const decoded: unknown = JSON.parse(json.replace(/^\uFEFF/u, ""));
    const entries = Array.isArray(decoded) ? decoded : [decoded];
    const snapshot: ProcessSnapshotMap = new Map();
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const pid = Number(record.ProcessId);
      const parentPid = Number(record.ParentProcessId);
      const startedAt = typeof record.CreationDate === "string" ? record.CreationDate.trim() : "";
      const command = [record.CommandLine, record.ExecutablePath, record.Name].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || command === undefined) {
        continue;
      }
      snapshot.set(pid, {
        pid,
        parentPid,
        command: command.trim(),
        ...(startedAt.length > 0
          ? { identity: `${pid}:${startedAt}`, identityPrecision: "exact" as const }
          : {}),
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function collectDescendantProcesses(
  parentPid: number,
  childrenByParentPid: ProcessChildrenMap,
): CapturedProcess[] {
  return collectDescendantProcessResult(parentPid, childrenByParentPid).descendants;
}

function collectDescendantProcessResult(
  parentPid: number,
  childrenByParentPid: ProcessChildrenMap,
): { readonly descendants: CapturedProcess[]; readonly complete: boolean } {
  const descendants: CapturedProcess[] = [];
  const stack = [...(childrenByParentPid.get(parentPid) ?? [])].reverse();
  const visited = new Set<number>([parentPid]);

  while (stack.length > 0 && descendants.length < POSIX_TREE_WALK_MAX_VISITED) {
    const child = stack.pop();
    if (!child || visited.has(child.pid)) {
      continue;
    }
    visited.add(child.pid);
    descendants.push(child);

    const nestedChildren = childrenByParentPid.get(child.pid) ?? [];
    for (const nestedChild of [...nestedChildren].reverse()) {
      stack.push(nestedChild);
    }
  }

  return { descendants, complete: stack.length === 0 };
}

const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine,ExecutablePath,Name | ConvertTo-Json -Compress",
].join("; ");

function parsePlatformProcessSnapshot(stdout: string): ProcessSnapshotMap | null {
  return globalThis.process.platform === "win32"
    ? parseWindowsProcessSnapshot(stdout)
    : parsePosixProcessSnapshot(stdout);
}

function processSnapshotCommand(): { readonly command: string; readonly args: readonly string[] } {
  return globalThis.process.platform === "win32"
    ? {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_PROCESS_SNAPSHOT_SCRIPT,
        ],
      }
    : {
        command: "ps",
        args: ["-eo", "pid=,ppid=,pgid=,lstart=,command="],
      };
}

function captureProcessSnapshotSync(): ProcessSnapshotMap | null {
  try {
    const snapshot = processSnapshotCommand();
    const result = spawnSync(snapshot.command, snapshot.args, {
      encoding: "utf8",
      maxBuffer: PROCESS_TREE_SCAN_MAX_BUFFER_BYTES,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    return parsePlatformProcessSnapshot(result.stdout);
  } catch {
    return null;
  }
}

function captureProcessSnapshotAsync(): Promise<ProcessSnapshotMap | null> {
  const snapshot = processSnapshotCommand();
  return new Promise((resolve) => {
    execFile(
      snapshot.command,
      snapshot.args,
      {
        encoding: "utf8",
        maxBuffer: PROCESS_TREE_SCAN_MAX_BUFFER_BYTES,
        timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(error === null ? parsePlatformProcessSnapshot(stdout) : null);
      },
    );
  });
}

function readCurrentProcesses(pids: readonly number[]): ProcessSnapshotMap | null {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (uniquePids.length === 0) return new Map();
  const snapshot = captureProcessSnapshotSync();
  if (snapshot === null) return null;
  const selected: ProcessSnapshotMap = new Map();
  for (const pid of uniquePids) {
    const process = snapshot.get(pid);
    if (process !== undefined) selected.set(pid, process);
  }
  return selected;
}

function selectCurrentProcesses(
  pids: readonly number[],
  snapshot: ProcessSnapshotMap | null,
): ProcessSnapshotMap | null {
  if (snapshot === null) return null;
  const selected: ProcessSnapshotMap = new Map();
  for (const pid of new Set(pids)) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const process = snapshot.get(pid);
    if (process !== undefined) selected.set(pid, process);
  }
  return selected;
}

function signalPid(pid: number, signal: TerminalKillSignal): Error | null {
  try {
    globalThis.process.kill(pid, signal);
    return null;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === "ESRCH") {
      return null;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

function matchingCapturedProcessInstance(
  process: CapturedProcess,
  currentProcesses: ProcessSnapshotMap | null,
): CapturedProcessSnapshot | undefined {
  // A command or bare PID is not a process-instance identity. A legitimate exec can change the
  // command while retaining the PID, creation identity, and process group.
  if (process.identity === undefined) return undefined;
  const current = currentProcesses?.get(process.pid);
  if (current === undefined || current.identity !== process.identity) return undefined;
  // POSIX `ps lstart` is only second-granular. Retain the isolated process group as an additional,
  // independently checked provenance field so same-second PID reuse fails closed.
  if (process.identityPrecision === "seconds" || current.identityPrecision === "seconds") {
    if (
      process.groupId === undefined ||
      current.groupId === undefined ||
      current.groupId !== process.groupId
    ) {
      return undefined;
    }
  }
  return current;
}

function shouldSignalCapturedProcess(
  process: CapturedProcess,
  _signal: TerminalKillSignal,
  currentProcesses: ProcessSnapshotMap | null,
): boolean {
  // Signaling remains stricter than liveness inspection: refuse a changed command even when the
  // stable process identity still matches.
  return matchingCapturedProcessInstance(process, currentProcesses)?.command === process.command;
}

function capturedProcessesForSignal(
  descendants: readonly CapturedProcess[],
  signal: TerminalKillSignal,
  currentProcesses: ProcessSnapshotMap | null,
): CapturedProcess[] {
  return descendants.filter((descendant) =>
    shouldSignalCapturedProcess(descendant, signal, currentProcesses),
  );
}

// Creates an injectable killer so tests can exercise PID-reuse safeguards safely.
export function createProcessTreeKiller(
  dependencies: Partial<ProcessTreeKillerDependencies> = {},
): ProcessTreeKiller {
  const deps: ProcessTreeKillerDependencies = {
    captureProcessSnapshot: dependencies.captureProcessSnapshot ?? captureProcessSnapshotSync,
    captureProcessSnapshotAsync:
      dependencies.captureProcessSnapshotAsync ??
      (dependencies.captureProcessSnapshot === undefined
        ? captureProcessSnapshotAsync
        : async () => dependencies.captureProcessSnapshot?.() ?? null),
    readCurrentProcesses: dependencies.readCurrentProcesses ?? readCurrentProcesses,
    signalPid: dependencies.signalPid ?? signalPid,
    signalTree: dependencies.signalTree ?? treeKill,
  };

  const captureFromSnapshot = (
    rootPid: number,
    options: { readonly processGroupId?: number } | undefined,
    snapshot: ProcessSnapshotMap | null,
  ): CapturedProcessTree => {
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
      return { descendants: [], captureComplete: false };
    }
    if (snapshot === null) return { descendants: [], captureComplete: false };
    const root = snapshot.get(rootPid);
    const childrenByParentPid: ProcessChildrenMap = new Map();
    for (const process of snapshot.values()) {
      const siblings = childrenByParentPid.get(process.parentPid) ?? [];
      siblings.push(process);
      childrenByParentPid.set(process.parentPid, siblings);
    }
    const descendantsByIdentity = new Map<string, CapturedProcess>();
    const descendantResult = collectDescendantProcessResult(rootPid, childrenByParentPid);
    for (const descendant of descendantResult.descendants) {
      descendantsByIdentity.set(
        `${descendant.pid}:${descendant.identity ?? descendant.command}`,
        descendant,
      );
    }
    const processGroupId = options?.processGroupId;
    if (processGroupId !== undefined) {
      for (const process of snapshot.values()) {
        if (process.pid !== rootPid && process.groupId === processGroupId) {
          descendantsByIdentity.set(
            `${process.pid}:${process.identity ?? process.command}`,
            process,
          );
        }
      }
    }
    const descendants = [...descendantsByIdentity.values()];
    return {
      ...(root !== undefined ? { root } : {}),
      descendants,
      captureComplete:
        descendantResult.complete &&
        (processGroupId === undefined || root === undefined || root.groupId === processGroupId) &&
        (root === undefined || root.identity !== undefined) &&
        descendants.every((descendant) => descendant.identity !== undefined),
    };
  };

  const inspectFromSnapshot = (
    tree: CapturedProcessTree,
    currentProcesses: ProcessSnapshotMap | null,
  ): CapturedProcessTreeInspection => {
    if (tree.descendants.length === 0) {
      return { verified: true, survivors: [] };
    }
    if (currentProcesses === null) {
      return { verified: false, survivors: [...tree.descendants] };
    }
    return {
      verified: true,
      survivors: tree.descendants.filter((descendant) =>
        Boolean(matchingCapturedProcessInstance(descendant, currentProcesses)),
      ),
    };
  };

  type SignalInput = Parameters<ProcessTreeKiller["signal"]>[0];

  const validationPidsForSignal = ({
    rootPid,
    signal,
    tree,
    includeRootTree = true,
  }: SignalInput): number[] => [
    ...tree.descendants
      .filter((descendant) => signal === "SIGKILL" || descendant.identity !== undefined)
      .map((descendant) => descendant.pid),
    ...(includeRootTree && tree.root?.identity !== undefined ? [rootPid] : []),
  ];

  const signalCapturedProcessesFromSnapshot = (
    { signal, tree, includeRootTree = true, onError }: SignalInput,
    currentProcesses: ProcessSnapshotMap | null,
  ): boolean => {
    const capturedProcesses = capturedProcessesForSignal(
      tree.descendants,
      signal,
      currentProcesses,
    );
    for (const descendant of capturedProcesses.toReversed()) {
      const error = deps.signalPid(descendant.pid, signal);
      if (error) {
        onError(error, { pid: descendant.pid, source: "captured" });
      }
    }
    const shouldSignalRootTree =
      includeRootTree &&
      tree.root?.identity !== undefined &&
      shouldSignalCapturedProcess(tree.root, signal, currentProcesses);
    return shouldSignalRootTree;
  };

  const signalRootTree = (input: SignalInput, onComplete: () => void): void => {
    deps.signalTree(input.rootPid, input.signal, (error) => {
      if (error) {
        input.onError(error, { pid: input.rootPid, source: "tree-kill" });
      }
      onComplete();
    });
  };

  return {
    capture: (rootPid, options) =>
      captureFromSnapshot(rootPid, options, deps.captureProcessSnapshot()),
    captureAsync: async (rootPid, options) =>
      captureFromSnapshot(rootPid, options, await deps.captureProcessSnapshotAsync()),
    inspect: (tree) =>
      inspectFromSnapshot(
        tree,
        deps.readCurrentProcesses(tree.descendants.map((descendant) => descendant.pid)),
      ),
    inspectAsync: async (tree) =>
      tree.descendants.length === 0
        ? { verified: true, survivors: [] }
        : inspectFromSnapshot(tree, await deps.captureProcessSnapshotAsync()),
    signal: (input) => {
      const validationPids = validationPidsForSignal(input);
      const currentProcesses =
        validationPids.length > 0 ? deps.readCurrentProcesses(validationPids) : null;
      if (signalCapturedProcessesFromSnapshot(input, currentProcesses)) {
        signalRootTree(input, () => undefined);
      }
    },
    signalAsync: async (input) => {
      const validationPids = validationPidsForSignal(input);
      const currentProcesses =
        validationPids.length === 0
          ? null
          : selectCurrentProcesses(validationPids, await deps.captureProcessSnapshotAsync());
      if (signalCapturedProcessesFromSnapshot(input, currentProcesses)) {
        await new Promise<void>((resolve) => signalRootTree(input, resolve));
      }
    },
  };
}

export const defaultProcessTreeKiller: ProcessTreeKiller = createProcessTreeKiller();
