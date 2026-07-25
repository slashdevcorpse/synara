import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { it, assert, describe, vi } from "@effect/vitest";
import { Effect, Fiber, Layer, Result, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CommandCodeAdapter } from "../Services/CommandCodeAdapter.ts";
import {
  findProviderProcessExitUnprovenError,
  ProviderProcessExitUnprovenError,
} from "../supervisedProcessTeardown.ts";
import type { ProviderMaintenanceOwnedResourceCoordinator } from "../providerMaintenanceOwnedResources.ts";
import {
  buildCommandCodeTurnArgs,
  commandCodeExitCodeMessage,
  makeCommandCodeAdapterLive,
  parseCommandCodeModelList,
  type CommandCodeAdapterLiveOptions,
} from "./CommandCodeAdapter.ts";

type SpawnProcess = NonNullable<CommandCodeAdapterLiveOptions["spawnProcess"]>;
type SpawnProcessMock = ReturnType<typeof vi.fn<SpawnProcess>>;
type PrepareProcess = NonNullable<CommandCodeAdapterLiveOptions["prepareProcess"]>;
type PrepareProcessMock = ReturnType<typeof vi.fn<PrepareProcess>>;
type ResolveExecutable = NonNullable<CommandCodeAdapterLiveOptions["resolveExecutable"]>;

interface MockChild {
  readonly child: ChildProcess;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  error(cause: Error): void;
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
    close(code, signal = null) {
      Object.assign(emitter, { exitCode: code, signalCode: signal });
      emitter.emit("exit", code, signal);
      emitter.emit("close", code, signal);
    },
  };
}

