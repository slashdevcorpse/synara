import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type {
  CapturedProcess,
  CapturedProcessTree,
  ProcessTreeKiller,
  TerminalKillSignal,
} from "../terminal/processTreeKiller";
import {
  ProviderProcessExitUnprovenError,
  superviseEffectProcessTree,
  teardownEffectProcessTree,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown";

function deterministicClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("teardownProviderProcessTree", () => {
  it("does not convert a failed Effect exit watcher into false exit proof", async () => {
    const watcherFailure = new Error("provider exit watcher failed");

    await expect(
      teardownEffectProcessTree(
        {
          pid: 91,
          exitCode: Effect.die(watcherFailure),
        },
        async ({ rootExited }) => {
          await expect(rootExited).rejects.toBe(watcherFailure);
          return { escalated: false, signalErrors: [] };
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
  });

  it("accepts signal-driven exit failure only when the owned handle proves it stopped", async () => {
    const signalExit = new Error("Process interrupted due to receipt of signal: 'SIGTERM'");

    await expect(
      teardownEffectProcessTree(
        {
          pid: 92,
          exitCode: Effect.fail(signalExit),
          isRunning: Effect.succeed(false),
        },
        async ({ rootExited }) => {
          await expect(rootExited).resolves.toBeUndefined();
          return { escalated: false, signalErrors: [] };
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
  });

  it("escalates ignored TERM and returns only after root and descendants prove exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 102, command: "provider-worker" }],
      captureComplete: true,
    };
    const runningDescendants = new Map<number, CapturedProcess>([[102, tree.descendants[0]!]]);
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({ verified: true, survivors: [...runningDescendants.values()] }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGKILL") {
          runningDescendants.clear();
          resolveRootExit?.();
        }
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 101, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: true },
      { signal: "SIGKILL", includeRootTree: true },
    ]);
  });

  it("force-kills captured descendants without re-signalling a root that exited after TERM", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 202, command: "provider-grandchild" }],
      captureComplete: true,
    };
    let descendantsRunning = true;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({
        verified: true,
        survivors: descendantsRunning ? tree.descendants : [],
      }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGTERM") resolveRootExit?.();
        if (signal === "SIGKILL") descendantsRunning = false;
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 201, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(signals.at(-1)).toEqual({ signal: "SIGKILL", includeRootTree: false });
  });

  it("does not signal a root PID whose exit was already proven before teardown", async () => {
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      inspect: () => ({ verified: true, survivors: [] }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 251, rootExited: Promise.resolve(), termGraceMs: 5, forceExitMs: 5 },
        { processTreeKiller, ...clock },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(signals).toEqual([{ signal: "SIGTERM", includeRootTree: false }]);
  });

  it("refreshes ownership after TERM before proving a late child exited", async () => {
    const lateChild: CapturedProcess = {
      pid: 272,
      command: "provider-late-child",
      identity: "272:late-start",
    };
    let lateChildRunning = false;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: TerminalKillSignal[] = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({ descendants: [], captureComplete: true }),
      inspect: (tree) => ({
        verified: true,
        survivors: lateChildRunning
          ? tree.descendants.filter(({ pid }) => pid === lateChild.pid)
          : [],
      }),
      signal: ({ signal }) => {
        signals.push(signal);
        if (signal === "SIGTERM") {
          lateChildRunning = true;
          resolveRootExit?.();
        } else {
          lateChildRunning = false;
        }
      },
    };
    const clock = deterministicClock();
    let refreshes = 0;

    await expect(
      teardownProviderProcessTree(
        {
          rootPid: 271,
          rootExited,
          capturedTree: { descendants: [], captureComplete: true },
          refreshCapturedTree: async () => {
            refreshes += 1;
            return {
              descendants: lateChildRunning ? [lateChild] : [],
              captureComplete: true,
            };
          },
          termGraceMs: 5,
          forceExitMs: 5,
        },
        { processTreeKiller, ...clock },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(refreshes).toBeGreaterThanOrEqual(2);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails closed when forced termination cannot prove process-tree exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 302, command: "stuck-provider" }],
      captureComplete: true,
    };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 301, rootExited: new Promise(() => undefined), termGraceMs: 5, forceExitMs: 5 },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: tree.descendants }),
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      name: "ProviderProcessExitUnprovenError",
      rootPid: 301,
      rootExited: false,
      remainingDescendantPids: [302],
    });
  });
});

