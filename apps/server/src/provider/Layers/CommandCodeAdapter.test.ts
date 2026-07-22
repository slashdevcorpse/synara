import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { it, assert, describe, vi } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CommandCodeAdapter } from "../Services/CommandCodeAdapter.ts";
import {
  buildCommandCodeTurnArgs,
  makeCommandCodeAdapterLive,
  parseCommandCodeModelList,
  parseCommandCodeSessionLine,
  type CommandCodeAdapterLiveOptions,
} from "./CommandCodeAdapter.ts";

type SpawnProcess = NonNullable<CommandCodeAdapterLiveOptions["spawnProcess"]>;
type SpawnProcessMock = ReturnType<typeof vi.fn<SpawnProcess>>;
type PrepareProcess = NonNullable<CommandCodeAdapterLiveOptions["prepareProcess"]>;
type PrepareProcessMock = ReturnType<typeof vi.fn<PrepareProcess>>;

interface MockChild {
  readonly child: ChildProcess;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  error(cause: Error): void;
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  close(code: number | null, signal?: NodeJS.Signals | null): void;
}

function makeMockChild(): MockChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, {
    pid: 4_242,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn(() => true),
  });
  return {
    child: emitter as ChildProcess,
    stdin,
    stdout,
    stderr,
    error(cause) {
      emitter.emit("error", cause);
    },
    exit(code, signal = null) {
      Object.assign(emitter, { exitCode: code, signalCode: signal });
      emitter.emit("exit", code, signal);
    },
    close(code, signal = null) {
      Object.assign(emitter, { exitCode: code, signalCode: signal });
      emitter.emit("close", code, signal);
    },
  };
}

