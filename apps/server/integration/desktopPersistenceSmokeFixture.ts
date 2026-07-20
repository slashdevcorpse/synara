// FILE: desktopPersistenceSmokeFixture.ts
// Purpose: Seed and verify the durable state used by the native two-launch desktop smoke test.
// Layer: Offline integration fixture backed by the production SQLite repositories.
// Depends on: Orchestration engine/projections and provider-session directory; never provider adapters.

import assert from "node:assert/strict";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";

import { deriveServerPaths, ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../src/provider/Services/ProviderSessionDirectory.ts";

const FIXTURE_PREFIX = "desktop persistence smoke fixture";
const FIXTURE_CREATED_AT = "2026-07-20T12:00:00.000Z";

export const DESKTOP_PERSISTENCE_SMOKE_PROJECT_ID = ProjectId.makeUnsafe(
  "desktop-persistence-smoke-project",
);
export const DESKTOP_PERSISTENCE_SMOKE_THREAD_ID = ThreadId.makeUnsafe(
  "desktop-persistence-smoke-thread",
);
export const DESKTOP_PERSISTENCE_SMOKE_PROJECT_TITLE = "Desktop persistence smoke project";
export const DESKTOP_PERSISTENCE_SMOKE_THREAD_TITLE = "Desktop persistence smoke thread";
export const DESKTOP_PERSISTENCE_SMOKE_ADAPTER_KEY = "codex-desktop-persistence-smoke";
export const DESKTOP_PERSISTENCE_SMOKE_LIFECYCLE_GENERATION =
  "desktop-persistence-smoke-generation-v1";
export const DESKTOP_PERSISTENCE_SMOKE_ACTIVE_TURN_ID =
  "desktop-persistence-smoke-interrupted-turn";
export const DESKTOP_PERSISTENCE_SMOKE_MODEL_SELECTION = {
  provider: "codex" as const,
  model: DEFAULT_MODEL_BY_PROVIDER.codex,
};
export const DESKTOP_PERSISTENCE_SMOKE_RESUME_CURSOR = {
  threadId: "provider-native-desktop-persistence-smoke",
  opaque: { revision: 7 },
};
export const DESKTOP_PERSISTENCE_SMOKE_RETAINED_METADATA = {
  source: "desktop-persistence-smoke",
  revision: 7,
  survivesCrashRecovery: true,
};
export const DESKTOP_PERSISTENCE_SMOKE_ARM_MARKER = {
  marker: "desktop-persistence-smoke-launch-a-force-kill",
  targetLaunch: "A",
  version: 1,
};
export const DESKTOP_PERSISTENCE_SMOKE_ARM_EVENT = "provider.desktopPersistenceSmokeArmed";

export interface DesktopPersistenceSmokeFixturePaths {
  readonly synaraHome: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
}

type FixtureMode = "seed" | "arm" | "assert";

interface FixtureCliOptions {
  readonly mode: FixtureMode;
  readonly synaraHome: string;
}

class FixtureInputError extends Error {
  readonly name = "FixtureInputError";
}

function failInput(message: string): never {
  throw new FixtureInputError(`${FIXTURE_PREFIX}: ${message}`);
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await FS.access(path);
    return true;
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

function processState(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ESRCH") {
      return "dead";
    }
    return "unknown";
  }
}

