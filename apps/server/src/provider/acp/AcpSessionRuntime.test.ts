import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  assistantItemId,
  awaitAcpChildExit,
  decodeSetSessionConfigOptionResponse,
  makeAcpIncomingFrameGuard,
  makeRetryableAcpChildTeardown,
  sessionConfigOptionsFromSetup,
  teardownAcpChildProcess,
} from "./AcpSessionRuntime.ts";
import { teardownProviderProcessTree } from "../supervisedProcessTeardown.ts";
import { markWindowsProviderProcessSpawn } from "../windowsProviderProcess.ts";

describe("makeAcpIncomingFrameGuard", () => {
  const encode = (value: string) => new TextEncoder().encode(value);

  it("enforces the frame budget across split chunks and resets it at newline boundaries", () => {
    const guard = makeAcpIncomingFrameGuard(5);

    expect(guard(encode("123"))).toBeUndefined();
    expect(guard(encode("45\n12345\n"))).toBeUndefined();
    expect(guard(encode("1\n"))).toBeUndefined();
  });

  it("rejects an oversized unterminated frame", () => {
    const guard = makeAcpIncomingFrameGuard(5);

    expect(guard(encode("123"))).toBeUndefined();
    const error = guard(encode("456"));
    expect(error?._tag).toBe("AcpTransportError");
    expect(error?.detail).toContain("5-byte limit");
  });
});

