// FILE: codexCliExecutable.test.ts
// Purpose: Verifies Windows Codex resolution preserves configured and PATH precedence.
// Layer: Shared Node runtime utility tests

import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  resolveCodexCliExecutable,
  resolveCodexCliExecutableAsync,
  resolveCodexCliExecutableWithDiscovery,
  resolveCodexCliExecutableWithDiscoveryAsync,
} from "./codexCliExecutable";

function whereOutput(...candidates: string[]) {
  return vi.fn((_command: string, _args: ReadonlyArray<string>) => ({
    stdout: candidates.join("\r\n"),
    status: 0,
  }));
}

function regularFiles(...paths: string[]) {
  const files = new Set(paths.map((path) => path.toLowerCase()));
  return vi.fn((path: string) => {
    if (!files.has(path.toLowerCase())) {
      throw Object.assign(new Error(`Missing file: ${path}`), { code: "ENOENT" });
    }
    return { isFile: () => true };
  });
}

describe("resolveCodexCliExecutable", () => {
  it("preserves non-Windows commands exactly without probing", () => {
    const spawnSync = vi.fn();
    const readStat = vi.fn();

    expect(
      resolveCodexCliExecutable(" CoDeX ", {
        platform: "linux",
        spawnSync,
        statSync: readStat,
      }),
    ).toBe(" CoDeX ");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readStat).not.toHaveBeenCalled();
  });

  it.each([
    "C:\\Program Files\\OpenAI\\codex.exe",
    "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd",
  ])("keeps an explicit configured path authoritative: %s", (configured) => {
    const spawnSync = vi.fn();
    const readStat = vi.fn(() => {
      throw new Error("explicit paths are validated by provider preparation");
    });

    expect(
      resolveCodexCliExecutable(configured, {
        platform: "win32",
        spawnSync,
        statSync: readStat,
      }),
    ).toBe(configured);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readStat).not.toHaveBeenCalled();
  });

  it("resolves an explicit alias once and never substitutes default Codex fallbacks", () => {
    const configured = "company-codex";
    const resolved = "D:\\Company Tools\\company-codex.cmd";
    const spawnSync = whereOutput(resolved);

    expect(
      resolveCodexCliExecutable(configured, {
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" },
        spawnSync,
        statSync: regularFiles(
          "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
        ),
      }),
    ).toBe(resolved);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0]?.[1]).toEqual([configured]);
  });

  it("uses the first spawn-safe PATH match even when a later standalone CLI exists", () => {
    const npmCodex = "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd";
    const standaloneCodex = "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\codex.exe";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        spawnSync: whereOutput(npmCodex, standaloneCodex),
      }),
    ).toBe(npmCodex);
  });

  it("skips a current-directory hit while preserving the remaining PATH order", () => {
    const cwd = "C:\\work\\repo";
    const cwdCodex = Path.win32.join(cwd, "codex.exe");
    const npmCodex = "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd";
    const laterCodex = "C:\\Tools\\codex.exe";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd,
        spawnSync: whereOutput(cwdCodex, npmCodex, laterCodex),
      }),
    ).toBe(npmCodex);
  });

  it("skips an extensionless POSIX shim in favor of the first Windows-spawn-safe match", () => {
    const posixShim = "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex";
    const npmCodex = `${posixShim}.cmd`;

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        spawnSync: whereOutput(posixShim, npmCodex),
      }),
    ).toBe(npmCodex);
  });

  it("uses verified fallback installs only after PATH discovery cannot resolve Codex", () => {
    const installDirCodex = "D:\\Codex Install\\codex.exe";
    const standaloneCodex =
      "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    const npmCodex = "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        env: {
          CODEX_INSTALL_DIR: "D:\\Codex Install",
          LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
          APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
        },
        spawnSync: vi.fn(() => ({ stdout: "", status: 1 })),
        statSync: regularFiles(standaloneCodex, npmCodex),
      }),
    ).toBe(standaloneCodex);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        env: {
          CODEX_INSTALL_DIR: "D:\\Codex Install",
          LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
          APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
        },
        spawnSync: vi.fn(() => ({ stdout: "", status: 1 })),
        statSync: regularFiles(installDirCodex, standaloneCodex, npmCodex),
      }),
    ).toBe(installDirCodex);
  });

  it.each([
    ["not_found", { stdout: "", status: 1 }],
    [
      "transient_failure",
      {
        stdout: "",
        status: null,
        error: Object.assign(new Error("where.exe timed out"), { code: "ETIMEDOUT" }),
      },
    ],
  ] as const)("preserves a %s discovery outcome when no fallback exists", (outcome, result) => {
    expect(
      resolveCodexCliExecutableWithDiscovery("codex", {
        platform: "win32",
        env: {},
        spawnSync: vi.fn(() => result),
        statSync: regularFiles(),
      }),
    ).toEqual({
      executable: "codex",
      discoveryOutcome: outcome,
    });
  });

  it("fails closed on transient discovery without probing an existing fallback", () => {
    const standaloneCodex =
      "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    const readStat = regularFiles(standaloneCodex);

    expect(
      resolveCodexCliExecutableWithDiscovery("codex", {
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" },
        spawnSync: vi.fn(() => ({
          stdout: "",
          status: null,
          error: Object.assign(new Error("where.exe timed out"), { code: "ETIMEDOUT" }),
        })),
        statSync: readStat,
      }),
    ).toEqual({
      executable: "codex",
      discoveryOutcome: "transient_failure",
    });
    expect(readStat).not.toHaveBeenCalled();
  });

  it("resolves the first PATH Codex asynchronously without invoking spawnSync", async () => {
    const npmCodex = "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd";
    const standaloneCodex = "C:\\Tools\\codex.exe";
    const spawnSync = vi.fn(() => {
      throw new Error("async resolution must not invoke spawnSync");
    });
    const execFile = vi.fn(async () => ({
      stdout: `${npmCodex}\r\n${standaloneCodex}\r\n`,
      status: 0,
    }));

    await expect(
      resolveCodexCliExecutableAsync("codex", {
        platform: "win32",
        execFile,
        spawnSync,
      }),
    ).resolves.toBe(npmCodex);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("keeps async explicit paths authoritative and reports unresolved aliases", async () => {
    const explicit = "C:\\Tools\\Custom Codex\\codex.cmd";
    const execFile = vi.fn(async () => ({ stdout: "", status: 1 }));

    await expect(
      resolveCodexCliExecutableAsync(explicit, {
        platform: "win32",
        execFile,
      }),
    ).resolves.toBe(explicit);
    expect(execFile).not.toHaveBeenCalled();

    await expect(
      resolveCodexCliExecutableWithDiscoveryAsync("company-codex", {
        platform: "win32",
        env: {},
        execFile,
      }),
    ).resolves.toEqual({
      executable: "company-codex",
      discoveryOutcome: "not_found",
    });
  });

  it("fails closed asynchronously on transient discovery with an existing fallback", async () => {
    const npmCodex = "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd";
    const readStat = regularFiles(npmCodex);

    await expect(
      resolveCodexCliExecutableWithDiscoveryAsync("codex", {
        platform: "win32",
        env: { APPDATA: "C:\\Users\\Test\\AppData\\Roaming" },
        execFile: vi.fn(async () => ({
          stdout: "",
          status: null,
          error: Object.assign(new Error("where.exe timed out"), { code: "ETIMEDOUT" }),
        })),
        statSync: readStat,
      }),
    ).resolves.toEqual({
      executable: "codex",
      discoveryOutcome: "transient_failure",
    });
    expect(readStat).not.toHaveBeenCalled();
  });
});
