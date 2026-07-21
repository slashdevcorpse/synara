// FILE: containedClaudeSdkProcess.ts
// Purpose: Applies Windows provider containment to every Claude Agent SDK subprocess.
// Layer: Server provider process supervision

import {
  spawn as spawnChildProcess,
  type ChildProcess,
  type SpawnOptions as NodeSpawnOptions,
} from "node:child_process";

import type { SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";

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

export function spawnContainedClaudeSdkProcess(
  options: ClaudeSpawnOptions,
  dependencies: ContainedClaudeSdkProcessDependencies = {},
): ChildProcess {
  const prepareProcess = dependencies.prepareProcess ?? prepareWindowsProviderProcess;
  const spawnProcess = dependencies.spawnProcess ?? spawnChildProcess;
  const processInput: WindowsProviderProcessInput = {
    cwd: options.cwd,
    env: options.env,
  };
  const prepared = prepareProcess(options.command, options.args, processInput);

  return markWindowsProviderProcessSpawn(
    spawnProcess(prepared.command, prepared.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      signal: options.signal,
      shell: prepared.shell,
      ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    }),
    prepared,
    dependencies.spawnProcess === undefined,
  );
}
