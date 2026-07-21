import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import {
  containedClaudeSdkProcessDidNotSpawn,
  containedClaudeSdkProcessSupervisionFailure,
  spawnContainedClaudeSdkProcess,
} from "./containedClaudeSdkProcess.ts";

describe("spawnContainedClaudeSdkProcess", () => {
  it("preserves the Claude SDK process contract through the contained command", () => {
    const child = { pid: 401 } as ChildProcess;
    const controller = new AbortController();
    const env = { CLAUDE_CONFIG_DIR: "C:\\Users\\synara\\.claude" };
    const prepareProcess = vi.fn(() => ({
      command: "C:\\Synara\\synara-windows-job-launcher.exe",
      args: ["--protocol", "1", "--", "C:\\tools\\claude.exe", "--version"],
      shell: false as const,
      windowsHide: true as const,
      windowsVerbatimArguments: true as const,
    }));
    const spawnProcess = vi.fn(() => child);
    const superviseProcess = vi.fn(() => ({
      rootPid: 401,
      proveExit: vi.fn(),
      requestTermination: vi.fn(),
      teardown: vi.fn(),
    }));
    const onSpawnedProcess = vi.fn();
    const options = {
      command: "C:\\tools\\claude.exe",
      args: ["--version"],
      cwd: "D:\\worktree",
      env,
      signal: controller.signal,
    } as ClaudeSpawnOptions;

    expect(
      spawnContainedClaudeSdkProcess(options, {
        platform: "linux",
        prepareProcess,
        spawnProcess,
        superviseProcess,
        onSpawnedProcess,
      }),
    ).toBe(child);
    expect(prepareProcess).toHaveBeenCalledWith("C:\\tools\\claude.exe", ["--version"], {
      cwd: "D:\\worktree",
      env,
      platform: "linux",
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Synara\\synara-windows-job-launcher.exe",
      ["--protocol", "1", "--", "C:\\tools\\claude.exe", "--version"],
      {
        cwd: "D:\\worktree",
        env,
        detached: true,
        signal: controller.signal,
        shell: false,
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      },
    );
    expect(onSpawnedProcess).toHaveBeenCalledWith({
      prepared: prepareProcess.mock.results[0]!.value,
      process: child,
      platform: "linux",
    });
    expect(superviseProcess).toHaveBeenCalledWith(prepareProcess.mock.results[0]!.value, child, {
      platform: "linux",
      ownedProcessGroupId: 401,
    });
    expect(onSpawnedProcess.mock.invocationCallOrder[0]).toBeLessThan(
      superviseProcess.mock.invocationCallOrder[0]!,
    );
  });

  it("does not synthesize cwd or verbatim flags that preparation did not provide", () => {
    const child = { pid: 402 } as ChildProcess;
    const prepareProcess = vi.fn(() => ({
      command: "/usr/local/bin/claude",
      args: ["--help"],
      shell: false as const,
    }));
    const spawnProcess = vi.fn(() => child);
    const options = {
      command: "/usr/local/bin/claude",
      args: ["--help"],
      env: { PATH: "/usr/local/bin" },
      signal: new AbortController().signal,
    } satisfies ClaudeSpawnOptions;

    spawnContainedClaudeSdkProcess(options, {
      platform: "linux",
      prepareProcess,
      spawnProcess,
      superviseProcess: () => ({
        rootPid: 402,
        proveExit: vi.fn(),
        requestTermination: vi.fn(),
        teardown: vi.fn(),
      }),
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      ["--help"],
      expect.not.objectContaining({ cwd: expect.anything(), windowsVerbatimArguments: true }),
    );
  });

  it("reports the provisional owner before supervisor construction can fail", () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 403,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const calls: string[] = [];
    const options = {
      command: "/usr/local/bin/claude",
      args: ["--help"],
      env: {},
      signal: new AbortController().signal,
    } satisfies ClaudeSpawnOptions;

    expect(() =>
      spawnContainedClaudeSdkProcess(options, {
        platform: "linux",
        prepareProcess: (command, args) => ({ command, args, shell: false }),
        spawnProcess: () => {
          calls.push("spawn");
          return child;
        },
        onSpawnedProcess: () => {
          calls.push("observe");
        },
        superviseProcess: () => {
          calls.push("supervise");
          throw new Error("supervisor construction failed");
        },
      }),
    ).toThrow("supervisor construction failed");
    expect(calls).toEqual(["spawn", "observe", "supervise"]);
  });

  it("observes a PID-less spawn before installing supervision", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined as number | undefined,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const superviseProcess = vi.fn(() => ({
      rootPid: 404,
      proveExit: vi.fn(),
      requestTermination: vi.fn(),
      teardown: vi.fn(),
    }));

    expect(
      spawnContainedClaudeSdkProcess(
        {
          command: "/usr/local/bin/claude",
          args: ["--help"],
          env: {},
          signal: new AbortController().signal,
        } satisfies ClaudeSpawnOptions,
        {
          platform: "linux",
          prepareProcess: (command, args) => ({ command, args, shell: false }),
          spawnProcess: () => child,
          superviseProcess,
        },
      ),
    ).toBe(child);
    expect(superviseProcess).not.toHaveBeenCalled();

    child.pid = 404;
    child.emit("spawn");
    await Promise.resolve();

    expect(superviseProcess).toHaveBeenCalledTimes(1);
  });

  it("surfaces deferred supervision failure without requiring a process error listener", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined as number | undefined,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const requestedFailure = new Error("deferred supervisor construction failed");
    const onSupervisionError = vi.fn();

    spawnContainedClaudeSdkProcess(
      {
        command: "/usr/local/bin/claude",
        args: ["--help"],
        env: {},
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions,
      {
        platform: "linux",
        prepareProcess: (command, args) => ({ command, args, shell: false }),
        spawnProcess: () => child,
        superviseProcess: () => {
          throw requestedFailure;
        },
        onSupervisionError,
      },
    );

    child.pid = 405;
    child.emit("spawn");
    await Promise.resolve();
    await Promise.resolve();

    expect(onSupervisionError).toHaveBeenCalledWith(requestedFailure);
    expect(containedClaudeSdkProcessSupervisionFailure(child)).toBe(requestedFailure);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("contains throwing and rejecting supervision callbacks without losing the original failure", async () => {
    for (const onSupervisionError of [
      () => {
        throw new Error("callback threw");
      },
      () => Promise.reject(new Error("callback rejected")),
    ]) {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined as number | undefined,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcess;
      const supervisionFailure = new Error("original deferred supervision failure");

      spawnContainedClaudeSdkProcess(
        {
          command: "/usr/local/bin/claude",
          args: [],
          env: {},
          signal: new AbortController().signal,
        } satisfies ClaudeSpawnOptions,
        {
          platform: "linux",
          prepareProcess: (command, args) => ({ command, args, shell: false }),
          spawnProcess: () => child,
          superviseProcess: () => {
            throw supervisionFailure;
          },
          onSupervisionError,
        },
      );

      child.pid = 406;
      child.emit("spawn");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(containedClaudeSdkProcessSupervisionFailure(child)).toBe(supervisionFailure);
      expect(child.listenerCount("error")).toBe(0);
    }
  });

  it("marks a PID-less spawn failure so callers do not attempt teardown without an owner", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined as number | undefined,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const superviseProcess = vi.fn();

    spawnContainedClaudeSdkProcess(
      {
        command: "/missing/claude",
        args: [],
        env: {},
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions,
      {
        platform: "linux",
        prepareProcess: (command, args) => ({ command, args, shell: false }),
        spawnProcess: () => child,
        superviseProcess,
      },
    );
    child.emit("error", new Error("spawn /missing/claude ENOENT"));
    await Promise.resolve();

    expect(containedClaudeSdkProcessDidNotSpawn(child)).toBe(true);
    expect(superviseProcess).not.toHaveBeenCalled();
  });
});
