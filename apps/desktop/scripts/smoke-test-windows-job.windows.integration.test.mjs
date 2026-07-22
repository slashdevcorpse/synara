import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDesktopSmokeEnvironment,
  createDesktopSmokeSpawnSpec,
  DESKTOP_SMOKE_OBSERVATION_MS,
  DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS,
  resolveWindowsPowerShellPath,
  superviseDesktopSmokeProcess,
  WINDOWS_SMOKE_JOB_READY_PREFIX,
  WINDOWS_SMOKE_JOB_RUN_ID_ENV,
  WINDOWS_SMOKE_JOB_TERMINATE_PREFIX,
} from "./smoke-test-lifecycle.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(scriptsDirectory, "smoke-test-windows-job.ps1");

const fixtureSource = String.raw`
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [mode, pidFile, portText] = process.argv.slice(2);
if (pidFile) appendFileSync(pidFile, mode + ":" + process.pid + "\n");
console.log("FIXTURE_ARGV:" + JSON.stringify(process.argv.slice(2)));

if (mode === "root") {
  setTimeout(() => {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "child", pidFile, portText], {
      stdio: "ignore",
      windowsHide: true,
    });
  }, 150);
} else if (mode === "child") {
  setTimeout(() => {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "grandchild", pidFile, portText], {
      stdio: "ignore",
      windowsHide: true,
    });
  }, 150);
} else if (mode === "grandchild") {
  createServer(() => {}).listen(Number(portText), "127.0.0.1");
}

setInterval(() => {}, 1_000);
`;

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a TCP port.");
  }
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function canConnect(port) {
  return await new Promise((resolveConnection) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (connected) => {
      socket.destroy();
      resolveConnection(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function spawnFixture({ fixturePath, arguments: fixtureArguments, workingDirectory, runId }) {
  const spawnSpec = createDesktopSmokeSpawnSpec({
    platform: "win32",
    executable: process.execPath,
    args: [fixturePath, ...fixtureArguments],
    environment: createDesktopSmokeEnvironment(),
    windowsHelperPath: helperPath,
    windowsJobRunId: runId,
    workingDirectory,
  });
  return spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
}

describe.skipIf(process.platform !== "win32")(
  "Windows desktop smoke Job Object integration",
  () => {
    let temporaryDirectory;
    let fixturePath;
    let spawnedChildren;

    beforeEach(async () => {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "synara smoke job path with spaces "));
      fixturePath = join(temporaryDirectory, "fixture with spaces.mjs");
      spawnedChildren = [];
      await writeFile(fixturePath, fixtureSource, "utf8");
    });

    afterEach(async () => {
      for (const child of spawnedChildren) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        try {
          child.stdin?.end();
        } catch {
          // Killing the wrapper below still closes its non-inheritable Job handle.
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // The wrapper may already be exiting after EOF.
        }
        await Promise.race([
          once(child, "close").catch(() => {}),
          new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
        ]);
      }
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    });

    const startFixture = (fixtureArguments = []) => {
      const runId = randomUUID();
      const child = spawnFixture({
        fixturePath,
        arguments: fixtureArguments,
        workingDirectory: temporaryDirectory,
        runId,
      });
      spawnedChildren.push(child);
      return { child, runId };
    };

    it("preserves a one-element argument array through Windows PowerShell 5.1", async () => {
      const { child, runId } = startFixture();
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      const closePromise = once(child, "close");

      await waitFor(
        () => output.includes(WINDOWS_SMOKE_JOB_READY_PREFIX + runId),
        "the wrapper ready marker",
        DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS,
      );
      await waitFor(
        () => output.includes("FIXTURE_ARGV:[]"),
        "the one-element target argv to cross the PowerShell output relay",
      );
      child.stdin.end(WINDOWS_SMOKE_JOB_TERMINATE_PREFIX + runId + "\n");
      const [code, signal] = await closePromise;

      expect({ code, signal }).toEqual({ code: 137, signal: null });
      expect(output).toContain("FIXTURE_ARGV:[]");
      expect(output).not.toContain("SYNARA_SMOKE_JOB_ERROR");
    }, 70_000);

    it("preserves literal -- argv and contains root, child, grandchild, and TCP listener", async () => {
      const pidFile = join(temporaryDirectory, "owned process ids.txt");
      const port = await reservePort();
      const targetArguments = [
        "root",
        pidFile,
        String(port),
        "--",
        "literal value",
        'quoted "value"',
        "trailing space \\",
      ];
      const { child, runId } = startFixture(targetArguments);
      const resultPromise = superviseDesktopSmokeProcess({
        child,
        platform: "win32",
        windowsJobRunId: runId,
        observationMs: DESKTOP_SMOKE_OBSERVATION_MS,
      });

      await waitFor(
        async () => {
          try {
            return (await readFile(pidFile, "utf8")).includes("grandchild:");
          } catch (error) {
            if (error?.code === "ENOENT") return false;
            throw error;
          }
        },
        "the grandchild to start",
        DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS,
      );
      await waitFor(() => canConnect(port), "the grandchild listener");

      const result = await resultPromise;
      expect(result).toMatchObject({ ok: true, failures: [], teardownDiagnostics: [] });
      expect(result.output).toContain(`FIXTURE_ARGV:${JSON.stringify(targetArguments)}`);

      const processIds = (await readFile(pidFile, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => Number(line.split(":")[1]));
      expect(processIds).toHaveLength(3);
      await waitFor(
        () => processIds.every((pid) => !processExists(pid)),
        "all Job-owned PIDs to exit",
      );
      await expect(canConnect(port)).resolves.toBe(false);
    }, 70_000);

    it("treats wrapper stdin EOF as a contained Job shutdown", async () => {
      const pidFile = join(temporaryDirectory, "eof target pid.txt");
      const { child, runId } = startFixture(["hold", pidFile, "0"]);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });

      await waitFor(
        () => output.includes(WINDOWS_SMOKE_JOB_READY_PREFIX + runId),
        "the wrapper ready marker",
        DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS,
      );
      await waitFor(async () => {
        try {
          return (await readFile(pidFile, "utf8")).includes("hold:");
        } catch (error) {
          if (error?.code === "ENOENT") return false;
          throw error;
        }
      }, "the EOF target PID");
      child.stdin.end();
      const [code, signal] = await once(child, "close");

      expect({ code, signal }).toEqual({ code: 137, signal: null });
      expect(output).not.toContain("SYNARA_SMOKE_JOB_ERROR");
      const pid = Number((await readFile(pidFile, "utf8")).trim().split(":")[1]);
      await waitFor(() => !processExists(pid), "the EOF target to be killed by Job teardown");
    }, 70_000);

    it("rejects an existing drive-root-relative target before READY in the helper itself", async () => {
      await access(process.execPath);
      const executableRoot = win32.parse(process.execPath).root;
      expect(executableRoot).toMatch(/^[A-Za-z]:\\$/);
      const rootRelativeExecutable = "\\" + process.execPath.slice(executableRoot.length);
      expect(win32.resolve(dirname(process.execPath), rootRelativeExecutable)).toBe(
        win32.normalize(process.execPath),
      );

      const runId = randomUUID();
      const environment = createDesktopSmokeEnvironment();
      environment[WINDOWS_SMOKE_JOB_RUN_ID_ENV] = runId;
      const child = spawn(
        resolveWindowsPowerShellPath(environment),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helperPath,
          "--",
          rootRelativeExecutable,
          "--version",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          cwd: dirname(process.execPath),
          env: environment,
        },
      );
      spawnedChildren.push(child);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      const [code, signal] = await once(child, "close");

      expect({ code, signal }).toEqual({ code: 70, signal: null });
      expect(output).toContain(
        "SYNARA_SMOKE_JOB_ERROR executable path is not an existing absolute file",
      );
      expect(output).not.toContain(WINDOWS_SMOKE_JOB_READY_PREFIX);
    }, 20_000);

    it("fails initialization before READY when the target executable cannot launch", async () => {
      const runId = randomUUID();
      const missingExecutable = join(temporaryDirectory, "missing target.exe");
      const spawnSpec = createDesktopSmokeSpawnSpec({
        platform: "win32",
        executable: missingExecutable,
        args: [],
        environment: createDesktopSmokeEnvironment(),
        windowsHelperPath: helperPath,
        windowsJobRunId: runId,
        workingDirectory: temporaryDirectory,
      });
      const child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
      spawnedChildren.push(child);

      const result = await superviseDesktopSmokeProcess({
        child,
        platform: "win32",
        windowsJobRunId: runId,
      });

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining("exited before its ready marker"),
          expect.stringContaining("closed before its ready marker"),
          "SYNARA_SMOKE_JOB_ERROR",
        ]),
      );
      expect(result.output).toContain(
        "SYNARA_SMOKE_JOB_ERROR executable path is not an existing absolute file",
      );
    }, 20_000);
  },
);
