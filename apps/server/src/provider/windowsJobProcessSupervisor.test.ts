import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WindowsSafeProcessCommand } from "@synara/shared/windowsProcess";
import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  finalizeSynchronousWindowsJobExit,
  installPreparedEffectProcessSupervisor,
  installPreparedNodeProcessSupervisor,
  observeNodeProviderProcessSpawn,
  PreparedProcessSupervisorFallbackError,
  supervisePreparedNodeProcess,
  supervisePreparedEffectProcess,
  superviseWindowsJobEffectProcess,
  superviseWindowsJobNodeProcess,
  teardownNodeProviderProcess,
  type SupervisePreparedEffectProcessOptions,
  type WindowsJobEffectProcessHandle,
  WindowsJobProcessExitUnprovenError,
} from "./windowsJobProcessSupervisor.ts";
import {
  containPreparedWindowsProviderProcess,
  isWindowsJobPreparedCommand,
  type WindowsJobPreparedCommand,
  windowsJobControlFilePath,
} from "./windowsProviderProcess.ts";

function jobPreparedCommand(controlDirectory = "C:\\Temp"): WindowsJobPreparedCommand {
  const prepared = containPreparedWindowsProviderProcess(
    { command: "C:\\tools\\provider.exe", args: [], shell: false, windowsHide: true },
    {
      platform: "win32",
      arch: "x64",
      cwd: "C:\\tools",
      controlDirectory,
      launcherPath: "C:\\synara\\synara-windows-job-launcher.exe",
      fileExists: () => true,
    },
  );
  if (!isWindowsJobPreparedCommand(prepared)) {
    throw new Error("Expected the Windows fixture command to be Job-prepared.");
  }
  return prepared;
}

function posixPreparedCommand(): WindowsSafeProcessCommand {
  return { command: "/usr/local/bin/provider", args: [], shell: false };
}

type MutableChildProcess = ChildProcess & { exitCode: number | null };

function nodeChild(pid: number): MutableChildProcess {
  const events = new EventEmitter();
  return Object.assign(events, {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  }) as unknown as MutableChildProcess;
}

