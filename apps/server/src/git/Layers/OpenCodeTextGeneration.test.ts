// FILE: OpenCodeTextGeneration.test.ts
// Purpose: Locks down OpenCode git text-generation behavior around server reuse,
// plain-text JSON parsing, and upstream structured-output failures.
// Depends on: OpenCodeTextGenerationServiceLive, OpenCodeRuntime, ServerConfig, TestClock.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../../provider/opencodeRuntime.ts";
import {
  makeProviderMaintenanceOwnedResourceCoordinator,
  ProviderMaintenanceOwnedResourceCloseError,
} from "../../provider/providerMaintenanceOwnedResources.ts";
import { KiloTextGeneration, OpenCodeTextGeneration } from "../Services/TextGeneration.ts";
import {
  makeKiloTextGenerationServiceLive,
  makeOpenCodeTextGenerationServiceLive,
} from "./OpenCodeTextGeneration.ts";

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    startCwds: [] as Array<string | undefined>,
    sessionCreateInputs: [] as Array<Record<string, unknown>>,
    promptUrls: [] as string[],
    promptInputs: [] as Array<Record<string, unknown>>,
    authHeaders: [] as Array<string | null>,
    closeCalls: [] as string[],
    stopAttempts: [] as string[],
    stopFailuresRemaining: 0,
    startupFailuresRemaining: 0,
    serverExits: [] as Array<Deferred.Deferred<number>>,
    stopControls: [] as Array<{
      readonly started: Deferred.Deferred<void>;
      readonly allow: Deferred.Deferred<void>;
    }>,
    promptStartedResolvers: [] as Array<() => void>,
    promptWaits: [] as Array<Promise<void>>,
    promptResult: undefined as
      | { data?: { info?: { error?: unknown }; parts?: Array<{ type: string; text?: string }> } }
      | undefined,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.startCwds.length = 0;
    this.state.sessionCreateInputs.length = 0;
    this.state.promptUrls.length = 0;
    this.state.promptInputs.length = 0;
    this.state.authHeaders.length = 0;
    this.state.closeCalls.length = 0;
    this.state.stopAttempts.length = 0;
    this.state.stopFailuresRemaining = 0;
    this.state.startupFailuresRemaining = 0;
    this.state.serverExits.length = 0;
    this.state.stopControls.length = 0;
    this.state.promptStartedResolvers.length = 0;
    this.state.promptWaits.length = 0;
    this.state.promptResult = undefined;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath, cwd, onProcessOwned }) =>
    Effect.gen(function* () {
      const index = runtimeMock.state.startCalls.length + 1;
      const url = `http://127.0.0.1:${4_300 + index}`;
      runtimeMock.state.startCalls.push(binaryPath);
      runtimeMock.state.startCwds.push(cwd);
      const serverExit = yield* Deferred.make<number>();
      runtimeMock.state.serverExits.push(serverExit);
      let stopped = false;
      const stop = Effect.suspend(() => {
        if (stopped) {
          return Effect.void;
        }
        runtimeMock.state.stopAttempts.push(url);
        const stopControl = runtimeMock.state.stopControls.shift();
        const awaitStopControl =
          stopControl === undefined
            ? Effect.void
            : Deferred.succeed(stopControl.started, undefined).pipe(
                Effect.andThen(Deferred.await(stopControl.allow)),
              );
        return awaitStopControl.pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (runtimeMock.state.stopFailuresRemaining > 0) {
                runtimeMock.state.stopFailuresRemaining -= 1;
                return Effect.fail(
                  new OpenCodeRuntimeError({
                    operation: "stopOpenCodeServerProcess",
                    detail: "Process-tree exit remains unproven.",
                    cause: new Error("unproven test process"),
                  }),
                );
              }
              stopped = true;
              runtimeMock.state.closeCalls.push(url);
              return Effect.void;
            }),
          ),
        );
      });

      const ownedProcess = {
        exitCode: Deferred.await(serverExit),
        stop,
      };

      // Mirror the production scoped cleanup and pre-readiness ownership handoff.
      yield* Effect.addFinalizer(() => stop.pipe(Effect.orDie));
      if (onProcessOwned !== undefined) {
        yield* onProcessOwned(ownedProcess);
      }
      if (runtimeMock.state.startupFailuresRemaining > 0) {
        runtimeMock.state.startupFailuresRemaining -= 1;
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: "Test server failed before readiness completed.",
        });
      }

      return {
        url,
        ...ownedProcess,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.succeed({
      url: serverUrl ?? "http://127.0.0.1:4301",
      exitCode: null,
      external: Boolean(serverUrl),
    }),
  runOpenCodeCommand: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "runOpenCodeCommand",
        detail: "OpenCodeRuntimeTestDouble.runOpenCodeCommand should not be used in this test",
        cause: null,
      }),
    ),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async (input: Record<string, unknown>) => {
          runtimeMock.state.sessionCreateInputs.push(input);
          return { data: { id: `${baseUrl}/session` } };
        },
        prompt: async (input: Record<string, unknown>) => {
          runtimeMock.state.promptUrls.push(baseUrl);
          runtimeMock.state.promptInputs.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          runtimeMock.state.promptStartedResolvers.shift()?.();
          const promptWait = runtimeMock.state.promptWaits.shift();
          if (promptWait) {
            await promptWait;
          }

          return (
            runtimeMock.state.promptResult ?? {
              data: {
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      subject: "Improve OpenCode reuse",
                      body: "Reuse one server for the full action.",
                    }),
                  },
                ],
              },
            }
          );
        },
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory should not be used in this test",
        cause: null,
      }),
    ),
  listOpenCodeCliModels: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "listOpenCodeCliModels",
        detail: "OpenCodeRuntimeTestDouble.listOpenCodeCliModels should not be used in this test",
        cause: null,
      }),
    ),
  loadOpenCodeCredentialProviderIDs: () => Effect.succeed([]),
};

