import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import {
  type ClaudeNodeProcessSpawner,
  protectContainedClaudeSdkProcessTermination,
  spawnContainedClaudeSdkProcess,
  teardownContainedClaudeSdkProcess,
} from "./containedClaudeSdkProcess.ts";
import { WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION } from "./windowsProviderProcess.ts";

describe("spawnContainedClaudeSdkProcess", () => {
  it("does not forward the SDK AbortSignal to a contained launcher", () => {
    const child = {} as ChildProcess;
    const controller = new AbortController();
    const env = { CLAUDE_CONFIG_DIR: "C:\\Users\\synara\\.claude" };
    const prepareProcess = vi.fn(() => ({
      command: "C:\\Synara\\synara-windows-job-launcher.exe",
      args: [
        "--protocol",
        WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
        "--argument-mode",
        "verbatim",
        "--",
        "C:\\tools\\claude.exe",
        "--version",
      ],
      shell: false as const,
      windowsHide: true as const,
      windowsVerbatimArguments: true as const,
      containment: "windows-job-object" as const,
    }));
    const spawnProcess = vi.fn<ClaudeNodeProcessSpawner>(() => child);
    const options = {
      command: "C:\\tools\\claude.exe",
      args: ["--version"],
      cwd: "D:\\worktree",
      env,
      signal: controller.signal,
    } as ClaudeSpawnOptions;

    expect(spawnContainedClaudeSdkProcess(options, { prepareProcess, spawnProcess })).toBe(child);
    expect(prepareProcess).toHaveBeenCalledWith("C:\\tools\\claude.exe", ["--version"], {
      cwd: "D:\\worktree",
      env,
      completionReceipt: "create",
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Synara\\synara-windows-job-launcher.exe",
      [
        "--protocol",
        WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
        "--argument-mode",
        "verbatim",
        "--",
        "C:\\tools\\claude.exe",
        "--version",
      ],
      {
        cwd: "D:\\worktree",
        env,
        shell: false,
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      },
    );
  });

  it("routes repeated SDK abort and kill requests through one awaitable teardown", async () => {
    const originalKill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), {
      pid: 73_312,
      exitCode: null,
      signalCode: null,
      kill: originalKill,
    }) as unknown as ChildProcess;
    const abort = new AbortController();
    const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));

    protectContainedClaudeSdkProcessTermination(child, abort.signal, teardown);
    expect(child.kill("SIGKILL")).toBe(true);
    abort.abort();
    await teardownContainedClaudeSdkProcess(child, teardown);

    expect(originalKill).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledOnce();
  });

  it("releases a rejected single-flight cleanup so the owner can retry proof", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 73_313,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const teardown = vi
      .fn(async () => ({ escalated: false, signalErrors: [] }))
      .mockRejectedValueOnce(new Error("transient controller failure"));
    protectContainedClaudeSdkProcessTermination(child, undefined, teardown);

    const first = teardownContainedClaudeSdkProcess(child, teardown);
    expect(teardownContainedClaudeSdkProcess(child, teardown)).toBe(first);
    await expect(first).rejects.toThrow("transient controller failure");
    await expect(teardownContainedClaudeSdkProcess(child, teardown)).resolves.toEqual({
      escalated: false,
      signalErrors: [],
    });
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it("withholds direct SDK cancellation without synthesizing unrelated spawn flags", () => {
    const child = {} as ChildProcess;
    const prepareProcess = vi.fn(() => ({
      command: "/usr/local/bin/claude",
      args: ["--help"],
      shell: false as const,
    }));
    const spawnProcess = vi.fn<ClaudeNodeProcessSpawner>(() => child);
    const options = {
      command: "/usr/local/bin/claude",
      args: ["--help"],
      env: { PATH: "/usr/local/bin" },
      signal: new AbortController().signal,
    } satisfies ClaudeSpawnOptions;

    spawnContainedClaudeSdkProcess(options, { prepareProcess, spawnProcess });

    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      ["--help"],
      expect.not.objectContaining({ signal: expect.anything() }),
    );
    expect(spawnProcess.mock.calls[0]?.[2]).not.toEqual(
      expect.objectContaining({ cwd: expect.anything(), windowsVerbatimArguments: true }),
    );
  });
});
