// FILE: CursorAdapter.test.ts
// Purpose: Verifies Cursor model discovery preparation and private host-policy delivery.
// Layer: Provider adapter tests
// Depends on: CursorAdapter model-list process helper.

import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { prepareWindowsProviderProcess } from "../windowsProviderProcess.ts";
import {
  findProviderProcessExitUnprovenError,
  ProviderProcessExitUnprovenError,
} from "../supervisedProcessTeardown.ts";

import {
  makeCursorModelListChildProcess,
  makeCursorAdapter,
  stopCursorSessionsBestEffort,
  takeCursorSynaraHarnessPolicyTextPart,
} from "./CursorAdapter.ts";

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

describe("CursorAdapter model discovery", () => {
  it("forwards prepared Windows model-list spawn options", () => {
    const env = { SYNARA_TEST: "cursor-model-list" };
    const command = makeCursorModelListChildProcess(
      {
        command: "C:\\tools\\synara-windows-job-launcher.exe",
        args: ["--", "C:\\tools\\cursor-agent.exe", "models"],
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

  it("does not enter the CLI fallback after ACP process exit remains unproven", async () => {
    const processFailure = new ProviderProcessExitUnprovenError({
      rootPid: 6_201,
      rootExited: false,
      remainingDescendantPids: null,
      captureComplete: false,
    });
    const spawnArgs: ReadonlyArray<string>[] = [];
    const spawner = ChildProcessSpawner.make((command) => {
      spawnArgs.push((command as unknown as { readonly args?: ReadonlyArray<string> }).args ?? []);
      return Effect.fail(processFailure as never);
    });

    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeCursorAdapter({ binaryPath: "C:\\tools\\cursor-agent.exe" });
          return yield* adapter.listModels!({
            provider: "cursor",
            binaryPath: "C:\\tools\\cursor-agent.exe",
          }).pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cursor-adapter-test-" })),
        Effect.provide(NodeServices.layer),
      ),
    );

    expect(findProviderProcessExitUnprovenError(failure)).toBe(processFailure);
    expect(spawnArgs.some((args) => args.includes("models"))).toBe(false);
  });

  it("retains a failed CLI model owner until a later stopAll retry", async () => {
    const processFailure = new ProviderProcessExitUnprovenError({
      rootPid: 6_203,
      rootExited: true,
      remainingDescendantPids: [6_204],
      captureComplete: true,
    });
    const teardown = vi
      .fn<() => Promise<{ escalated: boolean; signalErrors: never[] }>>()
      .mockRejectedValueOnce(processFailure)
      .mockResolvedValue({ escalated: false, signalErrors: [] });
    let spawnCount = 0;
    const spawner = ChildProcessSpawner.make(() => {
      spawnCount += 1;
      return spawnCount === 1
        ? Effect.fail(new Error("Cursor ACP discovery unavailable") as never)
        : Effect.succeed(modelListHandle(6_203));
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeCursorAdapter(
            { binaryPath: "C:\\tools\\cursor-agent.exe" },
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
            adapter.listModels!({
              provider: "cursor",
              binaryPath: "C:\\tools\\cursor-agent.exe",
            }),
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
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cursor-adapter-test-" })),
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(spawnCount).toBe(2);
  });
});

describe("Cursor Synara harness policy", () => {
  it("delivers scoped MCP host context exactly once per fresh/load/fork session", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { harnessPolicyDelivered?: boolean } = {};
      const first = takeCursorSynaraHarnessPolicyTextPart(state, true);
      expect(first?.text, lifecycle).toContain(SYNARA_HARNESS_POLICY_MARKER);
      expect(first?.text, lifecycle).toContain("Use the synara_* tools");
      expect(takeCursorSynaraHarnessPolicyTextPart(state, true), lifecycle).toBeNull();
    }
  });

  it("stays truthful without a scoped gateway connection", () => {
    expect(takeCursorSynaraHarnessPolicyTextPart({}, false)?.text).toContain(
      "Synara MCP control is unavailable",
    );
  });
});

describe("Cursor session cleanup", () => {
  it("attempts a snapshot of every session and re-raises the first stop failure", async () => {
    const firstFailure = new Error("first Cursor stop failed");
    const sessions = new Map([
      ["one", { id: "one" }],
      ["two", { id: "two" }],
      ["three", { id: "three" }],
    ]);
    const attempted: string[] = [];

    const exit = await Effect.runPromise(
      Effect.exit(
        stopCursorSessionsBestEffort(sessions.values(), (session) => {
          attempted.push(session.id);
          sessions.delete(session.id);
          if (session.id === "one") return Effect.fail(firstFailure);
          if (session.id === "two") return Effect.die(new Error("later Cursor stop defect"));
          return Effect.void;
        }),
      ),
    );

    expect(attempted).toEqual(["one", "two", "three"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBe(firstFailure);
    }
  });
});