function adapterLayer(input: {
  readonly child: MockChild;
  readonly spawnProcess?: SpawnProcessMock;
  readonly prepareProcess?: PrepareProcessMock;
  readonly teardownProcessTree?: (child: ChildProcess) => Promise<unknown>;
  readonly resolveExecutable?: ResolveExecutable;
  readonly platform?: NodeJS.Platform;
  readonly superviseProcess?: CommandCodeAdapterLiveOptions["superviseProcess"];
  readonly maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator;
}) {
  const spawnProcess = input.spawnProcess ?? vi.fn<SpawnProcess>(() => input.child.child);
  const teardownProcessTree =
    input.teardownProcessTree ??
    (async () => {
      if (input.child.child.exitCode === null) input.child.close(130);
    });
  return {
    spawnProcess,
    layer: makeCommandCodeAdapterLive({
      platform: input.platform ?? "linux",
      spawnProcess,
      prepareProcess: input.prepareProcess ?? prepareWindowsSafeProcess,
      teardownProcessTree,
      superviseProcess:
        input.superviseProcess ??
        ((_prepared, child) => ({
          rootPid: Number(child.pid),
          proveExit: async () => ({ escalated: false, signalErrors: [] }),
          teardown: async () => {
            await teardownProcessTree(child);
            return { escalated: false, signalErrors: [] };
          },
          requestTermination: (signal) => child.kill(signal),
        })),
      ...(input.maintenanceOwnedResources
        ? { maintenanceOwnedResources: input.maintenanceOwnedResources }
        : {}),
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

const COMMAND_CODE_SESSION_ID = "d37c825d-d4f7-4f7c-bfa2-f5c8a7c00119";

function writeHeadlessRecord(
  mock: MockChild,
  record: Readonly<Record<string, unknown>>,
  ending = "\n",
): void {
  mock.stdout.write(`${JSON.stringify(record)}${ending}`);
}

function successfulResultRecord(
  input: {
    readonly sessionId?: string;
    readonly finalText?: string;
    readonly stopReason?: string;
    readonly usage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
    };
  } = {},
): Readonly<Record<string, unknown>> {
  return {
    type: "result",
    subtype: "success",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    stopReason: input.stopReason ?? "end_turn",
    usage: input.usage ?? {
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    },
    durationMs: 25,
    finalText: input.finalText ?? "",
  };
}

function writeSuccessfulResult(
  mock: MockChild,
  input: Parameters<typeof successfulResultRecord>[0] = {},
): void {
  writeHeadlessRecord(mock, successfulResultRecord(input));
}

function completeSuccessfulTurn(
  mock: MockChild,
  input?: Parameters<typeof writeSuccessfulResult>[1],
): void {
  writeSuccessfulResult(mock, input);
  mock.close(0);
}

function eventToolCallId(event: ProviderRuntimeEvent): string | undefined {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return undefined;
  }
  if (event.payload.itemType !== "dynamic_tool_call") return undefined;
  const data: unknown = event.payload.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const toolCallId = (data as Readonly<Record<string, unknown>>).toolCallId;
  return typeof toolCallId === "string" ? toolCallId : undefined;
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
      "--output-format",
      "json",
      "--skip-onboarding",
      "--trust",
      "--no-auto-update",
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

  it.effect("propagates Windows, macOS, and Linux launch semantics through the adapter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const platform of ["win32", "darwin", "linux"] as const) {
          const mock = makeMockChild();
          const prepareProcess = vi.fn<PrepareProcess>((command, args, options) => ({
            command,
            args: [...args],
            shell: false,
            ...(platform === "win32" ? { windowsHide: true as const } : {}),
          }));
          const { layer, spawnProcess } = adapterLayer({
            child: mock,
            platform,
            prepareProcess,
          });
          const threadId = ThreadId.makeUnsafe(`command-code-platform-${platform}`);

          yield* Effect.gen(function* () {
            const adapter = yield* CommandCodeAdapter;
            yield* adapter.startSession(startInput(threadId));
            yield* adapter.sendTurn({ threadId, input: `run on ${platform}` });

            assert.strictEqual(prepareProcess.mock.calls[0]?.[2]?.platform, platform);
            assert.strictEqual(spawnProcess.mock.calls[0]?.[2].detached, platform !== "win32");
            assert.strictEqual(
              spawnProcess.mock.calls[0]?.[2].windowsHide,
              platform === "win32" ? true : undefined,
            );

            yield* adapter.stopSession(threadId);
          }).pipe(Effect.provide(layer));
        }
      }),
    ),
  );

  it("maps documented v1 process exits to actionable messages", () => {
    assert.match(commandCodeExitCodeMessage(3) ?? "", /not authenticated/u);
    assert.match(commandCodeExitCodeMessage(4) ?? "", /denied/u);
    assert.match(commandCodeExitCodeMessage(5) ?? "", /rate limited/u);
    assert.match(commandCodeExitCodeMessage(6) ?? "", /network failure/u);
    assert.match(commandCodeExitCodeMessage(7) ?? "", /API server error/u);
    assert.match(commandCodeExitCodeMessage(8, 27) ?? "", /27-turn limit/u);
    assert.match(commandCodeExitCodeMessage(9) ?? "", /no response/u);
    assert.match(commandCodeExitCodeMessage(10) ?? "", /insufficient credits/u);
    assert.strictEqual(commandCodeExitCodeMessage(0), undefined);
    assert.strictEqual(commandCodeExitCodeMessage(1), undefined);
    assert.strictEqual(commandCodeExitCodeMessage(130), undefined);
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
        platform: process.platform,
      });
      const threadId = ThreadId.makeUnsafe("command-code-thread");
      const program = Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(9))).pipe(
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
        assert.match(providerArgv, /--output-format[^\n]*json/u);
        assert.match(providerArgv, /--no-auto-update/u);
        assert.match(providerArgv, /--model[^\n]*gpt-5\.6-sol/u);
        assert.ok(!/hello/u.test(providerArgv));

        const concurrent = yield* adapter.sendTurn({ threadId, input: "second" }).pipe(Effect.flip);
        assert.ok(concurrent instanceof ProviderAdapterValidationError);

        mock.stderr.write("Running bash tool\n");
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "run_start", sessionId: COMMAND_CODE_SESSION_ID },
        });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "text_delta", delta: "😀\n" },
        });
        writeSuccessfulResult(mock, {
          sessionId: COMMAND_CODE_SESSION_ID,
          finalText: "😀\n",
        });
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
            "thread.token-usage.updated",
            "turn.completed",
          ],
        );
        assert.ok(!events.some((event) => event.type === "tool.progress"));
        const sessions = yield* adapter.listSessions();
        assert.deepStrictEqual(sessions[0]?.resumeCursor, {
          sessionId: COMMAND_CODE_SESSION_ID,
          totalProcessedTokens: 16,
        });
        const snapshot = yield* adapter.readThread(threadId);
        assert.deepStrictEqual(snapshot.turns[0]?.items, [
          { type: "assistant_message", text: "😀\n" },
        ]);
        assert.strictEqual(events.at(-1)?.turnId, turn.turnId);
        const firstUsage = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
            event.type === "thread.token-usage.updated",
        );
        assert.deepStrictEqual(firstUsage?.payload.usage, {
          usedTokens: 16,
          totalProcessedTokens: 16,
          inputTokens: 12,
          cachedInputTokens: 3,
          outputTokens: 4,
          lastUsedTokens: 16,
          lastInputTokens: 12,
          lastCachedInputTokens: 3,
          lastOutputTokens: 4,
          toolUses: 0,
          durationMs: 25,
        });

        let resumedStdin = "";
        resumedMock.stdin.on("data", (chunk) => (resumedStdin += chunk.toString()));
        const resumedEventFiber = yield* Stream.runCollect(
          adapter.streamEvents.pipe(Stream.take(3)),
        ).pipe(Effect.forkChild);
        yield* adapter.sendTurn({ threadId, input: "follow-up prompt" });
        assert.strictEqual(spawnProcess.mock.calls.length, 2);
        assert.strictEqual(prepareProcess.mock.calls.length, 2);
        assert.strictEqual(resumedStdin, "follow-up prompt");
        const resumedArgs = spawnProcess.mock.calls[1]![1] as ReadonlyArray<string>;
        const resumedArgv =
          process.platform === "win32" ? String(resumedArgs[4]) : resumedArgs.join(" ");
        assert.match(resumedArgv, new RegExp(`--resume[^\\n]*${COMMAND_CODE_SESSION_ID}`, "u"));
        assert.ok(!/follow-up prompt/u.test(resumedArgv));
        completeSuccessfulTurn(resumedMock);
        const resumedEvents = Array.from(yield* Fiber.join(resumedEventFiber));
        assert.deepStrictEqual(
          resumedEvents.map((event) => event.type),
          ["turn.started", "thread.token-usage.updated", "turn.completed"],
        );
        const resumedUsage = resumedEvents.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
            event.type === "thread.token-usage.updated",
        );
        assert.deepStrictEqual(resumedUsage?.payload.usage, {
          usedTokens: 16,
          totalProcessedTokens: 32,
          inputTokens: 12,
          cachedInputTokens: 3,
          outputTokens: 4,
          lastUsedTokens: 16,
          lastInputTokens: 12,
          lastCachedInputTokens: 3,
          lastOutputTokens: 4,
          toolUses: 0,
          durationMs: 25,
        });
      });
      yield* program.pipe(Effect.provide(layer));
    }),
  ),
);

it.effect(
  "rehydrates cumulative usage and replaces a resume selector with the canonical v1 session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockChild();
        const { layer, spawnProcess } = adapterLayer({ child: mock });
        const threadId = ThreadId.makeUnsafe("command-code-rehydrated-cursor");
        const resumeSelector = "imported-session-selector";
        const canonicalSessionId = "059dff13-55c7-4166-82d7-63aa50ec5275";

        const events = yield* Effect.gen(function* () {
          const adapter = yield* CommandCodeAdapter;
          const eventFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          const session = yield* adapter.startSession({
            ...startInput(threadId),
            resumeCursor: {
              sessionId: resumeSelector,
              totalProcessedTokens: 37,
            },
          });
          assert.deepStrictEqual(session.resumeCursor, {
            sessionId: resumeSelector,
            totalProcessedTokens: 37,
          });

          const turn = yield* adapter.sendTurn({ threadId, input: "resume imported work" });
          assert.deepStrictEqual(turn.resumeCursor, {
            sessionId: resumeSelector,
            totalProcessedTokens: 37,
          });
          const args = spawnProcess.mock.calls[0]?.[1] as ReadonlyArray<string>;
          assert.match(args.join(" "), new RegExp(`--resume\\s+${resumeSelector}`, "u"));

          writeHeadlessRecord(mock, {
            type: "event",
            event: { type: "run_start", sessionId: canonicalSessionId },
          });
          writeSuccessfulResult(mock, {
            sessionId: canonicalSessionId,
            usage: {
              inputTokens: 20,
              outputTokens: 5,
              cacheReadTokens: 8,
              cacheWriteTokens: 1,
            },
          });
          mock.close(0);

          const observed = Array.from(yield* Fiber.join(eventFiber));
          assert.deepStrictEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
            sessionId: canonicalSessionId,
            totalProcessedTokens: 62,
          });
          return observed;
        }).pipe(Effect.provide(layer));

        const threadStarted = events.filter((event) => event.type === "thread.started");
        assert.strictEqual(threadStarted.length, 2);
        assert.deepStrictEqual(threadStarted[0]?.payload, {});
        assert.strictEqual(threadStarted[0]?.providerRefs, undefined);
        assert.deepStrictEqual(threadStarted[1]?.payload, {
          providerThreadId: canonicalSessionId,
        });
        assert.strictEqual(threadStarted[1]?.providerRefs?.providerThreadId, canonicalSessionId);
        const usage = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
            event.type === "thread.token-usage.updated",
        );
        assert.strictEqual(usage?.payload.usage.totalProcessedTokens, 62);
      }),
    ),
);

