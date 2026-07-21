// FILE: opencodeRuntime.test.ts
// Purpose: Covers OpenCode runtime parsing and local server startup diagnostics.
// Layer: Provider runtime tests
// Exports: Vitest suites for opencodeRuntime.ts

import { Deferred, Duration, Effect, Exit, Fiber, Layer, Result, Scope, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { TestClock } from "effect/testing";
import { pathToFileURL } from "node:url";
import type { ChatAttachment } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildOpenCodeServerProcessEnv,
  type OpenCodeCompatibleCliSpec,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
  KILO_CLI_SPEC,
  makeOpenCodeRuntimeLive,
  OPENCODE_CLI_SPEC,
  OPENCODE_LOCAL_SERVER_IDLE_TTL_MS,
  parseOpenCodeCliModelsOutput,
  parseOpenCodeCredentialProviderIDs,
  toOpenCodeFileParts,
} from "./opencodeRuntime.ts";
import { ProviderProcessExitUnprovenError } from "./supervisedProcessTeardown.ts";
import type { CapturedProcessTree, ProcessTreeKiller } from "../terminal/processTreeKiller.ts";

const encoder = new TextEncoder();

const completeTestProcessTreeKiller: ProcessTreeKiller = {
  capture: (rootPid) => ({
    root: {
      pid: rootPid,
      command: "test provider process",
      identity: `${rootPid}:test-root`,
    },
    descendants: [],
    captureComplete: true,
  }),
  captureAsync: async (rootPid) => completeTestProcessTreeKiller.capture(rootPid),
  inspect: () => ({ verified: true, survivors: [] }),
  inspectAsync: async () => ({ verified: true, survivors: [] }),
  signal: () => undefined,
};

function makeTestOpenCodeRuntimeLive(
  options: Parameters<typeof makeOpenCodeRuntimeLive>[0] = {},
) {
  return makeOpenCodeRuntimeLive({
    processTreeKiller: completeTestProcessTreeKiller,
    netService: {
      canListenOnHost: () => Effect.succeed(true),
      isPortAvailableOnLoopback: () => Effect.succeed(true),
      reserveLoopbackPort: () => Effect.succeed(59_000),
      findAvailablePort: () => Effect.succeed(59_000),
    },
    ...options,
  });
}

function mockOpenCodeServerHandle(input: {
  stdout: string;
  stderr: string;
  pid?: number;
  exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, never>;
  kill?: () => Effect.Effect<void, never>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid ?? 1),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.succeed(true),
    kill: input.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.stdout)),
    stderr: Stream.make(encoder.encode(input.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockOpenCodeServerSpawnerLayer(input: { stdout: string; stderr: string }) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.succeed(mockOpenCodeServerHandle(input))),
  );
}

function mockPooledOpenCodeServerSpawnerLayer(state: {
  spawnUrls: Array<string>;
  spawnCwds?: Array<string | undefined>;
  killUrls: Array<string>;
  processUrls?: Map<number, string>;
  exitCodes?: Array<Effect.Effect<ChildProcessSpawner.ExitCode, never>>;
  startupStdouts?: Array<string>;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command?: string;
        options?: { cwd?: string };
      };
      const cliSpec =
        cmd.command === KILO_CLI_SPEC.defaultBinaryPath ? KILO_CLI_SPEC : OPENCODE_CLI_SPEC;
      const url = `http://127.0.0.1:${59000 + state.spawnUrls.length}`;
      const pid = 59_000 + state.spawnUrls.length;
      const exitCode = state.exitCodes?.shift();
      state.spawnUrls.push(url);
      state.spawnCwds?.push(cmd.options?.cwd);
      state.processUrls?.set(pid, url);
      return Effect.succeed(
        mockOpenCodeServerHandle({
          stdout: state.startupStdouts?.shift() ?? `${cliSpec.serverReadyPrefix} on ${url}\n`,
          stderr: "",
          pid,
          ...(exitCode !== undefined ? { exitCode } : {}),
          kill: () =>
            Effect.sync(() => {
              state.killUrls.push(url);
            }),
        }),
      );
    }),
  );
}

const advanceOpenCodePoolIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_LOCAL_SERVER_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

const advanceOpenCodePoolAlmostToIdle = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_LOCAL_SERVER_IDLE_TTL_MS - 1));
  yield* Effect.yieldNow;
});