function assertContainedPath(parent: string, candidate: string, label: string): void {
  const relative = Path.relative(parent, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${Path.sep}`) && relative !== ".." && !Path.isAbsolute(relative))
  ) {
    return;
  }
  failInput(`${label} must remain inside the explicit SYNARA_HOME.`);
}

async function resolveFixturePaths(
  synaraHomeInput: string,
): Promise<DesktopPersistenceSmokeFixturePaths> {
  if (synaraHomeInput.trim().length === 0) {
    failInput("--home-dir must be a non-empty absolute path.");
  }
  if (!Path.isAbsolute(synaraHomeInput)) {
    failInput(`--home-dir must be absolute; received '${synaraHomeInput}'.`);
  }

  const resolvedHome = Path.resolve(synaraHomeInput);
  if (resolvedHome === Path.parse(resolvedHome).root) {
    failInput("--home-dir cannot be a filesystem root.");
  }

  let homeStat;
  try {
    homeStat = await FS.stat(resolvedHome);
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") {
      failInput(
        `--home-dir must already exist so ownership remains with the caller; missing '${resolvedHome}'.`,
      );
    }
    throw cause;
  }
  if (!homeStat.isDirectory()) {
    failInput(`--home-dir must identify a directory; received '${resolvedHome}'.`);
  }

  const synaraHome = await FS.realpath(resolvedHome);
  const derivedPaths = await Effect.runPromise(
    deriveServerPaths(synaraHome, undefined).pipe(Effect.provide(NodeServices.layer)),
  );
  const workspaceDir = Path.join(synaraHome, "desktop-persistence-smoke-workspace");

  assertContainedPath(synaraHome, workspaceDir, "Fixture workspace");
  assertContainedPath(synaraHome, derivedPaths.dbPath, "Desktop state database");

  return {
    synaraHome,
    workspaceDir,
    dbPath: derivedPaths.dbPath,
  };
}

function makeProviderDirectoryLayer() {
  return ProviderSessionDirectoryLive.pipe(
    Layer.provideMerge(ProviderSessionRuntimeRepositoryLive),
  );
}

function makeSeedLayer(paths: DesktopPersistenceSmokeFixturePaths) {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  );

  return Layer.mergeAll(orchestrationLayer, makeProviderDirectoryLayer()).pipe(
    Layer.provide(makeSqlitePersistenceLive(paths.dbPath)),
    Layer.provideMerge(ServerConfig.layerTest(paths.workspaceDir, paths.synaraHome)),
    Layer.provideMerge(NodeServices.layer),
  );
}

function makeAssertLayer(paths: DesktopPersistenceSmokeFixturePaths) {
  return Layer.mergeAll(
    OrchestrationProjectionSnapshotQueryLive,
    makeProviderDirectoryLayer(),
  ).pipe(
    Layer.provide(makeSqlitePersistenceLive(paths.dbPath)),
    Layer.provideMerge(ServerConfig.layerTest(paths.workspaceDir, paths.synaraHome)),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function makeConcurrentArmLayer(paths: DesktopPersistenceSmokeFixturePaths) {
  if (process.versions.bun === undefined) {
    failInput("arm must run under Bun so it uses the production Bun SQLite client.");
  }
  const BunSqliteClient = await import("@effect/sql-sqlite-bun/SqliteClient");

  // Launch A intentionally owns the process lifecycle lock. Arm bypasses only
  // that application-level lock and still uses the production Bun SQLite client
  // plus typed projection/provider repositories. The existing database is
  // already migrated and in WAL mode; this client must neither create it nor run
  // migrations or journal-mode setup while the desktop connection is live.
  const concurrentClientLayer = BunSqliteClient.layer({
    filename: paths.dbPath,
    create: false,
    readwrite: true,
    disableWAL: true,
  });

  return Layer.mergeAll(
    OrchestrationProjectionSnapshotQueryLive,
    makeProviderDirectoryLayer(),
  ).pipe(Layer.provide(concurrentClientLayer));
}

function runtimePayloadFor(paths: DesktopPersistenceSmokeFixturePaths) {
  return {
    cwd: paths.workspaceDir,
    model: DESKTOP_PERSISTENCE_SMOKE_MODEL_SELECTION.model,
    modelSelection: DESKTOP_PERSISTENCE_SMOKE_MODEL_SELECTION,
    providerOptions: {
      codex: {
        homePath: Path.join(paths.synaraHome, "offline-codex-home"),
        binaryPath: Path.join(paths.synaraHome, "offline-codex-never-invoked"),
      },
    },
    activeTurnId: DESKTOP_PERSISTENCE_SMOKE_ACTIVE_TURN_ID,
    lastError: null,
    retainedMetadata: DESKTOP_PERSISTENCE_SMOKE_RETAINED_METADATA,
  };
}

function armedRuntimePayloadFor(paths: DesktopPersistenceSmokeFixturePaths, armedAt: string) {
  return {
    ...runtimePayloadFor(paths),
    desktopPersistenceSmokeArm: DESKTOP_PERSISTENCE_SMOKE_ARM_MARKER,
    lastRuntimeEvent: DESKTOP_PERSISTENCE_SMOKE_ARM_EVENT,
    lastRuntimeEventAt: armedAt,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} missing`);
  return value as Record<string, unknown>;
}

