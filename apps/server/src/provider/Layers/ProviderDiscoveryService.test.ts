// FILE: ProviderDiscoveryService.test.ts
// Purpose: Verifies the discovery service merges provider-native skills with the
//          unified Synara catalog, filters user-disabled skills, and reports
//          skill discovery as supported for every provider.
// Layer: Server provider tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ProviderComposerCapabilities,
  ProviderKind,
  ProviderListSkillsResult,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveServerPaths,
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderDiscoveryService } from "../Services/ProviderDiscoveryService.ts";
import {
  makeProviderMaintenanceGate,
  ProviderMaintenanceBusyError,
  ProviderMaintenanceLatchedError,
} from "../providerMaintenanceGate.ts";
import { clearSkillsCatalogCacheForTests } from "../skillsCatalog.ts";
import {
  findProviderProcessExitUnprovenError,
  ProviderProcessExitUnprovenError,
} from "../supervisedProcessTeardown.ts";
import { makeProviderDiscoveryServiceLive } from "./ProviderDiscoveryService.ts";

let root: string;
let homeDir: string;
let baseDir: string;
let cwd: string;

async function writeSkill(skillDir: string, name: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
  );
}

const makeConfigLayer = () =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const derived = yield* deriveServerPaths(baseDir, undefined);
      return {
        mode: "web",
        port: 0,
        host: undefined,
        cwd,
        homeDir,
        chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir }),
        studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir }),
        baseDir,
        ...derived,
        staticDir: undefined,
        devUrl: undefined,
        publicUrl: undefined,
        allowInsecureRemote: false,
        allowUnauthenticatedLoopback: true,
        noBrowser: true,
        authToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logProviderEvents: false,
        logWebSocketEvents: false,
      } satisfies ServerConfigShape;
    }),
  );

const makeRegistryLayer = (adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>) =>
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: () => Effect.succeed(adapter as ProviderAdapterShape<ProviderAdapterError>),
    listProviders: () => Effect.succeed([]),
  });

const runListSkills = (input: {
  adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>;
  disabled?: string[];
  provider: ProviderKind;
}) => {
  const baseLayer = Layer.mergeAll(
    makeConfigLayer(),
    ServerSettingsService.layerTest({ skills: { disabled: input.disabled ?? [] } }),
    makeRegistryLayer(input.adapter),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = makeProviderDiscoveryServiceLive({ projectRootBoundary: root }).pipe(
    Layer.provideMerge(baseLayer),
  );
  const program = Effect.gen(function* () {
    const discovery = yield* ProviderDiscoveryService;
    return yield* discovery.listSkills({ provider: input.provider, cwd });
  }).pipe(Effect.provide(testLayer));
  return Effect.runPromise(
    program as unknown as Effect.Effect<ProviderListSkillsResult, never, never>,
  );
};

beforeEach(async () => {
  clearSkillsCatalogCacheForTests();
  root = mkdtempSync(path.join(os.tmpdir(), "discovery-service-"));
  homeDir = path.join(root, "home");
  baseDir = path.join(homeDir, ".synara");
  cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ProviderDiscoveryService.listSkills", () => {
  it("serves the unified catalog for providers without native skill discovery", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const result = await runListSkills({ adapter: {}, provider: "antigravity" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });

  it("prefers provider-native entries and appends catalog-only skills", async () => {
    await writeSkill(path.join(baseDir, "skills", "shared"), "shared");
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const nativeShared = {
      name: "shared",
      path: path.join(homeDir, ".codex", "skills", "shared", "SKILL.md"),
      enabled: true,
      scope: "user",
    };
    const result = await runListSkills({
      adapter: {
        listSkills: () =>
          Effect.succeed({ skills: [nativeShared], source: "codex-app-server", cached: false }),
      },
      provider: "codex",
    });

    const shared = result.skills.find((skill) => skill.name === "shared");
    expect(shared?.path).toBe(nativeShared.path);
    expect(result.skills.some((skill) => skill.name === "portable")).toBe(true);
  });

  it("filters user-disabled skills from merged results", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");
    await writeSkill(path.join(baseDir, "skills", "muted"), "muted");

    const result = await runListSkills({
      adapter: {},
      disabled: ["Muted"],
      provider: "opencode",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });

  it("falls back to the catalog when native discovery fails", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const result = await runListSkills({
      adapter: {
        listSkills: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "skills/list",
              detail: "codex binary missing",
            }),
          ),
      },
      provider: "codex",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });

  it("fails closed instead of serving catalog-only skills when native exit is unproven", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");
    const processFailure = new ProviderProcessExitUnprovenError({
      rootPid: 42_201,
      rootExited: true,
      remainingDescendantPids: [42_202],
      captureComplete: true,
    });
    const adapterFailure = new ProviderAdapterRequestError({
      provider: "codex",
      method: "skills/list",
      detail: "native skill discovery exit could not be proven",
      cause: new AggregateError([new Error("ordinary native failure"), processFailure]),
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const maintenanceGate = yield* makeProviderMaintenanceGate;
          const baseLayer = Layer.mergeAll(
            makeConfigLayer(),
            ServerSettingsService.layerTest(),
            makeRegistryLayer({ listSkills: () => Effect.fail(adapterFailure) }),
          ).pipe(Layer.provideMerge(NodeServices.layer));
          const testLayer = makeProviderDiscoveryServiceLive({
            projectRootBoundary: root,
            maintenanceGate,
          }).pipe(Layer.provideMerge(baseLayer));
          const result = yield* Effect.gen(function* () {
            const discovery = yield* ProviderDiscoveryService;
            return yield* discovery.listSkills({ provider: "codex", cwd });
          }).pipe(Effect.provide(testLayer), Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBe(adapterFailure);
            expect(findProviderProcessExitUnprovenError(result.failure)).toBe(processFailure);
          }

          let maintenanceRuns = 0;
          const maintenance = yield* maintenanceGate
            .withExclusiveMaintenance({
              provider: "codex",
              run: Effect.sync(() => {
                maintenanceRuns += 1;
              }),
            })
            .pipe(Effect.result);
          expect(Result.isFailure(maintenance)).toBe(true);
          if (Result.isFailure(maintenance)) {
            expect(maintenance.failure).toBeInstanceOf(ProviderMaintenanceLatchedError);
          }
          expect(maintenanceRuns).toBe(0);
        }),
      ),
    );
  });
});

