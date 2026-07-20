// FILE: processTree.ts
// Purpose: Closes Playwright Electron applications and force-terminates their descendants.

import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type { ElectronApplication } from "@playwright/test";

const GRACEFUL_CLOSE_TIMEOUT_MS = 30_000;
const FORCE_KILL_TIMEOUT_MS = 5_000;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;
const IDENTITY_POLL_INTERVAL_MS = 250;

export interface ProcessSnapshotRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly identity: string | null;
  readonly commandFingerprint: string | null;
}

export interface TrackedProcess {
  readonly pid: number;
  readonly identity: string;
  readonly commandFingerprint: string;
}

export interface ProcessTreeDependencies {
  readonly platform: NodeJS.Platform;
  readonly readProcessSnapshot: (requestedPids?: readonly number[]) => ProcessSnapshotRow[];
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
}

export type ProcessIdentityState = "same" | "gone" | "reused" | "unknown";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function classifyProcessIdentity(
  expected: TrackedProcess,
  current: ProcessSnapshotRow | undefined,
): ProcessIdentityState {
  if (!current) return "gone";
  if (!current.identity || !current.commandFingerprint) return "unknown";
  if (current.identity !== expected.identity) return "reused";
  return current.commandFingerprint === expected.commandFingerprint ? "same" : "unknown";
}

function processSnapshotFailure(
  command: string,
  result: {
    error?: Error;
    status: number | null;
    signal: NodeJS.Signals | null;
    stderr: string | Buffer | null;
  },
): Error {
  const stderr =
    typeof result.stderr === "string" ? result.stderr.trim() : result.stderr?.toString().trim();
  const details = [
    result.error ? `error=${result.error.message}` : null,
    `status=${String(result.status)}`,
    `signal=${String(result.signal)}`,
    stderr ? `stderr=${stderr.slice(0, 500)}` : null,
  ].filter((value): value is string => value !== null);
  return new Error(`Desktop process snapshot failed (${command}): ${details.join(" ")}.`);
}

