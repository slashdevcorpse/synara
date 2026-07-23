import type { WindowsCommandDiscoveryObservation } from "@synara/shared/windowsProcess";
import { describe, expect, it } from "vitest";

import {
  containPreparedWindowsProviderProcess,
  isWindowsJobPreparedCommand,
  prepareResolvedWindowsProviderProcess,
  prepareWindowsProviderProcess,
  prepareWindowsProviderProcessAsync,
  resolveWindowsJobLauncherPath,
  WINDOWS_JOB_LAUNCHER_EXECUTABLE,
  WindowsProviderBatchShimLaunchError,
  WindowsProviderTargetNotResolvedError,
} from "./windowsProviderProcess.ts";

const launcher = `C:\\Synara\\native\\${WINDOWS_JOB_LAUNCHER_EXECUTABLE}`;
const shimPath = "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd";
const shimDirectory = "C:\\Users\\Test\\AppData\\Roaming\\npm";
const packageTarget =
  "C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
const pathNode = "C:\\Program Files\\nodejs\\node.exe";

function npmCmdShim(target = "node_modules\\@openai\\codex\\bin\\codex.js"): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
  ].join("\r\n");
}

function hostNpmCmdShim(): string {
  return `@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;
}

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

  it("turns a discovered canonical npm shim into Job -> native Node -> package target", () => {
    const observations: WindowsCommandDiscoveryObservation[] = [];
    const prepared = prepareWindowsProviderProcess(
      "codex",
      ["app-server", "--flag", "value with spaces"],
      {
        platform: "win32",
        arch: "x64",
        controlDirectory: "C:\\Temp",
        launcherPath: launcher,
        fileExists: (path) => [launcher, shimPath, packageTarget, pathNode].includes(path),
        readFileString: (path) => (path === shimPath ? npmCmdShim() : undefined),
        realPath: (path) => path,
        spawnSync: (_command, args) => {
          if (args[0] === "codex") {
            return { stdout: `${shimPath}\r\n`, status: 0 };
          }
          if (args[0] === "node") {
            return { stdout: `${pathNode}\r\n`, status: 0 };
          }
          return { stdout: "", status: 1 };
        },
        onCommandDiscovery: (observation) => observations.push(observation),
      },
    );

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
        pathNode,
        packageTarget,
        "app-server",
        "--flag",
        "value with spaces",
      ],
      shell: false,
      windowsHide: true,
    });
    expect(prepared.windowsVerbatimArguments).toBeUndefined();
    expect(prepared.args.join(" ").toLowerCase()).not.toContain("cmd.exe");
    expect(observations).toEqual([{ outcome: "resolved", source: "where" }]);
  });

  it("asynchronously resolves canonical npm shims and skips an earlier node.cmd candidate", async () => {
    const nodeShim = "C:\\tools\\node.cmd";
    const execFileCalls: string[] = [];
    let eventLoopAdvanced = false;
    let synchronousDiscoveryCalls = 0;
    const preparing = prepareWindowsProviderProcessAsync(
      "codex",
      ["app-server", "--flag", "value with spaces"],
      {
        platform: "win32",
        arch: "x64",
        controlDirectory: "C:\\Temp",
        launcherPath: launcher,
        fileExists: (path) =>
          [launcher, shimPath, packageTarget, nodeShim, pathNode].includes(path),
        readFileString: (path) => (path === shimPath ? npmCmdShim() : undefined),
        realPath: (path) => path,
        execFile: async (_command, args) => {
          execFileCalls.push(args[0] ?? "");
          await new Promise<void>((resolve) => setImmediate(resolve));
          return args[0] === "codex"
            ? { stdout: `${shimPath}\r\n`, status: 0 }
            : args[0] === "node"
              ? { stdout: `${nodeShim}\r\n${pathNode}\r\n`, status: 0 }
              : { stdout: "", status: 1 };
        },
        spawnSync: () => {
          synchronousDiscoveryCalls += 1;
          throw new Error("the async provider path must never invoke spawnSync");
        },
      },
    );
    queueMicrotask(() => {
      eventLoopAdvanced = true;
    });

    await Promise.resolve();
    expect(eventLoopAdvanced).toBe(true);
    const prepared = await preparing;

    expect(execFileCalls).toEqual(["codex", "node"]);
    expect(synchronousDiscoveryCalls).toBe(0);
    expect(prepared.args.slice(7)).toEqual([
      pathNode,
      packageTarget,
      "app-server",
      "--flag",
      "value with spaces",
    ]);
    expect(prepared.args.join(" ").toLowerCase()).not.toContain("cmd.exe");
    expect(prepared.windowsVerbatimArguments).toBeUndefined();
  });

  it("fails closed instead of falling back to cold sync discovery after a transient Node prewarm", async () => {
    let synchronousDiscoveryCalls = 0;
    let failure: unknown;
    try {
      await prepareWindowsProviderProcessAsync("codex", ["--version"], {
        platform: "win32",
        arch: "x64",
        launcherPath: launcher,
        fileExists: (path) => [launcher, shimPath, packageTarget].includes(path),
        readFileString: (path) => (path === shimPath ? npmCmdShim() : undefined),
        realPath: (path) => path,
        execFile: async (_command, args) =>
          args[0] === "codex"
            ? { stdout: `${shimPath}\r\n`, status: 0 }
            : {
                error: Object.assign(new Error("where.exe timed out"), {
                  code: "ETIMEDOUT",
                }),
                stdout: "",
                status: null,
              },
        spawnSync: () => {
          synchronousDiscoveryCalls += 1;
          return { stdout: `${pathNode}\r\n`, status: 0 };
        },
      });
    } catch (cause) {
      failure = cause;
    }

    expect(synchronousDiscoveryCalls).toBe(0);
    expect(failure).toBeInstanceOf(WindowsProviderBatchShimLaunchError);
    expect((failure as WindowsProviderBatchShimLaunchError).reason).toBe("native_node_not_found");
  });

  it("prefers a verified sibling node.exe for npm's direct host .bat shim template", () => {
    const batShimPath = shimPath.replace(/\.cmd$/u, ".bat");
    const relativeBatShimPath = ".\\npm\\codex.bat";
    const siblingNode = `${shimDirectory}\\node.exe`;
    const spawnSync = () => {
      throw new Error("PATH node discovery must not run when sibling node.exe is verified");
    };
    const prepared = prepareResolvedWindowsProviderProcess(relativeBatShimPath, ["--version"], {
      platform: "win32",
      arch: "x64",
      cwd: "C:\\Users\\Test\\AppData\\Roaming",
      controlDirectory: "C:\\Temp",
      launcherPath: launcher,
      fileExists: (path) => [launcher, batShimPath, packageTarget, siblingNode].includes(path),
      readFileString: (path) => (path === batShimPath ? hostNpmCmdShim() : undefined),
      realPath: (path) => path,
      spawnSync,
    });

    expect(prepared.args.slice(7)).toEqual([siblingNode, packageTarget, "--version"]);
    expect(prepared.args[3]).toBe("argv");
    expect(prepared.windowsVerbatimArguments).toBeUndefined();
  });

  it.each([
    ["noncanonical wrapper", "@ECHO off\r\nCALL node arbitrary.js %*\r\n"],
    [
      "traversal target",
      hostNpmCmdShim().replace(
        "node_modules\\@openai\\codex\\bin\\codex.js",
        "node_modules\\@openai\\codex\\..\\escape.js",
      ),
    ],
  ])("fails closed for a %s", (_label, shimContents) => {
    expect(() =>
      prepareResolvedWindowsProviderProcess(shimPath, [], {
        platform: "win32",
        arch: "x64",
        launcherPath: launcher,
        fileExists: () => true,
        readFileString: () => shimContents,
        realPath: (path) => path,
      }),
    ).toThrow(
      expect.objectContaining({
        name: "WindowsProviderBatchShimLaunchError",
        reason: "shim_not_canonical_npm_node",
      }),
    );
  });

  it.each([
    {
      label: "missing package target",
      reason: "target_not_file",
      existingFiles: [launcher, shimPath],
      nodeDiscovery: { stdout: `${pathNode}\r\n`, status: 0 },
    },
    {
      label: "missing native Node runtime",
      reason: "native_node_not_found",
      existingFiles: [launcher, shimPath, packageTarget, "C:\\tools\\node.cmd"],
      nodeDiscovery: { stdout: "C:\\tools\\node.cmd\r\n", status: 0 },
    },
  ])("fails closed for a $label", ({ reason, existingFiles, nodeDiscovery }) => {
    let failure: unknown;
    try {
      prepareResolvedWindowsProviderProcess(shimPath, [], {
        platform: "win32",
        arch: "x64",
        launcherPath: launcher,
        fileExists: (path) => existingFiles.includes(path),
        readFileString: () => npmCmdShim(),
        realPath: (path) => path,
        spawnSync: () => nodeDiscovery,
      });
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(WindowsProviderBatchShimLaunchError);
    expect((failure as WindowsProviderBatchShimLaunchError).reason).toBe(reason);
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