describe("Windows Job exact-handle supervision", () => {
  it("rejects an unbranded command before selecting exact supervision", () => {
    expect(() =>
      supervisePreparedEffectProcess(
        { command: "provider", args: [], shell: false, windowsHide: true },
        {
          pid: 10,
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          synaraTerminateExact: () => true,
        },
        { platform: "win32" },
      ),
    ).toThrow("without Job-prepared command provenance");
  });

  it("never falls back to numeric process inspection when the exact hook is missing", () => {
    const capture = vi.fn();
    expect(() =>
      supervisePreparedEffectProcess(
        jobPreparedCommand(),
        {
          pid: 18,
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
        },
        {
          platform: "win32",
          processTreeKiller: {
            capture,
            inspect: () => ({ verified: true, survivors: [] }),
            signal: () => undefined,
          },
        },
      ),
    ).toThrow("missing exact native-handle");
    expect(capture).not.toHaveBeenCalled();
  });

  it("preserves fail-closed error invariants against hostile enumerable cause fields", () => {
    const cause = {
      rootPid: 99_999,
      rootExited: true,
      remainingDescendantPids: [] as number[],
      captureComplete: true,
      name: "ForgedSuccess",
      message: "all processes exited",
      cause: "forged nested cause",
      toString: () => "hostile failure",
    };

    const error = new WindowsJobProcessExitUnprovenError(31, cause);

    expect(error).toMatchObject({
      rootPid: 31,
      rootExited: false,
      remainingDescendantPids: null,
      captureComplete: false,
      name: "WindowsJobProcessExitUnprovenError",
      message: "Windows Job wrapper 31 did not prove complete drain. hostile failure",
    });
    expect(error.cause).toBe(cause);
  });

  it("recovers an exact Effect owner before exposing an injected construction failure", async () => {
    const requestedSupervisorFailure = new Error("injected Effect supervisor failed");
    const capture = vi.fn();
    const verifyExit = vi.fn(async () => undefined);
    const terminateExact = vi.fn(() => true);
    const prepared = jobPreparedCommand();
    const process = {
      pid: 32,
      exitCode: Effect.succeed(0),
      isRunning: Effect.succeed(false),
      synaraTerminateExact: terminateExact,
    };
    const options = {
      platform: "win32" as const,
      processTreeKiller: {
        capture,
        inspect: () => ({ verified: true as const, survivors: [] }),
        signal: () => undefined,
      },
      verifyExit,
    };
    const requestedSupervisor = vi.fn(
      (
        receivedPrepared: WindowsSafeProcessCommand,
        receivedProcess: WindowsJobEffectProcessHandle,
        receivedOptions?: SupervisePreparedEffectProcessOptions,
      ) => {
        expect(receivedPrepared).toBe(prepared);
        expect(receivedProcess).toBe(process);
        expect(receivedOptions).toBe(options);
        throw requestedSupervisorFailure;
      },
    );

    const installation = installPreparedEffectProcessSupervisor(
      prepared,
      process,
      options,
      requestedSupervisor,
    );

    expect(installation._tag).toBe("Recovered");
    if (installation._tag !== "Recovered") throw new Error("Expected recovered installation.");
    const publishedOwner = installation.supervisor;
    const surfacedFailure = installation.requestedSupervisorFailure;
    expect(publishedOwner).toBe(installation.supervisor);
    expect(surfacedFailure).toBe(requestedSupervisorFailure);
    await expect(publishedOwner.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(verifyExit).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(terminateExact).not.toHaveBeenCalled();
  });

  it("recovers an exact Node owner with identical prepared-command options", async () => {
    const requestedSupervisorFailure = new Error("injected Node supervisor failed");
    const verifyExit = vi.fn(async () => undefined);
    const prepared = jobPreparedCommand();
    const child = nodeChild(33);
    child.exitCode = 0;
    const options = { platform: "win32" as const, verifyExit };
    const requestedSupervisor = vi.fn(
      (
        receivedPrepared: WindowsSafeProcessCommand,
        receivedProcess: ChildProcess,
        receivedOptions?: SupervisePreparedEffectProcessOptions,
      ) => {
        expect(receivedPrepared).toBe(prepared);
        expect(receivedProcess).toBe(child);
        expect(receivedOptions).toBe(options);
        throw requestedSupervisorFailure;
      },
    );

    const installation = installPreparedNodeProcessSupervisor(
      prepared,
      child,
      options,
      requestedSupervisor,
    );

    expect(installation._tag).toBe("Recovered");
    if (installation._tag !== "Recovered") throw new Error("Expected recovered installation.");
    expect(installation.requestedSupervisorFailure).toBe(requestedSupervisorFailure);
    await expect(installation.supervisor.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(verifyExit).toHaveBeenCalledOnce();
  });

  it("keeps PID-less double failure labeled while proving failed spawn without an unhandled error", async () => {
    const events = new EventEmitter();
    const child = Object.assign(events, {
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => false),
    }) as unknown as MutableChildProcess;
    const spawnOutcome = observeNodeProviderProcessSpawn(child);
    const requestedSupervisorFailure = new Error("injected Node supervisor failed");
    let installationFailure: unknown;

    try {
      installPreparedNodeProcessSupervisor(
        jobPreparedCommand(),
        child,
        { platform: "win32" },
        () => {
          throw requestedSupervisorFailure;
        },
      );
    } catch (cause) {
      installationFailure = cause;
    }

    expect(installationFailure).toBeInstanceOf(PreparedProcessSupervisorFallbackError);
    if (!(installationFailure instanceof PreparedProcessSupervisorFallbackError)) {
      throw new Error("Expected labeled fallback failure.");
    }
    expect(installationFailure.supervisorKind).toBe("Node");
    expect(installationFailure.requestedSupervisorFailure).toBe(requestedSupervisorFailure);
    expect(installationFailure.fallbackSupervisorFailure).toBeInstanceOf(TypeError);
    expect(installationFailure.errors).toEqual([
      requestedSupervisorFailure,
      installationFailure.fallbackSupervisorFailure,
    ]);
    expect(installationFailure.fallbackSupervisorFailure).toMatchObject({
      message: expect.stringContaining("positive integer"),
    });

    const spawnFailure = new Error("spawn provider ENOENT");
    expect(() => events.emit("error", spawnFailure)).not.toThrow();
    await expect(spawnOutcome).resolves.toEqual({
      _tag: "FailedToSpawn",
      cause: spawnFailure,
    });
    expect(events.listenerCount("error")).toBe(0);
    expect(events.listenerCount("close")).toBe(0);
    expect(() => events.emit("close", null, null)).not.toThrow();
  });

  it("settles a PID-less spawn-then-error sequence without waiting for close", async () => {
    const events = new EventEmitter();
    const child = Object.assign(events, {
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => false),
    }) as unknown as MutableChildProcess;
    const spawnOutcome = observeNodeProviderProcessSpawn(child);
    const spawnFailure = new Error("spawn event did not establish a process identity");

    events.emit("spawn");
    expect(() => events.emit("error", spawnFailure)).not.toThrow();

    await expect(spawnOutcome).resolves.toEqual({
      _tag: "FailedToSpawn",
      cause: spawnFailure,
    });
    expect(events.listenerCount("spawn")).toBe(0);
    expect(events.listenerCount("error")).toBe(0);
    expect(events.listenerCount("close")).toBe(0);
  });

  it("uses one exact Effect-handle termination for concurrent teardown callers", async () => {
    const exited = Deferred.makeUnsafe<number>();
    let running = true;
    const terminate = vi.fn(() => true);
    const verifyExit = vi.fn(async () => undefined);
    const requestStop = vi.fn(async () => {
      running = false;
      Deferred.doneUnsafe(exited, Effect.succeed(143));
    });
    const supervisor = superviseWindowsJobEffectProcess(
      jobPreparedCommand(),
      {
        pid: 11,
        exitCode: Deferred.await(exited),
        isRunning: Effect.sync(() => running),
        synaraTerminateExact: terminate,
      },
      { requestStop, verifyExit },
    );

    const [first, second] = await Promise.all([supervisor.teardown(), supervisor.teardown()]);
    expect(first.escalated).toBe(true);
    expect(second.escalated).toBe(true);
    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(verifyExit).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("proves an already-completed nonzero Effect child without terminating it", async () => {
    const terminate = vi.fn(() => true);
    const verifyExit = vi.fn(async () => undefined);
    const supervisor = superviseWindowsJobEffectProcess(
      jobPreparedCommand(),
      {
        pid: 12,
        exitCode: Effect.fail(new Error("exit 7")),
        isRunning: Effect.succeed(false),
        synaraTerminateExact: terminate,
      },
      { verifyExit },
    );

    await expect(supervisor.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    await expect(supervisor.teardown()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(verifyExit).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("bounds a broken Effect liveness watcher", async () => {
    const supervisor = superviseWindowsJobEffectProcess(
      jobPreparedCommand(),
      {
        pid: 15,
        exitCode: Effect.succeed(0),
        isRunning: Effect.never,
        synaraTerminateExact: () => true,
      },
      { exitTimeoutMs: 10 },
    );

    await expect(supervisor.proveExit()).rejects.toThrow("Timed out checking whether");
  });

  it("routes Node kill and teardown through one retained handle", async () => {
    const events = new EventEmitter();
    const rawKill = vi.fn(() => true);
    const verifyExit = vi.fn(async () => undefined);
    const requestStop = vi.fn(async () => {
      child.exitCode = 143;
      events.emit("exit", 143, null);
    });
    const child = Object.assign(events, {
      pid: 13,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: rawKill,
      killed: false,
    }) as unknown as MutableChildProcess;
    const supervisor = superviseWindowsJobNodeProcess(jobPreparedCommand(), child, {
      requestStop,
      verifyExit,
    });

    expect(child.kill()).toBe(true);
    expect(child.killed).toBe(true);
    await expect(supervisor.teardown()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(verifyExit).toHaveBeenCalledTimes(1);
    expect(rawKill).not.toHaveBeenCalled();
  });

  it("preserves Node kill(0) as a retained-wrapper liveness probe", () => {
    const events = new EventEmitter();
    const rawKill = vi.fn(() => true);
    const requestStop = vi.fn(async () => undefined);
    const child = Object.assign(events, {
      pid: 23,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: rawKill,
      killed: false,
    }) as unknown as MutableChildProcess;
    superviseWindowsJobNodeProcess(jobPreparedCommand(), child, { requestStop });

    expect(child.kill(0)).toBe(true);
    expect(rawKill).toHaveBeenCalledOnce();
    expect(rawKill).toHaveBeenCalledWith(0);
    expect(requestStop).not.toHaveBeenCalled();
    expect(child.killed).toBe(false);
  });

  it("does not kill an already-completed nonzero Node child", async () => {
    const events = new EventEmitter();
    const rawKill = vi.fn(() => true);
    const child = Object.assign(events, {
      pid: 14,
      exitCode: 9,
      signalCode: null as NodeJS.Signals | null,
      kill: rawKill,
    }) as unknown as ChildProcess;
    const verifyExit = vi.fn(async () => undefined);
    const supervisor = superviseWindowsJobNodeProcess(jobPreparedCommand(), child, {
      verifyExit,
    });

    await expect(supervisor.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    await expect(supervisor.teardown()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(verifyExit).toHaveBeenCalledTimes(1);
    expect(rawKill).not.toHaveBeenCalled();
  });

  it("permanently rejects Node proof after emergency exact termination", async () => {
    const events = new EventEmitter();
    const rawKill = vi.fn(() => {
      child.exitCode = 143;
      events.emit("exit", 143, null);
      return true;
    });
    const requestStop = vi.fn(async () => {
      throw new Error("control failure");
    });
    const verifyExit = vi.fn(async () => undefined);
    const child = Object.assign(events, {
      pid: 16,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: rawKill,
    }) as unknown as MutableChildProcess;
    const supervisor = superviseWindowsJobNodeProcess(jobPreparedCommand(), child, {
      requestStop,
      verifyExit,
    });

    await expect(supervisor.teardown()).rejects.toThrow("control failure");
    await expect(supervisor.teardown()).rejects.toThrow("permanently unavailable");
    await expect(supervisor.proveExit()).rejects.toThrow("permanently unavailable");
    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(rawKill).toHaveBeenCalledTimes(1);
    expect(verifyExit).not.toHaveBeenCalled();
  });

  it("cleans compromised request and acknowledgement artifacts after accepted termination", async () => {
    const controlDirectory = await mkdtemp(join(tmpdir(), "synara-job-proof-"));
    try {
      const prepared = jobPreparedCommand(controlDirectory);
      const controlFilePath = windowsJobControlFilePath(prepared);
      await Promise.all([
        writeFile(controlFilePath, "stop\n", "utf8"),
        writeFile(`${controlFilePath}.drained`, "drained\n", "utf8"),
        writeFile(`${controlFilePath}.drained.tmp`, "partial", "utf8"),
      ]);
      const events = new EventEmitter();
      const child = Object.assign(events, {
        pid: 26,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => {
          child.exitCode = 143;
          events.emit("exit", 143, null);
          return true;
        },
      }) as unknown as MutableChildProcess;
      const supervisor = superviseWindowsJobNodeProcess(prepared, child, {
        requestStop: async () => {
          throw new Error("control failure");
        },
      });

      await expect(supervisor.teardown()).rejects.toThrow("control failure");
      await expect(access(controlFilePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${controlFilePath}.drained`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${controlFilePath}.drained.tmp`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(supervisor.proveExit()).rejects.toThrow("permanently unavailable");
    } finally {
      await rm(controlDirectory, { force: true, recursive: true });
    }
  });

  it.each(["returns false", "throws"])(
    "retries controlled stop when emergency exact termination %s",
    async (behavior) => {
      const events = new EventEmitter();
      const rawKill = vi.fn(() => {
        if (behavior === "throws") throw new Error("native failure");
        return false;
      });
      const requestStop = vi
        .fn<(path: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("control failure"))
        .mockImplementationOnce(async () => {
          child.exitCode = 143;
          events.emit("exit", 143, null);
        });
      const verifyExit = vi.fn(async () => undefined);
      const child = Object.assign(events, {
        pid: behavior === "throws" ? 25 : 24,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: rawKill,
      }) as unknown as MutableChildProcess;
      const supervisor = superviseWindowsJobNodeProcess(jobPreparedCommand(), child, {
        requestStop,
        verifyExit,
      });

      await expect(supervisor.teardown()).rejects.toThrow("control failure");
      await expect(supervisor.teardown()).resolves.toMatchObject({ escalated: true });
      expect(requestStop).toHaveBeenCalledTimes(2);
      expect(rawKill).toHaveBeenCalledTimes(1);
      expect(verifyExit).toHaveBeenCalledTimes(1);
    },
  );

  it("permanently rejects concurrent Effect proof after emergency exact termination", async () => {
    const exited = Deferred.makeUnsafe<number>();
    let running = true;
    const terminate = vi.fn(() => {
      running = false;
      Deferred.doneUnsafe(exited, Effect.succeed(143));
      return true;
    });
    const requestStop = vi.fn(async () => {
      throw new Error("control failure");
    });
    const verifyExit = vi.fn(async () => undefined);
    const supervisor = superviseWindowsJobEffectProcess(
      jobPreparedCommand(),
      {
        pid: 19,
        exitCode: Deferred.await(exited),
        isRunning: Effect.sync(() => running),
        synaraTerminateExact: terminate,
      },
      { requestStop, verifyExit },
    );
    const proof = expect(supervisor.proveExit()).rejects.toThrow("permanently unavailable");

    await expect(supervisor.teardown()).rejects.toThrow("control failure");
    await proof;
    await expect(supervisor.teardown()).rejects.toThrow("permanently unavailable");
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(verifyExit).not.toHaveBeenCalled();
  });

  it("memoizes drain acknowledgement verification for concurrent proof callers", async () => {
    const verifyExit = vi.fn(async () => undefined);
    const supervisor = superviseWindowsJobEffectProcess(
      jobPreparedCommand(),
      {
        pid: 20,
        exitCode: Effect.succeed(0),
        isRunning: Effect.succeed(false),
        synaraTerminateExact: () => true,
      },
      { verifyExit },
    );

    await Promise.all([supervisor.proveExit(), supervisor.teardown(), supervisor.proveExit()]);
    expect(verifyExit).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing launcher drain acknowledgement", async () => {
    const controlDirectory = await mkdtemp(join(tmpdir(), "synara-job-proof-"));
    try {
      const supervisor = superviseWindowsJobEffectProcess(jobPreparedCommand(controlDirectory), {
        pid: 21,
        exitCode: Effect.succeed(0),
        isRunning: Effect.succeed(false),
        synaraTerminateExact: () => true,
      });

      await expect(supervisor.proveExit()).rejects.toMatchObject({
        cause: { code: "ENOENT" },
      });
    } finally {
      await rm(controlDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a tampered launcher drain acknowledgement", async () => {
    const controlDirectory = await mkdtemp(join(tmpdir(), "synara-job-proof-"));
    try {
      const prepared = jobPreparedCommand(controlDirectory);
      await writeFile(`${windowsJobControlFilePath(prepared)}.drained`, "drained\nspoof", "utf8");
      const supervisor = superviseWindowsJobEffectProcess(prepared, {
        pid: 22,
        exitCode: Effect.succeed(0),
        isRunning: Effect.succeed(false),
        synaraTerminateExact: () => true,
      });

      await expect(supervisor.proveExit()).rejects.toThrow(
        "Invalid Windows Job drain acknowledgement",
      );
    } finally {
      await rm(controlDirectory, { force: true, recursive: true });
    }
  });

  it("validates and cleans synchronous launcher drain proof", async () => {
    const controlDirectory = await mkdtemp(join(tmpdir(), "synara-job-proof-"));
    try {
      const prepared = jobPreparedCommand(controlDirectory);
      const controlFilePath = windowsJobControlFilePath(prepared);
      await writeFile(controlFilePath, "stop\n", "utf8");
      await writeFile(`${controlFilePath}.drained`, "drained\n", "utf8");
      await writeFile(`${controlFilePath}.drained.tmp`, "stale", "utf8");

      expect(() => finalizeSynchronousWindowsJobExit(prepared)).not.toThrow();
      await expect(access(controlFilePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${controlFilePath}.drained`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${controlFilePath}.drained.tmp`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(controlDirectory, { force: true, recursive: true });
    }
  });

  it("cleans synchronous artifacts when required proof is missing", async () => {
    const controlDirectory = await mkdtemp(join(tmpdir(), "synara-job-proof-"));
    try {
      const prepared = jobPreparedCommand(controlDirectory);
      const controlFilePath = windowsJobControlFilePath(prepared);
      await writeFile(controlFilePath, "stop\n", "utf8");
      await writeFile(`${controlFilePath}.drained.tmp`, "partial", "utf8");

      expect(() => finalizeSynchronousWindowsJobExit(prepared)).toThrow();
      await expect(access(controlFilePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${controlFilePath}.drained.tmp`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(controlDirectory, { force: true, recursive: true });
    }
  });

  it("allows an unstarted synchronous failure while still cleaning artifacts", async () => {
    const controlDirectory = await mkdtemp(join(tmpdir(), "synara-job-proof-"));
    try {
      const prepared = jobPreparedCommand(controlDirectory);
      const controlFilePath = windowsJobControlFilePath(prepared);
      await writeFile(controlFilePath, "stop\n", "utf8");
      await writeFile(`${controlFilePath}.drained.tmp`, "partial", "utf8");

      expect(() =>
        finalizeSynchronousWindowsJobExit(prepared, { proofRequired: false }),
      ).not.toThrow();
      await expect(access(controlFilePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${controlFilePath}.drained.tmp`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(controlDirectory, { force: true, recursive: true });
    }
  });

  it("rejects tampered synchronous proof after cleaning every artifact", async () => {
    const controlDirectory = await mkdtemp(join(tmpdir(), "synara-job-proof-"));
    try {
      const prepared = jobPreparedCommand(controlDirectory);
      const controlFilePath = windowsJobControlFilePath(prepared);
      await Promise.all([
        writeFile(controlFilePath, "stop\n", "utf8"),
        writeFile(`${controlFilePath}.drained`, "tampered", "utf8"),
        writeFile(`${controlFilePath}.drained.tmp`, "partial", "utf8"),
      ]);

      expect(() => finalizeSynchronousWindowsJobExit(prepared)).toThrow(
        "Invalid Windows Job drain acknowledgement",
      );
      await expect(access(controlFilePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${controlFilePath}.drained`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${controlFilePath}.drained.tmp`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(controlDirectory, { force: true, recursive: true });
    }
  });

  it("does not double-wrap a Node child registered twice", () => {
    const events = new EventEmitter();
    const child = Object.assign(events, {
      pid: 17,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const first = superviseWindowsJobNodeProcess(jobPreparedCommand(), child);
    const second = superviseWindowsJobNodeProcess(jobPreparedCommand(), child);

    expect(second).toBe(first);
  });

  it("supervises an explicitly detached POSIX process group", async () => {
    const child = nodeChild(61);
    const root = { pid: 61, command: "provider", identity: "61:owned", groupId: 61 };
    const capture = vi.fn(() => ({ root, descendants: [], captureComplete: true }));
    let teardownInput:
      | Parameters<
          NonNullable<
            NonNullable<Parameters<typeof supervisePreparedNodeProcess>[2]>["teardownProcessTree"]
          >
        >[0]
      | undefined;
    const supervisor = supervisePreparedNodeProcess(posixPreparedCommand(), child, {
      platform: "linux",
      ownedProcessGroupId: 61,
      processTreeKiller: {
        capture,
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      teardownProcessTree: async (input) => {
        teardownInput = input;
        child.exitCode = 0;
        child.emit("exit", 0, null);
        await input.rootExited;
        return { escalated: false, signalErrors: [] };
      },
    });

    await expect(supervisor.teardown()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(capture).toHaveBeenCalledWith(61, { processGroupId: 61 });
    expect(teardownInput?.ownedProcessGroupId).toBe(61);
  });

  it("uses a no-group teardown fallback for a non-detached POSIX Codex child", async () => {
    const child = nodeChild(62);
    const fallback = vi.fn(async () => ({ fallback: true }));
    let teardownInput:
      | Parameters<
          NonNullable<
            NonNullable<Parameters<typeof supervisePreparedNodeProcess>[2]>["teardownProcessTree"]
          >
        >[0]
      | undefined;
    supervisePreparedNodeProcess(posixPreparedCommand(), child, {
      platform: "linux",
      teardownProcessTree: async (input) => {
        teardownInput = input;
        child.exitCode = 0;
        child.emit("exit", 0, null);
        await input.rootExited;
        return { escalated: false, signalErrors: [] };
      },
    });

    await expect(teardownNodeProviderProcess(child, fallback)).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(teardownInput?.ownedProcessGroupId).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });
});