function observeCleanProcessExit(child: ChildProcess): {
  promise: Promise<void>;
  dispose: () => void;
} {
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Electron application exited while closing with code=${String(code)} signal=${String(signal)}.`,
        ),
      );
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(
        new Error(
          `Electron application exited before teardown began with code=${String(child.exitCode)} signal=${String(child.signalCode)}.`,
        ),
      );
      return;
    }
    exitListener = settle;
    child.once("exit", exitListener);
  });
  return {
    promise,
    dispose: () => {
      if (exitListener) child.off("exit", exitListener);
    },
  };
}

function trackedProcessFromRow(row: ProcessSnapshotRow, context: string): TrackedProcess {
  if (!row.identity || !row.commandFingerprint) {
    throw new Error(`Desktop process snapshot lacked creation identity for ${context} pid ${row.pid}.`);
  }
  return {
    pid: row.pid,
    identity: row.identity,
    commandFingerprint: row.commandFingerprint,
  };
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function forceTerminateChildHandle(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;

  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;
    const cleanup = (): void => {
      child.off("exit", handleExit);
      if (timeout) clearTimeout(timeout);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleExit = (): void => settle();

    child.once("exit", handleExit);
    if (childHasExited(child)) {
      settle();
      return;
    }
    timeout = setTimeout(() => {
      if (childHasExited(child)) settle();
      else settle(new Error("Timed out while terminating the Electron child handle."));
    }, FORCE_KILL_TIMEOUT_MS);
    timeout.unref();
    try {
      const signalSent = child.kill("SIGKILL");
      if (!signalSent && childHasExited(child)) settle();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH" || childHasExited(child)) {
        settle();
      } else {
        settle(
          new Error(`Failed to terminate the Electron child handle: ${errorMessage(error)}.`),
        );
      }
    }
  });
}

function trackedRootProcess(
  rootPid: number,
  processRows: readonly ProcessSnapshotRow[],
): TrackedProcess {
  const root = processRows.find((row) => row.pid === rootPid);
  if (!root) {
    throw new Error(`Desktop process snapshot did not contain Electron root pid ${rootPid}.`);
  }
  return trackedProcessFromRow(root, "Electron root");
}

type ProcessAncestryState = "valid" | "stale" | "unknown";

export function classifyProcessAncestry(
  parent: Pick<ProcessSnapshotRow, "identity">,
  child: Pick<ProcessSnapshotRow, "identity">,
): ProcessAncestryState {
  if (!parent.identity || !child.identity) return "unknown";
  if (parent.identity.startsWith("windows:") || child.identity.startsWith("windows:")) {
    if (!parent.identity.startsWith("windows:") || !child.identity.startsWith("windows:")) {
      return "unknown";
    }
    return child.identity >= parent.identity ? "valid" : "stale";
  }
  if (parent.identity.startsWith("linux:") || child.identity.startsWith("linux:")) {
    const parentMatch = /^linux:(.+):(\d+)$/u.exec(parent.identity);
    const childMatch = /^linux:(.+):(\d+)$/u.exec(child.identity);
    if (!parentMatch || !childMatch || parentMatch[1] !== childMatch[1]) return "unknown";
    return BigInt(childMatch[2]!) >= BigInt(parentMatch[2]!) ? "valid" : "stale";
  }
  return "valid";
}

interface DescendantCollection {
  readonly processes: TrackedProcess[];
  readonly errors: Error[];
}

export function collectDescendants(
  rootPid: number,
  processRows: readonly ProcessSnapshotRow[],
): DescendantCollection {
  const childrenByParent = new Map<number, ProcessSnapshotRow[]>();
  for (const row of processRows) {
    const { parentPid } = row;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(row);
    childrenByParent.set(parentPid, children);
  }
  const descendants: TrackedProcess[] = [];
  const errors: Error[] = [];
  const root = processRows.find((row) => row.pid === rootPid);
  if (!root) {
    return {
      processes: descendants,
      errors: [new Error(`Desktop process snapshot did not contain root pid ${rootPid}.`)],
    };
  }
  const visiting = new Set<number>([rootPid]);
  const visit = (parent: ProcessSnapshotRow): void => {
    for (const child of childrenByParent.get(parent.pid) ?? []) {
      if (visiting.has(child.pid)) {
        errors.push(
          new Error(`Desktop process snapshot contained a parent cycle at pid ${child.pid}.`),
        );
        continue;
      }
      let trackedChild: TrackedProcess;
      try {
        trackedChild = trackedProcessFromRow(child, "descendant");
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(errorMessage(error)));
        continue;
      }
      const ancestryState = classifyProcessAncestry(parent, child);
      if (ancestryState !== "valid") {
        errors.push(
          new Error(
            ancestryState === "stale"
              ? `Desktop process snapshot linked descendant pid ${child.pid} to a newer parent pid ${parent.pid}.`
              : `Desktop process snapshot could not verify ancestry from pid ${parent.pid} to pid ${child.pid}.`,
          ),
        );
        continue;
      }
      visiting.add(child.pid);
      visit(child);
      visiting.delete(child.pid);
      descendants.push(trackedChild);
    }
  };
  visit(root);
  return { processes: descendants, errors };
}

export function parseLinuxProcessStat(
  pid: number,
  stat: string,
  bootId: string,
): ProcessSnapshotRow {
  const openingParenthesis = stat.indexOf("(");
  const closingParenthesis = stat.lastIndexOf(")");
  const reportedPid = Number(stat.slice(0, openingParenthesis).trim());
  const command = stat.slice(openingParenthesis + 1, closingParenthesis);
  const fields =
    openingParenthesis > 0 && closingParenthesis > openingParenthesis
      ? stat.slice(closingParenthesis + 1).trim().split(/\s+/u)
      : [];
  const parentPid = Number(fields[1]);
  const startTicks = fields[19];
  if (
    reportedPid !== pid ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    !startTicks ||
    !/^\d+$/u.test(startTicks) ||
    !command
  ) {
    throw new Error(`Desktop process snapshot found malformed Linux stat data for pid ${pid}.`);
  }
  return {
    pid,
    parentPid,
    identity: `linux:${bootId}:${startTicks}`,
    commandFingerprint: fingerprint(command),
  };
}

function readLinuxProcessSnapshot(requestedPids?: readonly number[]): ProcessSnapshotRow[] {
  let bootId: string;
  try {
    bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (error) {
    throw new Error(
      `Desktop process snapshot could not read the Linux boot id: ${errorMessage(error)}.`,
    );
  }
  if (!bootId) {
    throw new Error("Desktop process snapshot returned an empty Linux boot id.");
  }

  let processIds: number[];
  if (requestedPids) {
    processIds = [...requestedPids];
  } else {
    try {
      processIds = readdirSync("/proc", { withFileTypes: true }).flatMap((entry) => {
        const pid = Number(entry.name);
        return entry.isDirectory() &&
          /^\d+$/u.test(entry.name) &&
          Number.isSafeInteger(pid) &&
          pid > 0
          ? [pid]
          : [];
      });
    } catch (error) {
      throw new Error(
        `Desktop process snapshot could not enumerate /proc: ${errorMessage(error)}.`,
      );
    }
  }

  const processRows: ProcessSnapshotRow[] = [];
  for (const pid of processIds) {
    try {
      processRows.push(
        parseLinuxProcessStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"), bootId),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        `Desktop process snapshot could not read Linux identity for pid ${pid}: ${errorMessage(error)}.`,
      );
    }
  }
  if (!requestedPids && processRows.length === 0) {
    throw new Error("Desktop process snapshot failed (/proc): no process rows were returned.");
  }
  return processRows;
}

function readPosixProcessSnapshot(requestedPids?: readonly number[]): ProcessSnapshotRow[] {
  if (process.platform === "linux") return readLinuxProcessSnapshot(requestedPids);

  const psArguments = requestedPids
    ? ["-p", requestedPids.join(","), "-o", "pid=,ppid=,lstart=,command="]
    : ["-eo", "pid=,ppid=,lstart=,command="];
  const result = spawnSync("ps", psArguments, {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    timeout: PROCESS_SNAPSHOT_TIMEOUT_MS,
  });
  if (
    result.error ||
    (result.status !== 0 && !(requestedPids && result.status === 1 && !result.stdout?.trim())) ||
    typeof result.stdout !== "string"
  ) {
    throw processSnapshotFailure("ps", result);
  }
  const processRows: ProcessSnapshotRow[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const startedAt = match[3]?.trim();
    const command = match[4]?.trim();
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid)) continue;
    processRows.push({
      pid,
      parentPid,
      identity: startedAt ? `${process.platform}:${startedAt}` : null,
      commandFingerprint: command ? fingerprint(command) : null,
    });
  }
  if (!requestedPids && processRows.length === 0) {
    throw new Error("Desktop process snapshot failed (ps): no process rows were returned.");
  }
  return processRows;
}

function readWindowsProcessSnapshot(requestedPids?: readonly number[]): ProcessSnapshotRow[] {
  const processFilter = requestedPids
    ? ` -Filter '${requestedPids.map((pid) => `ProcessId = ${pid}`).join(" OR ")}'`
    : "";
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process${processFilter} | Select-Object ProcessId,ParentProcessId,@{Name='CreationDateUtc';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('O')} else {$null}}},ExecutablePath,Name | ConvertTo-Json -Compress`,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: PROCESS_SNAPSHOT_TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw processSnapshotFailure("PowerShell Win32_Process", result);
  }
  if (requestedPids && result.stdout.trim() === "") return [];
  try {
    const parsed = JSON.parse(result.stdout) as
      | {
          ProcessId?: unknown;
          ParentProcessId?: unknown;
          CreationDateUtc?: unknown;
          ExecutablePath?: unknown;
          Name?: unknown;
        }
      | Array<{
          ProcessId?: unknown;
          ParentProcessId?: unknown;
          CreationDateUtc?: unknown;
          ExecutablePath?: unknown;
          Name?: unknown;
        }>;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const processRows = entries.flatMap((entry): ProcessSnapshotRow[] => {
      if (
        typeof entry.ProcessId !== "number" ||
        !Number.isSafeInteger(entry.ProcessId) ||
        entry.ProcessId <= 0 ||
        typeof entry.ParentProcessId !== "number" ||
        !Number.isSafeInteger(entry.ParentProcessId)
      ) {
        return [];
      }
      const creationDate =
        typeof entry.CreationDateUtc === "string" ? entry.CreationDateUtc.trim() : "";
      const executablePath =
        typeof entry.ExecutablePath === "string" ? entry.ExecutablePath.toLowerCase() : "";
      const processName = typeof entry.Name === "string" ? entry.Name.toLowerCase() : "";
      const commandIdentity = executablePath || processName;
      return [
        {
          pid: entry.ProcessId,
          parentPid: entry.ParentProcessId,
          identity: creationDate ? `windows:${creationDate}` : null,
          commandFingerprint: commandIdentity ? fingerprint(commandIdentity) : null,
        },
      ];
    });
    if (!requestedPids && processRows.length === 0) {
      throw new Error("no valid process rows were returned");
    }
    return processRows;
  } catch (error) {
    throw new Error(
      `Desktop process snapshot failed (PowerShell Win32_Process JSON): ${errorMessage(error)}.`,
    );
  }
}