it.effect("projects v1 reasoning, tools, final-text fallback, and usage without raw NDJSON", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-structured-events");
      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* Stream.runCollect(
          adapter.streamEvents.pipe(Stream.take(13)),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "inspect the project" });

        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "thinking_delta", delta: "Inspecting files." },
        });
        writeHeadlessRecord(mock, {
          type: "event",
          event: {
            type: "tool_running",
            toolCallId: "call_read_1",
            toolName: "read_file",
            description: "Read package.json",
          },
        });
        writeHeadlessRecord(mock, {
          type: "event",
          event: {
            type: "tool_completed",
            toolCallId: "call_read_1",
            toolName: "read_file",
            result: { path: "package.json", ok: true },
          },
        });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "future_v1_event", ignored: true },
        });
        writeSuccessfulResult(mock, { finalText: "Inspection complete." });
        mock.close(0);

        const observed = Array.from(yield* Fiber.join(eventFiber));
        const snapshot = yield* adapter.readThread(threadId);
        assert.deepStrictEqual(snapshot.turns[0]?.items, [
          { type: "reasoning", text: "Inspecting files." },
          { type: "assistant_message", text: "Inspection complete." },
        ]);
        return observed;
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "thread.started",
          "turn.started",
          "item.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "item.started",
          "content.delta",
          "item.completed",
          "thread.token-usage.updated",
          "turn.completed",
        ],
      );
      const toolCompleted = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      );
      assert.deepStrictEqual(
        toolCompleted?.type === "item.completed" ? toolCompleted.payload.data : undefined,
        {
          toolCallId: "call_read_1",
          toolName: "read_file",
          result: { path: "package.json", ok: true },
        },
      );
      const usage = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
          event.type === "thread.token-usage.updated",
      );
      assert.deepStrictEqual(usage?.payload.usage, {
        usedTokens: 16,
        totalProcessedTokens: 16,
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 4,
        lastUsedTokens: 16,
        lastInputTokens: 12,
        lastCachedInputTokens: 3,
        lastOutputTokens: 4,
        toolUses: 1,
        durationMs: 25,
      });
      assert.ok(
        !events.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta.includes('"type":"event"'),
        ),
      );
    }),
  ),
);

it.effect("bounds multibyte tool payload previews by UTF-8 bytes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-multibyte-tool-preview");
      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(7))).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "read the large payload" });

        writeHeadlessRecord(mock, {
          type: "event",
          event: {
            type: "tool_completed",
            toolCallId: "call_multibyte",
            toolName: "read_file",
            result: { text: "界".repeat(30_000) },
          },
        });
        completeSuccessfulTurn(mock);

        return Array.from(yield* Fiber.join(eventFiber));
      }).pipe(Effect.provide(layer));

      const toolCompleted = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      );
      const data =
        toolCompleted?.type === "item.completed" ? toolCompleted.payload.data : undefined;
      assert.ok(typeof data === "object" && data !== null && !Array.isArray(data));
      const compacted = data as Readonly<Record<string, unknown>>;
      assert.strictEqual(compacted.truncated, true);
      assert.ok(typeof compacted.originalBytes === "number" && compacted.originalBytes > 64 * 1024);
      assert.strictEqual(typeof compacted.preview, "string");
      if (typeof compacted.preview !== "string") return;
      assert.ok(Buffer.byteLength(compacted.preview, "utf8") <= 64 * 1024);
      assert.ok(!compacted.preview.includes("\uFFFD"));
    }),
  ),
);

