import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  consumeWindowsJobEmptyExitProof,
  containPreparedWindowsProviderProcess,
  isWindowsJobContainedProviderProcess,
  markWindowsProviderProcessSpawn,
  prepareWindowsJobTerminationCommand,
  prepareResolvedWindowsProviderProcess,
  recordWindowsProviderProcessExit,
  resolveWindowsJobLauncherPath,
  WINDOWS_JOB_LAUNCHER_EXECUTABLE,
  WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
  windowsProviderProcessExitProofError,
} from "./windowsProviderProcess.ts";

const launcher = `C:\\Synara\\native\\${WINDOWS_JOB_LAUNCHER_EXECUTABLE}`;

describe("Windows provider process containment", () => {
  it("preserves non-Windows launches exactly", () => {
    const prepared = { command: "/usr/bin/codex", args: ["app-server"], shell: false as const };

    expect(
      containPreparedWindowsProviderProcess(prepared, {
        platform: "linux",
      }),
    ).toBe(prepared);
  });

  it("wraps a one-shot executable in the versioned argv protocol without a receipt", () => {
    expect(
      prepareResolvedWindowsProviderProcess(
        "C:\\Program Files\\Codex\\codex.exe",
        ["app-server", "--flag", "value with spaces"],
        {
          platform: "win32",
          arch: "x64",
          launcherPath: launcher,
          fileExists: () => true,
        },
      ),
    ).toEqual({
      command: launcher,
      args: [
        "--protocol",
        WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
        "--argument-mode",
        "argv",
        "--",
        "C:\\Program Files\\Codex\\codex.exe",
        "app-server",
        "--flag",
        "value with spaces",
      ],
      shell: false,
      windowsHide: true,
      containment: "windows-job-object",
    });
  });

  it("adds an exact nonce receipt only for a supervised launch", () => {
    const completionReceipt = {
      path: "C:\\Temp\\synara-job-proof.receipt",
      token: "supervised-job-proof",
    };
    const windowsJobName = "synara-job-proof-test";
    const prepared = prepareResolvedWindowsProviderProcess(
      "C:\\Program Files\\Codex\\codex.exe",
      ["app-server"],
      {
        platform: "win32",
        arch: "x64",
        launcherPath: launcher,
        fileExists: () => true,
        completionReceipt,
        windowsJobName,
      },
    );
    expect(prepared.windowsTerminationEventName).toMatch(
      /^synara-windows-job-termination-[0-9a-f-]+$/u,
    );

    expect(prepared).toEqual({
      command: launcher,
      args: [
        "--protocol",
        WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
        "--argument-mode",
        "argv",
        "--job-name",
        windowsJobName,
        "--termination-event",
        prepared.windowsTerminationEventName,
        "--completion-receipt",
        completionReceipt.path,
        "--receipt-token",
        completionReceipt.token,
        "--",
        "C:\\Program Files\\Codex\\codex.exe",
        "app-server",
      ],
      shell: false,
      windowsHide: true,
      containment: "windows-job-object",
      completionReceipt,
      windowsJobName,
      windowsTerminationEventName: prepared.windowsTerminationEventName,
    });
  });

  it("retains only the exact owner-event signal command for supervised termination", () => {
    const process = { pid: 4321 };
    markWindowsProviderProcessSpawn(
      process,
      {
        command: launcher,
        args: [],
        shell: false,
        containment: "windows-job-object",
        windowsJobName: "diagnostic-job-name-is-not-a-capability",
        windowsTerminationEventName: "synara-owner-termination-test",
      },
      true,
    );

    expect(prepareWindowsJobTerminationCommand(process)).toEqual({
      command: launcher,
      args: [
        "--protocol",
        WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
        "--signal-termination-event",
        "synara-owner-termination-test",
        "--launcher-pid",
        "4321",
      ],
    });
  });

  it("marks only a child spawned from an explicitly contained command", () => {
    const containedChild = {};
    const injectedChild = {};
    const ordinaryChild = {};
    const contained = prepareResolvedWindowsProviderProcess(
      "C:\\Program Files\\Codex\\codex.exe",
      ["app-server"],
      {
        platform: "win32",
        arch: "x64",
        launcherPath: launcher,
        fileExists: () => true,
      },
    );
    const ordinary = containPreparedWindowsProviderProcess(
      { command: "/usr/bin/codex", args: ["app-server"], shell: false },
      { platform: "linux" },
    );

    markWindowsProviderProcessSpawn(containedChild, contained, true);
    markWindowsProviderProcessSpawn(injectedChild, contained, false);
    markWindowsProviderProcessSpawn(ordinaryChild, ordinary, true);

    expect(isWindowsJobContainedProviderProcess(containedChild)).toBe(true);
    expect(isWindowsJobContainedProviderProcess(injectedChild)).toBe(false);
    expect(isWindowsJobContainedProviderProcess(ordinaryChild)).toBe(false);
  });

  it("does not accept any preplanted receipt for an arbitrary object", () => {
    const receiptDirectory = mkdtempSync(join(tmpdir(), "synara-job-proof-"));
    const completionReceipt = {
      path: join(receiptDirectory, "job-empty.receipt"),
      token: "exact-job-empty-token",
    };
    const child = {};
    writeFileSync(completionReceipt.path, `${completionReceipt.token}\n1234\n`, "utf8");
    markWindowsProviderProcessSpawn(
      child,
      {
        command: launcher,
        args: [],
        shell: false,
        containment: "windows-job-object",
        completionReceipt,
      },
      true,
    );

    try {
      expect(consumeWindowsJobEmptyExitProof(child)).toBe(false);
      expect(existsSync(completionReceipt.path)).toBe(true);
      expect(windowsProviderProcessExitProofError(child)?.message).toContain(
        "without proving that its Job reached zero active processes",
      );
    } finally {
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("requires explicit exit observation before a structural handle can prove its pid-bound receipt", () => {
    const receiptDirectory = mkdtempSync(join(tmpdir(), "synara-job-proof-"));
    const completionReceipt = {
      path: join(receiptDirectory, "effect-handle.receipt"),
      token: "effect-handle-exact-exit-proof",
    };
    const child = { pid: 4321 };
    writeFileSync(completionReceipt.path, `${completionReceipt.token}\n${child.pid}\n`, "utf8");
    markWindowsProviderProcessSpawn(
      child,
      {
        command: launcher,
        args: [],
        shell: false,
        containment: "windows-job-object",
        completionReceipt,
      },
      true,
    );

    try {
      expect(consumeWindowsJobEmptyExitProof(child)).toBe(false);
      expect(existsSync(completionReceipt.path)).toBe(true);
      expect(recordWindowsProviderProcessExit(child)).toBe(true);
      expect(existsSync(completionReceipt.path)).toBe(false);
      expect(consumeWindowsJobEmptyExitProof(child)).toBe(true);
    } finally {
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a token-only receipt after the exact launcher handle exits", async () => {
    const receiptDirectory = mkdtempSync(join(tmpdir(), "synara-job-proof-"));
    const completionReceipt = {
      path: join(receiptDirectory, "token-only.receipt"),
      token: "token-alone-is-not-instance-proof",
    };
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    writeFileSync(completionReceipt.path, `${completionReceipt.token}\n`, "utf8");
    markWindowsProviderProcessSpawn(
      child,
      {
        command: launcher,
        args: [],
        shell: false,
        containment: "windows-job-object",
        completionReceipt,
      },
      true,
    );

    try {
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      expect(existsSync(completionReceipt.path)).toBe(false);
      expect(consumeWindowsJobEmptyExitProof(child)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("removes and caches a real Node child's receipt as soon as the child exits", async () => {
    const receiptDirectory = mkdtempSync(join(tmpdir(), "synara-job-proof-"));
    const completionReceipt = {
      path: join(receiptDirectory, "job-empty.receipt"),
      token: "natural-node-exit-proof",
    };
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error("expected spawned child pid");
    writeFileSync(completionReceipt.path, `${completionReceipt.token}\n${child.pid}\n`, "utf8");
    markWindowsProviderProcessSpawn(
      child,
      {
        command: launcher,
        args: [],
        shell: false,
        containment: "windows-job-object",
        completionReceipt,
      },
      true,
    );

    try {
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      expect(existsSync(completionReceipt.path)).toBe(false);
      expect(consumeWindowsJobEmptyExitProof(child)).toBe(true);
      expect(consumeWindowsJobEmptyExitProof(child)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("returns a stable fail-closed error for a contained exit without a receipt", () => {
    const receiptDirectory = mkdtempSync(join(tmpdir(), "synara-job-proof-"));
    const child = {};
    markWindowsProviderProcessSpawn(
      child,
      {
        command: launcher,
        args: [],
        shell: false,
        containment: "windows-job-object",
        completionReceipt: {
          path: join(receiptDirectory, "missing.receipt"),
          token: "missing-job-proof",
        },
      },
      true,
    );

    try {
      expect(windowsProviderProcessExitProofError(child)?.message).toContain(
        "without proving that its Job reached zero active processes",
      );
      expect(windowsProviderProcessExitProofError(child)?.message).toContain(
        "without proving that its Job reached zero active processes",
      );
    } finally {
      rmSync(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("preserves the existing cmd.exe verbatim argument mode", () => {
    expect(
      containPreparedWindowsProviderProcess(
        {
          command: "C:\\Windows\\System32\\cmd.exe",
          args: ["/d", "/s", "/v:off", "/c", 'call "C:\\tools\\agent.cmd" "hello"'],
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
        {
          platform: "win32",
          arch: "arm64",
          launcherPath: launcher,
          fileExists: () => true,
        },
      ).args,
    ).toEqual([
      "--protocol",
      WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
      "--argument-mode",
      "verbatim",
      "--",
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\tools\\agent.cmd" "hello"',
    ]);
  });

  it("resolves an explicit relative target against the provider cwd", () => {
    const wrapped = containPreparedWindowsProviderProcess(
      { command: ".\\bin\\agent.exe", args: [], shell: false },
      {
        platform: "win32",
        arch: "x64",
        cwd: "D:\\work",
        launcherPath: launcher,
        fileExists: () => true,
      },
    );

    expect(wrapped.args[5]).toBe("D:\\work\\bin\\agent.exe");
  });

  it("qualifies a drive-rooted target against the provider cwd drive", () => {
    const wrapped = containPreparedWindowsProviderProcess(
      { command: "\\tools\\agent.exe", args: [], shell: false },
      {
        platform: "win32",
        arch: "x64",
        cwd: "D:\\work\\repo",
        launcherPath: launcher,
        fileExists: () => true,
      },
    );

    expect(wrapped.args[5]).toBe("D:\\tools\\agent.exe");
  });

  it.each([
    ["drive-absolute", "C:\\tools\\agent.exe", "D:\\work", "C:\\tools\\agent.exe"],
    [
      "UNC absolute",
      "\\\\server\\share\\tools\\agent.exe",
      "D:\\work",
      "\\\\server\\share\\tools\\agent.exe",
    ],
    [
      "drive-rooted on UNC cwd",
      "\\tools\\agent.exe",
      "\\\\server\\share\\work",
      "\\\\server\\share\\tools\\agent.exe",
    ],
  ])("keeps %s targets launcher-valid across host platforms", (_label, command, cwd, expected) => {
    const wrapped = containPreparedWindowsProviderProcess(
      { command, args: [], shell: false },
      {
        platform: "win32",
        arch: "x64",
        cwd,
        launcherPath: launcher,
        fileExists: () => true,
      },
    );

    expect(wrapped.args[5]).toBe(expected);
  });

  it("fails closed when a drive-rooted target has no absolute Windows cwd", () => {
    expect(() =>
      containPreparedWindowsProviderProcess(
        { command: "\\tools\\agent.exe", args: [], shell: false },
        {
          platform: "win32",
          arch: "x64",
          cwd: "relative-worktree",
          launcherPath: launcher,
          fileExists: () => true,
        },
      ),
    ).toThrow("no absolute Windows cwd was available");
  });

  it("fails closed when a bare provider command was not resolved", () => {
    expect(() =>
      containPreparedWindowsProviderProcess(
        { command: "codex", args: [], shell: false },
        {
          platform: "win32",
          arch: "x64",
          launcherPath: launcher,
          fileExists: () => true,
        },
      ),
    ).toThrow("was not resolved to an absolute executable path");
  });

  it("fails closed when the architecture-specific helper is absent", () => {
    expect(() =>
      resolveWindowsJobLauncherPath({
        platform: "win32",
        arch: "x64",
        launcherPath: launcher,
        fileExists: () => false,
      }),
    ).toThrow(/Refusing to fall back to a post-spawn, racy process-tree capture/);
  });
});
