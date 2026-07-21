// FILE: GrokAdapter.test.ts
// Purpose: Covers Grok-specific adapter guards that keep resumed ACP replay out of live turns.
// Layer: Provider adapter tests
// Depends on: GrokAdapter helper exports and shared contract ids.

import { TurnId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";
import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";

import { ServerConfig } from "../../config.ts";
import { prepareWindowsProviderProcess } from "../windowsProviderProcess.ts";
import {
  findProviderProcessExitUnprovenError,
  ProviderProcessExitUnprovenError,
} from "../supervisedProcessTeardown.ts";

import {
  isGrokContextCompactionToolCall,
  isRenderableGrokAssistantDelta,
  makeGrokModelListChildProcess,
  makeGrokAdapter,
  mergeGrokModelDescriptors,
  parseXaiLanguageModelDescriptors,
  scopeGrokRuntimeItemIdForTurn,
  scopeGrokToolCallStateForTurn,
  takeGrokSynaraHarnessPolicyTextPart,
} from "./GrokAdapter.ts";

const encoder = new TextEncoder();

function modelListHandle(pid: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(pid),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode("")),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("Grok Synara harness policy", () => {
  it("delivers private scoped host context once", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    expect(takeGrokSynaraHarnessPolicyTextPart(state, true)?.text).toContain(
      SYNARA_HARNESS_POLICY_MARKER,
    );
    expect(takeGrokSynaraHarnessPolicyTextPart(state, true)).toBeNull();
  });
});

