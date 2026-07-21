import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { spawnContainedClaudeSdkProcess } from "./containedClaudeSdkProcess.ts";

describe("spawnContainedClaudeSdkProcess", () => {
  it("preserves the Claude SDK process contract through the contained command", () => {
    const child = {} as ChildProcess;
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
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Synara\\synara-windows-job-launcher.exe",
      ["--protocol", "1", "--", "C:\\tools\\claude.exe", "--version"],
      {
        cwd: "D:\\worktree",
        env,
        signal: controller.signal,
        shell: false,
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      },
    );
  });

  it("does not synthesize cwd or verbatim flags that preparation did not provide", () => {
    const child = {} as ChildProcess;
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

    spawnContainedClaudeSdkProcess(options, { prepareProcess, spawnProcess });

    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      ["--help"],
      expect.not.objectContaining({ cwd: expect.anything(), windowsVerbatimArguments: true }),
    );
  });
});