it.effect("projects v1 tool updates and terminal denied or hook-blocked states", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-tool-terminals");
      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "exercise tool lifecycle" });

        for (const event of [
          {
            type: "tool_queued",
            toolCallId: "call_progress",
            toolName: "read_file",
            input: { file_path: "package.json" },
          },
          {
            type: "tool_running",
            toolCallId: "call_progress",
            toolName: "read_file",
            description: "r".repeat(5_000),
          },
          {
            type: "tool_update",
            toolCallId: "call_progress",
            toolName: "read_file",
            partial: { bytesRead: 128 },
          },
          {
            type: "tool_completed",
            toolCallId: "call_progress",
            toolName: "read_file",
            result: { ok: true },
          },
          {
            type: "tool_queued",
            toolCallId: "call_denied",
            toolName: "shell",
            input: { command: "echo blocked" },
          },
          {
            type: "tool_denied",
            toolCallId: "call_denied",
            toolName: "shell",
          },
          {
            type: "tool_hook_blocked",
            toolCallId: "call_hook",
            toolName: "write_file",
            hookOutput: "x".repeat(5_000),
          },
          {
            type: "tool_errored",
            toolCallId: "call_error",
            toolName: "shell",
            error: "e".repeat(5_000),
          },
        ]) {
          writeHeadlessRecord(mock, { type: "event", event });
        }
        completeSuccessfulTurn(mock);
        return Array.from(yield* Fiber.join(eventFiber));
      }).pipe(Effect.provide(layer));

      const progressEvents = events.filter((event) => eventToolCallId(event) === "call_progress");
      assert.deepStrictEqual(
        progressEvents.map((event) => event.type),
        ["item.started", "item.updated", "item.updated", "item.completed"],
      );
      const update = progressEvents.find((event) => event.type === "item.updated");
      assert.ok(
        progressEvents.some(
          (event) =>
            event.type === "item.updated" &&
            JSON.stringify(event.payload.data).includes('"bytesRead":128'),
        ),
      );
      assert.ok(update);
      const runningDetail = progressEvents.find(
        (event) => event.type === "item.updated" && event.payload.detail,
      );
      assert.ok(
        runningDetail?.type === "item.updated" && runningDetail.payload.detail?.endsWith("…"),
      );
      assert.ok(
        (runningDetail?.type === "item.updated"
          ? (runningDetail.payload.detail?.length ?? 0)
          : 0) <= 4_097,
      );

      const denied = events.find(
        (event) => event.type === "item.completed" && eventToolCallId(event) === "call_denied",
      );
      assert.strictEqual(
        denied?.type === "item.completed" ? denied.payload.status : undefined,
        "failed",
      );
      assert.match(
        denied?.type === "item.completed" ? (denied.payload.detail ?? "") : "",
        /permission.*denied/iu,
      );

      const hookBlocked = events.find(
        (event) => event.type === "item.completed" && eventToolCallId(event) === "call_hook",
      );
      assert.strictEqual(
        hookBlocked?.type === "item.completed" ? hookBlocked.payload.status : undefined,
        "failed",
      );
      const hookDetail =
        hookBlocked?.type === "item.completed" ? (hookBlocked.payload.detail ?? "") : "";
      assert.ok(hookDetail.endsWith("…"));
      assert.ok(hookDetail.length <= 4_097);
      const toolErrored = events.find(
        (event) => event.type === "item.completed" && eventToolCallId(event) === "call_error",
      );
      const errorDetail =
        toolErrored?.type === "item.completed" ? (toolErrored.payload.detail ?? "") : "";
      assert.strictEqual(
        toolErrored?.type === "item.completed" ? toolErrored.payload.status : undefined,
        "failed",
      );
      assert.ok(errorDetail.endsWith("…"));
      assert.ok(errorDetail.length <= 4_097);
      assert.ok(
        !events.some(
          (event) =>
            event.type === "item.completed" &&
            eventToolCallId(event) === "call_denied" &&
            /ended before reporting/iu.test(event.payload.detail ?? ""),
        ),
      );
    }),
  ),
);

it.effect("coalesces v1 deltas across ignored cumulative snapshots", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-coalesced-deltas");
      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "stream compactly" });

        const records: Readonly<Record<string, unknown>>[] = [];
        let cumulative = "";
        for (let index = 0; index < 100; index += 1) {
          cumulative += "x";
          records.push({
            type: "event",
            event: { type: "text_delta", delta: "x" },
          });
          records.push({
            type: "event",
            event: {
              type: "message_update",
              content: [{ type: "text", text: cumulative }],
            },
          });
        }
        records.push(successfulResultRecord({ finalText: cumulative }));
        mock.stdout.write(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
        mock.close(0);

        const observed = Array.from(yield* Fiber.join(eventFiber));
        const snapshot = yield* adapter.readThread(threadId);
        assert.deepStrictEqual(snapshot.turns[0]?.items, [
          { type: "assistant_message", text: cumulative },
        ]);
        return observed;
      }).pipe(Effect.provide(layer));

      const textDeltas = events.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.strictEqual(textDeltas.length, 1);
      assert.strictEqual(
        textDeltas[0]?.type === "content.delta" ? textDeltas[0].payload.delta : undefined,
        "x".repeat(100),
      );
    }),
  ),
);

it.effect("uses structured v1 errors and preserves an existing resume cursor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-structured-error");
      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(6))).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession({
          ...startInput(threadId),
          resumeCursor: { sessionId: COMMAND_CODE_SESSION_ID },
        });
        yield* adapter.sendTurn({ threadId, input: "requires authentication" });
        writeHeadlessRecord(mock, {
          type: "result",
          subtype: "error",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          durationMs: 12,
          finalText: "",
          error: "Login required by Command Code.",
        });
        mock.close(3);
        const observed = Array.from(yield* Fiber.join(eventFiber));
        assert.deepStrictEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
          sessionId: COMMAND_CODE_SESSION_ID,
          totalProcessedTokens: 0,
        });
        return observed;
      }).pipe(Effect.provide(layer));

      const runtimeError = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "runtime.error" }> =>
          event.type === "runtime.error",
      );
      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.strictEqual(runtimeError?.payload.message, "Login required by Command Code.");
      assert.strictEqual(completed?.payload.state, "failed");
      assert.strictEqual(completed?.payload.errorMessage, "Login required by Command Code.");
    }),
  ),
);

it.effect("fails closed when a clean process exit omits the terminal v1 result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-missing-result");
      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(8))).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "must have a result" });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "text_delta", delta: "partial output" },
        });
        mock.close(0);
        return Array.from(yield* Fiber.join(eventFiber));
      }).pipe(Effect.provide(layer));

      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.strictEqual(completed?.payload.state, "failed");
      assert.match(completed?.payload.errorMessage ?? "", /without a final result/u);
      assert.strictEqual(events.filter((event) => event.type === "turn.completed").length, 1);
    }),
  ),
);

it.effect("fails the turn instead of ignoring a malformed recognized v1 event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-malformed-known-event");
      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "reject malformed events" });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "text_delta", delta: "valid prefix" },
        });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "thinking_delta", delta: 42 },
        });
        return Array.from(yield* Fiber.join(eventFiber));
      }).pipe(Effect.provide(layer));

      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.strictEqual(completed?.payload.state, "failed");
      assert.match(completed?.payload.errorMessage ?? "", /supported v1 schema/iu);
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["valid prefix"],
      );
    }),
  ),
);