function readProcessSnapshot(requestedPids?: readonly number[]): ProcessSnapshotRow[] {
  return process.platform === "win32"
    ? readWindowsProcessSnapshot(requestedPids)
    : readPosixProcessSnapshot(requestedPids);
}

const DEFAULT_PROCESS_TREE_DEPENDENCIES: ProcessTreeDependencies = {
  platform: process.platform,
  readProcessSnapshot,
  signalProcess: (pid, signal) => process.kill(pid, signal),
};

export function mergeTrackedProcesses(
  ...groups: ReadonlyArray<readonly TrackedProcess[]>
): TrackedProcess[] {
  const processesByIdentity = new Map<string, TrackedProcess>();
  for (const processIdentity of groups.flat()) {
    const identityKey = `${processIdentity.pid}:${processIdentity.identity}`;
    if (!processesByIdentity.has(identityKey)) {
      processesByIdentity.set(identityKey, processIdentity);
    }
  }
  return [...processesByIdentity.values()];
}

function matchingTrackedProcesses(
  trackedProcesses: readonly TrackedProcess[],
  processRows: readonly ProcessSnapshotRow[],
  errors: unknown[],
  context: string,
): TrackedProcess[] {
  const processByPid = new Map(processRows.map((row) => [row.pid, row]));
  return trackedProcesses.flatMap((trackedProcess) => {
    const current = processByPid.get(trackedProcess.pid);
    const identityState = classifyProcessIdentity(trackedProcess, current);
    if (identityState === "gone" || identityState === "reused") return [];
    if (identityState === "unknown") {
      errors.push(
        new Error(
          `Desktop process identity could not be confirmed ${context} for pid ${trackedProcess.pid}.`,
        ),
      );
      return [];
    }
    return [trackedProcess];
  });
}

