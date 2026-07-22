// FILE: opencodeRuntime.test.ts
// Purpose: Covers OpenCode runtime parsing and local server startup diagnostics.
// Layer: Provider runtime tests
// Exports: Vitest suites for opencodeRuntime.ts

import { existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";

import { Cause, Duration, Effect, Exit, Fiber, Layer, Scope, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { TestClock } from "effect/testing";
import type { ChatAttachment } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildOpenCodeServerProcessEnv,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  makeOpenCodeRuntimeLive,
  OPENCODE_LOCAL_SERVER_IDLE_TTL_MS,
  parseOpenCodeCliModelsOutput,
  parseOpenCodeCredentialProviderIDs,
  toOpenCodeFileParts,
} from "./opencodeRuntime.ts";

const encoder = new TextEncoder();
const prepareMockProcess = (command: string, args: ReadonlyArray<string>) => ({
  command,
  args: [...args],
  shell: false as const,
});

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
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        options?: { cwd?: string };
      };
      const url = `http://127.0.0.1:${59000 + state.spawnUrls.length}`;
      const pid = 59_000 + state.spawnUrls.length;
      state.spawnUrls.push(url);
      state.spawnCwds?.push(cmd.options?.cwd);
      state.processUrls?.set(pid, url);
      return Effect.succeed(
        mockOpenCodeServerHandle({
          stdout: `opencode server listening on ${url}\n`,
          stderr: "",
          pid,
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
    makeOpenCodeRuntimeLive({
      prepareProcess: prepareMockProcess,
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_000),
        findAvailablePort: () => Effect.succeed(59_000),
      },
      teardownProcessTree: async ({ rootPid }) => {
        const url = processUrls.get(rootPid);
        if (url) state.killUrls.push(url);
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(Layer.provide(mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls }))),
    TestClock.layer(),
  );
}

