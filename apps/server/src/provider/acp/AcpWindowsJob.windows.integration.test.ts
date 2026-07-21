import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ensureAcpWindowsJobExecutable, prepareAcpWindowsJobLaunch } from "./AcpWindowsJob.ts";
import { headerOnlyPortableExecutableFixture } from "./AcpWindowsJobTestSupport.ts";

const fixturePath = fileURLToPath(
  new URL("../../../scripts/acp-windows-job-fixture.mjs", import.meta.url),
);
const compilerPath = fileURLToPath(
  new URL("../../../scripts/acp-windows-job.ps1", import.meta.url),
);
const nativeSourcePath = fileURLToPath(
  new URL("../../../scripts/acp-windows-job-native.cs", import.meta.url),
);

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForPromise<T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function markerPid(output: string, marker: string): number | undefined {
  const match = new RegExp(`${marker}:(\\d+)`, "u").exec(output);
  return match ? Number(match[1]) : undefined;
}

describe.skipIf(process.platform !== "win32")("Windows ACP Job Object containment", () => {
  it("repairs an existing corrupt helper-cache executable", async () => {
    const fixtureDirectory = await mkdtemp(Path.join(tmpdir(), "synara-acp-job-repair-"));
    const fixtureCompilerPath = Path.join(fixtureDirectory, "acp-windows-job.ps1");
    const fixtureSourcePath = Path.join(fixtureDirectory, "acp-windows-job-native.cs");
    await copyFile(compilerPath, fixtureCompilerPath);
    const source = await readFile(nativeSourcePath, "utf8");
    await writeFile(fixtureSourcePath, `${source}\n// Cache repair fixture: ${fixtureDirectory}\n`);
    let executablePath: string | undefined;

    try {
      const prepare = () =>
        ensureAcpWindowsJobExecutable({
          env: process.env,
          assets: {
            compilerPath: fixtureCompilerPath,
            nativeSourcePath: fixtureSourcePath,
          },
        });
      executablePath = await prepare();
      await writeFile(executablePath, headerOnlyPortableExecutableFixture());

      expect(await prepare()).toBe(executablePath);
      const repaired = await readFile(executablePath);
      const peOffset = repaired.readUInt32LE(0x3c);
      expect(repaired.subarray(0, 2).toString("ascii")).toBe("MZ");
      expect(repaired.readUInt32LE(peOffset)).toBe(0x0000_4550);
    } finally {
      if (executablePath !== undefined) await rm(executablePath, { force: true });
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  }, 25_000);

  it("kills surviving descendants when the cooperative provider root exits", async () => {
    const launch = await prepareAcpWindowsJobLaunch({
      provider: {
        command: process.execPath,
        args: [fixturePath, "root"],
        shell: false,
        windowsHide: true,
      },
      env: process.env,
    });
    const wrapper: ChildProcess = spawn(launch.command, [...launch.args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    wrapper.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    wrapper.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    const closePromise = once(wrapper, "close") as Promise<[number | null, NodeJS.Signals | null]>;

    try {
      await waitFor(
        () =>
          markerPid(output, "ACP_JOB_ROOT") !== undefined &&
          markerPid(output, "ACP_JOB_CHILD") !== undefined &&
          markerPid(output, "ACP_JOB_GRANDCHILD") !== undefined,
        "the complete owned fixture tree",
      ).catch((error) => {
        throw new Error(`${String(error)}\n${output}`);
      });
      const ownedPids = [
        markerPid(output, "ACP_JOB_ROOT"),
        markerPid(output, "ACP_JOB_CHILD"),
        markerPid(output, "ACP_JOB_GRANDCHILD"),
      ].filter((pid): pid is number => pid !== undefined);
      expect(ownedPids).toHaveLength(3);
      await waitFor(() => !processIsRunning(ownedPids[1]!), "the intermediate child to exit");
      expect(processIsRunning(ownedPids[0]!)).toBe(true);
      expect(processIsRunning(ownedPids[2]!)).toBe(true);

      wrapper.stdin?.end();
      const [code, signal] = await waitForPromise(closePromise, "the Job Object wrapper to close");
      expect(signal).toBeNull();
      expect(code).toBe(137);
      await waitFor(
        () => ownedPids.every((pid) => !processIsRunning(pid)),
        "every Job Object member to exit",
      );
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill();
        await waitForPromise(closePromise, "wrapper cleanup", 5_000).catch(() => undefined);
      }
    }
  }, 25_000);

  it("kills an EOF-ignoring provider tree when its Synara parent dies", async () => {
    const launch = await prepareAcpWindowsJobLaunch({
      provider: {
        command: process.execPath,
        args: [fixturePath, "orphan-root"],
        shell: false,
        windowsHide: true,
      },
      env: process.env,
    });
    const launcher = spawn(
      process.execPath,
      [fixturePath, "launcher", launch.command, launch.args[0]!, launch.args[1]!],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    launcher.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    launcher.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    const exitPromise = once(launcher, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

    try {
      await waitFor(
        () =>
          markerPid(output, "ACP_JOB_WRAPPER") !== undefined &&
          markerPid(output, "ACP_JOB_ROOT") !== undefined &&
          markerPid(output, "ACP_JOB_CHILD") !== undefined &&
          markerPid(output, "ACP_JOB_GRANDCHILD") !== undefined,
        "the parent-death fixture tree",
      ).catch((error) => {
        throw new Error(`${String(error)}\n${output}`);
      });
      const [launcherCode, launcherSignal] = await waitForPromise(
        exitPromise,
        "the launcher parent to exit",
      );
      expect(launcherSignal).toBeNull();
      expect(launcherCode).toBe(0);

      const ownedPids = [
        markerPid(output, "ACP_JOB_WRAPPER"),
        markerPid(output, "ACP_JOB_ROOT"),
        markerPid(output, "ACP_JOB_CHILD"),
        markerPid(output, "ACP_JOB_GRANDCHILD"),
      ].filter((pid): pid is number => pid !== undefined);
      expect(ownedPids).toHaveLength(4);
      await waitFor(
        () => ownedPids.every((pid) => !processIsRunning(pid)),
        "the orphan-resistant Job Object tree to exit",
      );
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
      const wrapperPid = markerPid(output, "ACP_JOB_WRAPPER");
      if (wrapperPid !== undefined && processIsRunning(wrapperPid)) {
        try {
          process.kill(wrapperPid);
        } catch {
          // The parent watcher may have completed between the liveness check and cleanup.
        }
      }
    }
  }, 25_000);
});