describe("superviseEffectProcessTree", () => {
  function controllableEffectProcess(pid: number) {
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    return {
      process: {
        pid,
        exitCode: Effect.promise(() => exited),
      },
      exit: () => resolveExit?.(),
    };
  }

  it("proves normal root success only after every live-captured descendant exits", async () => {
    const owned = controllableEffectProcess(501);
    const root: CapturedProcess = {
      pid: 501,
      command: "provider updater",
      identity: "501:root-start",
    };
    const child: CapturedProcess = {
      pid: 502,
      command: "provider postinstall",
      identity: "502:child-start",
    };
    let rootAlive = true;
    let childAlive = true;
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({
        ...(rootAlive ? { root } : {}),
        descendants: childAlive ? [child] : [],
        captureComplete: true,
      }),
      inspect: (tree) => ({
        verified: true,
        survivors: childAlive ? tree.descendants.filter(({ pid }) => pid === child.pid) : [],
      }),
      signal: () => undefined,
    };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller,
      platform: "win32",
      capturePollMs: 1,
      proofTimeoutMs: 5,
    });

    rootAlive = false;
    owned.exit();
    const failure = await supervisor.proveExit().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 501,
      rootExited: true,
      remainingDescendantPids: [502],
      captureComplete: true,
    });

    childAlive = false;
  });

  it("bounds background ownership capture to one delayed startup refresh", async () => {
    const owned = controllableEffectProcess(551);
    const root: CapturedProcess = {
      pid: 551,
      command: "provider session",
      identity: "551:root-start",
    };
    let releaseStartupCapture: (() => void) | undefined;
    const startupCaptureDelay = new Promise<void>((resolve) => {
      releaseStartupCapture = resolve;
    });
    let asynchronousCaptures = 0;
    const tree = { root, descendants: [], captureComplete: true };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => tree,
        captureAsync: async () => {
          asynchronousCaptures += 1;
          return tree;
        },
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      platform: "win32",
      sleep: () => startupCaptureDelay,
    });

    releaseStartupCapture?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(asynchronousCaptures).toBe(1);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(asynchronousCaptures).toBe(1);
    owned.exit();
    await expect(supervisor.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(asynchronousCaptures).toBe(2);
  });

  it("uses the injected process-tree killer for default teardown signalling", async () => {
    const owned = controllableEffectProcess(2_147_483_647);
    const root: CapturedProcess = {
      pid: 2_147_483_647,
      command: "synthetic provider",
      identity: "2147483647:root-start",
    };
    const signals: TerminalKillSignal[] = [];
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => ({ root, descendants: [], captureComplete: true }),
        inspect: () => ({ verified: true, survivors: [] }),
        signal: ({ signal }) => {
          signals.push(signal);
          owned.exit();
        },
      },
      platform: "win32",
      capturePollMs: 60_000,
    });

    await expect(supervisor.teardown()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("accepts normal root success when every live-captured descendant is gone", async () => {
    const owned = controllableEffectProcess(601);
    const root: CapturedProcess = {
      pid: 601,
      command: "provider updater",
      identity: "601:root-start",
    };
    const child: CapturedProcess = {
      pid: 602,
      command: "provider postinstall",
      identity: "602:child-start",
    };
    let rootAlive = true;
    let childAlive = true;
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({
        ...(rootAlive ? { root } : {}),
        descendants: childAlive ? [child] : [],
        captureComplete: true,
      }),
      inspect: (tree) => ({
        verified: true,
        survivors: childAlive ? tree.descendants.filter(({ pid }) => pid === child.pid) : [],
      }),
      signal: () => undefined,
    };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller,
      platform: "win32",
      capturePollMs: 1,
      proofTimeoutMs: 5,
    });

    rootAlive = false;
    childAlive = false;
    owned.exit();

    await expect(supervisor.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
  });

  it("proves a signal-driven exit after the owned handle reports it stopped", async () => {
    const root: CapturedProcess = {
      pid: 651,
      command: "provider updater",
      identity: "651:root-start",
    };
    let rootAlive = true;
    const supervisor = superviseEffectProcessTree(
      {
        pid: 651,
        exitCode: Effect.fail(new Error("Process interrupted due to receipt of signal: 'SIGTERM'")),
        isRunning: Effect.succeed(false),
      },
      {
        processTreeKiller: {
          capture: () => ({ ...(rootAlive ? { root } : {}), descendants: [] }),
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        platform: "win32",
        capturePollMs: 1,
        proofTimeoutMs: 5,
      },
    );

    rootAlive = false;
    await expect(supervisor.proveExit()).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
  });

  it("fails closed on POSIX when the updater has no explicitly owned process group", async () => {
    const owned = controllableEffectProcess(701);
    let rootAlive = true;
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => ({
        ...(rootAlive
          ? {
              root: {
                pid: 701,
                command: "provider updater",
                identity: "701:root-start",
              },
            }
          : {}),
        descendants: [],
        captureComplete: true,
      }),
      inspect: () => ({ verified: true, survivors: [] }),
      signal: () => undefined,
    };
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller,
      platform: "linux",
      capturePollMs: 1,
      proofTimeoutMs: 5,
    });

    rootAlive = false;
    owned.exit();
    const failure = await supervisor.proveExit().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 701,
      rootExited: true,
      remainingDescendantPids: [],
      captureComplete: false,
    });
  });

  it("keeps teardown single-flight while pending and retries a rejected proof", async () => {
    const owned = controllableEffectProcess(801);
    const root: CapturedProcess = {
      pid: 801,
      command: "provider updater",
      identity: "801:root-start",
    };
    const child: CapturedProcess = {
      pid: 802,
      command: "provider postinstall",
      identity: "802:child-start",
    };
    const capturedTrees: CapturedProcessTree[] = [];
    let releaseFirstAttempt: (() => void) | undefined;
    const firstAttemptGate = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    let teardownAttempts = 0;
    const supervisor = superviseEffectProcessTree(owned.process, {
      processTreeKiller: {
        capture: () => ({ root, descendants: [child], captureComplete: true }),
        inspect: () => ({ verified: true, survivors: [] }),
        signal: () => undefined,
      },
      teardownProcessTree: async (input) => {
        teardownAttempts += 1;
        capturedTrees.push(input.capturedTree ?? { descendants: [], captureComplete: false });
        if (teardownAttempts === 1) {
          await firstAttemptGate;
          throw new ProviderProcessExitUnprovenError({
            rootPid: 801,
            rootExited: false,
            remainingDescendantPids: [802],
            captureComplete: true,
          });
        }
        return { escalated: false, signalErrors: [] };
      },
      platform: "win32",
      capturePollMs: 1,
    });

    const first = supervisor.teardown();
    const concurrent = supervisor.teardown();
    expect(concurrent).toBe(first);
    releaseFirstAttempt?.();
    await expect(first).rejects.toBeInstanceOf(ProviderProcessExitUnprovenError);
    await expect(concurrent).rejects.toBeInstanceOf(ProviderProcessExitUnprovenError);

    const retry = supervisor.teardown();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(supervisor.teardown()).toBe(retry);
    expect(teardownAttempts).toBe(2);
    expect(capturedTrees).toHaveLength(2);
    expect(capturedTrees[0]?.descendants).toContainEqual(child);
    expect(capturedTrees[1]?.descendants).toContainEqual(child);
  });
});
