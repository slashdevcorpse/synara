import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../Services/PTY";
import { TerminalManagerRuntime, type TerminalSubprocessActivity } from "./Manager";
import type {
  CapturedProcessTree,
  ProcessTreeKiller,
  TerminalKillSignal,
} from "../processTreeKiller";
import type {
  WindowsProcessSnapshotCollector,
  WindowsProcessSnapshotResult,
} from "../windowsProcessSnapshot";
import { Effect, Encoding } from "effect";
import {
  createTerminalHistoryMetadata,
  terminalHistoryMetadataPath,
} from "../terminalHistoryRecord";
import type {
  PosixTerminalShellResolver,
  WindowsExplicitShellChoice,
  WindowsShellSelectionDependencies,
  WindowsTerminalShellResolver,
} from "../windowsShellSelection";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;
  paused = false;

  constructor(readonly pid: number) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private nextPid = 9000;

  constructor(private readonly mode: "sync" | "async" = "sync") {}

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtySpawnError({
            adapter: "fake",
            message: "Failed to spawn PTY process",
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 800): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
  });
}

function pollSubprocessActivity(manager: TerminalManagerRuntime): Promise<void> {
  return (
    manager as unknown as { pollSubprocessActivity: () => Promise<void> }
  ).pollSubprocessActivity();
}

function isSubprocessPollInFlight(manager: TerminalManagerRuntime): boolean {
  return (manager as unknown as { subprocessPollInFlight: boolean }).subprocessPollInFlight;
}

function subprocessState(
  manager: TerminalManagerRuntime,
  threadId = "thread-1",
  terminalId = "default",
): {
  readonly detectedCliKind: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly providerDescendantObserved: boolean;
} {
  const sessions = (
    manager as unknown as {
      sessions: Map<
        string,
        {
          detectedCliKind: string | null;
          hasRunningSubprocess: boolean;
          providerDescendantObserved: boolean;
        }
      >;
    }
  ).sessions;
  const session = sessions.get(`${threadId}\u0000${terminalId}`);
  if (!session) throw new Error(`Missing test terminal session: ${threadId}/${terminalId}`);
  return session;
}

