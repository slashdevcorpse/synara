import type { ProviderKind } from "@synara/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Deferred, Effect, Fiber, Layer, Result, Stream } from "effect";

import { ClaudeAdapter, ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter, CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { CommandCodeAdapter, CommandCodeAdapterShape } from "../Services/CommandCodeAdapter.ts";
import { CursorAdapter, CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { DroidAdapter, DroidAdapterShape } from "../Services/DroidAdapter.ts";
import { GrokAdapter, GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { KiloAdapter, KiloAdapterShape } from "../Services/KiloAdapter.ts";
import { OpenCodeAdapter, OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { PiAdapter, PiAdapterShape } from "../Services/PiAdapter.ts";
import { AntigravityAdapter, AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import {
  makeProviderAdapterRegistryLive,
  ProviderAdapterRegistryLive,
} from "./ProviderAdapterRegistry.ts";
import {
  ProviderAdapterRequestError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  makeProviderMaintenanceGate,
  ProviderMaintenanceBusyError,
  ProviderMaintenanceLatchedError,
} from "../providerMaintenanceGate.ts";
import {
  findProviderProcessExitUnprovenError,
  ProviderProcessExitUnprovenError,
} from "../supervisedProcessTeardown.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const fakeCodexAdapter: CodexAdapterShape = {
  provider: "codex",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCommandCodeAdapter: CommandCodeAdapterShape = {
  provider: "commandCode",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeAdapter: ClaudeAdapterShape = {
  provider: "claudeAgent",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  stopTask: vi.fn(),
  backgroundTask: vi.fn(),
  steerSubagent: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCursorAdapter: CursorAdapterShape = {
  provider: "cursor",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeGrokAdapter: GrokAdapterShape = {
  provider: "grok",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeDroidAdapter: DroidAdapterShape = {
  provider: "droid",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeOpenCodeAdapter: OpenCodeAdapterShape = {
  provider: "opencode",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeKiloAdapter: KiloAdapterShape = {
  provider: "kilo",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakePiAdapter: PiAdapterShape = {
  provider: "pi",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeAntigravityAdapter: AntigravityAdapterShape = {
  provider: "antigravity",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const providerAdapterServices = Layer.mergeAll(
  Layer.succeed(CodexAdapter, fakeCodexAdapter),
  Layer.succeed(CommandCodeAdapter, fakeCommandCodeAdapter),
  Layer.succeed(ClaudeAdapter, fakeClaudeAdapter),
  Layer.succeed(CursorAdapter, fakeCursorAdapter),
  Layer.succeed(AntigravityAdapter, fakeAntigravityAdapter),
  Layer.succeed(GrokAdapter, fakeGrokAdapter),
  Layer.succeed(DroidAdapter, fakeDroidAdapter),
  Layer.succeed(KiloAdapter, fakeKiloAdapter),
  Layer.succeed(OpenCodeAdapter, fakeOpenCodeAdapter),
  Layer.succeed(PiAdapter, fakePiAdapter),
);

const layer = it.layer(
  Layer.mergeAll(
    ProviderAdapterRegistryLive.pipe(Layer.provide(providerAdapterServices)),
    NodeServices.layer,
  ),
);

layer("ProviderAdapterRegistryLive", (it) => {
  it.effect("resolves a registered provider adapter", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const codex = yield* registry.getByProvider("codex");
      const commandCode = yield* registry.getByProvider("commandCode");
      const claude = yield* registry.getByProvider("claudeAgent");
      const cursor = yield* registry.getByProvider("cursor");
      const antigravity = yield* registry.getByProvider("antigravity");
      const grok = yield* registry.getByProvider("grok");
      const droid = yield* registry.getByProvider("droid");
      const kilo = yield* registry.getByProvider("kilo");
      const opencode = yield* registry.getByProvider("opencode");
      const pi = yield* registry.getByProvider("pi");
      assert.equal(codex, fakeCodexAdapter);
      assert.equal(commandCode, fakeCommandCodeAdapter);
      assert.equal(claude, fakeClaudeAdapter);
      assert.equal(cursor, fakeCursorAdapter);
      assert.equal(antigravity, fakeAntigravityAdapter);
      assert.equal(grok, fakeGrokAdapter);
      assert.equal(droid, fakeDroidAdapter);
      assert.equal(kilo, fakeKiloAdapter);
      assert.equal(opencode, fakeOpenCodeAdapter);
      assert.equal(pi, fakePiAdapter);

      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, [
        "codex",
        "commandCode",
        "claudeAgent",
        "cursor",
        "antigravity",
        "grok",
        "droid",
        "kilo",
        "opencode",
        "pi",
      ]);
    }),
  );

  it.effect("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }),
  );
});

it.effect("gates direct adapter work while leaving maintenance controls available", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const maintenanceGate = yield* makeProviderMaintenanceGate;
      const readExternalThread = vi.fn(() =>
        Effect.succeed({ threadId: "external-thread" as never, turns: [] }),
      );
      const transcribeVoice = vi.fn(() => Effect.succeed({ text: "transcribed" }));
      const stopAll = vi.fn(() => Effect.void);
      const adapter = {
        ...fakeCodexAdapter,
        readExternalThread,
        transcribeVoice,
        stopAll,
      } as ProviderAdapterShape<ProviderAdapterError>;
      const registryLayer = makeProviderAdapterRegistryLive({
        adapters: [adapter],
        maintenanceGate,
      }).pipe(Layer.provide(providerAdapterServices));
      const maintenanceStarted = yield* Deferred.make<void>();
      const releaseMaintenance = yield* Deferred.make<void>();
      const maintenance = yield* maintenanceGate
        .withExclusiveMaintenance({
          provider: "codex",
          run: Deferred.succeed(maintenanceStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseMaintenance)),
          ),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(maintenanceStarted);

      const results = yield* Effect.gen(function* () {
        const registry = yield* ProviderAdapterRegistry;
        const gated = yield* registry.getByProvider("codex");
        const imported = yield* gated.readExternalThread!({
          externalThreadId: "native-thread",
        }).pipe(Effect.result);
        const transcribed = yield* gated.transcribeVoice!({
          provider: "codex",
          cwd: "/repo",
          mimeType: "audio/webm",
          sampleRateHz: 48_000,
          durationMs: 100,
          audioBase64: "YQ==",
        }).pipe(Effect.result);
        yield* gated.stopAll();
        return { imported, transcribed };
      }).pipe(Effect.provide(registryLayer));

      assert.equal(Result.isFailure(results.imported), true);
      assert.equal(Result.isFailure(results.transcribed), true);
      if (Result.isFailure(results.imported)) {
        assert.equal(results.imported.failure instanceof ProviderAdapterRequestError, true);
      }
      if (Result.isFailure(results.transcribed)) {
        assert.equal(results.transcribed.failure instanceof ProviderAdapterRequestError, true);
      }
      assert.equal(readExternalThread.mock.calls.length, 0);
      assert.equal(transcribeVoice.mock.calls.length, 0);
      assert.equal(stopAll.mock.calls.length, 1);

      yield* Deferred.succeed(releaseMaintenance, undefined);
      yield* Fiber.join(maintenance);
    }),
  ),
);

it.effect("latches a proxied adapter exit-proof failure before queued maintenance can run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const maintenanceGate = yield* makeProviderMaintenanceGate;
      const operationStarted = yield* Deferred.make<void>();
      const releaseOperation = yield* Deferred.make<void>();
      const processFailure = new ProviderProcessExitUnprovenError({
        rootPid: 42_101,
        rootExited: true,
        remainingDescendantPids: [42_102],
        captureComplete: true,
      });
      const adapterFailure = new ProviderAdapterRequestError({
        provider: "codex",
        method: "model/list",
        detail: "model discovery failed",
        cause: new Error("wrapped model discovery failure", {
          cause: new AggregateError([new Error("ordinary failure"), processFailure]),
        }),
      });
      const listModels = vi.fn(() =>
        Deferred.succeed(operationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseOperation)),
          Effect.andThen(Effect.fail(adapterFailure)),
        ),
      );
      const adapter = {
        ...fakeCodexAdapter,
        listModels,
      } as ProviderAdapterShape<ProviderAdapterError>;
      const registryLayer = makeProviderAdapterRegistryLive({
        adapters: [adapter],
        maintenanceGate,
      }).pipe(Layer.provide(providerAdapterServices));
      const operation = yield* Effect.gen(function* () {
        const registry = yield* ProviderAdapterRegistry;
        const gated = yield* registry.getByProvider("codex");
        return yield* gated.listModels!({ provider: "codex" });
      }).pipe(Effect.provide(registryLayer), Effect.result, Effect.forkChild);
      yield* Deferred.await(operationStarted);

      let maintenanceRuns = 0;
      const maintenance = yield* maintenanceGate
        .withExclusiveMaintenance({
          provider: "codex",
          run: Effect.sync(() => {
            maintenanceRuns += 1;
          }),
        })
        .pipe(Effect.result, Effect.forkChild);
      let maintenanceRefusal: ProviderMaintenanceBusyError | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = yield* maintenanceGate
          .withOperation({ provider: "codex", operation: "test.probe", run: Effect.void })
          .pipe(Effect.result);
        if (Result.isFailure(probe)) {
          maintenanceRefusal = probe.failure;
          break;
        }
        yield* Effect.yieldNow;
      }
      assert.equal(maintenanceRefusal instanceof ProviderMaintenanceBusyError, true);

      yield* Deferred.succeed(releaseOperation, undefined);
      const operationResult = yield* Fiber.join(operation);
      assert.equal(Result.isFailure(operationResult), true);
      if (Result.isFailure(operationResult)) {
        assert.equal(operationResult.failure, adapterFailure);
        assert.equal(findProviderProcessExitUnprovenError(operationResult.failure), processFailure);
      }

      const maintenanceResult = yield* Fiber.join(maintenance);
      assert.equal(Result.isFailure(maintenanceResult), true);
      if (Result.isFailure(maintenanceResult)) {
        assert.equal(maintenanceResult.failure instanceof ProviderMaintenanceLatchedError, true);
      }
      assert.equal(maintenanceRuns, 0);
      assert.equal(listModels.mock.calls.length, 1);

      const futureOperation = yield* maintenanceGate
        .withOperation({ provider: "codex", operation: "future.operation", run: Effect.void })
        .pipe(Effect.result);
      assert.equal(Result.isFailure(futureOperation), true);
      if (Result.isFailure(futureOperation)) {
        assert.equal(futureOperation.failure instanceof ProviderMaintenanceBusyError, true);
        assert.equal(futureOperation.failure.latchedReason, processFailure.message);
      }
    }),
  ),
);