function openCodeRuntimePoolTestLayer(state: {
  spawnUrls: Array<string>;
  killUrls: Array<string>;
}) {
  const processUrls = new Map<number, string>();
  return Layer.merge(
    makeTestOpenCodeRuntimeLive({
      teardownProcessTree: async ({ rootPid }) => {
        const url = processUrls.get(rootPid);
        if (url) state.killUrls.push(url);
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(Layer.provide(mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls }))),
    TestClock.layer(),
  );
}

function closeLocalServerPoolsForCliSpec(
  runtime: OpenCodeRuntimeShape,
  cliSpec: OpenCodeCompatibleCliSpec,
) {
  const closePools = runtime.closeLocalServerPoolsForCliSpec;
  if (closePools === undefined) {
    throw new Error("Expected live OpenCode runtime pool control API.");
  }
  return closePools({ cliSpec });
}

describe("toOpenCodeFileParts", () => {
  it("materializes image attachments as SDK file parts", () => {
    const attachmentPath = "/tmp/synara-attachments/screenshot.png";
    const attachment = {
      type: "image",
      id: "thread-attachment-image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 12,
    } satisfies ChatAttachment;

    expect(
      toOpenCodeFileParts({
        attachments: [attachment],
        resolveAttachmentPath: () => attachmentPath,
      }),
    ).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: pathToFileURL(attachmentPath).href,
      },
    ]);
  });

  it("leaves generic files for prompt-path projection", () => {
    const attachment = {
      type: "file",
      id: "thread-attachment-file",
      name: "notes.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 12,
    } satisfies ChatAttachment;

    expect(
      toOpenCodeFileParts({
        attachments: [attachment],
        resolveAttachmentPath: () => "/tmp/synara-attachments/notes.docx",
      }),
    ).toEqual([]);
  });
});

describe("buildOpenCodeServerProcessEnv", () => {
  it("does not override file-based config with synthetic empty config content", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        PATH: "/usr/bin",
      },
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("preserves an explicitly configured config-content environment value", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        OPENCODE_CONFIG_CONTENT: '{"provider":{"openai":{}}}',
      },
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"provider":{"openai":{}}}');
  });

  it("strips inherited Synara authority from managed server processes", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        OPENAI_API_KEY: "provider-key",
        SYNARA_AUTH_TOKEN: "server-secret",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/browser.sock",
      },
    });

    expect(env.OPENAI_API_KEY).toBe("provider-key");
    expect(env.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(env.SYNARA_BROWSER_USE_PIPE_PATH).toBeUndefined();
  });
});

describe("OpenCodeRuntime startup diagnostics", () => {
  it("detects the ready server URL in CRLF process output", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime.startOpenCodeServerProcess({ binaryPath: "/custom/bin/opencode" });
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout:
                  "booting custom OpenCode wrapper\r\n" +
                  "opencode server listening on http://127.0.0.1:59000\r\n",
                stderr: "",
              }),
            ),
          ),
        ),
      ),
    );

    expect(result.url).toBe("http://127.0.0.1:59000");
  });

  it("includes command and partial process output when server startup times out", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "/custom/bin/opencode",
              hostname: "127.0.0.1",
              port: 58123,
              timeoutMs: 5,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeTestOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "booting custom OpenCode wrapper\n",
                stderr: "loading provider credentials\n",
              }),
            ),
          ),
        ),
      ),
    );

    expect(OpenCodeRuntimeError.is(error)).toBe(true);
    expect(error.detail).toContain("Timed out waiting for OpenCode server start after 5ms.");
    expect(error.detail).toContain(
      "command: /custom/bin/opencode serve --hostname 127.0.0.1 --port 58123",
    );
    expect(error.detail).toContain('OpenCode ready prefix: "opencode server listening"');
    expect(error.detail).toContain("stdout:\nbooting custom OpenCode wrapper");
    expect(error.detail).toContain("stderr:\nloading provider credentials");
  });

  it("redacts likely secrets from startup timeout diagnostics and causes", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "/custom/bin/opencode",
              hostname: "127.0.0.1",
              port: 58123,
              timeoutMs: 5,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeTestOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "OPENAI_API_KEY=sk-live-123\nauth_token: token-abc\nsafe line\n",
                stderr: 'Authorization: Bearer auth-secret\nserverPassword="pw-secret"\n',
              }),
            ),
          ),
        ),
      ),
    );
    const causeJson = JSON.stringify(error.cause);

    expect(error.detail).toContain("OPENAI_API_KEY=[redacted]");
    expect(error.detail).toContain("auth_token: [redacted]");
    expect(error.detail).toContain("Authorization: Bearer [redacted]");
    expect(error.detail).toContain('serverPassword="[redacted]"');
    expect(error.detail).toContain("safe line");
    for (const secret of ["sk-live-123", "token-abc", "auth-secret", "pw-secret"]) {
      expect(error.detail).not.toContain(secret);
      expect(causeJson).not.toContain(secret);
    }
  });
});

