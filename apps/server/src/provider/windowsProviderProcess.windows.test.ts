import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { teardownChildProcessTree } from "./supervisedProcessTeardown.ts";
import {
  markWindowsProviderProcessSpawn,
  resolveWindowsJobLauncherPath,
  type WindowsProviderProcessCommand,
} from "./windowsProviderProcess.ts";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

interface CompletionReceiptOptions {
  readonly path: string;
  readonly token: string;
}

function helperArgs(
  target: string,
  args: ReadonlyArray<string>,
  completionReceipt?: CompletionReceiptOptions,
  jobName?: string,
  terminationEventName?: string,
): string[] {
  const resolvedTerminationEventName = completionReceipt
    ? (terminationEventName ?? `Synara.Termination.${randomUUID()}`)
    : undefined;
  return [
    "--protocol",
    "2",
    "--argument-mode",
    "argv",
    ...(jobName ? ["--job-name", jobName] : []),
    ...(resolvedTerminationEventName ? ["--termination-event", resolvedTerminationEventName] : []),
    ...(completionReceipt
      ? ["--completion-receipt", completionReceipt.path, "--receipt-token", completionReceipt.token]
      : []),
    "--",
    target,
    ...args,
  ];
}

function completionReceiptContents(token: string, launcherPid: number | undefined): string {
  if (launcherPid === undefined || !Number.isSafeInteger(launcherPid) || launcherPid <= 0) {
    throw new Error(`expected a positive launcher pid, received: ${String(launcherPid)}`);
  }
  return `${token}\n${launcherPid}\n`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(25);
  }
  return !isProcessAlive(pid);
}

