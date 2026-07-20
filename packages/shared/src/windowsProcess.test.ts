// FILE: windowsProcess.test.ts
// Purpose: Verifies Windows process preparation avoids Node shell-mode deprecations.
// Layer: Shared Node runtime utility tests

import { spawnSync as spawnChildSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWindowsBatchCommandArgs,
  clearWindowsCommandDiscoveryCache,
  createWindowsCommandDiscoveryCache,
  foldWindowsAsciiCase,
  getWindowsCommandDiscoveryCacheStats,
  isWindowsBatchCommand,
  normalizeWindowsChildEnvironment,
  prepareResolvedWindowsSafeProcess,
  prepareWindowsSafeProcess,
  readEffectiveWindowsEnvironmentValue,
  resolveWindowsCommandCandidates,
  resolveWindowsCommandPath,
  resolveWindowsComSpec,
  resolveWindowsSystemRoot,
  type WindowsCommandDiscoveryObservation,
  type WindowsSafeProcessInput,
} from "./windowsProcess";

const WINDOWS_BATCH_FIXTURE_TEST_TIMEOUT_MS = 15_000;
const WINDOWS_WHERE_FIXTURE_PROCESS_TIMEOUT_MS = 10_000;
const WINDOWS_WHERE_FIXTURE_TEST_TIMEOUT_MS = 30_000;