describe("OpenCodeRuntime local server pool", () => {
  it("installs live process-tree supervision before honoring spawn-time interruption", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const spawnReported = yield* Deferred.make<void>();
          const rootExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const capturedDescendant = {
            pid: 2,
            command: "opencode worker",
            identity: "2:worker-start",
          };
          const processTreeKiller: ProcessTreeKiller = {
            capture: (rootPid) => ({
              root: {
                pid: rootPid,
                command: "opencode serve",
                identity: `${rootPid}:root-start`,
              },
              descendants: [capturedDescendant],
              captureComplete: true,
            }),
            captureAsync: async (rootPid) => processTreeKiller.capture(rootPid),
            inspect: () => ({ verified: true, survivors: [] }),
            inspectAsync: async () => ({ verified: true, survivors: [] }),
            signal: () => undefined,
          };
          let capturedTree: CapturedProcessTree | undefined;
          let markTeardownStarted: (() => void) | undefined;
          const teardownStarted = new Promise<void>((resolve) => {
            markTeardownStarted = resolve;
          });
          let allowTeardown: (() => void) | undefined;
          const teardownGate = new Promise<void>((resolve) => {
            allowTeardown = resolve;
          });
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Deferred.succeed(spawnReported, undefined).pipe(
                Effect.as(
                  mockOpenCodeServerHandle({
                    stdout: "starting opencode server\n",
                    stderr: "",
                    exitCode: Deferred.await(rootExit),
                  }),
                ),
              ),
            ),
          );
          const layer = makeTestOpenCodeRuntimeLive({
            processTreeKiller,
            teardownProcessTree: async (input) => {
              capturedTree = input.capturedTree;
              markTeardownStarted?.();
              await teardownGate;
              Effect.runSync(
                Deferred.succeed(rootExit, ChildProcessSpawner.ExitCode(0)),
              );
              return { escalated: false, signalErrors: [] };
            },
          }).pipe(Layer.provide(spawnerLayer));

          yield* Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            const startup = yield* Effect.scoped(
              runtime.startOpenCodeServerProcess({
                binaryPath: "opencode",
                timeoutMs: 60_000,
              }),
            ).pipe(Effect.forkChild);
            yield* Deferred.await(spawnReported);
            const interrupting = yield* Fiber.interrupt(startup).pipe(Effect.forkChild);
            yield* Effect.promise(() => teardownStarted);
            const interruptionWaitedForProof = interrupting.pollUnsafe() === undefined;

            allowTeardown?.();
            yield* Fiber.join(interrupting);

            expect(interruptionWaitedForProof).toBe(true);
            expect(capturedTree?.descendants).toContainEqual(capturedDescendant);
          }).pipe(Effect.provide(layer));
        }),
      ),
    );
  });

  it("retains fail-closed ownership when initial process-tree capture throws", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };
    const processUrls = new Map<number, string>();
    let captureCalls = 0;
    const processTreeKiller: ProcessTreeKiller = {
      capture: (rootPid) => {
        captureCalls += 1;
        if (captureCalls === 1) {
          throw new Error("initial process snapshot failed");
        }
        return {
          root: {
            pid: rootPid,
            command: "opencode serve",
            identity: `${rootPid}:root-start`,
          },
          descendants: [],
          captureComplete: true,
        };
      },
      captureAsync: async (rootPid) => processTreeKiller.capture(rootPid),
      inspect: () => ({ verified: true, survivors: [] }),
      inspectAsync: async () => ({ verified: true, survivors: [] }),
      signal: () => undefined,
    };
    const unprovenExit = new ProviderProcessExitUnprovenError({
      rootPid: 59_000,
      rootExited: false,
      remainingDescendantPids: null,
      captureComplete: false,
    });
    let teardownCalls = 0;
    const layer = makeTestOpenCodeRuntimeLive({
      processTreeKiller,
      teardownProcessTree: async ({ rootPid }) => {
        teardownCalls += 1;
        const url = processUrls.get(rootPid);
        if (url === undefined) {
          throw new Error(`Missing test URL for process ${rootPid}.`);
        }
        if (teardownCalls === 1) {
          throw unprovenExit;
        }
        state.killUrls.push(url);
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(
      Layer.provide(mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls })),
    );

    const runtimeExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            const failedScope = yield* Scope.make();
            const startup = yield* runtime
              .connectToOpenCodeServer({ binaryPath: "opencode" })
              .pipe(Effect.provideService(Scope.Scope, failedScope), Effect.result);
            expect(Result.isFailure(startup)).toBe(true);
            if (Result.isFailure(startup)) {
              expect(startup.failure.detail).toContain("Failed to install OpenCode server");
            }
            yield* Scope.close(failedScope, Exit.void);
            expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);
            expect(state.killUrls).toEqual([]);
            expect(teardownCalls).toBe(1);

            const refusedScope = yield* Scope.make();
            const refused = yield* runtime
              .connectToOpenCodeServer({ binaryPath: "opencode" })
              .pipe(Effect.provideService(Scope.Scope, refusedScope), Effect.result);
            expect(Result.isFailure(refused)).toBe(true);
            yield* Scope.close(refusedScope, Exit.void);
            expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

            yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);
            expect(teardownCalls).toBe(2);
            expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);

            const freshScope = yield* Scope.make();
            const fresh = yield* runtime
              .connectToOpenCodeServer({ binaryPath: "opencode" })
              .pipe(Effect.provideService(Scope.Scope, freshScope));
            expect(fresh.url).toBe("http://127.0.0.1:59001");
            yield* Scope.close(freshScope, Exit.void);
            yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);
            expect(state.killUrls).toEqual([
              "http://127.0.0.1:59000",
              "http://127.0.0.1:59001",
            ]);
          }),
        ).pipe(Effect.provide(layer)),
      ),
    );
    expect(Exit.isSuccess(runtimeExit)).toBe(true);
  });

  it("keeps server scope closure pending until process-tree exit is proven", async () => {
    let proveExit: (() => void) | undefined;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let markTeardownStarted: (() => void) | undefined;
    const teardownStarted = new Promise<void>((resolve) => {
      markTeardownStarted = resolve;
    });
    let teardownCalls = 0;
    const layer = makeTestOpenCodeRuntimeLive({
      teardownProcessTree: async ({ rootPid }) => {
        teardownCalls += 1;
        markTeardownStarted?.();
        expect(rootPid).toBe(1);
        await exitProof;
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(
      Layer.provide(
        mockOpenCodeServerSpawnerLayer({
          stdout: "opencode server listening on http://127.0.0.1:59000\n",
          stderr: "",
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const serverScope = yield* Scope.make("sequential");
          yield* runtime
            .startOpenCodeServerProcess({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, serverScope));

          const closing = yield* Scope.close(serverScope, Exit.void).pipe(Effect.forkChild);
          yield* Effect.promise(() => teardownStarted);
          const closingWaitedForProof = closing.pollUnsafe() === undefined;

          proveExit?.();
          yield* Fiber.join(closing);
          expect(teardownCalls).toBe(1);
          expect(closingWaitedForProof).toBe(true);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("retries and serializes direct server stop until process-tree exit is proven", async () => {
    const unprovenExit = new ProviderProcessExitUnprovenError({
      rootPid: 1,
      rootExited: false,
      remainingDescendantPids: [2],
      captureComplete: true,
    });
    let allowRetryExit: (() => void) | undefined;
    const retryExit = new Promise<void>((resolve) => {
      allowRetryExit = resolve;
    });
    let teardownCalls = 0;
    const layer = makeTestOpenCodeRuntimeLive({
      teardownProcessTree: async () => {
        teardownCalls += 1;
        if (teardownCalls === 1) {
          throw unprovenExit;
        }
        await retryExit;
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(
      Layer.provide(
        mockOpenCodeServerSpawnerLayer({
          stdout: "opencode server listening on http://127.0.0.1:59000\n",
          stderr: "",
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const serverScope = yield* Scope.make("sequential");
          const server = yield* runtime
            .startOpenCodeServerProcess({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, serverScope));

          const first = yield* server.stop.pipe(Effect.result);
          expect(Result.isFailure(first)).toBe(true);
          if (Result.isFailure(first)) {
            expect(first.failure).toBeInstanceOf(OpenCodeRuntimeError);
            expect(first.failure.cause).toBe(unprovenExit);
          }
          expect(teardownCalls).toBe(1);

          const retrying = yield* server.stop.pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const concurrent = yield* server.stop.pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(teardownCalls).toBe(2);

          allowRetryExit?.();
          yield* Fiber.join(retrying);
          yield* Fiber.join(concurrent);
          yield* server.stop;
          yield* Scope.close(serverScope, Exit.void);
          expect(teardownCalls).toBe(2);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("waits for process-tree exit proof when closing an idle target pool", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };
    const processUrls = new Map<number, string>();
    let proveExit: (() => void) | undefined;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let markTeardownStarted: (() => void) | undefined;
    const teardownStarted = new Promise<void>((resolve) => {
      markTeardownStarted = resolve;
    });
    let teardownCalls = 0;
    const layer = Layer.merge(
      makeTestOpenCodeRuntimeLive({
        teardownProcessTree: async ({ rootPid }) => {
          teardownCalls += 1;
          markTeardownStarted?.();
          expect(processUrls.get(rootPid)).toBe("http://127.0.0.1:59000");
          await exitProof;
          state.killUrls.push("http://127.0.0.1:59000");
          return { escalated: false, signalErrors: [] };
        },
      }).pipe(
        Layer.provide(mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls })),
      ),
      TestClock.layer(),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const connectionScope = yield* Scope.make();
          yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, connectionScope));
          yield* Scope.close(connectionScope, Exit.void);

          const closing = yield* closeLocalServerPoolsForCliSpec(
            runtime,
            OPENCODE_CLI_SPEC,
          ).pipe(Effect.forkChild);
          yield* Effect.promise(() => teardownStarted);
          const closingWaitedForProof = closing.pollUnsafe() === undefined;

          proveExit?.();
          yield* Fiber.join(closing);
          expect(teardownCalls).toBe(1);
          expect(closingWaitedForProof).toBe(true);
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("keeps an idle target pool authoritative until a retry proves process-tree exit", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };
    const processUrls = new Map<number, string>();
    const unprovenExit = new ProviderProcessExitUnprovenError({
      rootPid: 59_000,
      rootExited: false,
      remainingDescendantPids: [59_001],
      captureComplete: true,
    });
    let rejectTeardown = true;
    let teardownCalls = 0;
    const layer = Layer.merge(
      makeTestOpenCodeRuntimeLive({
        teardownProcessTree: async ({ rootPid }) => {
          teardownCalls += 1;
          const url = processUrls.get(rootPid);
          if (url === undefined) {
            throw new Error(`Missing test URL for process ${rootPid}.`);
          }
          if (rejectTeardown) {
            throw unprovenExit;
          }
          state.killUrls.push(url);
          return { escalated: false, signalErrors: [] };
        },
      }).pipe(
        Layer.provide(mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls })),
      ),
      TestClock.layer(),
    );

    const runtimeExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            const connectionScope = yield* Scope.make();
            yield* runtime
              .connectToOpenCodeServer({ binaryPath: "opencode" })
              .pipe(Effect.provideService(Scope.Scope, connectionScope));
            yield* Scope.close(connectionScope, Exit.void);

            const failedClose = yield* closeLocalServerPoolsForCliSpec(
              runtime,
              OPENCODE_CLI_SPEC,
            ).pipe(Effect.result);
            expect(Result.isFailure(failedClose)).toBe(true);
            if (Result.isFailure(failedClose)) {
              expect(failedClose.failure).toBeInstanceOf(OpenCodeRuntimeError);
              expect(failedClose.failure.operation).toBe("closeLocalServerPoolsForCliSpec");
              expect(failedClose.failure.cause).toBeInstanceOf(OpenCodeRuntimeError);
              expect((failedClose.failure.cause as OpenCodeRuntimeError).cause).toBe(
                unprovenExit,
              );
            }
            expect(state.killUrls).toEqual([]);

            rejectTeardown = false;
            const refusedReuseScope = yield* Scope.make();
            const refusedReuse = yield* runtime
              .connectToOpenCodeServer({ binaryPath: "opencode" })
              .pipe(Effect.provideService(Scope.Scope, refusedReuseScope), Effect.result);
            expect(Result.isFailure(refusedReuse)).toBe(true);
            yield* Scope.close(refusedReuseScope, Exit.void);
            expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

            yield* closeLocalServerPoolsForCliSpec(
              runtime,
              OPENCODE_CLI_SPEC,
            );
            expect(teardownCalls).toBe(2);
            expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);

            const freshScope = yield* Scope.make();
            const freshConnection = yield* runtime
              .connectToOpenCodeServer({ binaryPath: "opencode" })
              .pipe(Effect.provideService(Scope.Scope, freshScope));
            expect(freshConnection.url).toBe("http://127.0.0.1:59001");
            expect(state.spawnUrls).toEqual([
              "http://127.0.0.1:59000",
              "http://127.0.0.1:59001",
            ]);
            yield* Scope.close(freshScope, Exit.void);
            yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);
            expect(state.killUrls).toEqual([
              "http://127.0.0.1:59000",
              "http://127.0.0.1:59001",
            ]);
          }),
        ).pipe(Effect.provide(layer)),
      ),
    );
    expect(Exit.isSuccess(runtimeExit)).toBe(true);
  });

  it("retains a failed readiness owner until target cleanup retries exact exit proof", async () => {
    const state = {
      spawnUrls: [] as Array<string>,
      killUrls: [] as Array<string>,
      startupStdouts: [
        "booting opencode without readiness\n",
        "opencode server listening on http://127.0.0.1:59001\n",
      ],
    };
    const processUrls = new Map<number, string>();
    const unprovenExit = new ProviderProcessExitUnprovenError({
      rootPid: 59_000,
      rootExited: false,
      remainingDescendantPids: [59_099],
      captureComplete: true,
    });
    let teardownCalls = 0;
    const layer = makeTestOpenCodeRuntimeLive({
      teardownProcessTree: async ({ rootPid }) => {
        teardownCalls += 1;
        const url = processUrls.get(rootPid);
        if (url === undefined) {
          throw new Error(`Missing test URL for process ${rootPid}.`);
        }
        if (teardownCalls === 1) {
          throw unprovenExit;
        }
        state.killUrls.push(url);
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(
      Layer.provide(mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls })),
    );

    const runtimeExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            const failedScope = yield* Scope.make();
            const startup = yield* runtime
              .connectToOpenCodeServer({ binaryPath: "opencode", timeoutMs: 5 })
              .pipe(Effect.provideService(Scope.Scope, failedScope), Effect.result);
            expect(Result.isFailure(startup)).toBe(true);
            yield* Scope.close(failedScope, Exit.void);
            expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);
            expect(state.killUrls).toEqual([]);
            expect(teardownCalls).toBe(1);

            const refusedScope = yield* Scope.make();
            const refused = yield* runtime
              .connectToOpenCodeServer({ binaryPath: "opencode" })
              .pipe(Effect.provideService(Scope.Scope, refusedScope), Effect.result);
            expect(Result.isFailure(refused)).toBe(true);
            yield* Scope.close(refusedScope, Exit.void);
            expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

            yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);
            expect(teardownCalls).toBe(2);
            expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);

            const freshScope = yield* Scope.make();
            const fresh = yield* runtime
              .connectToOpenCodeServer({ binaryPath: "opencode" })
              .pipe(Effect.provideService(Scope.Scope, freshScope));
            expect(fresh.url).toBe("http://127.0.0.1:59001");
            expect(state.spawnUrls).toEqual([
              "http://127.0.0.1:59000",
              "http://127.0.0.1:59001",
            ]);
            yield* Scope.close(freshScope, Exit.void);
            yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);
            expect(state.killUrls).toEqual([
              "http://127.0.0.1:59000",
              "http://127.0.0.1:59001",
            ]);
          }),
        ).pipe(Effect.provide(layer)),
      ),
    );
    expect(Exit.isSuccess(runtimeExit)).toBe(true);
  });

  it("refuses reuse after an unexpected root exit until retained descendants prove gone", async () => {
    const rootExit = Effect.runSync(Deferred.make<ChildProcessSpawner.ExitCode>());
    const state = {
      spawnUrls: [] as Array<string>,
      killUrls: [] as Array<string>,
      exitCodes: [Deferred.await(rootExit)],
    };
    const processUrls = new Map<number, string>();
    const capturedDescendant = {
      pid: 59_099,
      command: "opencode worker",
      identity: "59099:worker-start",
    };
    let descendantAlive = true;
    const captureTree = (rootPid: number): CapturedProcessTree => ({
      root: {
        pid: rootPid,
        command: "opencode serve",
        identity: `${rootPid}:root-start`,
      },
      descendants: rootPid === 59_000 && descendantAlive ? [capturedDescendant] : [],
      captureComplete: true,
    });
    const processTreeKiller: ProcessTreeKiller = {
      capture: captureTree,
      captureAsync: async (rootPid) => captureTree(rootPid),
      inspect: (tree) => ({
        verified: true,
        survivors: descendantAlive ? tree.descendants : [],
      }),
      inspectAsync: async (tree) => ({
        verified: true,
        survivors: descendantAlive ? tree.descendants : [],
      }),
      signal: () => undefined,
    };
    const unprovenExit = new ProviderProcessExitUnprovenError({
      rootPid: 59_000,
      rootExited: true,
      remainingDescendantPids: [capturedDescendant.pid],
      captureComplete: true,
    });
    let rejectTeardown = true;
    let markUnexpectedTeardownStarted: (() => void) | undefined;
    const unexpectedTeardownStarted = new Promise<void>((resolve) => {
      markUnexpectedTeardownStarted = resolve;
    });
    const capturedTrees: CapturedProcessTree[] = [];
    const layer = Layer.merge(
      makeTestOpenCodeRuntimeLive({
        processTreeKiller,
        teardownProcessTree: async (input) => {
          if (input.capturedTree !== undefined) {
            capturedTrees.push(input.capturedTree);
          }
          markUnexpectedTeardownStarted?.();
          if (rejectTeardown) {
            throw unprovenExit;
          }
          descendantAlive = false;
          return { escalated: false, signalErrors: [] };
        },
      }).pipe(
        Layer.provide(
          mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls }),
        ),
      ),
      TestClock.layer(),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const connectionScope = yield* Scope.make();
          yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, connectionScope));

          yield* Deferred.succeed(rootExit, ChildProcessSpawner.ExitCode(0));
          yield* Effect.promise(() => unexpectedTeardownStarted);

          const refusedScope = yield* Scope.make();
          const refused = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, refusedScope), Effect.result);
          expect(Result.isFailure(refused)).toBe(true);
          if (Result.isFailure(refused)) {
            expect(refused.failure).toMatchObject({
              operation: "closeLocalServerPoolsForCliSpec",
            });
          }
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);
          yield* Scope.close(refusedScope, Exit.void);

          yield* Scope.close(connectionScope, Exit.void);
          rejectTeardown = false;
          yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);
          expect(capturedTrees[0]?.descendants).toContainEqual(capturedDescendant);
          expect(capturedTrees[1]?.descendants).toContainEqual(capturedDescendant);

          const freshScope = yield* Scope.make();
          const fresh = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, freshScope));
          expect(fresh.url).toBe("http://127.0.0.1:59001");
          expect(state.spawnUrls).toEqual([
            "http://127.0.0.1:59000",
            "http://127.0.0.1:59001",
          ]);
          yield* Scope.close(freshScope, Exit.void);
          yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("refuses target pool teardown atomically while any matching pool has active references", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const idleScope = yield* Scope.make();
          const activeScope = yield* Scope.make();

          yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/idle" })
            .pipe(Effect.provideService(Scope.Scope, idleScope));
          yield* Scope.close(idleScope, Exit.void);
          yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/active" })
            .pipe(Effect.provideService(Scope.Scope, activeScope));

          const error = yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC).pipe(
            Effect.flip,
          );
          expect(error).toMatchObject({ operation: "closeLocalServerPoolsForCliSpec" });
          expect(error.detail).toContain("1 active connection reference");
          expect(state.killUrls).toEqual([]);

          yield* Scope.close(activeScope, Exit.void);
          yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);
          expect(state.killUrls).toEqual([
            "http://127.0.0.1:59000",
            "http://127.0.0.1:59001",
          ]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("closes every idle OpenCode pool without touching the separate Kilo pool", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const openCodeAlphaScope = yield* Scope.make();
          const openCodeBetaScope = yield* Scope.make();
          const kiloScope = yield* Scope.make();

          yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cliSpec: OPENCODE_CLI_SPEC,
              cwd: "/repo/alpha",
            })
            .pipe(Effect.provideService(Scope.Scope, openCodeAlphaScope));
          yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "/custom/bin/opencode",
              cliSpec: OPENCODE_CLI_SPEC,
              cwd: "/repo/beta",
            })
            .pipe(Effect.provideService(Scope.Scope, openCodeBetaScope));
          const kilo = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "kilo", cliSpec: KILO_CLI_SPEC })
            .pipe(Effect.provideService(Scope.Scope, kiloScope));

          yield* Scope.close(openCodeAlphaScope, Exit.void);
          yield* Scope.close(openCodeBetaScope, Exit.void);
          yield* Scope.close(kiloScope, Exit.void);
          yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);

          expect(state.killUrls).toEqual([
            "http://127.0.0.1:59000",
            "http://127.0.0.1:59001",
          ]);

          const reusedKiloScope = yield* Scope.make();
          const reusedKilo = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "kilo", cliSpec: KILO_CLI_SPEC })
            .pipe(Effect.provideService(Scope.Scope, reusedKiloScope));
          expect(reusedKilo.url).toBe(kilo.url);
          expect(state.spawnUrls).toHaveLength(3);

          yield* Scope.close(reusedKiloScope, Exit.void);
          yield* closeLocalServerPoolsForCliSpec(runtime, KILO_CLI_SPEC);
          expect(state.killUrls).toEqual([
            "http://127.0.0.1:59000",
            "http://127.0.0.1:59001",
            "http://127.0.0.1:59002",
          ]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("reuses a local server while scoped sessions are active and closes it after idling", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(first.external).toBe(false);
          expect(first.url).toBe(second.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual([]);

          yield* Scope.close(secondScope, Exit.void);
          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);

          const thirdScope = yield* Scope.make();
          const third = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, thirdScope));
          expect(third.url).toBe("http://127.0.0.1:59001");
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);
          yield* Scope.close(thirdScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("isolates same-cwd owners and closes private servers immediately on release", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const first = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cwd: "/repo",
              poolIsolationKey: "synara-thread-a",
            })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cwd: "/repo",
              poolIsolationKey: "synara-thread-b",
            })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(first.url).not.toBe(second.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);

          yield* Scope.close(firstScope, Exit.void);
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
          yield* Scope.close(secondScope, Exit.void);
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("does not spawn or pool when an external OpenCode server URL is configured", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const connection = yield* runtime.connectToOpenCodeServer({
            binaryPath: "opencode",
            serverUrl: " http://127.0.0.1:9999 ",
          });

          expect(connection).toMatchObject({
            url: "http://127.0.0.1:9999",
            exitCode: null,
            external: true,
          });
          yield* closeLocalServerPoolsForCliSpec(runtime, OPENCODE_CLI_SPEC);
          yield* closeLocalServerPoolsForCliSpec(runtime, KILO_CLI_SPEC);
          expect(state.spawnUrls).toEqual([]);
          expect(state.killUrls).toEqual([]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("keeps the warm server alive when a new session starts before idle expiry", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));

          yield* Scope.close(firstScope, Exit.void);
          yield* advanceOpenCodePoolAlmostToIdle;

          const secondScope = yield* Scope.make();
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(second.url).toBe(first.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual([]);

          yield* Scope.close(secondScope, Exit.void);
          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("keeps incompatible local server keys separate", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const defaultServer = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const customServer = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "/custom/bin/opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(defaultServer.url).toBe("http://127.0.0.1:59000");
          expect(customServer.url).toBe("http://127.0.0.1:59001");
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("starts local servers in the requested cwd and separates cwd-specific pools", async () => {
    const state = {
      spawnUrls: [] as Array<string>,
      spawnCwds: [] as Array<string | undefined>,
      killUrls: [] as Array<string>,
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const thirdScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/alpha" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/beta" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));
          const third = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/alpha" })
            .pipe(Effect.provideService(Scope.Scope, thirdScope));

          expect(first.url).toBe("http://127.0.0.1:59000");
          expect(second.url).toBe("http://127.0.0.1:59001");
          expect(third.url).toBe(first.url);
          expect(state.spawnCwds).toEqual(["/repo/alpha", "/repo/beta"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
          yield* Scope.close(thirdScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });
});

describe("parseOpenCodeCliModelsOutput", () => {
  it("parses verbose OpenCode model output with metadata blocks", () => {
    const models = parseOpenCodeCliModelsOutput(`
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4",
  "variants": {
    "low": {
      "reasoningEffort": "low"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
opencode/gpt-5-nano
{
  "id": "gpt-5-nano",
  "providerID": "opencode",
  "name": "GPT-5 Nano",
  "variants": {}
}
`);

    expect(models).toEqual([
      {
        slug: "opencode/gpt-5-nano",
        providerID: "opencode",
        modelID: "gpt-5-nano",
        name: "GPT-5 Nano",
        variants: [],
        supportedReasoningEfforts: [],
      },
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "GPT-5.4",
        variants: ["high", "low"],
        supportedReasoningEfforts: [
          {
            value: "low",
          },
          {
            value: "high",
          },
        ],
      },
    ]);
  });

  it("falls back to slug-derived metadata when only plain model lines are present", () => {
    const models = parseOpenCodeCliModelsOutput(`
warning: cached model metadata is unavailable
openai/gpt-5.4
opencode/minimax-m2.5-free
`);

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "gpt-5.4",
        variants: [],
        supportedReasoningEfforts: [],
      },
      {
        slug: "opencode/minimax-m2.5-free",
        providerID: "opencode",
        modelID: "minimax-m2.5-free",
        name: "minimax-m2.5-free",
        variants: [],
        supportedReasoningEfforts: [],
      },
    ]);
  });

  it("deduplicates repeated slug entries by keeping the latest descriptor", () => {
    const models = parseOpenCodeCliModelsOutput(`
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4"
}
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4 Latest"
}
`);

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "GPT-5.4 Latest",
        variants: [],
        supportedReasoningEfforts: [],
      },
    ]);
  });

  it("keeps verbose reasoning metadata from CLI output", () => {
    const models = parseOpenCodeCliModelsOutput(`
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4",
  "options": {
    "reasoningEffort": "medium"
  },
  "variants": {
    "none": {
      "reasoningEffort": "none"
    },
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
`);

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "GPT-5.4",
        variants: ["high", "low", "medium", "none"],
        supportedReasoningEfforts: [
          { value: "none" },
          { value: "low" },
          { value: "medium" },
          { value: "high" },
        ],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("reads current OpenCode variant effort shapes from verbose CLI output", () => {
    const models = parseOpenCodeCliModelsOutput(`
opencode/claude-opus-4-7
{
  "id": "claude-opus-4-7",
  "providerID": "opencode",
  "name": "Claude Opus 4.7",
  "options": {
    "effort": "high"
  },
  "variants": {
    "low": {
      "thinking": {
        "type": "adaptive"
      }
    },
    "medium": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "medium"
    },
    "high": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "high"
    },
    "xhigh": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "xhigh"
    },
    "max": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "max"
    }
  }
}
opencode/gemini-3-flash
{
  "id": "gemini-3-flash",
  "providerID": "opencode",
  "name": "Gemini 3 Flash",
  "variants": {
    "minimal": {
      "thinkingConfig": {
        "thinkingLevel": "minimal"
      }
    },
    "high": {
      "thinkingConfig": {
        "thinkingLevel": "high"
      }
    }
  }
}
openrouter/grok-3-mini
{
  "id": "grok-3-mini",
  "providerID": "openrouter",
  "name": "Grok 3 Mini",
  "variants": {
    "low": {
      "reasoning": {
        "effort": "low"
      }
    },
    "high": {
      "reasoning": {
        "effort": "high"
      }
    }
  }
}
amazon-bedrock/nova-reel
{
  "id": "nova-reel",
  "providerID": "amazon-bedrock",
  "name": "Nova Reel",
  "variants": {
    "medium": {
      "reasoningConfig": {
        "maxReasoningEffort": "medium"
      }
    }
  }
}
`);

    expect(models).toEqual([
      {
        slug: "opencode/claude-opus-4-7",
        providerID: "opencode",
        modelID: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        variants: ["high", "low", "max", "medium", "xhigh"],
        supportedReasoningEfforts: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
          { value: "max" },
        ],
        defaultReasoningEffort: "high",
      },
      {
        slug: "opencode/gemini-3-flash",
        providerID: "opencode",
        modelID: "gemini-3-flash",
        name: "Gemini 3 Flash",
        variants: ["high", "minimal"],
        supportedReasoningEfforts: [{ value: "minimal" }, { value: "high" }],
      },
      {
        slug: "openrouter/grok-3-mini",
        providerID: "openrouter",
        modelID: "grok-3-mini",
        name: "Grok 3 Mini",
        variants: ["high", "low"],
        supportedReasoningEfforts: [{ value: "low" }, { value: "high" }],
      },
      {
        slug: "amazon-bedrock/nova-reel",
        providerID: "amazon-bedrock",
        modelID: "nova-reel",
        name: "Nova Reel",
        variants: ["medium"],
        supportedReasoningEfforts: [{ value: "medium" }],
      },
    ]);
  });
});

describe("parseOpenCodeCredentialProviderIDs", () => {
  it("returns top-level provider ids from the OpenCode credential store", () => {
    const providerIDs = parseOpenCodeCredentialProviderIDs(`{
  "openai": {
    "type": "oauth"
  },
  "opencode": {
    "type": "api"
  }
}`);

    expect(providerIDs).toEqual(["openai", "opencode"]);
  });

  it("ignores non-object entries and empty keys", () => {
    const providerIDs = parseOpenCodeCredentialProviderIDs(`{
  "": {
    "type": "oauth"
  },
  "openai": {
    "type": "oauth"
  },
  "broken": "nope"
}`);

    expect(providerIDs).toEqual(["openai"]);
  });
});
