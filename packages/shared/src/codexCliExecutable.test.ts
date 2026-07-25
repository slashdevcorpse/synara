// FILE: codexCliExecutable.test.ts
// Purpose: Verifies deterministic Windows Codex CLI executable selection.
// Layer: Shared Node runtime utility tests

import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveCodexCliExecutable,
  resolveCodexCliExecutableAsync,
  resolveCodexCliExecutableWithDiscovery,
  resolveCodexCliExecutableWithDiscoveryAsync,
} from "./codexCliExecutable";

function whereOutput(...candidates: string[]) {
  return vi.fn(() => ({ stdout: candidates.join("\r\n"), status: 0 }));
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

function codexPackageRoot(executable: string): string {
  return Path.win32.dirname(Path.win32.dirname(executable));
}

function completeCodexBundle(executable: string): [string, string, string] {
  const resources = Path.win32.join(codexPackageRoot(executable), "codex-resources");
  return [
    executable,
    Path.win32.join(resources, "codex-command-runner.exe"),
    Path.win32.join(resources, "codex-windows-sandbox-setup.exe"),
  ];
}

function nestedNpmVendorCodex(shim: string): string {
  return Path.win32.join(
    Path.win32.dirname(shim),
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
}

function codexVersions(...entries: ReadonlyArray<readonly [executable: string, version: string]>) {
  const manifests = new Map(
    entries.map(([executable, version]) => [
      Path.win32.join(codexPackageRoot(executable), "codex-package.json").toLowerCase(),
      JSON.stringify({ version }),
    ]),
  );
  return vi.fn((path: string, encoding: "utf8") => {
    expect(encoding).toBe("utf8");
    const manifest = manifests.get(path.toLowerCase());
    if (manifest === undefined) {
      throw Object.assign(new Error(`Missing file: ${path}`), { code: "ENOENT" });
    }
    return manifest;
  });
}

describe("resolveCodexCliExecutable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("preserves non-Windows commands exactly without probing", () => {
    const spawnSync = vi.fn();
    const readStat = vi.fn();

    expect(
      resolveCodexCliExecutable(" CoDeX ", {
        platform: "linux",
        env: {},
        spawnSync,
        statSync: readStat,
      }),
    ).toBe(" CoDeX ");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readStat).not.toHaveBeenCalled();
  });

  it("returns an explicit executable path without probing", () => {
    const spawnSync = vi.fn();
    const readStat = vi.fn();
    const configured = "C:\\Program Files (x86)\\Codex Tools\\custom.exe";

    expect(
      resolveCodexCliExecutable(configured, {
        platform: "win32",
        env: {},
        spawnSync,
        statSync: readStat,
      }),
    ).toBe(configured);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readStat).not.toHaveBeenCalled();
  });

  it("resolves an explicit extensionless Codex command to its complete native package", () => {
    const configured = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex";
    const shim = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const native = nestedNpmVendorCodex(shim);
    const spawnSync = whereOutput(shim);

    expect(
      resolveCodexCliExecutable(configured, {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(shim, ...completeCodexBundle(native)),
      }),
    ).toBe(native);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("resolves an unknown explicit extensionless command exactly once", () => {
    const configured = "custom-codex";
    const resolved = "C:\\tools\\custom-codex.cmd";
    const spawnSync = whereOutput(resolved);

    expect(
      resolveCodexCliExecutable(configured, {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: vi.fn(),
      }),
    ).toBe(resolved);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed explicit alias without consulting default fallbacks", () => {
    const fallback = "D:\\Codex\\codex.exe";
    const spawnSync = vi.fn(() => ({ stdout: "", status: 1 }));
    const readStat = regularFiles(fallback);

    expect(
      resolveCodexCliExecutable("custom-codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows", CODEX_INSTALL_DIR: "D:\\Codex" },
        spawnSync,
        statSync: readStat,
      }),
    ).toBe("custom-codex");
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(readStat).not.toHaveBeenCalled();
  });

  it("prefers a valid native PATH executable over batch and documented fallbacks", () => {
    const extensionless = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex";
    const batch = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd";
    const native = "C:\\Users\\Test User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    const installDirNative = "D:\\Codex\\codex.exe";
    const spawnSync = whereOutput(extensionless, batch, native);
    const readStat = regularFiles(batch, ...completeCodexBundle(native), installDirNative);

    expect(
      resolveCodexCliExecutable(" CoDeX ", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows", CODEX_INSTALL_DIR: "D:\\Codex" },
        spawnSync,
        statSync: readStat,
      }),
    ).toBe(native);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("accepts a native .com PATH executable", () => {
    const native = "C:\\tools\\codex.com";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: whereOutput(native),
        statSync: regularFiles(native),
      }),
    ).toBe(native);
  });

  it("honors a case-insensitive CODEX_INSTALL_DIR before a PATH batch shim", () => {
    const batch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const native = "D:\\OpenAI CLI\\codex.exe";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { systemroot: "C:\\Windows", codex_install_dir: " D:\\OpenAI CLI " },
        spawnSync: whereOutput(batch),
        statSync: regularFiles(batch, ...completeCodexBundle(native)),
      }),
    ).toBe(native);
  });

  it("uses the documented standalone install before a PATH batch shim", () => {
    const batch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const native = "C:\\Users\\Test User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: {
          SystemRoot: "C:\\Windows",
          localappdata: "C:\\Users\\Test User\\AppData\\Local",
        },
        spawnSync: whereOutput(batch),
        statSync: regularFiles(batch, ...completeCodexBundle(native)),
      }),
    ).toBe(native);
  });

  it("rejects an incomplete OpenAI native install and uses the complete npm package", () => {
    const native =
      "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    const npmBatch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const vendorNative = nestedNpmVendorCodex(npmBatch);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: {
          SystemRoot: "C:\\Windows",
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          APPDATA: "C:\\Users\\test\\AppData\\Roaming",
        },
        spawnSync: whereOutput(npmBatch, native),
        statSync: regularFiles(native, npmBatch, ...completeCodexBundle(vendorNative)),
      }),
    ).toBe(vendorNative);
  });

  it("resolves a complete npm vendor-native executable behind a PATH batch shim", () => {
    const pathBatch = "D:\\node\\codex.bat";
    const npmBatch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const vendorNative = nestedNpmVendorCodex(pathBatch);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: {
          SystemRoot: "C:\\Windows",
          AppData: "C:\\Users\\test\\AppData\\Roaming",
        },
        spawnSync: whereOutput(pathBatch),
        statSync: regularFiles(pathBatch, npmBatch, ...completeCodexBundle(vendorNative)),
      }),
    ).toBe(vendorNative);
  });

  it("resolves an npm vendor-native executable through paths containing spaces", () => {
    const npmBatch = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd";
    const vendorNative = nestedNpmVendorCodex(npmBatch);
    const spawnSync = whereOutput(npmBatch);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\Users\\Test User\\Synara Project",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(npmBatch, ...completeCodexBundle(vendorNative)),
      }),
    ).toBe(vendorNative);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("prefers the newest complete native package when stable versions are readable", () => {
    const olderNative = "C:\\OpenAI\\Codex\\bin\\codex.exe";
    const npmBatch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const newerNative = nestedNpmVendorCodex(npmBatch);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: whereOutput(olderNative, npmBatch),
        statSync: regularFiles(
          npmBatch,
          ...completeCodexBundle(olderNative),
          ...completeCodexBundle(newerNative),
        ),
        readFileSync: codexVersions(
          [olderNative, "0.144.1"],
          [newerNative, "0.145.0"],
        ),
      }),
    ).toBe(newerNative);
  });

  it("preserves deterministic candidate ordering when every version cannot be read safely", () => {
    const firstNative = "C:\\first\\bin\\codex.exe";
    const secondNative = "D:\\second\\bin\\codex.exe";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: whereOutput(firstNative, secondNative),
        statSync: regularFiles(
          ...completeCodexBundle(firstNative),
          ...completeCodexBundle(secondNative),
        ),
        readFileSync: codexVersions([secondNative, "999.0.0"]),
      }),
    ).toBe(firstNative);
  });

  it("uses the native npm package behind the case-insensitive APPDATA fallback", () => {
    const npmBatch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const vendorNative = nestedNpmVendorCodex(npmBatch);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: {
          SystemRoot: "C:\\Windows",
          appdata: "C:\\Users\\test\\AppData\\Roaming",
        },
        spawnSync: vi.fn(() => ({ stdout: "", status: 1 })),
        statSync: regularFiles(npmBatch, ...completeCodexBundle(vendorNative)),
      }),
    ).toBe(vendorNative);
  });

  it("rejects current-directory where.exe hits before validating candidates", () => {
    const cwdHit = "C:\\projects\\synara\\codex.exe";
    const safeNative = "C:\\tools\\codex.exe";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\PROJECTS\\SYNARA",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: whereOutput(cwdHit, safeNative),
        statSync: regularFiles(cwdHit, ...completeCodexBundle(safeNative)),
      }),
    ).toBe(safeNative);
  });

  it("rejects relative, drive-root-relative, missing, and non-file candidates", () => {
    const relative = "tools\\codex.exe";
    const driveRootRelative = "\\tools\\codex.exe";
    const missing = "C:\\missing\\codex.exe";
    const directory = "C:\\directory\\codex.exe";
    const fallback = "D:\\Codex\\codex.exe";
    const fallbackFiles = new Set(
      completeCodexBundle(fallback).map((path) => path.toLowerCase()),
    );
    const readStat = vi.fn((path: string) => {
      if (path === directory) {
        return { isFile: () => false };
      }
      if (fallbackFiles.has(path.toLowerCase())) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error(`Missing file: ${path}`), { code: "ENOENT" });
    });

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows", CODEX_INSTALL_DIR: "D:\\Codex" },
        spawnSync: whereOutput(relative, driveRootRelative, missing, directory),
        statSync: readStat,
      }),
    ).toBe(fallback);
    expect(readStat).not.toHaveBeenCalledWith(relative);
    expect(readStat).not.toHaveBeenCalledWith(driveRootRelative);
  });

  it("falls through from an incomplete explicit codex.exe to a healthy discovered package", () => {
    const configured = "C:\\Configured\\Codex\\bin\\codex.exe";
    const npmBatch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const vendorNative = nestedNpmVendorCodex(npmBatch);
    const spawnSync = whereOutput(configured, npmBatch);

    expect(
      resolveCodexCliExecutable(configured, {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(
          configured,
          npmBatch,
          ...completeCodexBundle(vendorNative),
        ),
      }),
    ).toBe(vendorNative);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("resolves a complete native package behind an explicit npm shim without running it", () => {
    const configured = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd";
    const vendorNative = nestedNpmVendorCodex(configured);
    const spawnSync = vi.fn();

    expect(
      resolveCodexCliExecutable(configured, {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(configured, ...completeCodexBundle(vendorNative)),
      }),
    ).toBe(vendorNative);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("falls through from an explicit npm shim whose native package is incomplete", () => {
    const configured = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd";
    const configuredNative = nestedNpmVendorCodex(configured);
    const healthyShim = "D:\\tools\\codex.cmd";
    const healthyNative = nestedNpmVendorCodex(healthyShim);
    const spawnSync = whereOutput(configured, healthyShim);

    expect(
      resolveCodexCliExecutable(configured, {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
        statSync: regularFiles(
          configured,
          configuredNative,
          healthyShim,
          ...completeCodexBundle(healthyNative),
        ),
      }),
    ).toBe(healthyNative);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("does not read fallback values from process.env when an env is supplied", () => {
    const globalNative = "C:\\Global\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    vi.stubEnv("LOCALAPPDATA", "C:\\Global");
    const readStat = regularFiles(globalNative);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: vi.fn(() => ({ stdout: "", status: 1 })),
        statSync: readStat,
      }),
    ).toBe("codex");
    expect(readStat).not.toHaveBeenCalled();
  });

  it("returns bare codex when no valid candidate exists", () => {
    expect(
      resolveCodexCliExecutable("CODEX", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: whereOutput("codex", "C:\\missing\\codex.cmd"),
        statSync: regularFiles(),
      }),
    ).toBe("codex");
  });

  it("does not fall back to a batch shim when no complete native package exists", () => {
    const incompleteNative = "C:\\OpenAI\\Codex\\bin\\codex.exe";
    const npmBatch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const incompleteVendorNative = nestedNpmVendorCodex(npmBatch);
    const [vendorExecutable, vendorCommandRunner] =
      completeCodexBundle(incompleteVendorNative);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: {
          SystemRoot: "C:\\Windows",
          APPDATA: "C:\\Users\\test\\AppData\\Roaming",
        },
        spawnSync: whereOutput(incompleteNative, npmBatch),
        statSync: regularFiles(
          incompleteNative,
          npmBatch,
          vendorExecutable,
          vendorCommandRunner,
        ),
      }),
    ).toBe("codex");
  });

  it("preserves definitive not-found discovery when falling back to bare codex", () => {
    expect(
      resolveCodexCliExecutableWithDiscovery("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: vi.fn(() => ({ stdout: "", status: 1 })),
        statSync: regularFiles(),
      }),
    ).toEqual({ executable: "codex", discoveryOutcome: "not_found" });
  });

  it("preserves transient discovery failure when falling back to bare codex", () => {
    expect(
      resolveCodexCliExecutableWithDiscovery("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: vi.fn(() => ({
          error: Object.assign(new Error("where.exe timed out"), { code: "ETIMEDOUT" }),
          stdout: "",
          status: null,
        })),
        statSync: regularFiles(),
      }),
    ).toEqual({ executable: "codex", discoveryOutcome: "transient_failure" });
  });

  it("resolves the default Codex executable asynchronously without invoking spawnSync", async () => {
    const batch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const native = "C:\\tools\\codex.exe";
    const execFile = vi.fn(async () => ({
      stdout: `${batch}\r\n${native}\r\n`,
      status: 0,
    }));
    const spawnSync = vi.fn(() => {
      throw new Error("synchronous discovery must not run");
    });

    await expect(
      resolveCodexCliExecutableAsync("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        execFile,
        spawnSync,
        statSync: regularFiles(batch, ...completeCodexBundle(native)),
      }),
    ).resolves.toBe(native);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("preserves an absolute configured Windows executable asynchronously without PATH probing", async () => {
    const configured =
      "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\codex.exe";
    const execFile = vi.fn();
    const spawnSync = vi.fn();

    await expect(
      resolveCodexCliExecutableAsync(configured, {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        execFile,
        spawnSync,
        statSync: regularFiles(...completeCodexBundle(configured)),
      }),
    ).resolves.toBe(configured);
    expect(execFile).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("preserves async not-found and transient discovery outcomes", async () => {
    await expect(
      resolveCodexCliExecutableWithDiscoveryAsync("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        execFile: vi.fn(async () => ({ stdout: "", status: 1 })),
        statSync: regularFiles(),
      }),
    ).resolves.toEqual({ executable: "codex", discoveryOutcome: "not_found" });

    await expect(
      resolveCodexCliExecutableWithDiscoveryAsync("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        execFile: vi.fn(async () => ({
          error: Object.assign(new Error("where.exe timed out"), { code: "ETIMEDOUT" }),
          stdout: "",
          status: null,
        })),
        statSync: regularFiles(),
      }),
    ).resolves.toEqual({ executable: "codex", discoveryOutcome: "transient_failure" });
  });
});
