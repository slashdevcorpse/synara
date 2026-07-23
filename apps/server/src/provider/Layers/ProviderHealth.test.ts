import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProviderStatus } from "@synara/contracts";
import { DEFAULT_SERVER_SETTINGS, ServerProviderUpdateError } from "@synara/contracts";
import { buildWindowsBatchCommandArgs, resolveWindowsComSpec } from "@synara/shared/windowsProcess";
import { describe, it, assert } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterAll, beforeAll, vi } from "vitest";

import { SYNARA_CODEX_HOME_OVERLAY_DIR } from "../../codexHomePaths";
import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import type { ProcessTreeKiller } from "../../terminal/processTreeKiller.ts";
import { ProviderHealth } from "../Services/ProviderHealth";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService";
import {
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache";
import {
  makeProviderMaintenanceGate,
  type ProviderMaintenanceGate,
} from "../providerMaintenanceGate.ts";
import {
  makeProviderMaintenanceOwnedResourceCoordinator,
  type ProviderMaintenanceOwnedResourceCoordinator,
} from "../providerMaintenanceOwnedResources.ts";
import {
  ProviderProcessExitUnprovenError,
  superviseEffectProcessTree,
  teardownProviderProcessTree,
} from "../supervisedProcessTeardown.ts";
import {
  hasCustomModelProvider,
  checkAntigravityProviderStatus as productionCheckAntigravityProviderStatus,
  checkPiProviderStatus as productionCheckPiProviderStatus,
  makeDisabledProviderStatus,
  makeCheckClaudeProviderStatus as makeProductionCheckClaudeProviderStatus,
  makeCheckCommandCodeProviderStatus as makeProductionCheckCommandCodeProviderStatus,
  makeCheckCodexProviderStatus as makeProductionCheckCodexProviderStatus,
  makeCheckCursorProviderStatus as makeProductionCheckCursorProviderStatus,
  makeCheckGrokProviderStatus as makeProductionCheckGrokProviderStatus,
  makeCheckKiloProviderStatus as makeProductionCheckKiloProviderStatus,
  makeCheckOpenCodeProviderStatus as makeProductionCheckOpenCodeProviderStatus,
  makeProviderHealthLive as makeProductionProviderHealthLive,
  parseAuthStatusFromOutput,
  parseClaudeAuthStatusFromOutput,
  parseCommandCodeStatusJson,
  PACKAGE_MANAGED_PROVIDER_UPDATES,
  packageManagedProviderUpdateDefinitions,
  probeClaudeSubscription,
  providerStatusesEqual,
  type ProviderHealthProcessOptions,
  projectProviderStatusesForSettings,
  readCodexConfigModelProvider,
  stabilizeProviderStatusesAgainstTransientTimeouts,
} from "./ProviderHealth";
import { resolvePackageManagedProviderMaintenance } from "../providerMaintenance";
import {
  isWindowsJobPreparedCommand,
  prepareResolvedWindowsProviderProcess,
  prepareWindowsProviderProcess,
  WINDOWS_JOB_LAUNCHER_ENV,
  WINDOWS_JOB_LAUNCHER_EXECUTABLE,
  WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
} from "../windowsProviderProcess.ts";
import {
  supervisePreparedEffectProcess,
  supervisePreparedNodeProcess,
} from "../windowsJobProcessSupervisor.ts";

const TEST_PROVIDER_PROCESS_OPTIONS = {
  platform: "linux",
  superviseProcess: (_prepared, child) => ({
    rootPid: Number(child.pid),
    waitForInitialCapture: () => Promise.resolve(),
    captureNow: () => Promise.resolve(),
    proveExit: () => Promise.resolve({ escalated: false, signalErrors: [] }),
    teardown: () => Promise.resolve({ escalated: false, signalErrors: [] }),
  }),
} as const satisfies ProviderHealthProcessOptions;

const TEST_REAL_PROVIDER_PROCESS_OPTIONS = {
  platform: process.platform,
  superviseProcess: (_prepared, child, options = {}) =>
    options.processTreeKiller
      ? superviseEffectProcessTree(child, {
          platform: options.platform ?? process.platform,
          processTreeKiller: options.processTreeKiller,
          ...(options.teardownProcessTree
            ? { teardownProcessTree: options.teardownProcessTree }
            : {}),
          ...(options.ownedProcessGroupId === undefined
            ? {}
            : { ownedProcessGroupId: options.ownedProcessGroupId }),
        })
      : TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(_prepared, child),
} as const satisfies ProviderHealthProcessOptions;

const TEST_PROVIDER_LAYER_PROCESS_OPTIONS = {
  platform: process.platform,
  superviseProcess: TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess,
} as const satisfies ProviderHealthProcessOptions;

function makeContainedWindowsProviderPreparationForTest(result: {
  readonly stdout?: string | null;
  readonly status?: number | null;
  readonly error?: Error | undefined;
}): typeof prepareWindowsProviderProcess {
  return (command, args, options = {}) =>
    prepareWindowsProviderProcess(command, args, {
      ...options,
      platform: "win32",
      launcherPath: `C:\\Synara\\${WINDOWS_JOB_LAUNCHER_EXECUTABLE}`,
      fileExists: () => true,
      spawnSync: () => result,
    });
}

const prepareContainedWindowsProviderForTest = makeContainedWindowsProviderPreparationForTest({
  stdout: "",
  status: 1,
});

const prepareContainedResolvedWindowsProviderForTest: typeof prepareResolvedWindowsProviderProcess =
  (command, args, options = {}) =>
    prepareResolvedWindowsProviderProcess(command, args, {
      ...options,
      platform: "win32",
      launcherPath: `C:\\Synara\\${WINDOWS_JOB_LAUNCHER_EXECUTABLE}`,
      fileExists: () => true,
    });

const makeCheckCodexProviderStatus = (binaryPath?: string, homePath?: string) =>
  makeProductionCheckCodexProviderStatus(binaryPath, homePath, TEST_PROVIDER_PROCESS_OPTIONS);
const checkCodexProviderStatus = makeCheckCodexProviderStatus();

const makeCheckCommandCodeProviderStatus = (
  binaryPath?: string,
  options?: Parameters<typeof makeProductionCheckCommandCodeProviderStatus>[1],
) =>
  makeProductionCheckCommandCodeProviderStatus(binaryPath, {
    ...TEST_PROVIDER_PROCESS_OPTIONS,
    ...options,
  });

const makeCheckClaudeProviderStatus = (
  resolveSubscriptionType?: Parameters<typeof makeProductionCheckClaudeProviderStatus>[0],
  binaryPath?: string,
  homeDir?: string,
  options?: Parameters<typeof makeProductionCheckClaudeProviderStatus>[3],
) =>
  makeProductionCheckClaudeProviderStatus(resolveSubscriptionType, binaryPath, homeDir, {
    ...TEST_PROVIDER_PROCESS_OPTIONS,
    ...options,
  });
const checkClaudeProviderStatus = makeCheckClaudeProviderStatus();

const makeCheckGrokProviderStatus = (binaryPath?: string) =>
  makeProductionCheckGrokProviderStatus(binaryPath, TEST_PROVIDER_PROCESS_OPTIONS);
const checkGrokProviderStatus = makeCheckGrokProviderStatus();

const makeCheckOpenCodeProviderStatus = (binaryPath?: string) =>
  makeProductionCheckOpenCodeProviderStatus(binaryPath, TEST_PROVIDER_PROCESS_OPTIONS);
const checkOpenCodeProviderStatus = makeCheckOpenCodeProviderStatus();

const makeCheckKiloProviderStatus = (binaryPath?: string) =>
  makeProductionCheckKiloProviderStatus(binaryPath, TEST_PROVIDER_PROCESS_OPTIONS);

const makeCheckCursorProviderStatus = (binaryPath?: string) =>
  makeProductionCheckCursorProviderStatus(binaryPath, TEST_PROVIDER_PROCESS_OPTIONS);
const checkCursorProviderStatus = makeCheckCursorProviderStatus();

const checkPiProviderStatus = (agentDir?: string, binaryPath?: string) =>
  productionCheckPiProviderStatus(agentDir, binaryPath, TEST_PROVIDER_PROCESS_OPTIONS);

const checkAntigravityProviderStatus = (binaryPath?: string) =>
  productionCheckAntigravityProviderStatus(binaryPath, TEST_PROVIDER_PROCESS_OPTIONS);

const makeProviderHealthLive = (options?: Parameters<typeof makeProductionProviderHealthLive>[0]) =>
  makeProductionProviderHealthLive({
    ...TEST_PROVIDER_LAYER_PROCESS_OPTIONS,
    ...options,
  });
const ProviderHealthLive = makeProviderHealthLive();

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();
const originalProviderHealthTestPath = process.env.PATH;
let providerHealthTestCommandDirectory: string | undefined;

function configuredTestBinary(name: string): string {
  return process.platform === "win32" ? `C:\\custom\\bin\\${name}` : `/custom/bin/${name}`;
}

beforeAll(() => {
  if (process.platform !== "win32") return;
  providerHealthTestCommandDirectory = mkdtempSync(
    NodePath.join(NodeOs.tmpdir(), "synara-provider-health-commands-"),
  );
  for (const command of [
    "codex",
    "claude",
    "grok",
    "opencode",
    "kilo",
    "pi",
    "agy",
    "droid",
    "cursor-agent",
    "commandcode",
    "missing-commandcode",
  ]) {
    writeFileSync(NodePath.join(providerHealthTestCommandDirectory, `${command}.exe`), "");
  }
  process.env.PATH = [providerHealthTestCommandDirectory, originalProviderHealthTestPath]
    .filter((entry): entry is string => Boolean(entry))
    .join(";");
});

afterAll(() => {
  if (originalProviderHealthTestPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalProviderHealthTestPath;
  }
  if (providerHealthTestCommandDirectory) {
    rmSync(providerHealthTestCommandDirectory, { recursive: true, force: true });
  }
});

function makeFetchMock(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, {
    preconnect: (_url: string | URL) => undefined,
  });
}

function latestPackageChannel(installedVersion: string, metadataPath: string) {
  return {
    kind: "package-dist-tag" as const,
    tag: "latest" as const,
    installedVersion,
    metadataPath,
  };
}

const writeLatestKiloPackageFixture = Effect.fn("writeLatestKiloPackageFixture")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly binaryPath: string;
  readonly version: string;
}) {
  const packageDirectory = NodePath.dirname(NodePath.dirname(input.binaryPath));
  yield* input.fileSystem.makeDirectory(NodePath.dirname(input.binaryPath), { recursive: true });
  yield* input.fileSystem.writeFileString(input.binaryPath, "#!/usr/bin/env node\n");
  yield* input.fileSystem.writeFileString(
    NodePath.join(packageDirectory, "package.json"),
    `${JSON.stringify({
      name: "@kilocode/cli",
      version: input.version,
      bin: { kilo: "bin/kilo" },
      _requested: {
        type: "tag",
        rawSpec: "latest",
        raw: "@kilocode/cli@latest",
      },
    })}\n`,
  );
});

interface ProviderCommandFixture {
  readonly commandDirectory: string;
}

interface TestProcessCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
  readonly synaraExternallySupervised?: boolean;
}

function fixtureExecutablePath(fixture: ProviderCommandFixture, command: string): string {
  return NodePath.join(
    fixture.commandDirectory,
    process.platform === "win32" ? `${command}.cmd` : command,
  );
}

function fixtureWindowsNpmNodePath(fixture: ProviderCommandFixture): string {
  return NodePath.join(fixture.commandDirectory, "node.exe");
}

function fixtureWindowsNpmCliPath(fixture: ProviderCommandFixture): string {
  return NodePath.join(
    fixture.commandDirectory,
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
}

function preparedProviderCommandMatches(input: {
  readonly fixture: ProviderCommandFixture;
  readonly executable: string;
  readonly expectedArgs: ReadonlyArray<string>;
  readonly command: string;
  readonly actualArgs: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly options?: TestProcessCommandOptions | undefined;
}): boolean {
  const argsMatch = JSON.stringify(input.actualArgs) === JSON.stringify(input.expectedArgs);
  if (
    process.platform === "win32" &&
    NodePath.win32.basename(input.executable).toLowerCase() === "npm.cmd"
  ) {
    return (
      input.command.toLowerCase() === fixtureWindowsNpmNodePath(input.fixture).toLowerCase() &&
      JSON.stringify(input.actualArgs) ===
        JSON.stringify([fixtureWindowsNpmCliPath(input.fixture), ...input.expectedArgs])
    );
  }
  const directCommandMatches =
    process.platform === "win32"
      ? input.command.toLowerCase() === input.executable.toLowerCase()
      : input.command === input.executable;
  if (directCommandMatches && argsMatch) return true;
  if (process.platform !== "win32") return false;

  const env = input.env ?? process.env;
  const expectedExecutable = NodePath.win32.isAbsolute(input.executable)
    ? input.executable
    : fixtureExecutablePath(input.fixture, input.executable);
  return (
    input.command.toLowerCase() === resolveWindowsComSpec(env).toLowerCase() &&
    input.options?.windowsVerbatimArguments === true &&
    JSON.stringify(input.actualArgs) ===
      JSON.stringify(buildWindowsBatchCommandArgs(expectedExecutable, input.expectedArgs))
  );
}

function assertPreparedProviderCommand(
  input: Parameters<typeof preparedProviderCommandMatches>[0],
): void {
  assert.ok(
    preparedProviderCommandMatches(input),
    `Unexpected prepared ${input.executable} command: ${input.command} ${input.actualArgs.join(" ")}`,
  );
}

function withIsolatedProviderCommands<A, E, R>(
  commands: ReadonlyArray<string>,
  use: (fixture: ProviderCommandFixture) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "provider-health-commands-",
      });
      const commandDirectory = path.join(tempDirectory, "bin");
      yield* fileSystem.makeDirectory(commandDirectory, { recursive: true });
      const canonicalCommandDirectory = realpathSync.native(commandDirectory);

      for (const command of commands) {
        const executablePath = fixtureExecutablePath(
          { commandDirectory: canonicalCommandDirectory },
          command,
        );
        yield* fileSystem.writeFileString(
          executablePath,
          process.platform === "win32" ? "@echo off\r\n@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
        );
        if (process.platform !== "win32") {
          yield* fileSystem.chmod(executablePath, 0o755);
        }
        if (process.platform === "win32" && command === "npm") {
          const fixture = { commandDirectory: canonicalCommandDirectory };
          const npmCliPath = fixtureWindowsNpmCliPath(fixture);
          yield* fileSystem.makeDirectory(NodePath.dirname(npmCliPath), { recursive: true });
          yield* fileSystem.writeFileString(
            fixtureWindowsNpmNodePath(fixture),
            "node fixture\n",
          );
          yield* fileSystem.writeFileString(npmCliPath, "console.log('npm fixture');\n");
        }
      }

      const previousPath = process.env.PATH;
      const previousPathExt = process.env.PATHEXT;
      yield* Effect.sync(() => {
        process.env.PATH = canonicalCommandDirectory;
        if (process.platform === "win32") {
          process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
        }
      });
      return {
        fixture: { commandDirectory: canonicalCommandDirectory },
        previousPath,
        previousPathExt,
      };
    }),
    ({ fixture }) => use(fixture),
    ({ previousPath, previousPathExt }) =>
      Effect.sync(() => {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        if (previousPathExt === undefined) {
          delete process.env.PATHEXT;
        } else {
          process.env.PATHEXT = previousPathExt;
        }
      }),
  );
}

function withLatestNpmVersion<A, E, R>(
  version: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = makeFetchMock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ version }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      return previousFetch;
    }),
    () => use,
    (previousFetch) =>
      Effect.sync(() => {
        globalThis.fetch = previousFetch;
      }),
  );
}

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return Object.assign(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.make(encoder.encode(result.stdout)),
      stderr: Stream.make(encoder.encode(result.stderr)),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
    { synaraTerminateExact: () => false },
  );
}

function syntheticProcessTreeKiller(rootPid: number): ProcessTreeKiller {
  const root = {
    pid: rootPid,
    command: "provider-updater-fixture",
    identity: `${rootPid}:provider-updater-fixture`,
  };
  return {
    capture: () => ({ root, descendants: [], captureComplete: true }),
    inspect: () => ({ verified: true, survivors: [] }),
    signal: () => {},
  };
}

type PreparedMockCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options?: TestProcessCommandOptions;
};

function unwrapContainedProviderCommand(cmd: PreparedMockCommand): PreparedMockCommand {
  const launcherPrefix = ["--protocol", WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION, "--argument-mode"];
  const isContained =
    process.platform === "win32" &&
    NodePath.basename(cmd.command).toLowerCase() === WINDOWS_JOB_LAUNCHER_EXECUTABLE &&
    launcherPrefix.every((value, index) => cmd.args[index] === value) &&
    cmd.args[4] === "--control-file" &&
    typeof cmd.args[5] === "string" &&
    cmd.args[6] === "--" &&
    typeof cmd.args[7] === "string";
  if (!isContained) return cmd;

  const target = cmd.args[7]!;
  const normalizedTestDirectory = providerHealthTestCommandDirectory?.toLowerCase();
  const targetDirectory = NodePath.dirname(target).toLowerCase();
  const isGlobalMockCommand = targetDirectory.includes("synara-provider-health-commands-");
  const unwrappedTarget =
    isGlobalMockCommand || (normalizedTestDirectory && targetDirectory === normalizedTestDirectory)
      ? NodePath.basename(target, NodePath.extname(target))
      : target.startsWith("\\") && !target.startsWith("\\\\")
        ? target.replaceAll("\\", "/")
        : target;
  const options =
    cmd.args[3] === "verbatim" ? { ...cmd.options, windowsVerbatimArguments: true } : cmd.options;
  return {
    command: unwrappedTarget,
    args: cmd.args.slice(8),
    ...(options ? { options } : {}),
  };
}

function mockSpawnerLayer(
  handler: (
    args: ReadonlyArray<string>,
    command: string,
    env: NodeJS.ProcessEnv | undefined,
    options: TestProcessCommandOptions | undefined,
  ) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options?: TestProcessCommandOptions;
      };
      const unwrapped = unwrapContainedProviderCommand(cmd);
      return Effect.succeed(
        mockHandle(
          handler(unwrapped.args, unwrapped.command, unwrapped.options?.env, unwrapped.options),
        ),
      );
    }),
  );
}

function effectSpawnerLayer(
  handler: (
    args: ReadonlyArray<string>,
    command: string,
    env: NodeJS.ProcessEnv | undefined,
    options: TestProcessCommandOptions | undefined,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle>,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options?: TestProcessCommandOptions;
      };
      const unwrapped = unwrapContainedProviderCommand(cmd);
      return handler(unwrapped.args, unwrapped.command, unwrapped.options?.env, unwrapped.options);
    }),
  );
}

function provisionalOwnerSpawnerLayer(
  handler: (
    args: ReadonlyArray<string>,
    command: string,
    env: NodeJS.ProcessEnv | undefined,
    options: TestProcessCommandOptions | undefined,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle>,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options?: TestProcessCommandOptions;
      };
      const unwrapped = unwrapContainedProviderCommand(cmd);
      return Effect.acquireRelease(
        handler(unwrapped.args, unwrapped.command, unwrapped.options?.env, unwrapped.options),
        (handle) =>
          unwrapped.options?.synaraExternallySupervised === true
            ? Effect.void
            : handle.kill().pipe(Effect.orDie),
      );
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function hangingSpawnerLayer(input: {
  readonly onKill: () => void;
  readonly onSpawn?: Effect.Effect<void>;
  readonly shouldHang: (
    args: ReadonlyArray<string>,
    command: string,
    env: NodeJS.ProcessEnv | undefined,
    options: TestProcessCommandOptions | undefined,
  ) => boolean;
}) {
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(2),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.sync(input.onKill),
    stdin: Sink.drain,
    stdout: Stream.never,
    stderr: Stream.never,
    all: Stream.never,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.never,
  });
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options?: TestProcessCommandOptions;
      };
      const unwrapped = unwrapContainedProviderCommand(cmd);
      return input.shouldHang(
        unwrapped.args,
        unwrapped.command,
        unwrapped.options?.env,
        unwrapped.options,
      )
        ? (input.onSpawn ?? Effect.void).pipe(Effect.as(handle))
        : Effect.succeed(mockHandle({ stdout: "", stderr: "", code: 0 }));
    }),
  );
}

const allProvidersDisabledSettings = {
  providers: {
    codex: { enabled: false },
    commandCode: { enabled: false },
    claudeAgent: { enabled: false },
    cursor: { enabled: false },
    antigravity: { enabled: false },
    grok: { enabled: false },
    droid: { enabled: false },
    kilo: { enabled: false },
    opencode: { enabled: false },
    pi: { enabled: false },
  },
} as const;

const allProvidersDisabledServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
    commandCode: { ...DEFAULT_SERVER_SETTINGS.providers.commandCode, enabled: false },
    claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, enabled: false },
    cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, enabled: false },
    antigravity: { ...DEFAULT_SERVER_SETTINGS.providers.antigravity, enabled: false },
    grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: false },
    droid: { ...DEFAULT_SERVER_SETTINGS.providers.droid, enabled: false },
    kilo: { ...DEFAULT_SERVER_SETTINGS.providers.kilo, enabled: false },
    opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: false },
    pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, enabled: false },
  },
} satisfies typeof DEFAULT_SERVER_SETTINGS;