function adapterLayer(input: {
  readonly child: MockChild;
  readonly spawnProcess?: SpawnProcessMock;
  readonly prepareProcess?: PrepareProcessMock;
  readonly teardownProcessTree?: (child: ChildProcess) => Promise<unknown>;
  readonly resolveExecutable?: (command: string) => string;
}) {
  const spawnProcess = input.spawnProcess ?? vi.fn<SpawnProcess>(() => input.child.child);
  return {
    spawnProcess,
    layer: makeCommandCodeAdapterLive({
      spawnProcess,
      prepareProcess: input.prepareProcess ?? prepareWindowsSafeProcess,
      teardownProcessTree:
        input.teardownProcessTree ??
        (async () => {
          if (input.child.child.exitCode === null) input.child.close(130);
        }),
      resolveExecutable: input.resolveExecutable ?? (() => "C:\\tools\\commandcode.cmd"),
    }).pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "command-code-adapter-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
}

function startInput(threadId: ThreadId) {
  return {
    threadId,
    provider: "commandCode" as const,
    cwd: process.cwd(),
    modelSelection: { provider: "commandCode" as const, model: "gpt-5.6-sol" },
    providerOptions: {
      commandCode: { binaryPath: "C:\\tools\\commandcode.cmd" },
    },
    runtimeMode: "full-access" as const,
  };
}

describe("Command Code CLI helpers", () => {
  it("builds headless resume args without putting the prompt on argv", () => {
    const args = buildCommandCodeTurnArgs({
      providerSessionId: "d37c825d-d4f7-4f7c-bfa2-f5c8a7c00119",
      model: "gpt-5.6-sol",
      runtimeMode: "full-access",
      plan: true,
    });
    assert.deepStrictEqual(args, [
      "-p",
      "--verbose",
      "--skip-onboarding",
      "--trust",
      "--max-turns",
      "10",
      "--resume",
      "d37c825d-d4f7-4f7c-bfa2-f5c8a7c00119",
      "--model",
      "gpt-5.6-sol",
      "--plan",
    ]);
  });

  it("uses full-access bypass only outside plan mode", () => {
    const args = buildCommandCodeTurnArgs({
      model: "gpt-5.6-sol",
      runtimeMode: "full-access",
    });
    assert.ok(args.includes("--trust"));
    assert.ok(args.includes("--yolo"));
    assert.ok(!args.includes("--plan"));
  });

  it("prepares a Command Code npm shim through cmd.exe deterministically", () => {
    const prepared = prepareWindowsSafeProcess(
      "C:\\tools\\commandcode.cmd",
      ["-p", "--trust", "--model", "gpt-5.6-sol"],
      {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      },
    );
    assert.strictEqual(prepared.command, "C:\\Windows\\System32\\cmd.exe");
    assert.deepStrictEqual(prepared.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
    assert.match(prepared.args[4] ?? "", /call "C:\\tools\\commandcode\.cmd"/u);
    assert.strictEqual(prepared.windowsVerbatimArguments, true);
  });

  it("parses only the documented verbose session line with a UUID", () => {
    assert.strictEqual(
      parseCommandCodeSessionLine("session: d37c825d-d4f7-4f7c-bfa2-f5c8a7c00119"),
      "d37c825d-d4f7-4f7c-bfa2-f5c8a7c00119",
    );
    assert.strictEqual(parseCommandCodeSessionLine("session: ../../auth.json"), undefined);
    assert.strictEqual(parseCommandCodeSessionLine("tool session: d37c825d-d4f7"), undefined);
  });

  it("parses grouped runtime models without treating headings as models", () => {
    assert.deepStrictEqual(
      parseCommandCodeModelList(`Available models  ·  2 models

OpenAI

gpt-5.6-sol     frontier model for complex work
gpt-5.4-mini    fast model (default)

Pass the full id, or just the short name:
cmdc --model gpt-5.6-sol
`),
      [
        {
          slug: "gpt-5.6-sol",
          name: "GPT 5.6 sol",
          description: "frontier model for complex work",
          upstreamProviderName: "OpenAI",
        },
        {
          slug: "gpt-5.4-mini",
          name: "GPT 5.4 mini",
          description: "fast model",
          upstreamProviderName: "OpenAI",
        },
      ],
    );
  });
});

it.effect("spawns only on send, uses Windows-safe argv, resumes, and projects final output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const resumedMock = makeMockChild();
      const children = [mock, resumedMock];
      const spawnProcess = vi.fn<SpawnProcess>(() => children.shift()!.child);
      const prepareProcess = vi.fn<PrepareProcess>((command, args, options) =>
        prepareWindowsSafeProcess(command, args, options),
      );
      const teardownProcessTree = async (child: ChildProcess) => {
        if (child === mock.child && mock.child.exitCode === null) mock.close(130);
        if (child === resumedMock.child && resumedMock.child.exitCode === null) {
          resumedMock.close(130);
        }
      };
      const { layer } = adapterLayer({
        child: mock,
        spawnProcess,
        prepareProcess,
        teardownProcessTree,
      });
      const threadId = ThreadId.makeUnsafe("command-code-thread");
      const program = Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(8))).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        assert.strictEqual(spawnProcess.mock.calls.length, 0);

        let stdin = "";
        mock.stdin.on("data", (chunk) => (stdin += chunk.toString()));
        const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
        assert.strictEqual(spawnProcess.mock.calls.length, 1);
        assert.strictEqual(prepareProcess.mock.calls.length, 1);
        assert.strictEqual(stdin, "hello");
        const [command, args, options] = spawnProcess.mock.calls[0]!;
        assert.strictEqual(options.shell, false);
        const providerArgv = process.platform === "win32" ? String(args[4]) : args.join(" ");
        if (process.platform === "win32") {
          assert.match(String(command), /cmd\.exe$/iu);
          assert.deepStrictEqual(args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
          assert.strictEqual(options.windowsVerbatimArguments, true);
        } else {
          assert.strictEqual(command, "C:\\tools\\commandcode.cmd");
        }
        assert.match(providerArgv, /--trust/u);
        assert.match(providerArgv, /--model[^\n]*gpt-5\.6-sol/u);
        assert.ok(!/hello/u.test(providerArgv));

        const concurrent = yield* adapter.sendTurn({ threadId, input: "second" }).pipe(Effect.flip);
        assert.ok(concurrent instanceof ProviderAdapterValidationError);

        mock.stderr.write("session: d37c825d-d4f7-4f7c-");
        mock.stderr.write("bfa2-f5c8a7c00119\nRunning bash tool\n");
        mock.stdout.write(Buffer.from([0xf0, 0x9f]));
        mock.stdout.write(Buffer.from([0x98, 0x80, 0x0a]));
        mock.close(0);
        const events = Array.from(yield* Fiber.join(eventFiber));
        assert.deepStrictEqual(
          events.map((event) => event.type),
          [
            "session.started",
            "thread.started",
            "turn.started",
            "thread.started",
            "item.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );
        assert.ok(!events.some((event) => event.type === "tool.progress"));
        const sessions = yield* adapter.listSessions();
        assert.deepStrictEqual(sessions[0]?.resumeCursor, {
          sessionId: "d37c825d-d4f7-4f7c-bfa2-f5c8a7c00119",
        });
        assert.strictEqual(events.at(-1)?.turnId, turn.turnId);

        let resumedStdin = "";
        resumedMock.stdin.on("data", (chunk) => (resumedStdin += chunk.toString()));
        yield* adapter.sendTurn({ threadId, input: "follow-up prompt" });
        assert.strictEqual(spawnProcess.mock.calls.length, 2);
        assert.strictEqual(prepareProcess.mock.calls.length, 2);
        assert.strictEqual(resumedStdin, "follow-up prompt");
        const resumedArgs = spawnProcess.mock.calls[1]![1] as ReadonlyArray<string>;
        const resumedArgv =
          process.platform === "win32" ? String(resumedArgs[4]) : resumedArgs.join(" ");
        assert.match(resumedArgv, /--resume[^\n]*d37c825d-d4f7-4f7c-bfa2-f5c8a7c00119/u);
        assert.ok(!/follow-up prompt/u.test(resumedArgv));
        resumedMock.close(0);
      });
      yield* program.pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("treats the prepared process command as authoritative for turn launches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const prepareProcess = vi.fn<PrepareProcess>((command, args) => ({
        command: "C:\\tools\\synara-windows-job-launcher.exe",
        args: ["--contained", command, ...args],
        shell: false,
        windowsHide: true,
      }));
      const { layer, spawnProcess } = adapterLayer({ child: mock, prepareProcess });
      const threadId = ThreadId.makeUnsafe("command-code-contained-turn");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "contained prompt" });
        const [command, args, options] = spawnProcess.mock.calls[0]!;
        assert.strictEqual(command, "C:\\tools\\synara-windows-job-launcher.exe");
        assert.strictEqual(args[0], "--contained");
        assert.strictEqual(args[1], "C:\\tools\\commandcode.cmd");
        assert.strictEqual(options.shell, false);
        assert.strictEqual(options.windowsHide, true);
        mock.close(0);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("maps synchronous process preparation failures to ProviderAdapterProcessError", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const prepareProcess = vi.fn<PrepareProcess>(() => {
        throw new Error("containment helper is unavailable");
      });
      const { layer, spawnProcess } = adapterLayer({ child: mock, prepareProcess });
      const threadId = ThreadId.makeUnsafe("command-code-prepare-failure");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        const failure = yield* adapter
          .sendTurn({ threadId, input: "must stay contained" })
          .pipe(Effect.flip);
        assert.ok(failure instanceof ProviderAdapterProcessError);
        assert.strictEqual(failure.threadId, threadId);
        assert.match(failure.detail, /containment helper is unavailable/u);
        assert.strictEqual(spawnProcess.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("defaults direct sessions to gpt-5.6-sol and validates before replacing state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      let failResolution = false;
      const { layer, spawnProcess } = adapterLayer({
        child: mock,
        resolveExecutable: () => {
          if (failResolution) throw new Error("configured binary is missing");
          return "commandcode";
        },
      });
      const threadId = ThreadId.makeUnsafe("command-code-default-model");
      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const { modelSelection: _modelSelection, ...withoutModel } = startInput(threadId);
        const session = yield* adapter.startSession(withoutModel);
        assert.strictEqual(session.model, "gpt-5.6-sol");
        failResolution = true;
        const error = yield* adapter.startSession(withoutModel).pipe(Effect.flip);
        assert.ok(error instanceof ProviderAdapterValidationError);
        assert.strictEqual(yield* adapter.hasSession(threadId), true);
        failResolution = false;
        yield* adapter.sendTurn({ threadId, input: "use the default" });
        const args = spawnProcess.mock.calls[0]?.[1] as ReadonlyArray<string>;
        assert.match(args.join(" "), /--model["\s]+gpt-5\.6-sol/u);
        mock.close(0);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("surfaces exit code 8 as a max-turn-cap failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-max-turns");
      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(5))).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "bounded task" });
        mock.close(8);
        return Array.from(yield* Fiber.join(eventFiber));
      }).pipe(Effect.provide(layer));
      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.strictEqual(completed?.payload.state, "failed");
      assert.match(completed?.payload.errorMessage ?? "", /10-turn limit/u);
    }),
  ),
);