describe("ProviderDiscoveryService maintenance ownership", () => {
  it("latches an ungated adapter failure before queued maintenance can run", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const maintenanceGate = yield* makeProviderMaintenanceGate;
          const operationStarted = yield* Deferred.make<void>();
          const releaseOperation = yield* Deferred.make<void>();
          const processFailure = new ProviderProcessExitUnprovenError({
            rootPid: 42_203,
            rootExited: false,
            remainingDescendantPids: null,
            captureComplete: false,
          });
          const adapterFailure = new ProviderAdapterRequestError({
            provider: "codex",
            method: "model/list",
            detail: "native model discovery exit could not be proven",
            cause: new Error("wrapped model discovery failure", {
              cause: new AggregateError([new Error("ordinary model failure"), processFailure]),
            }),
          });
          const listModels = () =>
            Deferred.succeed(operationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseOperation)),
              Effect.andThen(Effect.fail(adapterFailure)),
            );
          const baseLayer = Layer.mergeAll(
            makeConfigLayer(),
            ServerSettingsService.layerTest(),
            makeRegistryLayer({ listModels }),
          ).pipe(Layer.provideMerge(NodeServices.layer));
          const testLayer = makeProviderDiscoveryServiceLive({
            projectRootBoundary: root,
            maintenanceGate,
          }).pipe(Layer.provideMerge(baseLayer));
          const operation = yield* Effect.gen(function* () {
            const discovery = yield* ProviderDiscoveryService;
            return yield* discovery.listModels({ provider: "codex", cwd });
          }).pipe(Effect.provide(testLayer), Effect.result, Effect.forkChild);
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
          expect(maintenanceRefusal).toBeInstanceOf(ProviderMaintenanceBusyError);

          yield* Deferred.succeed(releaseOperation, undefined);
          const operationResult = yield* Fiber.join(operation);
          expect(Result.isFailure(operationResult)).toBe(true);
          if (Result.isFailure(operationResult)) {
            expect(operationResult.failure).toBe(adapterFailure);
            expect(findProviderProcessExitUnprovenError(operationResult.failure)).toBe(
              processFailure,
            );
          }

          const maintenanceResult = yield* Fiber.join(maintenance);
          expect(Result.isFailure(maintenanceResult)).toBe(true);
          if (Result.isFailure(maintenanceResult)) {
            expect(maintenanceResult.failure).toBeInstanceOf(ProviderMaintenanceLatchedError);
          }
          expect(maintenanceRuns).toBe(0);
        }),
      ),
    );
  });
});

describe("ProviderDiscoveryService.getComposerCapabilities", () => {
  it("reports skill discovery as supported even when the adapter declines it", async () => {
    const baseLayer = Layer.mergeAll(
      makeConfigLayer(),
      ServerSettingsService.layerTest(),
      makeRegistryLayer({}),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const testLayer = makeProviderDiscoveryServiceLive({ projectRootBoundary: root }).pipe(
      Layer.provideMerge(baseLayer),
    );

    const program = Effect.gen(function* () {
      const discovery = yield* ProviderDiscoveryService;
      return yield* discovery.getComposerCapabilities({ provider: "grok" });
    }).pipe(Effect.provide(testLayer));
    const capabilities = await Effect.runPromise(
      program as unknown as Effect.Effect<ProviderComposerCapabilities, never, never>,
    );

    expect(capabilities.supportsSkillDiscovery).toBe(true);
    expect(capabilities.supportsSkillMentions).toBe(true);
  });
});
