// FILE: windowsProviderProcess.ts
// Purpose: Routes Windows provider-only child launches through the atomic Job Object helper.
// Layer: Server provider process supervision

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import launcherConfig from "../../native/windows-job-launcher/launcher.config.json" with { type: "json" };

import {
  prepareResolvedWindowsSafeProcess,
  prepareWindowsSafeProcess,
  type WindowsCommandDiscoveryOutcome,
  type WindowsSafeProcessCommand,
  type WindowsSafeProcessInput,
} from "@synara/shared/windowsProcess";

const WINDOWS_JOB_PREPARED_COMMAND = Symbol("synara.windowsJobPreparedCommand");
const WINDOWS_JOB_CONTROL_FILE = Symbol("synara.windowsJobControlFile");

export interface WindowsJobPreparedCommand extends WindowsSafeProcessCommand {
  readonly [WINDOWS_JOB_PREPARED_COMMAND]: true;
  readonly [WINDOWS_JOB_CONTROL_FILE]: string;
}

export const WINDOWS_JOB_LAUNCHER_ENV = "SYNARA_WINDOWS_JOB_LAUNCHER_PATH";
export const WINDOWS_JOB_LAUNCHER_EXECUTABLE = launcherConfig.executableName;
export const WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION = launcherConfig.protocolVersion;

export interface WindowsProviderProcessInput extends WindowsSafeProcessInput {
  readonly arch?: NodeJS.Architecture | undefined;
  readonly launcherPath?: string | undefined;
  readonly fileExists?: ((path: string) => boolean) | undefined;
  readonly controlDirectory?: string | undefined;
}

export class WindowsProviderTargetNotResolvedError extends Error {
  readonly command: string;
  readonly discoveryOutcome: WindowsCommandDiscoveryOutcome | undefined;

  constructor(command: string, discoveryOutcome?: WindowsCommandDiscoveryOutcome) {
    super(
      `Windows provider target '${command}' was not resolved to an absolute executable path; containment refuses PATH/CWD fallback.`,
    );
    this.name = "WindowsProviderTargetNotResolvedError";
    this.command = command;
    this.discoveryOutcome = discoveryOutcome;
  }
}

export function isWindowsJobPreparedCommand(
  command: WindowsSafeProcessCommand,
): command is WindowsJobPreparedCommand {
  return (command as Partial<WindowsJobPreparedCommand>)[WINDOWS_JOB_PREPARED_COMMAND] === true;
}

export function windowsJobControlFilePath(command: WindowsJobPreparedCommand): string {
  return command[WINDOWS_JOB_CONTROL_FILE];
}

function markWindowsJobPreparedCommand(
  command: WindowsSafeProcessCommand,
  controlFilePath: string,
): WindowsJobPreparedCommand {
  Object.defineProperty(command, WINDOWS_JOB_PREPARED_COMMAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  Object.defineProperty(command, WINDOWS_JOB_CONTROL_FILE, {
    configurable: false,
    enumerable: false,
    value: controlFilePath,
    writable: false,
  });
  return command as WindowsJobPreparedCommand;
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

function resolveLauncherCandidate(candidate: string): string {
  return /^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith("\\\\")
    ? Path.win32.normalize(candidate)
    : Path.resolve(candidate);
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
    const resolved = resolveLauncherCandidate(candidate);
    if (fileExists(resolved)) {
      return resolved;
    }
  }

  throw new Error(
    [
      `Windows provider containment helper is required for win32-${arch} but was not found.`,
      `Checked: ${candidates.map(resolveLauncherCandidate).join(", ")}.`,
      "Build it with: node apps/server/scripts/build-windows-job-launcher.mjs --arch " + arch,
      `Packaged desktop builds must set ${WINDOWS_JOB_LAUNCHER_ENV} to their signed extraFile.`,
      "Refusing to fall back to a post-spawn, racy process-tree capture.",
    ].join(" "),
  );
}

function resolveAbsolutePreparedCommand(command: string, cwd: string | undefined): string {
  if (/^[A-Za-z]:[\\/]/u.test(command) || command.startsWith("\\\\")) {
    return Path.win32.normalize(command);
  }
  if (/^[\\/](?![\\/])/u.test(command)) {
    const baseDirectory = cwd ?? process.cwd();
    const baseRoot = Path.win32.parse(baseDirectory).root;
    if (!/^[A-Za-z]:[\\/]$/u.test(baseRoot) && !baseRoot.startsWith("\\\\")) {
      throw new Error(
        `Windows provider target '${command}' is drive-rooted but no absolute Windows cwd was available to qualify it.`,
      );
    }
    return Path.win32.resolve(baseDirectory, command);
  }
  if (/[\\/]/.test(command)) {
    return Path.win32.resolve(cwd ?? process.cwd(), command);
  }
  throw new WindowsProviderTargetNotResolvedError(command);
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
  const controlDirectory = input.controlDirectory ?? OS.tmpdir();
  const controlFilePath = Path.win32.join(
    controlDirectory,
    `synara-job-control-${process.pid}-${randomUUID()}.signal`,
  );
  return markWindowsJobPreparedCommand(
    {
      command: launcherPath,
      args: [
        "--protocol",
        WINDOWS_JOB_LAUNCHER_PROTOCOL_VERSION,
        "--argument-mode",
        argumentMode,
        "--control-file",
        controlFilePath,
        "--",
        target,
        ...prepared.args,
      ],
      shell: false,
      windowsHide: true,
    },
    controlFilePath,
  );
}

export function prepareWindowsProviderProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsProviderProcessInput = {},
): WindowsSafeProcessCommand {
  let discoveryOutcome: WindowsCommandDiscoveryOutcome | undefined;
  const prepared = prepareWindowsSafeProcess(command, args, {
    ...input,
    onCommandDiscovery: (observation) => {
      discoveryOutcome = observation.outcome;
      input.onCommandDiscovery?.(observation);
    },
  });
  try {
    return containPreparedWindowsProviderProcess(prepared, input);
  } catch (cause) {
    if (cause instanceof WindowsProviderTargetNotResolvedError && discoveryOutcome !== undefined) {
      throw new WindowsProviderTargetNotResolvedError(cause.command, discoveryOutcome);
    }
    throw cause;
  }
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
