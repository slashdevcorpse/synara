import { describe, expect, it } from "vitest";

import {
  containPreparedWindowsProviderProcess,
  prepareResolvedWindowsProviderProcess,
  resolveWindowsJobLauncherPath,
  WINDOWS_JOB_LAUNCHER_EXECUTABLE,
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
        "1",
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
          launcherPath: launcher,
          fileExists: () => true,
        },
      ).args,
    ).toEqual([
      "--protocol",
      "1",
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