describe("teardownAcpChildProcess", () => {
  it("registers exact teardown before honoring a queued post-spawn interruption", async () => {
    const childPid = 4_246;
    const acquiredSpawn = Promise.withResolvers<void>();
    const releaseSpawn = Promise.withResolvers<void>();
    const awaitStage = async <A>(stage: string, promise: Promise<A>): Promise<A> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              releaseSpawn.resolve();
              reject(new Error(`Timed out waiting for ACP test stage: ${stage}`));
            }, 3_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const teardownPids: number[] = [];
    let capturedTeardown:
      | Effect.Effect<{
          readonly escalated: boolean;
          readonly signalErrors: Error[];
        }>
      | undefined;
    const childExited = Deferred.makeUnsafe<ChildProcessSpawner.ExitCode>();
    const child = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(childPid),
      exitCode: Deferred.await(childExited),
      isRunning: Effect.succeed(true),
      kill: () =>
        Deferred.succeed(childExited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.promise(async () => {
          acquiredSpawn.resolve();
          await releaseSpawn.promise;
          return child;
        }),
      ),
    );
    const runtimeLayer = AcpSessionRuntime.layer({
      spawn: { command: process.execPath, args: [] },
      cwd: process.cwd(),
      clientInfo: { name: "synara-test", version: "1.0.0" },
      teardownProcessTree: async (input) => {
        teardownPids.push(input.rootPid);
        return { escalated: false, signalErrors: [] };
      },
      captureProcessTeardown: (teardown) => {
        capturedTeardown = teardown;
      },
    }).pipe(Layer.provide(spawnerLayer));
    const runtimeFiber = Effect.runFork(
      Effect.gen(function* () {
        yield* AcpSessionRuntime;
      }).pipe(Effect.provide(runtimeLayer), Effect.scoped),
    );

    await awaitStage("spawn acquisition", acquiredSpawn.promise);
    const interrupting = Effect.runPromise(Fiber.interrupt(runtimeFiber));
    await Promise.resolve();
    const capturedBeforeRelease = capturedTeardown;
    releaseSpawn.resolve();
    await awaitStage("interruption cleanup", interrupting);

    expect(capturedBeforeRelease).toBeUndefined();
    expect(capturedTeardown).toBeDefined();
    expect(teardownPids).toEqual([childPid]);
    const runtimeExit = runtimeFiber.pollUnsafe();
    expect(runtimeExit).toBeDefined();
    expect(
      runtimeExit && Exit.isFailure(runtimeExit) ? Cause.hasInterrupts(runtimeExit.cause) : false,
    ).toBe(true);

    await Effect.runPromise(capturedTeardown!);
    expect(teardownPids).toEqual([childPid]);
  });

  it("keeps ACP scope closure pending until the owned root exit settles", async () => {
    const processExited = Deferred.makeUnsafe<number>();
    const exitCode = Deferred.await(processExited);
    let observeTeardown!: (input: {
      readonly rootPid: number;
      readonly rootExited: Promise<unknown>;
    }) => void;
    const teardownStarted = new Promise<{
      readonly rootPid: number;
      readonly rootExited: Promise<unknown>;
    }>((resolve) => {
      observeTeardown = resolve;
    });
    const scope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(
      Effect.addFinalizer(() =>
        teardownAcpChildProcess({ pid: 4_242, exitCode }, async (input) => {
          observeTeardown(input);
          await input.rootExited;
          return { escalated: false, signalErrors: [] };
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    let scopeClosed = false;
    const closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
      scopeClosed = true;
    });
    const teardown = await teardownStarted;
    expect(teardown.rootPid).toBe(4_242);
    await Promise.resolve();
    expect(scopeClosed).toBe(false);

    Deferred.doneUnsafe(processExited, Effect.succeed(0));
    await closing;
    expect(scopeClosed).toBe(true);
  });

  it("accepts ACP Job-empty receipt proof when exit settles during signaling", async () => {
    let captureCalls = 0;
    let signalCalls = 0;
    const processExited = Deferred.makeUnsafe<number>();
    const receiptDirectory = mkdtempSync(join(tmpdir(), "synara-acp-job-receipt-"));
    const completionReceipt = {
      path: join(receiptDirectory, "job-empty.receipt"),
      token: "acp-job-empty-proof",
    };
    writeFileSync(completionReceipt.path, `${completionReceipt.token}\n4243\n`, "utf8");
    const child = markWindowsProviderProcessSpawn(
      { pid: 4_243, exitCode: Deferred.await(processExited) },
      {
        command: "C:\\Synara\\synara-windows-job-launcher.exe",
        args: [],
        shell: false,
        containment: "windows-job-object",
        completionReceipt,
      },
      true,
    );

    try {
      await expect(
        Effect.runPromise(
          teardownAcpChildProcess(child, (input) =>
            teardownProviderProcessTree(
              { ...input, termGraceMs: 5, forceExitMs: 5 },
              {
                processTreeKiller: {
                  capture: () => {
                    captureCalls += 1;
                    throw new Error("capture must not run for an exited ACP launcher");
                  },
                  signal: async () => {
                    signalCalls += 1;
                    Deferred.doneUnsafe(processExited, Effect.succeed(0));
                    return { rootTreeSignalSucceeded: false };
                  },
                },
              },
            ),
          ),
        ),
      ).resolves.toEqual({ escalated: false, signalErrors: [] });
      expect(captureCalls).toBe(0);
      expect(signalCalls).toBe(1);
    } finally {
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("retries failed cleanup against the same owned child and latches success", async () => {
    const child = { pid: 4_244, exitCode: Effect.succeed(0) };
    const cleanupError = new Error("cleanup proof rejected");
    const observedRootPids: number[] = [];
    const teardown = makeRetryableAcpChildTeardown(child, async (input) => {
      observedRootPids.push(input.rootPid);
      if (observedRootPids.length === 1) {
        throw cleanupError;
      }
      return { escalated: false, signalErrors: [] };
    });

    await expect(Effect.runPromise(teardown)).rejects.toBe(cleanupError);
    await expect(Effect.runPromise(teardown)).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    await expect(Effect.runPromise(teardown)).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(observedRootPids).toEqual([4_244, 4_244]);
  });

  it("shares one exact-child cleanup attempt across concurrent callers", async () => {
    const child = { pid: 4_245, exitCode: Effect.succeed(0) };
    const result = { escalated: false, signalErrors: [] };
    let cleanupCalls = 0;
    let notifyCleanupStarted!: () => void;
    let finishCleanup!: (value: typeof result) => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      notifyCleanupStarted = resolve;
    });
    const cleanupResult = new Promise<typeof result>((resolve) => {
      finishCleanup = resolve;
    });
    const teardown = makeRetryableAcpChildTeardown(child, (input) => {
      expect(input.rootPid).toBe(child.pid);
      cleanupCalls += 1;
      notifyCleanupStarted();
      return cleanupResult;
    });

    const first = Effect.runPromise(teardown);
    const second = Effect.runPromise(teardown);
    await cleanupStarted;
    expect(cleanupCalls).toBe(1);

    finishCleanup(result);
    await expect(Promise.all([first, second])).resolves.toEqual([result, result]);
    await expect(Effect.runPromise(teardown)).resolves.toBe(result);
    expect(cleanupCalls).toBe(1);
  });
});

describe("awaitAcpChildExit", () => {
  it("completes for both successful and failed child exit signals", async () => {
    const successfulExit = Deferred.makeUnsafe<number>();
    const failedExit = Deferred.makeUnsafe<number, Error>();
    let successfulCompleted = false;
    let failedCompleted = false;

    const successfulWait = Effect.runPromise(
      awaitAcpChildExit({ pid: 1, exitCode: Deferred.await(successfulExit) }),
    ).then(() => {
      successfulCompleted = true;
    });
    const failedWait = Effect.runPromise(
      awaitAcpChildExit({ pid: 2, exitCode: Deferred.await(failedExit) }),
    ).then(() => {
      failedCompleted = true;
    });

    await Promise.resolve();
    expect(successfulCompleted).toBe(false);
    expect(failedCompleted).toBe(false);

    Deferred.doneUnsafe(successfulExit, Effect.succeed(0));
    Deferred.doneUnsafe(failedExit, Effect.fail(new Error("child exit signal failed")));
    await Promise.all([successfulWait, failedWait]);

    expect(successfulCompleted).toBe(true);
    expect(failedCompleted).toBe(true);
  });
});

describe("assistantItemId", () => {
  // Format contract only — distinct runtimeInstanceId wiring is covered by
  // AcpJsonRpcConnection.test.ts ("assigns distinct fallback assistant item ids...").
  it("produces distinct ids across runtime instances with the same session id and segment index", () => {
    const sessionId = "session-1";
    const a = assistantItemId(sessionId, "aaaa1111", 0);
    const b = assistantItemId(sessionId, "bbbb2222", 0);
    expect(a).not.toBe(b);
    expect(a).toBe("assistant:session-1:aaaa1111:segment:0");
    expect(b).toBe("assistant:session-1:bbbb2222:segment:0");
  });
});

describe("decodeSetSessionConfigOptionResponse", () => {
  const configOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-5.6-luna",
      options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
    },
  ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

  it("uses the matching config update for an empty response", () => {
    const decoded = Effect.runSync(
      decodeSetSessionConfigOptionResponse({}, Effect.succeed(configOptions)),
    );
    expect(decoded).toEqual({ configOptions });
  });

  it("strictly decodes a non-empty response without awaiting an update", () => {
    let awaitedUpdate = false;
    const decoded = Effect.runSync(
      decodeSetSessionConfigOptionResponse(
        { configOptions },
        Effect.sync(() => {
          awaitedUpdate = true;
          return [];
        }),
      ),
    );
    expect(decoded).toEqual({ configOptions });
    expect(awaitedUpdate).toBe(false);
  });

  it("rejects an invalid non-empty response", async () => {
    const error = await Effect.runPromise(
      decodeSetSessionConfigOptionResponse(
        { unexpected: true },
        Effect.succeed(configOptions),
      ).pipe(Effect.flip),
    );
    expect(error._tag).toBe("AcpTransportError");
    if (error._tag === "AcpTransportError") {
      expect(error.detail).toContain("invalid session/set_config_option response");
    }
  });
});

describe("sessionConfigOptionsFromSetup", () => {
  const replayedConfigOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-5.6-luna",
      options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
    },
  ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

  it("preserves config retained from replay when setup omits configOptions", () => {
    expect(sessionConfigOptionsFromSetup({}, replayedConfigOptions)).toBe(replayedConfigOptions);
  });

  it("uses an explicit setup inventory instead of replayed config", () => {
    expect(sessionConfigOptionsFromSetup({ configOptions: [] }, replayedConfigOptions)).toEqual([]);
  });
});
