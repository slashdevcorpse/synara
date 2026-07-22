// FILE: containedClaudeSdkProcess.ts
// Purpose: Applies Windows provider containment to every Claude Agent SDK subprocess.
// Layer: Server provider process supervision

import {
  spawn as spawnChildProcess,
  type ChildProcess,
  type SpawnOptions as NodeSpawnOptions,
} from "node:child_process";

import type { SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { teardownChildProcessTree } from "./supervisedProcessTeardown.ts";
import {
  markWindowsProviderProcessSpawn,
  prepareWindowsProviderProcess,
  type WindowsProviderProcessInput,
} from "./windowsProviderProcess.ts";

export type ClaudeNodeProcessSpawner = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeSpawnOptions,
) => ChildProcess;

export interface ContainedClaudeSdkProcessDependencies {
  readonly prepareProcess?: typeof prepareWindowsProviderProcess;
  readonly spawnProcess?: ClaudeNodeProcessSpawner;
}

type ClaudeProcessTeardown = () => Promise<unknown>;

interface ContainedClaudeSdkProcessTerminationState {
  cleanup: Promise<unknown> | undefined;
}

const containedClaudeSdkProcessTermination = new WeakMap<
  object,
  ContainedClaudeSdkProcessTerminationState
>();

/**
 * Starts one shared process-tree teardown for every SDK abort/kill and explicit owner cleanup.
 * Successful proof remains cached; a failed single-flight attempt is observable by its callers and
 * then released so the owning lifecycle can retry a transient termination failure.
 */
export function teardownContainedClaudeSdkProcess(
  process: ChildProcess,
  teardown: ClaudeProcessTeardown = () => teardownChildProcessTree(process),
): Promise<unknown> {
  const state = containedClaudeSdkProcessTermination.get(process);
  if (!state) return Promise.resolve().then(teardown);
  if (!state.cleanup) {
    const cleanup = Promise.resolve().then(teardown);
    state.cleanup = cleanup;
    void cleanup.catch(() => {
      if (state.cleanup === cleanup) state.cleanup = undefined;
    });
  }
  return state.cleanup;
}

/**
 * Prevents the Claude SDK from externally killing a provider root before Synara captures its
 * process tree. SDK abort and kill requests instead begin the same supervised teardown that the
 * owning adapter later awaits; Windows teardown additionally requires the exact Job-empty receipt.
 */
export function protectContainedClaudeSdkProcessTermination(
  process: ChildProcess,
  abortSignal: AbortSignal | undefined,
  teardown: ClaudeProcessTeardown = () => teardownChildProcessTree(process),
): ChildProcess {
  if (containedClaudeSdkProcessTermination.has(process)) return process;

  containedClaudeSdkProcessTermination.set(process, { cleanup: undefined });
  const beginTeardown = () => {
    void teardownContainedClaudeSdkProcess(process, teardown).catch(() => undefined);
  };
  const originalKill = process.kill.bind(process);
  process.kill = ((signal?: NodeJS.Signals | number): boolean => {
    if (signal === 0) return originalKill(signal);
    if (process.exitCode !== null || process.signalCode !== null) return false;
    beginTeardown();
    return true;
  }) as ChildProcess["kill"];

  if (abortSignal) {
    const removeAbortListener = () => abortSignal.removeEventListener("abort", beginTeardown);
    process.once("exit", removeAbortListener);
    if (abortSignal.aborted) beginTeardown();
    else abortSignal.addEventListener("abort", beginTeardown, { once: true });
  }
  return process;
}

export function spawnContainedClaudeSdkProcess(
  options: ClaudeSpawnOptions,
  dependencies: ContainedClaudeSdkProcessDependencies = {},
): ChildProcess {
  const prepareProcess = dependencies.prepareProcess ?? prepareWindowsProviderProcess;
  const spawnProcess = dependencies.spawnProcess ?? spawnChildProcess;
  const processInput: WindowsProviderProcessInput = {
    cwd: options.cwd,
    env: options.env,
    completionReceipt: "create",
  };
  const prepared = prepareProcess(options.command, options.args, processInput);
  const ownsSpawn = dependencies.spawnProcess === undefined;
  const child = markWindowsProviderProcessSpawn(
    spawnProcess(prepared.command, prepared.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      shell: prepared.shell,
      ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    }),
    prepared,
    ownsSpawn,
  );
  return ownsSpawn ? protectContainedClaudeSdkProcessTermination(child, options.signal) : child;
}
