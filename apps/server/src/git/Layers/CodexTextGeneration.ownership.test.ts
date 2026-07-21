import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { installCodexTextGenerationProcessOwnership } from "./CodexTextGeneration.ts";

describe("Codex text-generation process ownership", () => {
  it("keeps Effect's provisional finalizer when supervisor construction cannot recover", async () => {
    const calls: string[] = [];
    const requestedFailure = new Error("requested supervisor construction failed");
    const child = {
      pid: Number.NaN,
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
    };

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              calls.push("provisional");
            }),
          );
          return yield* installCodexTextGenerationProcessOwnership(
            { command: "codex", args: ["exec"], shell: false },
            child,
            "codex",
            "generateBranchName",
            {
              supervisorOptions: { platform: "linux" },
              superviseProcess: () => {
                calls.push("requested");
                throw requestedFailure;
              },
            },
          );
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(calls).toEqual(["requested", "provisional"]);
  });

  it("runs the exact finalizer before the provisional owner on interruption", async () => {
    const calls: string[] = [];
    const supervisor = {
      rootPid: 8202,
      waitForInitialCapture: vi.fn(async () => undefined),
      captureNow: vi.fn(async () => undefined),
      proveExit: vi.fn(async () => ({ escalated: false, signalErrors: [] })),
      teardown: vi.fn(async () => {
        calls.push("exact");
        return { escalated: false, signalErrors: [] };
      }),
    };

    await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              calls.push("provisional");
            }),
          );
          yield* installCodexTextGenerationProcessOwnership(
            { command: "codex", args: ["exec"], shell: false },
            {
              pid: 8202,
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
            },
            "codex",
            "generateBranchName",
            { superviseProcess: () => supervisor },
          );
          return yield* Effect.interrupt;
        }),
      ),
    );

    expect(supervisor.teardown).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["exact", "provisional"]);
  });
});