function withKiloUpdateFixture<A, E, R>(
  installedVersion: string,
  use: (input: {
    readonly fixture: ProviderCommandFixture;
    readonly baseDir: string;
    readonly npmPrefix: string;
    readonly kiloBinaryPath: string;
    readonly cachePath: string;
    readonly settings: typeof DEFAULT_SERVER_SETTINGS;
  }) => Effect.Effect<A, E, R>,
) {
  return withIsolatedProviderCommands(["npm"], (fixture) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "provider-update-exact-status-",
      });
      const npmPrefix = NodePath.join(baseDir, "nvm");
      const kiloBinaryPath = NodePath.join(
        npmPrefix,
        "lib",
        "node_modules",
        "@kilocode",
        "cli",
        "bin",
        "kilo",
      );
      yield* writeLatestKiloPackageFixture({
        fileSystem,
        binaryPath: kiloBinaryPath,
        version: installedVersion,
      });
      const cachePath = resolveProviderStatusCachePath({
        stateDir: NodePath.join(baseDir, "userdata"),
        provider: "kilo",
      });
      yield* writeProviderStatusCache({
        filePath: cachePath,
        provider: {
          provider: "kilo",
          status: "ready",
          available: true,
          authStatus: "unknown",
          checkedAt: "2026-07-20T12:00:00.000Z",
          message: "Kilo CLI is installed. Configure provider credentials inside Kilo as needed.",
          version: installedVersion,
        },
      });
      const settings = {
        ...allProvidersDisabledServerSettings,
        providers: {
          ...allProvidersDisabledServerSettings.providers,
          kilo: {
            ...DEFAULT_SERVER_SETTINGS.providers.kilo,
            enabled: true,
            binaryPath: kiloBinaryPath,
          },
        },
      } satisfies typeof DEFAULT_SERVER_SETTINGS;
      return yield* use({ fixture, baseDir, npmPrefix, kiloBinaryPath, cachePath, settings });
    }),
  );
}

const providerServiceWithoutRuntimesLayer = Layer.succeed(ProviderService, {
  listSessions: () => Effect.succeed([]),
  stopRuntimeSession: () => Effect.void,
  hasLiveRuntimeTasks: () => Effect.succeed(false),
} as unknown as ProviderServiceShape);

const disabledProviderHealthLayer = ProviderHealthLive.pipe(
  Layer.provideMerge(providerServiceWithoutRuntimesLayer),
  Layer.provideMerge(ServerSettingsService.layerTest(allProvidersDisabledSettings)),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "provider-health-disabled-" }),
  ),
);

const cachedReadyCodexStatus = {
  provider: "codex" as const,
  status: "ready" as const,
  available: true,
  authStatus: "authenticated" as const,
  checkedAt: "2026-06-16T12:00:00.000Z",
  message: "Codex CLI is installed and authenticated.",
} satisfies ServerProviderStatus;

/**
 * Create a temporary CODEX_HOME scoped to the current Effect test.
 * Cleanup is registered in the test scope rather than via Vitest hooks.
 */
function withTempCodexHome(configContent?: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-test-codex-" });
    const runtimeDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "synara-test-runtime-",
    });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        // Override the runtime and source homes so ambient state cannot skew
        // the resolved CODEX_HOME during this test.
        const overrides: Record<string, string> = {
          CODEX_HOME: tmpDir,
          SYNARA_HOME: runtimeDir,
        };
        const restore: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(overrides)) {
          restore[key] = process.env[key];
          process.env[key] = value;
        }
        const originalPortkeyApiKey = process.env.PORTKEY_API_KEY;
        process.env.PORTKEY_API_KEY ??= "test-portkey-key";
        return { restore, originalPortkeyApiKey };
      }),
      ({ restore, originalPortkeyApiKey }) =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(restore)) {
            if (value !== undefined) {
              process.env[key] = value;
            } else {
              delete process.env[key];
            }
          }
          if (originalPortkeyApiKey !== undefined) {
            process.env.PORTKEY_API_KEY = originalPortkeyApiKey;
          } else {
            delete process.env.PORTKEY_API_KEY;
          }
        }),
    );

    if (configContent !== undefined) {
      yield* fileSystem.writeFileString(path.join(tmpDir, "config.toml"), configContent);
    }

    return { tmpDir, runtimeDir } as const;
  });
}

