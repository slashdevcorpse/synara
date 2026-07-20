// FILE: processTree.ts
// Purpose: Closes Playwright Electron applications and force-terminates their descendants.

import { spawnSync } from "node:child_process";
import type { ElectronApplication } from "@playwright/test";
import { killWindowsProcessTree } from "../../scripts/smoke-test-lifecycle.mjs";

const GRACEFUL_CLOSE_TIMEOUT_MS = 15_000;
const FORCE_KILL_TIMEOUT_MS = 5_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return !processIsAlive(pid);
}

function collectDescendants(rootPid: number, processRows: ReadonlyArray<readonly [number, number]>): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const [pid, parentPid] of processRows) {
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const descendants: number[] = [];
  const visit = (parentPid: number): void => {
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      visit(childPid);
      descendants.push(childPid);
    }
  };
  visit(rootPid);
  return descendants;
}

function readPosixDescendants(rootPid: number): number[] {
  const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  const processRows: Array<readonly [number, number]> = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    processRows.push([pid, parentPid]);
  }
  return collectDescendants(rootPid, processRows);
}

function readWindowsDescendants(rootPid: number): number[] {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  try {
    const parsed = JSON.parse(result.stdout) as
      | { ProcessId?: unknown; ParentProcessId?: unknown }
      | Array<{ ProcessId?: unknown; ParentProcessId?: unknown }>;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return collectDescendants(
      rootPid,
      entries.flatMap((entry) =>
        typeof entry.ProcessId === "number" && typeof entry.ParentProcessId === "number"
          ? [[entry.ProcessId, entry.ParentProcessId] as const]
          : [],
      ),
    );
  } catch {
    return [];
  }
}

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
  if (!processIsAlive(pid)) return;
  try {
    process.kill(pid, signal);
  } catch {
    // The process may exit between the liveness check and the signal.
  }
}

async function terminateTrackedProcesses(
  rootPid: number,
  initiallyTrackedDescendants: readonly number[],
): Promise<void> {
  const lateDescendants =
    process.platform === "win32"
      ? readWindowsDescendants(rootPid)
      : readPosixDescendants(rootPid);
  const allTrackedPids = [
    ...new Set([...initiallyTrackedDescendants, ...lateDescendants, rootPid]),
  ];
  const teardownDiagnostics: string[] = [];
  if (process.platform === "win32") {
    if (processIsAlive(rootPid)) {
      const result = await killWindowsProcessTree(rootPid, {
        timeoutMs: FORCE_KILL_TIMEOUT_MS,
      });
      if (!result.ok && result.diagnostic) teardownDiagnostics.push(result.diagnostic);
    }
    await waitForExit(rootPid, FORCE_KILL_TIMEOUT_MS);
    for (const pid of allTrackedPids) signalIfAlive(pid, "SIGKILL");
  } else {
    for (const pid of allTrackedPids) signalIfAlive(pid, "SIGTERM");
    const gracefulDeadline = Date.now() + 2_000;
    while (Date.now() < gracefulDeadline && allTrackedPids.some(processIsAlive)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    for (const pid of allTrackedPids) signalIfAlive(pid, "SIGKILL");
  }

  await Promise.all(allTrackedPids.map((pid) => waitForExit(pid, FORCE_KILL_TIMEOUT_MS)));
  const survivors = allTrackedPids.filter(processIsAlive);
  if (survivors.length > 0) {
    throw new Error(
      [
        `Desktop process-tree teardown left surviving pids: ${survivors.join(", ")}.`,
        ...teardownDiagnostics,
      ].join(" "),
    );
  }
}

export async function closeElectronApplication(electronApp: ElectronApplication): Promise<void> {
  const pid = electronApp.process().pid;
  const trackedDescendants =
    pid === undefined
      ? []
      : process.platform === "win32"
        ? readWindowsDescendants(pid)
        : readPosixDescendants(pid);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      electronApp.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out while closing the Electron application.")),
          GRACEFUL_CLOSE_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (pid !== undefined) await terminateTrackedProcesses(pid, trackedDescendants);
  }
}