function readMatchingTrackedProcesses(
  trackedProcesses: readonly TrackedProcess[],
  errors: unknown[],
  context: string,
  dependencies: ProcessTreeDependencies,
): TrackedProcess[] {
  try {
    const requestedPids =
      trackedProcesses.length === 1 ? [trackedProcesses[0]!.pid] : undefined;
    return matchingTrackedProcesses(
      trackedProcesses,
      dependencies.readProcessSnapshot(requestedPids),
      errors,
      context,
    );
  } catch (error) {
    errors.push(
      new Error(`Desktop process identity verification failed ${context}: ${errorMessage(error)}.`),
    );
    return [];
  }
}

function signalTrackedProcesses(
  trackedProcesses: readonly TrackedProcess[],
  signal: NodeJS.Signals,
  errors: unknown[],
  context: string,
  dependencies: ProcessTreeDependencies,
): void {
  for (const trackedProcess of trackedProcesses) {
    const matchingProcess = readMatchingTrackedProcesses(
      [trackedProcess],
      errors,
      `${context} for pid ${trackedProcess.pid}`,
      dependencies,
    );
    if (matchingProcess.length === 0) continue;
    try {
      dependencies.signalProcess(trackedProcess.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      errors.push(
        new Error(
          `Failed to signal desktop process ${trackedProcess.pid} with ${signal}: ${errorMessage(error)}.`,
        ),
      );
    }
  }
}

async function waitForTrackedProcessesExit(
  trackedProcesses: readonly TrackedProcess[],
  timeoutMs: number,
  errors: unknown[],
  dependencies: ProcessTreeDependencies,
): Promise<TrackedProcess[]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const errorCount = errors.length;
    const survivors = readMatchingTrackedProcesses(
      trackedProcesses,
      errors,
      "while waiting for process exit",
      dependencies,
    );
    if (errors.length > errorCount || survivors.length === 0 || Date.now() >= deadline) {
      return survivors;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, IDENTITY_POLL_INTERVAL_MS));
  }
}

