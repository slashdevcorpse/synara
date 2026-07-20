// FILE: windowsProviderProcess.ts
// Purpose: Routes Windows provider-only child launches through the atomic Job Object helper.
// Layer: Server provider process supervision

import { existsSync, statSync } from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareResolvedWindowsSafeProcess,
  prepareWindowsSafeProcess,
  type WindowsSafeProcessCommand,
  type WindowsSafeProcessInput,
} from "@synara/shared/windowsProcess";

export const WINDOWS_JOB_LAUNCHER_ENV = "SYNARA_WINDOWS_JOB_LAUNCHER_PATH";
export const WINDOWS_JOB_LAUNCHER_EXECUTABLE = "synara-windows-job-launcher.exe";
export const WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION = "1";

export interface WindowsProviderProcessInput extends WindowsSafeProcessInput {
  readonly arch?: NodeJS.Architecture | undefined;
  readonly launcherPath?: string | undefined;
  readonly fileExists?: ((path: string) => boolean) | undefined;
}

function defaultFileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveRuntimeDirectory(): string {
  return Path.dirname(fileURLToPath(import.meta.url));
}

export function resolveWindowsJobLauncherPath(input: WindowsProviderProcessInput = {}): string {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("The Windows Job launcher is only available on Windows.");
  }
  const arch = input.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Windows provider containment does not support architecture '${arch}'.`);
  }

  const runtimeDirectory = resolveRuntimeDirectory();
  const explicitPath =
    readNonEmpty(input.launcherPath) ??
    readNonEmpty(input.env?.[WINDOWS_JOB_LAUNCHER_ENV]) ??
    readNonEmpty(process.env[WINDOWS_JOB_LAUNCHER_ENV]);
  const candidates = explicitPath
    ? [explicitPath]
    : [
        // Bundled CLI: import.meta.url is apps/server/dist/index.mjs.
        Path.join(runtimeDirectory, "native", `win32-${arch}`, WINDOWS_JOB_LAUNCHER_EXECUTABLE),
        // Source/dev: import.meta.url is apps/server/src/provider/windowsProviderProcess.ts.
        Path.resolve(
          runtimeDirectory,
          "..",
          "..",
          "native",
          "windows-job-launcher",
          "out",
          `win32-${arch}`,
          WINDOWS_JOB_LAUNCHER_EXECUTABLE,
        ),
      ];
  const fileExists = input.fileExists ?? defaultFileExists;
  for (const candidate of candidates) {
    const resolved = Path.resolve(candidate);
    if (fileExists(resolved)) {
      return resolved;
    }
  }

  throw new Error(
    [
      `Windows provider containment helper is required for win32-${arch} but was not found.`,
      `Checked: ${candidates.map((candidate) => Path.resolve(candidate)).join(", ")}.`,
      "Build it with: node apps/server/scripts/build-windows-job-launcher.mjs --arch " + arch,
      `Packaged desktop builds must set ${WINDOWS_JOB_LAUNCHER_ENV} to their signed extraFile.`,
      "Refusing to fall back to a post-spawn, racy process-tree capture.",
    ].join(" "),
  );
}

function resolveAbsolutePreparedCommand(command: string, cwd: string | undefined): string {
  if (Path.win32.isAbsolute(command)) {
    return Path.win32.normalize(command);
  }
  if (/[\\/]/.test(command)) {
    return Path.win32.resolve(cwd ?? process.cwd(), command);
  }
  throw new Error(
    `Windows provider target '${command}' was not resolved to an absolute executable path; containment refuses PATH/CWD fallback.`,
  );
}

export function containPreparedWindowsProviderProcess(
  prepared: WindowsSafeProcessCommand,
  input: WindowsProviderProcessInput = {},
): WindowsSafeProcessCommand {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return prepared;
  }

  const launcherPath = resolveWindowsJobLauncherPath(input);
  const target = resolveAbsolutePreparedCommand(prepared.command, input.cwd);
  const argumentMode = prepared.windowsVerbatimArguments ? "verbatim" : "argv";
  return {
    command: launcherPath,
    args: [
      "--protocol",
      WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
      "--argument-mode",
      argumentMode,
      "--",
      target,
      ...prepared.args,
    ],
    shell: false,
    windowsHide: true,
  };
}

export function prepareWindowsProviderProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput = {},
): WindowsSafeProcessCommand {
  return containPreparedWindowsProviderProcess(
    prepareWindowsSafeProcess(command, args, input),
    input,
  );
}

export function prepareResolvedWindowsProviderProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput = {},
): WindowsSafeProcessCommand {
  return containPreparedWindowsProviderProcess(
    prepareResolvedWindowsSafeProcess(command, args, input),
    input,
  );
}