describe("GrokAdapter runtime event scoping", () => {
  it("forwards prepared Windows model-list spawn options", () => {
    const env = { SYNARA_TEST: "grok-model-list" };
    const command = makeGrokModelListChildProcess(
      {
        command: "C:\\tools\\synara-windows-job-launcher.exe",
        args: ["--", "C:\\tools\\grok.exe", "models"],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
      env,
    );

    expect(command.options).toMatchObject({
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });

  it("does not continue to xAI fallback after CLI process exit remains unproven", async () => {
    const processFailure = new ProviderProcessExitUnprovenError({
      rootPid: 6_301,
      rootExited: false,
      remainingDescendantPids: null,
      captureComplete: false,
    });
    let spawnCount = 0;
    const spawner = ChildProcessSpawner.make(() => {
      spawnCount += 1;
      return Effect.fail(
        new Error("Grok CLI teardown failed", {
          cause: new AggregateError([new Error("command failed"), processFailure]),
        }) as never,
      );
    });

    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeGrokAdapter({ binaryPath: "C:\\tools\\grok.exe" });
          return yield* adapter.listModels!({
            provider: "grok",
            binaryPath: "C:\\tools\\grok.exe",
          }).pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "grok-adapter-test-" })),
        Effect.provide(NodeServices.layer),
      ),
    );

    expect(findProviderProcessExitUnprovenError(failure)).toBe(processFailure);
    expect(spawnCount).toBe(1);
  });

  it("retains a failed CLI model owner until a later stopAll retry", async () => {
    const processFailure = new ProviderProcessExitUnprovenError({
      rootPid: 6_303,
      rootExited: true,
      remainingDescendantPids: [6_304],
      captureComplete: true,
    });
    const teardown = vi
      .fn<() => Promise<{ escalated: boolean; signalErrors: never[] }>>()
      .mockRejectedValueOnce(processFailure)
      .mockResolvedValue({ escalated: false, signalErrors: [] });
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(modelListHandle(6_303)));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeGrokAdapter(
            { binaryPath: "C:\\tools\\grok.exe" },
            {
              prepareProcess: (command, args, input) =>
                prepareWindowsProviderProcess(command, args, {
                  ...input,
                  platform: "win32",
                  arch: "x64",
                  controlDirectory: "C:\\Temp",
                  launcherPath: "C:\\synara\\synara-windows-job-launcher.exe",
                  fileExists: () => true,
                }),
              superviseProcess: (_prepared, child) => ({
                rootPid: Number(child.pid),
                waitForInitialCapture: async () => undefined,
                captureNow: async () => undefined,
                proveExit: async () => {
                  throw processFailure;
                },
                teardown,
              }),
            },
          );
          const listing = yield* Effect.exit(
            adapter.listModels!({ provider: "grok", binaryPath: "C:\\tools\\grok.exe" }),
          );
          expect(Exit.isFailure(listing)).toBe(true);
          if (Exit.isFailure(listing)) {
            expect(findProviderProcessExitUnprovenError(Cause.squash(listing.cause))).toBe(
              processFailure,
            );
          }
          expect(teardown).toHaveBeenCalledTimes(1);

          yield* adapter.stopAll();
          expect(teardown).toHaveBeenCalledTimes(2);
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "grok-adapter-test-" })),
        Effect.provide(NodeServices.layer),
      ),
    );
  });

  it("makes reused ACP assistant segment ids unique per DP turn", () => {
    const providerItemId = "assistant:grok-session:segment:5";

    expect(scopeGrokRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-a"), providerItemId)).toBe(
      "grok:turn-a:assistant:grok-session:segment:5",
    );
    expect(scopeGrokRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-b"), providerItemId)).toBe(
      "grok:turn-b:assistant:grok-session:segment:5",
    );
  });

  it("preserves the provider tool id while scoping the runtime item id", () => {
    const scoped = scopeGrokToolCallStateForTurn(TurnId.makeUnsafe("turn-a"), {
      toolCallId: "call-1",
      kind: "execute",
      status: "completed",
      title: "Ran command",
      data: {
        toolCallId: "call-1",
      },
    });

    expect(scoped.toolCallId).toBe("grok:turn-a:call-1");
    expect(scoped.data).toMatchObject({
      toolCallId: "call-1",
      providerToolCallId: "call-1",
    });
  });

  it("detects Grok compaction tool calls for context compaction UI rows", () => {
    expect(
      isGrokContextCompactionToolCall({
        toolCallId: "tool-1",
        kind: "other",
        status: "inProgress",
        title: "Compacting conversation context",
        data: {},
      }),
    ).toBe(true);
    expect(
      isGrokContextCompactionToolCall({
        toolCallId: "tool-2",
        kind: "execute",
        status: "completed",
        title: "Run tests",
        data: {},
      }),
    ).toBe(false);
  });

  it("only treats visible assistant text as renderable Grok content", () => {
    expect(
      isRenderableGrokAssistantDelta({
        streamKind: "assistant_text",
        text: "done",
      }),
    ).toBe(true);
    expect(
      isRenderableGrokAssistantDelta({
        streamKind: "assistant_text",
        text: "   ",
      }),
    ).toBe(false);
    expect(
      isRenderableGrokAssistantDelta({
        streamKind: "reasoning_text",
        text: "thinking",
      }),
    ).toBe(false);
  });

  it("parses xAI language model API responses for picker discovery", () => {
    expect(
      parseXaiLanguageModelDescriptors({
        models: [
          {
            id: "grok-build-0.1",
            object: "model",
            aliases: ["grok-code-fast", "grok-code-fast-1", "grok-build-0.1", "ignored-alias"],
          },
          { id: "grok-code-fast-1-0825", object: "model" },
          { id: "grok-4.3", object: "model" },
          { id: "   " },
          null,
        ],
      }),
    ).toEqual([
      { slug: "grok-build-0.1", name: "Grok Build 0.1" },
      { slug: "grok-code-fast", name: "Grok Code Fast" },
      { slug: "grok-code-fast-1", name: "Grok Code Fast 1" },
      { slug: "grok-code-fast-1-0825", name: "Grok Code Fast 1 0825" },
    ]);
  });

  it("merges Grok CLI and xAI API model lists without duplicates", () => {
    const models = mergeGrokModelDescriptors([
      [
        { slug: "grok-build", name: "Grok 4.3" },
        { slug: "grok-build-0.1", name: "Grok Build 0.1" },
      ],
      [
        { slug: "grok-build-0.1", name: "Grok Build 0.1" },
        { slug: "grok-4.5", name: "Grok 4.5" },
      ],
    ]);

    expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
      { slug: "grok-build", name: "Grok 4.3" },
      { slug: "grok-build-0.1", name: "Grok Build 0.1" },
      { slug: "grok-4.5", name: "Grok 4.5" },
    ]);
    for (const model of models) {
      expect(model.defaultReasoningEffort).toBe("low");
      expect(model.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
        "none",
        "low",
        "medium",
        "high",
      ]);
    }
  });
});