it.effect("discovers models through the mocked CLI without a vendor call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const prepareProcess = vi.fn<PrepareProcess>((command, args) => ({
        command: "C:\\tools\\synara-windows-job-launcher.exe",
        args: ["--contained", command, ...args],
        shell: false,
        windowsHide: true,
      }));
      const { layer, spawnProcess } = adapterLayer({ child: mock, prepareProcess });
      const result = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const fiber = yield* adapter.listModels!({
          provider: "commandCode",
          cwd: process.cwd(),
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        mock.stdout.write("Available models · 1 model\n\nOpenAI\n\ngpt-5.6-sol  frontier model\n");
        mock.close(0);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        result.models.map((model) => model.slug),
        ["gpt-5.6-sol"],
      );
      assert.strictEqual(result.source, "command-code.cli");
      assert.strictEqual(prepareProcess.mock.calls.length, 1);
      assert.deepStrictEqual(prepareProcess.mock.calls[0]?.[1], ["--list-models"]);
      assert.strictEqual(
        spawnProcess.mock.calls[0]?.[0],
        "C:\\tools\\synara-windows-job-launcher.exe",
      );
      assert.deepStrictEqual(spawnProcess.mock.calls[0]?.[1].slice(0, 2), [
        "--contained",
        "C:\\tools\\commandcode.cmd",
      ]);
      assert.match(
        (spawnProcess.mock.calls[0]?.[1] as ReadonlyArray<string>).join(" "),
        /--list-models/u,
      );
    }),
  ),
);