it.effect("retains turn ownership when a parser failure and exit-proof failure coincide", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const processFailure = new ProviderProcessExitUnprovenError({
        rootPid: 7_001,
        rootExited: true,
        remainingDescendantPids: [7_002],
        captureComplete: true,
      });
      const teardown = vi.fn(async () => undefined);
      const { layer } = adapterLayer({
        child: mock,
        teardownProcessTree: teardown,
        superviseProcess: (_prepared, child) => ({
          rootPid: Number(child.pid),
          proveExit: vi.fn(async () => {
            throw processFailure;
          }),
          teardown: async () => ({ escalated: false, signalErrors: [] }),
          requestTermination: (signal) => child.kill(signal),
        }),
      });
      const threadId = ThreadId.makeUnsafe("command-code-parser-and-proof-failure");

      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "retain failed ownership" });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "text_delta", delta: "partial" },
        });
        mock.close(0);

        const observed = Array.from(yield* Fiber.join(eventFiber));
        const [session] = yield* adapter.listSessions();
        assert.strictEqual(session?.status, "running");
        assert.ok(session?.activeTurnId);
        yield* adapter.stopAll();
        return observed;
      }).pipe(Effect.provide(layer));

      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.strictEqual(completed?.payload.state, "failed");
      assert.match(completed?.payload.errorMessage ?? "", /without a final result/iu);
    }),
  ),
);

it.effect("fails a turn when structured session identifiers disagree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-session-id-mismatch");
      const firstSessionId = "4f16b12f-3e8c-45b0-976e-158f0699de65";
      const secondSessionId = "8caecbaa-754b-4b44-a9d2-f0b3a3699560";

      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "keep one session identity" });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "run_start", sessionId: firstSessionId },
        });
        writeHeadlessRecord(mock, successfulResultRecord({ sessionId: secondSessionId }));

        const observed = Array.from(yield* Fiber.join(eventFiber));
        assert.deepStrictEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
          sessionId: firstSessionId,
          totalProcessedTokens: 0,
        });
        return observed;
      }).pipe(Effect.provide(layer));

      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.strictEqual(completed?.payload.state, "failed");
      assert.match(completed?.payload.errorMessage ?? "", /changed session identifiers/iu);
      assert.ok(
        !events.some(
          (event) =>
            event.type === "thread.started" && event.payload.providerThreadId === secondSessionId,
        ),
      );
    }),
  ),
);

it.effect("preserves repeated assistant and reasoning interleaving in thread snapshots", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-item-order");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "emit assistant first" });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "text_delta", delta: "answer first" },
        });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "thinking_delta", delta: "reasoning later" },
        });
        writeHeadlessRecord(mock, {
          type: "event",
          event: { type: "text_delta", delta: "answer again" },
        });
        completeSuccessfulTurn(mock, { finalText: "answer firstanswer again" });
        const events = Array.from(yield* Fiber.join(eventFiber));

        const snapshot = yield* adapter.readThread(threadId);
        assert.deepStrictEqual(snapshot.turns[0]?.items, [
          { type: "assistant_message", text: "answer first" },
          { type: "reasoning", text: "reasoning later" },
          { type: "assistant_message", text: "answer again" },
        ]);
        const textLifecycle = events.filter(
          (event) =>
            (event.type === "item.started" || event.type === "item.completed") &&
            (event.payload.itemType === "assistant_message" ||
              event.payload.itemType === "reasoning"),
        );
        assert.deepStrictEqual(
          textLifecycle.map((event) => event.type),
          [
            "item.started",
            "item.completed",
            "item.started",
            "item.completed",
            "item.started",
            "item.completed",
          ],
        );
        const startedIds = textLifecycle
          .filter((event) => event.type === "item.started")
          .map((event) => event.itemId);
        const completedIds = textLifecycle
          .filter((event) => event.type === "item.completed")
          .map((event) => event.itemId);
        assert.strictEqual(new Set(startedIds).size, 3);
        assert.deepStrictEqual(completedIds, startedIds);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("suppresses Command Code self-updates for session, turn, and model-list launches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const turnChild = makeMockChild();
      const modelListChild = makeMockChild();
      const children = [turnChild, modelListChild];
      const spawnProcess = vi.fn<SpawnProcess>(() => children.shift()!.child);
      const resolveExecutable = vi.fn<ResolveExecutable>(() => "C:\\tools\\commandcode.cmd");
      const { layer } = adapterLayer({
        child: turnChild,
        spawnProcess,
        resolveExecutable,
      });
      const threadId = ThreadId.makeUnsafe("command-code-skip-updates");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        assert.strictEqual(resolveExecutable.mock.calls[0]?.[1].env.COMMANDCODE_SKIP_UPDATES, "1");

        yield* adapter.sendTurn({ threadId, input: "do not self-update" });
        assert.strictEqual(spawnProcess.mock.calls[0]?.[2].env?.COMMANDCODE_SKIP_UPDATES, "1");
        completeSuccessfulTurn(turnChild);

        const listing = yield* adapter.listModels!({
          provider: "commandCode",
          cwd: process.cwd(),
        }).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(spawnProcess.mock.calls.length, 2)),
        );
        assert.strictEqual(resolveExecutable.mock.calls[1]?.[1].env.COMMANDCODE_SKIP_UPDATES, "1");
        assert.strictEqual(spawnProcess.mock.calls[1]?.[2].env?.COMMANDCODE_SKIP_UPDATES, "1");
        modelListChild.stdout.write(
          "Available models · 1 model\n\nOpenAI\n\ngpt-5.6-sol  frontier model\n",
        );
        modelListChild.close(0);
        yield* Fiber.join(listing);
      }).pipe(Effect.provide(layer));
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
        completeSuccessfulTurn(mock);
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