const DEFAULT_TEST_MODEL_SELECTION = {
  provider: "opencode" as const,
  model: "openai/gpt-5",
};

const OPENCODE_TEXT_GENERATION_IDLE_TTL_MS = 30_000;

const OpenCodeTextGenerationServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-opencode-text-generation-test-",
});

const OpenCodeTextGenerationExistingServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-opencode-text-generation-existing-server-test-",
});

const maintenanceOwnedResources = Effect.runSync(
  makeProviderMaintenanceOwnedResourceCoordinator,
);
const externalMaintenanceOwnedResources = Effect.runSync(
  makeProviderMaintenanceOwnedResourceCoordinator,
);
const kiloMaintenanceOwnedResources = Effect.runSync(
  makeProviderMaintenanceOwnedResourceCoordinator,
);

const OpenCodeTextGenerationTestLayer = Layer.mergeAll(
  NodeServices.layer,
  makeOpenCodeTextGenerationServiceLive(undefined, { maintenanceOwnedResources }).pipe(
    Layer.provide(OpenCodeTextGenerationServerConfigLayer),
    Layer.provide(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provide(NodeServices.layer),
  ),
);

const OpenCodeTextGenerationExistingServerTestLayer = Layer.mergeAll(
  NodeServices.layer,
  makeOpenCodeTextGenerationServiceLive(() => Effect.succeed("secret-password"), {
    maintenanceOwnedResources: externalMaintenanceOwnedResources,
  }).pipe(
    Layer.provide(OpenCodeTextGenerationExistingServerConfigLayer),
    Layer.provide(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provide(NodeServices.layer),
  ),
);

const KiloTextGenerationTestLayer = Layer.mergeAll(
  NodeServices.layer,
  makeKiloTextGenerationServiceLive(undefined, {
    maintenanceOwnedResources: kiloMaintenanceOwnedResources,
  }).pipe(
    Layer.provide(OpenCodeTextGenerationServerConfigLayer),
    Layer.provide(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provide(NodeServices.layer),
  ),
);

beforeEach(() => {
  runtimeMock.reset();
});

// Advance the shared-server idle timer without sleeping in real time.
const advanceIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_TEXT_GENERATION_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

it.layer(OpenCodeTextGenerationTestLayer)("OpenCodeTextGenerationServiceLive", (it) => {
  it.effect("drains a completed request's warm server for provider maintenance", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-maintenance",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      expect(runtimeMock.state.closeCalls).toEqual([]);

      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      expect(runtimeMock.state.stopAttempts).toEqual(["http://127.0.0.1:4301"]);
    }),
  );

  it.effect("finishes exact resource cleanup before honoring drain interruption", () =>
    Effect.gen(function* () {
      const stopStarted = yield* Deferred.make<void>();
      const allowStop = yield* Deferred.make<void>();
      runtimeMock.state.stopControls.push({ started: stopStarted, allow: allowStop });
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-interrupted-maintenance",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      const draining = yield* maintenanceOwnedResources
        .drainProviderResources({ provider: "opencode" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(stopStarted);
      const interrupting = yield* Fiber.interrupt(draining).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const interruptionWaitedForCleanup = interrupting.pollUnsafe() === undefined;

      yield* Deferred.succeed(allowStop, undefined);
      yield* Fiber.join(interrupting);

      expect(interruptionWaitedForCleanup).toBe(true);
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-interrupted-maintenance",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["opencode", "opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4302",
      ]);
      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
    }),
  );

  it.effect("retains and retries a warm server whose exit proof initially fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.stopFailuresRemaining = 1;
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-maintenance-retry",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      const first = yield* maintenanceOwnedResources
        .drainProviderResources({ provider: "opencode" })
        .pipe(Effect.flip);
      expect(first).toBeInstanceOf(ProviderMaintenanceOwnedResourceCloseError);
      expect(runtimeMock.state.closeCalls).toEqual([]);
      expect(runtimeMock.state.stopAttempts).toEqual(["http://127.0.0.1:4301"]);

      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      expect(runtimeMock.state.stopAttempts).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4301",
      ]);
    }),
  );

  it.effect("retains a failed startup until maintenance retries exact exit proof", () =>
    Effect.gen(function* () {
      runtimeMock.state.startupFailuresRemaining = 1;
      runtimeMock.state.stopFailuresRemaining = 1;
      const textGeneration = yield* OpenCodeTextGeneration;

      const startupError = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-startup-cleanup-retry",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.flip);

      expect(startupError).toBeInstanceOf(Error);
      expect(runtimeMock.state.startCalls).toEqual(["opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual([]);
      expect(runtimeMock.state.stopAttempts).toEqual(["http://127.0.0.1:4301"]);
      expect(runtimeMock.state.closeCalls).toEqual([]);

      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
      expect(runtimeMock.state.stopAttempts).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4301",
      ]);
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-startup-cleanup-retry",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      expect(runtimeMock.state.startCalls).toEqual(["opencode", "opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual(["http://127.0.0.1:4302"]);

      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
    }),
  );

  it.effect("does not reuse a warm server after an idle shutdown proof failure", () =>
    Effect.gen(function* () {
      runtimeMock.state.stopFailuresRemaining = 1;
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-failed-idle-close",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      yield* advanceIdleClock;

      expect(runtimeMock.state.stopAttempts).toEqual(["http://127.0.0.1:4301"]);
      expect(runtimeMock.state.closeCalls).toEqual([]);

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-failed-idle-close",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["opencode", "opencode"]);
      expect(runtimeMock.state.stopAttempts).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4301",
      ]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4302",
      ]);
      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("proves an unexpected warm-server exit before starting its replacement", () =>
    Effect.gen(function* () {
      const stopStarted = yield* Deferred.make<void>();
      const allowStop = yield* Deferred.make<void>();
      runtimeMock.state.stopControls.push({ started: stopStarted, allow: allowStop });
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-unexpected-exit",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      const firstServerExit = runtimeMock.state.serverExits[0];
      if (firstServerExit === undefined) {
        throw new Error("Expected the first managed text-generation server exit control.");
      }
      yield* Deferred.succeed(firstServerExit, 17);
      yield* Deferred.await(stopStarted);

      const replacement = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-unexpected-exit",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(runtimeMock.state.startCalls).toEqual(["opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual(["http://127.0.0.1:4301"]);

      yield* Deferred.succeed(allowStop, undefined);
      yield* Fiber.join(replacement);

      expect(runtimeMock.state.stopAttempts).toEqual(["http://127.0.0.1:4301"]);
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      expect(runtimeMock.state.startCalls).toEqual(["opencode", "opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4302",
      ]);
      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
    }),
  );

  it.effect("retains an unexpectedly exited server until a stop-proof retry succeeds", () =>
    Effect.gen(function* () {
      runtimeMock.state.stopFailuresRemaining = 1;
      const stopStarted = yield* Deferred.make<void>();
      const allowStop = yield* Deferred.make<void>();
      runtimeMock.state.stopControls.push({ started: stopStarted, allow: allowStop });
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-unexpected-exit-retry",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      const firstServerExit = runtimeMock.state.serverExits[0];
      if (firstServerExit === undefined) {
        throw new Error("Expected the first managed text-generation server exit control.");
      }
      yield* Deferred.succeed(firstServerExit, 17);
      yield* Deferred.await(stopStarted);

      const replacement = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-unexpected-exit-retry",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(allowStop, undefined);
      yield* Fiber.join(replacement);

      expect(runtimeMock.state.stopAttempts).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4301",
      ]);
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      expect(runtimeMock.state.startCalls).toEqual(["opencode", "opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4302",
      ]);
      yield* maintenanceOwnedResources.drainProviderResources({ provider: "opencode" });
    }),
  );

  it.effect("reuses a warm server across back-to-back requests and closes it after idling", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4301",
      ]);
      expect(runtimeMock.state.closeCalls).toEqual([]);

      yield* advanceIdleClock;

      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts a new server after the warm server idles out", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      yield* advanceIdleClock;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["opencode", "opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4302",
      ]);
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts managed OpenCode servers in the request cwd", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;
      const cwd = "/repo/with-local-opencode-config";

      yield* textGeneration.generateCommitMessage({
        cwd,
        branch: "feature/opencode-config",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["opencode"]);
      expect(runtimeMock.state.startCwds).toEqual([cwd]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts a separate warm server when the request cwd changes", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: "/repo/alpha",
        branch: "feature/opencode-alpha",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      yield* textGeneration.generateCommitMessage({
        cwd: "/repo/beta",
        branch: "feature/opencode-beta",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["opencode", "opencode"]);
      expect(runtimeMock.state.startCwds).toEqual(["/repo/alpha", "/repo/beta"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not reuse an active managed server for a different request cwd", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;
      let releaseFirstPrompt!: () => void;
      const firstPromptStarted = new Promise<void>((resolve) => {
        runtimeMock.state.promptStartedResolvers.push(resolve);
      });
      runtimeMock.state.promptWaits.push(
        new Promise<void>((resolve) => {
          releaseFirstPrompt = resolve;
        }),
      );

      const firstFiber = yield* textGeneration
        .generateCommitMessage({
          cwd: "/repo/alpha",
          branch: "feature/opencode-alpha",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.forkChild);

      yield* Effect.promise(() => firstPromptStarted);

      yield* textGeneration.generateCommitMessage({
        cwd: "/repo/beta",
        branch: "feature/opencode-beta",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      releaseFirstPrompt();
      yield* Fiber.join(firstFiber);

      expect(runtimeMock.state.startCalls).toEqual(["opencode", "opencode"]);
      expect(runtimeMock.state.startCwds).toEqual(["/repo/alpha", "/repo/beta"]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4302",
      ]);
      expect(runtimeMock.state.closeCalls).toContain("http://127.0.0.1:4302");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("returns a typed empty-output error when OpenCode returns no text parts", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = { data: {} };
      const textGeneration = yield* OpenCodeTextGeneration;

      const error = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("OpenCode returned empty output.");
    }),
  );

  it.effect("parses JSON returned inside plain text output", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          parts: [
            {
              type: "text",
              text: 'Here is the result:\n{"subject":"Tighten OpenCode parsing","body":"Handle JSON text output locally."}',
            },
          ],
        },
      };
      const textGeneration = yield* OpenCodeTextGeneration;

      const result = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(result).toEqual({
        subject: "Tighten OpenCode parsing",
        body: "Handle JSON text output locally.",
      });
    }),
  );

  it.effect("pins the selected OpenCode model on generated sessions", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          parts: [{ type: "text", text: JSON.stringify({ title: "Model check" }) }],
        },
      };
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "which model are you",
        modelSelection: {
          provider: "opencode",
          model: "opencode/big-pickle",
          options: {
            agent: "build",
            variant: "fast",
          },
        },
      });

      expect(runtimeMock.state.sessionCreateInputs[0]).toMatchObject({
        model: {
          providerID: "opencode",
          id: "big-pickle",
          variant: "fast",
        },
        agent: "build",
      });
    }),
  );

  it.effect("projects generic attachments into text-generation prompts", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          parts: [{ type: "text", text: JSON.stringify({ title: "Meeting recap" }) }],
        },
      };
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "summarize this",
        attachments: [
          {
            type: "file" as const,
            id: "thread-title-docx-00000000-0000-4000-8000-000000000001",
            name: "minutes.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 4_096,
          },
        ],
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      const parts = runtimeMock.state.promptInputs[0]?.parts as
        | Array<Record<string, unknown>>
        | undefined;
      expect(parts).toHaveLength(1);
      expect(parts?.[0]).toMatchObject({ type: "text" });
      expect(parts?.[0]?.text).toEqual(expect.stringContaining("<attached_files>"));
      expect(parts?.[0]?.text).toEqual(expect.stringContaining('"minutes.docx"'));
      expect(parts?.[0]?.text).toEqual(
        expect.stringContaining(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      );
    }),
  );

  it.effect("surfaces the upstream structured-output error message", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          info: {
            error: {
              name: "StructuredOutputError",
              data: {
                message: "Model did not produce structured output",
                retries: 2,
              },
            },
          },
        },
      };
      const textGeneration = yield* OpenCodeTextGeneration;

      const error = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("Model did not produce structured output");
    }),
  );
});