describe("toOpenCodeFileParts", () => {
  it("materializes image attachments as SDK file parts", () => {
    const attachmentPath = nodePath.join(
      nodePath.parse(process.cwd()).root,
      "tmp",
      "synara-attachments",
      "screenshot.png",
    );
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

describe("OpenCodeRuntime one-shot command ownership", () => {
  it("requests and validates a Windows Job-empty receipt for a natural command exit", async () => {
    const receiptToken = `opencode-command-${String(process.pid)}-${String(Date.now())}`;
    const receiptPath = nodePath.join(os.tmpdir(), `${receiptToken}.receipt`);
    let requestedCompletionReceipt: unknown;
    let teardownCalls = 0;
    let receiptWritten = false;
    const layer = makeOpenCodeRuntimeLive({
      prepareProcess: (command, args, input) => {
        requestedCompletionReceipt = input?.completionReceipt;
        return {
          command,
          args: [...args],
          shell: false,
          containment: "windows-job-object",
          completionReceipt: { path: receiptPath, token: receiptToken },
        };
      },
      teardownProcessTree: async (input) => {
        teardownCalls += 1;
        expect(input.descendantExitProof).toBe("windows-job-empty-on-exit");
        expect(await input.rootExitProof).toBe(true);
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              mockOpenCodeServerHandle({
                stdout: "models listed\n",
                stderr: "",
                pid: 59_050,
                exitCode: Effect.sync(() => {
                  if (!receiptWritten) {
                    receiptWritten = true;
                    writeFileSync(receiptPath, `${receiptToken}\n59050\n`);
                  }
                  return ChildProcessSpawner.ExitCode(0);
                }),
              }),
            ),
          ),
        ),
      ),
    );

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime.runOpenCodeCommand({
            binaryPath: "opencode",
            args: ["models"],
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(result).toEqual({ stdout: "models listed\n", stderr: "", code: 0 });
      expect(requestedCompletionReceipt).toBe("create");
      expect(teardownCalls).toBe(1);
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      rmSync(receiptPath, { force: true });
    }
  });

  it("requires POSIX process-group exit proof after a natural command exit", async () => {
    const provenProcessGroups: Array<number> = [];
    let observedDetached: boolean | undefined;
    const layer = makeOpenCodeRuntimeLive({
      platform: "linux",
      prepareProcess: prepareMockProcess,
      teardownPosixProcessGroup: async (processGroupId) => {
        provenProcessGroups.push(processGroupId);
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            observedDetached = (
              command as unknown as { readonly options?: { readonly detached?: boolean } }
            ).options?.detached;
            return Effect.succeed(
              mockOpenCodeServerHandle({
                stdout: "models listed\n",
                stderr: "",
                pid: 59_055,
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              }),
            );
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.runOpenCodeCommand({
          binaryPath: "opencode",
          args: ["models"],
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({ stdout: "models listed\n", stderr: "", code: 0 });
    expect(observedDetached).toBe(true);
    expect(provenProcessGroups).toEqual([59_055]);
  });

  it("registers interrupted command ownership after spawn and retains failed group cleanup", async () => {
    let spawnCalls = 0;
    let teardownCalls = 0;
    const provenProcessGroups: number[] = [];
    const acquiredFirstSpawn = Promise.withResolvers<void>();
    const releaseFirstSpawn = Promise.withResolvers<void>();
    let proveRetry: (() => void) | undefined;
    const retryProof = new Promise<void>((resolve) => {
      proveRetry = resolve;
    });
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => {
        const spawnIndex = spawnCalls;
        spawnCalls += 1;
        const child = mockOpenCodeServerHandle({
          stdout: spawnIndex === 0 ? "running\n" : `result-${String(spawnIndex)}\n`,
          stderr: "",
          pid: 59_060 + spawnIndex,
          exitCode:
            spawnIndex === 0 ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        });
        return spawnIndex === 0
          ? Effect.promise(async () => {
              acquiredFirstSpawn.resolve();
              await releaseFirstSpawn.promise;
              return child;
            })
          : Effect.succeed(child);
      }),
    );
    const layer = makeOpenCodeRuntimeLive({
      platform: "linux",
      prepareProcess: prepareMockProcess,
      teardownPosixProcessGroup: async (processGroupId) => {
        teardownCalls += 1;
        provenProcessGroups.push(processGroupId);
        if (teardownCalls === 1) throw new Error("interrupted command cleanup proof failed");
        if (teardownCalls === 2) await retryProof;
      },
    }).pipe(Layer.provide(spawnerLayer));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const command = () =>
            runtime.runOpenCodeCommand({ binaryPath: "opencode", args: ["models"] });
          const interruptedCommand = yield* command().pipe(Effect.forkChild);
          yield* Effect.promise(() => acquiredFirstSpawn.promise);
          const interrupting = yield* Fiber.interrupt(interruptedCommand).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(spawnCalls).toBe(1);
          releaseFirstSpawn.resolve();
          yield* Fiber.join(interrupting);
          expect(teardownCalls).toBe(1);
          expect(provenProcessGroups).toEqual([59_060]);

          const replacementA = yield* command().pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(teardownCalls).toBe(2);
          const replacementB = yield* command().pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(spawnCalls).toBe(1);
          expect(replacementA.pollUnsafe()).toBeUndefined();
          expect(replacementB.pollUnsafe()).toBeUndefined();

          proveRetry?.();
          const [first, second] = yield* Effect.all([
            Fiber.join(replacementA),
            Fiber.join(replacementB),
          ]);
          expect(first.stdout).toBe("result-1\n");
          expect(second.stdout).toBe("result-2\n");
          expect(spawnCalls).toBe(3);
          expect(teardownCalls).toBe(4);
          expect(provenProcessGroups).toEqual([59_060, 59_060, 59_061, 59_062]);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });
});

describe("OpenCodeRuntime startup diagnostics", () => {
  it("forwards prepared hidden-window policy to command and server launches", async () => {
    const observedWindowsHide: Array<boolean | undefined> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const preparedCommand = command as unknown as {
          readonly args: ReadonlyArray<string>;
          readonly options?: { readonly windowsHide?: boolean };
        };
        observedWindowsHide.push(preparedCommand.options?.windowsHide);
        const isServer = preparedCommand.args.includes("serve");
        return Effect.succeed(
          mockOpenCodeServerHandle({
            stdout: isServer
              ? "opencode server listening on http://127.0.0.1:59000\n"
              : "models listed\n",
            stderr: "",
            exitCode: isServer ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          }),
        );
      }),
    );
    const layer = makeOpenCodeRuntimeLive({
      prepareProcess: (command, args) => ({
        command,
        args: [...args],
        shell: false,
        windowsHide: true,
      }),
      teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
    }).pipe(Layer.provide(spawnerLayer));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const commandResult = yield* runtime.runOpenCodeCommand({
            binaryPath: "/custom/bin/opencode",
            args: ["models"],
          });
          expect(commandResult.code).toBe(0);
          const server = yield* runtime.startOpenCodeServerProcess({
            binaryPath: "/custom/bin/opencode",
            port: 59_000,
          });
          expect(server.url).toBe("http://127.0.0.1:59000");
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(observedWindowsHide).toEqual([true, true]);
  });

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
            prepareProcess: prepareMockProcess,
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
          makeOpenCodeRuntimeLive({
            prepareProcess: prepareMockProcess,
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
          makeOpenCodeRuntimeLive({
            prepareProcess: prepareMockProcess,
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
  it("completes caller-scope ownership transfer before honoring interruption", async () => {
    let teardownCalls = 0;
    let cleanupFinished = false;
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const layer = makeOpenCodeRuntimeLive({
      prepareProcess: prepareMockProcess,
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_090),
        findAvailablePort: () => Effect.succeed(59_090),
      },
      teardownProcessTree: async () => {
        teardownCalls += 1;
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        cleanupFinished = true;
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(
      Layer.provide(
        mockOpenCodeServerSpawnerLayer({
          stdout: "opencode server listening on http://127.0.0.1:59090\n",
          stderr: "",
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const callerScope = yield* Scope.make();
          yield* Scope.close(callerScope, Exit.void);

          yield* Effect.gen(function* () {
            const connecting = yield* runtime
              .connectToOpenCodeServer({
                binaryPath: "opencode",
                poolIsolationKey: "closed-caller-scope-transfer",
              })
              .pipe(Effect.provideService(Scope.Scope, callerScope), Effect.forkChild);

            yield* Effect.promise(() => cleanupStarted.promise);
            const interrupting = yield* Fiber.interrupt(connecting).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;

            expect(teardownCalls).toBe(1);
            expect(cleanupFinished).toBe(false);
            expect(interrupting.pollUnsafe()).toBeUndefined();

            releaseCleanup.resolve();
            yield* Fiber.join(interrupting);
            expect(cleanupFinished).toBe(true);

            const connectingExit = connecting.pollUnsafe();
            expect(connectingExit).toBeDefined();
            expect(
              connectingExit && Exit.isFailure(connectingExit)
                ? Cause.hasInterrupts(connectingExit.cause)
                : false,
            ).toBe(true);
          }).pipe(Effect.ensuring(Effect.sync(() => releaseCleanup.resolve())));
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("keeps server scope closure pending until process-tree exit is proven", async () => {
    let proveExit: (() => void) | undefined;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let teardownCalls = 0;
    const layer = makeOpenCodeRuntimeLive({
      prepareProcess: prepareMockProcess,
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_000),
        findAvailablePort: () => Effect.succeed(59_000),
      },
      teardownProcessTree: async ({ rootPid }) => {
        teardownCalls += 1;
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
          yield* Effect.yieldNow;
          expect(teardownCalls).toBe(1);
          expect(closing.pollUnsafe()).toBeUndefined();

          proveExit?.();
          yield* Fiber.join(closing);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("retains failed startup cleanup and serializes concurrent replacement until proof", async () => {
    let spawnCalls = 0;
    let teardownCalls = 0;
    let proveRetry: (() => void) | undefined;
    const retryProof = new Promise<void>((resolve) => {
      proveRetry = resolve;
    });
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => {
        const spawnIndex = spawnCalls;
        spawnCalls += 1;
        return Effect.succeed(
          mockOpenCodeServerHandle({
            stdout:
              spawnIndex === 0
                ? "startup stalled before ready\n"
                : "opencode server listening on http://127.0.0.1:59101\n",
            stderr: spawnIndex === 0 ? "simulated startup stall\n" : "",
            pid: 59_100 + spawnIndex,
            exitCode: Effect.never,
          }),
        );
      }),
    );
    const layer = makeOpenCodeRuntimeLive({
      prepareProcess: prepareMockProcess,
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_101),
        findAvailablePort: () => Effect.succeed(59_101),
      },
      teardownProcessTree: async () => {
        teardownCalls += 1;
        if (teardownCalls === 1) {
          throw new Error("startup cleanup proof failed");
        }
        if (teardownCalls === 2) {
          await retryProof;
        }
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(Layer.provide(spawnerLayer));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const input = {
            binaryPath: "opencode",
            poolIsolationKey: "startup-cleanup-recovery",
            timeoutMs: 5,
          };
          const initialScope = yield* Scope.make();
          const initialExit = yield* runtime
            .connectToOpenCodeServer(input)
            .pipe(Effect.provideService(Scope.Scope, initialScope), Effect.exit);
          expect(Exit.isFailure(initialExit)).toBe(true);
          if (Exit.isFailure(initialExit)) {
            const failure = Cause.squash(initialExit.cause);
            expect(OpenCodeRuntimeError.is(failure)).toBe(true);
            if (OpenCodeRuntimeError.is(failure)) {
              expect(failure.cause).toBeInstanceOf(AggregateError);
              const causes = (failure.cause as AggregateError).errors;
              expect(OpenCodeRuntimeError.is(causes[0])).toBe(true);
              if (OpenCodeRuntimeError.is(causes[0])) {
                expect(causes[0].detail).toContain("Timed out waiting for OpenCode server start");
              }
              expect(OpenCodeRuntimeError.is(causes[1])).toBe(true);
              if (OpenCodeRuntimeError.is(causes[1])) {
                expect(causes[1].detail).toContain("startup cleanup proof failed");
              }
            }
          }
          yield* Scope.close(initialScope, Exit.void);
          expect(spawnCalls).toBe(1);
          expect(teardownCalls).toBe(1);

          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const firstReplacement = yield* runtime
            .connectToOpenCodeServer(input)
            .pipe(Effect.provideService(Scope.Scope, firstScope), Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(teardownCalls).toBe(2);
          const secondReplacement = yield* runtime
            .connectToOpenCodeServer(input)
            .pipe(Effect.provideService(Scope.Scope, secondScope), Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          expect(spawnCalls).toBe(1);
          expect(firstReplacement.pollUnsafe()).toBeUndefined();
          expect(secondReplacement.pollUnsafe()).toBeUndefined();

          proveRetry?.();
          const [first, second] = yield* Effect.all([
            Fiber.join(firstReplacement),
            Fiber.join(secondReplacement),
          ]);
          expect(first.url).toBe("http://127.0.0.1:59101");
          expect(second.url).toBe(first.url);
          expect(spawnCalls).toBe(2);
          expect(teardownCalls).toBe(2);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
          expect(teardownCalls).toBe(3);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("registers receipt-aware server ownership before a queued post-spawn interruption", async () => {
    let spawnCalls = 0;
    let teardownCalls = 0;
    const acquiredFirstSpawn = Promise.withResolvers<void>();
    const releaseFirstSpawn = Promise.withResolvers<void>();
    const releaseCleanupRetry = Promise.withResolvers<void>();
    const cleanupInputs: Array<{
      readonly rootPid: number;
      readonly descendantExitProof: string | undefined;
      readonly hasRootExitProof: boolean;
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => {
        const spawnIndex = spawnCalls;
        spawnCalls += 1;
        const child = mockOpenCodeServerHandle({
          stdout:
            spawnIndex === 0
              ? "startup waiting after spawn\n"
              : "opencode server listening on http://127.0.0.1:59110\n",
          stderr: "",
          pid: 59_110 + spawnIndex,
          exitCode: Effect.never,
        });
        return spawnIndex === 0
          ? Effect.promise(async () => {
              acquiredFirstSpawn.resolve();
              await releaseFirstSpawn.promise;
              return child;
            })
          : Effect.succeed(child);
      }),
    );
    const layer = makeOpenCodeRuntimeLive({
      platform: "win32",
      prepareProcess: () => ({
        command: "synara-windows-job-launcher.exe",
        args: ["--", "opencode"],
        shell: false as const,
        containment: "windows-job-object" as const,
        completionReceipt: {
          path: "C:\\Synara\\opencode-job-empty.receipt",
          token: "opencode-job-empty-proof",
        },
        windowsJobName: "synara-opencode-job",
      }),
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_110),
        findAvailablePort: () => Effect.succeed(59_110),
      },
      teardownProcessTree: async (input) => {
        teardownCalls += 1;
        cleanupInputs.push({
          rootPid: input.rootPid,
          descendantExitProof: input.descendantExitProof,
          hasRootExitProof: input.rootExitProof instanceof Promise,
        });
        if (teardownCalls === 1) {
          throw new Error("interrupted server receipt cleanup proof failed");
        }
        if (teardownCalls === 2) {
          await releaseCleanupRetry.promise;
        }
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(Layer.provide(spawnerLayer));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const input = {
            binaryPath: "opencode",
            poolIsolationKey: "post-spawn-interruption",
          };
          const interruptedScope = yield* Scope.make();
          const interruptedStartup = yield* runtime
            .connectToOpenCodeServer(input)
            .pipe(Effect.provideService(Scope.Scope, interruptedScope), Effect.forkChild);

          yield* Effect.promise(() => acquiredFirstSpawn.promise);
          const interrupting = yield* Fiber.interrupt(interruptedStartup).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          releaseFirstSpawn.resolve();
          yield* Fiber.join(interrupting);

          const replacementScope = yield* Scope.make();
          const replacement = yield* runtime
            .connectToOpenCodeServer(input)
            .pipe(Effect.provideService(Scope.Scope, replacementScope), Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          const stateBeforeRetryProof = {
            teardownCalls,
            spawnCalls,
            replacementPending: replacement.pollUnsafe() === undefined,
          };

          releaseCleanupRetry.resolve();
          const server = yield* Fiber.join(replacement);

          expect(stateBeforeRetryProof).toEqual({
            teardownCalls: 2,
            spawnCalls: 1,
            replacementPending: true,
          });
          expect(cleanupInputs[0]).toEqual({
            rootPid: 59_110,
            descendantExitProof: "windows-job-empty-on-exit",
            hasRootExitProof: true,
          });
          expect(server.url).toBe("http://127.0.0.1:59110");
          expect(spawnCalls).toBe(2);

          yield* Scope.close(interruptedScope, Exit.void);
          yield* Scope.close(replacementScope, Exit.void);
          expect(teardownCalls).toBe(3);
          expect(
            cleanupInputs.every(
              (cleanup) =>
                cleanup.descendantExitProof === "windows-job-empty-on-exit" &&
                cleanup.hasRootExitProof,
            ),
          ).toBe(true);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              releaseFirstSpawn.resolve();
              releaseCleanupRetry.resolve();
            }),
          ),
        ),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("proves an exited POSIX server group is empty before replacement", async () => {
    const spawnedUrls: Array<string> = [];
    const exitResolvers: Array<(code: ChildProcessSpawner.ExitCode) => void> = [];
    const provenProcessGroups: Array<number> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => {
        const url = `http://127.0.0.1:${String(59_200 + spawnedUrls.length)}`;
        const pid = 59_200 + spawnedUrls.length;
        spawnedUrls.push(url);
        let resolveExit!: (code: ChildProcessSpawner.ExitCode) => void;
        const exitCode = new Promise<ChildProcessSpawner.ExitCode>((resolve) => {
          resolveExit = resolve;
        });
        exitResolvers.push(resolveExit);
        return Effect.succeed(
          mockOpenCodeServerHandle({
            stdout: `opencode server listening on ${url}\n`,
            stderr: "",
            pid,
            exitCode: Effect.promise(() => exitCode),
          }),
        );
      }),
    );
    const layer = makeOpenCodeRuntimeLive({
      platform: "linux",
      prepareProcess: prepareMockProcess,
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_200),
        findAvailablePort: () => Effect.succeed(59_200),
      },
      teardownPosixProcessGroup: async (processGroupId) => {
        provenProcessGroups.push(processGroupId);
      },
    }).pipe(Layer.provide(spawnerLayer));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const input = {
            binaryPath: "opencode",
            poolIsolationKey: "natural-exit-replacement",
          };
          const firstScope = yield* Scope.make();
          const first = yield* runtime
            .connectToOpenCodeServer(input)
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          expect(first.url).toBe("http://127.0.0.1:59200");

          exitResolvers[0]?.(ChildProcessSpawner.ExitCode(0));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          const secondScope = yield* Scope.make();
          const second = yield* runtime
            .connectToOpenCodeServer(input)
            .pipe(Effect.provideService(Scope.Scope, secondScope));
          expect(second.url).toBe("http://127.0.0.1:59201");
          expect(spawnedUrls).toEqual(["http://127.0.0.1:59200", "http://127.0.0.1:59201"]);
          expect(provenProcessGroups).toEqual([59_200]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
          expect(provenProcessGroups).toEqual([59_200, 59_201]);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("attempts every owned server cleanup before finalizer failure is surfaced", async () => {
    const attemptedProcessIds: Array<number> = [];
    let spawnCalls = 0;
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => {
        const processIndex = spawnCalls;
        spawnCalls += 1;
        const port = 59_300 + processIndex;
        return Effect.succeed(
          mockOpenCodeServerHandle({
            stdout: `opencode server listening on http://127.0.0.1:${String(port)}\n`,
            stderr: "",
            pid: port,
            exitCode: Effect.never,
          }),
        );
      }),
    );
    const layer = makeOpenCodeRuntimeLive({
      prepareProcess: prepareMockProcess,
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_300),
        findAvailablePort: () => Effect.succeed(59_300),
      },
      teardownProcessTree: async ({ rootPid }) => {
        attemptedProcessIds.push(rootPid);
        throw new Error(`cleanup failed for ${String(rootPid)}`);
      },
    }).pipe(Layer.provide(spawnerLayer));

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              poolIsolationKey: "finalizer-first",
            })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              poolIsolationKey: "finalizer-second",
            })
            .pipe(Effect.provideService(Scope.Scope, secondScope));
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(attemptedProcessIds).toContain(59_300);
    expect(attemptedProcessIds).toContain(59_301);
    expect(attemptedProcessIds.indexOf(59_301)).toBeGreaterThan(
      attemptedProcessIds.indexOf(59_300),
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