function completeWindowsSnapshot(
  entries: Array<{ ppid: number; pid: number; command: string }>,
): WindowsProcessSnapshotResult {
  const childrenByParentPid = new Map<
    number,
    Array<{ readonly pid: number; readonly command: string }>
  >();
  for (const { ppid, pid, command } of entries) {
    const children = childrenByParentPid.get(ppid) ?? [];
    children.push({ pid, command });
    childrenByParentPid.set(ppid, children);
  }
  return {
    kind: "ok",
    processCount: entries.length,
    childrenByParentPid,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function historyLogName(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`;
}

function historyLogPath(logsDir: string, threadId = "thread-1"): string {
  return path.join(logsDir, historyLogName(threadId));
}

function multiTerminalHistoryLogPath(
  logsDir: string,
  threadId = "thread-1",
  terminalId = "default",
): string {
  return path.join(logsDir, multiTerminalHistoryLogName(threadId, terminalId));
}

describe("TerminalManager", () => {
  const tempDirs: string[] = [];

  type MakeManagerOptions = {
    shellEnvironment?: NodeJS.ProcessEnv;
    windowsShellSelectionDependencies?: WindowsShellSelectionDependencies;
    subprocessChecker?: (terminalPid: number) => Promise<boolean | TerminalSubprocessActivity>;
    subprocessPlatform?: NodeJS.Platform;
    windowsProcessSnapshotCollector?: WindowsProcessSnapshotCollector;
    processTreeKiller?: ProcessTreeKiller;
    subprocessPollIntervalMs?: number;
    processKillGraceMs?: number;
    maxRetainedInactiveSessions?: number;
    ptyAdapter?: FakePtyAdapter;
    prepareLogs?: (logsDir: string) => void;
  } & (
    | {
        shellPlatform: "win32";
        shellResolver?: WindowsTerminalShellResolver;
      }
    | {
        shellPlatform: Exclude<NodeJS.Platform, "win32">;
        shellResolver?: PosixTerminalShellResolver;
      }
    | {
        shellPlatform?: undefined;
        shellResolver?: never;
      }
  );

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeManager(historyLineLimit = 5, options: MakeManagerOptions = {}) {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-terminal-"));
    tempDirs.push(logsDir);
    options.prepareLogs?.(logsDir);
    const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
    const defaultShellChoice: WindowsExplicitShellChoice = {
      executable: "C:\\Synara Test\\fake-shell.exe",
      args: [],
    };
    const inertProcessTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      signal: () => undefined,
    };
    const commonOptions = {
      logsDir,
      ptyAdapter,
      historyLineLimit,
      processTreeKiller: options.processTreeKiller ?? inertProcessTreeKiller,
      ...(options.shellEnvironment ? { shellEnvironment: options.shellEnvironment } : {}),
      ...(options.windowsShellSelectionDependencies
        ? { windowsShellSelectionDependencies: options.windowsShellSelectionDependencies }
        : {}),
      ...(options.subprocessChecker ? { subprocessChecker: options.subprocessChecker } : {}),
      ...(options.subprocessPlatform ? { subprocessPlatform: options.subprocessPlatform } : {}),
      ...(options.windowsProcessSnapshotCollector
        ? { windowsProcessSnapshotCollector: options.windowsProcessSnapshotCollector }
        : {}),
      ...(options.subprocessPollIntervalMs
        ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
        : {}),
      ...(options.processKillGraceMs ? { processKillGraceMs: options.processKillGraceMs } : {}),
      ...(options.maxRetainedInactiveSessions !== undefined
        ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
        : {}),
    };
    const manager =
      options.shellPlatform === "win32"
        ? new TerminalManagerRuntime({
            ...commonOptions,
            shellPlatform: "win32",
            shellResolver: options.shellResolver ?? (() => defaultShellChoice),
          })
        : options.shellPlatform !== undefined
          ? new TerminalManagerRuntime({
              ...commonOptions,
              shellPlatform: options.shellPlatform,
              shellResolver: options.shellResolver ?? (() => "/bin/bash"),
            })
          : process.platform === "win32"
            ? new TerminalManagerRuntime({
                ...commonOptions,
                shellPlatform: "win32",
                shellResolver: () => defaultShellChoice,
              })
            : new TerminalManagerRuntime({
                ...commonOptions,
                shellPlatform: process.platform,
                shellResolver: () => "/bin/bash",
              });
    return { logsDir, ptyAdapter, manager };
  }

  it("captures an exited recovery snapshot without relaunching a dropped exit", async () => {
    const { manager, ptyAdapter } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    if (!process) throw new Error("missing fake PTY");

    process.emitData("final output\n");
    process.emitExit({ exitCode: 7, signal: 9 });
    const recovery = await manager.recoverySnapshot({ threadId: "thread-1" });

    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(recovery.snapshot).toMatchObject({
      status: "exited",
      pid: null,
      history: "final output\n",
      exitCode: 7,
      exitSignal: 9,
    });
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ["started", 1],
      ["output", 2],
      ["exited", 3],
    ]);
    expect(recovery.watermark).toBe(3);
    expect(recovery.generation).toBe(manager.generation);
    await manager.dispose();
  });

  it("starts a fresh event generation and sequence namespace after server restart", async () => {
    const first = makeManager();
    const firstEvents: TerminalEvent[] = [];
    first.manager.on("event", (event) => firstEvents.push(event));
    await first.manager.open(openInput());

    const second = makeManager();
    const secondEvents: TerminalEvent[] = [];
    second.manager.on("event", (event) => secondEvents.push(event));
    await second.manager.open(openInput());

    expect(second.manager.generation).not.toBe(first.manager.generation);
    expect(firstEvents[0]).toMatchObject({
      generation: first.manager.generation,
      sequence: 1,
    });
    expect(secondEvents[0]).toMatchObject({
      generation: second.manager.generation,
      sequence: 1,
    });
    await first.manager.dispose();
    await second.manager.dispose();
  });

  it("flushes through the watermark then atomically rebases ACK accounting", async () => {
    const { manager, ptyAdapter } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    await manager.open(openInput());
    await manager.ackOutput({ threadId: "thread-1", bytes: 1 });
    const process = ptyAdapter.processes[0];
    if (!process) throw new Error("missing fake PTY");

    process.emitData("before-watermark");
    const recovery = await manager.recoverySnapshot({ threadId: "thread-1" });
    const session = (
      manager as unknown as {
        sessions: Map<
          string,
          { outputUnackedBytes: number; outputAckPauseRequested: boolean; outputPaused: boolean }
        >;
      }
    ).sessions.get("thread-1\u0000default");
    expect(recovery.snapshot.history).toBe("before-watermark");
    expect(recovery.watermark).toBe(2);
    expect(session).toMatchObject({
      outputUnackedBytes: 0,
      outputAckPauseRequested: false,
      outputPaused: false,
    });

    process.emitExit({ exitCode: 0, signal: null });
    const exit = events.at(-1);
    expect(exit).toMatchObject({ type: "exited", sequence: 3 });
    expect(exit?.sequence).toBeGreaterThan(recovery.watermark);
    await manager.dispose();
  });

  it("keeps event clocks isolated by both terminal id and thread id", async () => {
    const { manager, ptyAdapter } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    await manager.open(openInput({ terminalId: "one" }));
    await manager.open(openInput({ terminalId: "two" }));
    await manager.open(openInput({ threadId: "thread-2", terminalId: "one" }));
    ptyAdapter.processes[0]?.emitData("one-extra");

    const first = await manager.recoverySnapshot({ threadId: "thread-1", terminalId: "one" });
    const second = await manager.recoverySnapshot({ threadId: "thread-1", terminalId: "two" });
    const otherThread = await manager.recoverySnapshot({
      threadId: "thread-2",
      terminalId: "one",
    });

    expect(first.watermark).toBe(2);
    expect(second.watermark).toBe(1);
    expect(otherThread.watermark).toBe(1);
    expect(
      events
        .filter((event) => event.threadId === "thread-1" && event.terminalId === "one")
        .map((event) => event.sequence),
    ).toEqual([1, 2]);
    await manager.dispose();
  });

  it("evaluates a structured explicit Windows choice once and forwards its exact arguments", async () => {
    const explicitArgs = ["", "two words", '"quoted"', "&|<>^%", "日本語"];
    const resolveExplicit = vi.fn(() => ({
      executable: "C:\\Program Files\\Éditeur & Tools\\shell.exe",
      args: explicitArgs,
    }));
    const { manager, ptyAdapter } = makeManager(5, {
      shellPlatform: "win32",
      shellResolver: resolveExplicit,
    });

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(resolveExplicit).toHaveBeenCalledTimes(1);
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(ptyAdapter.spawnInputs[0]?.shell).toBe("C:\\Program Files\\Éditeur & Tools\\shell.exe");
    expect(ptyAdapter.spawnInputs[0]?.args).toEqual(explicitArgs);
    expect(ptyAdapter.spawnInputs[0]?.args).not.toBe(explicitArgs);

    await manager.restart(restartInput());
    expect(resolveExplicit).toHaveBeenCalledTimes(2);
    await manager.dispose();
  });

  it.each([
    [
      "resolver failure",
      () => {
        throw new Error("C:\\Users\\secret\\profile-output");
      },
      "Explicit Windows terminal shell could not be resolved.",
    ],
    [
      "invalid value",
      () => ({ executable: "C:\\secret\0shell.exe", args: ["secret"] }),
      "Explicit Windows terminal shell is invalid.",
    ],
  ])("fails closed on explicit Windows %s", async (_label, shellResolver, expectedMessage) => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellPlatform: "win32",
      shellResolver,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("error");
    expect(ptyAdapter.spawnInputs).toEqual([]);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      message: expectedMessage,
    });
    expect(JSON.stringify(events)).not.toMatch(/secret|profile-output/i);
    await manager.dispose();
  });

  it("does not fall through after an explicit Windows PTY launch failure", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellPlatform: "win32",
      shellResolver: () => ({ executable: "C:\\private\\missing.exe", args: ["secret"] }),
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    ptyAdapter.spawnFailures.push(Object.assign(new Error("secret ENOENT"), { code: "ENOENT" }));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("error");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      message: "Explicit Windows terminal shell failed to start.",
    });
    expect(JSON.stringify(events)).not.toMatch(/private|secret|missing\.exe/i);
    await manager.dispose();
  });

  it("sequences a start failure before zero-retention eviction", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellPlatform: "win32",
      shellResolver: () => ({ executable: "C:\\missing.exe", args: [] }),
      maxRetainedInactiveSessions: 0,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    ptyAdapter.spawnFailures.push(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("error");
    expect(events).toMatchObject([{ type: "error", sequence: 1 }]);
    expect((manager as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    await manager.dispose();
  });

  it("advances through the exact Windows automatic order only for not-found PTY races", async () => {
    const resolveExplicit = vi.fn(() => null);
    const probes: string[] = [];
    const validations: string[] = [];
    const { manager, ptyAdapter } = makeManager(5, {
      shellPlatform: "win32",
      shellResolver: resolveExplicit,
      shellEnvironment: {
        SystemRoot: "C:\\Windows",
        ComSpec: "D:\\Command Tools\\cmd.exe",
      },
      windowsShellSelectionDependencies: {
        probePowerShell: async (executable) => {
          probes.push(executable);
          return null;
        },
        validateExecutable: async (executable) => {
          validations.push(executable);
          return null;
        },
      },
    });
    ptyAdapter.spawnFailures.push(
      Object.assign(new Error("race one"), { code: "ENOENT" }),
      Object.assign(new Error("race two"), { code: "ENOENT" }),
      Object.assign(new Error("file not found"), { code: "ENOENT" }),
    );

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(resolveExplicit).toHaveBeenCalledTimes(1);
    expect(ptyAdapter.spawnInputs.map(({ shell, args }) => ({ shell, args }))).toEqual([
      { shell: "pwsh", args: ["-NoLogo"] },
      {
        shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: ["-NoLogo"],
      },
      { shell: "D:\\Command Tools\\cmd.exe", args: [] },
      { shell: "C:\\Windows\\System32\\cmd.exe", args: [] },
    ]);
    expect(probes).toEqual([
      "pwsh",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]);
    expect(validations).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "D:\\Command Tools\\cmd.exe",
      "C:\\Windows\\System32\\cmd.exe",
    ]);
    ptyAdapter.processes.at(-1)?.emitExit({ exitCode: 0, signal: null });
    await manager.dispose();
  });

  it("stops on a non-not-found automatic PTY failure and sanitizes the event", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellPlatform: "win32",
      shellResolver: () => null,
      shellEnvironment: { SystemRoot: "C:\\private", ComSpec: "D:\\private\\cmd.exe" },
      windowsShellSelectionDependencies: {
        probePowerShell: async () => null,
        validateExecutable: async () => null,
      },
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    ptyAdapter.spawnFailures.push(new Error("native binding SECRET failure"));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("error");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      message: "Windows terminal shell failed to start (PowerShell 7: launch failed).",
    });
    expect(JSON.stringify(events)).not.toMatch(/private|SECRET|native binding/i);
    await manager.dispose();
  });

  it("spawns lazily and reuses running terminal per thread", async () => {
    const { manager, ptyAdapter } = makeManager();
    const [first, second] = await Promise.all([
      manager.open(openInput()),
      manager.open(openInput()),
    ]);
    const third = await manager.open(openInput());

    expect(first.threadId).toBe("thread-1");
    expect(first.terminalId).toBe("default");
    expect(second.threadId).toBe("thread-1");
    expect(third.threadId).toBe("thread-1");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);

    await manager.dispose();
  });

  it("supports asynchronous PTY spawn effects", async () => {
    const { manager, ptyAdapter } = makeManager(5, { ptyAdapter: new FakePtyAdapter("async") });

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(ptyAdapter.processes).toHaveLength(1);

    await manager.dispose();
  });

  it("forwards write and resize to active pty process", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.write({ threadId: "thread-1", data: "ls\n" });
    await manager.resize({ threadId: "thread-1", cols: 120, rows: 30 });

    expect(process.writes).toEqual(["ls\n"]);
    expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);

    await manager.dispose();
  });

  it("resizes running terminal on open when a different size is requested", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.open(openInput({ cols: 140, rows: 40 }));

    expect(process.resizeCalls).toEqual([{ cols: 140, rows: 40 }]);

    await manager.dispose();
  });

  it("keeps a running terminal alive when open reattaches with different cwd or env", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    const snapshot = await manager.open(
      openInput({ cwd: logsDir, env: { SYNARA_TERMINAL_TEST: "changed" } }),
    );

    expect(snapshot.cwd).toBe(globalThis.process.cwd());
    expect(snapshot.status).toBe("running");
    expect(process.killSignals).toEqual([]);
    expect(ptyAdapter.spawnInputs).toHaveLength(1);

    await manager.write({ threadId: "thread-1", data: "echo alive\n" });
    expect(process.writes).toContain("echo alive\n");

    await manager.dispose();
  });

  it("preserves existing terminal size on open when size is omitted", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const ptyProcess = ptyAdapter.processes[0];
    expect(ptyProcess).toBeDefined();
    if (!ptyProcess) return;

    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    expect(ptyProcess.resizeCalls).toEqual([]);

    ptyProcess.emitExit({ exitCode: 0, signal: 0 });
    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    const resumedSpawn = ptyAdapter.spawnInputs[1];
    expect(resumedSpawn).toBeDefined();
    if (!resumedSpawn) return;
    expect(resumedSpawn.cols).toBe(100);
    expect(resumedSpawn.rows).toBe(24);

    await manager.dispose();
  });

  it("uses default dimensions when opening a new terminal without size hints", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open({
      threadId: "thread-1",
      cwd: process.cwd(),
    });

    const spawned = ptyAdapter.spawnInputs[0];
    expect(spawned).toBeDefined();
    if (!spawned) return;
    expect(spawned.cols).toBe(120);
    expect(spawned.rows).toBe(30);

    await manager.dispose();
  });

  it("never creates or restarts a PTY for a reattach-only cold recovery", async () => {
    const { manager, ptyAdapter } = makeManager();

    const missingSnapshot = await manager.open(openInput({ reattachOnly: true }));
    expect(missingSnapshot.status).toBe("exited");
    expect(ptyAdapter.spawnInputs).toHaveLength(0);

    await manager.restart(restartInput());
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    const runningSnapshot = await manager.open(openInput({ reattachOnly: true }));
    expect(runningSnapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    ptyAdapter.processes[0]?.emitExit({ exitCode: 0, signal: 0 });

    const exitedSnapshot = await manager.open(openInput({ reattachOnly: true }));
    expect(exitedSnapshot.status).toBe("exited");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);

    await manager.dispose();
  });

  it("supports multiple terminals per thread with isolated sessions", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "term-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    await manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
    await manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

    expect(first.writes).toEqual(["pwd\n"]);
    expect(second.writes).toEqual(["ls\n"]);
    expect(ptyAdapter.spawnInputs).toHaveLength(2);

    await manager.dispose();
  });

  it("clears transcript and emits cleared event", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("hello\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    await manager.clear({ threadId: "thread-1" });
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");
    expect(
      JSON.parse(fs.readFileSync(terminalHistoryMetadataPath(historyLogPath(logsDir)), "utf8")),
    ).toEqual(createTerminalHistoryMetadata("", 100, 24));

    expect(events.some((event) => event.type === "cleared")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "cleared" &&
          event.threadId === "thread-1" &&
          event.terminalId === "default",
      ),
    ).toBe(true);

    await manager.dispose();
  });

  it.skipIf(process.platform === "win32")(
    "creates terminal history with private permissions",
    async () => {
      const { manager, ptyAdapter, logsDir } = makeManager();
      await manager.open(openInput());
      ptyAdapter.processes[0]?.emitData("private history\n");
      const historyPath = historyLogPath(logsDir);
      await waitFor(() => fs.existsSync(historyPath));

      expect(fs.statSync(logsDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(historyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(terminalHistoryMetadataPath(historyPath)).mode & 0o777).toBe(0o600);

      await manager.dispose();
    },
  );

  it.skipIf(process.platform === "win32")(
    "repairs existing terminal history permissions on first open",
    async () => {
      const { manager, logsDir } = makeManager(5, {
        prepareLogs: (directoryPath) => {
          fs.chmodSync(directoryPath, 0o755);
          fs.writeFileSync(historyLogPath(directoryPath), "existing history\n", { mode: 0o644 });
        },
      });

      expect(fs.statSync(logsDir).mode & 0o777).toBe(0o700);
      await manager.open(openInput());
      expect(fs.statSync(historyLogPath(logsDir)).mode & 0o777).toBe(0o600);

      await manager.dispose();
    },
  );

  it("restores validated source dimensions and identity through open snapshots", async () => {
    const history = "recovered history\n";
    const { manager } = makeManager(5, {
      prepareLogs: (directory) => {
        const historyPath = historyLogPath(directory);
        fs.writeFileSync(historyPath, history);
        fs.writeFileSync(
          terminalHistoryMetadataPath(historyPath),
          JSON.stringify(createTerminalHistoryMetadata(history, 77, 19)),
        );
      },
    });
    const snapshot = await manager.open(openInput({ cols: 120, rows: 30 }));
    expect(snapshot.history).toBe(history);
    expect(snapshot.recoveredCols).toBe(77);
    expect(snapshot.recoveredRows).toBe(19);
    expect(snapshot.historyRecordIdentity).toBe(
      createTerminalHistoryMetadata(history, 77, 19).recordIdentity,
    );
    await manager.dispose();
  });

  it("invalidates recovered dimensions after live output and reopens updated history dimensionless", async () => {
    const recoveredHistory = "recovered history\n";
    const liveOutput = "live after recovery\n";
    const { manager, ptyAdapter, logsDir } = makeManager(5, {
      prepareLogs: (directory) => {
        const historyPath = historyLogPath(directory);
        fs.writeFileSync(historyPath, recoveredHistory);
        fs.writeFileSync(
          terminalHistoryMetadataPath(historyPath),
          JSON.stringify(createTerminalHistoryMetadata(recoveredHistory, 77, 19)),
        );
      },
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));

    const initialSnapshot = await manager.open(openInput({ cols: 120, rows: 30 }));
    expect(initialSnapshot.history).toBe(recoveredHistory);
    expect(initialSnapshot.recoveredCols).toBe(77);
    expect(initialSnapshot.recoveredRows).toBe(19);
    expect(initialSnapshot.historyRecordIdentity).toBeTypeOf("string");

    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData(liveOutput);
    await waitFor(() =>
      events.some((event) => event.type === "output" && event.data === liveOutput),
    );
    const expectedHistory = `${recoveredHistory}${liveOutput}`;
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === expectedHistory);

    const reopenedSnapshot = await manager.open(openInput({ cols: 120, rows: 30 }));
    expect(reopenedSnapshot.history).toBe(expectedHistory);
    expect(reopenedSnapshot.recoveredCols).toBeUndefined();
    expect(reopenedSnapshot.recoveredRows).toBeUndefined();
    expect(reopenedSnapshot.historyRecordIdentity).toBeUndefined();

    await manager.dispose();
  });

  it("persists reattach dimensions-only changes with a new record identity", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    ptyAdapter.processes[0]?.emitData("same bytes\n");
    const metadataPath = terminalHistoryMetadataPath(historyLogPath(logsDir));
    await waitFor(() => fs.existsSync(metadataPath));
    const first = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      recordIdentity: string;
    };
    await manager.open(openInput({ cols: 120, rows: 40 }));
    await waitFor(() => {
      const current = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        cols: number;
        recordIdentity: string;
      };
      return current.cols === 120 && current.recordIdentity !== first.recordIdentity;
    });
    await manager.dispose();
  });

  it("rewrites normalized legacy bytes and hashes the exact capped source", async () => {
    const raw = "drop\nkeep-1\n\u001b[2Jkeep-2\n";
    const expected = "keep-1\nkeep-2\n";
    const { manager, logsDir } = makeManager(2, {
      prepareLogs: (directory) => {
        const historyPath = historyLogPath(directory);
        fs.writeFileSync(historyPath, raw);
        fs.writeFileSync(
          terminalHistoryMetadataPath(historyPath),
          JSON.stringify(createTerminalHistoryMetadata(raw, 77, 19)),
        );
      },
    });

    const snapshot = await manager.open(openInput());
    const historyPath = historyLogPath(logsDir);
    const metadataPath = terminalHistoryMetadataPath(historyPath);
    expect(snapshot.history).toBe(expected);
    expect(snapshot.recoveredCols).toBeUndefined();
    expect(snapshot.recoveredRows).toBeUndefined();
    expect(snapshot.historyRecordIdentity).toBeUndefined();
    expect(fs.readFileSync(historyPath, "utf8")).toBe(expected);
    expect(fs.existsSync(metadataPath)).toBe(false);

    await manager.resize({ threadId: "thread-1", cols: 100, rows: 24 });
    await waitFor(() => fs.existsSync(metadataPath));
    expect(fs.readFileSync(historyPath, "utf8")).toBe(expected);
    expect(JSON.parse(fs.readFileSync(metadataPath, "utf8"))).toEqual(
      createTerminalHistoryMetadata(expected, 100, 24),
    );
    await manager.dispose();
  });

  it("removes sidecar and history when close deletes history", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    ptyAdapter.processes[0]?.emitData("delete me\n");
    const historyPath = historyLogPath(logsDir);
    await waitFor(() => fs.existsSync(terminalHistoryMetadataPath(historyPath)));
    await manager.close({ threadId: "thread-1", deleteHistory: true });
    expect(fs.existsSync(terminalHistoryMetadataPath(historyPath))).toBe(false);
    expect(fs.existsSync(historyPath)).toBe(false);
  });

  it("preserves every session and history when an atomic batch-close preflight fails", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput({ terminalId: "one" }));
    await manager.open(openInput({ terminalId: "two" }));
    ptyAdapter.processes[0]?.emitData("one history\n");
    ptyAdapter.processes[1]?.emitData("two history\n");
    const oneHistoryPath = multiTerminalHistoryLogPath(logsDir, "thread-1", "one");
    const twoHistoryPath = multiTerminalHistoryLogPath(logsDir, "thread-1", "two");
    await waitFor(() => fs.existsSync(oneHistoryPath) && fs.existsSync(twoHistoryPath));

    const internals = manager as unknown as {
      flushPersistQueue: (threadId: string, terminalId: string) => Promise<void>;
      sessions: Map<string, unknown>;
    };
    const flushPersistQueue = internals.flushPersistQueue.bind(manager);
    vi.spyOn(internals, "flushPersistQueue").mockImplementation(async (threadId, terminalId) => {
      if (terminalId === "two") throw new Error("preflight failed");
      await flushPersistQueue(threadId, terminalId);
    });

    await expect(
      manager.close({
        threadId: "thread-1",
        terminalIds: ["one", "two"],
        deleteHistory: true,
      }),
    ).rejects.toThrow("preflight failed");

    expect(internals.sessions.has("thread-1\u0000one")).toBe(true);
    expect(internals.sessions.has("thread-1\u0000two")).toBe(true);
    expect(ptyAdapter.processes[0]?.killed).toBe(false);
    expect(ptyAdapter.processes[1]?.killed).toBe(false);
    expect(fs.readFileSync(oneHistoryPath, "utf8")).toContain("one history");
    expect(fs.readFileSync(twoHistoryPath, "utf8")).toContain("two history");

    await manager.dispose();
  });

  it("drains trailing batch persistence after stopping and tolerates cleanup flush failures", async () => {
    const { manager, logsDir } = makeManager();
    await manager.open(openInput({ terminalId: "one" }));
    await manager.open(openInput({ terminalId: "two" }));
    const oneHistoryPath = multiTerminalHistoryLogPath(logsDir, "thread-1", "one");
    const twoHistoryPath = multiTerminalHistoryLogPath(logsDir, "thread-1", "two");

    const internals = manager as unknown as {
      flushPersistQueue: (threadId: string, terminalId: string) => Promise<void>;
      sessions: Map<string, unknown>;
    };
    const flushPersistQueue = internals.flushPersistQueue.bind(manager);
    const callCounts = new Map<string, number>();
    vi.spyOn(internals, "flushPersistQueue").mockImplementation(async (threadId, terminalId) => {
      const callCount = (callCounts.get(terminalId) ?? 0) + 1;
      callCounts.set(terminalId, callCount);
      if (terminalId === "two" && callCount === 2) {
        throw new Error("trailing persistence failed");
      }
      await flushPersistQueue(threadId, terminalId);
    });

    await expect(
      manager.close({
        threadId: "thread-1",
        terminalIds: ["one", "two"],
        deleteHistory: true,
      }),
    ).resolves.toBeUndefined();

    expect(callCounts).toEqual(
      new Map([
        ["one", 2],
        ["two", 2],
      ]),
    );
    expect(internals.sessions.has("thread-1\u0000one")).toBe(false);
    expect(internals.sessions.has("thread-1\u0000two")).toBe(false);
    expect(fs.existsSync(oneHistoryPath)).toBe(false);
    expect(fs.existsSync(twoHistoryPath)).toBe(false);

    await manager.dispose();
  });

  it("keeps pty reads paused until renderer output ACKs drain", async () => {
    const { manager, ptyAdapter } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.ackOutput({ threadId: "thread-1", terminalId: "default", bytes: 1 });
    const output = "x".repeat(120_000);
    process.emitData(output);

    await waitFor(() => process.paused);
    expect(
      events.some((event) => event.type === "output" && event.byteLength === output.length),
    ).toBe(true);

    await manager.ackOutput({ threadId: "thread-1", terminalId: "default", bytes: 116_000 });

    expect(process.paused).toBe(false);
    await manager.dispose();
  });

  it("drains output into history without emitting output events when streamOutput is false", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput({ streamOutput: false }));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("dev server listening\n");
    // History is still drained and persisted even though nothing is broadcast.
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    await waitFor(() =>
      fs.readFileSync(historyLogPath(logsDir), "utf8").includes("dev server listening"),
    );

    // No live output event ever reaches the WebSocket fanout for a headless session.
    expect(events.some((event) => event.type === "output")).toBe(false);

    // Re-opening with streamOutput:true flips the session back to live mode (e.g. a
    // log viewer attaching later); omitting the flag would preserve headless mode.
    await manager.open(openInput({ streamOutput: true }));
    process.emitData("after attach\n");
    await waitFor(() => events.some((event) => event.type === "output"));

    await manager.dispose();
  });

  it("resumes ack-paused reads when a renderer reattaches", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    // Renderer proves ACK support, then a burst pauses reads without draining.
    await manager.ackOutput({ threadId: "thread-1", terminalId: "default", bytes: 1 });
    process.emitData("x".repeat(120_000));
    await waitFor(() => process.paused);

    // Renderer disconnects while paused and reattaches (open on a running session).
    // Without resetting the previous client's ACK accounting the PTY would stay
    // paused forever, since the fresh renderer never ACKs output it never received.
    await manager.open(openInput());

    expect(process.paused).toBe(false);
    await manager.dispose();
  });

  it("includes live terminal mode replay preamble in reattach snapshots", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("\u001b[?2004h\u001b[?1002h\u001b[>7u");
    const snapshot = await manager.open(openInput());

    expect(snapshot.replayPreamble).toContain("\u001b[?2004h");
    expect(snapshot.replayPreamble).toContain("\u001b[=7;1u");
    expect(snapshot.replayPreamble ?? "").not.toContain("?1002h");

    process.emitData("\u001b[?2004l\u001b[=0;1u");
    const resetSnapshot = await manager.open(openInput());

    expect(resetSnapshot.replayPreamble ?? "").not.toContain("?2004");
    expect(resetSnapshot.replayPreamble ?? "").not.toContain("=7;1u");

    await manager.dispose();
  });

  it("restarts terminal with empty transcript and respawns pty", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const firstProcess = ptyAdapter.processes[0];
    expect(firstProcess).toBeDefined();
    if (!firstProcess) return;
    firstProcess.emitData("before restart\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    const snapshot = await manager.restart(restartInput());
    expect(snapshot.history).toBe("");
    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    await manager.dispose();
  });

  it("keeps zero-retention restart registered with a monotonic event clock", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      maxRetainedInactiveSessions: 0,
      shellPlatform: "win32",
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    await manager.open(openInput());

    const snapshot = await manager.restart(restartInput());
    const recovery = await manager.recoverySnapshot({ threadId: "thread-1" });

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ["started", 1],
      ["restarted", 2],
    ]);
    expect(recovery.watermark).toBe(2);
    await manager.dispose();
  });

  it("sequences a zero-retention restart failure before evicting the session", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      maxRetainedInactiveSessions: 0,
      shellPlatform: "win32",
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    await manager.open(openInput());
    ptyAdapter.spawnFailures.push(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const snapshot = await manager.restart(restartInput());

    expect(snapshot.status).toBe("error");
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ["started", 1],
      ["error", 2],
    ]);
    expect((manager as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    await manager.dispose();
  });

  it("continues the event clock when zero-retention reopens an exited terminal", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      maxRetainedInactiveSessions: 0,
      shellPlatform: "win32",
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    await manager.open(openInput());
    ptyAdapter.processes[0]?.emitExit({ exitCode: 0, signal: 0 });

    const snapshot = await manager.open(openInput());
    const recovery = await manager.recoverySnapshot({ threadId: "thread-1" });

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ["started", 1],
      ["exited", 2],
      ["started", 3],
    ]);
    expect(recovery.watermark).toBe(3);
    await manager.dispose();
  });

  it("continues the event clock through a zero-retention reopen failure", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      maxRetainedInactiveSessions: 0,
      shellPlatform: "win32",
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    await manager.open(openInput());
    ptyAdapter.processes[0]?.emitExit({ exitCode: 0, signal: 0 });
    ptyAdapter.spawnFailures.push(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("error");
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ["started", 1],
      ["exited", 2],
      ["error", 3],
    ]);
    expect((manager as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    await manager.dispose();
  });

  it("emits exited event and reopens with clean transcript after exit", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("old data\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    process.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => events.some((event) => event.type === "exited"));
    const reopened = await manager.open(openInput());

    expect(reopened.history).toBe("");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("");

    await manager.dispose();
  });

  it("ignores trailing writes after terminal exit", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitExit({ exitCode: 0, signal: 0 });

    await expect(manager.write({ threadId: "thread-1", data: "\r" })).resolves.toBeUndefined();
    expect(process.writes).toEqual([]);

    await manager.dispose();
  });

  it("emits subprocess activity events when child-process state changes", async () => {
    let hasRunningSubprocess = false;
    const { manager } = makeManager(5, {
      subprocessChecker: async () => hasRunningSubprocess,
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await waitFor(() => events.some((event) => event.type === "started"));
    expect(events.some((event) => event.type === "activity")).toBe(false);

    hasRunningSubprocess = true;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
      1_200,
    );

    hasRunningSubprocess = false;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
      1_200,
    );

    await manager.dispose();
  });

  it.each([1, 8, 32])(
    "shares one completed Windows snapshot across %i running terminals in a poll cycle",
    async (terminalCount) => {
      let result = completeWindowsSnapshot([]);
      let collectorCalls = 0;
      const processTreeKiller: ProcessTreeKiller = {
        capture: () => ({ descendants: [], captureComplete: true }),
        signal: () => undefined,
      };
      const { manager } = makeManager(5, {
        processTreeKiller,
        subprocessPlatform: "win32",
        subprocessPollIntervalMs: 60_000,
        windowsProcessSnapshotCollector: async () => {
          collectorCalls += 1;
          return result;
        },
      });
      const events: TerminalEvent[] = [];
      manager.on("event", (event) => {
        events.push(event);
      });

      const terminalIds = Array.from({ length: terminalCount }, (_, index) =>
        index === 0 ? "default" : `terminal-${index + 1}`,
      );
      for (const terminalId of terminalIds) {
        await manager.open(openInput({ terminalId }));
      }
      await waitFor(() => !isSubprocessPollInFlight(manager));

      collectorCalls = 0;
      events.length = 0;
      result = completeWindowsSnapshot(
        terminalIds.map((_, index) => ({
          ppid: 9000 + index,
          pid: 10_000 + index,
          command: `node task-${index}.js`,
        })),
      );
      await pollSubprocessActivity(manager);

      expect(collectorCalls).toBe(1);
      expect(
        events
          .filter((event) => event.type === "activity" && event.hasRunningSubprocess === true)
          .map((event) => event.terminalId)
          .sort(),
      ).toEqual([...terminalIds].sort());

      await manager.dispose();
    },
  );

  it("preserves Windows activity and warns once per contiguous snapshot failure", async () => {
    let result: WindowsProcessSnapshotResult = completeWindowsSnapshot([]);
    let collectorCalls = 0;
    const { manager } = makeManager(5, {
      subprocessPlatform: "win32",
      subprocessPollIntervalMs: 60_000,
      windowsProcessSnapshotCollector: async () => {
        collectorCalls += 1;
        return result;
      },
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await waitFor(() => !isSubprocessPollInFlight(manager));
    await manager.write({ threadId: "thread-1", data: "codex\r" });
    result = completeWindowsSnapshot([{ ppid: 9000, pid: 9100, command: "codex" }]);
    await pollSubprocessActivity(manager);
    expect(subprocessState(manager)).toMatchObject({
      detectedCliKind: "codex",
      hasRunningSubprocess: true,
      providerDescendantObserved: true,
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    collectorCalls = 0;
    events.length = 0;
    result = { kind: "unknown", reason: "capture_failed" };
    await pollSubprocessActivity(manager);
    result = { kind: "unknown", reason: "timed_out" };
    await pollSubprocessActivity(manager);

    expect(subprocessState(manager)).toMatchObject({
      detectedCliKind: "codex",
      hasRunningSubprocess: true,
      providerDescendantObserved: true,
    });
    expect(events.filter((event) => event.type === "activity")).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("capture_failed");

    result = completeWindowsSnapshot([]);
    await pollSubprocessActivity(manager);
    expect(subprocessState(manager)).toMatchObject({
      detectedCliKind: null,
      hasRunningSubprocess: false,
      providerDescendantObserved: false,
    });

    events.length = 0;
    result = { kind: "unknown", reason: "empty_snapshot" };
    await pollSubprocessActivity(manager);

    expect(subprocessState(manager)).toMatchObject({
      detectedCliKind: null,
      hasRunningSubprocess: false,
      providerDescendantObserved: false,
    });
    expect(events.filter((event) => event.type === "activity")).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain("empty_snapshot");
    expect(collectorCalls).toBe(4);

    await manager.dispose();
  });

  it("keeps overlapping Windows polls single-flight", async () => {
    let pending: ReturnType<typeof deferred<WindowsProcessSnapshotResult>> | null = null;
    let collectorCalls = 0;
    const { manager } = makeManager(5, {
      subprocessPlatform: "win32",
      subprocessPollIntervalMs: 60_000,
      windowsProcessSnapshotCollector: async () => {
        collectorCalls += 1;
        return pending?.promise ?? completeWindowsSnapshot([]);
      },
    });

    await manager.open(openInput());
    await waitFor(() => !isSubprocessPollInFlight(manager));
    collectorCalls = 0;
    pending = deferred<WindowsProcessSnapshotResult>();

    const firstPoll = pollSubprocessActivity(manager);
    await waitFor(() => collectorCalls === 1 && isSubprocessPollInFlight(manager));
    await pollSubprocessActivity(manager);
    expect(collectorCalls).toBe(1);

    pending.resolve(completeWindowsSnapshot([]));
    await firstPoll;
    expect(isSubprocessPollInFlight(manager)).toBe(false);

    await manager.dispose();
  });

  it("aborts and settles a pending Windows snapshot when disposed", async () => {
    let collectorSignal: AbortSignal | undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      signal: () => undefined,
    };
    const { manager } = makeManager(5, {
      processTreeKiller,
      subprocessPlatform: "win32",
      subprocessPollIntervalMs: 60_000,
      windowsProcessSnapshotCollector: (signal) =>
        new Promise((resolve) => {
          collectorSignal = signal;
          signal?.addEventListener(
            "abort",
            () => resolve({ kind: "unknown", reason: "cancelled" }),
            { once: true },
          );
        }),
    });

    await manager.open(openInput());
    await waitFor(() => collectorSignal !== undefined && isSubprocessPollInFlight(manager));
    await manager.dispose();

    expect(collectorSignal?.aborted).toBe(true);
    await waitFor(() => !isSubprocessPollInFlight(manager));
    expect(
      (manager as unknown as { subprocessPollAbortController: AbortController | null })
        .subprocessPollAbortController,
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("aborts and settles a pending Windows snapshot when no running terminal remains", async () => {
    let collectorSignal: AbortSignal | undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      signal: () => undefined,
    };
    const { manager } = makeManager(5, {
      processTreeKiller,
      subprocessPlatform: "win32",
      subprocessPollIntervalMs: 60_000,
      windowsProcessSnapshotCollector: (signal) =>
        new Promise((resolve) => {
          collectorSignal = signal;
          signal?.addEventListener(
            "abort",
            () => resolve({ kind: "unknown", reason: "cancelled" }),
            { once: true },
          );
        }),
    });

    await manager.open(openInput());
    await waitFor(() => collectorSignal !== undefined && isSubprocessPollInFlight(manager));
    await manager.close({ threadId: "thread-1", terminalId: "default" });

    expect(collectorSignal?.aborted).toBe(true);
    await waitFor(() => !isSubprocessPollInFlight(manager));
    expect(warn).toHaveBeenCalledTimes(1);

    await manager.dispose();
  });

  it("keeps a shared Windows cycle alive when one of multiple terminals closes", async () => {
    let pending: ReturnType<typeof deferred<WindowsProcessSnapshotResult>> | null = null;
    let collectorSignal: AbortSignal | undefined;
    let collectorCalls = 0;
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      signal: () => undefined,
    };
    const { manager } = makeManager(5, {
      processTreeKiller,
      subprocessPlatform: "win32",
      subprocessPollIntervalMs: 60_000,
      windowsProcessSnapshotCollector: async (signal) => {
        collectorCalls += 1;
        collectorSignal = signal;
        return pending?.promise ?? completeWindowsSnapshot([]);
      },
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "sidecar" }));
    await waitFor(() => !isSubprocessPollInFlight(manager));
    collectorCalls = 0;
    events.length = 0;
    pending = deferred<WindowsProcessSnapshotResult>();

    const poll = pollSubprocessActivity(manager);
    await waitFor(() => collectorCalls === 1 && isSubprocessPollInFlight(manager));
    await manager.close({ threadId: "thread-1", terminalId: "default" });
    expect(collectorSignal?.aborted).toBe(false);

    pending.resolve(
      completeWindowsSnapshot([
        { ppid: 9000, pid: 9100, command: "node closed.js" },
        { ppid: 9001, pid: 9101, command: "node active.js" },
      ]),
    );
    await poll;

    expect(collectorCalls).toBe(1);
    expect(
      events.filter((event) => event.type === "activity").map((event) => event.terminalId),
    ).toEqual(["sidecar"]);
    expect(subprocessState(manager, "thread-1", "sidecar")).toMatchObject({
      hasRunningSubprocess: true,
    });

    await manager.dispose();
  });

  it("preserves injected subprocess checkers on Windows", async () => {
    let checkerCalls = 0;
    let collectorCalls = 0;
    const { manager } = makeManager(5, {
      subprocessChecker: async () => {
        checkerCalls += 1;
        return true;
      },
      subprocessPlatform: "win32",
      subprocessPollIntervalMs: 60_000,
      windowsProcessSnapshotCollector: async () => {
        collectorCalls += 1;
        return completeWindowsSnapshot([]);
      },
    });

    await manager.open(openInput());
    await waitFor(() => checkerCalls > 0 && !isSubprocessPollInFlight(manager));

    expect(collectorCalls).toBe(0);
    expect(subprocessState(manager)).toMatchObject({ hasRunningSubprocess: true });

    await manager.dispose();
  });

  it("does not brand generic terminals from provider descendants", async () => {
    const { manager } = makeManager(5, {
      subprocessChecker: async () => ({
        cliKind: "codex",
        hasNonProviderSubprocess: true,
        hasProviderDescendant: true,
        hasRunningSubprocess: true,
      }),
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "activity" &&
            event.hasRunningSubprocess === true &&
            event.cliKind === null,
        ),
      1_200,
    );

    expect(events.some((event) => event.type === "activity" && event.cliKind === "codex")).toBe(
      false,
    );
    await manager.dispose();
  });

  it("does not brand generic terminals from provider-looking output", async () => {
    const { manager, ptyAdapter } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("Claude Code v1.2.3 is available in this dev-server log\n");
    await waitFor(() => events.some((event) => event.type === "output"));

    expect(events.some((event) => event.type === "activity" && event.cliKind === "claude")).toBe(
      false,
    );
    await manager.dispose();
  });

  it("clears provider identity when a generic command is submitted", async () => {
    const { manager } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await manager.write({ threadId: "thread-1", data: "codex\r" });
    expect(events.some((event) => event.type === "activity" && event.cliKind === "codex")).toBe(
      true,
    );

    await manager.write({ threadId: "thread-1", data: "bun run dev\r" });
    expect(events.at(-1)).toMatchObject({
      type: "activity",
      cliKind: null,
    });
    await manager.dispose();
  });

  it("clears unmanaged provider identity as soon as an observed provider process disappears", async () => {
    let subprocessActivity: TerminalSubprocessActivity = {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    };
    let providerDescendantPolls = 0;
    const { manager } = makeManager(5, {
      subprocessChecker: async () => {
        if (subprocessActivity.hasProviderDescendant) {
          providerDescendantPolls += 1;
        }
        return subprocessActivity;
      },
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await manager.write({ threadId: "thread-1", data: "codex\r" });
    expect(events.some((event) => event.type === "activity" && event.cliKind === "codex")).toBe(
      true,
    );

    subprocessActivity = {
      cliKind: "codex",
      hasNonProviderSubprocess: false,
      hasProviderDescendant: true,
      hasRunningSubprocess: true,
    };
    await waitFor(() => providerDescendantPolls > 0, 1_200);

    subprocessActivity = {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    };
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "activity" &&
            event.cliKind === null &&
            event.hasRunningSubprocess === false,
        ),
      1_200,
    );

    await manager.dispose();
  });

  it("caps persisted history to configured line limit", async () => {
    const { manager, ptyAdapter } = makeManager(3);
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("line1\nline2\nline3\nline4\n");
    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
    expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);

    await manager.dispose();
  });

  it("strips replay-unsafe terminal query and reply sequences from persisted history", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("prompt ");
    process.emitData("\u001b[32mok\u001b[0m ");
    process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
    process.emitData("\u001b[1;1R");
    process.emitData("done\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("prompt \u001b[32mok\u001b[0m done\n");

    await manager.dispose();
  });

  it("strips replay-destructive clears while preserving style sequences", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before clear\n");
    process.emitData("\u001b[H\u001b[2J");
    process.emitData("prompt ");
    process.emitData("\u001b]11;");
    process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
    process.emitData("R\u001b[36mdone\u001b[0m\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("before clear\nprompt \u001b[36mdone\u001b[0m\n");

    await manager.dispose();
  });

  it("strips cursor save and restore sequences that can blank replayed prompt history", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("instant prompt\n");
    process.emitData("\u001b7warning output\n\u001b8\u001b[J");
    process.emitData("final prompt \u001b[35m❯\u001b[0m ");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe(
      "instant prompt\nwarning output\nfinal prompt \u001b[35m❯\u001b[0m ",
    );

    await manager.dispose();
  });

  it("strips replay cursor movement while preserving prompt styling", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("first prompt\r");
    process.emitData("\u001b[A\u001b[H\u001b[2K");
    process.emitData("\u001b[0m\u001b[38;5;175m❯\u001b[0m ");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("first prompt\r\u001b[0m\u001b[38;5;175m❯\u001b[0m ");

    await manager.dispose();
  });

  it("does not leak final bytes from ESC sequences with intermediate bytes", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before ");
    process.emitData("\u001b(B");
    process.emitData("after\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("before \u001b(Bafter\n");

    await manager.dispose();
  });

  it("preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before ");
    process.emitData("\u001b(");
    process.emitData("Bafter\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("before \u001b(Bafter\n");

    await manager.dispose();
  });

  it("deletes history file when close(deleteHistory=true)", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("bye\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    await manager.close({ threadId: "thread-1", deleteHistory: true });
    expect(fs.existsSync(historyLogPath(logsDir))).toBe(false);

    await manager.dispose();
  });

  it("closes all terminals for a thread when close omits terminalId", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "sidecar" }));
    const defaultProcess = ptyAdapter.processes[0];
    const sidecarProcess = ptyAdapter.processes[1];
    expect(defaultProcess).toBeDefined();
    expect(sidecarProcess).toBeDefined();
    if (!defaultProcess || !sidecarProcess) return;

    defaultProcess.emitData("default\n");
    sidecarProcess.emitData("sidecar\n");
    const defaultHistoryPath = multiTerminalHistoryLogPath(logsDir, "thread-1", "default");
    const sidecarHistoryPath = multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar");
    await waitFor(() => fs.existsSync(defaultHistoryPath));
    await waitFor(() => fs.existsSync(sidecarHistoryPath));
    expect(fs.existsSync(terminalHistoryMetadataPath(defaultHistoryPath))).toBe(true);
    expect(fs.existsSync(terminalHistoryMetadataPath(sidecarHistoryPath))).toBe(true);

    await manager.close({ threadId: "thread-1", deleteHistory: true });

    expect(defaultProcess.killed).toBe(true);
    expect(sidecarProcess.killed).toBe(true);
    expect(fs.existsSync(defaultHistoryPath)).toBe(false);
    expect(fs.existsSync(sidecarHistoryPath)).toBe(false);
    expect(fs.existsSync(terminalHistoryMetadataPath(defaultHistoryPath))).toBe(false);
    expect(fs.existsSync(terminalHistoryMetadataPath(sidecarHistoryPath))).toBe(false);

    await manager.dispose();
  });

  it("starts every thread terminal stop before awaiting capture and removes sessions after cleanup", async () => {
    const defaultCapture = deferred<CapturedProcessTree>();
    const sidecarCapture = deferred<CapturedProcessTree>();
    const capturesByPid = new Map<number, Promise<CapturedProcessTree>>();
    const captureStarted: number[] = [];
    const treeSignals: Array<{
      rootPid: number;
      signal: string;
      includeRootTree: boolean | undefined;
    }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: (rootPid) => {
        const pendingCapture = capturesByPid.get(rootPid);
        if (!pendingCapture) throw new Error(`Unexpected capture PID: ${rootPid}`);
        captureStarted.push(rootPid);
        return pendingCapture;
      },
      signal: ({ rootPid, signal, includeRootTree }) => {
        treeSignals.push({ rootPid, signal, includeRootTree });
      },
    };
    const { manager, ptyAdapter } = makeManager(5, { processTreeKiller });
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "sidecar" }));
    const defaultProcess = ptyAdapter.processes[0];
    const sidecarProcess = ptyAdapter.processes[1];
    expect(defaultProcess).toBeDefined();
    expect(sidecarProcess).toBeDefined();
    if (!defaultProcess || !sidecarProcess) {
      throw new Error("Expected both thread terminal processes to start");
    }
    capturesByPid.set(defaultProcess.pid, defaultCapture.promise);
    capturesByPid.set(sidecarProcess.pid, sidecarCapture.promise);
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    let closeSettled = false;

    const close = manager.close({ threadId: "thread-1" }).then(() => {
      closeSettled = true;
    });
    await waitFor(() => captureStarted.length === 2);

    expect(captureStarted).toEqual([defaultProcess.pid, sidecarProcess.pid]);
    expect(sessions.size).toBe(2);
    expect(closeSettled).toBe(false);
    defaultProcess.emitExit({ exitCode: 0, signal: 15 });
    sidecarProcess.emitExit({ exitCode: 0, signal: 15 });
    expect(sessions.size).toBe(2);

    defaultCapture.resolve({ descendants: [], captureComplete: true });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    sidecarCapture.resolve({ descendants: [], captureComplete: true });
    await close;

    expect(treeSignals).toEqual([
      { rootPid: defaultProcess.pid, signal: "SIGTERM", includeRootTree: false },
      { rootPid: sidecarProcess.pid, signal: "SIGTERM", includeRootTree: false },
    ]);
    expect(defaultProcess.killSignals).toEqual([]);
    expect(sidecarProcess.killSignals).toEqual([]);
    expect(sessions.size).toBe(0);
    await manager.dispose();
  });

  it("deletes orphaned thread metadata temporaries without touching adjacent artifacts", async () => {
    const { manager, logsDir } = makeManager();
    const ownedHistoryPath = multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar");
    const ownedMetadataTemp = `${terminalHistoryMetadataPath(ownedHistoryPath)}.tmp-4100-7`;
    const adjacentMetadataTemp = `${terminalHistoryMetadataPath(
      multiTerminalHistoryLogPath(logsDir, "thread-10", "sidecar"),
    )}.tmp-4100-7`;
    const unknownSuffix = `${terminalHistoryMetadataPath(ownedHistoryPath)}.tmp-4100-7.keep`;
    fs.writeFileSync(ownedMetadataTemp, "orphaned metadata");
    fs.writeFileSync(adjacentMetadataTemp, "adjacent thread");
    fs.writeFileSync(unknownSuffix, "unknown transaction suffix");

    await manager.close({ threadId: "thread-1", deleteHistory: true });

    expect(fs.existsSync(ownedMetadataTemp)).toBe(false);
    expect(fs.readFileSync(adjacentMetadataTemp, "utf8")).toBe("adjacent thread");
    expect(fs.readFileSync(unknownSuffix, "utf8")).toBe("unknown transaction suffix");
    await manager.dispose();
  });

  it("deletes orphaned thread history temporaries without touching adjacent artifacts", async () => {
    const { manager, logsDir } = makeManager();
    const ownedHistoryPath = historyLogPath(logsDir, "thread-1");
    const ownedHistoryTemp = `${ownedHistoryPath}.tmp-4200-8`;
    const adjacentHistoryTemp = `${historyLogPath(logsDir, "thread-10")}.tmp-4200-8`;
    const unknownSuffix = `${ownedHistoryPath}.tmp-manual`;
    fs.writeFileSync(ownedHistoryTemp, "orphaned history");
    fs.writeFileSync(adjacentHistoryTemp, "adjacent thread");
    fs.writeFileSync(unknownSuffix, "unknown transaction suffix");

    await manager.close({ threadId: "thread-1", deleteHistory: true });

    expect(fs.existsSync(ownedHistoryTemp)).toBe(false);
    expect(fs.readFileSync(adjacentHistoryTemp, "utf8")).toBe("adjacent thread");
    expect(fs.readFileSync(unknownSuffix, "utf8")).toBe("unknown transaction suffix");
    await manager.dispose();
  });

  it("escalates terminal shutdown to SIGKILL when process does not exit in time", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 10 });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.close({ threadId: "thread-1" });
    await waitFor(() => process.killSignals.includes("SIGKILL"));

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).toContain("SIGKILL");

    await manager.dispose();
  });

  it("waits for asynchronous process-tree capture before signaling terminal shutdown", async () => {
    const capturedTree = deferred<{
      descendants: Array<{ pid: number; command: string }>;
      captureComplete: boolean;
    }>();
    const treeSignals: string[] = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => capturedTree.promise,
      signal: ({ signal }) => {
        treeSignals.push(signal);
      },
    };
    const { manager, ptyAdapter } = makeManager(5, { processTreeKiller });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    const close = manager.close({ threadId: "thread-1" });
    await Promise.resolve();
    expect(process.killSignals).toEqual([]);
    expect(treeSignals).toEqual([]);

    capturedTree.resolve({ descendants: [], captureComplete: true });
    await close;

    expect(treeSignals).toEqual(["SIGTERM"]);
    expect(process.killSignals).toEqual(["SIGTERM"]);
    await manager.dispose();
  });

  it("discards descendants captured after the owned terminal root exits", async () => {
    const captureStarted = deferred<void>();
    const capturedTree = deferred<CapturedProcessTree>();
    const treeSignals: Array<{
      signal: TerminalKillSignal;
      includeRootTree: boolean | undefined;
      descendantPids: number[];
    }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => {
        captureStarted.resolve();
        return capturedTree.promise;
      },
      signal: ({ signal, includeRootTree, tree }) => {
        treeSignals.push({
          signal,
          includeRootTree,
          descendantPids: tree.descendants.map(({ pid }) => pid),
        });
      },
    };
    const { manager, ptyAdapter } = makeManager(5, { processTreeKiller });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    const close = manager.close({ threadId: "thread-1" });
    await captureStarted.promise;
    process.emitExit({ exitCode: 0, signal: 15 });
    capturedTree.resolve({
      descendants: [{ pid: 4242, command: "unrelated-reused-root-child" }],
      captureComplete: true,
    });
    await close;

    expect(treeSignals).toEqual([
      { signal: "SIGTERM", includeRootTree: false, descendantPids: [] },
    ]);
    expect(process.killSignals).toEqual([]);
    await manager.dispose();
  });

  it("cancels SIGKILL escalation when the process exits after SIGTERM", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 30 });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.close({ threadId: "thread-1" });
    process.emitExit({ exitCode: 0, signal: 15 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).not.toContain("SIGKILL");

    await manager.dispose();
  });

  it("keeps captured-child SIGKILL escalation after root exit without re-signaling the root", async () => {
    const treeSignals: Array<{
      rootPid: number;
      signal: string;
      descendantPids: number[];
      includeRootTree: boolean | undefined;
    }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({
        descendants: [{ pid: 4242, command: "tsdown --watch --clean" }],
      }),
      signal: ({ rootPid, signal, tree, includeRootTree }) => {
        treeSignals.push({
          rootPid,
          signal,
          descendantPids: tree.descendants.map((descendant) => descendant.pid),
          includeRootTree,
        });
      },
    };
    const { manager, ptyAdapter } = makeManager(5, {
      processKillGraceMs: 10,
      processTreeKiller,
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.close({ threadId: "thread-1" });
    process.emitExit({ exitCode: 0, signal: 15 });
    await waitFor(() => treeSignals.some((entry) => entry.signal === "SIGKILL"));

    expect(treeSignals).toContainEqual({
      rootPid: process.pid,
      signal: "SIGKILL",
      descendantPids: [4242],
      includeRootTree: false,
    });
    expect(process.killSignals).toEqual(["SIGTERM"]);

    await manager.dispose();
  });

  it("rechecks root exit while asynchronous forced tree signaling is in flight", async () => {
    const forcedSignalStarted = deferred<void>();
    const releaseForcedSignal = deferred<void>();
    const rootSignalDecisions: boolean[] = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({
        descendants: [{ pid: 4242, command: "tsdown --watch --clean" }],
        captureComplete: true,
      }),
      signal: async ({ signal, shouldSignalRootTree }) => {
        if (signal !== "SIGKILL") return;
        forcedSignalStarted.resolve();
        await releaseForcedSignal.promise;
        rootSignalDecisions.push(shouldSignalRootTree?.() ?? true);
      },
    };
    const { manager, ptyAdapter } = makeManager(5, {
      processKillGraceMs: 10,
      processTreeKiller,
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.close({ threadId: "thread-1" });
    await forcedSignalStarted.promise;
    process.emitExit({ exitCode: 0, signal: 15 });
    releaseForcedSignal.resolve();
    await waitFor(() => rootSignalDecisions.length === 1);

    expect(rootSignalDecisions).toEqual([false]);
    expect(process.killSignals).toEqual(["SIGTERM"]);
    await manager.dispose();
  });

  it("shutdown disposal waits for kill escalation before returning", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 10 });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.disposeForShutdown();

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).toContain("SIGKILL");
  });

  it("bounds hanging tree-signal callbacks before shutdown disposal returns", async () => {
    const abortSignals: Array<{
      signal: TerminalKillSignal;
      abortSignal: AbortSignal | undefined;
    }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      signal: ({ signal, abortSignal }) => {
        abortSignals.push({ signal, abortSignal });
        return new Promise(() => undefined);
      },
    };
    const { manager, ptyAdapter } = makeManager(5, {
      processKillGraceMs: 5,
      processTreeKiller,
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.disposeForShutdown();

    expect(abortSignals.map(({ signal }) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(abortSignals.every(({ abortSignal }) => abortSignal?.aborted === true)).toBe(true);
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("returns an awaitable public disposal that waits for asynchronous process capture", async () => {
    const capturedTree = deferred<{
      descendants: Array<{ pid: number; command: string }>;
      captureComplete: boolean;
    }>();
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => capturedTree.promise,
      signal: () => undefined,
    };
    const { manager, ptyAdapter } = makeManager(5, { processTreeKiller });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;

    const disposal = manager.dispose();

    expect(disposal).toBeInstanceOf(Promise);
    expect(sessions.size).toBe(1);
    process.emitExit({ exitCode: 0, signal: 15 });
    capturedTree.resolve({ descendants: [], captureComplete: true });
    await disposal;

    expect(sessions.size).toBe(0);
  });

  it("keeps sessions addressable until asynchronous shutdown stops settle", async () => {
    const capturedTree = deferred<{
      descendants: Array<{ pid: number; command: string }>;
      captureComplete: boolean;
    }>();
    const treeSignals: Array<{ signal: string; includeRootTree: boolean | undefined }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => capturedTree.promise,
      signal: ({ signal, includeRootTree }) => {
        treeSignals.push({ signal, includeRootTree });
      },
    };
    const { manager, ptyAdapter } = makeManager(5, { processTreeKiller });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;

    const shutdown = manager.disposeForShutdown();

    expect(sessions.size).toBe(1);
    process.emitExit({ exitCode: 0, signal: 15 });
    expect(sessions.size).toBe(1);

    capturedTree.resolve({ descendants: [], captureComplete: true });
    await shutdown;

    expect(treeSignals).toEqual([{ signal: "SIGTERM", includeRootTree: false }]);
    expect(process.killSignals).toEqual([]);
    expect(sessions.size).toBe(0);
  });

  it("flushes pending output before shutdown removes terminal event clocks", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 10 });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => events.push(event));
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("pending-before-shutdown");

    await manager.disposeForShutdown();

    expect(events.find((event) => event.type === "output")).toMatchObject({
      type: "output",
      sequence: 2,
      data: "pending-before-shutdown",
    });
    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).toContain("SIGKILL");
  });

  it("evicts oldest inactive terminal sessions when retention limit is exceeded", async () => {
    const { manager, ptyAdapter } = makeManager(5, { maxRetainedInactiveSessions: 1 });

    await manager.open(openInput({ threadId: "thread-1" }));
    await manager.open(openInput({ threadId: "thread-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    first.emitExit({ exitCode: 0, signal: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    second.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => {
      const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
      return sessions.size === 1;
    });

    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    const keys = [...sessions.keys()];
    expect(keys).toEqual(["thread-2\u0000default"]);

    await manager.dispose();
  });

  it("migrates legacy transcript filenames to terminal-scoped history path on open", async () => {
    const { manager, logsDir } = makeManager();
    const legacyPath = path.join(logsDir, "thread-1.log");
    const nextPath = historyLogPath(logsDir);
    fs.writeFileSync(legacyPath, "legacy-line\n", "utf8");

    const snapshot = await manager.open(openInput());

    expect(snapshot.history).toBe("legacy-line\n");
    expect(snapshot.recoveredCols).toBeUndefined();
    expect(snapshot.recoveredRows).toBeUndefined();
    expect(snapshot.historyRecordIdentity).toBeUndefined();
    expect(fs.existsSync(nextPath)).toBe(true);
    expect(fs.readFileSync(nextPath, "utf8")).toBe("legacy-line\n");
    expect(fs.existsSync(terminalHistoryMetadataPath(nextPath))).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(nextPath).mode & 0o777).toBe(0o600);
    }

    await manager.dispose();
  });

  it("preserves POSIX parsing and fallback when the preferred shell spawn fails", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellPlatform: "linux",
      shellResolver: () => "/definitely/missing-shell -l",
    });
    ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
    expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/definitely/missing-shell");
    expect(
      ptyAdapter.spawnInputs.some((input) =>
        ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"].includes(input.shell),
      ),
    ).toBe(true);

    await manager.dispose();
  });

  it("emits nested PTY spawn failure details", async () => {
    const { manager, ptyAdapter } = makeManager(5, { shellPlatform: "linux" });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    ptyAdapter.spawnFailures.push(new Error("native binding missing"));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("error");
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.message === "Failed to spawn PTY process: native binding missing",
      ),
    ).toBe(true);

    await manager.dispose();
  });

  it("filters app runtime env variables from terminal sessions", async () => {
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string | undefined) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }
      if (value === undefined) {
        delete process.env[key];
        return;
      }
      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    setEnv("PORT", "5173");
    setEnv("SYNARA_PORT", "3773");
    setEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
    setEnv("TEST_TERMINAL_KEEP", "keep-me");

    try {
      const { manager, ptyAdapter } = makeManager();
      await manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.SYNARA_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");

      await manager.dispose();
    } finally {
      restoreEnv();
    }
  });

  it("pins TERM to the embedded renderer and drops host-terminal identity env", async () => {
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }
      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    setEnv("TERM", "xterm-ghostty");
    setEnv("TERM_PROGRAM", "ghostty");
    setEnv("TERMINFO", "/Applications/Ghostty.app/Contents/Resources/terminfo");
    setEnv("GHOSTTY_RESOURCES_DIR", "/Applications/Ghostty.app/Contents/Resources");

    try {
      const { manager, ptyAdapter } = makeManager();
      await manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.TERM).toBe(
        process.platform === "win32" ? "xterm-color" : "xterm-256color",
      );
      expect(spawnInput.env.TERM_PROGRAM).toBeUndefined();
      expect(spawnInput.env.TERMINFO).toBeUndefined();
      expect(spawnInput.env.GHOSTTY_RESOURCES_DIR).toBeUndefined();

      await manager.dispose();
    } finally {
      restoreEnv();
    }
  });

  it("injects runtime env overrides into spawned terminals", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(
      openInput({
        env: {
          SYNARA_PROJECT_ROOT: "/repo",
          SYNARA_WORKTREE_PATH: "/repo/worktree-a",
          CUSTOM_FLAG: "1",
        },
      }),
    );
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.env.SYNARA_PROJECT_ROOT).toBe("/repo");
    expect(spawnInput.env.SYNARA_WORKTREE_PATH).toBe("/repo/worktree-a");
    expect(spawnInput.env.CUSTOM_FLAG).toBe("1");

    await manager.dispose();
  });

  it("starts zsh as a login shell with prompt spacer disabled", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellPlatform: "linux",
      shellResolver: () => "/bin/zsh",
    });
    await manager.open(openInput());
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.shell).toBe("/bin/zsh");
    expect(spawnInput.args).toEqual(["-l", "-o", "nopromptsp"]);

    await manager.dispose();
  });
});