it.effect("does not spawn when stopSession wins during async process preparation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      type PreparedProcess = Awaited<ReturnType<PrepareProcess>>;
      let resolvePreparation!: (prepared: PreparedProcess) => void;
      const pendingPreparation = new Promise<PreparedProcess>((resolve) => {
        resolvePreparation = resolve;
      });
      const prepareProcess = vi.fn<PrepareProcess>(() => pendingPreparation);
      const { layer, spawnProcess } = adapterLayer({ child: mock, prepareProcess });
      const threadId = ThreadId.makeUnsafe("command-code-stop-during-prepare");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        const sendFiber = yield* adapter
          .sendTurn({ threadId, input: "must not launch" })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(prepareProcess.mock.calls.length, 1)),
        );

        yield* adapter.stopSession(threadId);
        resolvePreparation({
          command: "C:\\tools\\synara-windows-job-launcher.exe",
          args: ["--contained", "C:\\tools\\commandcode.cmd"],
          shell: false,
          windowsHide: true,
        });

        const result = yield* Fiber.join(sendFiber);
        assert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
          assert.ok(result.failure instanceof ProviderAdapterValidationError);
        }
        assert.strictEqual(spawnProcess.mock.calls.length, 0);
        assert.strictEqual(yield* adapter.hasSession(threadId), false);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("does not spawn when a replacement session wins during async process preparation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      type PreparedProcess = Awaited<ReturnType<PrepareProcess>>;
      let resolvePreparation!: (prepared: PreparedProcess) => void;
      const pendingPreparation = new Promise<PreparedProcess>((resolve) => {
        resolvePreparation = resolve;
      });
      const prepareProcess = vi.fn<PrepareProcess>(() => pendingPreparation);
      const { layer, spawnProcess } = adapterLayer({ child: mock, prepareProcess });
      const threadId = ThreadId.makeUnsafe("command-code-replace-during-prepare");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        const sendFiber = yield* adapter
          .sendTurn({ threadId, input: "must not outlive replacement" })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(prepareProcess.mock.calls.length, 1)),
        );

        yield* adapter.startSession(startInput(threadId));
        resolvePreparation({
          command: "C:\\tools\\synara-windows-job-launcher.exe",
          args: ["--contained", "C:\\tools\\commandcode.cmd"],
          shell: false,
          windowsHide: true,
        });

        const result = yield* Fiber.join(sendFiber);
        assert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
          assert.ok(result.failure instanceof ProviderAdapterValidationError);
        }
        assert.strictEqual(spawnProcess.mock.calls.length, 0);
        assert.strictEqual(yield* adapter.hasSession(threadId), true);
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("drops late process-close events after the adapter scope shuts down", () =>
  Effect.gen(function* () {
    const mock = makeMockChild();
    const teardown = vi.fn(async () => undefined);
    const { layer } = adapterLayer({
      child: mock,
      teardownProcessTree: teardown,
    });
    const threadId = ThreadId.makeUnsafe("command-code-late-close-after-scope");

    yield* Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "close after scope" });
      }).pipe(Effect.provide(layer)),
    );
    assert.strictEqual(teardown.mock.calls.length, 1);

    let unhandledRejection: unknown;
    const captureUnhandledRejection = (reason: unknown): void => {
      unhandledRejection = reason;
    };
    process.once("unhandledRejection", captureUnhandledRejection);
    try {
      assert.doesNotThrow(() => mock.close(0));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
      );
      assert.strictEqual(unhandledRejection, undefined);
    } finally {
      process.off("unhandledRejection", captureUnhandledRejection);
    }
  }),
);

it.effect("drains a PID-less pending turn when the adapter scope is interrupted", () =>
  Effect.gen(function* () {
    const mock = makeMockChild();
    delete (mock.child as ChildProcess & { pid?: number }).pid;
    const teardown = vi.fn(async () => mock.close(130));
    const { layer, spawnProcess } = adapterLayer({
      child: mock,
      teardownProcessTree: teardown,
    });
    const threadId = ThreadId.makeUnsafe("command-code-pending-turn-scope-shutdown");

    yield* Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        yield* adapter
          .sendTurn({ threadId, input: "scope must own this pending child" })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(spawnProcess.mock.calls.length, 1)),
        );
        setTimeout(() => {
          Object.assign(mock.child, { pid: 6_521 });
          mock.child.emit("spawn");
        }, 10);
      }).pipe(Effect.provide(layer)),
    );

    assert.strictEqual(teardown.mock.calls.length, 1);
    assert.strictEqual(mock.stdout.listenerCount("data"), 0);
  }),
);

it.effect("drains PID-less pending model discovery when the adapter scope is interrupted", () =>
  Effect.gen(function* () {
    const mock = makeMockChild();
    delete (mock.child as ChildProcess & { pid?: number }).pid;
    const teardown = vi.fn(async () => mock.close(130));
    const { layer, spawnProcess } = adapterLayer({
      child: mock,
      teardownProcessTree: teardown,
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.listModels!({
          provider: "commandCode",
          cwd: process.cwd(),
        }).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(spawnProcess.mock.calls.length, 1)),
        );
        assert.strictEqual(mock.stdout.listenerCount("data"), 0);
        setTimeout(() => {
          Object.assign(mock.child, { pid: 6_523 });
          mock.child.emit("spawn");
        }, 10);
      }).pipe(Effect.provide(layer)),
    );

    assert.strictEqual(teardown.mock.calls.length, 1);
    assert.strictEqual(mock.stdout.listenerCount("data"), 0);
  }),
);