describe("windowsProcess", () => {
  afterEach(() => {
    clearWindowsCommandDiscoveryCache();
    vi.restoreAllMocks();
  });

  it("normalizes Windows child environments by defined ordinal winners without mutation", () => {
    const caller = {
      Path: "C:\\mixed",
      path: "C:\\lower",
      PaTh: "C:\\alternating",
      PATH: "C:\\upper",
      PathExt: ".BAD",
      PATHEXT: "",
      SystemRoot: "C:\\discarded-windows",
      SYSTEMROOT: "D:\\Windows",
      ComSpec: "C:\\discarded-cmd.exe",
      COMSPEC: "",
      INVALID: " value with spaces ",
      UNDEFINED: undefined,
      İD: "capital-dotted",
      "i\u0307d": "combining-dot",
    } satisfies NodeJS.ProcessEnv;
    const before = { ...caller };

    const normalized = normalizeWindowsChildEnvironment(caller);

    expect(normalized).not.toBe(caller);
    expect(caller).toEqual(before);
    expect(Object.keys(normalized).filter((name) => name.toUpperCase() === "PATH")).toEqual([
      "PATH",
    ]);
    expect(readEffectiveWindowsEnvironmentValue(normalized, "PATH")).toBe("C:\\upper");
    expect(readEffectiveWindowsEnvironmentValue(normalized, "PATHEXT")).toBe("");
    expect(resolveWindowsSystemRoot(normalized)).toBe("D:\\Windows");
    expect(resolveWindowsComSpec(normalized)).toBe("D:\\Windows\\System32\\cmd.exe");
    expect(normalized.INVALID).toBe(" value with spaces ");
    expect(normalized.UNDEFINED).toBeUndefined();
    expect(normalized["İD"]).toBe("capital-dotted");
    expect(normalized["i\u0307d"]).toBe("combining-dot");
  });

  it("selects the first defined alias when the ordinal uppercase spelling is undefined", () => {
    const caller = {
      path: "C:\\lower",
      Path: "C:\\mixed",
      PATH: undefined,
      PaTh: "C:\\alternating",
    } satisfies NodeJS.ProcessEnv;

    expect(normalizeWindowsChildEnvironment(caller)).toEqual({ PaTh: "C:\\alternating" });
    expect(readEffectiveWindowsEnvironmentValue(caller, "PATH")).toBe("C:\\alternating");
    expect(caller).toEqual({
      path: "C:\\lower",
      Path: "C:\\mixed",
      PATH: undefined,
      PaTh: "C:\\alternating",
    });
  });

  it("folds only Windows ASCII case for shared path and environment identities", () => {
    expect(foldWindowsAsciiCase("C:\\TOOLS\\İD\\PATH")).toBe("c:\\tools\\İd\\path");
    expect(foldWindowsAsciiCase("i\u0307D")).toBe("i\u0307d");
  });

  it("leaves non-Windows commands shell-free and otherwise unchanged", () => {
    const spawnSync = vi.fn();
    const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
    expect(
      prepareWindowsSafeProcess("codex", ["app-server"], {
        platform: "darwin",
        commandDiscoveryCache,
        spawnSync,
      }),
    ).toEqual({ command: "codex", args: ["app-server"], shell: false });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({ size: 0 });
  });

  it("resolves Windows PATH commands through where.exe", () => {
    const spawnSync = vi.fn(() => ({
      stdout: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd\r\n",
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(spawnSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["codex"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("prefers .cmd over extensionless npm shims from where.exe", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("skips current-directory command hits from where.exe", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\projects\\synara\\codex.cmd",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("filters current-directory hits before preferring spawn-safe candidates", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\projects\\synara\\codex.cmd",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("uses process.cwd for current-directory filtering when cwd is omitted", () => {
    vi.spyOn(process, "cwd").mockReturnValue("C:\\projects\\synara");
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\projects\\synara\\codex.cmd",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(spawnSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["codex"],
      expect.objectContaining({ cwd: "C:\\projects\\synara" }),
    );
  });

  it("resolves extensionless path-like Windows shims before spawning", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("C:\\Users\\test\\AppData\\Roaming\\npm\\codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(spawnSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["C:\\Users\\test\\AppData\\Roaming\\npm\\codex"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("keeps explicit path-like Windows executables without resolving", () => {
    const spawnSync = vi.fn();

    expect(
      resolveWindowsCommandPath("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(
      resolveWindowsCommandPath("C:\\Program Files\\Codex\\codex.exe", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Program Files\\Codex\\codex.exe");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("wraps .cmd shims through cmd.exe without shell true", () => {
    const spawnSync = vi.fn(() => ({
      stdout: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd\r\n",
      status: 0,
    }));

    expect(
      prepareWindowsSafeProcess("codex", ["app-server"], {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        'call "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd" "app-server"',
      ],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });

  it.each([
    {
      configured: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
      candidates: [
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ],
      resolved: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
    },
    {
      configured: "custom-codex",
      candidates: ["C:\\tools\\custom-codex", "C:\\tools\\custom-codex.cmd"],
      resolved: "C:\\tools\\custom-codex.cmd",
    },
  ])(
    "resolves and wraps the explicit extensionless command $configured",
    ({ candidates, configured, resolved }) => {
      const spawnSync = vi.fn(() => ({
        stdout: candidates.join("\r\n"),
        status: 0,
      }));

      expect(
        prepareWindowsSafeProcess(configured, ["app-server"], {
          platform: "win32",
          cwd: "C:\\projects\\synara",
          env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
          spawnSync,
        }),
      ).toEqual({
        command: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/v:off", "/c", `call "${resolved}" "app-server"`],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    },
  );

  it("wraps a configured .cmd Codex path without truncating it", () => {
    const spawnSync = vi.fn();
    const customPath = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd";

    expect(
      prepareWindowsSafeProcess(customPath, ["app-server"], {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        'call "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd" "app-server"',
      ],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("wraps an already-resolved .cmd command without probing again", () => {
    const spawnSync = vi.fn();
    const resolved = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";

    expect(
      prepareResolvedWindowsSafeProcess(resolved, ["app-server"], {
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        spawnSync,
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", `call "${resolved}" "app-server"`],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("encodes one cmd.exe command line with quoted command and argument tokens", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\Users\\Test User\\npm\\tool.cmd", [
        "path with spaces",
        "flag=value",
      ]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\Users\\Test User\\npm\\tool.cmd" "path with spaces" "flag=value"',
    ]);
  });

  it("preserves literal quotes in existing Codex config arguments", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", [
        "exec",
        "--config",
        'approval_policy="never"',
        "--config",
        'model_reasoning_effort="high"',
      ]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\tools\\codex.cmd" "exec" "--config" "approval_policy=""never""" "--config" "model_reasoning_effort=""high"""',
    ]);
  });

  it("rejects batch tokens with cmd.exe control characters", () => {
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\bad%path\\codex.cmd", [])).toThrow(
      /Cannot safely execute Windows batch command/,
    );
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", ["one&two"])).toThrow(
      /Cannot safely execute Windows batch argument/,
    );
  });

  it("allows batch paths with spaces and parentheses", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\Program Files (x86)\\Tool\\tool.cmd", ["--version"]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\Program Files (x86)\\Tool\\tool.cmd" "--version"',
    ]);
  });

  it("quotes batch paths containing parentheses even without spaces", () => {
    expect(buildWindowsBatchCommandArgs("C:\\tools(x86)\\codex.cmd", ["--version"])).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\tools(x86)\\codex.cmd" "--version"',
    ]);
  });

  it.runIf(process.platform === "win32")(
    "preserves quoted Codex arguments through a real cmd.exe batch launch",
    () => {
      const root = mkdtempSync(Path.join(tmpdir(), "synara-windows-process-"));
      const commandDir = Path.join(root, "tools(x86)");
      const scriptPath = Path.join(commandDir, "capture.mjs");
      const commandPath = Path.join(commandDir, "codex.cmd");
      const expectedArgs = [
        "exec",
        "--config",
        'approval_policy="never"',
        "--config",
        'model_reasoning_effort="high"',
      ];

      try {
        mkdirSync(commandDir);
        writeFileSync(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
        writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0capture.mjs" %*\r\n`);

        const prepared = prepareWindowsSafeProcess(commandPath, expectedArgs, {
          platform: "win32",
          env: process.env,
        });
        const result = spawnChildSync(prepared.command, prepared.args, {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: prepared.windowsVerbatimArguments,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(expectedArgs);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
    WINDOWS_BATCH_FIXTURE_TEST_TIMEOUT_MS,
  );

  it("rejects batch tokens with line breaks", () => {
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", ["line\nbreak"])).toThrow(
      /Cannot safely execute Windows batch argument/,
    );
  });

  it("keeps resolved .exe commands direct", () => {
    const spawnSync = vi.fn(() => ({
      stdout: "C:\\Program Files\\Codex\\codex.exe\r\n",
      status: 0,
    }));

    expect(
      prepareWindowsSafeProcess("codex", ["--version"], {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toEqual({
      command: "C:\\Program Files\\Codex\\codex.exe",
      args: ["--version"],
      shell: false,
      windowsHide: true,
    });
  });

  it("keeps a configured native Codex executable path intact", () => {
    const spawnSync = vi.fn();

    expect(
      prepareWindowsSafeProcess(
        "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
        ["app-server"],
        {
          platform: "win32",
          cwd: "C:\\projects\\synara",
          env: { SystemRoot: "C:\\Windows" },
          spawnSync,
        },
      ),
    ).toEqual({
      command: "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
      args: ["app-server"],
      shell: false,
      windowsHide: true,
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  describe("Windows command discovery cache", () => {
    const cwd = "C:\\projects\\synara";
    const env = {
      PATH: "C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
    };
    const resolvedCommand = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";

    it("reuses a warm positive result without another where.exe launch", () => {
      let now = 0;
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache({ now: () => now });
      const observations: WindowsCommandDiscoveryObservation[] = [];
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      const input = {
        platform: "win32" as const,
        cwd,
        env,
        spawnSync,
        commandDiscoveryCache,
        onCommandDiscovery: (observation: WindowsCommandDiscoveryObservation) =>
          observations.push(observation),
      };

      const first = resolveWindowsCommandCandidates("codex", input);
      now = 1;
      const second = resolveWindowsCommandCandidates("codex", input);

      expect(first).toEqual([resolvedCommand]);
      expect(second).toEqual([resolvedCommand]);
      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(spawnSync).toHaveBeenCalledWith(
        "C:\\Windows\\System32\\where.exe",
        ["codex"],
        expect.objectContaining({
          maxBuffer: 256 * 1024,
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2_000,
          windowsHide: true,
        }),
      );
      expect(observations).toEqual([
        { outcome: "resolved", source: "where" },
        { outcome: "resolved", source: "cache" },
      ]);
    });

    it("shares cwd cache identity across trailing separators while preserving roots", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      const resolveAt = (command: string, workingDirectory: string) =>
        resolveWindowsCommandCandidates(command, {
          platform: "win32",
          cwd: workingDirectory,
          env,
          spawnSync,
          commandDiscoveryCache,
        });

      resolveAt("codex", "C:\\x");
      resolveAt("codex", "C:\\x\\");
      resolveAt("root-tool", "C:\\");
      resolveAt("root-tool", "C:\\\\");

      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({ size: 2 });
    });

    it("keeps quoted and whitespace-wrapped invalid cwd values cache-distinct", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      for (const workingDirectory of ["C:\\x", '"C:\\x"', " C:\\x "]) {
        resolveWindowsCommandCandidates("codex", {
          platform: "win32",
          cwd: workingDirectory,
          env,
          spawnSync,
          commandDiscoveryCache,
        });
      }

      expect(spawnSync).toHaveBeenCalledTimes(3);
      expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({ size: 3 });
    });

    it("expires positive results after 30 seconds", () => {
      let now = 0;
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache({ now: () => now });
      const spawnSync = vi
        .fn()
        .mockReturnValueOnce({ stdout: "C:\\tools\\first.cmd\r\n", status: 0 })
        .mockReturnValueOnce({ stdout: "C:\\tools\\second.cmd\r\n", status: 0 });
      const input = { platform: "win32" as const, cwd, env, spawnSync, commandDiscoveryCache };

      expect(resolveWindowsCommandCandidates("tool", input)).toEqual(["C:\\tools\\first.cmd"]);
      now = 29_999;
      expect(resolveWindowsCommandCandidates("tool", input)).toEqual(["C:\\tools\\first.cmd"]);
      now = 30_000;
      expect(resolveWindowsCommandCandidates("tool", input)).toEqual(["C:\\tools\\second.cmd"]);
      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({ size: 1 });
    });

    it("caches only authoritative empty status-1 misses for two seconds", () => {
      let now = 0;
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache({ now: () => now });
      const observations: WindowsCommandDiscoveryObservation[] = [];
      const spawnSync = vi
        .fn()
        .mockReturnValueOnce({ stdout: "", status: 1 })
        .mockReturnValueOnce({ stdout: `${resolvedCommand}\r\n`, status: 0 });
      const input = {
        platform: "win32" as const,
        cwd,
        env,
        spawnSync,
        commandDiscoveryCache,
        onCommandDiscovery: (observation: WindowsCommandDiscoveryObservation) =>
          observations.push(observation),
      };

      expect(resolveWindowsCommandCandidates("missing", input)).toEqual([]);
      now = 1_999;
      expect(resolveWindowsCommandCandidates("missing", input)).toEqual([]);
      now = 2_000;
      expect(resolveWindowsCommandCandidates("missing", input)).toEqual([resolvedCommand]);
      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(observations).toEqual([
        { outcome: "not_found", source: "where" },
        { outcome: "not_found", source: "cache" },
        { outcome: "resolved", source: "where" },
      ]);
    });

    it.each([
      {
        name: "spawn error",
        result: { error: new Error("spawn failed"), stdout: `${resolvedCommand}\r\n`, status: 0 },
      },
      {
        name: "timeout",
        result: {
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          stdout: "",
          status: null,
        },
      },
      {
        name: "output-limit error",
        result: {
          error: Object.assign(new Error("output limit"), { code: "ENOBUFS" }),
          stdout: `${resolvedCommand}\r\n`,
          status: 0,
        },
      },
      { name: "null status", result: { stdout: `${resolvedCommand}\r\n`, status: null } },
      { name: "status greater than one", result: { stdout: "", status: 2 } },
      { name: "status one with output", result: { stdout: `${resolvedCommand}\r\n`, status: 1 } },
      { name: "empty successful output", result: { stdout: "", status: 0 } },
      {
        name: "malformed relative output",
        result: { stdout: "relative\\codex.cmd\r\n", status: 0 },
      },
      {
        name: "truncated oversized output",
        result: { stdout: `C:\\${"a".repeat(256 * 1024)}\r\n`, status: 0 },
      },
    ])("retries immediately after transient $name", ({ result }) => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const observations: WindowsCommandDiscoveryObservation[] = [];
      const spawnSync = vi
        .fn()
        .mockReturnValueOnce(result)
        .mockReturnValueOnce({ stdout: `${resolvedCommand}\r\n`, status: 0 });
      const input = {
        platform: "win32" as const,
        cwd,
        env,
        spawnSync,
        commandDiscoveryCache,
        onCommandDiscovery: (observation: WindowsCommandDiscoveryObservation) =>
          observations.push(observation),
      };

      expect(resolveWindowsCommandCandidates("codex", input)).toEqual([]);
      expect(resolveWindowsCommandCandidates("codex", input)).toEqual([resolvedCommand]);
      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(observations).toEqual([
        { outcome: "transient_failure", source: "where" },
        { outcome: "resolved", source: "where" },
      ]);
    });

    it("invalidates for command, mode, cwd, PATH, PATHEXT, and SystemRoot changes", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      const baseInput = {
        platform: "win32" as const,
        cwd,
        env,
        spawnSync,
        commandDiscoveryCache,
      };

      resolveWindowsCommandCandidates("codex", baseInput);
      resolveWindowsCommandCandidates("codex", baseInput);
      resolveWindowsCommandCandidates("codex", {
        ...baseInput,
        env: { ...env, PATH: `D:\\tools;${env.PATH}` },
      });
      resolveWindowsCommandCandidates("codex", {
        ...baseInput,
        env: { ...env, PATHEXT: ".EXE;.CMD" },
      });
      resolveWindowsCommandCandidates("codex", { ...baseInput, cwd: "D:\\projects\\synara" });
      resolveWindowsCommandCandidates("codex", {
        ...baseInput,
        env: { ...env, SystemRoot: "D:\\Windows" },
      });
      resolveWindowsCommandCandidates("other", baseInput);
      resolveWindowsCommandCandidates(".\\codex", baseInput);
      resolveWindowsCommandCandidates("C:\\tools\\codex", baseInput);

      expect(spawnSync).toHaveBeenCalledTimes(8);
    });

    it("normalizes mixed-case env names and ASCII value case without folding non-ASCII", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const spawnSync = vi.fn(() => ({
        stdout: "D:\\Program Files\\工具\\codex.cmd\r\n",
        status: 0,
      }));

      expect(
        resolveWindowsCommandCandidates("CODEX", {
          platform: "win32",
          cwd: "D:\\Projects\\Synara",
          env: {
            pAtH: "D:\\Program Files\\工具\\bin;D:\\Tools",
            pAtHeXt: ".CMD;.EXE",
            sYsTeMrOoT: "D:\\Windows",
          },
          spawnSync,
          commandDiscoveryCache,
        }),
      ).toEqual(["D:\\Program Files\\工具\\codex.cmd"]);
      expect(
        resolveWindowsCommandCandidates("codex", {
          platform: "win32",
          cwd: "d:\\projects\\synara",
          env: {
            PATH: "d:\\program files\\工具\\bin;d:\\tools",
            PATHEXT: ".cmd;.exe",
            SYSTEMROOT: "d:\\windows",
          },
          spawnSync,
          commandDiscoveryCache,
        }),
      ).toEqual(["D:\\Program Files\\工具\\codex.cmd"]);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    });

    it("isolates Unicode-expanding and raw PATH/cwd identities in both lookup orders", () => {
      type InjectedVariant = {
        readonly command: string;
        readonly cwd: string;
        readonly env: NodeJS.ProcessEnv;
        readonly whereExe: string;
        readonly outcome: WindowsCommandDiscoveryObservation["outcome"];
        readonly candidates: readonly string[];
        readonly result: {
          readonly stdout: string;
          readonly status: number | null;
          readonly error?: Error;
        };
        readonly cacheable: boolean;
      };

      const unicodeCapitalIWithDot = "\u0130";
      const unicodeLowerIWithCombiningDot = "i\u0307";
      const baseCwd = "C:\\projects\\synara";
      const baseSystemRoot = "C:\\Windows";
      const basePath = "C:\\tools\\unicode";
      const baseEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
        PATH: basePath,
        PATHEXT: ".CMD",
        SystemRoot: baseSystemRoot,
        ...overrides,
      });
      const makeVariant = (
        input: Pick<InjectedVariant, "command" | "cwd" | "env">,
        outcome: InjectedVariant["outcome"],
        candidate?: string,
      ): InjectedVariant => {
        const systemRoot = input.env.SystemRoot ?? baseSystemRoot;
        const candidates = candidate === undefined ? [] : [candidate];
        return {
          ...input,
          whereExe: Path.win32.join(systemRoot, "System32", "where.exe"),
          outcome,
          candidates,
          result:
            outcome === "resolved"
              ? { stdout: `${candidate}\r\n`, status: 0 }
              : outcome === "not_found"
                ? { stdout: "", status: 1 }
                : { error: new Error("spawn failed"), stdout: "", status: null },
          cacheable: outcome !== "transient_failure",
        };
      };

      const collisions = [
        {
          name: "PATH Unicode expansion",
          left: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ PATH: `C:\\tools\\${unicodeCapitalIWithDot}` }),
            },
            "resolved",
            `C:\\resolved\\path-${unicodeCapitalIWithDot}.cmd`,
          ),
          right: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ PATH: `C:\\tools\\${unicodeLowerIWithCombiningDot}` }),
            },
            "resolved",
            `C:\\resolved\\path-${unicodeLowerIWithCombiningDot}.cmd`,
          ),
        },
        {
          name: "command Unicode expansion",
          left: makeVariant(
            {
              command: `probe-${unicodeCapitalIWithDot}`,
              cwd: baseCwd,
              env: baseEnv(),
            },
            "resolved",
            `C:\\resolved\\command-${unicodeCapitalIWithDot}.cmd`,
          ),
          right: makeVariant(
            {
              command: `probe-${unicodeLowerIWithCombiningDot}`,
              cwd: baseCwd,
              env: baseEnv(),
            },
            "resolved",
            `C:\\resolved\\command-${unicodeLowerIWithCombiningDot}.cmd`,
          ),
        },
        {
          name: "PATHEXT Unicode expansion",
          left: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ PATHEXT: `.${unicodeCapitalIWithDot}` }),
            },
            "resolved",
            `C:\\resolved\\probe.${unicodeCapitalIWithDot}`,
          ),
          right: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ PATHEXT: `.${unicodeLowerIWithCombiningDot}` }),
            },
            "resolved",
            `C:\\resolved\\probe.${unicodeLowerIWithCombiningDot}`,
          ),
        },
        {
          name: "SystemRoot and where.exe Unicode expansion",
          left: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ SystemRoot: `C:\\Windows-${unicodeCapitalIWithDot}` }),
            },
            "resolved",
            "C:\\resolved\\system-root.cmd",
          ),
          right: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({
                SystemRoot: `C:\\Windows-${unicodeLowerIWithCombiningDot}`,
              }),
            },
            "transient_failure",
          ),
        },
        {
          name: "quoted PATH",
          left: makeVariant(
            { command: "probe", cwd: baseCwd, env: baseEnv({ PATH: basePath }) },
            "resolved",
            "C:\\resolved\\quoted-path.cmd",
          ),
          right: makeVariant(
            { command: "probe", cwd: baseCwd, env: baseEnv({ PATH: `"${basePath}"` }) },
            "not_found",
          ),
        },
        {
          name: "space-wrapped PATH",
          left: makeVariant(
            { command: "probe", cwd: baseCwd, env: baseEnv({ PATH: basePath }) },
            "resolved",
            "C:\\resolved\\space-path.cmd",
          ),
          right: makeVariant(
            { command: "probe", cwd: baseCwd, env: baseEnv({ PATH: ` ${basePath} ` }) },
            "not_found",
          ),
        },
        {
          name: "missing versus configured-empty PATH",
          left: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: { PATHEXT: ".CMD", SystemRoot: baseSystemRoot },
            },
            "not_found",
          ),
          right: makeVariant(
            { command: "probe", cwd: baseCwd, env: baseEnv({ PATH: "" }) },
            "resolved",
            "C:\\resolved\\empty-path.cmd",
          ),
        },
        {
          name: "PATH delimiter order",
          left: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ PATH: "C:\\one;C:\\two" }),
            },
            "resolved",
            "C:\\one\\probe.cmd",
          ),
          right: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ PATH: "C:\\two;C:\\one" }),
            },
            "resolved",
            "C:\\two\\probe.cmd",
          ),
        },
        {
          name: "PATH empty-entry structure",
          left: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ PATH: "C:\\one;C:\\two" }),
            },
            "not_found",
          ),
          right: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ PATH: "C:\\one;;C:\\two" }),
            },
            "resolved",
            "C:\\resolved\\empty-entry.cmd",
          ),
        },
        {
          name: "PATH duplicate structure",
          left: makeVariant(
            { command: "probe", cwd: baseCwd, env: baseEnv({ PATH: "C:\\one" }) },
            "resolved",
            "C:\\one\\probe.cmd",
          ),
          right: makeVariant(
            {
              command: "probe",
              cwd: baseCwd,
              env: baseEnv({ PATH: "C:\\one;C:\\one" }),
            },
            "resolved",
            "C:\\resolved\\duplicate-path.cmd",
          ),
        },
        {
          name: "quoted cwd",
          left: makeVariant(
            { command: "probe", cwd: baseCwd, env: baseEnv() },
            "resolved",
            "C:\\resolved\\quoted-cwd.cmd",
          ),
          right: makeVariant(
            { command: "probe", cwd: `"${baseCwd}"`, env: baseEnv() },
            "transient_failure",
          ),
        },
        {
          name: "space-wrapped cwd",
          left: makeVariant(
            { command: "probe", cwd: baseCwd, env: baseEnv() },
            "resolved",
            "C:\\resolved\\space-cwd.cmd",
          ),
          right: makeVariant(
            { command: "probe", cwd: ` ${baseCwd} `, env: baseEnv() },
            "transient_failure",
          ),
        },
      ] as const;

      for (const collision of collisions) {
        for (const variants of [
          [collision.left, collision.right],
          [collision.right, collision.left],
        ] as const) {
          const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
          const observations: WindowsCommandDiscoveryObservation[] = [];
          const spawnSync = vi.fn(
            (
              whereExe: string,
              args: ReadonlyArray<string>,
              options: { cwd?: string; env?: NodeJS.ProcessEnv },
            ) => {
              const variant = variants.find(
                (candidate) =>
                  candidate.whereExe === whereExe &&
                  candidate.command === args[0] &&
                  candidate.cwd === options.cwd &&
                  JSON.stringify(normalizeWindowsChildEnvironment(candidate.env)) ===
                    JSON.stringify(options.env),
              );
              if (!variant) throw new Error(`Unexpected launcher input for ${collision.name}`);
              return variant.result;
            },
          );
          const resolve = (variant: (typeof variants)[number]) =>
            resolveWindowsCommandCandidates(variant.command, {
              platform: "win32",
              cwd: variant.cwd,
              env: variant.env,
              spawnSync,
              commandDiscoveryCache,
              onCommandDiscovery: (observation) => observations.push(observation),
            });

          expect(variants.map(resolve), collision.name).toEqual(
            variants.map((variant) => [...variant.candidates]),
          );
          expect(variants.map(resolve), `${collision.name} warm`).toEqual(
            variants.map((variant) => [...variant.candidates]),
          );
          expect(spawnSync, collision.name).toHaveBeenCalledTimes(
            2 + variants.filter((variant) => !variant.cacheable).length,
          );
          expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({
            size: variants.filter((variant) => variant.cacheable).length,
          });
          expect(observations).toEqual([
            ...variants.map((variant) => ({ outcome: variant.outcome, source: "where" as const })),
            ...variants.map((variant) => ({
              outcome: variant.outcome,
              source: variant.cacheable ? ("cache" as const) : ("where" as const),
            })),
          ]);
        }
      }
    });

    it("uses Node's lexical winner for duplicate keys regardless of insertion or exact casing", () => {
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      const canonicalFirst = {
        SystemRoot: "C:\\discarded-root",
        SYSTEMROOT: "D:\\effective-root",
        ComSpec: "C:\\discarded-cmd.exe",
        COMSPEC: "D:\\effective-cmd.exe",
      };
      const uppercaseFirst = {
        COMSPEC: "D:\\effective-cmd.exe",
        ComSpec: "C:\\discarded-cmd.exe",
        SYSTEMROOT: "D:\\effective-root",
        SystemRoot: "C:\\discarded-root",
      };

      expect(resolveWindowsComSpec(canonicalFirst)).toBe("D:\\effective-cmd.exe");
      expect(resolveWindowsComSpec(uppercaseFirst)).toBe("D:\\effective-cmd.exe");
      resolveWindowsCommandCandidates("codex", {
        platform: "win32",
        cwd,
        env: canonicalFirst,
        spawnSync,
      });
      resolveWindowsCommandCandidates("codex", {
        platform: "win32",
        cwd,
        env: uppercaseFirst,
        spawnSync,
      });

      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(spawnSync).toHaveBeenNthCalledWith(
        1,
        "D:\\effective-root\\System32\\where.exe",
        ["codex"],
        expect.objectContaining({ env: normalizeWindowsChildEnvironment(canonicalFirst) }),
      );
      expect(spawnSync).toHaveBeenNthCalledWith(
        2,
        "D:\\effective-root\\System32\\where.exe",
        ["codex"],
        expect.objectContaining({ env: normalizeWindowsChildEnvironment(uppercaseFirst) }),
      );
    });

    it("shares cache identity when only discarded duplicate values change", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      const firstEnv = {
        Path: "C:\\discarded-path-one",
        PATH: env.PATH,
        PathExt: ".DISCARDED1",
        PATHEXT: env.PATHEXT,
        SystemRoot: "C:\\discarded-root-one",
        SYSTEMROOT: "D:\\effective-root",
      };
      const secondEnv = {
        SYSTEMROOT: "D:\\effective-root",
        SystemRoot: "E:\\discarded-root-two",
        PATHEXT: env.PATHEXT,
        PathExt: ".DISCARDED2",
        PATH: env.PATH,
        Path: "E:\\discarded-path-two",
      };

      expect(
        resolveWindowsCommandCandidates("codex", {
          platform: "win32",
          cwd,
          env: firstEnv,
          spawnSync,
          commandDiscoveryCache,
        }),
      ).toEqual([resolvedCommand]);
      expect(
        resolveWindowsCommandCandidates("codex", {
          platform: "win32",
          cwd,
          env: secondEnv,
          spawnSync,
          commandDiscoveryCache,
        }),
      ).toEqual([resolvedCommand]);

      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(spawnSync).toHaveBeenCalledWith(
        "D:\\effective-root\\System32\\where.exe",
        ["codex"],
        expect.objectContaining({ env: normalizeWindowsChildEnvironment(firstEnv) }),
      );
    });

    it("invalidates when a lexically selected duplicate value changes", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      const firstEnv = {
        PATH: env.PATH,
        Path: "C:\\discarded-path",
        PATHEXT: env.PATHEXT,
        PathExt: ".DISCARDED",
        SYSTEMROOT: "D:\\effective-root",
        SystemRoot: "C:\\discarded-root",
      };
      const changedEffectiveEnv = {
        PATH: env.PATH,
        Path: "C:\\discarded-path",
        PATHEXT: env.PATHEXT,
        PathExt: ".DISCARDED",
        SYSTEMROOT: "E:\\effective-root",
        SystemRoot: "C:\\discarded-root",
      };

      resolveWindowsCommandCandidates("codex", {
        platform: "win32",
        cwd,
        env: firstEnv,
        spawnSync,
        commandDiscoveryCache,
      });
      resolveWindowsCommandCandidates("codex", {
        platform: "win32",
        cwd,
        env: changedEffectiveEnv,
        spawnSync,
        commandDiscoveryCache,
      });

      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(spawnSync).toHaveBeenNthCalledWith(
        1,
        "D:\\effective-root\\System32\\where.exe",
        ["codex"],
        expect.objectContaining({ env: normalizeWindowsChildEnvironment(firstEnv) }),
      );
      expect(spawnSync).toHaveBeenNthCalledWith(
        2,
        "E:\\effective-root\\System32\\where.exe",
        ["codex"],
        expect.objectContaining({ env: normalizeWindowsChildEnvironment(changedEffectiveEnv) }),
      );
    });

    it("isolates structurally distinct PATHEXT values in both cache lookup orders", () => {
      const executable = "C:\\tools\\probe.exe";
      const batch = "C:\\tools\\probe.cmd";
      const extensionless = "C:\\tools\\probe";
      const collisions = [
        {
          name: "missing versus explicit default",
          left: { pathExt: undefined, candidates: [] },
          right: { pathExt: ".COM;.EXE;.BAT;.CMD", candidates: [executable] },
        },
        {
          name: "leading dot",
          left: { pathExt: ".EXE", candidates: [executable] },
          right: { pathExt: "EXE", candidates: [] },
        },
        {
          name: "wrapping quotes",
          left: { pathExt: ".EXE", candidates: [executable] },
          right: { pathExt: '".EXE"', candidates: [] },
        },
        {
          name: "surrounding whitespace",
          left: { pathExt: ".CMD", candidates: [extensionless, batch] },
          right: { pathExt: " .CMD ", candidates: [extensionless] },
        },
        {
          name: "delimiter order",
          left: { pathExt: ".EXE;.CMD", candidates: [executable, batch] },
          right: { pathExt: ".CMD;.EXE", candidates: [batch, executable] },
        },
        {
          name: "empty-entry structure",
          left: { pathExt: ".CMD", candidates: [extensionless, batch] },
          right: { pathExt: ";.CMD;", candidates: [extensionless, batch] },
        },
        {
          name: "duplicate multiplicity",
          left: { pathExt: ".EXE", candidates: [executable] },
          right: { pathExt: ".EXE;.exe", candidates: [executable, executable] },
        },
      ] as const;

      for (const collision of collisions) {
        for (const variants of [
          [collision.left, collision.right],
          [collision.right, collision.left],
        ] as const) {
          const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
          const observations: WindowsCommandDiscoveryObservation[] = [];
          const spawnSync = vi.fn(
            (
              _command: string,
              _args: ReadonlyArray<string>,
              options: { env?: NodeJS.ProcessEnv },
            ) => {
              const pathExt = Object.prototype.hasOwnProperty.call(options.env ?? {}, "PATHEXT")
                ? options.env?.PATHEXT
                : undefined;
              const variant = variants.find((candidate) => candidate.pathExt === pathExt);
              if (!variant) throw new Error(`Unexpected PATHEXT for ${collision.name}`);
              return variant.candidates.length > 0
                ? { stdout: `${variant.candidates.join("\r\n")}\r\n`, status: 0 }
                : { stdout: "", status: 1 };
            },
          );
          const resolve = (variant: (typeof variants)[number]) =>
            resolveWindowsCommandCandidates("probe", {
              platform: "win32",
              cwd,
              env:
                variant.pathExt === undefined
                  ? { PATH: env.PATH, SystemRoot: env.SystemRoot }
                  : { PATH: env.PATH, PATHEXT: variant.pathExt, SystemRoot: env.SystemRoot },
              spawnSync,
              commandDiscoveryCache,
              onCommandDiscovery: (observation) => observations.push(observation),
            });

          expect(variants.map(resolve), collision.name).toEqual(
            variants.map((variant) => [...variant.candidates]),
          );
          expect(variants.map(resolve), `${collision.name} warm`).toEqual(
            variants.map((variant) => [...variant.candidates]),
          );
          expect(spawnSync, collision.name).toHaveBeenCalledTimes(2);
          expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({ size: 2 });
          expect(observations.map(({ source }) => source)).toEqual([
            "where",
            "where",
            "cache",
            "cache",
          ]);
        }
      }
    });

    it.runIf(process.platform === "win32")(
      "normalizes duplicate child keys before real where.exe lookup and caching",
      () => {
        const root = mkdtempSync(Path.join(tmpdir(), "synara-normalized-child-env-"));
        const winnerBin = Path.join(root, "winner-bin");
        const discardedBin = Path.join(root, "discarded-bin");
        const workingDirectory = Path.join(root, "cwd");
        const command = "synara-normalized-environment-probe";
        const candidate = Path.join(winnerBin, `${command}.cmd`);
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
        const comSpec = process.env.ComSpec ?? Path.join(systemRoot, "System32", "cmd.exe");
        mkdirSync(winnerBin, { recursive: true });
        mkdirSync(discardedBin, { recursive: true });
        mkdirSync(workingDirectory, { recursive: true });
        writeFileSync(candidate, "@echo off\r\n");

        const caller = {
          Path: discardedBin,
          path: discardedBin,
          PaTh: discardedBin,
          PATH: winnerBin,
          PathExt: ".EXE",
          PATHEXT: ".CMD",
          SystemRoot: "C:\\discarded-root",
          SYSTEMROOT: systemRoot,
          ComSpec: "C:\\discarded-cmd.exe",
          COMSPEC: comSpec,
        } satisfies NodeJS.ProcessEnv;
        const callerBefore = { ...caller };
        const reverseCaller = Object.fromEntries(Object.entries(caller).reverse());
        const reverseBefore = { ...reverseCaller };
        const cache = createWindowsCommandDiscoveryCache();
        const observations: WindowsCommandDiscoveryObservation[] = [];
        const childEnvironments: NodeJS.ProcessEnv[] = [];
        const spawnSync: NonNullable<WindowsSafeProcessInput["spawnSync"]> = (
          whereCommand,
          args,
          options,
        ) => {
          childEnvironments.push({ ...(options.env ?? {}) });
          return spawnChildSync(whereCommand, [...args], {
            ...options,
            timeout: WINDOWS_WHERE_FIXTURE_PROCESS_TIMEOUT_MS,
          });
        };
        const resolve = (childEnv: NodeJS.ProcessEnv) =>
          resolveWindowsCommandCandidates(command, {
            platform: "win32",
            cwd: workingDirectory,
            env: childEnv,
            spawnSync,
            commandDiscoveryCache: cache,
            onCommandDiscovery: (observation) => observations.push(observation),
          });

        try {
          const first = resolve(caller);
          const reverse = resolve(reverseCaller);
          const discardedChanged = resolve({ ...caller, Path: `${discardedBin}-changed` });
          const changedWinner = { ...caller, PATH: discardedBin, Path: winnerBin };
          const miss = resolve(changedWinner);
          const reverseMiss = resolve(Object.fromEntries(Object.entries(changedWinner).reverse()));

          expect(first).toHaveLength(1);
          expect(reverse).toEqual(first);
          expect(discardedChanged).toEqual(first);
          const expectedIdentity = statSync(candidate, { bigint: true });
          const actualIdentity = statSync(first[0]!, { bigint: true });
          expect({ dev: actualIdentity.dev, ino: actualIdentity.ino }).toEqual({
            dev: expectedIdentity.dev,
            ino: expectedIdentity.ino,
          });
          expect(miss).toEqual([]);
          expect(reverseMiss).toEqual([]);
          expect(observations).toEqual([
            { outcome: "resolved", source: "where" },
            { outcome: "resolved", source: "cache" },
            { outcome: "resolved", source: "cache" },
            { outcome: "not_found", source: "where" },
            { outcome: "not_found", source: "cache" },
          ]);
          expect(childEnvironments).toHaveLength(2);
          expect(
            childEnvironments.map((childEnv) =>
              Object.keys(childEnv).filter((name) => name.toUpperCase() === "PATH"),
            ),
          ).toEqual([["PATH"], ["PATH"]]);
          expect(childEnvironments.map((childEnv) => childEnv.PATH)).toEqual([
            winnerBin,
            discardedBin,
          ]);
          expect(caller).toEqual(callerBefore);
          expect(reverseCaller).toEqual(reverseBefore);
        } finally {
          rmSync(root, { force: true, recursive: true });
        }
      },
      WINDOWS_WHERE_FIXTURE_TEST_TIMEOUT_MS,
    );

    it.runIf(process.platform === "win32")(
      "matches native where.exe PATHEXT collisions in both cache lookup orders",
      () => {
        const root = mkdtempSync(Path.join(tmpdir(), "synara-pathext-cache-"));
        const binDir = Path.join(root, "bin");
        const workingDir = Path.join(root, "cwd");
        const executableCommand = "synara-native-executable-probe";
        const shimCommand = "synara-native-shim-probe";
        const executableName = `${executableCommand}.exe`;
        const shimBatchName = `${shimCommand}.cmd`;
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";

        try {
          mkdirSync(binDir);
          mkdirSync(workingDir);
          writeFileSync(Path.join(binDir, executableName), "");
          writeFileSync(Path.join(binDir, shimCommand), "");
          writeFileSync(Path.join(binDir, shimBatchName), "");

          const collisions = [
            {
              name: "missing versus explicit default",
              command: executableCommand,
              left: { pathExt: undefined, candidates: [] },
              right: { pathExt: ".COM;.EXE;.BAT;.CMD", candidates: [executableName] },
            },
            {
              name: "leading dot",
              command: executableCommand,
              left: { pathExt: ".EXE", candidates: [executableName] },
              right: { pathExt: "EXE", candidates: [] },
            },
            {
              name: "wrapping quotes",
              command: executableCommand,
              left: { pathExt: ".EXE", candidates: [executableName] },
              right: { pathExt: '".EXE"', candidates: [] },
            },
            {
              name: "extensionless candidates",
              command: shimCommand,
              left: { pathExt: ".CMD", candidates: [shimCommand, shimBatchName] },
              right: { pathExt: "CMD", candidates: [shimCommand] },
            },
            {
              name: "duplicate multiplicity",
              command: executableCommand,
              left: { pathExt: ".EXE", candidates: [executableName] },
              right: { pathExt: ".EXE;.exe", candidates: [executableName, executableName] },
            },
          ] as const;

          for (const collision of collisions) {
            for (const variants of [
              [collision.left, collision.right],
              [collision.right, collision.left],
            ] as const) {
              const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
              const observations: WindowsCommandDiscoveryObservation[] = [];
              const resolve = (variant: (typeof variants)[number]) =>
                resolveWindowsCommandCandidates(collision.command, {
                  platform: "win32",
                  cwd: workingDir,
                  env:
                    variant.pathExt === undefined
                      ? { PATH: binDir, SystemRoot: systemRoot }
                      : { PATH: binDir, PATHEXT: variant.pathExt, SystemRoot: systemRoot },
                  commandDiscoveryCache,
                  onCommandDiscovery: (observation) => observations.push(observation),
                }).map((candidate) => Path.win32.basename(candidate).toLowerCase());

              expect(variants.map(resolve), collision.name).toEqual(
                variants.map((variant) =>
                  variant.candidates.map((candidate) => candidate.toLowerCase()),
                ),
              );
              expect(variants.map(resolve), `${collision.name} warm`).toEqual(
                variants.map((variant) =>
                  variant.candidates.map((candidate) => candidate.toLowerCase()),
                ),
              );
              expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({
                size: 2,
              });
              expect(observations.map(({ source }) => source)).toEqual([
                "where",
                "where",
                "cache",
                "cache",
              ]);
            }
          }
        } finally {
          rmSync(root, { force: true, recursive: true });
        }
      },
      20_000,
    );

    it.runIf(process.platform === "win32")(
      "matches native Unicode and raw PATH/cwd collisions in both cache lookup orders",
      () => {
        type NativeVariant = {
          readonly command: string;
          readonly cwd: string;
          readonly env: NodeJS.ProcessEnv;
          readonly outcome: WindowsCommandDiscoveryObservation["outcome"];
          readonly candidates: readonly string[];
          readonly cacheable: boolean;
        };

        const unicodeCapitalIWithDot = "\u0130";
        const unicodeLowerIWithCombiningDot = "i\u0307";
        const root = mkdtempSync(Path.join(tmpdir(), "synara-cache-key-native-"));
        const workingDir = Path.join(root, "cwd");
        const commonBin = Path.join(root, "bin");
        const unicodePathCapital = Path.join(root, `path-${unicodeCapitalIWithDot}`);
        const unicodePathExpanded = Path.join(root, `path-${unicodeLowerIWithCombiningDot}`);
        const unicodeSystemRootCapital = Path.join(root, `Windows-${unicodeCapitalIWithDot}`);
        const unicodeSystemRootExpanded = Path.join(
          root,
          `Windows-${unicodeLowerIWithCombiningDot}`,
        );
        const realSystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
        const realWhereExe = Path.join(realSystemRoot, "System32", "where.exe");
        const pathCommand = "synara-native-path-identity-probe";
        const unicodeCommandCapital = `synara-native-command-${unicodeCapitalIWithDot}`;
        const unicodeCommandExpanded = `synara-native-command-${unicodeLowerIWithCombiningDot}`;
        const pathExtCommand = "synara-native-pathext-identity-probe";
        const shapeCommand = "synara-native-shape-identity-probe";
        const shapeCandidate = Path.join(commonBin, `${shapeCommand}.cmd`);
        const transientOutcome = "transient_failure" as const;

        const foldNativeCandidateForComparison = (candidate: string): string =>
          Path.win32
            .normalize(candidate)
            .replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x20));
        const makeVariant = (
          input: Pick<NativeVariant, "command" | "cwd" | "env">,
          outcome: NativeVariant["outcome"],
          candidates: readonly string[] = [],
        ): NativeVariant => ({
          ...input,
          outcome,
          candidates,
          cacheable: outcome !== transientOutcome,
        });
        const runCollision = (name: string, left: NativeVariant, right: NativeVariant): void => {
          const nativeOracle = new Map<NativeVariant, string[]>();
          for (const variant of [left, right]) {
            const oracleObservations: WindowsCommandDiscoveryObservation[] = [];
            const oracleCandidates = resolveWindowsCommandCandidates(variant.command, {
              platform: "win32",
              cwd: variant.cwd,
              env: variant.env,
              spawnSync: (command, args, options) => spawnChildSync(command, [...args], options),
              onCommandDiscovery: (observation) => oracleObservations.push(observation),
            }).map(foldNativeCandidateForComparison);
            expect(oracleCandidates, `${name} native oracle multiplicity`).toHaveLength(
              variant.candidates.length,
            );
            expect(oracleObservations, `${name} native oracle outcome`).toEqual([
              { outcome: variant.outcome, source: "where" },
            ]);
            nativeOracle.set(variant, oracleCandidates);
          }

          for (const variants of [
            [left, right],
            [right, left],
          ] as const) {
            const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
            const observations: WindowsCommandDiscoveryObservation[] = [];
            const resolve = (variant: (typeof variants)[number]) =>
              resolveWindowsCommandCandidates(variant.command, {
                platform: "win32",
                cwd: variant.cwd,
                env: variant.env,
                commandDiscoveryCache,
                onCommandDiscovery: (observation) => observations.push(observation),
              }).map(foldNativeCandidateForComparison);

            expect(variants.map(resolve), name).toEqual(
              variants.map((variant) => nativeOracle.get(variant)),
            );
            expect(variants.map(resolve), `${name} warm`).toEqual(
              variants.map((variant) => nativeOracle.get(variant)),
            );
            expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({
              size: variants.filter((variant) => variant.cacheable).length,
            });
            expect(observations).toEqual([
              ...variants.map((variant) => ({
                outcome: variant.outcome,
                source: "where" as const,
              })),
              ...variants.map((variant) => ({
                outcome: variant.outcome,
                source: variant.cacheable ? ("cache" as const) : ("where" as const),
              })),
            ]);
          }
        };

        try {
          mkdirSync(workingDir);
          mkdirSync(commonBin);
          mkdirSync(unicodePathCapital);
          mkdirSync(unicodePathExpanded);
          mkdirSync(Path.join(unicodeSystemRootCapital, "System32"), { recursive: true });
          mkdirSync(Path.join(unicodeSystemRootExpanded, "System32"), { recursive: true });

          const unicodePathCapitalCandidate = Path.join(unicodePathCapital, `${pathCommand}.cmd`);
          const unicodePathExpandedCandidate = Path.join(unicodePathExpanded, `${pathCommand}.cmd`);
          const unicodeCommandCapitalCandidate = Path.join(
            commonBin,
            `${unicodeCommandCapital}.cmd`,
          );
          const unicodeCommandExpandedCandidate = Path.join(
            commonBin,
            `${unicodeCommandExpanded}.cmd`,
          );
          const unicodePathExtCapitalCandidate = Path.join(
            commonBin,
            `${pathExtCommand}.${unicodeCapitalIWithDot}`,
          );
          const unicodePathExtExpandedCandidate = Path.join(
            commonBin,
            `${pathExtCommand}.${unicodeLowerIWithCombiningDot}`,
          );

          for (const candidate of [
            unicodePathCapitalCandidate,
            unicodePathExpandedCandidate,
            unicodeCommandCapitalCandidate,
            unicodeCommandExpandedCandidate,
            unicodePathExtCapitalCandidate,
            unicodePathExtExpandedCandidate,
            shapeCandidate,
          ]) {
            writeFileSync(candidate, "");
          }
          copyFileSync(realWhereExe, Path.join(unicodeSystemRootCapital, "System32", "where.exe"));
          writeFileSync(Path.join(unicodeSystemRootExpanded, "System32", "where.exe"), "");

          const baseEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
            PATH: commonBin,
            PATHEXT: ".CMD",
            SystemRoot: realSystemRoot,
            ...overrides,
          });
          const collisions = [
            {
              name: "native PATH Unicode expansion",
              left: makeVariant(
                {
                  command: pathCommand,
                  cwd: workingDir,
                  env: baseEnv({ PATH: unicodePathCapital }),
                },
                "resolved",
                [unicodePathCapitalCandidate],
              ),
              right: makeVariant(
                {
                  command: pathCommand,
                  cwd: workingDir,
                  env: baseEnv({ PATH: unicodePathExpanded }),
                },
                "resolved",
                [unicodePathExpandedCandidate],
              ),
            },
            {
              name: "native command Unicode expansion",
              left: makeVariant(
                {
                  command: unicodeCommandCapital,
                  cwd: workingDir,
                  env: baseEnv(),
                },
                "resolved",
                [unicodeCommandCapitalCandidate],
              ),
              right: makeVariant(
                {
                  command: unicodeCommandExpanded,
                  cwd: workingDir,
                  env: baseEnv(),
                },
                "resolved",
                [unicodeCommandExpandedCandidate],
              ),
            },
            {
              name: "native PATHEXT Unicode expansion",
              left: makeVariant(
                {
                  command: pathExtCommand,
                  cwd: workingDir,
                  env: baseEnv({ PATHEXT: `.${unicodeCapitalIWithDot}` }),
                },
                "resolved",
                [unicodePathExtCapitalCandidate],
              ),
              right: makeVariant(
                {
                  command: pathExtCommand,
                  cwd: workingDir,
                  env: baseEnv({ PATHEXT: `.${unicodeLowerIWithCombiningDot}` }),
                },
                "resolved",
                [unicodePathExtExpandedCandidate],
              ),
            },
            {
              name: "native quoted PATH",
              left: makeVariant(
                { command: shapeCommand, cwd: workingDir, env: baseEnv() },
                "resolved",
                [shapeCandidate],
              ),
              right: makeVariant(
                {
                  command: shapeCommand,
                  cwd: workingDir,
                  env: baseEnv({ PATH: `"${commonBin}"` }),
                },
                "not_found",
              ),
            },
            {
              name: "native space-wrapped PATH",
              left: makeVariant(
                { command: shapeCommand, cwd: workingDir, env: baseEnv() },
                "resolved",
                [shapeCandidate],
              ),
              right: makeVariant(
                {
                  command: shapeCommand,
                  cwd: workingDir,
                  env: baseEnv({ PATH: ` ${commonBin} ` }),
                },
                "not_found",
              ),
            },
            {
              name: "native quoted cwd",
              left: makeVariant(
                { command: shapeCommand, cwd: workingDir, env: baseEnv() },
                "resolved",
                [shapeCandidate],
              ),
              right: makeVariant(
                { command: shapeCommand, cwd: `"${workingDir}"`, env: baseEnv() },
                "transient_failure",
              ),
            },
            {
              name: "native space-wrapped cwd",
              left: makeVariant(
                { command: shapeCommand, cwd: workingDir, env: baseEnv() },
                "resolved",
                [shapeCandidate],
              ),
              right: makeVariant(
                { command: shapeCommand, cwd: ` ${workingDir} `, env: baseEnv() },
                "transient_failure",
              ),
            },
            {
              name: "native SystemRoot and where.exe Unicode expansion",
              left: makeVariant(
                {
                  command: shapeCommand,
                  cwd: workingDir,
                  env: baseEnv({ SystemRoot: unicodeSystemRootCapital }),
                },
                "resolved",
                [shapeCandidate],
              ),
              right: makeVariant(
                {
                  command: shapeCommand,
                  cwd: workingDir,
                  env: baseEnv({ SystemRoot: unicodeSystemRootExpanded }),
                },
                "transient_failure",
              ),
            },
          ] as const;

          for (const collision of collisions) {
            runCollision(collision.name, collision.left, collision.right);
          }
        } finally {
          rmSync(root, { force: true, recursive: true });
        }
      },
      30_000,
    );

    it("includes the actual process cwd when cwd is omitted", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("C:\\projects\\one");
      const input = { platform: "win32" as const, env, spawnSync, commandDiscoveryCache };

      resolveWindowsCommandCandidates("codex", input);
      resolveWindowsCommandCandidates("codex", input);
      cwdSpy.mockReturnValue("C:\\projects\\two");
      resolveWindowsCommandCandidates("codex", input);

      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(spawnSync).toHaveBeenNthCalledWith(
        1,
        "C:\\Windows\\System32\\where.exe",
        ["codex"],
        expect.objectContaining({ cwd: "C:\\projects\\one" }),
      );
      expect(spawnSync).toHaveBeenNthCalledWith(
        2,
        "C:\\Windows\\System32\\where.exe",
        ["codex"],
        expect.objectContaining({ cwd: "C:\\projects\\two" }),
      );
    });

    it("bypasses discovery and caching for explicit executable paths", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const observations: WindowsCommandDiscoveryObservation[] = [];
      const spawnSync = vi.fn();
      const command = "C:\\Program Files\\Codex 工具\\codex.cmd";

      expect(
        resolveWindowsCommandCandidates(command, {
          platform: "win32",
          cwd,
          env,
          spawnSync,
          commandDiscoveryCache,
          onCommandDiscovery: (observation) => observations.push(observation),
        }),
      ).toEqual([command]);
      expect(spawnSync).not.toHaveBeenCalled();
      expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({ size: 0 });
      expect(observations).toEqual([{ outcome: "resolved", source: "bypass" }]);
    });

    it("keeps true access order and caps each cache at 256 entries", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const spawnSync = vi.fn((_command: string, args: ReadonlyArray<string>) => ({
        stdout: `C:\\tools\\${args[0]}.cmd\r\n`,
        status: 0,
      }));
      const input = { platform: "win32" as const, cwd, env, spawnSync, commandDiscoveryCache };

      for (let index = 0; index < 256; index += 1) {
        resolveWindowsCommandCandidates(`tool-${index}`, input);
      }
      resolveWindowsCommandCandidates("tool-0", input);
      resolveWindowsCommandCandidates("tool-256", input);

      expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({ size: 256 });
      expect(spawnSync).toHaveBeenCalledTimes(257);
      resolveWindowsCommandCandidates("tool-0", input);
      expect(spawnSync).toHaveBeenCalledTimes(257);
      resolveWindowsCommandCandidates("tool-1", input);
      expect(spawnSync).toHaveBeenCalledTimes(258);
      expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({ size: 256 });
    });

    it("does not let caller mutation corrupt a cached candidate list", () => {
      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      const input = { platform: "win32" as const, cwd, env, spawnSync, commandDiscoveryCache };

      const candidates = resolveWindowsCommandCandidates("codex", input);
      candidates[0] = "C:\\tampered.cmd";
      candidates.push("C:\\injected.cmd");

      expect(resolveWindowsCommandCandidates("codex", input)).toEqual([resolvedCommand]);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    });

    it("bypasses the process cache for injected launchers unless given an isolated cache", () => {
      const spawnSync = vi.fn(() => ({ stdout: `${resolvedCommand}\r\n`, status: 0 }));
      const uncachedInput = { platform: "win32" as const, cwd, env, spawnSync };

      resolveWindowsCommandCandidates("codex", uncachedInput);
      resolveWindowsCommandCandidates("codex", uncachedInput);
      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(getWindowsCommandDiscoveryCacheStats()).toEqual({ size: 0 });

      const commandDiscoveryCache = createWindowsCommandDiscoveryCache();
      const cachedInput = { ...uncachedInput, commandDiscoveryCache };
      resolveWindowsCommandCandidates("codex", cachedInput);
      resolveWindowsCommandCandidates("codex", cachedInput);
      expect(spawnSync).toHaveBeenCalledTimes(3);
      expect(getWindowsCommandDiscoveryCacheStats(commandDiscoveryCache)).toEqual({ size: 1 });
      expect(getWindowsCommandDiscoveryCacheStats()).toEqual({ size: 0 });
    });

    it.runIf(process.platform === "win32")("clears the process-local cache", () => {
      const root = mkdtempSync(Path.join(tmpdir(), "synara-process-cache-"));
      try {
        clearWindowsCommandDiscoveryCache();
        expect(
          resolveWindowsCommandCandidates("synara-process-local-cache-probe-that-must-not-exist", {
            platform: "win32",
            cwd: root,
            env: {
              PATH: "",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
              SYSTEMROOT: resolveWindowsSystemRoot(process.env),
            },
          }),
        ).toEqual([]);
        expect(getWindowsCommandDiscoveryCacheStats()).toEqual({ size: 1 });
        clearWindowsCommandDiscoveryCache();
        expect(getWindowsCommandDiscoveryCacheStats()).toEqual({ size: 0 });
      } finally {
        clearWindowsCommandDiscoveryCache();
        rmSync(root, { force: true, recursive: true });
      }
    });
  });

  it("resolves ComSpec from environment before falling back", () => {
    expect(resolveWindowsComSpec({ ComSpec: "D:\\cmd.exe" })).toBe("D:\\cmd.exe");
    expect(resolveWindowsComSpec({ cOmSpEc: "E:\\cmd.exe" })).toBe("E:\\cmd.exe");
    expect(resolveWindowsComSpec({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\cmd.exe",
    );
  });

  it("detects batch shims by extension", () => {
    expect(isWindowsBatchCommand("codex.cmd")).toBe(true);
    expect(isWindowsBatchCommand("tool.bat")).toBe(true);
    expect(isWindowsBatchCommand("tool.exe")).toBe(false);
  });
});