function assertSeededProjection(
  snapshot: OrchestrationReadModel,
  paths: DesktopPersistenceSmokeFixturePaths,
): void {
  const project = snapshot.projects.find(
    (candidate) => candidate.id === DESKTOP_PERSISTENCE_SMOKE_PROJECT_ID,
  );
  assert(project, "seeded project is missing from the authoritative projection");
  assert.equal(project.title, DESKTOP_PERSISTENCE_SMOKE_PROJECT_TITLE);
  assert.equal(project.workspaceRoot, paths.workspaceDir);
  assert.deepEqual(project.defaultModelSelection, DESKTOP_PERSISTENCE_SMOKE_MODEL_SELECTION);

  const thread = snapshot.threads.find(
    (candidate) => candidate.id === DESKTOP_PERSISTENCE_SMOKE_THREAD_ID,
  );
  assert(thread, "seeded thread is missing from the authoritative projection");
  assert.equal(thread.projectId, DESKTOP_PERSISTENCE_SMOKE_PROJECT_ID);
  assert.equal(thread.title, DESKTOP_PERSISTENCE_SMOKE_THREAD_TITLE);
  assert.deepEqual(thread.modelSelection, DESKTOP_PERSISTENCE_SMOKE_MODEL_SELECTION);
  assert.equal(thread.runtimeMode, "approval-required");
}

function assertFixtureBindingIdentity(
  binding: ProviderRuntimeBinding,
  paths: DesktopPersistenceSmokeFixturePaths,
): Record<string, unknown> {
  assert.equal(binding.threadId, DESKTOP_PERSISTENCE_SMOKE_THREAD_ID);
  assert.equal(binding.provider, "codex");
  assert.equal(binding.adapterKey, DESKTOP_PERSISTENCE_SMOKE_ADAPTER_KEY);
  assert.equal(binding.runtimeMode, "approval-required");
  assert.equal(binding.lifecycleGeneration, DESKTOP_PERSISTENCE_SMOKE_LIFECYCLE_GENERATION);
  assert.deepEqual(binding.resumeCursor, DESKTOP_PERSISTENCE_SMOKE_RESUME_CURSOR);

  const expectedPayload = runtimePayloadFor(paths);
  const payload = asRecord(binding.runtimePayload, "provider runtime payload");
  assert.equal(payload.cwd, expectedPayload.cwd);
  assert.equal(payload.model, expectedPayload.model);
  assert.deepEqual(payload.modelSelection, expectedPayload.modelSelection);
  assert.deepEqual(payload.providerOptions, expectedPayload.providerOptions);
  assert.deepEqual(payload.retainedMetadata, expectedPayload.retainedMetadata);
  assert.equal(payload.lastError, expectedPayload.lastError);
  return payload;
}

function assertCrashRecoveredBinding(
  binding: ProviderRuntimeBinding,
  paths: DesktopPersistenceSmokeFixturePaths,
  options: { readonly mustContainArmMarker: boolean },
): void {
  const payload = assertFixtureBindingIdentity(binding, paths);
  assert.equal(binding.status, "stopped");
  assert.equal(payload.activeTurnId, null);
  assert.equal(payload.lastRuntimeEvent, "provider.startupCrashRecovery");
  assert.equal(typeof payload.lastRuntimeEventAt, "string");
  assert(
    !Number.isNaN(Date.parse(payload.lastRuntimeEventAt as string)),
    "provider startup crash-recovery timestamp must be an ISO date-time",
  );
  if (options.mustContainArmMarker) {
    assert.deepEqual(payload.desktopPersistenceSmokeArm, DESKTOP_PERSISTENCE_SMOKE_ARM_MARKER);
  } else {
    assert.equal(
      payload.desktopPersistenceSmokeArm,
      undefined,
      "binding was already armed before launch A",
    );
  }
}