it.effect("tears down a spawned process when stopSession wins during deferred ownership", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      delete (mock.child as ChildProcess & { pid?: number }).pid;
      const teardown = vi.fn(async () => mock.close(130));
      const { layer, spawnProcess } = adapterLayer({
        child: mock,
        teardownProcessTree: teardown,
      });
      const threadId = ThreadId.makeUnsafe("command-code-stop-during-ownership");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        const sendFiber = yield* adapter
          .sendTurn({ threadId, input: "must be torn down" })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(spawnProcess.mock.calls.length, 1)),
        );

        yield* adapter.stopSession(threadId);
        Object.assign(mock.child, { pid: 4_242 });
        mock.child.emit("spawn");

        const result = yield* Fiber.join(sendFiber);
        assert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
          assert.ok(result.failure instanceof ProviderAdapterValidationError);
        }
        assert.strictEqual(teardown.mock.calls.length, 1);
        assert.strictEqual(yield* adapter.hasSession(threadId), false);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("cleans up a spawned turn when maintenance owner registration defects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const registrationFailure = new Error("Command Code owner registration failed");
      const maintenanceOwnedResources = {
        register: () => Effect.die(registrationFailure),
        drainProviderResources: () => Effect.void,
      } as unknown as ProviderMaintenanceOwnedResourceCoordinator;
      const teardown = vi.fn(async () => mock.close(1));
      const { layer } = adapterLayer({
        child: mock,
        teardownProcessTree: teardown,
        maintenanceOwnedResources,
      });
      const threadId = ThreadId.makeUnsafe("command-code-registration-defect-turn");

      const result = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        const sendResult = yield* adapter
          .sendTurn({ threadId, input: "must clean up before failing" })
          .pipe(Effect.result);
        const [session] = yield* adapter.listSessions();
        assert.strictEqual(session?.status, "ready");
        assert.strictEqual(session?.activeTurnId, undefined);
        yield* adapter.stopAll();
        return sendResult;
      }).pipe(Effect.provide(layer));

      assert.strictEqual(Result.isFailure(result), true);
      if (Result.isFailure(result)) {
        assert.ok(result.failure instanceof ProviderAdapterProcessError);
        assert.match(result.failure.detail, /owner registration failed/iu);
      }
      assert.strictEqual(teardown.mock.calls.length, 1);
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
        completeSuccessfulTurn(mock);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("does not publish a replacement session across a stopAll boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      let releaseTeardown!: () => void;
      const teardownGate = new Promise<void>((resolve) => {
        releaseTeardown = resolve;
      });
      const teardown = vi.fn(() => teardownGate);
      const { layer, spawnProcess } = adapterLayer({
        child: mock,
        teardownProcessTree: teardown,
      });
      const threadId = ThreadId.makeUnsafe("command-code-replacement-stop-all-boundary");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "keep the original turn active" });
        assert.strictEqual(spawnProcess.mock.calls.length, 1);

        const replacement = yield* adapter
          .startSession(startInput(threadId))
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(teardown.mock.calls.length, 1)),
        );
        const stopping = yield* adapter.stopAll().pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        releaseTeardown();

        const replacementResult = yield* Fiber.join(replacement);
        assert.strictEqual(Result.isFailure(replacementResult), true);
        if (Result.isFailure(replacementResult)) {
          assert.ok(replacementResult.failure instanceof ProviderAdapterValidationError);
          assert.match(replacementResult.failure.issue, /cannot start across a stopAll boundary/iu);
        }
        assert.strictEqual(Result.isSuccess(yield* Fiber.join(stopping)), true);
        assert.strictEqual(yield* adapter.hasSession(threadId), false);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("upgrades legacy Command Code resume cursors with a zero cumulative total", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer, spawnProcess } = adapterLayer({ child: mock });
      const stringThreadId = ThreadId.makeUnsafe("command-code-legacy-string-cursor");
      const objectThreadId = ThreadId.makeUnsafe("command-code-legacy-object-cursor");
      const stringSessionId = "legacy-string-session";
      const objectSessionId = "legacy-object-session";

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const stringSession = yield* adapter.startSession({
          ...startInput(stringThreadId),
          resumeCursor: stringSessionId,
        });
        const objectSession = yield* adapter.startSession({
          ...startInput(objectThreadId),
          resumeCursor: { sessionId: objectSessionId },
        });

        assert.deepStrictEqual(stringSession.resumeCursor, {
          sessionId: stringSessionId,
          totalProcessedTokens: 0,
        });
        assert.deepStrictEqual(objectSession.resumeCursor, {
          sessionId: objectSessionId,
          totalProcessedTokens: 0,
        });
        assert.strictEqual(spawnProcess.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("rejects a supplied invalid resume cursor instead of starting fresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const { layer, spawnProcess } = adapterLayer({ child: mock });
      const threadId = ThreadId.makeUnsafe("command-code-invalid-resume-cursor");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        for (const resumeCursor of [
          { sessionId: "../other-session" },
          { sessionId: COMMAND_CODE_SESSION_ID, totalProcessedTokens: -1 },
          { sessionId: COMMAND_CODE_SESSION_ID, totalProcessedTokens: 1.5 },
          { sessionId: COMMAND_CODE_SESSION_ID, totalProcessedTokens: "16" },
          { sessionId: COMMAND_CODE_SESSION_ID, totalProcessedTokens: Number.MAX_SAFE_INTEGER + 1 },
        ]) {
          const failure = yield* adapter
            .startSession({
              ...startInput(threadId),
              resumeCursor,
            })
            .pipe(Effect.flip);
          assert.ok(failure instanceof ProviderAdapterValidationError);
          assert.match(failure.issue, /resume cursor.*safe session identifier/iu);
        }
        assert.strictEqual(yield* adapter.hasSession(threadId), false);
        assert.strictEqual(spawnProcess.mock.calls.length, 0);
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
        const eventFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(6))).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "bounded task" });
        writeHeadlessRecord(mock, {
          type: "result",
          subtype: "max_turns",
          stopReason: "max_turns",
          usage: {
            inputTokens: 12,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          durationMs: 25,
          finalText: "",
        });
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

it.effect("does not spawn model discovery that was preparing when stopAll began", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      type PreparedProcess = Awaited<ReturnType<PrepareProcess>>;
      let resolvePreparation!: (prepared: PreparedProcess) => void;
      const pendingPreparation = new Promise<PreparedProcess>((resolve) => {
        resolvePreparation = resolve;
      });
      const prepareProcess = vi.fn<PrepareProcess>(() => pendingPreparation);
      const { layer, spawnProcess } = adapterLayer({ child: mock, prepareProcess });

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const listing = yield* adapter.listModels!({
          provider: "commandCode",
          cwd: process.cwd(),
        }).pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(prepareProcess.mock.calls.length, 1)),
        );

        yield* adapter.stopAll();
        resolvePreparation({
          command: "C:\\tools\\synara-windows-job-launcher.exe",
          args: ["--contained", "C:\\tools\\commandcode.cmd", "--list-models"],
          shell: false,
          windowsHide: true,
        });

        const result = yield* Fiber.join(listing);
        assert.strictEqual(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
          assert.ok(result.failure instanceof ProviderAdapterRequestError);
          assert.match(result.failure.detail, /cannot start during stopAll/iu);
        }
        assert.strictEqual(spawnProcess.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
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
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(spawnProcess.mock.calls.length, 1)),
        );
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