async function terminateTrackedProcesses(
  rootProcess: TrackedProcess,
  initiallyTrackedDescendants: readonly TrackedProcess[],
  dependencies: ProcessTreeDependencies,
): Promise<void> {
  const errors: unknown[] = [];
  let lateDescendants: TrackedProcess[] = [];
  try {
    const lateSnapshot = dependencies.readProcessSnapshot();
    const lateRoot = lateSnapshot.find((row) => row.pid === rootProcess.pid);
    if (lateRoot?.identity === rootProcess.identity) {
      const matchingRoot = matchingTrackedProcesses(
        [rootProcess],
        lateSnapshot,
        errors,
        "before late descendant collection",
      );
      if (matchingRoot.length === 1) {
        const collected = collectDescendants(rootProcess.pid, lateSnapshot);
        lateDescendants = collected.processes;
        errors.push(...collected.errors);
      }
    } else if (lateRoot && !lateRoot.identity) {
      errors.push(
        new Error(
          `Desktop process identity was unavailable before late descendant collection for pid ${rootProcess.pid}.`,
        ),
      );
    }
  } catch (error) {
    errors.push(error);
  }
  const allTrackedProcesses = mergeTrackedProcesses(
    initiallyTrackedDescendants,
    lateDescendants,
    [rootProcess],
  );
  if (dependencies.platform === "win32") {
    signalTrackedProcesses(
      allTrackedProcesses,
      "SIGKILL",
      errors,
      "immediately before Windows forced termination",
      dependencies,
    );
  } else {
    signalTrackedProcesses(
      allTrackedProcesses,
      "SIGTERM",
      errors,
      "immediately before POSIX graceful termination",
      dependencies,
    );
    const terminateSurvivors = readMatchingTrackedProcesses(
      allTrackedProcesses,
      errors,
      "after POSIX graceful termination",
      dependencies,
    );
    if (terminateSurvivors.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
    signalTrackedProcesses(
      allTrackedProcesses,
      "SIGKILL",
      errors,
      "immediately before POSIX forced termination",
      dependencies,
    );
  }

  const survivors = await waitForTrackedProcessesExit(
    allTrackedProcesses,
    FORCE_KILL_TIMEOUT_MS,
    errors,
    dependencies,
  );
  if (survivors.length > 0) {
    errors.push(
      new Error(
        `Desktop process-tree teardown left surviving pids: ${survivors.map(({ pid }) => pid).join(", ")}.`,
      ),
    );
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Desktop process snapshot and process-tree cleanup failed.");
  }
}

export async function closeElectronApplication(
  electronApp: ElectronApplication,
  dependencies: ProcessTreeDependencies = DEFAULT_PROCESS_TREE_DEPENDENCIES,
): Promise<void> {
  const electronProcess = electronApp.process();
  const errors: unknown[] = [];
  const rootPid =
    typeof electronProcess.pid === "number" &&
    Number.isSafeInteger(electronProcess.pid) &&
    electronProcess.pid > 0
      ? electronProcess.pid
      : null;
  let rootProcess: TrackedProcess | null = null;
  let trackedDescendants: TrackedProcess[] = [];
  if (rootPid === null) {
    errors.push(
      new Error(`Electron application has an invalid process id: ${String(electronProcess.pid)}.`),
    );
  } else {
    try {
      const initialSnapshot = dependencies.readProcessSnapshot();
      rootProcess = trackedRootProcess(rootPid, initialSnapshot);
      const collected = collectDescendants(rootPid, initialSnapshot);
      trackedDescendants = collected.processes;
      errors.push(...collected.errors);
    } catch (error) {
      errors.push(error);
    }
  }
  const cleanProcessExit = observeCleanProcessExit(electronProcess);
  let timeout: NodeJS.Timeout | undefined;
  let playwrightCloseRejected = false;
  let playwrightCloseError: unknown;
  const playwrightClose = electronApp.close().catch((error: unknown) => {
    playwrightCloseRejected = true;
    playwrightCloseError = error;
    console.warn(
      `[desktop-e2e] Playwright close rejected; waiting for the Electron process exit: ${errorMessage(error)}`,
    );
    return new Promise<never>(() => undefined);
  });
  try {
    await Promise.race([
      playwrightClose,
      cleanProcessExit.promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out while closing the Electron application.")),
          GRACEFUL_CLOSE_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } catch (error) {
    errors.push(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    cleanProcessExit.dispose();
  }
  if (rootProcess) {
    try {
      await terminateTrackedProcesses(rootProcess, trackedDescendants, dependencies);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await forceTerminateChildHandle(electronProcess);
  } catch (error) {
    errors.push(error);
  }
  if (playwrightCloseRejected && errors.length > 0) {
    errors.push(playwrightCloseError);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Electron close and process-tree cleanup both failed.");
  }
}
