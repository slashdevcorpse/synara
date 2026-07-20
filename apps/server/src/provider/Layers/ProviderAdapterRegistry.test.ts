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
import { makeProviderMaintenanceGate } from "../providerMaintenanceGate.ts";
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

const layer = it.layer(
  Layer.mergeAll(
    Layer.provide(
      ProviderAdapterRegistryLive,
      Layer.mergeAll(
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
      ),
    ),
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
      });
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
        const imported = yield* gated
          .readExternalThread!({ externalThreadId: "native-thread" })
          .pipe(Effect.result);
        const transcribed = yield* gated
          .transcribeVoice!({
            provider: "codex",
            cwd: "/repo",
            mimeType: "audio/webm",
            sampleRateHz: 48_000,
            durationMs: 100,
            audioBase64: "YQ==",
          })
          .pipe(Effect.result);
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