function assertArmedBinding(
  binding: ProviderRuntimeBinding,
  paths: DesktopPersistenceSmokeFixturePaths,
  armedAt: string,
): void {
  const payload = assertFixtureBindingIdentity(binding, paths);
  assert.equal(binding.status, "running");
  assert.equal(payload.activeTurnId, DESKTOP_PERSISTENCE_SMOKE_ACTIVE_TURN_ID);
  assert.deepEqual(payload.desktopPersistenceSmokeArm, DESKTOP_PERSISTENCE_SMOKE_ARM_MARKER);
  assert.equal(payload.lastRuntimeEvent, DESKTOP_PERSISTENCE_SMOKE_ARM_EVENT);
  assert.equal(payload.lastRuntimeEventAt, armedAt);
}

function isSqliteBusyCause(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") {
    return /SQLITE_(?:BUSY|LOCKED)|database (?:is )?locked/iu.test(value);
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);

  const record = value as Record<string, unknown>;
  if (
    isSqliteBusyCause(record.code, seen) ||
    isSqliteBusyCause(record.message, seen) ||
    isSqliteBusyCause(record.cause, seen)
  ) {
    return true;
  }
  return false;
}

interface ExternalLifecycleLockOwner {
  readonly pid: number;
  readonly token: string;
}

async function requireLiveExternalLifecycleLockOwner(
  paths: DesktopPersistenceSmokeFixturePaths,
  expectedOwner?: ExternalLifecycleLockOwner,
): Promise<ExternalLifecycleLockOwner> {
  const lockPath = `${paths.dbPath}.lifecycle-lock`;
  const ownerPath = Path.join(lockPath, "owner.json");
  let lockStat;
  let ownerStat;
  let ownerText: string;
  try {
    [lockStat, ownerStat, ownerText] = await Promise.all([
      FS.lstat(lockPath),
      FS.lstat(ownerPath),
      FS.readFile(ownerPath, "utf8"),
    ]);
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") {
      failInput(
        "arm requires launch A to be running and holding the desktop database lifecycle lock.",
      );
    }
    throw cause;
  }
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    failInput("desktop database lifecycle lock is not a real directory.");
  }
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
    failInput("desktop database lifecycle lock owner is not a real file.");
  }

  let rawOwner: unknown;
  try {
    rawOwner = JSON.parse(ownerText);
  } catch {
    failInput("desktop database lifecycle lock owner metadata is invalid JSON.");
  }
  const owner = asRecord(rawOwner, "desktop database lifecycle lock owner");
  if (
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner.token) ||
    typeof owner.createdAt !== "string" ||
    Number.isNaN(Date.parse(owner.createdAt))
  ) {
    failInput("desktop database lifecycle lock owner metadata is invalid.");
  }

  const resolvedOwner = { pid: owner.pid as number, token: owner.token };
  if (resolvedOwner.pid === process.pid) {
    failInput("arm requires an external launch-A database owner, not the arm process itself.");
  }
  const state = processState(resolvedOwner.pid);
  if (state !== "live") {
    failInput(`launch-A database lifecycle-lock owner is ${state}.`);
  }
  if (
    expectedOwner !== undefined &&
    (expectedOwner.pid !== resolvedOwner.pid || expectedOwner.token !== resolvedOwner.token)
  ) {
    failInput("launch-A database lifecycle-lock ownership changed while arm was running.");
  }
  return resolvedOwner;
}

