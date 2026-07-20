import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { resolveWindowsJobLauncherPath } from "./windowsProviderProcess.ts";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

function helperArgs(target: string, args: ReadonlyArray<string>): string[] {
  return ["--protocol", "1", "--argument-mode", "argv", "--", target, ...args];
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
      if (!helperProcess.kill("SIGKILL")) {
        fail(
          new Error(
            `Helper process ${helperProcess.pid ?? "unknown"} rejected the SIGKILL cleanup signal.`,
          ),
        );
      }
    } catch (cause) {
      fail(
        new Error(`Failed to send SIGKILL to helper process ${helperProcess.pid ?? "unknown"}.`, {
          cause,
        }),
      );
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

  it("closes the Job and kills a surviving nested descendant when the provider root exits", async () => {
    const helper = resolveWindowsJobLauncherPath();
    const rootScript = [
      "const { spawn } = require('node:child_process')",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })",
      "process.stdout.write(String(descendant.pid))",
      "descendant.unref()",
    ].join(";");

    const result = spawnSync(helper, helperArgs(process.execPath, ["-e", rootScript]), {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(await waitForProcessExit(descendantPid)).toBe(true);
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

  it("returns a stable target error for a missing executable", () => {
    const helper = resolveWindowsJobLauncherPath();
    const result = spawnSync(helper, helperArgs("C:\\definitely-missing-synara-provider.exe", []), {
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status).toBe(241);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[synara-windows-job-launcher] stage=target");
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
    const line = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => reject(new Error("provider pid output timed out")), 5_000);
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
    const [rootPid, descendantPid] = line.split(",").map((value) => Number.parseInt(value, 10));
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
  });
});