it.effect(
  "retains deferred model discovery ownership when registration and exit proof both fail",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockChild();
        delete (mock.child as ChildProcess & { pid?: number }).pid;
        const registrationFailure = new Error("Command Code model owner registration failed");
        const processFailure = new ProviderProcessExitUnprovenError({
          rootPid: 6_511,
          rootExited: true,
          remainingDescendantPids: [6_512],
          captureComplete: true,
        });
        const maintenanceOwnedResources = {
          register: () => Effect.die(registrationFailure),
          drainProviderResources: () => Effect.void,
        } as unknown as ProviderMaintenanceOwnedResourceCoordinator;
        let teardownCalls = 0;
        const teardown = vi.fn(async () => {
          teardownCalls += 1;
          if (teardownCalls === 1) {
            mock.close(1);
            throw processFailure;
          }
        });
        const { layer, spawnProcess } = adapterLayer({
          child: mock,
          teardownProcessTree: teardown,
          maintenanceOwnedResources,
        });

        const result = yield* Effect.gen(function* () {
          const adapter = yield* CommandCodeAdapter;
          const listing = yield* adapter.listModels!({
            provider: "commandCode",
            cwd: process.cwd(),
          }).pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() =>
            vi.waitFor(() => assert.strictEqual(spawnProcess.mock.calls.length, 1)),
          );
          assert.strictEqual(mock.stdout.listenerCount("data"), 0);
          Object.assign(mock.child, { pid: 6_511 });
          mock.child.emit("spawn");

          const listingResult = yield* Fiber.join(listing);
          assert.strictEqual(mock.stdout.listenerCount("data"), 0);
          assert.strictEqual(teardown.mock.calls.length, 1);
          yield* adapter.stopAll();
          return listingResult;
        }).pipe(Effect.provide(layer));

        assert.strictEqual(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
          assert.ok(result.failure instanceof ProviderAdapterRequestError);
          assert.strictEqual(findProviderProcessExitUnprovenError(result.failure), processFailure);
          assert.ok(result.failure.cause instanceof AggregateError);
          assert.match(String(result.failure.cause.errors[0]), /model owner registration failed/iu);
          assert.strictEqual(result.failure.cause.errors[1], processFailure);
        }
        assert.strictEqual(teardown.mock.calls.length, 2);
      }),
    ),
);

it.effect("retains failed model discovery ownership until a later stopAll retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const primaryFailure = new Error("Command Code model discovery stream failed.");
      const processFailure = new ProviderProcessExitUnprovenError({
        rootPid: 6_501,
        rootExited: true,
        remainingDescendantPids: [6_502],
        captureComplete: true,
      });
      let teardownCalls = 0;
      const teardown = vi.fn(async () => {
        teardownCalls += 1;
        if (teardownCalls === 1) {
          mock.close(1);
          throw processFailure;
        }
      });
      const { layer, spawnProcess } = adapterLayer({ child: mock, teardownProcessTree: teardown });

      const result = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const listing = yield* adapter.listModels!({
          provider: "commandCode",
          cwd: process.cwd(),
        }).pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.strictEqual(spawnProcess.mock.calls.length, 1)),
        );
        mock.error(primaryFailure);
        const result = yield* Fiber.join(listing);
        assert.equal(teardown.mock.calls.length, 1);
        yield* adapter.stopAll();
        return result;
      }).pipe(Effect.provide(layer));

      assert.equal(Result.isFailure(result), true);
      if (Result.isFailure(result)) {
        assert.ok(result.failure instanceof ProviderAdapterRequestError);
        assert.equal(findProviderProcessExitUnprovenError(result.failure), processFailure);
        assert.ok(result.failure.cause instanceof AggregateError);
        assert.equal(result.failure.cause.errors[0], primaryFailure);
        assert.equal(result.failure.cause.errors[1], processFailure);
      }
      assert.equal(teardown.mock.calls.length, 2);
    }),
  ),
);

it.effect("attempts a failed active owner only once per stopAll call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const processFailure = new ProviderProcessExitUnprovenError({
        rootPid: 6_505,
        rootExited: true,
        remainingDescendantPids: [6_506],
        captureComplete: true,
      });
      const teardown = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(processFailure)
        .mockResolvedValue(undefined);
      const { layer } = adapterLayer({ child: mock, teardownProcessTree: teardown });
      const threadId = ThreadId.makeUnsafe("command-code-one-stop-attempt");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "keep running" });

        const firstStop = yield* adapter.stopAll().pipe(Effect.result);
        assert.equal(Result.isFailure(firstStop), true);
        if (Result.isFailure(firstStop)) {
          assert.equal(findProviderProcessExitUnprovenError(firstStop.failure), processFailure);
        }
        assert.equal(teardown.mock.calls.length, 1);

        yield* adapter.stopAll();
        assert.equal(teardown.mock.calls.length, 2);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("surfaces every failed session teardown and retries it on the next stopAll", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const teardownFailure = new Error("Command Code process teardown failed");
      const teardown = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(teardownFailure)
        .mockImplementationOnce(async () => mock.close(130));
      const { layer } = adapterLayer({ child: mock, teardownProcessTree: teardown });
      const threadId = ThreadId.makeUnsafe("command-code-generic-stop-failure");

      yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "keep teardown retryable" });

        const firstStop = yield* adapter.stopAll().pipe(Effect.result);
        assert.strictEqual(Result.isFailure(firstStop), true);
        if (Result.isFailure(firstStop)) {
          assert.ok(firstStop.failure instanceof ProviderAdapterRequestError);
          assert.strictEqual(firstStop.failure.cause, teardownFailure);
        }
        assert.strictEqual(teardown.mock.calls.length, 1);

        yield* adapter.stopAll();
        assert.strictEqual(teardown.mock.calls.length, 2);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("retains a failed turn owner so stopAll can retry exact teardown proof", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mock = makeMockChild();
      const processFailure = new ProviderProcessExitUnprovenError({
        rootPid: 6_503,
        rootExited: true,
        remainingDescendantPids: [6_504],
        captureComplete: true,
      });
      let teardownCalls = 0;
      const teardown = vi.fn(async () => {
        teardownCalls += 1;
        if (teardownCalls === 1) {
          mock.close(1);
          throw processFailure;
        }
      });
      const { layer } = adapterLayer({ child: mock, teardownProcessTree: teardown });
      const threadId = ThreadId.makeUnsafe("command-code-retained-proof-owner");

      const events = yield* Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const eventFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(5))).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession(startInput(threadId));
        yield* adapter.sendTurn({ threadId, input: "trigger a process error" });
        mock.error(new Error("Command Code transport failed."));
        const observed = Array.from(yield* Fiber.join(eventFiber));
        yield* adapter.stopAll();
        assert.equal(yield* adapter.hasSession(threadId), false);
        return observed;
      }).pipe(Effect.provide(layer));

      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.equal(completed?.payload.state, "failed");
      assert.match(completed?.payload.errorMessage ?? "", /transport failed/u);
      assert.equal(teardown.mock.calls.length, 2);
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