it.layer(OpenCodeTextGenerationExistingServerTestLayer)(
  "OpenCodeTextGenerationServiceLive with configured server URL",
  (it) => {
    it.effect("reuses a configured OpenCode server URL without spawning or applying idle TTL", () =>
      Effect.gen(function* () {
        const textGeneration = yield* OpenCodeTextGeneration;

        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          providerOptions: {
            opencode: {
              serverUrl: "http://127.0.0.1:9999",
            },
          },
        });
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          providerOptions: {
            opencode: {
              serverUrl: "http://127.0.0.1:9999",
            },
          },
        });

        expect(runtimeMock.state.startCalls).toEqual([]);
        expect(runtimeMock.state.promptUrls).toEqual([
          "http://127.0.0.1:9999",
          "http://127.0.0.1:9999",
        ]);
        expect(runtimeMock.state.authHeaders).toEqual([
          `Basic ${btoa("opencode:secret-password")}`,
          `Basic ${btoa("opencode:secret-password")}`,
        ]);

        yield* advanceIdleClock;

        yield* externalMaintenanceOwnedResources.drainProviderResources({
          provider: "opencode",
        });

        expect(runtimeMock.state.closeCalls).toEqual([]);
        expect(runtimeMock.state.stopAttempts).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);

it.layer(KiloTextGenerationTestLayer)("KiloTextGenerationServiceLive", (it) => {
  it.effect("registers its warm server with the Kilo maintenance target", () =>
    Effect.gen(function* () {
      const textGeneration = yield* KiloTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/kilo-maintenance",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: {
          provider: "kilo",
          model: "openai/gpt-5",
        },
      });

      yield* kiloMaintenanceOwnedResources.drainProviderResources({ provider: "kilo" });

      expect(runtimeMock.state.startCalls).toEqual(["kilo"]);
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
    }),
  );
});