it.effect("tears down the process tree and maps exit 130 to interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const teardown = vi.fn(async () => mock.close(130));
      const { layer } = adapterLayer({ child: mock, teardownProcessTree: teardown });
      const threadId = ThreadId.makeUnsafe("command-code-interrupt");
      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(4))).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        const turn = yield* adapter.sendTurn({ threadId, input: "long task" });
        yield* adapter.interruptTurn(threadId, turn.turnId);
        return Array.from(yield* Fiber.join(eventFiber));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(teardown.mock.calls.length, 1);
      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.strictEqual(completed?.payload.state, "interrupted");
      assert.strictEqual(completed?.payload.stopReason, "user_cancel");
    }),
  ),
);

it.effect("stopSession tears down an active process tree and removes the session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const teardown = vi.fn(async () => mock.close(130));
      const { layer } = adapterLayer({ child: mock, teardownProcessTree: teardown });
      const threadId = ThreadId.makeUnsafe("command-code-stop");
      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "long task" });
        yield* adapter.stopSession(threadId);
        assert.strictEqual(yield* adapter.hasSession(threadId), false);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(teardown.mock.calls.length, 1);
    }),
  ),
);

it.effect("releases a PID-less turn spawn failure without creating an unproven owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      Object.assign(mock.child, { pid: undefined });
      const teardown = vi.fn(async () => undefined);
      const { layer } = adapterLayer({ child: mock, teardownProcessTree: teardown });
      const threadId = ThreadId.makeUnsafe("command-code-pidless-turn");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "cannot spawn" });
        mock.error(new Error("spawn ENOENT"));
        const sessions = yield* adapter.listSessions();
        assert.strictEqual(sessions[0]?.status, "ready");
        assert.strictEqual(sessions[0]?.activeTurnId, undefined);
        assert.strictEqual(sessions[0]?.lastError, undefined);
        assert.strictEqual(teardown.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("retains the active owner when close precedes a rejected cleanup proof", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      let rejectCleanup!: (cause: Error) => void;
      let teardownCalls = 0;
      const teardown = vi.fn(() => {
        teardownCalls += 1;
        if (teardownCalls > 1) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          rejectCleanup = reject;
        });
      });
      const { layer, spawnProcess } = adapterLayer({
        child: mock,
        teardownProcessTree: teardown,
      });
      const threadId = ThreadId.makeUnsafe("command-code-close-before-proof");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        const turn = yield* adapter.sendTurn({ threadId, input: "long task" });
        const interrupt = yield* adapter
          .interruptTurn(threadId, turn.turnId)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.strictEqual(teardown.mock.calls.length, 1);

        mock.close(130);
        assert.strictEqual(interrupt.pollUnsafe(), undefined);
        rejectCleanup(new Error("close raced ahead of failed descendant proof"));
        const failure = yield* Fiber.join(interrupt).pipe(Effect.flip);
        assert.ok(failure instanceof ProviderAdapterProcessError);

        const sessions = yield* adapter.listSessions();
        assert.strictEqual(sessions[0]?.status, "error");
        assert.match(sessions[0]?.lastError ?? "", /failed descendant proof/u);
        const blocked = yield* adapter
          .sendTurn({ threadId, input: "must not overlap" })
          .pipe(Effect.flip);
        assert.ok(blocked instanceof ProviderAdapterValidationError);
        assert.strictEqual(spawnProcess.mock.calls.length, 1);

        yield* adapter.stopSession(threadId);
        assert.strictEqual(yield* adapter.hasSession(threadId), false);
        assert.strictEqual(teardown.mock.calls.length, 2);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("waits for close-driven finalization after cleanup observes exit first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const teardown = vi.fn(async () => mock.exit(130));
      const { layer } = adapterLayer({ child: mock, teardownProcessTree: teardown });
      const threadId = ThreadId.makeUnsafe("command-code-exit-before-close");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        const turn = yield* adapter.sendTurn({ threadId, input: "long task" });
        const interrupt = yield* adapter
          .interruptTurn(threadId, turn.turnId)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.strictEqual(teardown.mock.calls.length, 1);
        assert.strictEqual(interrupt.pollUnsafe(), undefined);

        mock.close(130);
        yield* Fiber.join(interrupt);
        const sessions = yield* adapter.listSessions();
        assert.strictEqual(sessions[0]?.status, "ready");
        assert.strictEqual(sessions[0]?.activeTurnId, undefined);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect(
  "retains a failed turn owner and blocks replacement until cleanup retry proves exit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockChild();
        let teardownCalls = 0;
        const teardown = vi.fn(async () => {
          teardownCalls += 1;
          if (teardownCalls <= 2) throw new Error(`cleanup proof failed ${teardownCalls}`);
          mock.close(130);
        });
        const { layer, spawnProcess } = adapterLayer({
          child: mock,
          teardownProcessTree: teardown,
        });
        const threadId = ThreadId.makeUnsafe("command-code-unproven-owner");

        yield* Effect.gen(function* () {
          const adapter = yield* CommandCodeAdapter;
          yield* adapter.startSession(startInput(threadId));
          yield* adapter.sendTurn({ threadId, input: "first child" });
          mock.error(new Error("command stream failed"));
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

          const blockedTurn = yield* adapter
            .sendTurn({ threadId, input: "must not overlap" })
            .pipe(Effect.flip);
          assert.ok(blockedTurn instanceof ProviderAdapterValidationError);
          assert.match(blockedTurn.message, /process tree is still unproven/u);
          assert.strictEqual(spawnProcess.mock.calls.length, 1);

          const blockedRestart = yield* adapter
            .startSession(startInput(threadId))
            .pipe(Effect.flip);
          assert.ok(blockedRestart instanceof ProviderAdapterProcessError);
          assert.strictEqual(yield* adapter.hasSession(threadId), true);
          assert.strictEqual(spawnProcess.mock.calls.length, 1);

          yield* adapter.stopSession(threadId);
          assert.strictEqual(yield* adapter.hasSession(threadId), false);
          assert.strictEqual(teardown.mock.calls.length, 3);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "serializes model discovery and blocks replacement until retained cleanup is proven",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = makeMockChild();
        const spawnProcess = vi.fn<SpawnProcess>(() => first.child);
        let teardownCalls = 0;
        const teardown = vi.fn(async () => {
          teardownCalls += 1;
          if (teardownCalls <= 2) throw new Error(`model cleanup proof failed ${teardownCalls}`);
        });
        const { layer } = adapterLayer({
          child: first,
          spawnProcess,
          teardownProcessTree: teardown,
        });

        yield* Effect.gen(function* () {
          const adapter = yield* CommandCodeAdapter;
          const firstLookup = yield* adapter.listModels!({
            provider: "commandCode",
            cwd: process.cwd(),
          }).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const replacementLookup = yield* adapter.listModels!({
            provider: "commandCode",
            cwd: process.cwd(),
          }).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.strictEqual(replacementLookup.pollUnsafe(), undefined);
          assert.strictEqual(spawnProcess.mock.calls.length, 1);

          first.error(new Error("model discovery stream failed"));
          const firstFailure = yield* Fiber.join(firstLookup).pipe(Effect.flip);
          assert.ok(firstFailure instanceof ProviderAdapterRequestError);
          assert.match(firstFailure.message, /cleanup could not be proven/u);

          const replacementFailure = yield* Fiber.join(replacementLookup).pipe(Effect.flip);
          assert.ok(replacementFailure instanceof ProviderAdapterRequestError);
          assert.match(replacementFailure.message, /cleanup could not be proven/u);
          assert.strictEqual(spawnProcess.mock.calls.length, 1);
          assert.strictEqual(teardown.mock.calls.length, 2);

          yield* adapter.stopAll();
          assert.strictEqual(teardown.mock.calls.length, 3);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("releases a PID-less model-discovery spawn failure without retaining cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      Object.assign(mock.child, { pid: undefined });
      const teardown = vi.fn(async () => undefined);
      const { layer } = adapterLayer({ child: mock, teardownProcessTree: teardown });

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const lookup = yield* adapter.listModels!({
          provider: "commandCode",
          cwd: process.cwd(),
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        mock.error(new Error("model discovery ENOENT"));
        const failure = yield* Fiber.join(lookup).pipe(Effect.flip);
        assert.ok(failure instanceof ProviderAdapterRequestError);
        assert.match(failure.message, /ENOENT/u);
        assert.strictEqual(teardown.mock.calls.length, 0);
        yield* adapter.stopAll();
      }).pipe(Effect.provide(layer));
    }),
  ),
);