async function retryArmWrite(write: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastCause: unknown;
  do {
    try {
      await write();
      return;
    } catch (cause) {
      lastCause = cause;
      if (!isSqliteBusyCause(cause)) throw cause;
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  } while (true);

  throw new Error("arm could not persist the launch-A force-kill marker within 5 seconds.", {
    cause: lastCause,
  });
}

export async function seedDesktopPersistenceSmokeFixture(
  synaraHomeInput: string,
): Promise<DesktopPersistenceSmokeFixturePaths> {
  const paths = await resolveFixturePaths(synaraHomeInput);
  if (await pathExists(paths.dbPath)) {
    failInput(
      `seed requires a fresh caller-owned home; desktop state already exists at '${paths.dbPath}'.`,
    );
  }

  await FS.mkdir(paths.workspaceDir, { recursive: true });
  const runtime = ManagedRuntime.make(makeSeedLayer(paths));
  try {
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const directory = await runtime.runPromise(Effect.service(ProviderSessionDirectory));

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("desktop-persistence-smoke-create-project"),
        projectId: DESKTOP_PERSISTENCE_SMOKE_PROJECT_ID,
        title: DESKTOP_PERSISTENCE_SMOKE_PROJECT_TITLE,
        workspaceRoot: paths.workspaceDir,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: DESKTOP_PERSISTENCE_SMOKE_MODEL_SELECTION,
        createdAt: FIXTURE_CREATED_AT,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("desktop-persistence-smoke-create-thread"),
        threadId: DESKTOP_PERSISTENCE_SMOKE_THREAD_ID,
        projectId: DESKTOP_PERSISTENCE_SMOKE_PROJECT_ID,
        title: DESKTOP_PERSISTENCE_SMOKE_THREAD_TITLE,
        modelSelection: DESKTOP_PERSISTENCE_SMOKE_MODEL_SELECTION,
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: FIXTURE_CREATED_AT,
      }),
    );
    await runtime.runPromise(
      directory.upsert({
        threadId: DESKTOP_PERSISTENCE_SMOKE_THREAD_ID,
        provider: "codex",
        adapterKey: DESKTOP_PERSISTENCE_SMOKE_ADAPTER_KEY,
        runtimeMode: "approval-required",
        status: "running",
        lifecycleGeneration: DESKTOP_PERSISTENCE_SMOKE_LIFECYCLE_GENERATION,
        resumeCursor: DESKTOP_PERSISTENCE_SMOKE_RESUME_CURSOR,
        runtimePayload: runtimePayloadFor(paths),
      }),
    );

    const snapshot = await runtime.runPromise(snapshotQuery.getSnapshot());
    assertSeededProjection(snapshot, paths);

    const bindingOption = await runtime.runPromise(
      directory.getBinding(DESKTOP_PERSISTENCE_SMOKE_THREAD_ID),
    );
    assert(Option.isSome(bindingOption), "seeded provider binding is missing");
    const payload = assertFixtureBindingIdentity(bindingOption.value, paths);
    assert.equal(bindingOption.value.status, "running");
    assert.equal(payload.activeTurnId, DESKTOP_PERSISTENCE_SMOKE_ACTIVE_TURN_ID);
    assert.equal(payload.desktopPersistenceSmokeArm, undefined);
  } finally {
    await runtime.dispose();
  }

  return paths;
}