async function forceKillHelperAndWaitForExit(
  helperProcess: ChildProcess,
  timeoutMs = 5_000,
): Promise<void> {
  if (helperProcess.exitCode !== null || helperProcess.signalCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      helperProcess.removeListener("exit", onExit);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    helperProcess.once("exit", onExit);
    timer = setTimeout(() => {
      fail(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for helper process ${helperProcess.pid ?? "unknown"} to exit after SIGKILL.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    try {
      // A concurrent natural exit can make kill return false after the exit
      // listener is installed. In either case the listener/timer below is the
      // authoritative cleanup proof.
      helperProcess.kill("SIGKILL");
    } catch (cause) {
      fail(
        new Error(`Failed to send SIGKILL to helper process ${helperProcess.pid ?? "unknown"}.`, {
          cause,
        }),
      );
    }
  });
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };

    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for child process ${child.pid ?? "unknown"} to exit.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    if (child.exitCode !== null || child.signalCode !== null) {
      cleanup();
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

describeWindows("Windows Job launcher native integration", () => {
  it("relays stdio, cwd, environment, and the exact child exit code", () => {
    const helper = resolveWindowsJobLauncherPath();
    const cwd = process.cwd();
    const script = [
      "process.stdin.setEncoding('utf8')",
      "let input = ''",
      "process.stdin.on('data', chunk => { input += chunk })",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ input, cwd: process.cwd(), value: process.env.SYNARA_JOB_TEST }))",
      "  process.stderr.write('native-stderr')",
      "  process.exit(37)",
      "})",
    ].join(";");

    const result = spawnSync(helper, helperArgs(process.execPath, ["-e", script]), {
      cwd,
      env: { ...process.env, SYNARA_JOB_TEST: "preserved" },
      input: "provider-stdin",
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(37);
    expect(result.stderr).toBe("native-stderr");
    expect(JSON.parse(result.stdout)).toEqual({
      input: "provider-stdin",
      cwd,
      value: "preserved",
    });
  });

  it("writes completion proof and exits only after a surviving descendant is gone", () => {
    const helper = resolveWindowsJobLauncherPath();
    const receiptDirectory = mkdtempSync(path.join(tmpdir(), "synara-job-receipt-"));
    const receiptPath = path.join(receiptDirectory, "completion.receipt");
    const receiptToken = "native-job-proof-token";
    const rootScript = [
      "const { spawn } = require('node:child_process')",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })",
      "process.stdout.write(String(descendant.pid))",
      "descendant.unref()",
    ].join(";");

    try {
      const result = spawnSync(
        helper,
        helperArgs(process.execPath, ["-e", rootScript], {
          path: receiptPath,
          token: receiptToken,
        }),
        {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const descendantPid = Number.parseInt(result.stdout.trim(), 10);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(isProcessAlive(descendantPid)).toBe(false);
      expect(readFileSync(receiptPath, "utf8")).toBe(
        completionReceiptContents(receiptToken, result.pid),
      );
    } finally {
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("ignores nested-Job zero notifications while outer-only processes remain", () => {
    const helper = resolveWindowsJobLauncherPath();
    const receiptDirectory = mkdtempSync(path.join(tmpdir(), "synara-job-receipt-"));
    const receiptPath = path.join(receiptDirectory, "nested-job.receipt");
    const receiptToken = "nested-job-outer-accounting-proof";
    const coordinatorScript = [
      "const { spawn, spawnSync } = require('node:child_process')",
      `const helper = ${JSON.stringify(helper)}`,
      "const survivors = Array.from({ length: 12 }, () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }))",
      "for (const survivor of survivors) survivor.unref()",
      "const inner = spawnSync(helper, ['--protocol', '2', '--argument-mode', 'argv', '--', process.execPath, '-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true, timeout: 40000 })",
      "if (inner.error || inner.status !== 0) { process.stderr.write(String(inner.error || `inner status ${inner.status}`)); process.exit(91) }",
      "process.stdout.write(JSON.stringify(survivors.map(survivor => survivor.pid)))",
    ].join(";");

    try {
      const result = spawnSync(
        helper,
        helperArgs(
          process.execPath,
          ["-e", coordinatorScript],
          { path: receiptPath, token: receiptToken },
          `Synara.Test.${randomUUID()}`,
        ),
        { encoding: "utf8", timeout: 75_000, windowsHide: true },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const survivorPids = JSON.parse(result.stdout) as number[];
      expect(survivorPids).toHaveLength(12);
      expect(survivorPids.every((pid) => Number.isSafeInteger(pid))).toBe(true);
      expect(survivorPids.every((pid) => !isProcessAlive(pid))).toBe(true);
      expect(readFileSync(receiptPath, "utf8")).toBe(
        completionReceiptContents(receiptToken, result.pid),
      );
    } finally {
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("drains completion notifications during sustained child-process churn", () => {
    const helper = resolveWindowsJobLauncherPath();
    const receiptDirectory = mkdtempSync(path.join(tmpdir(), "synara-job-receipt-"));
    const receiptPath = path.join(receiptDirectory, "process-churn.receipt");
    const receiptToken = "live-completion-drain-proof";
    const churnScript = [
      "const { spawn } = require('node:child_process')",
      "const command = process.env.ComSpec",
      "if (!command) throw new Error('ComSpec is unavailable')",
      "const launch = () => new Promise((resolve, reject) => { const child = spawn(command, ['/d', '/s', '/c', 'exit 0'], { stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`))) })",
      "void (async () => { for (let batch = 0; batch < 8; batch += 1) await Promise.all(Array.from({ length: 16 }, launch)); process.stdout.write('churn-complete') })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1 })",
    ].join(";");

    try {
      const result = spawnSync(
        helper,
        helperArgs(
          process.execPath,
          ["-e", churnScript],
          { path: receiptPath, token: receiptToken },
          `Synara.Test.${randomUUID()}`,
        ),
        { encoding: "utf8", timeout: 75_000, windowsHide: true },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("churn-complete");
      expect(readFileSync(receiptPath, "utf8")).toBe(
        completionReceiptContents(receiptToken, result.pid),
      );
    } finally {
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("fails with a stable error rather than replacing an existing completion receipt", () => {
    const helper = resolveWindowsJobLauncherPath();
    const receiptDirectory = mkdtempSync(path.join(tmpdir(), "synara-job-receipt-"));
    const receiptPath = path.join(receiptDirectory, "completion.receipt");
    writeFileSync(receiptPath, "occupied\n", "utf8");

    try {
      const result = spawnSync(
        helper,
        helperArgs(process.execPath, ["-e", "process.exit(0)"], {
          path: receiptPath,
          token: "must-not-replace",
        }),
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(248);
      expect(result.stderr).toContain("[synara-windows-job-launcher] stage=completion-receipt");
      expect(readFileSync(receiptPath, "utf8")).toBe("occupied\n");
    } finally {
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("terminates only through the owner's event and rejects named-Job reuse", async () => {
    const helper = resolveWindowsJobLauncherPath();
    const receiptDirectory = mkdtempSync(path.join(tmpdir(), "synara-job-receipt-"));
    const ownerReceipt = {
      path: path.join(receiptDirectory, "owner.receipt"),
      token: "named-job-owner-proof",
    };
    const collisionReceipt = {
      path: path.join(receiptDirectory, "collision.receipt"),
      token: "named-job-collision-proof",
    };
    const jobName = `Synara.Test.${randomUUID()}`;
    const ownerTerminationEventName = `Synara.Termination.${randomUUID()}`;
    const collisionTerminationEventName = `Synara.Termination.${randomUUID()}`;
    const rootScript = [
      "const { spawn } = require('node:child_process')",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })",
      "process.stdout.write(`${process.pid},${descendant.pid}\\n`)",
      "setInterval(() => {}, 1000)",
    ].join(";");
    let owner: ChildProcess | undefined;

    try {
      owner = spawn(
        helper,
        helperArgs(
          process.execPath,
          ["-e", rootScript],
          ownerReceipt,
          jobName,
          ownerTerminationEventName,
        ),
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      if (owner.pid === undefined) throw new Error("expected owner launcher pid");
      const line = await new Promise<string>((resolve, reject) => {
        let stdout = "";
        const timeout = setTimeout(
          () => reject(new Error("named provider pid output timed out")),
          5_000,
        );
        owner?.once("error", reject);
        owner?.stderr?.on("data", (chunk) => {
          const value = String(chunk);
          if (value) reject(new Error(value));
        });
        owner?.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
          const newline = stdout.indexOf("\n");
          if (newline >= 0) {
            clearTimeout(timeout);
            resolve(stdout.slice(0, newline));
          }
        });
      });
      const [rootPid, descendantPid] = line.split(",").map((value) => Number.parseInt(value, 10));
      expect(Number.isSafeInteger(rootPid)).toBe(true);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);

      const collision = spawnSync(
        helper,
        helperArgs(
          process.execPath,
          ["-e", "process.exit(0)"],
          collisionReceipt,
          jobName,
          collisionTerminationEventName,
        ),
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      );
      expect(collision.error).toBeUndefined();
      expect(collision.status).toBe(242);
      expect(collision.stderr).toContain("[synara-windows-job-launcher] stage=create-job");
      expect(readFileSync(collisionReceipt.path, "utf8")).toBe(
        completionReceiptContents(collisionReceipt.token, collision.pid),
      );

      const collisionController = spawnSync(
        helper,
        [
          "--protocol",
          "2",
          "--signal-termination-event",
          collisionTerminationEventName,
          "--launcher-pid",
          String(collision.pid),
        ],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      );
      expect(collisionController.error).toBeUndefined();
      expect(collisionController.status).toBe(0);
      expect(collisionController.stderr).toBe("");
      expect(rootPid === undefined ? false : isProcessAlive(rootPid)).toBe(true);
      expect(descendantPid === undefined ? false : isProcessAlive(descendantPid)).toBe(true);

      const controller = spawnSync(
        helper,
        [
          "--protocol",
          "2",
          "--signal-termination-event",
          ownerTerminationEventName,
          "--launcher-pid",
          String(owner.pid),
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        },
      );
      expect(controller.error).toBeUndefined();
      expect(controller.status).toBe(0);
      expect(controller.stderr).toBe("");

      const ownerExit = await waitForChildExit(owner);
      expect(ownerExit).toEqual({ code: 1223, signal: null });
      expect(rootPid === undefined ? false : await waitForProcessExit(rootPid)).toBe(true);
      expect(descendantPid === undefined ? false : await waitForProcessExit(descendantPid)).toBe(
        true,
      );
      expect(readFileSync(ownerReceipt.path, "utf8")).toBe(
        completionReceiptContents(ownerReceipt.token, owner.pid),
      );
    } finally {
      if (owner !== undefined) await forceKillHelperAndWaitForExit(owner);
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("honors an immediate owner-event termination request during startup", async () => {
    const helper = resolveWindowsJobLauncherPath();
    const receiptDirectory = mkdtempSync(path.join(tmpdir(), "synara-job-receipt-"));
    const ownerReceipt = {
      path: path.join(receiptDirectory, "immediate-owner.receipt"),
      token: "immediate-named-job-proof",
    };
    const jobName = `Synara.Test.${randomUUID()}`;
    const ownerTerminationEventName = `Synara.Termination.${randomUUID()}`;
    let owner: ChildProcess | undefined;

    try {
      owner = spawn(
        helper,
        helperArgs(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          ownerReceipt,
          jobName,
          ownerTerminationEventName,
        ),
        { stdio: "ignore", windowsHide: true },
      );
      if (owner.pid === undefined) throw new Error("expected owner launcher pid");
      const ownerExitPromise = waitForChildExit(owner, 35_000);
      const controller = spawnSync(
        helper,
        [
          "--protocol",
          "2",
          "--signal-termination-event",
          ownerTerminationEventName,
          "--launcher-pid",
          String(owner.pid),
        ],
        {
          encoding: "utf8",
          timeout: 35_000,
          windowsHide: true,
        },
      );

      expect(controller.error).toBeUndefined();
      expect(controller.status).toBe(0);
      expect(controller.stderr).toBe("");
      const ownerExit = await ownerExitPromise;
      expect([1223, 246]).toContain(ownerExit.code);
      expect(ownerExit.signal).toBeNull();
      expect(readFileSync(ownerReceipt.path, "utf8")).toBe(
        completionReceiptContents(ownerReceipt.token, owner.pid),
      );
    } finally {
      if (owner !== undefined) await forceKillHelperAndWaitForExit(owner);
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("lets exact launcher exit win a termination-event open race", async () => {
    const helper = resolveWindowsJobLauncherPath();
    const receiptDirectory = mkdtempSync(path.join(tmpdir(), "synara-job-receipt-"));
    const ownerReceipt = {
      path: path.join(receiptDirectory, "natural-exit-race.receipt"),
      token: "natural-exit-race-proof",
    };
    const jobName = `Synara.Test.${randomUUID()}`;
    const ownerTerminationEventName = `Synara.Termination.${randomUUID()}`;
    let owner: ChildProcess | undefined;

    try {
      owner = spawn(
        helper,
        helperArgs(
          process.execPath,
          ["-e", "process.exit(0)"],
          ownerReceipt,
          jobName,
          ownerTerminationEventName,
        ),
        { stdio: "ignore", windowsHide: true },
      );
      if (owner.pid === undefined) throw new Error("expected owner launcher pid");

      const controller = spawnSync(
        helper,
        [
          "--protocol",
          "2",
          "--signal-termination-event",
          ownerTerminationEventName,
          "--launcher-pid",
          String(owner.pid),
        ],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      );
      expect(controller.error).toBeUndefined();
      expect(controller.status).toBe(0);
      expect(controller.stderr).toBe("");

      const ownerExit = await waitForChildExit(owner);
      expect([0, 1223]).toContain(ownerExit.code);
      expect(ownerExit.signal).toBeNull();
      expect(readFileSync(ownerReceipt.path, "utf8")).toBe(
        completionReceiptContents(ownerReceipt.token, owner.pid),
      );
    } finally {
      if (owner !== undefined) await forceKillHelperAndWaitForExit(owner);
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("returns a stable launcher error without starting an invalid request", () => {
    const helper = resolveWindowsJobLauncherPath();
    const result = spawnSync(helper, ["--not-the-protocol"], {
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status).toBe(240);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[synara-windows-job-launcher] stage=protocol");
  });

  it("rejects the obsolete protocol before starting a target", () => {
    const helper = resolveWindowsJobLauncherPath();
    const result = spawnSync(
      helper,
      [
        "--protocol",
        "1",
        "--argument-mode",
        "argv",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { encoding: "utf8", windowsHide: true },
    );

    expect(result.status).toBe(240);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("expected --protocol 2");
  });

  it("tears down the exact marked handle after a proven missing-target exit", async () => {
    const helper = resolveWindowsJobLauncherPath();
    const receiptDirectory = mkdtempSync(path.join(tmpdir(), "synara-job-receipt-"));
    const completionReceipt = {
      path: path.join(receiptDirectory, "missing-target.receipt"),
      token: "missing-target-exact-handle-proof",
    };
    const prepared = {
      command: helper,
      args: helperArgs(
        "C:\\definitely-missing-synara-provider.exe",
        [],
        completionReceipt,
        `Synara.Test.${randomUUID()}`,
      ),
      shell: false,
      windowsHide: true,
      containment: "windows-job-object",
      completionReceipt,
    } satisfies WindowsProviderProcessCommand;
    let child: ChildProcess | undefined;

    try {
      let stderr = "";
      child = markWindowsProviderProcessSpawn(
        spawn(prepared.command, prepared.args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }),
        prepared,
        true,
      );
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      const exit = await waitForChildExit(child);
      expect(exit).toEqual({ code: 241, signal: null });
      expect(stderr).toContain("[synara-windows-job-launcher] stage=target");
      await expect(teardownChildProcessTree(child)).resolves.toEqual({
        escalated: false,
        signalErrors: [],
      });
      expect(existsSync(completionReceipt.path)).toBe(false);
    } finally {
      if (child !== undefined) await forceKillHelperAndWaitForExit(child);
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("launches successfully when all three helper stdio streams are ignored", () => {
    const helper = resolveWindowsJobLauncherPath();
    const result = spawnSync(helper, helperArgs(process.execPath, ["-e", "process.exit(0)"]), {
      stdio: "ignore",
      windowsHide: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it("launches successfully with mixed piped and ignored helper stdio", () => {
    const helper = resolveWindowsJobLauncherPath();
    const result = spawnSync(
      helper,
      helperArgs(process.execPath, ["-e", "process.stdout.write('mixed-stdio')"]),
      {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        windowsHide: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("mixed-stdio");
  });

  it("kills the provider root and nested descendant when the helper is terminated", async () => {
    const helper = resolveWindowsJobLauncherPath();
    const rootScript = [
      "const { spawn } = require('node:child_process')",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })",
      "process.stdout.write(`${process.pid},${descendant.pid}\\n`)",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const helperProcess = spawn(helper, helperArgs(process.execPath, ["-e", rootScript]), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let rootPid: number | undefined;
    let descendantPid: number | undefined;

    try {
      const line = await new Promise<string>((resolve, reject) => {
        let stdout = "";
        const timeout = setTimeout(() => reject(new Error("provider pid output timed out")), 5_000);
        timeout.unref?.();
        helperProcess.once("error", reject);
        helperProcess.stderr?.on("data", (chunk) => {
          const value = String(chunk);
          if (value) reject(new Error(value));
        });
        helperProcess.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
          const newline = stdout.indexOf("\n");
          if (newline >= 0) {
            clearTimeout(timeout);
            resolve(stdout.slice(0, newline));
          }
        });
      });
      [rootPid, descendantPid] = line.split(",").map((value) => Number.parseInt(value, 10));
      if (rootPid === undefined || descendantPid === undefined) {
        throw new Error(`expected provider root and descendant pids, received: ${line}`);
      }
      expect(Number.isSafeInteger(rootPid)).toBe(true);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(isProcessAlive(rootPid)).toBe(true);
      expect(isProcessAlive(descendantPid)).toBe(true);

      await forceKillHelperAndWaitForExit(helperProcess);

      expect(await waitForProcessExit(rootPid)).toBe(true);
      expect(await waitForProcessExit(descendantPid)).toBe(true);
    } finally {
      await forceKillHelperAndWaitForExit(helperProcess);
      if (rootPid !== undefined) await waitForProcessExit(rootPid);
      if (descendantPid !== undefined) await waitForProcessExit(descendantPid);
    }
  });
});
