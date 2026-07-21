#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import launcherConfig from "../native/windows-job-launcher/launcher.config.json" with { type: "json" };

const scriptPath = fileURLToPath(import.meta.url);
const serverDirectory = resolve(dirname(scriptPath), "..");
const projectPath = join(
  serverDirectory,
  "native",
  "windows-job-launcher",
  "windows-job-launcher.vcxproj",
);
const executableName = launcherConfig.executableName;

export const supportedWindowsJobLauncherArchitectures = Object.freeze([
  ...launcherConfig.architectures,
]);

export function publishWindowsJobLauncherArtifact(
  builtPath,
  resolvedOutputPath,
  { copyFile = copyFileSync, removeFile = rmSync, renameFile = renameSync } = {},
) {
  const pendingPath = `${resolvedOutputPath}.pending-${process.pid}`;
  removeFile(pendingPath, { force: true });
  try {
    copyFile(builtPath, pendingPath);
    // rename(2)/MoveFileEx replaces the destination as one filesystem operation.
    // Do not unlink the last known-good launcher first: if replacement fails (for
    // example because Windows still has the binary open), callers keep using it.
    renameFile(pendingPath, resolvedOutputPath);
  } finally {
    removeFile(pendingPath, { force: true });
  }
}

export function defaultWindowsJobLauncherPath(arch = process.arch) {
  if (!supportedWindowsJobLauncherArchitectures.includes(arch)) {
    throw new Error(`Unsupported Windows Job launcher architecture: ${arch}`);
  }
  return join(
    serverDirectory,
    "native",
    "windows-job-launcher",
    "out",
    `win32-${arch}`,
    executableName,
  );
}

function findVsWhere() {
  const candidates = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter(Boolean)
    .map((root) => join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe"));
  return candidates.find(existsSync) ?? null;
}

function findMsBuild(arch) {
  const vswhere = findVsWhere();
  if (!vswhere) {
    throw new Error(
      "Visual Studio vswhere.exe was not found. Install Visual Studio 2022 Build Tools with Desktop development with C++.",
    );
  }
  const requiredComponent =
    arch === "arm64"
      ? "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
      : "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";
  const result = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-version",
      "[17.0,18.0)",
      "-requires",
      requiredComponent,
      "-find",
      "MSBuild\\**\\Bin\\MSBuild.exe",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const msbuild = result.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (result.status !== 0 || !msbuild || !existsSync(msbuild)) {
    throw new Error(
      `Visual Studio 2022 is missing ${requiredComponent}; install the matching x64/ARM64 C++ build tools.`,
    );
  }
  return msbuild;
}

function assertPeArchitecture(filePath, arch) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`Built helper is not a PE executable: ${filePath}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`Built helper has an invalid PE header: ${filePath}`);
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const expectedMachine = arch === "arm64" ? 0xaa64 : 0x8664;
  if (machine !== expectedMachine) {
    throw new Error(
      `Built helper machine 0x${machine.toString(16)} does not match ${arch} (0x${expectedMachine.toString(16)}).`,
    );
  }
}

export function buildWindowsJobLauncher({ arch = process.arch, outputPath } = {}) {
  if (process.platform !== "win32") {
    throw new Error("The Windows Job launcher can only be built on Windows.");
  }
  if (!supportedWindowsJobLauncherArchitectures.includes(arch)) {
    throw new Error(`Unsupported Windows Job launcher architecture: ${arch}`);
  }
  const resolvedOutputPath = resolve(outputPath ?? defaultWindowsJobLauncherPath(arch));
  const msbuild = findMsBuild(arch);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "synara-windows-job-launcher-"));
  const buildOutputDirectory = join(temporaryDirectory, "out");
  const intermediateDirectory = join(temporaryDirectory, "obj");
  const platform = arch === "arm64" ? "ARM64" : "x64";

  try {
    const result = spawnSync(
      msbuild,
      [
        projectPath,
        "/nologo",
        "/m",
        "/t:Build",
        "/p:Configuration=Release",
        `/p:Platform=${platform}`,
        `/p:SynaraOutputDirectory=${buildOutputDirectory}\\`,
        `/p:SynaraIntermediateDirectory=${intermediateDirectory}\\`,
      ],
      { cwd: serverDirectory, encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) {
      const details = [result.stdout, result.stderr]
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .join("\n")
        .trim();
      throw new Error(
        `Windows Job launcher build failed with exit code ${result.status ?? "unknown"}.${details ? `\n${details}` : ""}`,
      );
    }

    const builtPath = join(buildOutputDirectory, executableName);
    if (!existsSync(builtPath)) {
      throw new Error(`MSBuild did not produce ${builtPath}.`);
    }
    assertPeArchitecture(builtPath, arch);
    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    publishWindowsJobLauncherArtifact(builtPath, resolvedOutputPath);
    const digest = createHash("sha256").update(readFileSync(resolvedOutputPath)).digest("hex");
    console.error(
      `[windows-job-launcher] Built win32-${arch} ${resolvedOutputPath} sha256=${digest}`,
    );
    return resolvedOutputPath;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseCommandLine(args) {
  let arch = process.arch;
  let outputPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--arch") {
      arch = args[++index];
      if (!arch) throw new Error("--arch requires x64 or arm64.");
    } else if (argument === "--output") {
      outputPath = args[++index];
      if (!outputPath) throw new Error("--output requires a file path.");
    } else {
      throw new Error(`Unknown Windows Job launcher build argument: ${argument}`);
    }
  }
  return { arch, outputPath };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    buildWindowsJobLauncher(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
