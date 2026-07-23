// FILE: containedClaudeSdkProcess.ts
// Purpose: Applies Windows provider containment to every Claude Agent SDK subprocess.
// Layer: Server provider process supervision

import {
  spawn as spawnChildProcess,
  type ChildProcess,
  type SpawnOptions as NodeSpawnOptions,
} from "node:child_process";

import type { SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { createWindowsCommandDiscoveryCache } from "@synara/shared/windowsProcess";

import {
  prepareWindowsProviderProcessAsync,
  prepareWindowsProviderProcess,
  type WindowsProviderProcessInput,
} from "./windowsProviderProcess.ts";
import {
  installPreparedNodeProcessSupervisor,
  observeNodeProviderProcessSpawn,
  supervisePreparedNodeProcess,
} from "./windowsJobProcessSupervisor.ts";

export type ClaudeNodeProcessSpawner = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeSpawnOptions,
) => ChildProcess;

export interface ContainedClaudeSdkProcessDependencies {
  readonly prepareProcess?: typeof prepareWindowsProviderProcess;
  readonly spawnProcess?: ClaudeNodeProcessSpawner;
  readonly superviseProcess?: typeof supervisePreparedNodeProcess;
  readonly platform?: NodeJS.Platform;
  readonly onSpawnedProcess?: (input: {
    readonly prepared: ReturnType<typeof prepareWindowsProviderProcess>;
    readonly process: ChildProcess;
    readonly platform: NodeJS.Platform;
  }) => void;
  readonly onSupervisionError?: (cause: Error) => void | PromiseLike<unknown>;
}

export interface ContainedClaudeSdkProcessPreparation {
  readonly platform: NodeJS.Platform;
  readonly prepareProcess: typeof prepareWindowsProviderProcess;
}

export interface PrepareContainedClaudeSdkProcessDependencies {
  readonly prepareProcessAsync?: typeof prepareWindowsProviderProcessAsync;
}

/**
 * Pre-resolves the Claude executable and any canonical npm-shim Node runtime
 * before the Agent SDK enters its synchronous spawn callback. The returned
 * callback preparer can consume only this exact isolated cache; a mismatched
 * command or missing prewarm fails closed instead of performing `spawnSync`.
 */
export async function prepareContainedClaudeSdkProcess(
  command: string,
  input: WindowsProviderProcessInput = {},
  dependencies: PrepareContainedClaudeSdkProcessDependencies = {},
): Promise<ContainedClaudeSdkProcessPreparation> {
  const platform = input.platform ?? globalThis.process.platform;
  if (platform !== "win32") {
    return {
      platform,
      prepareProcess: (spawnCommand, args) => ({
        command: spawnCommand,
        args: [...args],
        shell: false,
      }),
    };
  }

  const commandDiscoveryCache = input.commandDiscoveryCache ?? createWindowsCommandDiscoveryCache();
  await (dependencies.prepareProcessAsync ?? prepareWindowsProviderProcessAsync)(command, [], {
    ...input,
    platform,
    commandDiscoveryCache,
  });
  return {
    platform,
    prepareProcess: (spawnCommand, args, spawnInput = {}) =>
      prepareWindowsProviderProcess(spawnCommand, args, {
        ...input,
        ...spawnInput,
        platform,
        commandDiscoveryCache,
        commandDiscoveryMode: "cache-only",
      }),
  };
}

const containedClaudeProcessesWithoutPid = new WeakSet<ChildProcess>();
const containedClaudeProcessSupervisionFailures = new WeakMap<ChildProcess, Error>();

export function containedClaudeSdkProcessDidNotSpawn(process: ChildProcess): boolean {
  return containedClaudeProcessesWithoutPid.has(process);
}

export function containedClaudeSdkProcessSupervisionFailure(
  process: ChildProcess,
): Error | undefined {
  return containedClaudeProcessSupervisionFailures.get(process);
}

export function spawnContainedClaudeSdkProcess(
  options: ClaudeSpawnOptions,
  dependencies: ContainedClaudeSdkProcessDependencies = {},
): ChildProcess {
  const spawnProcess = dependencies.spawnProcess ?? spawnChildProcess;
  const platform = dependencies.platform ?? globalThis.process.platform;
  const prepareProcess: typeof prepareWindowsProviderProcess =
    dependencies.prepareProcess ??
    ((command: string, args: ReadonlyArray<string>) => {
      if (platform === "win32") {
        throw new Error(
          "Claude's synchronous SDK spawn callback requires async Windows process prewarming.",
        );
      }
      return { command, args: [...args], shell: false as const };
    });
  const processInput: WindowsProviderProcessInput = {
    cwd: options.cwd,
    env: options.env,
    platform,
  };
  const prepared = prepareProcess(options.command, options.args, processInput);

  const process = spawnProcess(prepared.command, prepared.args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    detached: platform !== "win32",
    signal: options.signal,
    shell: prepared.shell,
    ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const spawnOutcome = observeNodeProviderProcessSpawn(process);
  dependencies.onSpawnedProcess?.({ prepared, process, platform });
  const installSupervisor = (): void => {
    const installation = installPreparedNodeProcessSupervisor(
      prepared,
      process,
      {
        platform,
        ...(platform === "win32" ? {} : { ownedProcessGroupId: Number(process.pid) }),
      },
      dependencies.superviseProcess,
    );
    if (installation._tag === "Recovered") {
      throw installation.requestedSupervisorFailure;
    }
  };
  const rootPid = Number(process.pid);
  if (Number.isInteger(rootPid) && rootPid > 0) {
    installSupervisor();
  } else {
    // The SDK spawner contract is synchronous. Keep the returned ChildProcess observable while
    // deferring supervision until Node publishes a real PID; the observer was attached before any
    // caller or injected supervisor could miss a spawn failure.
    void spawnOutcome
      .then((outcome) => {
        if (outcome._tag === "Spawned") {
          installSupervisor();
          return;
        }
        containedClaudeProcessesWithoutPid.add(process);
      })
      .catch((cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause), { cause });
        containedClaudeProcessSupervisionFailures.set(process, error);
        const notify = dependencies.onSupervisionError;
        if (!notify) return;
        try {
          void Promise.resolve(notify(error)).catch(() => undefined);
        } catch {
          // The original supervision failure is retained above. Callback defects must not create
          // a second unhandled failure on the deferred spawn-observer promise.
        }
      });
  }
  return process;
}
