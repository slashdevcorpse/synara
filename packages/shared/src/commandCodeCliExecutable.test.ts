import { describe, expect, it, vi } from "vitest";

import {
  resolveCommandCodeCliExecutable,
  resolveCommandCodeCliExecutableAsync,
  resolveCommandCodeCliExecutableWithDiscovery,
} from "./commandCodeCliExecutable";

function regularFiles(...paths: string[]) {
  const files = new Set(paths.map((path) => path.toLowerCase()));
  return vi.fn((path: string) => {
    if (!files.has(path.toLowerCase())) throw new Error(`Missing file: ${path}`);
    return { isFile: () => true };
  });
}

describe("resolveCommandCodeCliExecutable", () => {
  it("preserves non-Windows commands without probing", () => {
    const spawnSync = vi.fn();
    expect(resolveCommandCodeCliExecutable("commandcode", { platform: "linux", spawnSync })).toBe(
      "commandcode",
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("resolves a configured custom command exactly once", () => {
    const resolved = "C:\\tools\\custom-command-code.cmd";
    const spawnSync = vi.fn(() => ({ stdout: resolved, status: 0 }));
    expect(
      resolveCommandCodeCliExecutable("custom-command-code", {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe(resolved);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("resolves configured commands asynchronously without invoking spawnSync", async () => {
    const resolved = "C:\\tools\\custom-command-code.cmd";
    const spawnSync = vi.fn();
    let eventLoopAdvanced = false;
    const resolving = resolveCommandCodeCliExecutableAsync("custom-command-code", {
      platform: "win32",
      cwd: "C:\\repo",
      env: { SystemRoot: "C:\\Windows" },
      execFile: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { stdout: resolved, status: 0 };
      },
      spawnSync,
    });
    queueMicrotask(() => {
      eventLoopAdvanced = true;
    });

    await Promise.resolve();
    expect(eventLoopAdvanced).toBe(true);
    await expect(resolving).resolves.toBe(resolved);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("prefers the configured official alias before its sibling", () => {
    const commandCode = "C:\\npm\\command-code.cmd";
    const commandcode = "C:\\npm\\commandcode.cmd";
    const spawnSync = vi.fn((_command: string, args: ReadonlyArray<string>) => ({
      stdout: args[0] === "command-code" ? commandCode : commandcode,
      status: 0,
    }));
    expect(
      resolveCommandCodeCliExecutable("command-code", {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(commandCode, commandcode),
      }),
    ).toBe(commandCode);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("falls back from commandcode to command-code", () => {
    const commandCode = "C:\\npm\\command-code.cmd";
    const spawnSync = vi.fn((_command: string, args: ReadonlyArray<string>) =>
      args[0] === "commandcode" ? { stdout: "", status: 1 } : { stdout: commandCode, status: 0 },
    );
    expect(
      resolveCommandCodeCliExecutable("commandcode", {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(commandCode),
      }),
    ).toBe(commandCode);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it("falls back to cmdc when it is the only installed official shim", () => {
    const cmdc = "C:\\npm\\cmdc.cmd";
    const spawnSync = vi.fn((_command: string, args: ReadonlyArray<string>) =>
      args[0] === "cmdc" ? { stdout: cmdc, status: 0 } : { stdout: "", status: 1 },
    );
    expect(
      resolveCommandCodeCliExecutable("commandcode", {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(cmdc),
      }),
    ).toBe(cmdc);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("resolves the cmd alias only to an npm shim, never the Windows command processor", () => {
    const commandProcessor = "C:\\Windows\\System32\\cmd.exe";
    const shim = "C:\\npm\\cmd.cmd";
    const spawnSync = vi.fn((_command: string, args: ReadonlyArray<string>) =>
      args[0] === "cmd"
        ? { stdout: `${commandProcessor}\r\n${shim}\r\n`, status: 0 }
        : { stdout: "", status: 1 },
    );

    expect(
      resolveCommandCodeCliExecutable("cmd", {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(commandProcessor, shim),
      }),
    ).toBe(shim);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("fails safe to the non-conflicting default when bare cmd has no package shim", () => {
    const commandProcessor = "C:\\Windows\\System32\\cmd.exe";
    const spawnSync = vi.fn((_command: string, args: ReadonlyArray<string>) =>
      args[0] === "cmd"
        ? { stdout: `${commandProcessor}\r\n`, status: 0 }
        : { stdout: "", status: 1 },
    );

    expect(
      resolveCommandCodeCliExecutable("cmd", {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(commandProcessor),
      }),
    ).toBe("commandcode");
    expect(spawnSync).toHaveBeenCalledTimes(4);
  });

  it("uses the case-insensitive APPDATA npm fallback", () => {
    const shim = "C:\\Users\\test\\AppData\\Roaming\\npm\\commandcode.cmd";
    expect(
      resolveCommandCodeCliExecutable("commandcode", {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows", appdata: "C:\\Users\\test\\AppData\\Roaming" },
        spawnSync: vi.fn(() => ({ stdout: "", status: 1 })),
        statSync: regularFiles(shim),
      }),
    ).toBe(shim);
  });

  it("preserves definitive not-found discovery across every official alias", () => {
    expect(
      resolveCommandCodeCliExecutableWithDiscovery("commandcode", {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: vi.fn(() => ({ stdout: "", status: 1 })),
        statSync: regularFiles(),
      }),
    ).toEqual({ executable: "commandcode", discoveryOutcome: "not_found" });
  });

  it("preserves a transient failure from any official alias", () => {
    const spawnSync = vi.fn((_command: string, args: ReadonlyArray<string>) =>
      args[0] === "commandcode"
        ? {
            error: Object.assign(new Error("where.exe timed out"), { code: "ETIMEDOUT" }),
            stdout: "",
            status: null,
          }
        : { stdout: "", status: 1 },
    );

    expect(
      resolveCommandCodeCliExecutableWithDiscovery("commandcode", {
        platform: "win32",
        cwd: "C:\\repo",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(),
      }),
    ).toEqual({ executable: "commandcode", discoveryOutcome: "transient_failure" });
    expect(spawnSync).toHaveBeenCalledTimes(4);
  });
});
