import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { superviseWindowsJobNodeProcess } from "./windowsJobProcessSupervisor.ts";
import {
  prepareResolvedWindowsProviderProcess,
  prepareWindowsProviderProcess,
  resolveWindowsJobLauncherPath,
} from "./windowsProviderProcess.ts";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const helperControlFiles = new Set<string>();

function helperArgs(target: string, args: ReadonlyArray<string>): string[] {
  const controlFilePath = join(
    tmpdir(),
    `synara-job-native-test-${process.pid}-${Math.random()}.signal`,
  );
  helperControlFiles.add(controlFilePath);
  return [
    "--protocol",
    "2",
    "--argument-mode",
    "argv",
    "--control-file",
    controlFilePath,
    "--",
    target,
    ...args,
  ];
}

function proveSynchronousHelperDrain(args: ReadonlyArray<string>): void {
  const controlFilePath = args[5];
  if (!controlFilePath) throw new Error("missing helper control file path");
  expect(readFileSync(`${controlFilePath}.drained`, "utf8")).toBe("drained\n");
  rmSync(controlFilePath, { force: true });
  rmSync(`${controlFilePath}.drained`, { force: true });
  helperControlFiles.delete(controlFilePath);
}

afterEach(() => {
  for (const controlFilePath of helperControlFiles) {
    rmSync(controlFilePath, { force: true });
    rmSync(`${controlFilePath}.drained`, { force: true });
    rmSync(`${controlFilePath}.drained.tmp`, { force: true });
  }
  helperControlFiles.clear();
});

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

async function cleanupTestDirectory(directory: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await delay(25);
    }
  }
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

async function readFirstLine(process: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error("provider output timed out")), 5_000);
    const finish = (operation: () => void) => {
      clearTimeout(timeout);
      operation();
    };
    process.once("error", (error) => finish(() => reject(error)));
    process.stderr?.on("data", (chunk) => {
      const value = String(chunk).trim();
      if (value) finish(() => reject(new Error(value)));
    });
    process.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline >= 0) finish(() => resolve(stdout.slice(0, newline)));
    });
  });
}

function spawnPreparedJobProcess(script: string) {
  const prepared = prepareResolvedWindowsProviderProcess(process.execPath, ["-e", script]);
  const child = spawn(prepared.command, prepared.args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: prepared.shell,
    windowsHide: true,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
  return { child, supervisor: superviseWindowsJobNodeProcess(prepared, child) };
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

    const args = helperArgs(process.execPath, ["-e", script]);
    const result = spawnSync(helper, args, {
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
    proveSynchronousHelperDrain(args);
  });

  it("preserves npm's nested prefix probe through the native Job launcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-job-npm-prefix-"));
    const nodeDirectory = join(root, "Program Files", "nodejs");
    const nodePath = join(nodeDirectory, "node.exe");
    const npmPrefixScriptPath = join(
      nodeDirectory,
      "node_modules",
      "npm",
      "bin",
      "npm-prefix.js",
    );
    const npmCommandPath = join(nodeDirectory, "npm.cmd");
    const expectedPrefix = join(root, "User Data", "npm");

    try {
      mkdirSync(dirname(npmPrefixScriptPath), { recursive: true });
      copyFileSync(process.execPath, nodePath);
      writeFileSync(
        npmPrefixScriptPath,
        'process.stdout.write(`${process.env.SYNARA_EXPECTED_NPM_PREFIX}\\n`);\n',
      );
      writeFileSync(
        npmCommandPath,
        [
          "@ECHO OFF",
          "SETLOCAL",
          'SET "NODE_EXE=%~dp0node.exe"',
          'SET "NPM_PREFIX_JS=%~dp0node_modules\\npm\\bin\\npm-prefix.js"',
          'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
          '  SET "NPM_PREFIX=%%F"',
          ")",
          "IF NOT DEFINED NPM_PREFIX EXIT /B 41",
          "ECHO %NPM_PREFIX%",
          "",
        ].join("\r\n"),
      );
      const env = { ...process.env, SYNARA_EXPECTED_NPM_PREFIX: expectedPrefix };
      const prepared = prepareWindowsProviderProcess(npmCommandPath, [], { env });
      const result = spawnSync(prepared.command, prepared.args, {
        encoding: "utf8",
        env,
        shell: prepared.shell,
        windowsHide: true,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(expectedPrefix);
      proveSynchronousHelperDrain(prepared.args);
    } finally {
      await cleanupTestDirectory(root);
    }
  });

  it("closes the Job and kills a surviving nested descendant when the provider root exits", async () => {
    const helper = resolveWindowsJobLauncherPath();
    const rootScript = [
      "const { spawn } = require('node:child_process')",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })",
      "process.stdout.write(String(descendant.pid))",
      "descendant.unref()",
    ].join(";");

    const args = helperArgs(process.execPath, ["-e", rootScript]);
    const result = spawnSync(helper, args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(await waitForProcessExit(descendantPid)).toBe(true);
    proveSynchronousHelperDrain(args);
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
    const args = helperArgs(process.execPath, ["-e", "process.exit(0)"]);
    const result = spawnSync(helper, args, { stdio: "ignore", windowsHide: true });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    proveSynchronousHelperDrain(args);
  });

  it("launches successfully with mixed piped and ignored helper stdio", () => {
    const helper = resolveWindowsJobLauncherPath();
    const args = helperArgs(process.execPath, ["-e", "process.stdout.write('mixed-stdio')"]);
    const result = spawnSync(helper, args, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("mixed-stdio");
    proveSynchronousHelperDrain(args);
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

  it.each([
    { mode: "forced stop", keepRootAlive: true },
    { mode: "natural root exit", keepRootAlive: false },
  ])(
    "releases a descendant-mapped CLI file before $mode proof resolves",
    async ({ keepRootAlive }) => {
      const directory = mkdtempSync(join(tmpdir(), "synara-job-lock-proof-"));
      const heldExecutable = join(directory, "held-provider.exe");
      const renamedExecutable = join(directory, "replaceable-provider.exe");
      const commandShell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
      copyFileSync(commandShell, heldExecutable);
      const script = [
        "const { spawn } = require('node:child_process')",
        `const descendant = spawn(${JSON.stringify(heldExecutable)}, ['/d', '/s', '/c', 'echo ready & ping.exe -t 127.0.0.1 >nul'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })`,
        "descendant.stdout.once('data', () => {",
        "  descendant.stdout.destroy()",
        "  descendant.unref()",
        "  process.stdout.write(String(descendant.pid) + '\\n')",
        "})",
        ...(keepRootAlive ? ["setInterval(() => {}, 1000)"] : []),
      ].join(";");
      const { child, supervisor } = spawnPreparedJobProcess(script);
      try {
        const descendantPid = Number.parseInt(await readFirstLine(child), 10);
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        if (keepRootAlive) {
          await supervisor.teardown();
        } else {
          await supervisor.proveExit();
        }

        // This is the API boundary promised to CLI updates: when proof resolves, Windows must no
        // longer hold the old executable image, so atomic replacement can proceed immediately.
        renameSync(heldExecutable, renamedExecutable);
        rmSync(renamedExecutable);
        expect(await waitForProcessExit(descendantPid)).toBe(true);
      } finally {
        await supervisor.teardown().catch(() => undefined);
        await cleanupTestDirectory(directory);
      }
    },
  );
});