export async function armDesktopPersistenceSmokeFixture(
  synaraHomeInput: string,
): Promise<DesktopPersistenceSmokeFixturePaths> {
  const paths = await resolveFixturePaths(synaraHomeInput);
  if (!(await pathExists(paths.dbPath))) {
    failInput(`arm requires an existing desktop state database at '${paths.dbPath}'.`);
  }

  const launchAOwner = await requireLiveExternalLifecycleLockOwner(paths);
  const runtime = ManagedRuntime.make(await makeConcurrentArmLayer(paths));
  try {
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const directory = await runtime.runPromise(Effect.service(ProviderSessionDirectory));

    const snapshot = await runtime.runPromise(snapshotQuery.getSnapshot());
    assertSeededProjection(snapshot, paths);

    const bindingBeforeOption = await runtime.runPromise(
      directory.getBinding(DESKTOP_PERSISTENCE_SMOKE_THREAD_ID),
    );
    assert(Option.isSome(bindingBeforeOption), "seeded provider binding is missing");
    assertCrashRecoveredBinding(bindingBeforeOption.value, paths, {
      mustContainArmMarker: false,
    });

    const armedAt = new Date().toISOString();
    await retryArmWrite(() =>
      runtime.runPromise(
        directory.upsert({
          threadId: DESKTOP_PERSISTENCE_SMOKE_THREAD_ID,
          provider: "codex",
          adapterKey: DESKTOP_PERSISTENCE_SMOKE_ADAPTER_KEY,
          runtimeMode: "approval-required",
          status: "running",
          lifecycleGeneration: DESKTOP_PERSISTENCE_SMOKE_LIFECYCLE_GENERATION,
          resumeCursor: DESKTOP_PERSISTENCE_SMOKE_RESUME_CURSOR,
          runtimePayload: armedRuntimePayloadFor(paths, armedAt),
        }),
      ),
    );

    const bindingAfterOption = await runtime.runPromise(
      directory.getBinding(DESKTOP_PERSISTENCE_SMOKE_THREAD_ID),
    );
    assert(Option.isSome(bindingAfterOption), "armed provider binding is missing");
    assertArmedBinding(bindingAfterOption.value, paths, armedAt);
    await requireLiveExternalLifecycleLockOwner(paths, launchAOwner);
  } finally {
    await runtime.dispose();
  }

  return paths;
}

export async function assertDesktopPersistenceSmokeFixture(
  synaraHomeInput: string,
): Promise<DesktopPersistenceSmokeFixturePaths> {
  const paths = await resolveFixturePaths(synaraHomeInput);
  if (!(await pathExists(paths.dbPath))) {
    failInput(`desktop state database is missing at '${paths.dbPath}'.`);
  }

  const runtime = ManagedRuntime.make(makeAssertLayer(paths));
  try {
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const directory = await runtime.runPromise(Effect.service(ProviderSessionDirectory));

    const snapshot = await runtime.runPromise(snapshotQuery.getSnapshot());
    assertSeededProjection(snapshot, paths);

    const bindingOption = await runtime.runPromise(
      directory.getBinding(DESKTOP_PERSISTENCE_SMOKE_THREAD_ID),
    );
    assert(Option.isSome(bindingOption), "seeded provider binding is missing");
    assertCrashRecoveredBinding(bindingOption.value, paths, {
      mustContainArmMarker: true,
    });
  } finally {
    await runtime.dispose();
  }

  return paths;
}

function parseCliOptions(argv: ReadonlyArray<string>): FixtureCliOptions {
  if (argv.length !== 3 || (argv[0] !== "seed" && argv[0] !== "arm" && argv[0] !== "assert")) {
    failInput("usage: <seed|arm|assert> --home-dir <absolute-SYNARA_HOME>.");
  }
  if (argv[1] !== "--home-dir") {
    failInput("the explicit home must be provided as --home-dir <absolute-SYNARA_HOME>.");
  }
  return { mode: argv[0], synaraHome: argv[2]! };
}

function formatCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ?? `${cause.name}: ${cause.message}`;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

async function runCli(argv: ReadonlyArray<string>): Promise<void> {
  const options = parseCliOptions(argv);
  const paths = await (options.mode === "seed"
    ? seedDesktopPersistenceSmokeFixture(options.synaraHome)
    : options.mode === "arm"
      ? armDesktopPersistenceSmokeFixture(options.synaraHome)
      : assertDesktopPersistenceSmokeFixture(options.synaraHome));
  process.stdout.write(
    `${FIXTURE_PREFIX}: ${options.mode} passed home=${paths.synaraHome} db=${paths.dbPath}\n`,
  );
}

if (import.meta.main) {
  try {
    await runCli(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${FIXTURE_PREFIX}: failed\n${formatCause(cause)}\n`);
    process.exitCode = 1;
  }
}
