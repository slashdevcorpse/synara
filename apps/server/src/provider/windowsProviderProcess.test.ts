import type { WindowsCommandDiscoveryObservation } from "@synara/shared/windowsProcess";
import { describe, expect, it } from "vitest";

import {
  containPreparedWindowsProviderProcess,
  isWindowsJobPreparedCommand,
  prepareResolvedWindowsProviderProcess,
  prepareWindowsProviderProcess,
  resolveWindowsJobLauncherPath,
  WINDOWS_JOB_LAUNCHER_EXECUTABLE,
  WindowsProviderTargetNotResolvedError,
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

  it("wraps a resolved executable in the versioned argv protocol", () => {
    const prepared = prepareResolvedWindowsProviderProcess(
      "C:\\Program Files\\Codex\\codex.exe",
      ["app-server", "--flag", "value with spaces"],
      {
        platform: "win32",
        arch: "x64",
        controlDirectory: "C:\\Temp",
        launcherPath: launcher,
        fileExists: () => true,
      },
    );
    expect(isWindowsJobPreparedCommand(prepared)).toBe(true);
    expect(prepared).toEqual({
      command: launcher,
      args: [
        "--protocol",
        "2",
        "--argument-mode",
        "argv",
        "--control-file",
        expect.stringMatching(/^C:\\Temp\\synara-job-control-/u),
        "--",
        "C:\\Program Files\\Codex\\codex.exe",
        "app-server",
        "--flag",
        "value with spaces",
      ],
      shell: false,
      windowsHide: true,
    });
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
          controlDirectory: "C:\\Temp",
          launcherPath: launcher,
          fileExists: () => true,
        },
      ).args,
    ).toEqual([
      "--protocol",
      "2",
      "--argument-mode",
      "verbatim",
      "--control-file",
      expect.stringMatching(/^C:\\Temp\\synara-job-control-/u),
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

    expect(wrapped.args[7]).toBe("D:\\work\\bin\\agent.exe");
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

    expect(wrapped.args[7]).toBe("D:\\tools\\agent.exe");
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

    expect(wrapped.args[7]).toBe(expected);
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

  it("preserves a definitive not-found discovery outcome and forwards the observer", () => {
    const observations: WindowsCommandDiscoveryObservation[] = [];
    let failure: unknown;

    try {
      prepareWindowsProviderProcess("codex", [], {
        platform: "win32",
        arch: "x64",
        launcherPath: launcher,
        fileExists: () => true,
        spawnSync: () => ({ stdout: "", status: 1 }),
        onCommandDiscovery: (observation) => observations.push(observation),
      });
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(WindowsProviderTargetNotResolvedError);
    expect((failure as WindowsProviderTargetNotResolvedError).discoveryOutcome).toBe("not_found");
    expect(observations).toEqual([{ outcome: "not_found", source: "where" }]);
  });

  it("preserves a transient discovery failure without weakening containment", () => {
    const observations: WindowsCommandDiscoveryObservation[] = [];
    let failure: unknown;

    try {
      prepareWindowsProviderProcess("codex", [], {
        platform: "win32",
        arch: "x64",
        launcherPath: launcher,
        fileExists: () => true,
        spawnSync: () => ({
          error: Object.assign(new Error("where.exe timed out"), { code: "ETIMEDOUT" }),
          stdout: "",
          status: null,
        }),
        onCommandDiscovery: (observation) => observations.push(observation),
      });
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(WindowsProviderTargetNotResolvedError);
    expect((failure as WindowsProviderTargetNotResolvedError).discoveryOutcome).toBe(
      "transient_failure",
    );
    expect(observations).toEqual([{ outcome: "transient_failure", source: "where" }]);
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