it.layer(NodeServices.layer)("ProviderHealth", (it) => {
  describe("Command Code health", () => {
    it("parses the documented automation status JSON defensively", () => {
      assert.deepStrictEqual(
        parseCommandCodeStatusJson(
          JSON.stringify({
            authenticated: true,
            version: "0.52.1",
            user: "operator@example.com",
            provider: "openai",
            model: "gpt-5.6-sol",
          }),
        ),
        {
          authenticated: true,
          version: "0.52.1",
          user: "operator@example.com",
          provider: "openai",
          model: "gpt-5.6-sol",
        },
      );
      assert.strictEqual(parseCommandCodeStatusJson("not-json"), undefined);
      assert.strictEqual(parseCommandCodeStatusJson('{"authenticated":"yes"}'), undefined);
    });

    it.effect("reports installed version and authenticated JSON status", () => {
      const calls: ReadonlyArray<string>[] = [];
      return makeCheckCommandCodeProviderStatus("commandcode.exe").pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            calls.push(args);
            if (args.includes("--version")) {
              return { stdout: "command-code 0.52.1", stderr: "", code: 0 };
            }
            return {
              stdout: JSON.stringify({
                authenticated: true,
                version: "0.52.1",
                user: "operator@example.com",
                provider: "openai",
                model: "gpt-5.6-sol",
              }),
              stderr: "",
              code: 0,
            };
          }),
        ),
        Effect.tap((status) =>
          Effect.sync(() => {
            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.authStatus, "authenticated");
            assert.strictEqual(status.version, "0.52.1");
            assert.strictEqual(status.authLabel, "operator@example.com");
            assert.ok(
              calls.some((args) => JSON.stringify(args) === JSON.stringify(["status", "--json"])),
            );
          }),
        ),
      );
    });

    it.effect("reports unauthenticated and malformed status responses as warnings", () =>
      Effect.gen(function* () {
        let statusResponse = JSON.stringify({ authenticated: false, error: "Login required" });
        const spawner = mockSpawnerLayer((args) =>
          args.includes("--version")
            ? { stdout: "0.52.1", stderr: "", code: 0 }
            : { stdout: statusResponse, stderr: "", code: 1 },
        );
        const unauthenticated = yield* makeCheckCommandCodeProviderStatus("commandcode.exe").pipe(
          Effect.provide(spawner),
        );
        assert.strictEqual(unauthenticated.status, "warning");
        assert.strictEqual(unauthenticated.authStatus, "unauthenticated");
        assert.strictEqual(unauthenticated.message, "Login required");

        statusResponse = "not-json";
        const malformed = yield* makeCheckCommandCodeProviderStatus("commandcode.exe").pipe(
          Effect.provide(spawner),
        );
        assert.strictEqual(malformed.authStatus, "unknown");
        assert.match(malformed.message ?? "", /malformed/u);
      }),
    );

    it.effect("reports a missing launcher as unavailable", () =>
      makeCheckCommandCodeProviderStatus("missing-commandcode.exe").pipe(
        Effect.provide(failingSpawnerLayer("not found")),
        Effect.tap((status) =>
          Effect.sync(() => {
            assert.strictEqual(status.status, "error");
            assert.strictEqual(status.available, false);
            assert.strictEqual(status.authStatus, "unknown");
          }),
        ),
      ),
    );

    it.effect("times out a hung JSON authentication probe", () =>
      Effect.gen(function* () {
        let killed = false;
        const checking = yield* makeCheckCommandCodeProviderStatus("commandcode.exe", {
          teardownProcessTree: () => {
            killed = true;
            return Promise.resolve({ escalated: false, signalErrors: [] });
          },
          superviseProcess: (_prepared, child, options = {}) =>
            superviseEffectProcessTree(child, {
              platform: "linux",
              ownedProcessGroupId: Number(child.pid),
              ...(options.teardownProcessTree
                ? { teardownProcessTree: options.teardownProcessTree }
                : {}),
            }),
        }).pipe(
          Effect.provide(
            hangingSpawnerLayer({
              onKill: () => {
                killed = true;
              },
              shouldHang: (args) => args.includes("status"),
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(15_000);
        const status = yield* Fiber.join(checking);
        assert.strictEqual(status.authStatus, "unknown");
        assert.match(status.message ?? "", /timed out/u);
        assert.strictEqual(killed, true);
      }),
    );
  });

  describe("health process ownership", () => {
    it.effect("does not install supervision when Effect spawn acquisition fails", () => {
      let supervisorInstallations = 0;
      return makeProductionCheckKiloProviderStatus("ignored", {
        platform: "linux",
        prepareProcess: () => ({
          command: "Z:\\synara-missing-provider-health-command.exe",
          args: [],
          shell: false,
        }),
        superviseProcess: (prepared, child) => {
          supervisorInstallations += 1;
          return TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child);
        },
      }).pipe(
        Effect.tap((status) =>
          Effect.sync(() => {
            assert.strictEqual(status.status, "error");
            assert.strictEqual(status.available, false);
            assert.strictEqual(supervisorInstallations, 0);
          }),
        ),
      );
    });

    it.effect("keeps Effect cleanup when the default health supervisor constructor fails", () =>
      Effect.gen(function* () {
        const processExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const lifecycle: string[] = [];
        let running = true;
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(84),
          exitCode: Deferred.await(processExit),
          isRunning: Effect.sync(() => running),
          kill: () =>
            Effect.sync(() => {
              lifecycle.push("provisional");
              running = false;
              Deferred.doneUnsafe(processExit, Effect.succeed(ChildProcessSpawner.ExitCode(0)));
            }),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
        });

        const status = yield* makeProductionCheckKiloProviderStatus("kilo", {
          platform: "win32",
          prepareProcess: (command, args) => ({ command, args: [...args], shell: false }),
        }).pipe(
          Effect.provide(
            provisionalOwnerSpawnerLayer((_args, _command, _env, options) => {
              lifecycle.push(
                options?.synaraExternallySupervised === true ? "external" : "provisional-owned",
              );
              return Effect.succeed(handle);
            }),
          ),
        );

        assert.strictEqual(status.status, "error");
        assert.match(status.message ?? "", /without Job-prepared command provenance/u);
        assert.deepStrictEqual(lifecycle, ["provisional-owned", "provisional"]);
      }),
    );

    it.effect("runs exact health cleanup before provisional cleanup when registration fails", () =>
      Effect.gen(function* () {
        const processExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const registrationFailure = new Error("health owner registration failed");
        const lifecycle: string[] = [];
        let running = true;
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(85),
          exitCode: Deferred.await(processExit),
          isRunning: Effect.sync(() => running),
          kill: () =>
            Effect.sync(() => {
              lifecycle.push("provisional");
              running = false;
              Deferred.doneUnsafe(processExit, Effect.succeed(ChildProcessSpawner.ExitCode(0)));
            }),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
        });
        const maintenanceOwnedResources = {
          register: () =>
            Effect.sync(() => lifecycle.push("register")).pipe(
              Effect.andThen(Effect.fail(registrationFailure)),
            ),
          drainProviderResources: () => Effect.void,
        } as unknown as ProviderMaintenanceOwnedResourceCoordinator;

        const status = yield* makeProductionCheckKiloProviderStatus("kilo", {
          platform: "linux",
          maintenanceOwnedResources,
          superviseProcess: (_prepared, child) => ({
            rootPid: Number(child.pid),
            waitForInitialCapture: async () => undefined,
            captureNow: async () => undefined,
            proveExit: async () => ({ escalated: false, signalErrors: [] }),
            teardown: async () => {
              lifecycle.push("exact");
              return { escalated: false, signalErrors: [] };
            },
          }),
        }).pipe(Effect.provide(provisionalOwnerSpawnerLayer(() => Effect.succeed(handle))));

        assert.strictEqual(status.status, "error");
        assert.match(status.message ?? "", /health owner registration failed/u);
        assert.deepStrictEqual(lifecycle, ["register", "exact", "provisional"]);
      }),
    );

    it.effect("passes the spawned PID as the owned POSIX process group", () => {
      const supervised: Array<{ readonly pid: number; readonly groupId: number | undefined }> = [];
      return makeProductionCheckKiloProviderStatus("kilo", {
        platform: "linux",
        superviseProcess: (prepared, child, options = {}) => {
          supervised.push({
            pid: Number(child.pid),
            groupId: options.ownedProcessGroupId,
          });
          return TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child);
        },
      }).pipe(
        Effect.provide(mockSpawnerLayer(() => ({ stdout: "kilo 7.4.10\n", stderr: "", code: 0 }))),
        Effect.tap(() =>
          Effect.sync(() => {
            assert.ok(supervised.length > 0);
            assert.deepStrictEqual(
              supervised,
              supervised.map(({ pid }) => ({ pid, groupId: pid })),
            );
          }),
        ),
      );
    });

    it.effect("unregisters a health owner when constructor recovery proves exit", () =>
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        const constructorError = new Error("health supervisor construction failed");
        const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
        let constructionAttempts = 0;

        const status = yield* makeProductionCheckKiloProviderStatus("kilo", {
          platform: "linux",
          maintenanceOwnedResources: coordinator,
          processTreeKiller: syntheticProcessTreeKiller(1),
          teardownProcessTree: teardown,
          superviseProcess: () => {
            constructionAttempts += 1;
            throw constructorError;
          },
        }).pipe(
          Effect.provide(
            mockSpawnerLayer(() => ({ stdout: "kilo 7.4.10\n", stderr: "", code: 0 })),
          ),
        );

        assert.strictEqual(status.status, "error");
        assert.match(status.message ?? "", /health supervisor construction failed/u);
        assert.strictEqual(constructionAttempts, 1);
        assert.strictEqual(teardown.mock.calls.length, 1);

        yield* coordinator.drainProviderResources({ provider: "kilo" });
        assert.strictEqual(teardown.mock.calls.length, 1);
      }),
    );

    it.effect("installs an exit observer during synchronous health construction recovery", () =>
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        const constructorError = new Error("health supervisor construction failed");
        const rootPid = 83;
        const root = {
          pid: rootPid,
          command: "kilo --version",
          identity: `${rootPid}:health-construction-recovery`,
        };
        const processExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        let running = true;
        let constructionAttempts = 0;
        let rootExitObserved = false;
        const teardown = vi.fn(async (input: Parameters<typeof teardownProviderProcessTree>[0]) => {
          running = false;
          Deferred.doneUnsafe(processExit, Effect.succeed(ChildProcessSpawner.ExitCode(0)));
          await input.rootExited;
          rootExitObserved = true;
          return { escalated: false, signalErrors: [] };
        });
        const processTreeKiller: ProcessTreeKiller = {
          capture: () => ({ root, descendants: [], captureComplete: true }),
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => {},
        };
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(rootPid),
          exitCode: Deferred.await(processExit),
          isRunning: Effect.sync(() => running),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });

        const status = yield* makeProductionCheckKiloProviderStatus("kilo", {
          platform: "linux",
          maintenanceOwnedResources: coordinator,
          processTreeKiller,
          teardownProcessTree: teardown,
          superviseProcess: () => {
            constructionAttempts += 1;
            throw constructorError;
          },
        }).pipe(
          Effect.provide(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.succeed(handle)),
            ),
          ),
        );

        assert.strictEqual(status.status, "error");
        assert.match(status.message ?? "", /health supervisor construction failed/u);
        assert.strictEqual(constructionAttempts, 1);
        assert.strictEqual(teardown.mock.calls.length, 1);
        assert.strictEqual(rootExitObserved, true);

        yield* coordinator.drainProviderResources({ provider: "kilo" });
        assert.strictEqual(teardown.mock.calls.length, 1);
      }),
    );

    it.effect("retains a failed health construction recovery on the same supervisor", () =>
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        const constructorError = new Error("health supervisor construction failed");
        const unprovenExit = new ProviderProcessExitUnprovenError({
          rootPid: 1,
          rootExited: true,
          remainingDescendantPids: [2],
          captureComplete: true,
        });
        const reported: ProviderProcessExitUnprovenError[] = [];
        const teardown = vi.fn(async () => {
          if (teardown.mock.calls.length === 1) throw unprovenExit;
          return { escalated: false, signalErrors: [] };
        });
        let constructionAttempts = 0;

        const status = yield* makeProductionCheckKiloProviderStatus("kilo", {
          platform: "linux",
          maintenanceOwnedResources: coordinator,
          processTreeKiller: syntheticProcessTreeKiller(1),
          teardownProcessTree: teardown,
          onUnprovenExit: ({ error }) =>
            Effect.sync(() => {
              reported.push(error);
            }),
          superviseProcess: () => {
            constructionAttempts += 1;
            throw constructorError;
          },
        }).pipe(
          Effect.provide(
            mockSpawnerLayer(() => ({ stdout: "kilo 7.4.10\n", stderr: "", code: 0 })),
          ),
        );

        assert.strictEqual(status.status, "error");
        assert.strictEqual(constructionAttempts, 1);
        assert.strictEqual(teardown.mock.calls.length, 1);
        assert.deepStrictEqual(reported, [unprovenExit]);

        yield* coordinator.drainProviderResources({ provider: "kilo" });
        assert.strictEqual(constructionAttempts, 1);
        assert.strictEqual(teardown.mock.calls.length, 2);
      }),
    );

    it.effect("emergency-tears down a provisional Claude owner when exact construction fails", () =>
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        const emergencyTeardown = vi.fn(async () => ({
          escalated: false,
          signalErrors: [],
        }));
        const child = Object.assign(new EventEmitter(), {
          pid: 706,
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
          kill: vi.fn(() => true),
        }) as unknown as ChildProcess;
        const spawnFailure = new Error("contained supervisor construction failed");
        const spawnContainedClaudeProcess: NonNullable<
          ProviderHealthProcessOptions["spawnContainedClaudeProcess"]
        > = (options, dependencies = {}) => {
          dependencies.onSpawnedProcess?.({
            prepared: { command: options.command, args: options.args, shell: false },
            process: child,
            platform: "win32",
          });
          throw spawnFailure;
        };
        const queryClaude = ((input) => {
          input.options?.spawnClaudeCodeProcess?.({
            command: "claude",
            args: ["--probe"],
            cwd: process.cwd(),
            env: {},
            signal: new AbortController().signal,
          });
          throw new Error("expected the contained spawn to fail");
        }) as NonNullable<ProviderHealthProcessOptions["queryClaude"]>;

        const result = yield* probeClaudeSubscription({
          platform: "win32",
          maintenanceOwnedResources: coordinator,
          spawnContainedClaudeProcess,
          queryClaude,
          teardownProcessTree: emergencyTeardown,
        });

        assert.strictEqual(result, undefined);
        assert.strictEqual(emergencyTeardown.mock.calls.length, 1);
        yield* coordinator.drainProviderResources({ provider: "claudeAgent" });
        assert.strictEqual(emergencyTeardown.mock.calls.length, 1);
      }),
    );

    it.effect("finalizes two immutable Claude owners and retains only the failed one", () =>
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        const maintenanceGate = yield* makeProviderMaintenanceGate;
        const attempts = new Map<number, number>();
        const reported: ProviderProcessExitUnprovenError[] = [];
        let spawned = 0;
        let secondOwnerStillFails = true;

        const spawnContainedClaudeProcess: NonNullable<
          ProviderHealthProcessOptions["spawnContainedClaudeProcess"]
        > = (options, dependencies = {}) => {
          const pid = 701 + spawned;
          spawned += 1;
          const events = new EventEmitter();
          const child = Object.assign(events, {
            pid,
            exitCode: null as number | null,
            signalCode: null as NodeJS.Signals | null,
            kill: vi.fn(() => true),
          }) as unknown as ChildProcess;
          const prepared = {
            command: options.command,
            args: options.args,
            shell: false as const,
          };
          dependencies.onSpawnedProcess?.({ prepared, process: child, platform: "linux" });
          supervisePreparedNodeProcess(prepared, child, {
            platform: "linux",
            teardownProcessTree: async () => {
              const nextAttempt = (attempts.get(pid) ?? 0) + 1;
              attempts.set(pid, nextAttempt);
              if (pid === 702 && secondOwnerStillFails) {
                throw new ProviderProcessExitUnprovenError({
                  rootPid: pid,
                  rootExited: true,
                  remainingDescendantPids: [703],
                  captureComplete: true,
                });
              }
              return { escalated: false, signalErrors: [] };
            },
          });
          return child;
        };
        const queryClaude = ((input) => {
          const spawn = input.options?.spawnClaudeCodeProcess;
          if (!spawn) throw new Error("Claude process spawner was not installed.");
          for (const index of [0, 1]) {
            spawn({
              command: "claude",
              args: [`--probe-${index}`],
              cwd: process.cwd(),
              env: {},
              signal: new AbortController().signal,
            });
          }
          return {
            initializationResult: async () => ({ account: { subscriptionType: "max" } }),
          } as ReturnType<NonNullable<ProviderHealthProcessOptions["queryClaude"]>>;
        }) as NonNullable<ProviderHealthProcessOptions["queryClaude"]>;

        const result = yield* probeClaudeSubscription({
          platform: "linux",
          maintenanceOwnedResources: coordinator,
          spawnContainedClaudeProcess,
          queryClaude,
          onUnprovenExit: ({ error }) =>
            Effect.sync(() => {
              reported.push(error);
            }).pipe(
              Effect.andThen(
                maintenanceGate.latchProvider({ provider: "claudeAgent", reason: error.message }),
              ),
            ),
        });
        const blocked = yield* maintenanceGate
          .withOperation({
            provider: "claudeAgent",
            operation: "session.start",
            run: Effect.void,
          })
          .pipe(Effect.flip);

        assert.strictEqual(result?.subscriptionType, "max");
        assert.strictEqual(spawned, 2);
        assert.deepStrictEqual(
          [...attempts.entries()],
          [
            [701, 1],
            [702, 1],
          ],
        );
        assert.strictEqual(reported.length, 1);
        assert.match(reported[0]?.message ?? "", /descendants still running: 703/u);
        assert.match(blocked.latchedReason ?? "", /descendants still running: 703/u);

        secondOwnerStillFails = false;
        yield* coordinator.drainProviderResources({ provider: "claudeAgent" });
        assert.deepStrictEqual(
          [...attempts.entries()],
          [
            [701, 1],
            [702, 2],
          ],
        );
      }),
    );

    it.effect("latches a branded health failure before releasing a queued updater", () =>
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        const maintenanceGate = yield* makeProviderMaintenanceGate;
        const proveExitStarted = yield* Deferred.make<void>();
        const releaseProveExit = yield* Deferred.make<void>();
        const teardown = vi.fn(async () => {
          if (teardown.mock.calls.length === 1) {
            throw new Error("Invalid provider health teardown acknowledgement");
          }
          return { escalated: false, signalErrors: [] };
        });
        const reported: ProviderProcessExitUnprovenError[] = [];
        let supervisorConstructions = 0;
        let updaterSpawnCount = 0;

        const health = yield* maintenanceGate
          .withOperation({
            provider: "kilo",
            operation: "ProviderHealth.refresh",
            run: makeProductionCheckKiloProviderStatus("kilo", {
              platform: "linux",
              maintenanceOwnedResources: coordinator,
              superviseProcess: (prepared, child) => {
                supervisorConstructions += 1;
                return {
                  ...TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child),
                  proveExit: async () => {
                    await Effect.runPromise(
                      Deferred.succeed(proveExitStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseProveExit)),
                      ),
                    );
                    throw new Error("Invalid provider health exit acknowledgement");
                  },
                  teardown,
                };
              },
              onUnprovenExit: ({ error }) =>
                Effect.sync(() => {
                  reported.push(error);
                }).pipe(
                  Effect.andThen(
                    maintenanceGate.latchProvider({ provider: "kilo", reason: error.message }),
                  ),
                ),
            }).pipe(
              Effect.provide(
                mockSpawnerLayer(() => ({
                  stdout: "kilo 7.4.10\n",
                  stderr: "",
                  code: 0,
                })),
              ),
            ),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(proveExitStarted);

        const updater = yield* maintenanceGate
          .withExclusiveMaintenance({
            provider: "kilo",
            run: Effect.sync(() => {
              updaterSpawnCount += 1;
            }),
          })
          .pipe(Effect.forkChild);
        let queuedBusy = false;
        for (let attempt = 0; attempt < 100 && !queuedBusy; attempt += 1) {
          const admission = yield* maintenanceGate
            .withOperation({
              provider: "kilo",
              operation: "queue-observer",
              run: Effect.void,
            })
            .pipe(Effect.result);
          queuedBusy = Result.isFailure(admission) && admission.failure.latchedReason === null;
          if (!queuedBusy) yield* Effect.yieldNow;
        }
        assert.strictEqual(queuedBusy, true);

        yield* Deferred.succeed(releaseProveExit, undefined);
        yield* Fiber.join(health);
        const updaterFailure = yield* Fiber.join(updater).pipe(Effect.flip);

        assert.strictEqual(updaterSpawnCount, 0);
        assert.match(updaterFailure.message, /process exit could not be proven/u);
        assert.strictEqual(supervisorConstructions, 1);
        assert.strictEqual(teardown.mock.calls.length, 1);
        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof ProviderProcessExitUnprovenError);
        assert.match(reported[0]?.message ?? "", /did not prove complete exit/u);

        yield* coordinator.drainProviderResources({ provider: "kilo" });
        assert.strictEqual(supervisorConstructions, 1);
        assert.strictEqual(teardown.mock.calls.length, 2);
      }),
    );
  });

  describe("provider update commands", () => {
    it.effect.skipIf(process.platform !== "win32")(
      "launches Windows npm updates as node.exe plus npm-cli.js without cmd.exe",
      () =>
        withKiloUpdateFixture("7.4.10", (input) =>
          withLatestNpmVersion(
            "7.4.11",
            Effect.gen(function* () {
              let updated = false;
              let updateSpawnCount = 0;
              const layer = makeProviderHealthLive({
                processTreeKiller: syntheticProcessTreeKiller(71),
              }).pipe(
                Layer.provideMerge(providerServiceWithoutRuntimesLayer),
                Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
                Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
                Layer.provideMerge(
                  mockSpawnerLayer((args, command, env, options) => {
                    if (args.includes("@kilocode/cli@latest")) {
                      updateSpawnCount += 1;
                      assert.strictEqual(
                        command.toLowerCase(),
                        fixtureWindowsNpmNodePath(input.fixture).toLowerCase(),
                      );
                      assert.deepStrictEqual(args, [
                        fixtureWindowsNpmCliPath(input.fixture),
                        "install",
                        "-g",
                        "--prefix",
                        input.npmPrefix,
                        "@kilocode/cli@latest",
                      ]);
                      assert.strictEqual(options?.windowsVerbatimArguments, undefined);
                      assert.strictEqual(
                        env?.PATH?.split(";")[0]?.toLowerCase(),
                        input.fixture.commandDirectory.toLowerCase(),
                      );
                      const invocation = `${command} ${args.join(" ")}`.toLowerCase();
                      assert.ok(!invocation.includes("cmd.exe"));
                      assert.ok(!invocation.includes("npm.cmd"));
                      assert.ok(!invocation.includes("call "));
                      assert.ok(!invocation.includes("npm-prefix.js"));
                      updated = true;
                      return { stdout: "updated\n", stderr: "", code: 0 };
                    }
                    return {
                      stdout: updated ? "kilo 7.4.11\n" : "kilo 7.4.10\n",
                      stderr: "",
                      code: 0,
                    };
                  }),
                ),
              );

              const result = yield* Effect.gen(function* () {
                const providerHealth = yield* ProviderHealth;
                return yield* providerHealth.updateProvider({ provider: "kilo" });
              }).pipe(Effect.provide(layer));
              const kilo = result.providers.find((status) => status.provider === "kilo");

              assert.strictEqual(updateSpawnCount, 1);
              assert.strictEqual(kilo?.updateState?.status, "succeeded");
            }),
          ),
        ),
    );

    it.effect.skipIf(process.platform !== "win32")(
      "keeps Effect cleanup when the default updater supervisor constructor fails",
      () =>
        withKiloUpdateFixture("7.4.10", (input) =>
          withLatestNpmVersion(
            "7.4.11",
            Effect.gen(function* () {
              const lifecycle: string[] = [];
              const expectedUpdateArgs = [
                fixtureWindowsNpmCliPath(input.fixture),
                "install",
                "-g",
                "--prefix",
                input.npmPrefix,
                "@kilocode/cli@latest",
              ] as const;
              const isUpdateCommand = (args: ReadonlyArray<string>) =>
                args.length === expectedUpdateArgs.length &&
                expectedUpdateArgs.every((expected, index) => args[index] === expected);
              let updatePrepareHits = 0;
              const updateHandle = ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(86),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () =>
                  Effect.sync(() => {
                    lifecycle.push("provisional");
                  }),
                stdin: Sink.drain,
                stdout: Stream.make(encoder.encode("updated\n")),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              });
              const layer = makeProductionProviderHealthLive({
                platform: "win32",
                processTreeKiller: syntheticProcessTreeKiller(1),
                windowsJobSupervisorOptions: {
                  requestStop: () => Promise.resolve(),
                  verifyExit: () => Promise.resolve(),
                },
                prepareProcess: (command, args, options) => {
                  if (isUpdateCommand(args)) {
                    updatePrepareHits += 1;
                    return { command, args: [...args], shell: false };
                  }
                  return prepareWindowsProviderProcess(command, args, {
                    ...options,
                    platform: "win32",
                    launcherPath: "C:\\Synara\\synara-windows-job-launcher.exe",
                    fileExists: () => true,
                    controlDirectory: input.baseDir,
                  });
                },
              }).pipe(
                Layer.provideMerge(providerServiceWithoutRuntimesLayer),
                Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
                Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
                Layer.provideMerge(
                  provisionalOwnerSpawnerLayer((args, _command, _env, options) => {
                    if (isUpdateCommand(args)) {
                      lifecycle.push(
                        options?.synaraExternallySupervised === true
                          ? "external"
                          : "provisional-owned",
                      );
                      return Effect.succeed(updateHandle);
                    }
                    return Effect.succeed(
                      mockHandle({ stdout: "kilo 7.4.10\n", stderr: "", code: 0 }),
                    );
                  }),
                ),
              );

              const result = yield* Effect.gen(function* () {
                const providerHealth = yield* ProviderHealth;
                return yield* providerHealth.updateProvider({ provider: "kilo" });
              }).pipe(Effect.provide(layer));
              const kilo = result.providers.find((status) => status.provider === "kilo");

              assert.strictEqual(updatePrepareHits, 1);
              assert.strictEqual(kilo?.updateState?.status, "failed");
              assert.match(
                kilo?.updateState?.message ?? "",
                /without Job-prepared command provenance/u,
              );
              assert.deepStrictEqual(lifecycle, ["provisional-owned", "provisional"]);
            }),
          ),
        ),
    );

    it.effect("runs exact updater cleanup before provisional cleanup when registration fails", () =>
      withKiloUpdateFixture("7.4.10", (input) =>
        withLatestNpmVersion(
          "7.4.11",
          Effect.gen(function* () {
            const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
            const processExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            const registrationFailure = new Error("updater owner registration failed");
            const lifecycle: string[] = [];
            let running = true;
            const updateHandle = ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(87),
              exitCode: Deferred.await(processExit),
              isRunning: Effect.sync(() => running),
              kill: () =>
                Effect.sync(() => {
                  lifecycle.push("provisional");
                  running = false;
                  Deferred.doneUnsafe(processExit, Effect.succeed(ChildProcessSpawner.ExitCode(0)));
                }),
              stdin: Sink.drain,
              stdout: Stream.never,
              stderr: Stream.never,
              all: Stream.never,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.never,
            });
            const maintenanceOwnedResources = {
              register: (
                resource: Parameters<ProviderMaintenanceOwnedResourceCoordinator["register"]>[0],
              ) =>
                resource.resourceId.startsWith("provider-update:")
                  ? Effect.sync(() => lifecycle.push("register")).pipe(
                      Effect.andThen(Effect.fail(registrationFailure)),
                    )
                  : coordinator.register(resource),
              drainProviderResources: coordinator.drainProviderResources,
            } as ProviderMaintenanceOwnedResourceCoordinator;
            const layer = makeProviderHealthLive({
              maintenanceOwnedResources,
              superviseProcess: (prepared, child) =>
                prepared.args.some((arg) => arg.includes("@kilocode/cli@latest"))
                  ? {
                      rootPid: Number(child.pid),
                      waitForInitialCapture: async () => undefined,
                      captureNow: async () => undefined,
                      proveExit: async () => ({ escalated: false, signalErrors: [] }),
                      teardown: async () => {
                        lifecycle.push("exact");
                        return { escalated: false, signalErrors: [] };
                      },
                    }
                  : TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child),
            }).pipe(
              Layer.provideMerge(providerServiceWithoutRuntimesLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
              Layer.provideMerge(
                provisionalOwnerSpawnerLayer((args) =>
                  args.some((arg) => arg.includes("@kilocode/cli@latest"))
                    ? Effect.succeed(updateHandle)
                    : Effect.succeed(mockHandle({ stdout: "kilo 7.4.10\n", stderr: "", code: 0 })),
                ),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              return yield* providerHealth.updateProvider({ provider: "kilo" });
            }).pipe(Effect.provide(layer));
            const kilo = result.providers.find((status) => status.provider === "kilo");

            assert.strictEqual(kilo?.updateState?.status, "failed");
            assert.match(kilo?.updateState?.message ?? "", /updater owner registration failed/u);
            assert.deepStrictEqual(lifecycle, ["register", "exact", "provisional"]);
          }),
        ),
      ),
    );

    it.effect("unregisters an updater owner when constructor recovery proves exit", () =>
      withKiloUpdateFixture("7.4.10", (input) =>
        withLatestNpmVersion(
          "7.4.11",
          Effect.gen(function* () {
            const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
            const constructorError = new Error("updater supervisor construction failed");
            const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
            let constructionAttempts = 0;
            let updateSpawnCount = 0;

            const layer = makeProviderHealthLive({
              maintenanceOwnedResources: coordinator,
              processTreeKiller: syntheticProcessTreeKiller(1),
              teardownProcessTree: () => teardown(),
              windowsJobSupervisorOptions: {
                requestStop: () => Promise.resolve(),
                verifyExit: async () => {
                  await teardown();
                },
              },
              superviseProcess: (prepared, child) => {
                if (!prepared.args.some((arg) => arg.includes("@kilocode/cli@latest"))) {
                  return TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child);
                }
                constructionAttempts += 1;
                throw constructorError;
              },
            }).pipe(
              Layer.provideMerge(providerServiceWithoutRuntimesLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
              Layer.provideMerge(
                mockSpawnerLayer((args, command, env, options) => {
                  if (
                    preparedProviderCommandMatches({
                      fixture: input.fixture,
                      executable: fixtureExecutablePath(input.fixture, "npm"),
                      expectedArgs: [
                        "install",
                        "-g",
                        "--prefix",
                        input.npmPrefix,
                        "@kilocode/cli@latest",
                      ],
                      command,
                      actualArgs: args,
                      env,
                      options,
                    })
                  ) {
                    updateSpawnCount += 1;
                    return { stdout: "updated\n", stderr: "", code: 0 };
                  }
                  return { stdout: "kilo 7.4.10\n", stderr: "", code: 0 };
                }),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              return yield* providerHealth.updateProvider({ provider: "kilo" });
            }).pipe(Effect.provide(layer));
            const kilo = result.providers.find((status) => status.provider === "kilo");

            assert.strictEqual(updateSpawnCount, 1);
            assert.strictEqual(kilo?.updateState?.status, "failed");
            assert.match(
              kilo?.updateState?.message ?? "",
              /updater supervisor construction failed/u,
            );
            assert.strictEqual(constructionAttempts, 1);
            assert.strictEqual(teardown.mock.calls.length, 1);

            yield* coordinator.drainProviderResources({ provider: "kilo" });
            assert.strictEqual(teardown.mock.calls.length, 1);
          }),
        ),
      ),
    );

    it.effect("retains an unproven updater construction recovery on the same supervisor", () =>
      withKiloUpdateFixture("7.4.10", (input) =>
        withLatestNpmVersion(
          "7.4.11",
          Effect.gen(function* () {
            const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
            const maintenanceGate = yield* makeProviderMaintenanceGate;
            const constructorError = new Error("updater supervisor construction failed");
            const unprovenExit = new ProviderProcessExitUnprovenError({
              rootPid: 1,
              rootExited: true,
              remainingDescendantPids: [2],
              captureComplete: true,
            });
            const teardown = vi.fn(async () => {
              if (teardown.mock.calls.length === 1) throw unprovenExit;
              return { escalated: false, signalErrors: [] };
            });
            let constructionAttempts = 0;
            let updateSpawnCount = 0;

            const layer = makeProviderHealthLive({
              maintenanceGate,
              maintenanceOwnedResources: coordinator,
              processTreeKiller: syntheticProcessTreeKiller(1),
              teardownProcessTree: () => teardown(),
              windowsJobSupervisorOptions: {
                requestStop: () => Promise.resolve(),
                verifyExit: async () => {
                  await teardown();
                },
              },
              superviseProcess: (prepared, child) => {
                if (!prepared.args.some((arg) => arg.includes("@kilocode/cli@latest"))) {
                  return TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child);
                }
                constructionAttempts += 1;
                throw constructorError;
              },
            }).pipe(
              Layer.provideMerge(providerServiceWithoutRuntimesLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
              Layer.provideMerge(
                mockSpawnerLayer((args, command, env, options) => {
                  if (
                    preparedProviderCommandMatches({
                      fixture: input.fixture,
                      executable: fixtureExecutablePath(input.fixture, "npm"),
                      expectedArgs: [
                        "install",
                        "-g",
                        "--prefix",
                        input.npmPrefix,
                        "@kilocode/cli@latest",
                      ],
                      command,
                      actualArgs: args,
                      env,
                      options,
                    })
                  ) {
                    updateSpawnCount += 1;
                    return { stdout: "updated\n", stderr: "", code: 0 };
                  }
                  return { stdout: "kilo 7.4.10\n", stderr: "", code: 0 };
                }),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              return yield* providerHealth.updateProvider({ provider: "kilo" });
            }).pipe(Effect.provide(layer));
            const kilo = result.providers.find((status) => status.provider === "kilo");
            const blocked = yield* maintenanceGate
              .withOperation({
                provider: "kilo",
                operation: "session.start",
                run: Effect.void,
              })
              .pipe(Effect.flip);

            assert.strictEqual(updateSpawnCount, 1);
            assert.strictEqual(kilo?.updateState?.status, "failed");
            assert.match(kilo?.updateState?.message ?? "", /Restart Synara/u);
            assert.match(blocked.latchedReason ?? "", /descendants still running: 2/u);
            assert.strictEqual(constructionAttempts, 1);
            assert.strictEqual(teardown.mock.calls.length, 1);

            yield* coordinator.drainProviderResources({ provider: "kilo" });
            assert.strictEqual(constructionAttempts, 1);
            assert.strictEqual(teardown.mock.calls.length, 2);
          }),
        ),
      ),
    );

    it.effect(
      "fails terminally without spawning when the pre-update probe is already latched",
      () =>
        withKiloUpdateFixture("7.4.10", (input) =>
          withLatestNpmVersion(
            "7.4.11",
            Effect.gen(function* () {
              const maintenanceGate = yield* makeProviderMaintenanceGate;
              yield* maintenanceGate.latchProvider({
                provider: "kilo",
                reason: "prior process exit remains unproven",
              });
              let spawnCount = 0;
              const layer = makeProviderHealthLive({ maintenanceGate }).pipe(
                Layer.provideMerge(providerServiceWithoutRuntimesLayer),
                Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
                Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
                Layer.provideMerge(
                  mockSpawnerLayer(() => {
                    spawnCount += 1;
                    return { stdout: "unexpected spawn\n", stderr: "", code: 0 };
                  }),
                ),
              );

              const observed = yield* Effect.gen(function* () {
                const providerHealth = yield* ProviderHealth;
                const error = yield* providerHealth
                  .updateProvider({ provider: "kilo" })
                  .pipe(Effect.flip);
                const providers = yield* providerHealth.getStatuses;
                return { error, providers };
              }).pipe(Effect.provide(layer));
              const kilo = observed.providers.find((status) => status.provider === "kilo");

              assert.ok(observed.error instanceof ServerProviderUpdateError);
              assert.match(observed.error.message, /prior process exit remains unproven/u);
              assert.strictEqual(spawnCount, 0);
              assert.strictEqual(kilo?.updateState?.status, "failed");
              assert.match(
                kilo?.updateState?.message ?? "",
                /prior process exit remains unproven/u,
              );
            }),
          ),
        ),
    );

    it.effect(
      "fails terminally without spawning a post-update probe after exit proof latches",
      () =>
        withKiloUpdateFixture("7.4.10", (input) =>
          withLatestNpmVersion(
            "7.4.11",
            Effect.gen(function* () {
              const maintenanceGate = yield* makeProviderMaintenanceGate;
              let healthSpawnCount = 0;
              let updateSpawnCount = 0;
              const layer = makeProviderHealthLive({
                maintenanceGate,
                superviseProcess: (prepared, child) => {
                  if (!prepared.args.some((arg) => arg.includes("@kilocode/cli@latest"))) {
                    return TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child);
                  }
                  return {
                    ...TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child),
                    proveExit: async () => {
                      await Effect.runPromise(
                        maintenanceGate.latchProvider({
                          provider: "kilo",
                          reason: "updater exit proof requires restart",
                        }),
                      );
                      return { escalated: false, signalErrors: [] };
                    },
                  };
                },
              }).pipe(
                Layer.provideMerge(providerServiceWithoutRuntimesLayer),
                Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
                Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
                Layer.provideMerge(
                  mockSpawnerLayer((args, command, env, options) => {
                    if (
                      preparedProviderCommandMatches({
                        fixture: input.fixture,
                        executable: fixtureExecutablePath(input.fixture, "npm"),
                        expectedArgs: [
                          "install",
                          "-g",
                          "--prefix",
                          input.npmPrefix,
                          "@kilocode/cli@latest",
                        ],
                        command,
                        actualArgs: args,
                        env,
                        options,
                      })
                    ) {
                      updateSpawnCount += 1;
                      return { stdout: "updated\n", stderr: "", code: 0 };
                    }
                    healthSpawnCount += 1;
                    return { stdout: "kilo 7.4.10\n", stderr: "", code: 0 };
                  }),
                ),
              );

              const observed = yield* Effect.gen(function* () {
                const providerHealth = yield* ProviderHealth;
                const error = yield* providerHealth
                  .updateProvider({ provider: "kilo" })
                  .pipe(Effect.flip);
                const providers = yield* providerHealth.getStatuses;
                return { error, providers };
              }).pipe(Effect.provide(layer));
              const kilo = observed.providers.find((status) => status.provider === "kilo");

              assert.ok(observed.error instanceof ServerProviderUpdateError);
              assert.match(observed.error.message, /updater exit proof requires restart/u);
              assert.strictEqual(updateSpawnCount, 1);
              assert.strictEqual(healthSpawnCount, 1);
              assert.strictEqual(kilo?.updateState?.status, "failed");
              assert.match(
                kilo?.updateState?.message ?? "",
                /updater exit proof requires restart/u,
              );
            }),
          ),
        ),
    );

    it.effect("latches an unproven health proveExit even when teardown later succeeds", () =>
      withKiloUpdateFixture("7.4.10", (input) =>
        withLatestNpmVersion(
          "7.4.11",
          Effect.gen(function* () {
            const maintenanceGate = yield* makeProviderMaintenanceGate;
            const unprovenExit = new ProviderProcessExitUnprovenError({
              rootPid: 1,
              rootExited: true,
              remainingDescendantPids: [2],
              captureComplete: true,
            });
            const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
            let healthSpawnCount = 0;
            let updateSpawnCount = 0;
            const layer = makeProviderHealthLive({
              maintenanceGate,
              superviseProcess: (prepared, child) => {
                if (prepared.args.some((arg) => arg.includes("@kilocode/cli@latest"))) {
                  return TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child);
                }
                return {
                  ...TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child),
                  proveExit: async () => {
                    throw new AggregateError(
                      [new Error("ordinary sibling failure"), unprovenExit],
                      "wrapped health proof failure",
                    );
                  },
                  teardown,
                };
              },
            }).pipe(
              Layer.provideMerge(providerServiceWithoutRuntimesLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
              Layer.provideMerge(
                mockSpawnerLayer((args, command, env, options) => {
                  if (
                    preparedProviderCommandMatches({
                      fixture: input.fixture,
                      executable: fixtureExecutablePath(input.fixture, "npm"),
                      expectedArgs: [
                        "install",
                        "-g",
                        "--prefix",
                        input.npmPrefix,
                        "@kilocode/cli@latest",
                      ],
                      command,
                      actualArgs: args,
                      env,
                      options,
                    })
                  ) {
                    updateSpawnCount += 1;
                    return { stdout: "updated\n", stderr: "", code: 0 };
                  }
                  healthSpawnCount += 1;
                  return { stdout: "kilo 7.4.10\n", stderr: "", code: 0 };
                }),
              ),
            );

            const observed = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              const update = yield* providerHealth
                .updateProvider({ provider: "kilo" })
                .pipe(Effect.result);
              const providers = yield* providerHealth.getStatuses;
              return { update, providers };
            }).pipe(Effect.provide(layer));
            const kilo = observed.providers.find((status) => status.provider === "kilo");
            const blocked = yield* maintenanceGate
              .withOperation({
                provider: "kilo",
                operation: "session.start",
                run: Effect.void,
              })
              .pipe(Effect.flip);

            assert.ok(Result.isFailure(observed.update));
            if (Result.isFailure(observed.update)) {
              assert.ok(observed.update.failure instanceof ServerProviderUpdateError);
              assert.match(observed.update.failure.message, /did not prove exit/u);
            }
            assert.strictEqual(healthSpawnCount, 1);
            assert.strictEqual(updateSpawnCount, 0);
            assert.strictEqual(teardown.mock.calls.length, 1);
            assert.match(blocked.latchedReason ?? "", /descendants still running: 2/u);
            assert.strictEqual(kilo?.updateState?.status, "failed");
          }),
        ),
      ),
    );

    it("derives stable native install roots instead of version or bin directories", () => {
      const cases = [
        {
          provider: "codex" as const,
          visible: "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
          canonical:
            "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\releases\\0.144.6\\codex.exe",
          expected: "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex",
          platform: "win32" as const,
        },
        {
          provider: "claudeAgent" as const,
          visible: "/Users/test/.local/bin/claude",
          canonical: "/Users/test/.local/share/claude/versions/2.1.0/claude",
          expected: "/Users/test/.local/share/claude",
          platform: "darwin" as const,
        },
        {
          provider: "antigravity" as const,
          visible: "C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe",
          canonical: "C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe",
          expected: "C:\\Users\\Test\\AppData\\Local\\agy",
          platform: "win32" as const,
        },
        {
          provider: "kilo" as const,
          visible: "/Users/test/.local/bin/kilo",
          canonical: "/Users/test/.local/share/kilo/bin/kilo",
          expected: "/Users/test/.local/share/kilo",
          platform: "darwin" as const,
        },
        {
          provider: "opencode" as const,
          visible: "/Users/test/.opencode/bin/opencode",
          canonical: "/Users/test/.opencode/bin/opencode",
          expected: "/Users/test/.opencode",
          platform: "darwin" as const,
        },
        {
          provider: "cursor" as const,
          visible: "/Users/test/.local/bin/cursor-agent",
          canonical: "/Users/test/.local/share/cursor-agent/versions/2026.07/cursor-agent",
          expected: "/Users/test/.local/share/cursor-agent",
          platform: "darwin" as const,
        },
      ];

      for (const fixture of cases) {
        const definition = PACKAGE_MANAGED_PROVIDER_UPDATES[fixture.provider];
        assert.ok(definition?.nativeUpdate?.resolveInstallRoot);
        assert.strictEqual(
          definition.nativeUpdate.resolveInstallRoot({
            visibleCommandPath: fixture.visible,
            canonicalCommandPath: fixture.canonical,
            platform: fixture.platform,
          }),
          fixture.expected,
        );
      }
    });

    it("keeps an unverified Command Code launcher manual-only", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.commandCode;
      assert.ok(definition);
      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        binaryPath: "commandcode",
        realCommandPath: "/usr/local/bin/commandcode",
        commandDirectory: "/usr/local/bin",
      });
      assert.strictEqual(capabilities.update, null);
    });

    it("registers Antigravity's native updater", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.antigravity;
      assert.ok(definition);
      const binaryPath = "/Users/test/.local/bin/agy";

      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        platform: "darwin",
        binaryPath,
        realCommandPath: binaryPath,
        canonicalInstallRoot: "/Users/test/.local/bin",
        managerExecutablePath: binaryPath,
        realManagerExecutablePath: binaryPath,
      });

      assert.ok(capabilities.update);
      assert.strictEqual(capabilities.update.executable, binaryPath);
      assert.deepStrictEqual(capabilities.update.args, ["update"]);
      assert.strictEqual(capabilities.update.lockKey, "antigravity-native:/Users/test/.local/bin");
      assert.strictEqual(capabilities.update.target.canonicalInstallRoot, "/Users/test/.local/bin");
    });

    it("updates the selected standalone Codex executable in place", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.codex;
      assert.ok(definition);
      const binaryPath = "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        binaryPath,
        realCommandPath: binaryPath,
        canonicalInstallRoot: "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex",
        managerExecutablePath: binaryPath,
        realManagerExecutablePath: binaryPath,
        platform: "win32",
      });

      assert.ok(capabilities.update);
      assert.strictEqual(capabilities.update.command, `${binaryPath} update`);
      assert.strictEqual(capabilities.update.executable, binaryPath);
      assert.deepStrictEqual(capabilities.update.args, ["update"]);
      assert.strictEqual(
        capabilities.update.lockKey,
        "codex-native:c:/users/test/appdata/local/programs/openai/codex",
      );
    });

    it("keeps Grok manual-only when its stable or alpha channel is unknown", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.grok;
      assert.equal(definition, undefined);
    });

    it("updates only a positively matched standalone Cursor Agent", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.cursor;
      assert.ok(definition);
      const visiblePath = "/Users/test/.local/bin/cursor-agent";
      const canonicalPath = "/Users/test/.local/share/cursor-agent/versions/2026.07/cursor-agent";
      const standalone = resolvePackageManagedProviderMaintenance(definition, {
        platform: "darwin",
        binaryPath: visiblePath,
        realCommandPath: canonicalPath,
        canonicalInstallRoot: "/Users/test/.local/share/cursor-agent",
        managerExecutablePath: visiblePath,
        realManagerExecutablePath: canonicalPath,
      });
      const editor = resolvePackageManagedProviderMaintenance(definition, {
        platform: "darwin",
        binaryPath: "cursor",
        realCommandPath: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        commandDirectory: "/Applications/Cursor.app/Contents/Resources/app/bin",
      });

      assert.ok(standalone.update);
      assert.strictEqual(standalone.update.executable, visiblePath);
      assert.deepStrictEqual(standalone.update.args, ["update"]);
      assert.strictEqual(
        standalone.update.lockKey,
        "cursor-agent-native:/Users/test/.local/share/cursor-agent",
      );
      assert.strictEqual(editor.update, null);
    });

    it("updates either exact Factory Droid npm identity through its owning manager", () => {
      const definitions = packageManagedProviderUpdateDefinitions("droid");
      assert.deepStrictEqual(
        definitions.map((definition) => definition.npmPackageName),
        ["droid", "@factory/cli"],
      );
      const installRoot = "/Users/test/.npm";
      const binaryPath = `${installRoot}/bin/droid`;
      for (const definition of definitions) {
        const packageName = definition.npmPackageName;
        assert.ok(packageName);
        const canonicalPath = `${installRoot}/lib/node_modules/${packageName}/bin/droid`;
        const capabilities = resolvePackageManagedProviderMaintenance(definition, {
          platform: "darwin",
          binaryPath,
          realCommandPath: canonicalPath,
          canonicalInstallRoot: installRoot,
          managerExecutablePath: "/usr/local/bin/npm",
          realManagerExecutablePath: "/usr/local/bin/npm",
          packageChannelEvidence: latestPackageChannel(
            "0.175.1",
            `${installRoot}/lib/node_modules/${packageName}/package.json`,
          ),
        });

        assert.strictEqual(capabilities.packageName, packageName);
        assert.ok(capabilities.update);
        assert.strictEqual(capabilities.update.executable, "/usr/local/bin/npm");
        assert.deepStrictEqual(capabilities.update.args, [
          "install",
          "-g",
          "--prefix",
          installRoot,
          `${packageName}@latest`,
        ]);
        assert.strictEqual(capabilities.update.lockKey, "npm-global:/Users/test/.npm");
      }
    });

    it("updates npm-managed Kilo through its matching package manager and PATH", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.kilo;
      assert.ok(definition);
      const installRoot = "/Users/test/.nvm/versions/node/v24.13.0";
      const binaryPath = `${installRoot}/bin/kilo`;
      const canonicalPath = `${installRoot}/lib/node_modules/@kilocode/cli/bin/kilo`;

      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        platform: "darwin",
        binaryPath,
        realCommandPath: canonicalPath,
        canonicalInstallRoot: installRoot,
        managerExecutablePath: `${installRoot}/bin/npm`,
        realManagerExecutablePath: `${installRoot}/bin/npm`,
        packageChannelEvidence: latestPackageChannel(
          "7.4.11",
          `${installRoot}/lib/node_modules/@kilocode/cli/package.json`,
        ),
      });

      assert.ok(capabilities.update);
      assert.strictEqual(capabilities.update.executable, `${installRoot}/bin/npm`);
      assert.deepStrictEqual(capabilities.update.args, [
        "install",
        "-g",
        "--prefix",
        installRoot,
        "@kilocode/cli@latest",
      ]);
      assert.strictEqual(
        capabilities.update.lockKey,
        "npm-global:/Users/test/.nvm/versions/node/v24.13.0",
      );
    });

    it.effect("reports an already-current CLI without claiming a replacement", () =>
      withIsolatedProviderCommands(["npm"], (fixture) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const previousFetch = globalThis.fetch;
            globalThis.fetch = makeFetchMock(() =>
              Promise.resolve(
                new Response(JSON.stringify({ version: "7.4.10" }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
            return previousFetch;
          }),
          () =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const baseDir = yield* fileSystem.makeTempDirectoryScoped({
                prefix: "provider-update-already-current-",
              });
              const npmPrefix = NodePath.join(baseDir, "nvm");
              const kiloBinaryPath = NodePath.join(
                npmPrefix,
                "lib",
                "node_modules",
                "@kilocode",
                "cli",
                "bin",
                "kilo",
              );
              yield* writeLatestKiloPackageFixture({
                fileSystem,
                binaryPath: kiloBinaryPath,
                version: "7.4.10",
              });
              yield* writeProviderStatusCache({
                filePath: resolveProviderStatusCachePath({
                  stateDir: NodePath.join(baseDir, "userdata"),
                  provider: "kilo",
                }),
                provider: {
                  provider: "kilo",
                  status: "ready",
                  available: true,
                  authStatus: "unknown",
                  checkedAt: "2026-07-20T12:00:00.000Z",
                  message:
                    "Kilo CLI is installed. Configure provider credentials inside Kilo as needed.",
                  version: "7.4.10",
                },
              });
              const settings = {
                ...allProvidersDisabledServerSettings,
                providers: {
                  ...allProvidersDisabledServerSettings.providers,
                  kilo: {
                    ...DEFAULT_SERVER_SETTINGS.providers.kilo,
                    enabled: true,
                    binaryPath: kiloBinaryPath,
                  },
                },
              } satisfies typeof DEFAULT_SERVER_SETTINGS;
              let updateSpawnCount = 0;
              const layer = makeProviderHealthLive({
                processTreeKiller: syntheticProcessTreeKiller(1),
              }).pipe(
                Layer.provideMerge(providerServiceWithoutRuntimesLayer),
                Layer.provideMerge(ServerSettingsService.layerTest(settings)),
                Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
                Layer.provideMerge(
                  mockSpawnerLayer((args, command, env, options) => {
                    if (
                      preparedProviderCommandMatches({
                        fixture,
                        executable: fixtureExecutablePath(fixture, "npm"),
                        expectedArgs: [
                          "install",
                          "-g",
                          "--prefix",
                          npmPrefix,
                          "@kilocode/cli@latest",
                        ],
                        command,
                        actualArgs: args,
                        env,
                        options,
                      })
                    ) {
                      updateSpawnCount += 1;
                      return { stdout: "already up to date\n", stderr: "", code: 0 };
                    }
                    return { stdout: "kilo 7.4.10\n", stderr: "", code: 0 };
                  }),
                ),
              );

              const result = yield* Effect.gen(function* () {
                const providerHealth = yield* ProviderHealth;
                return yield* providerHealth.updateProvider({ provider: "kilo" });
              }).pipe(Effect.provide(layer));
              const kilo = result.providers.find((provider) => provider.provider === "kilo");

              assert.strictEqual(updateSpawnCount, 0);
              assert.strictEqual(kilo?.version, "7.4.10");
              assert.strictEqual(kilo?.versionAdvisory?.status, "current");
              assert.strictEqual(kilo?.updateState?.status, "already_current");
              assert.strictEqual(
                kilo?.updateState?.message,
                "Provider CLI is already current; no update command was run.",
              );
            }),
          (previousFetch) =>
            Effect.sync(() => {
              globalThis.fetch = previousFetch;
            }),
        ),
      ),
    );

    it.effect("commits the exact current preflight without a second full refresh", () =>
      withKiloUpdateFixture("7.4.10", (input) =>
        withLatestNpmVersion(
          "7.4.10",
          Effect.gen(function* () {
            let healthProbeCount = 0;
            let updateSpawnCount = 0;
            const layer = makeProviderHealthLive({
              providerUpdateTimeoutMs: 10_000,
              processTreeKiller: syntheticProcessTreeKiller(201),
            }).pipe(
              Layer.provideMerge(providerServiceWithoutRuntimesLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
              Layer.provideMerge(
                effectSpawnerLayer((args, command, env, options) => {
                  if (
                    preparedProviderCommandMatches({
                      fixture: input.fixture,
                      executable: fixtureExecutablePath(input.fixture, "npm"),
                      expectedArgs: [
                        "install",
                        "-g",
                        "--prefix",
                        input.npmPrefix,
                        "@kilocode/cli@latest",
                      ],
                      command,
                      actualArgs: args,
                      env,
                      options,
                    })
                  ) {
                    updateSpawnCount += 1;
                    return Effect.succeed(
                      mockHandle({ stdout: "unexpected update\n", stderr: "", code: 0 }),
                    );
                  }
                  healthProbeCount += 1;
                  return healthProbeCount === 1
                    ? Effect.succeed(mockHandle({ stdout: "kilo 7.4.10\n", stderr: "", code: 0 }))
                    : Effect.never;
                }),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              return yield* TestClock.withLive(providerHealth.updateProvider({ provider: "kilo" }));
            }).pipe(Effect.provide(layer));
            const kilo = result.providers.find((status) => status.provider === "kilo");
            const persisted = yield* readProviderStatusCache(input.cachePath);

            assert.strictEqual(healthProbeCount, 1);
            assert.strictEqual(updateSpawnCount, 0);
            assert.strictEqual(kilo?.updateState?.status, "already_current");
            assert.strictEqual(kilo?.version, "7.4.10");
            assert.strictEqual(kilo?.versionAdvisory?.status, "current");
            assert.strictEqual(persisted?.version, "7.4.10");
            assert.strictEqual(persisted?.versionAdvisory?.status, "current");
          }),
        ),
      ),
    );

    it.effect("rejects an already-current preflight when settings drift before the decision", () =>
      withKiloUpdateFixture("7.4.10", (input) =>
        Effect.gen(function* () {
          const fetchStarted = yield* Deferred.make<void>();
          const releaseFetch = yield* Deferred.make<void>();
          const previousFetch = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = globalThis.fetch;
              globalThis.fetch = makeFetchMock(() =>
                Effect.runPromise(
                  Deferred.succeed(fetchStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFetch)),
                    Effect.as(
                      new Response(JSON.stringify({ version: "7.4.10" }), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                      }),
                    ),
                  ),
                ),
              );
              return previous;
            }),
            (previous) =>
              Effect.sync(() => {
                globalThis.fetch = previous;
              }),
          );
          void previousFetch;
          let updateSpawnCount = 0;
          const layer = makeProviderHealthLive({
            processTreeKiller: syntheticProcessTreeKiller(202),
          }).pipe(
            Layer.provideMerge(providerServiceWithoutRuntimesLayer),
            Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
            Layer.provideMerge(
              mockSpawnerLayer((args) => {
                if (args.includes("install") && args.includes("@kilocode/cli@latest")) {
                  updateSpawnCount += 1;
                }
                return { stdout: "kilo 7.4.10\n", stderr: "", code: 0 };
              }),
            ),
          );

          const result = yield* Effect.gen(function* () {
            const providerHealth = yield* ProviderHealth;
            const settings = yield* ServerSettingsService;
            const update = yield* providerHealth
              .updateProvider({ provider: "kilo" })
              .pipe(Effect.forkChild);
            yield* Deferred.await(fetchStarted);
            yield* settings.updateSettings({
              providers: { kilo: { serverUrl: "http://127.0.0.1:62001" } },
            });
            yield* Deferred.succeed(releaseFetch, undefined);
            return yield* Fiber.join(update);
          }).pipe(Effect.provide(layer));
          const kilo = result.providers.find((status) => status.provider === "kilo");
          const persisted = yield* readProviderStatusCache(input.cachePath);

          assert.strictEqual(updateSpawnCount, 0);
          assert.strictEqual(kilo?.updateState?.status, "failed");
          assert.match(kilo?.updateState?.message ?? "", /changed during pre-update verification/u);
          assert.notStrictEqual(kilo?.versionAdvisory?.status, "current");
          assert.strictEqual(persisted?.versionAdvisory, undefined);
        }),
      ),
    );

    it.effect(
      "marks a successful command unverified when settings drift during the post probe",
      () =>
        withKiloUpdateFixture("7.4.10", (input) =>
          Effect.gen(function* () {
            const postFetchStarted = yield* Deferred.make<void>();
            const releasePostFetch = yield* Deferred.make<void>();
            let fetchCount = 0;
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const previous = globalThis.fetch;
                globalThis.fetch = makeFetchMock(() => {
                  fetchCount += 1;
                  const response = new Response(JSON.stringify({ version: "7.4.11" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  });
                  return fetchCount === 1
                    ? Promise.resolve(response)
                    : Effect.runPromise(
                        Deferred.succeed(postFetchStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(releasePostFetch)),
                          Effect.as(response),
                        ),
                      );
                });
                return previous;
              }),
              (previous) =>
                Effect.sync(() => {
                  globalThis.fetch = previous;
                }),
            );
            let updaterCompleted = false;
            let updateSpawnCount = 0;
            const layer = makeProviderHealthLive({
              processTreeKiller: syntheticProcessTreeKiller(203),
            }).pipe(
              Layer.provideMerge(providerServiceWithoutRuntimesLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
              Layer.provideMerge(
                mockSpawnerLayer((args, command, env, options) => {
                  if (
                    preparedProviderCommandMatches({
                      fixture: input.fixture,
                      executable: fixtureExecutablePath(input.fixture, "npm"),
                      expectedArgs: [
                        "install",
                        "-g",
                        "--prefix",
                        input.npmPrefix,
                        "@kilocode/cli@latest",
                      ],
                      command,
                      actualArgs: args,
                      env,
                      options,
                    })
                  ) {
                    updateSpawnCount += 1;
                    updaterCompleted = true;
                    return { stdout: "updated\n", stderr: "", code: 0 };
                  }
                  return {
                    stdout: updaterCompleted ? "kilo 7.4.11\n" : "kilo 7.4.10\n",
                    stderr: "",
                    code: 0,
                  };
                }),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              const settings = yield* ServerSettingsService;
              const update = yield* providerHealth
                .updateProvider({ provider: "kilo" })
                .pipe(Effect.forkChild);
              yield* Deferred.await(postFetchStarted);
              yield* settings.updateSettings({
                providers: { kilo: { serverUrl: "http://127.0.0.1:62002" } },
              });
              yield* Deferred.succeed(releasePostFetch, undefined);
              return yield* Fiber.join(update);
            }).pipe(Effect.provide(layer));
            const kilo = result.providers.find((status) => status.provider === "kilo");
            const persisted = yield* readProviderStatusCache(input.cachePath);

            assert.strictEqual(fetchCount, 2);
            assert.strictEqual(updateSpawnCount, 1);
            assert.strictEqual(kilo?.updateState?.status, "unverified");
            assert.match(kilo?.updateState?.message ?? "", /target changed before verification/u);
            assert.strictEqual(kilo?.version, "7.4.10");
            assert.strictEqual(kilo?.versionAdvisory?.status, "behind_latest");
            assert.strictEqual(persisted?.version, "7.4.10");
            assert.strictEqual(persisted?.versionAdvisory?.status, "behind_latest");
          }),
        ),
    );

    it.effect("returns and persists the exact post-probe version and advisory", () =>
      withKiloUpdateFixture("7.4.10", (input) =>
        withLatestNpmVersion(
          "7.4.11",
          Effect.gen(function* () {
            let updaterCompleted = false;
            let healthProbeCount = 0;
            let updateSpawnCount = 0;
            let updaterExternallySupervised = false;
            let updaterOutputConsumed = false;
            let updaterRunning = true;
            const updaterExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            const initialLivenessChecked = yield* Deferred.make<void>();
            let releaseInitialCapture!: () => void;
            let markInitialCaptureStarted!: () => void;
            const initialCaptureStarted = new Promise<void>((resolve) => {
              markInitialCaptureStarted = resolve;
            });
            const updaterRoot = {
              pid: 1,
              command: "provider-updater-fixture",
              identity: "1:provider-updater-fixture",
            };
            const capturedUpdaterTree = {
              root: updaterRoot,
              descendants: [],
              captureComplete: true,
            };
            const initialCapture = new Promise<typeof capturedUpdaterTree>((resolve) => {
              releaseInitialCapture = () => resolve(capturedUpdaterTree);
            });
            let captureCount = 0;
            const processTreeKiller: ProcessTreeKiller = {
              capture: () => capturedUpdaterTree,
              captureAsync: () => {
                captureCount += 1;
                if (captureCount === 1) {
                  markInitialCaptureStarted();
                  return initialCapture;
                }
                return Promise.resolve(capturedUpdaterTree);
              },
              inspect: () => ({ verified: true, survivors: [] }),
              signal: () => {},
            };
            const updaterHandle = ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(updaterRoot.pid),
              exitCode: Deferred.await(updaterExit),
              isRunning: Effect.sync(() => {
                Deferred.doneUnsafe(initialLivenessChecked, Effect.void);
                return updaterRunning;
              }),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.fromEffect(
                Effect.sync(() => {
                  updaterOutputConsumed = true;
                  return encoder.encode("updated\n");
                }),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
            const layer = makeProviderHealthLive({
              ...TEST_REAL_PROVIDER_PROCESS_OPTIONS,
              providerUpdateTimeoutMs: 10_000,
              processTreeKiller,
            }).pipe(
              Layer.provideMerge(providerServiceWithoutRuntimesLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
              Layer.provideMerge(
                effectSpawnerLayer((args, command, env, options) => {
                  if (
                    preparedProviderCommandMatches({
                      fixture: input.fixture,
                      executable: fixtureExecutablePath(input.fixture, "npm"),
                      expectedArgs: [
                        "install",
                        "-g",
                        "--prefix",
                        input.npmPrefix,
                        "@kilocode/cli@latest",
                      ],
                      command,
                      actualArgs: args,
                      env,
                      options,
                    })
                  ) {
                    updateSpawnCount += 1;
                    updaterExternallySupervised = options?.synaraExternallySupervised === true;
                    updaterCompleted = true;
                    return Effect.succeed(updaterHandle);
                  }
                  healthProbeCount += 1;
                  return healthProbeCount <= 2
                    ? Effect.succeed(
                        mockHandle({
                          stdout: updaterCompleted ? "kilo 7.4.11\n" : "kilo 7.4.10\n",
                          stderr: "",
                          code: 0,
                        }),
                      )
                    : Effect.never;
                }),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              return yield* TestClock.withLive(
                Effect.gen(function* () {
                  const update = yield* providerHealth
                    .updateProvider({ provider: "kilo" })
                    .pipe(Effect.forkChild);
                  yield* Effect.promise(() => initialCaptureStarted);
                  yield* Effect.promise(
                    () => new Promise<void>((resolve) => setImmediate(resolve)),
                  );
                  const outputConsumedBeforeCapture = updaterOutputConsumed;
                  releaseInitialCapture();
                  yield* Deferred.await(initialLivenessChecked);
                  yield* Effect.promise(
                    () => new Promise<void>((resolve) => setImmediate(resolve)),
                  );
                  updaterRunning = false;
                  yield* Deferred.succeed(updaterExit, ChildProcessSpawner.ExitCode(0));
                  const updateResult = yield* Fiber.join(update);
                  return { updateResult, outputConsumedBeforeCapture };
                }),
              );
            }).pipe(Effect.provide(layer));
            const kilo = result.updateResult.providers.find((status) => status.provider === "kilo");
            const persisted = yield* readProviderStatusCache(input.cachePath);

            assert.strictEqual(
              kilo?.updateState?.status,
              "succeeded",
              kilo?.updateState?.message ?? "missing update state",
            );
            assert.strictEqual(healthProbeCount, 2);
            assert.strictEqual(updateSpawnCount, 1);
            assert.strictEqual(updaterExternallySupervised, false);
            assert.strictEqual(result.outputConsumedBeforeCapture, false);
            assert.strictEqual(kilo?.version, "7.4.11");
            assert.strictEqual(kilo?.versionAdvisory?.status, "current");
            assert.strictEqual(kilo?.versionAdvisory?.currentVersion, "7.4.11");
            assert.strictEqual(kilo?.versionAdvisory?.latestVersion, "7.4.11");
            assert.strictEqual(persisted?.version, kilo?.version);
            assert.deepStrictEqual(persisted?.versionAdvisory, kilo?.versionAdvisory);
          }),
        ),
      ),
    );

    it.effect("fails closed when the updater exits before its initial ownership capture", () =>
      withKiloUpdateFixture("7.4.10", (input) =>
        withLatestNpmVersion(
          "7.4.11",
          Effect.gen(function* () {
            let updateSpawnCount = 0;
            let updaterExternallySupervised = false;
            let fallbackTeardownCalls = 0;
            let promotedSupervisorTeardownCalls = 0;
            const processTreeKiller: ProcessTreeKiller = {
              capture: () => ({ descendants: [], captureComplete: true }),
              captureAsync: async () => ({ descendants: [], captureComplete: true }),
              inspect: () => ({ verified: true, survivors: [] }),
              signal: () => {},
            };
            const layer = makeProviderHealthLive({
              ...TEST_REAL_PROVIDER_PROCESS_OPTIONS,
              providerUpdateTimeoutMs: 10_000,
              processTreeKiller,
              teardownProcessTree: (teardown) => {
                if (teardown.capturedTree === undefined) {
                  fallbackTeardownCalls += 1;
                  assert.strictEqual(
                    teardown.ownedProcessGroupId,
                    process.platform === "win32" ? undefined : teardown.rootPid,
                  );
                } else {
                  promotedSupervisorTeardownCalls += 1;
                }
                return Promise.resolve({ escalated: false, signalErrors: [] });
              },
            }).pipe(
              Layer.provideMerge(providerServiceWithoutRuntimesLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
              Layer.provideMerge(
                effectSpawnerLayer((args, command, env, options) => {
                  if (
                    preparedProviderCommandMatches({
                      fixture: input.fixture,
                      executable: fixtureExecutablePath(input.fixture, "npm"),
                      expectedArgs: [
                        "install",
                        "-g",
                        "--prefix",
                        input.npmPrefix,
                        "@kilocode/cli@latest",
                      ],
                      command,
                      actualArgs: args,
                      env,
                      options,
                    })
                  ) {
                    updateSpawnCount += 1;
                    updaterExternallySupervised = options?.synaraExternallySupervised === true;
                    return Effect.succeed(mockHandle({ stdout: "updated\n", stderr: "", code: 0 }));
                  }
                  return Effect.succeed(
                    mockHandle({ stdout: "kilo 7.4.10\n", stderr: "", code: 0 }),
                  );
                }),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              return yield* TestClock.withLive(providerHealth.updateProvider({ provider: "kilo" }));
            }).pipe(Effect.provide(layer));
            const kilo = result.providers.find((status) => status.provider === "kilo");

            assert.strictEqual(updateSpawnCount, 1);
            assert.strictEqual(updaterExternallySupervised, false);
            assert.strictEqual(fallbackTeardownCalls, 0);
            assert.strictEqual(promotedSupervisorTeardownCalls, 1);
            assert.strictEqual(kilo?.updateState?.status, "failed");
            assert.match(kilo?.updateState?.message ?? "", /did not prove exit/u);
            assert.match(kilo?.updateState?.message ?? "", /Restart Synara/u);
            assert.strictEqual(kilo?.version, "7.4.10");
          }),
        ),
      ),
    );

    it.effect("does not let an older refresh overwrite exact post-update evidence", () =>
      withKiloUpdateFixture("7.4.10", (input) =>
        Effect.gen(function* () {
          const normalFetchStarted = yield* Deferred.make<void>();
          const releaseNormalFetch = yield* Deferred.make<void>();
          let fetchCount = 0;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = globalThis.fetch;
              globalThis.fetch = makeFetchMock(() => {
                fetchCount += 1;
                const response = new Response(JSON.stringify({ version: "7.4.11" }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                });
                return fetchCount === 1
                  ? Effect.runPromise(
                      Deferred.succeed(normalFetchStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseNormalFetch)),
                        Effect.as(response),
                      ),
                    )
                  : Promise.resolve(response);
              });
              return previous;
            }),
            (previous) =>
              Effect.sync(() => {
                globalThis.fetch = previous;
              }),
          );

          let updaterCompleted = false;
          let healthProbeCount = 0;
          let updateSpawnCount = 0;
          const layer = makeProviderHealthLive({
            providerUpdateTimeoutMs: 10_000,
            processTreeKiller: syntheticProcessTreeKiller(205),
          }).pipe(
            Layer.provideMerge(providerServiceWithoutRuntimesLayer),
            Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
            Layer.provideMerge(
              effectSpawnerLayer((args, command, env, options) => {
                if (
                  preparedProviderCommandMatches({
                    fixture: input.fixture,
                    executable: fixtureExecutablePath(input.fixture, "npm"),
                    expectedArgs: [
                      "install",
                      "-g",
                      "--prefix",
                      input.npmPrefix,
                      "@kilocode/cli@latest",
                    ],
                    command,
                    actualArgs: args,
                    env,
                    options,
                  })
                ) {
                  updateSpawnCount += 1;
                  updaterCompleted = true;
                  return Effect.succeed(mockHandle({ stdout: "updated\n", stderr: "", code: 0 }));
                }
                healthProbeCount += 1;
                return Effect.succeed(
                  mockHandle({
                    stdout: updaterCompleted ? "kilo 7.4.11\n" : "kilo 7.4.10\n",
                    stderr: "",
                    code: 0,
                  }),
                );
              }),
            ),
          );

          yield* TestClock.setTime(new Date("2099-01-01T00:00:00.000Z").getTime());
          const result = yield* Effect.gen(function* () {
            const providerHealth = yield* ProviderHealth;
            const refreshFiber = yield* providerHealth.refresh.pipe(Effect.forkChild);
            yield* Deferred.await(normalFetchStarted);
            const update = yield* providerHealth.updateProvider({ provider: "kilo" });
            yield* Deferred.succeed(releaseNormalFetch, undefined);
            const refresh = yield* Fiber.join(refreshFiber);
            const current = yield* providerHealth.getStatuses;
            return { update, refresh, current };
          }).pipe(Effect.provide(layer));

          const updateKilo = result.update.providers.find((status) => status.provider === "kilo");
          const refreshKilo = result.refresh.find((status) => status.provider === "kilo");
          const currentKilo = result.current.find((status) => status.provider === "kilo");
          const persisted = yield* readProviderStatusCache(input.cachePath);

          assert.strictEqual(fetchCount, 3);
          assert.strictEqual(healthProbeCount, 3);
          assert.strictEqual(updateSpawnCount, 1);
          for (const status of [updateKilo, refreshKilo, currentKilo]) {
            assert.strictEqual(status?.version, "7.4.11");
            assert.strictEqual(status?.versionAdvisory?.status, "current");
            assert.strictEqual(status?.versionAdvisory?.currentVersion, "7.4.11");
            assert.strictEqual(status?.versionAdvisory?.latestVersion, "7.4.11");
            assert.strictEqual(status?.updateState?.status, "succeeded");
          }
          assert.strictEqual(persisted?.version, "7.4.11");
          assert.strictEqual(persisted?.versionAdvisory?.status, "current");
          assert.strictEqual(persisted?.versionAdvisory?.currentVersion, "7.4.11");
          assert.strictEqual(persisted?.versionAdvisory?.latestVersion, "7.4.11");
        }),
      ),
    );

    it.effect("fails when an exit-zero update leaves the configured binary unavailable", () =>
      withIsolatedProviderCommands(["npm"], (fixture) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const previousFetch = globalThis.fetch;
            globalThis.fetch = makeFetchMock(() =>
              Promise.resolve(
                new Response(JSON.stringify({ version: "7.4.11" }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
            return previousFetch;
          }),
          () =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const baseDir = yield* fileSystem.makeTempDirectoryScoped({
                prefix: "provider-update-binary-unavailable-",
              });
              const npmPrefix = NodePath.join(baseDir, "nvm");
              const kiloBinaryPath = NodePath.join(
                npmPrefix,
                "lib",
                "node_modules",
                "@kilocode",
                "cli",
                "bin",
                "kilo",
              );
              yield* writeLatestKiloPackageFixture({
                fileSystem,
                binaryPath: kiloBinaryPath,
                version: "7.4.10",
              });
              const settings = {
                ...allProvidersDisabledServerSettings,
                providers: {
                  ...allProvidersDisabledServerSettings.providers,
                  kilo: {
                    ...DEFAULT_SERVER_SETTINGS.providers.kilo,
                    enabled: true,
                    binaryPath: kiloBinaryPath,
                  },
                },
              } satisfies typeof DEFAULT_SERVER_SETTINGS;
              let updateSpawnCount = 0;
              let updaterCompleted = false;
              const layer = makeProviderHealthLive({
                processTreeKiller: syntheticProcessTreeKiller(101),
              }).pipe(
                Layer.provideMerge(providerServiceWithoutRuntimesLayer),
                Layer.provideMerge(ServerSettingsService.layerTest(settings)),
                Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
                Layer.provideMerge(
                  mockSpawnerLayer((args, command, env, options) => {
                    if (
                      preparedProviderCommandMatches({
                        fixture,
                        executable: fixtureExecutablePath(fixture, "npm"),
                        expectedArgs: [
                          "install",
                          "-g",
                          "--prefix",
                          npmPrefix,
                          "@kilocode/cli@latest",
                        ],
                        command,
                        actualArgs: args,
                        env,
                        options,
                      })
                    ) {
                      updateSpawnCount += 1;
                      updaterCompleted = true;
                      return { stdout: "update completed\n", stderr: "", code: 0 };
                    }
                    return updaterCompleted
                      ? { stdout: "", stderr: "configured binary is missing\n", code: 1 }
                      : { stdout: "kilo 7.4.10\n", stderr: "", code: 0 };
                  }),
                ),
              );

              const result = yield* Effect.gen(function* () {
                const providerHealth = yield* ProviderHealth;
                return yield* providerHealth.updateProvider({ provider: "kilo" });
              }).pipe(Effect.provide(layer));
              const kilo = result.providers.find((provider) => provider.provider === "kilo");

              assert.strictEqual(updateSpawnCount, 1);
              assert.strictEqual(kilo?.updateState?.status, "failed");
              assert.match(
                kilo?.updateState?.message ?? "",
                /configured provider binary is unavailable/u,
              );
            }),
          (previousFetch) =>
            Effect.sync(() => {
              globalThis.fetch = previousFetch;
            }),
        ),
      ),
    );

    it.effect("stops a hung provider process and persists a failed update state", () =>
      withIsolatedProviderCommands(["npm"], (fixture) =>
        withLatestNpmVersion(
          "7.4.11",
          Effect.gen(function* () {
            let killed = false;
            const updaterSpawned = yield* Deferred.make<void>();
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const baseDir = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "provider-update-timeout-",
            });
            const npmPrefix = path.join(baseDir, "nvm");
            const kiloBinaryPath = path.join(
              npmPrefix,
              "lib",
              "node_modules",
              "@kilocode",
              "cli",
              "bin",
              "kilo",
            );
            yield* writeLatestKiloPackageFixture({
              fileSystem,
              binaryPath: kiloBinaryPath,
              version: "7.3.46",
            });
            yield* writeProviderStatusCache({
              filePath: resolveProviderStatusCachePath({
                stateDir: path.join(baseDir, "userdata"),
                provider: "kilo",
              }),
              provider: {
                provider: "kilo",
                status: "ready",
                available: true,
                authStatus: "authenticated",
                checkedAt: "2026-07-15T12:00:00.000Z",
                message: "Kilo CLI is installed and authenticated.",
                version: "7.3.46",
              },
            });
            const settings = {
              ...allProvidersDisabledServerSettings,
              providers: {
                ...allProvidersDisabledServerSettings.providers,
                kilo: {
                  ...DEFAULT_SERVER_SETTINGS.providers.kilo,
                  enabled: true,
                  binaryPath: kiloBinaryPath,
                },
              },
            } satisfies typeof DEFAULT_SERVER_SETTINGS;
            const layer = makeProviderHealthLive({
              ...TEST_REAL_PROVIDER_PROCESS_OPTIONS,
              providerUpdateTimeoutMs: 2_000,
              processTreeKiller: syntheticProcessTreeKiller(2),
              teardownProcessTree: () => {
                killed = true;
                return Promise.resolve({ escalated: false, signalErrors: [] });
              },
            }).pipe(
              Layer.provideMerge(providerServiceWithoutRuntimesLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
              Layer.provideMerge(
                hangingSpawnerLayer({
                  onKill: () => (killed = true),
                  onSpawn: Deferred.succeed(updaterSpawned, undefined),
                  shouldHang: (args, command, env, options) =>
                    preparedProviderCommandMatches({
                      fixture,
                      executable: fixtureExecutablePath(fixture, "npm"),
                      expectedArgs: [
                        "install",
                        "-g",
                        "--prefix",
                        npmPrefix,
                        "@kilocode/cli@latest",
                      ],
                      command,
                      actualArgs: args,
                      env,
                      options,
                    }),
                }),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              const update = yield* providerHealth
                .updateProvider({ provider: "kilo" })
                .pipe(Effect.forkChild);
              yield* Deferred.await(updaterSpawned);
              yield* TestClock.adjust(2_000);
              return yield* Fiber.join(update);
            }).pipe(Effect.provide(layer));
            const kilo = result.providers.find((provider) => provider.provider === "kilo");

            assert.strictEqual(killed, true, kilo?.updateState?.message ?? "missing update state");
            assert.strictEqual(kilo?.updateState?.status, "failed");
            assert.strictEqual(
              kilo?.updateState?.message,
              "Update job timed out after 2 seconds. It was canceled, and any spawned updater process tree was stopped before provider access resumed.",
            );
          }),
        ),
      ),
    );

    it.effect("refuses an update without spawning the updater when provider work is active", () =>
      withIsolatedProviderCommands(["npm"], () =>
        withLatestNpmVersion(
          "7.4.11",
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const baseDir = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "provider-update-active-runtime-",
            });
            const npmPrefix = NodePath.join(baseDir, "nvm");
            const kiloBinaryPath = NodePath.join(
              npmPrefix,
              "lib",
              "node_modules",
              "@kilocode",
              "cli",
              "bin",
              "kilo",
            );
            yield* writeLatestKiloPackageFixture({
              fileSystem,
              binaryPath: kiloBinaryPath,
              version: "7.4.10",
            });
            const settings = {
              ...allProvidersDisabledServerSettings,
              providers: {
                ...allProvidersDisabledServerSettings.providers,
                kilo: {
                  ...DEFAULT_SERVER_SETTINGS.providers.kilo,
                  enabled: true,
                  binaryPath: kiloBinaryPath,
                },
              },
            } satisfies typeof DEFAULT_SERVER_SETTINGS;
            yield* writeProviderStatusCache({
              filePath: resolveProviderStatusCachePath({
                stateDir: NodePath.join(baseDir, "userdata"),
                provider: "kilo",
              }),
              provider: {
                provider: "kilo",
                status: "ready",
                available: true,
                authStatus: "authenticated",
                checkedAt: "2026-07-20T12:00:00.000Z",
                message: "Kilo CLI is installed and authenticated.",
                version: "7.4.10",
              },
            });
            let updateSpawnCount = 0;
            const activeSession = {
              provider: "kilo" as const,
              status: "running" as const,
              runtimeMode: "full-access" as const,
              threadId: "00000000-0000-4000-8000-000000000001" as never,
              activeTurnId: "00000000-0000-4000-8000-000000000002" as never,
              createdAt: "2026-07-20T12:00:00.000Z",
              updatedAt: "2026-07-20T12:00:00.000Z",
            };
            const activeProviderServiceLayer = Layer.succeed(ProviderService, {
              listSessions: () => Effect.succeed([activeSession]),
              stopRuntimeSession: () => Effect.void,
              hasLiveRuntimeTasks: () => Effect.succeed(false),
            } as unknown as ProviderServiceShape);
            const layer = ProviderHealthLive.pipe(
              Layer.provideMerge(activeProviderServiceLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
              Layer.provideMerge(
                mockSpawnerLayer((args) => {
                  if (args.includes("install") && args.includes("@kilocode/cli@latest")) {
                    updateSpawnCount += 1;
                  }
                  return { stdout: "kilo 7.4.10", stderr: "", code: 0 };
                }),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              return yield* providerHealth.updateProvider({ provider: "kilo" });
            }).pipe(Effect.provide(layer));
            const kilo = result.providers.find((provider) => provider.provider === "kilo");

            assert.strictEqual(updateSpawnCount, 0);
            assert.strictEqual(kilo?.updateState?.status, "failed");
            assert.match(
              kilo?.updateState?.message ?? "",
              /process ownership cannot be proven safely/u,
            );
          }),
        ),
      ),
    );

    it.effect("latches provider access when runtime shutdown cannot prove process-tree exit", () =>
      withIsolatedProviderCommands(["npm"], () =>
        withLatestNpmVersion(
          "7.4.11",
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const baseDir = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "provider-update-unproven-runtime-exit-",
            });
            const npmPrefix = NodePath.join(baseDir, "nvm");
            const kiloBinaryPath = NodePath.join(
              npmPrefix,
              "lib",
              "node_modules",
              "@kilocode",
              "cli",
              "bin",
              "kilo",
            );
            yield* writeLatestKiloPackageFixture({
              fileSystem,
              binaryPath: kiloBinaryPath,
              version: "7.4.10",
            });
            const settings = {
              ...allProvidersDisabledServerSettings,
              providers: {
                ...allProvidersDisabledServerSettings.providers,
                kilo: {
                  ...DEFAULT_SERVER_SETTINGS.providers.kilo,
                  enabled: true,
                  binaryPath: kiloBinaryPath,
                },
              },
            } satisfies typeof DEFAULT_SERVER_SETTINGS;
            yield* writeProviderStatusCache({
              filePath: resolveProviderStatusCachePath({
                stateDir: NodePath.join(baseDir, "userdata"),
                provider: "kilo",
              }),
              provider: {
                provider: "kilo",
                status: "ready",
                available: true,
                authStatus: "authenticated",
                checkedAt: "2026-07-20T12:00:00.000Z",
                message: "Kilo CLI is installed and authenticated.",
                version: "7.4.10",
              },
            });
            const unprovenExit = new ProviderProcessExitUnprovenError({
              rootPid: 59_000,
              rootExited: false,
              remainingDescendantPids: [59_001],
              captureComplete: true,
            });
            const runtimeShutdownError = new Error("Local Kilo server shutdown failed.", {
              cause: unprovenExit,
            });
            const providerServiceLayer = Layer.succeed(ProviderService, {
              prepareForMaintenance: () => Effect.fail(runtimeShutdownError),
              listSessions: () => Effect.succeed([]),
              stopRuntimeSession: () => Effect.void,
              hasLiveRuntimeTasks: () => Effect.succeed(false),
            } as unknown as ProviderServiceShape);
            const maintenanceGate = yield* makeProviderMaintenanceGate;
            let updateSpawnCount = 0;
            const layer = makeProviderHealthLive({ maintenanceGate }).pipe(
              Layer.provideMerge(providerServiceLayer),
              Layer.provideMerge(ServerSettingsService.layerTest(settings)),
              Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
              Layer.provideMerge(
                mockSpawnerLayer((args) => {
                  if (args.includes("install") && args.includes("@kilocode/cli@latest")) {
                    updateSpawnCount += 1;
                  }
                  return { stdout: "kilo 7.4.10", stderr: "", code: 0 };
                }),
              ),
            );

            const result = yield* Effect.gen(function* () {
              const providerHealth = yield* ProviderHealth;
              return yield* providerHealth.updateProvider({ provider: "kilo" });
            }).pipe(Effect.provide(layer));
            const kilo = result.providers.find((provider) => provider.provider === "kilo");
            const blocked = yield* maintenanceGate
              .withOperation({
                provider: "kilo",
                operation: "session.start",
                run: Effect.void,
              })
              .pipe(Effect.flip);

            assert.strictEqual(updateSpawnCount, 0);
            assert.strictEqual(kilo?.updateState?.status, "failed");
            assert.match(kilo?.updateState?.message ?? "", /Restart Synara/u);
            assert.strictEqual(blocked.operation, "session.start");
            assert.match(blocked.message, /Restart Synara before retrying/u);
            assert.match(blocked.latchedReason ?? "", /descendants still running: 59001/u);
          }),
        ),
      ),
    );

    it.effect(
      "keeps maintenance closed until interrupted updater teardown proves exit or latches failure",
      () =>
        withIsolatedProviderCommands(["npm"], (fixture) =>
          withLatestNpmVersion(
            "7.4.11",
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const baseDir = yield* fileSystem.makeTempDirectoryScoped({
                prefix: "provider-update-interrupted-spawn-",
              });
              const npmPrefix = NodePath.join(baseDir, "nvm");
              const kiloBinaryPath = NodePath.join(
                npmPrefix,
                "lib",
                "node_modules",
                "@kilocode",
                "cli",
                "bin",
                "kilo",
              );
              yield* writeLatestKiloPackageFixture({
                fileSystem,
                binaryPath: kiloBinaryPath,
                version: "7.4.10",
              });
              yield* writeProviderStatusCache({
                filePath: resolveProviderStatusCachePath({
                  stateDir: NodePath.join(baseDir, "userdata"),
                  provider: "kilo",
                }),
                provider: {
                  provider: "kilo",
                  status: "ready",
                  available: true,
                  authStatus: "authenticated",
                  checkedAt: "2026-07-20T12:00:00.000Z",
                  message: "Kilo CLI is installed and authenticated.",
                  version: "7.4.10",
                },
              });
              const settings = {
                ...allProvidersDisabledServerSettings,
                providers: {
                  ...allProvidersDisabledServerSettings.providers,
                  kilo: {
                    ...DEFAULT_SERVER_SETTINGS.providers.kilo,
                    enabled: true,
                    binaryPath: kiloBinaryPath,
                  },
                },
              } satisfies typeof DEFAULT_SERVER_SETTINGS;

              const rootPid = 73;
              const root = {
                pid: rootPid,
                command: "npm install @kilocode/cli@latest",
                identity: `${rootPid}:owned-updater-root`,
              };
              // The mock has created its child before publishing spawnSucceeded, then holds the
              // acquisition result so interruption targets the spawn-to-finalizer handoff exactly.
              const spawnSucceeded = yield* Deferred.make<void>();
              const releaseSpawnResult = yield* Deferred.make<void>();
              let markTeardownStarted!: () => void;
              const teardownStarted = new Promise<void>((resolve) => {
                markTeardownStarted = resolve;
              });
              let rejectTeardownProof!: (error: ProviderProcessExitUnprovenError) => void;
              const teardownProof = new Promise<never>((_resolve, reject) => {
                rejectTeardownProof = reject;
              });
              const updaterExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
              const maintenanceGate = yield* makeProviderMaintenanceGate;
              const maintenanceOwnedResources =
                yield* makeProviderMaintenanceOwnedResourceCoordinator;
              let updaterRunning = true;
              let captureCount = 0;
              let teardownAttempts = 0;
              let teardownRootPid: number | undefined;
              let teardownCapturedRootIdentity: string | undefined;
              let concurrentOperationEntered = false;
              const spawnedCommands: string[] = [];

              const processTreeKiller: ProcessTreeKiller = {
                capture: () => {
                  captureCount += 1;
                  return { root, descendants: [], captureComplete: true };
                },
                inspect: () => ({ verified: true, survivors: [] }),
                signal: () => {},
              };
              const updaterHandle = ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(rootPid),
                exitCode: Deferred.await(updaterExit),
                isRunning: Effect.sync(() => updaterRunning),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: Stream.never,
                stderr: Stream.never,
                all: Stream.never,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.never,
              });
              const spawnerLayer = Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((command) => {
                  const cmd = command as unknown as {
                    command: string;
                    args: ReadonlyArray<string>;
                    options?: {
                      env?: NodeJS.ProcessEnv;
                      windowsVerbatimArguments?: boolean;
                    };
                  };
                  const unwrapped = unwrapContainedProviderCommand(cmd);
                  spawnedCommands.push(`${cmd.command} ${cmd.args.join(" ")}`);
                  const isUpdater = preparedProviderCommandMatches({
                    fixture,
                    executable: fixtureExecutablePath(fixture, "npm"),
                    expectedArgs: ["install", "-g", "--prefix", npmPrefix, "@kilocode/cli@latest"],
                    command: unwrapped.command,
                    actualArgs: unwrapped.args,
                    env: unwrapped.options?.env,
                    options: unwrapped.options,
                  });
                  return isUpdater
                    ? Deferred.succeed(spawnSucceeded, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseSpawnResult)),
                        Effect.as(updaterHandle),
                      )
                    : Effect.succeed(mockHandle({ stdout: "kilo 7.4.10\n", stderr: "", code: 0 }));
                }),
              );
              const layer = makeProviderHealthLive({
                ...TEST_REAL_PROVIDER_PROCESS_OPTIONS,
                maintenanceGate,
                maintenanceOwnedResources,
                processTreeKiller,
                teardownProcessTree: (input) => {
                  teardownAttempts += 1;
                  teardownRootPid = input.rootPid;
                  teardownCapturedRootIdentity = input.capturedTree?.root?.identity;
                  markTeardownStarted();
                  return teardownAttempts === 1
                    ? teardownProof
                    : Promise.resolve({ escalated: false, signalErrors: [] });
                },
              }).pipe(
                Layer.provideMerge(providerServiceWithoutRuntimesLayer),
                Layer.provideMerge(ServerSettingsService.layerTest(settings)),
                Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
                Layer.provideMerge(spawnerLayer),
              );

              yield* Effect.gen(function* () {
                const providerHealth = yield* ProviderHealth;
                const update = yield* providerHealth
                  .updateProvider({ provider: "kilo" })
                  .pipe(Effect.forkChild);
                const spawnOutcome = yield* Effect.race(
                  Effect.race(
                    Deferred.await(spawnSucceeded).pipe(Effect.as("spawned" as const)),
                    Fiber.await(update).pipe(Effect.as("update-exited" as const)),
                  ),
                  Effect.promise(
                    () =>
                      new Promise<"spawn-timeout">((resolve) =>
                        setTimeout(() => resolve("spawn-timeout"), 5_000),
                      ),
                  ),
                );
                assert.strictEqual(
                  spawnOutcome,
                  "spawned",
                  `Spawn boundary failed after: ${spawnedCommands.join(" | ")}`,
                );

                const interrupting = yield* Fiber.interrupt(update).pipe(Effect.forkChild);
                yield* Deferred.succeed(releaseSpawnResult, undefined);
                const boundaryOutcome = yield* Effect.race(
                  Effect.promise(() => teardownStarted).pipe(
                    Effect.as("teardown-started" as const),
                  ),
                  Fiber.await(interrupting).pipe(Effect.as("interrupt-completed" as const)),
                );

                assert.strictEqual(
                  boundaryOutcome,
                  "teardown-started",
                  `captureCount=${captureCount}; teardownRootPid=${String(teardownRootPid)}`,
                );
                assert.ok(captureCount > 0);
                assert.strictEqual(teardownRootPid, rootPid);
                assert.strictEqual(teardownCapturedRootIdentity, root.identity);

                const duringTeardown = yield* maintenanceGate
                  .withOperation({
                    provider: "kilo",
                    operation: "session.start",
                    run: Effect.sync(() => {
                      concurrentOperationEntered = true;
                    }),
                  })
                  .pipe(Effect.flip);
                assert.strictEqual(concurrentOperationEntered, false);
                assert.match(duringTeardown.message, /CLI is being updated/u);

                const unprovenExit = new ProviderProcessExitUnprovenError({
                  rootPid,
                  rootExited: true,
                  remainingDescendantPids: [74],
                  captureComplete: true,
                });
                updaterRunning = false;
                yield* Deferred.succeed(updaterExit, ChildProcessSpawner.ExitCode(0));
                rejectTeardownProof(unprovenExit);
                yield* Fiber.join(interrupting);

                const latched = yield* maintenanceGate
                  .withOperation({
                    provider: "kilo",
                    operation: "session.start",
                    run: Effect.void,
                  })
                  .pipe(Effect.flip);
                assert.strictEqual(latched.operation, "session.start");
                assert.match(latched.message, /Restart Synara before retrying/u);
                assert.match(latched.latchedReason ?? "", /descendants still running: 74/u);

                yield* maintenanceOwnedResources.drainProviderResources({ provider: "kilo" });
                assert.strictEqual(teardownAttempts, 2);
                assert.strictEqual(teardownRootPid, rootPid);
                assert.strictEqual(teardownCapturedRootIdentity, root.identity);
                yield* maintenanceOwnedResources.drainProviderResources({ provider: "kilo" });
                assert.strictEqual(teardownAttempts, 2);
              }).pipe(Effect.provide(layer));
            }),
          ),
        ),
    );
  });

  describe("Windows provider refresh isolation", () => {
    it.effect.skipIf(process.platform !== "win32")(
      "keeps installed, missing, and failed provider results when one probe defects",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-windows-refresh-",
          });
          const maintenanceGate = yield* makeProviderMaintenanceGate;
          const faultInjectingMaintenanceGate: ProviderMaintenanceGate = {
            ...maintenanceGate,
            withOperation: (input) =>
              input.provider === "opencode" && input.operation === "ProviderHealth.refresh"
                ? Effect.die(new Error("synthetic OpenCode health probe defect"))
                : maintenanceGate.withOperation(input),
          };
          const kiloBinaryPath = "C:\\provider-fixtures\\kilo.exe";
          const settings = {
            ...allProvidersDisabledServerSettings,
            enableProviderUpdateChecks: false,
            providers: {
              ...allProvidersDisabledServerSettings.providers,
              grok: {
                ...DEFAULT_SERVER_SETTINGS.providers.grok,
                enabled: true,
                binaryPath: "grok",
              },
              kilo: {
                ...DEFAULT_SERVER_SETTINGS.providers.kilo,
                enabled: true,
                binaryPath: kiloBinaryPath,
              },
              opencode: {
                ...DEFAULT_SERVER_SETTINGS.providers.opencode,
                enabled: true,
                binaryPath: "opencode",
              },
            },
          } satisfies typeof DEFAULT_SERVER_SETTINGS;
          let spawnCount = 0;
          const layer = makeProviderHealthLive({
            platform: "win32",
            maintenanceGate: faultInjectingMaintenanceGate,
            prepareProcess: prepareContainedWindowsProviderForTest,
          }).pipe(
            Layer.provideMerge(providerServiceWithoutRuntimesLayer),
            Layer.provideMerge(ServerSettingsService.layerTest(settings)),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provideMerge(
              mockSpawnerLayer((args, command) => {
                spawnCount += 1;
                assert.strictEqual(command.toLowerCase(), kiloBinaryPath.toLowerCase());
                assert.deepStrictEqual(args, ["--version"]);
                return { stdout: "kilo 7.4.10\n", stderr: "", code: 0 };
              }),
            ),
          );

          const result = yield* Effect.gen(function* () {
            const providerHealth = yield* ProviderHealth;
            const firstRefresh = yield* providerHealth.refresh;
            const secondRefresh = yield* providerHealth.refresh;
            const current = yield* providerHealth.getStatuses;
            return { firstRefresh, secondRefresh, current };
          }).pipe(Effect.provide(layer));

          for (const statuses of [result.firstRefresh, result.secondRefresh, result.current]) {
            assert.strictEqual(statuses.length, 10);
            const kilo = statuses.find((status) => status.provider === "kilo");
            const grok = statuses.find((status) => status.provider === "grok");
            const opencode = statuses.find((status) => status.provider === "opencode");
            assert.strictEqual(kilo?.status, "ready");
            assert.strictEqual(kilo?.available, true);
            assert.strictEqual(kilo?.version, "7.4.10");
            assert.strictEqual(grok?.status, "error");
            assert.strictEqual(grok?.available, false);
            assert.strictEqual(grok?.message, "Grok CLI (`grok`) is not installed or not on PATH.");
            assert.strictEqual(opencode?.status, "error");
            assert.strictEqual(opencode?.available, false);
            assert.strictEqual(
              opencode?.message,
              "Provider health check failed before completion. Retry to refresh its status.",
            );
            assert.strictEqual(/synthetic OpenCode/u.test(opencode?.message ?? ""), false);
          }
          assert.strictEqual(spawnCount, 2);

          for (const provider of ["grok", "kilo", "opencode"] as const) {
            const cached = yield* readProviderStatusCache(
              resolveProviderStatusCachePath({
                stateDir: path.join(baseDir, "userdata"),
                provider,
              }),
            );
            assert.strictEqual(cached?.provider, provider);
          }
        }),
    );

    it.effect.skipIf(process.platform !== "win32")(
      "keeps other providers when update advisory enrichment defects",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-windows-enrichment-",
          });
          const malformedKiloBinaryPath = "C:\\provider-fixtures\\kilo\0.exe";
          const settings = {
            ...allProvidersDisabledServerSettings,
            enableProviderUpdateChecks: true,
            providers: {
              ...allProvidersDisabledServerSettings.providers,
              kilo: {
                ...DEFAULT_SERVER_SETTINGS.providers.kilo,
                enabled: true,
                binaryPath: malformedKiloBinaryPath,
              },
            },
          } satisfies typeof DEFAULT_SERVER_SETTINGS;
          const layer = makeProviderHealthLive({
            platform: "win32",
            prepareProcess: prepareContainedWindowsProviderForTest,
          }).pipe(
            Layer.provideMerge(providerServiceWithoutRuntimesLayer),
            Layer.provideMerge(ServerSettingsService.layerTest(settings)),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provideMerge(
              mockSpawnerLayer((args, command) => {
                assert.strictEqual(command, malformedKiloBinaryPath);
                assert.deepStrictEqual(args, ["--version"]);
                return { stdout: "kilo 7.4.10\n", stderr: "", code: 0 };
              }),
            ),
          );

          const statuses = yield* Effect.gen(function* () {
            const providerHealth = yield* ProviderHealth;
            return yield* providerHealth.refresh;
          }).pipe(Effect.provide(layer));

          assert.strictEqual(statuses.length, 10);
          const kilo = statuses.find((status) => status.provider === "kilo");
          assert.strictEqual(kilo?.status, "ready");
          assert.strictEqual(kilo?.available, true);
          assert.strictEqual(kilo?.version, "7.4.10");
          assert.strictEqual(kilo?.versionAdvisory?.status, "unknown");
          assert.strictEqual(kilo?.versionAdvisory?.canUpdate, false);
        }),
    );

    it.effect.skipIf(process.platform !== "win32")(
      "retains a cached ready provider after transient Windows command discovery fails",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-windows-transient-cache-",
          });
          const cachePath = resolveProviderStatusCachePath({
            stateDir: path.join(baseDir, "userdata"),
            provider: "grok",
          });
          yield* writeProviderStatusCache({
            filePath: cachePath,
            provider: {
              provider: "grok",
              status: "ready",
              available: true,
              authStatus: "unknown",
              version: "0.2.4",
              checkedAt: "2026-07-22T12:00:00.000Z",
              message: "Grok CLI is installed. Authentication is managed by the Grok CLI.",
            },
          });
          const settings = {
            ...allProvidersDisabledServerSettings,
            enableProviderUpdateChecks: false,
            providers: {
              ...allProvidersDisabledServerSettings.providers,
              grok: {
                ...DEFAULT_SERVER_SETTINGS.providers.grok,
                enabled: true,
                binaryPath: "grok",
              },
            },
          } satisfies typeof DEFAULT_SERVER_SETTINGS;
          let spawnCount = 0;
          const layer = makeProviderHealthLive({
            platform: "win32",
            prepareProcess: makeContainedWindowsProviderPreparationForTest({
              error: Object.assign(new Error("where.exe timed out"), { code: "ETIMEDOUT" }),
              stdout: "",
              status: null,
            }),
          }).pipe(
            Layer.provideMerge(providerServiceWithoutRuntimesLayer),
            Layer.provideMerge(ServerSettingsService.layerTest(settings)),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provideMerge(
              mockSpawnerLayer(() => {
                spawnCount += 1;
                return { stdout: "", stderr: "", code: 0 };
              }),
            ),
          );

          const statuses = yield* Effect.gen(function* () {
            const providerHealth = yield* ProviderHealth;
            return yield* providerHealth.refresh;
          }).pipe(Effect.provide(layer));
          const grok = statuses.find((status) => status.provider === "grok");
          const cached = yield* readProviderStatusCache(cachePath);

          assert.strictEqual(spawnCount, 0);
          assert.strictEqual(grok?.status, "ready");
          assert.strictEqual(grok?.available, true);
          assert.strictEqual(grok?.version, "0.2.4");
          assert.strictEqual(cached?.status, "ready");
          assert.strictEqual(cached?.available, true);
          assert.strictEqual(cached?.version, "0.2.4");
        }),
    );

    it.effect.skipIf(process.platform !== "win32")(
      "retains cached Codex and Command Code providers after pre-resolution discovery fails",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-windows-preresolved-cache-",
          });
          const cachedProviders = [
            {
              provider: "codex",
              status: "ready",
              available: true,
              authStatus: "authenticated",
              version: "0.114.0",
              checkedAt: "2026-07-22T12:00:00.000Z",
            },
            {
              provider: "commandCode",
              status: "ready",
              available: true,
              authStatus: "authenticated",
              version: "1.2.3",
              checkedAt: "2026-07-22T12:00:00.000Z",
            },
          ] as const satisfies ReadonlyArray<ServerProviderStatus>;
          for (const provider of cachedProviders) {
            yield* writeProviderStatusCache({
              filePath: resolveProviderStatusCachePath({
                stateDir: path.join(baseDir, "userdata"),
                provider: provider.provider,
              }),
              provider,
            });
          }
          const settings = {
            ...allProvidersDisabledServerSettings,
            enableProviderUpdateChecks: false,
            providers: {
              ...allProvidersDisabledServerSettings.providers,
              codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: true },
              commandCode: { ...DEFAULT_SERVER_SETTINGS.providers.commandCode, enabled: true },
            },
          } satisfies typeof DEFAULT_SERVER_SETTINGS;
          let spawnCount = 0;
          const layer = makeProviderHealthLive({
            platform: "win32",
            prepareResolvedProcess: prepareContainedResolvedWindowsProviderForTest,
            resolveCodexExecutable: () => ({
              executable: "codex",
              discoveryOutcome: "transient_failure",
            }),
            resolveCommandCodeExecutable: () => ({
              executable: "commandcode",
              discoveryOutcome: "transient_failure",
            }),
          }).pipe(
            Layer.provideMerge(providerServiceWithoutRuntimesLayer),
            Layer.provideMerge(ServerSettingsService.layerTest(settings)),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provideMerge(
              mockSpawnerLayer(() => {
                spawnCount += 1;
                return { stdout: "", stderr: "", code: 0 };
              }),
            ),
          );

          const statuses = yield* Effect.gen(function* () {
            const providerHealth = yield* ProviderHealth;
            return yield* providerHealth.refresh;
          }).pipe(Effect.provide(layer));

          assert.strictEqual(spawnCount, 0);
          for (const provider of cachedProviders) {
            const status = statuses.find((candidate) => candidate.provider === provider.provider);
            const cached = yield* readProviderStatusCache(
              resolveProviderStatusCachePath({
                stateDir: path.join(baseDir, "userdata"),
                provider: provider.provider,
              }),
            );
            assert.strictEqual(status?.status, "ready", provider.provider);
            assert.strictEqual(status?.available, true, provider.provider);
            assert.strictEqual(status?.version, provider.version, provider.provider);
            assert.strictEqual(cached?.status, "ready", provider.provider);
            assert.strictEqual(cached?.available, true, provider.provider);
            assert.strictEqual(cached?.version, provider.version, provider.provider);
          }
        }),
    );

    it.effect.skipIf(process.platform !== "win32")(
      "reports definitive pre-resolution misses for Codex and Command Code as not installed",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-windows-preresolved-missing-",
          });
          const settings = {
            ...allProvidersDisabledServerSettings,
            enableProviderUpdateChecks: false,
            providers: {
              ...allProvidersDisabledServerSettings.providers,
              codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: true },
              commandCode: { ...DEFAULT_SERVER_SETTINGS.providers.commandCode, enabled: true },
            },
          } satisfies typeof DEFAULT_SERVER_SETTINGS;
          const layer = makeProviderHealthLive({
            platform: "win32",
            prepareResolvedProcess: prepareContainedResolvedWindowsProviderForTest,
            resolveCodexExecutable: () => ({
              executable: "codex",
              discoveryOutcome: "not_found",
            }),
            resolveCommandCodeExecutable: () => ({
              executable: "commandcode",
              discoveryOutcome: "not_found",
            }),
          }).pipe(
            Layer.provideMerge(providerServiceWithoutRuntimesLayer),
            Layer.provideMerge(ServerSettingsService.layerTest(settings)),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provideMerge(
              mockSpawnerLayer(() => {
                throw new Error("Definitive missing commands must not reach spawn.");
              }),
            ),
          );

          const statuses = yield* Effect.gen(function* () {
            const providerHealth = yield* ProviderHealth;
            return yield* providerHealth.refresh;
          }).pipe(Effect.provide(layer));
          const codex = statuses.find((status) => status.provider === "codex");
          const commandCode = statuses.find((status) => status.provider === "commandCode");

          assert.strictEqual(
            codex?.message,
            "Codex CLI (`codex`) is not installed or not on PATH.",
          );
          assert.strictEqual(
            commandCode?.message,
            "Command Code CLI (`commandcode` or `command-code`) is not installed or not on PATH.",
          );
        }),
    );
  });

  describe("disabled provider handling", () => {
    it("builds an inert status for disabled providers", () => {
      assert.deepStrictEqual(makeDisabledProviderStatus("kilo", "2026-06-16T12:00:00.000Z"), {
        provider: "kilo",
        status: "warning",
        available: false,
        authStatus: "unknown",
        checkedAt: "2026-06-16T12:00:00.000Z",
        message: "Provider is disabled in Synara settings.",
      });
    });

    it("projects disabled settings over cached ready statuses", () => {
      const statuses = projectProviderStatusesForSettings(
        [cachedReadyCodexStatus],
        allProvidersDisabledServerSettings,
        "2026-06-16T12:05:00.000Z",
      );
      const codex = statuses.find((status) => status.provider === "codex");

      assert.strictEqual(statuses.length, 10);
      assert.strictEqual(codex?.available, false);
      assert.strictEqual(codex?.message, "Provider is disabled in Synara settings.");
    });

    it("suppresses cached update advisories when automatic update checks are disabled", () => {
      const statuses = projectProviderStatusesForSettings(
        [
          {
            ...cachedReadyCodexStatus,
            version: "0.129.0",
            versionAdvisory: {
              status: "behind_latest",
              currentVersion: "0.129.0",
              latestVersion: "0.130.0",
              updateCommand: "npm install -g @openai/codex@latest",
              canUpdate: true,
              checkedAt: "2026-06-16T12:00:00.000Z",
              message: "Update available.",
            },
          },
        ],
        { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
        "2026-06-16T12:05:00.000Z",
      );
      const codex = statuses.find((status) => status.provider === "codex");

      assert.strictEqual(codex?.available, true);
      assert.strictEqual(codex?.version, "0.129.0");
      assert.strictEqual(codex?.versionAdvisory?.status, "unknown");
      assert.strictEqual(codex?.versionAdvisory?.latestVersion, null);
      assert.strictEqual(codex?.versionAdvisory?.canUpdate, false);
      assert.strictEqual(codex?.versionAdvisory?.updateCommand, null);
    });

    it.effect("does not expose cached ready statuses for disabled providers", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-disabled-cache-",
        });
        const cachePath = resolveProviderStatusCachePath({
          stateDir: path.join(baseDir, "userdata"),
          provider: "codex",
        });
        yield* writeProviderStatusCache({
          filePath: cachePath,
          provider: cachedReadyCodexStatus,
        });

        const layer = ProviderHealthLive.pipe(
          Layer.provideMerge(providerServiceWithoutRuntimesLayer),
          Layer.provideMerge(ServerSettingsService.layerTest(allProvidersDisabledSettings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        );
        const statuses = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* providerHealth.getStatuses;
        }).pipe(Effect.provide(layer));
        const codex = statuses.find((status) => status.provider === "codex");
        const cachedCodex = yield* readProviderStatusCache(cachePath);

        assert.strictEqual(codex?.available, false);
        assert.strictEqual(codex?.message, "Provider is disabled in Synara settings.");
        assert.deepStrictEqual(cachedCodex, cachedReadyCodexStatus);
      }),
    );

    it.effect("projects cached ready status when a disabled provider is re-enabled", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-enable-cache-",
        });
        const cachePath = resolveProviderStatusCachePath({
          stateDir: path.join(baseDir, "userdata"),
          provider: "codex",
        });
        yield* writeProviderStatusCache({
          filePath: cachePath,
          provider: cachedReadyCodexStatus,
        });

        let spawnCount = 0;
        const layer = ProviderHealthLive.pipe(
          Layer.provideMerge(providerServiceWithoutRuntimesLayer),
          Layer.provideMerge(ServerSettingsService.layerTest(allProvidersDisabledSettings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer((args) => {
              spawnCount += 1;
              const joined = args.join(" ");
              if (joined === "--version") {
                return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              }
              if (joined === "login status" || joined === "login status --json") {
                return { stdout: '{"authenticated":true}\n', stderr: "", code: 0 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          const serverSettings = yield* ServerSettingsService;
          const disabledStatuses = yield* providerHealth.getStatuses;
          const disabledCodex = disabledStatuses.find((status) => status.provider === "codex");

          assert.strictEqual(disabledCodex?.available, false);
          assert.strictEqual(disabledCodex?.message, "Provider is disabled in Synara settings.");

          yield* serverSettings.updateSettings({
            providers: {
              codex: {
                enabled: true,
              },
            },
          });

          const currentStatuses = yield* providerHealth.getStatuses;
          const currentCodex = currentStatuses.find((status) => status.provider === "codex");
          assert.strictEqual(currentCodex?.available, true);
          assert.strictEqual(currentCodex?.authStatus, "authenticated");
          assert.notStrictEqual(currentCodex?.message, "Provider is disabled in Synara settings.");
          assert.strictEqual(spawnCount, 0);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("does not offer updates for disabled providers", () =>
      Effect.gen(function* () {
        const providerHealth = yield* ProviderHealth;
        const statuses = yield* providerHealth.refresh;

        assert.strictEqual(statuses.length, 10);
        for (const status of statuses) {
          assert.strictEqual(status.available, false);
          assert.strictEqual(status.message, "Provider is disabled in Synara settings.");
          assert.strictEqual(status.versionAdvisory?.status, "unknown");
          assert.strictEqual(status.versionAdvisory?.canUpdate, false);
          assert.strictEqual(status.versionAdvisory?.updateCommand, null);
        }
      }).pipe(Effect.provide(disabledProviderHealthLayer)),
    );

    it.effect("rejects one-click updates for disabled providers", () =>
      Effect.gen(function* () {
        const providerHealth = yield* ProviderHealth;
        const error = yield* Effect.flip(providerHealth.updateProvider({ provider: "kilo" }));

        assert.ok(error instanceof ServerProviderUpdateError);
        assert.strictEqual(error.provider, "kilo");
        assert.strictEqual(error.reason, "Provider is disabled in Synara settings.");
      }).pipe(Effect.provide(disabledProviderHealthLayer)),
    );
  });

  describe("startup refresh behavior", () => {
    it.effect("serves cached statuses without spawning provider CLIs on layer startup", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-no-boot-refresh-",
        });
        let spawnCount = 0;
        const layer = ProviderHealthLive.pipe(
          Layer.provideMerge(providerServiceWithoutRuntimesLayer),
          Layer.provideMerge(ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer(() => {
              spawnCount += 1;
              return { stdout: "", stderr: "", code: 0 };
            }),
          ),
        );

        const statuses = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* providerHealth.getStatuses;
        }).pipe(Effect.provide(layer));

        assert.deepStrictEqual(statuses, []);
        assert.strictEqual(spawnCount, 0);
      }),
    );
  });

  describe("stabilizeProviderStatusesAgainstTransientTimeouts", () => {
    const previousReadyOpenCode = {
      provider: "opencode",
      status: "ready",
      available: true,
      authStatus: "unknown",
      version: "1.15.13",
      checkedAt: "2026-06-04T17:00:00.000Z",
      message:
        "OpenCode CLI is installed. Configure provider credentials inside OpenCode as needed.",
    } satisfies ServerProviderStatus;

    it("keeps an already usable provider available after a transient command timeout", () => {
      const result = stabilizeProviderStatusesAgainstTransientTimeouts(
        [previousReadyOpenCode],
        [
          {
            provider: "opencode",
            status: "error",
            available: false,
            authStatus: "unknown",
            checkedAt: "2026-06-04T17:01:00.000Z",
            message:
              "OpenCode CLI is installed but failed to run. Timed out while running command.",
          },
        ],
      );

      assert.deepStrictEqual(result, [
        {
          ...previousReadyOpenCode,
          checkedAt: "2026-06-04T17:01:00.000Z",
        },
      ]);
    });

    it("does not hide non-timeout provider failures", () => {
      const unavailableStatus = {
        provider: "opencode",
        status: "error",
        available: false,
        authStatus: "unknown",
        checkedAt: "2026-06-04T17:01:00.000Z",
        message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
      } satisfies ServerProviderStatus;

      assert.deepStrictEqual(
        stabilizeProviderStatusesAgainstTransientTimeouts(
          [previousReadyOpenCode],
          [unavailableStatus],
        ),
        [unavailableStatus],
      );
    });

    it("keeps an already usable provider available after transient Windows discovery fails", () => {
      const result = stabilizeProviderStatusesAgainstTransientTimeouts(
        [previousReadyOpenCode],
        [
          {
            provider: "opencode",
            status: "error",
            available: false,
            authStatus: "unknown",
            checkedAt: "2026-06-04T17:01:00.000Z",
            message:
              "Failed to execute OpenCode CLI health check: Windows command discovery was temporarily unavailable: opencode.",
          },
        ],
      );

      assert.deepStrictEqual(result, [
        {
          ...previousReadyOpenCode,
          checkedAt: "2026-06-04T17:01:00.000Z",
        },
      ]);
    });

    it("keeps an already usable provider ready after a transient auth timeout warning", () => {
      const previousReadyClaude = {
        provider: "claudeAgent",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        version: "2.1.162",
        checkedAt: "2026-06-04T17:00:00.000Z",
      } satisfies ServerProviderStatus;

      const result = stabilizeProviderStatusesAgainstTransientTimeouts(
        [previousReadyClaude],
        [
          {
            provider: "claudeAgent",
            status: "warning",
            available: true,
            authStatus: "unknown",
            version: "2.1.162",
            checkedAt: "2026-06-04T17:01:00.000Z",
            message:
              "Could not verify Claude authentication status. Timed out while running command.",
          },
        ],
      );

      assert.deepStrictEqual(result, [
        {
          ...previousReadyClaude,
          checkedAt: "2026-06-04T17:01:00.000Z",
        },
      ]);
    });

    it("does not keep a stale Claude auth error after a transient auth timeout", () => {
      const previousUnauthenticatedClaude = {
        provider: "claudeAgent",
        status: "error",
        available: true,
        authStatus: "unauthenticated",
        version: "2.1.162",
        checkedAt: "2026-06-04T17:00:00.000Z",
        message: "Claude is not authenticated. Run `claude auth login` and try again.",
      } satisfies ServerProviderStatus;
      const authTimeoutWarning = {
        provider: "claudeAgent",
        status: "warning",
        available: true,
        authStatus: "unknown",
        version: "2.1.162",
        checkedAt: "2026-06-04T17:01:00.000Z",
        message: "Could not verify Claude authentication status. Timed out while running command.",
      } satisfies ServerProviderStatus;

      assert.deepStrictEqual(
        stabilizeProviderStatusesAgainstTransientTimeouts(
          [previousUnauthenticatedClaude],
          [authTimeoutWarning],
        ),
        [authTimeoutWarning],
      );
    });
  });

  describe("providerStatusesEqual", () => {
    const readyCursor = {
      provider: "cursor",
      status: "ready",
      available: true,
      authStatus: "unknown",
      version: "2026.06.04-8f81907",
      checkedAt: "2026-06-04T17:00:00.000Z",
      message:
        "Cursor Agent CLI is installed. Sign in with Cursor if a session prompts for authentication.",
      versionAdvisory: {
        status: "current",
        currentVersion: "2026.06.04-8f81907",
        latestVersion: "2026.06.04-8f81907",
        updateCommand: null,
        canUpdate: true,
        checkedAt: "2026-06-04T17:00:00.000Z",
        message: null,
      },
    } satisfies ServerProviderStatus;

    it("ignores top-level and version-advisory checkedAt churn", () => {
      assert.strictEqual(
        providerStatusesEqual(
          [readyCursor],
          [
            {
              ...readyCursor,
              checkedAt: "2026-06-04T17:01:00.000Z",
              versionAdvisory: {
                ...readyCursor.versionAdvisory,
                checkedAt: "2026-06-04T17:01:00.000Z",
              },
            },
          ],
        ),
        true,
      );
    });

    it("detects meaningful version-advisory changes", () => {
      assert.strictEqual(
        providerStatusesEqual(
          [readyCursor],
          [
            {
              ...readyCursor,
              versionAdvisory: {
                ...readyCursor.versionAdvisory,
                status: "behind_latest",
                latestVersion: "2026.06.05-a1b2c3d",
              },
            },
          ],
        ),
        false,
      );
    });
  });

  // ── checkCodexProviderStatus tests ────────────────────────────────
  //
  // These tests control CODEX_HOME to ensure the custom-provider detection
  // in hasCustomModelProvider() does not interfere with the auth-probe
  // path being tested.

  describe("checkCodexProviderStatus", () => {
    it.effect("returns ready when codex is installed and authenticated", () =>
      Effect.gen(function* () {
        // Point CODEX_HOME at an empty tmp dir (no config.toml) so the
        // default code path (OpenAI provider, auth probe runs) is exercised.
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("uses configured codex binary for version and auth probes", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* makeCheckCodexProviderStatus(`  ${configuredTestBinary("codex")}  `);
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, configuredTestBinary("codex"));
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("propagates verbatim Windows arguments through the Effect command", () => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { tmpDir } = yield* withTempCodexHome();
        const launcherPath = path.join(tmpDir, WINDOWS_JOB_LAUNCHER_EXECUTABLE);
        yield* fileSystem.writeFileString(launcherPath, "");
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env[WINDOWS_JOB_LAUNCHER_ENV];
            process.env[WINDOWS_JOB_LAUNCHER_ENV] = launcherPath;
            return previous;
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env[WINDOWS_JOB_LAUNCHER_ENV];
              } else {
                process.env[WINDOWS_JOB_LAUNCHER_ENV] = previous;
              }
            }),
        );
        const status = yield* makeProductionCheckCodexProviderStatus(
          "C:\\tools(x86)\\codex.cmd",
          undefined,
          { ...TEST_PROVIDER_LAYER_PROCESS_OPTIONS, platform: "win32" },
        );
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, _env, options) => {
            assert.strictEqual(command.toLowerCase(), "c:\\windows\\system32\\cmd.exe");
            assert.strictEqual(options?.windowsVerbatimArguments, true);
            const commandLine = args.at(-1) ?? "";
            if (commandLine.includes('"--version"')) {
              return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            }
            if (commandLine.includes('"login" "status"')) {
              return { stdout: "Logged in\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${args.join(" ")}`);
          }),
        ),
        Effect.ensuring(Effect.sync(() => platform.mockRestore())),
      );
    });

    it.effect("uses configured codex home for version, config, and auth probes", () => {
      let sawLoginStatusProbe = false;
      let expectedCodexHome: string | undefined;
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { tmpDir, runtimeDir } = yield* withTempCodexHome();
        yield* fileSystem.writeFileString(
          path.join(tmpDir, "config.toml"),
          'model_provider = "portkey"\n',
        );
        const configuredHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "synara-configured-codex-",
        });
        yield* fileSystem.writeFileString(
          path.join(configuredHome, "config.toml"),
          'model_provider = "openai"\n',
        );
        expectedCodexHome = path.join(runtimeDir, SYNARA_CODEX_HOME_OVERLAY_DIR);

        const status = yield* makeCheckCodexProviderStatus("codex", configuredHome);
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.message, undefined);
        assert.strictEqual(sawLoginStatusProbe, true);
        assert.notStrictEqual(configuredHome, tmpDir);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, _command, env) => {
            assert.strictEqual(env?.CODEX_HOME, expectedCodexHome);
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") {
              sawLoginStatusProbe = true;
              return { stdout: "Logged in\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      );
    });

    it.effect("returns unavailable when codex is missing", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(status.message, "Codex CLI (`codex`) is not installed or not on PATH.");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );

    it.effect("returns unavailable when codex is below the minimum supported version", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI v0.36.0 is too old for Synara. Upgrade to v0.37.0 or newer and restart Synara.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 0.36.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when auth probe reports login required", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") {
              return { stdout: "", stderr: "Not logged in. Run codex login.", code: 1 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when login status output includes 'not logged in'", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when login status command is unsupported", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI authentication status command is unavailable in this Codex version.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") {
              return { stdout: "", stderr: "error: unknown command 'login'", code: 2 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── Custom model provider: checkCodexProviderStatus integration ───

  describe("checkCodexProviderStatus with custom model provider", () => {
    it.effect("skips auth probe and returns ready when a custom model provider is configured", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Using a custom Codex model provider; OpenAI login check skipped.",
        );
      }).pipe(
        Effect.provide(
          // The spawner only handles --version; if the test attempts
          // "login status" the throw proves the auth probe was NOT skipped.
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Auth probe should have been skipped but got args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("still reports error when codex CLI is missing even with custom provider", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );
  });

  describe("checkCodexProviderStatus with openai model provider", () => {
    it.effect("still runs auth probe when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        const status = yield* checkCodexProviderStatus;
        // The auth probe runs and sees "not logged in" → error
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── parseAuthStatusFromOutput pure tests ──────────────────────────

  describe("parseAuthStatusFromOutput", () => {
    it("exit code 0 with no auth markers is ready", () => {
      const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.authStatus, "authenticated");
    });

    it("JSON with authenticated=false is unauthenticated", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"authenticated":false}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "error");
      assert.strictEqual(parsed.authStatus, "unauthenticated");
    });

    it("JSON without auth marker is warning", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"ok":true}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "warning");
      assert.strictEqual(parsed.authStatus, "unknown");
    });
  });

  // ── readCodexConfigModelProvider tests ─────────────────────────────

  describe("readCodexConfigModelProvider", () => {
    it.effect("returns undefined when config file does not exist", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        assert.strictEqual(yield* readCodexConfigModelProvider, undefined);
      }),
    );

    it.effect("returns undefined when config has no model_provider key", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider, undefined);
      }),
    );

    it.effect("returns the provider when model_provider is set at top level", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\nmodel_provider = "portkey"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider, "portkey");
      }),
    );

    it.effect("returns openai when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider, "openai");
      }),
    );

    it.effect("ignores model_provider inside section headers", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model = "gpt-5-codex"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'model_provider = "should-be-ignored"',
            "",
          ].join("\n"),
        );
        assert.strictEqual(yield* readCodexConfigModelProvider, undefined);
      }),
    );

    it.effect("handles comments and whitespace", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            "# This is a comment",
            "",
            '  model_provider = "azure"  ',
            "",
            "[profiles.deep-review]",
            'model = "gpt-5-pro"',
          ].join("\n"),
        );
        assert.strictEqual(yield* readCodexConfigModelProvider, "azure");
      }),
    );

    it.effect("handles single-quoted values in TOML", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome("model_provider = 'mistral'\n");
        assert.strictEqual(yield* readCodexConfigModelProvider, "mistral");
      }),
    );
  });

  // ── hasCustomModelProvider tests ───────────────────────────────────

  describe("hasCustomModelProvider", () => {
    it.effect("returns false when no config file exists", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns false when model_provider is not set", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\n');
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns false when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns true when model_provider is portkey", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "portkey"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is azure", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "azure"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is ollama", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "ollama"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is a custom proxy", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "my-company-proxy"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );
  });

  // ── checkClaudeProviderStatus tests ──────────────────────────

  describe("checkClaudeProviderStatus", () => {
    it.effect("returns ready when claude is installed and authenticated", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("uses configured claude binary for version and auth probes", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckClaudeProviderStatus(
          undefined,
          configuredTestBinary("claude"),
        );
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, configuredTestBinary("claude"));
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("honors caller process supervision overrides", () => {
      let supervisorInstallations = 0;
      return makeCheckClaudeProviderStatus(undefined, "claude", undefined, {
        superviseProcess: (prepared, child) => {
          supervisorInstallations += 1;
          return TEST_PROVIDER_PROCESS_OPTIONS.superviseProcess(prepared, child);
        },
      }).pipe(
        Effect.provide(mockSpawnerLayer(() => ({ stdout: "", stderr: "version failed", code: 1 }))),
        Effect.tap((status) =>
          Effect.sync(() => {
            assert.strictEqual(status.status, "error");
            assert.strictEqual(supervisorInstallations, 1);
          }),
        ),
      );
    });

    it.effect(
      "strips stale direct Claude credentials from health probes when local OAuth is usable",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homeDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-claude-home-",
          });
          const claudeDir = path.join(homeDir, ".claude");
          yield* fileSystem.makeDirectory(claudeDir, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "local-access-token",
                expiresAt: Date.now() + 60_000,
              },
            }),
          );

          const envKeys = [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_ANTHROPIC_AWS",
          ] as const;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = new Map<string, string | undefined>();
              for (const key of envKeys) {
                previous.set(key, process.env[key]);
                delete process.env[key];
              }
              process.env.ANTHROPIC_API_KEY = "stale-api-key";
              process.env.ANTHROPIC_AUTH_TOKEN = "stale-auth-token";
              process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-oauth-token";
              return previous;
            }),
            (previous) =>
              Effect.sync(() => {
                for (const [key, value] of previous) {
                  if (value === undefined) {
                    delete process.env[key];
                  } else {
                    process.env[key] = value;
                  }
                }
              }),
          );

          const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir).pipe(
            Effect.provide(
              mockSpawnerLayer((args, command, env) => {
                assert.strictEqual(command, "claude");
                assert.strictEqual(env?.ANTHROPIC_API_KEY, undefined);
                assert.strictEqual(env?.ANTHROPIC_AUTH_TOKEN, undefined);
                assert.strictEqual(env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);

                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
                if (joined === "auth status")
                  return {
                    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                    stderr: "",
                    code: 0,
                  };
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.authStatus, "authenticated");
        }),
    );

    it.effect("trusts usable Claude OAuth credentials after the SDK probe validates them", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-claude-auth-fallback-",
        });
        const claudeDir = path.join(homeDir, ".claude");
        yield* fileSystem.makeDirectory(claudeDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(claudeDir, ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "expired-access-token",
              refreshToken: "refresh-token",
              expiresAt: Date.now() - 60_000,
              subscriptionType: "max",
            },
          }),
        );

        let sdkProbeCalls = 0;
        const status = yield* makeCheckClaudeProviderStatus(
          Effect.sync(() => {
            sdkProbeCalls += 1;
            return "max";
          }),
          "claude",
          homeDir,
        ).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") {
                return { stdout: "2.1.197\n", stderr: "", code: 0 };
              }
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );

        assert.strictEqual(sdkProbeCalls, 1);
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(status.authType, "max");
        assert.strictEqual(status.authLabel, "Claude Max Subscription");
        assert.strictEqual(status.message, undefined);
      }),
    );

    it.effect("does not trust local Claude OAuth token strings without a live SDK validation", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-claude-auth-fallback-no-probe-",
        });
        const claudeDir = path.join(homeDir, ".claude");
        yield* fileSystem.makeDirectory(claudeDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(claudeDir, ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "expired-access-token",
              refreshToken: "stale-refresh-token",
              expiresAt: Date.now() - 60_000,
              subscriptionType: "max",
            },
          }),
        );

        const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") {
                return { stdout: "2.1.197\n", stderr: "", code: 0 };
              }
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );

        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(status.authType, undefined);
        assert.strictEqual(status.authLabel, undefined);
      }),
    );

    it.effect(
      "keeps Claude unauthenticated when auth status includes a textual login failure",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homeDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-claude-auth-text-failure-",
          });
          const claudeDir = path.join(homeDir, ".claude");
          yield* fileSystem.makeDirectory(claudeDir, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "expired-access-token",
                refreshToken: "refresh-token",
                expiresAt: Date.now() - 60_000,
                subscriptionType: "max",
              },
            }),
          );

          const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "2.1.197\n", stderr: "", code: 0 };
                }
                if (joined === "auth status")
                  return {
                    stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n',
                    stderr: "Not logged in. Please run /login.\n",
                    code: 0,
                  };
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.authStatus, "unauthenticated");
          assert.strictEqual(status.authType, undefined);
          assert.strictEqual(status.authLabel, undefined);
          assert.match(status.message ?? "", /not authenticated/i);
        }),
    );

    it.effect(
      "re-probes auth status once when a structured false negative has no credential file to rescue it",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const homeDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-claude-auth-retry-",
          });

          let authStatusCalls = 0;
          const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir, {
            falseNegativeRetryDelayMs: 0,
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "2.1.197\n", stderr: "", code: 0 };
                }
                if (joined === "auth status") {
                  authStatusCalls += 1;
                  // First probe loses a refresh-token rotation race; the retry
                  // observes the settled, rotated token.
                  return authStatusCalls === 1
                    ? {
                        stdout: '{"loggedIn":false,"authMethod":"none"}\n',
                        stderr: "",
                        code: 0,
                      }
                    : {
                        stdout:
                          '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\n',
                        stderr: "",
                        code: 0,
                      };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(authStatusCalls, 2);
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.authStatus, "authenticated");
          assert.strictEqual(status.authType, "max");
        }),
    );

    it.effect(
      "stays unauthenticated when the structured false negative persists across the retry",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const homeDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-claude-auth-retry-persist-",
          });

          let authStatusCalls = 0;
          const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir, {
            falseNegativeRetryDelayMs: 0,
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "2.1.197\n", stderr: "", code: 0 };
                }
                if (joined === "auth status") {
                  authStatusCalls += 1;
                  return {
                    stdout: '{"loggedIn":false,"authMethod":"none"}\n',
                    stderr: "",
                    code: 0,
                  };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(authStatusCalls, 2);
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.authStatus, "unauthenticated");
          assert.match(status.message ?? "", /not authenticated/i);
        }),
    );

    it.effect("returns unavailable when claude is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Claude Agent CLI (`claude`) is not installed or not on PATH.",
        );
      }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
    );

    it.effect("returns error when version check fails with non-zero exit code", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version")
              return { stdout: "", stderr: "Something went wrong", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when auth status reports not logged in", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Claude is not authenticated. Run `claude auth login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":false}\n',
                stderr: "",
                code: 1,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when output includes 'not logged in'", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status") return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when auth status command is unsupported", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Claude Agent authentication status command is unavailable in this version of Claude.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return { stdout: "", stderr: "error: unknown command 'auth'", code: 2 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  describe("checkOpenCodeProviderStatus", () => {
    it.effect("returns ready when opencode is installed", () =>
      withIsolatedProviderCommands(["opencode"], (fixture) =>
        Effect.gen(function* () {
          const status = yield* checkOpenCodeProviderStatus;
          assert.strictEqual(status.provider, "opencode");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.available, true);
          assert.strictEqual(status.authStatus, "unknown");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args, command, env, options) => {
              assertPreparedProviderCommand({
                fixture,
                executable: "opencode",
                expectedArgs: ["--version"],
                command,
                actualArgs: args,
                env,
                options,
              });
              return { stdout: "opencode 1.3.17\n", stderr: "", code: 0 };
            }),
          ),
        ),
      ),
    );

    it.effect("uses configured opencode binary for version probe", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckOpenCodeProviderStatus(configuredTestBinary("opencode"));
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, configuredTestBinary("opencode"));
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "opencode 1.3.17\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unavailable when opencode is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkOpenCodeProviderStatus;
        assert.strictEqual(status.provider, "opencode");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        );
      }).pipe(Effect.provide(failingSpawnerLayer("spawn opencode ENOENT"))),
    );
  });

  describe("checkKiloProviderStatus", () => {
    it.effect("uses configured Kilo binary for version probe", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckKiloProviderStatus(configuredTestBinary("kilo"));
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, configuredTestBinary("kilo"));
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "kilo 7.2.52\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  describe("checkPiProviderStatus", () => {
    it.effect("returns ready using only the Pi CLI version probe", () =>
      withIsolatedProviderCommands(["pi"], (fixture) =>
        Effect.gen(function* () {
          const status = yield* checkPiProviderStatus();
          assert.strictEqual(status.provider, "pi");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.available, true);
          assert.strictEqual(status.authStatus, "unknown");
          assert.strictEqual(
            status.message,
            "Pi CLI is installed. Configure provider credentials inside Pi as needed.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args, command, env, options) => {
              assertPreparedProviderCommand({
                fixture,
                executable: "pi",
                expectedArgs: ["--version"],
                command,
                actualArgs: args,
                env,
                options,
              });
              return { stdout: "pi 0.74.0\n", stderr: "", code: 0 };
            }),
          ),
        ),
      ),
    );

    it.effect("uses configured Pi binary and agent dir without SDK registry reads", () =>
      Effect.gen(function* () {
        const status = yield* checkPiProviderStatus("/tmp/pi-agent", configuredTestBinary("pi"));
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(
          status.message,
          "Pi CLI is installed. Synara will use Pi agent dir /tmp/pi-agent.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, configuredTestBinary("pi"));
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "pi 0.74.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("keeps Pi usable when the advisory CLI probe is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkPiProviderStatus();
        assert.strictEqual(status.provider, "pi");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Pi SDK is bundled, but the Pi CLI (`pi`) is not on PATH, so Synara could not verify the installed CLI version.",
        );
      }).pipe(Effect.provide(failingSpawnerLayer("spawn pi ENOENT"))),
    );
  });

  describe("checkAntigravityProviderStatus", () => {
    it.effect("rejects versions that predate --new-project support", () =>
      Effect.gen(function* () {
        const status = yield* checkAntigravityProviderStatus();
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.version, "1.0.11");
        assert.strictEqual(
          status.message,
          "Antigravity CLI 1.0.11 is too old for Synara. Upgrade to 1.0.12 or newer.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "Antigravity CLI 1.0.11\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns ready when Antigravity lists authenticated models", () =>
      withIsolatedProviderCommands(["agy"], (fixture) =>
        Effect.gen(function* () {
          const status = yield* checkAntigravityProviderStatus();
          assert.strictEqual(status.provider, "antigravity");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.available, true);
          assert.strictEqual(status.authStatus, "authenticated");
          assert.strictEqual(status.version, "1.1.2");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args, command, env, options) => {
              if (
                preparedProviderCommandMatches({
                  fixture,
                  executable: "agy",
                  expectedArgs: ["--version"],
                  command,
                  actualArgs: args,
                  env,
                  options,
                })
              ) {
                return { stdout: "Antigravity CLI 1.1.2\n", stderr: "", code: 0 };
              }
              assertPreparedProviderCommand({
                fixture,
                executable: "agy",
                expectedArgs: ["models"],
                command,
                actualArgs: args,
                env,
                options,
              });
              return {
                stdout: "Gemini 3.5 Flash (Medium)\nClaude Sonnet 4.6 (Thinking)\n",
                stderr: "",
                code: 0,
              };
            }),
          ),
        ),
      ),
    );

    it.effect("uses the configured Antigravity binary", () =>
      Effect.gen(function* () {
        const status = yield* checkAntigravityProviderStatus(configuredTestBinary("agy"));
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, configuredTestBinary("agy"));
            return args.join(" ") === "--version"
              ? { stdout: "1.1.2\n", stderr: "", code: 0 }
              : { stdout: "GPT-OSS 120B (Medium)\n", stderr: "", code: 0 };
          }),
        ),
      ),
    );
  });

  describe("checkGrokProviderStatus", () => {
    it.effect("returns ready when Grok CLI is installed", () => {
      const previousXaiApiKey = process.env.XAI_API_KEY;
      const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.GROK_CODE_XAI_API_KEY;
      return Effect.gen(function* () {
        const status = yield* checkGrokProviderStatus;
        assert.strictEqual(status.provider, "grok");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(status.version, "0.1.0");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousXaiApiKey === undefined) {
              delete process.env.XAI_API_KEY;
            } else {
              process.env.XAI_API_KEY = previousXaiApiKey;
            }
            if (previousApiKey === undefined) {
              delete process.env.GROK_CODE_XAI_API_KEY;
            } else {
              process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
            }
          }),
        ),
      );
    });

    it.effect("marks Grok authenticated when XAI_API_KEY is present", () => {
      const previousXaiApiKey = process.env.XAI_API_KEY;
      const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;
      process.env.XAI_API_KEY = "xai-test-key";
      delete process.env.GROK_CODE_XAI_API_KEY;
      return Effect.gen(function* () {
        const status = yield* checkGrokProviderStatus;
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(status.authType, "apiKey");
        assert.strictEqual(status.authLabel, "xAI API Key");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousXaiApiKey === undefined) {
              delete process.env.XAI_API_KEY;
            } else {
              process.env.XAI_API_KEY = previousXaiApiKey;
            }
            if (previousApiKey === undefined) {
              delete process.env.GROK_CODE_XAI_API_KEY;
            } else {
              process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
            }
          }),
        ),
      );
    });

    it.effect("uses configured Grok binary for version probe", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckGrokProviderStatus(configuredTestBinary("grok"));
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, configuredTestBinary("grok"));
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unavailable when Grok CLI is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkGrokProviderStatus;
        assert.strictEqual(status.provider, "grok");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(status.message, "Grok CLI (`grok`) is not installed or not on PATH.");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn grok ENOENT"))),
    );

    it.effect.skipIf(process.platform !== "win32")(
      "returns unavailable before spawn when Windows containment cannot resolve Grok",
      () => {
        let spawnCount = 0;
        return Effect.gen(function* () {
          const status = yield* makeProductionCheckGrokProviderStatus(undefined, {
            ...TEST_PROVIDER_PROCESS_OPTIONS,
            platform: "win32",
            prepareProcess: prepareContainedWindowsProviderForTest,
          });
          assert.strictEqual(status.provider, "grok");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.available, false);
          assert.strictEqual(status.authStatus, "unknown");
          assert.strictEqual(status.message, "Grok CLI (`grok`) is not installed or not on PATH.");
          assert.strictEqual(spawnCount, 0);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer(() => {
              spawnCount += 1;
              return { stdout: "", stderr: "", code: 0 };
            }),
          ),
        );
      },
    );

    it.effect.skipIf(process.platform !== "win32")(
      "reports transient Windows discovery failures as execution failures rather than missing",
      () =>
        Effect.gen(function* () {
          const transientCases = [
            {
              name: "where timeout",
              result: {
                error: Object.assign(new Error("where.exe timed out"), { code: "ETIMEDOUT" }),
                stdout: "",
                status: null,
              },
            },
            {
              name: "missing process status",
              result: { stdout: "", status: null },
            },
            {
              name: "unexpected nonzero exit",
              result: { stdout: "", status: 2 },
            },
            {
              name: "malformed relative output",
              result: { stdout: "relative\\grok.exe\r\n", status: 0 },
            },
            {
              name: "oversized output",
              result: { stdout: "x".repeat(256 * 1024 + 1), status: 0 },
            },
          ] as const;

          for (const testCase of transientCases) {
            let spawnCount = 0;
            const status = yield* makeProductionCheckGrokProviderStatus(undefined, {
              ...TEST_PROVIDER_PROCESS_OPTIONS,
              platform: "win32",
              prepareProcess: makeContainedWindowsProviderPreparationForTest(testCase.result),
            }).pipe(
              Effect.provide(
                mockSpawnerLayer(() => {
                  spawnCount += 1;
                  return { stdout: "", stderr: "", code: 0 };
                }),
              ),
            );

            assert.strictEqual(status.provider, "grok", testCase.name);
            assert.strictEqual(status.status, "error", testCase.name);
            assert.strictEqual(status.available, false, testCase.name);
            assert.match(status.message ?? "", /Failed to execute Grok CLI health check:/u);
            assert.strictEqual(
              /not installed or not on PATH/u.test(status.message ?? ""),
              false,
              testCase.name,
            );
            assert.strictEqual(spawnCount, 0, testCase.name);
          }
        }),
    );

    it.effect.skipIf(process.platform !== "win32")(
      "reports a thrown Windows discovery error as an execution failure",
      () =>
        Effect.gen(function* () {
          const status = yield* makeProductionCheckGrokProviderStatus(undefined, {
            ...TEST_PROVIDER_PROCESS_OPTIONS,
            platform: "win32",
            prepareProcess: () => {
              throw new Error("synthetic where.exe launch failure");
            },
          });

          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.available, false);
          assert.match(status.message ?? "", /Failed to execute Grok CLI health check:/u);
          assert.strictEqual(/not installed or not on PATH/u.test(status.message ?? ""), false);
        }).pipe(Effect.provide(mockSpawnerLayer(() => ({ stdout: "", stderr: "", code: 0 })))),
    );
  });

  describe("checkCursorProviderStatus", () => {
    it.effect("returns ready when Cursor Agent is authenticated and has models", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "cursor-agent");
            assert.strictEqual(env?.NO_BROWSER, "true");
            assert.strictEqual(env?.BROWSER, "www-browser");
            assert.strictEqual(env?.CI, "true");
            assert.strictEqual(env?.DEBIAN_FRONTEND, "noninteractive");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Logged in as user@example.com\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return { stdout: "gpt-5 - GPT-5\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("maps the old ambiguous agent default to cursor-agent", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckCursorProviderStatus("agent");
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Logged in as user@example.com\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return { stdout: "gpt-5 - GPT-5\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("uses configured Cursor Agent binary for version probe", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckCursorProviderStatus(configuredTestBinary("agent"));
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, configuredTestBinary("agent"));
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Logged in as user@example.com\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return { stdout: "gpt-5 - GPT-5\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect(
      "falls back through configured Cursor editors when no agent command is resolved",
      () =>
        Effect.gen(function* () {
          const originalPath = process.env.PATH;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              process.env.PATH = "";
            }),
            () =>
              Effect.sync(() => {
                if (originalPath !== undefined) {
                  process.env.PATH = originalPath;
                } else {
                  delete process.env.PATH;
                }
              }),
          );
          const status = yield* makeCheckCursorProviderStatus(configuredTestBinary("cursor"));
          assert.strictEqual(status.status, "ready");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args, command) => {
              assert.strictEqual(command, configuredTestBinary("cursor"));
              const joined = args.join(" ");
              if (joined === "agent --version") {
                return { stdout: "cursor 2026.04.27\n", stderr: "", code: 0 };
              }
              if (joined === "agent status") {
                return { stdout: "Logged in as user@example.com\n", stderr: "", code: 0 };
              }
              if (joined === "agent models") {
                return { stdout: "gpt-5 - GPT-5\n", stderr: "", code: 0 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
    );

    it.effect("returns unavailable when Cursor Agent is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Cursor Agent CLI (`cursor-agent`) is not installed or not on PATH.",
        );
      }).pipe(Effect.provide(failingSpawnerLayer("spawn cursor-agent ENOENT"))),
    );

    it.effect("returns unavailable when Cursor Agent exits with an error", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Cursor Agent CLI is installed but failed to run. version failed",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "", stderr: "version failed\n", code: 1 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when Cursor Agent status requires login", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Cursor Agent is not authenticated. Run `cursor-agent login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return {
                stdout: "",
                stderr:
                  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
                code: 1,
              };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when Cursor Agent says not authenticated", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Not authenticated\n", stderr: "", code: 1 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unavailable when Cursor Agent has no account models", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(
          status.message,
          "Cursor Agent is authenticated, but it reports no models available for this account.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Logged in (unable to fetch user details)\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return { stdout: "No models available for this account.\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when Cursor Agent model discovery fails to spawn", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const cmd = command as unknown as {
                command: string;
                args: ReadonlyArray<string>;
              };
              const unwrapped = unwrapContainedProviderCommand(cmd);
              assert.strictEqual(unwrapped.command, "cursor-agent");
              const joined = unwrapped.args.join(" ");
              if (joined === "--version") {
                return Effect.succeed(
                  mockHandle({ stdout: "agent 2026.04.27\n", stderr: "", code: 0 }),
                );
              }
              if (joined === "status") {
                return Effect.succeed(
                  mockHandle({ stdout: "Logged in as user@example.com\n", stderr: "", code: 0 }),
                );
              }
              if (joined === "models") {
                return Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "ChildProcess",
                    method: "spawn",
                    description: "models probe failed",
                  }),
                );
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      ),
    );
  });

  // ── parseClaudeAuthStatusFromOutput pure tests ────────────────────

  describe("parseClaudeAuthStatusFromOutput", () => {
    it("exit code 0 with no auth markers is ready", () => {
      const parsed = parseClaudeAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.authStatus, "authenticated");
    });

    it("JSON with loggedIn=true is authenticated", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.authStatus, "authenticated");
    });

    it("JSON with loggedIn=false is unauthenticated", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"loggedIn":false}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "error");
      assert.strictEqual(parsed.authStatus, "unauthenticated");
    });

    it("JSON without auth marker is warning", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"ok":true}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "warning");
      assert.strictEqual(parsed.authStatus, "unknown");
    });
  });
});
