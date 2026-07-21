// FILE: AcpWindowsJob.ts
// Purpose: Wraps Windows ACP providers in a kernel Job Object before provider code executes.
// Layer: Provider ACP process-launch infrastructure.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildWindowsCreateProcessCommandLine,
  resolveWindowsSystemRoot,
  type WindowsSafeProcessCommand,
} from "@synara/shared/windowsProcess";

// CreateProcessW's documented 32,767-character limit includes the terminating NUL.
const WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_WITHOUT_NULL = 32_766;
const ACP_WINDOWS_JOB_COMPILER_TIMEOUT_MS = 60_000;
const ACP_WINDOWS_JOB_COMPILER_OUTPUT_MAX_BYTES = 256 * 1024;
const WINDOWS_PE_MINIMUM_IMAGE_BYTES = 1_024;
const WINDOWS_PE_SECTION_HEADER_BYTES = 40;
const WINDOWS_PE32_OPTIONAL_HEADER_BYTES = 0xe0;
const WINDOWS_PE32_PLUS_OPTIONAL_HEADER_BYTES = 0xf0;
const WINDOWS_PE_CODE_SECTION = 0x0000_0020;
const WINDOWS_PE_EXECUTE_SECTION = 0x2000_0000;

export interface AcpWindowsJobLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: false;
  readonly windowsHide: true;
  readonly windowsVerbatimArguments?: undefined;
}

export interface AcpWindowsJobAssets {
  readonly compilerPath: string;
  readonly nativeSourcePath: string;
}

export type AcpWindowsJobCompiler = (input: {
  readonly powershell: string;
  readonly compilerPath: string;
  readonly sourceHash: string;
  readonly outputPath: string;
}) => Promise<void>;

function defaultAcpWindowsJobAssets(): AcpWindowsJobAssets {
  const directories = [
    // Bundled CLI/desktop layout: the build copies both helpers beside dist/index.mjs.
    fileURLToPath(new URL("./", import.meta.url)),
    // Source/Vitest layout.
    fileURLToPath(new URL("../../../scripts/", import.meta.url)),
  ];
  for (const directory of directories) {
    const compilerPath = Path.join(directory, "acp-windows-job.ps1");
    const nativeSourcePath = Path.join(directory, "acp-windows-job-native.cs");
    if (existsSync(compilerPath) && existsSync(nativeSourcePath)) {
      return { compilerPath, nativeSourcePath };
    }
  }
  throw new Error(`Windows ACP Job Object assets are missing (checked ${directories.join(", ")}).`);
}

function isUsableWindowsExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    const image = readFileSync(path);
    if (
      image.length < WINDOWS_PE_MINIMUM_IMAGE_BYTES ||
      image.subarray(0, 2).toString("ascii") !== "MZ"
    ) {
      return false;
    }
    const peOffset = image.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > image.length - 24) return false;
    if (image.readUInt32LE(peOffset) !== 0x0000_4550) return false;

    const machine = image.readUInt16LE(peOffset + 4);
    if (machine !== 0x014c && machine !== 0x8664 && machine !== 0xaa64) return false;
    const sectionCount = image.readUInt16LE(peOffset + 6);
    if (sectionCount < 1 || sectionCount > 96) return false;
    const optionalHeaderSize = image.readUInt16LE(peOffset + 20);
    const characteristics = image.readUInt16LE(peOffset + 22);
    if ((characteristics & 0x0002) === 0) return false;

    const optionalHeaderOffset = peOffset + 24;
    const optionalHeaderMagic = image.readUInt16LE(optionalHeaderOffset);
    const minimumOptionalHeaderSize =
      optionalHeaderMagic === 0x010b
        ? WINDOWS_PE32_OPTIONAL_HEADER_BYTES
        : optionalHeaderMagic === 0x020b
          ? WINDOWS_PE32_PLUS_OPTIONAL_HEADER_BYTES
          : 0;
    if (minimumOptionalHeaderSize === 0 || optionalHeaderSize < minimumOptionalHeaderSize) {
      return false;
    }

    const addressOfEntryPoint = image.readUInt32LE(optionalHeaderOffset + 16);
    const sectionAlignment = image.readUInt32LE(optionalHeaderOffset + 32);
    const fileAlignment = image.readUInt32LE(optionalHeaderOffset + 36);
    const sizeOfImage = image.readUInt32LE(optionalHeaderOffset + 56);
    const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
    const sectionTableEnd = sectionTableOffset + sectionCount * WINDOWS_PE_SECTION_HEADER_BYTES;
    if (sectionTableEnd > image.length) return false;
    const sizeOfHeaders = image.readUInt32LE(optionalHeaderOffset + 60);
    const subsystem = image.readUInt16LE(optionalHeaderOffset + 68);
    const numberOfDataDirectories = image.readUInt32LE(
      optionalHeaderOffset + (optionalHeaderMagic === 0x010b ? 92 : 108),
    );
    const isPowerOfTwo = (value: number): boolean => value > 0 && (value & (value - 1)) === 0;
    if (
      addressOfEntryPoint === 0 ||
      !isPowerOfTwo(fileAlignment) ||
      fileAlignment < 0x200 ||
      fileAlignment > 0x1_0000 ||
      !isPowerOfTwo(sectionAlignment) ||
      sectionAlignment < fileAlignment ||
      sizeOfImage === 0 ||
      sizeOfImage % sectionAlignment !== 0 ||
      sizeOfHeaders < sectionTableEnd ||
      sizeOfHeaders > image.length ||
      sizeOfHeaders % fileAlignment !== 0 ||
      (subsystem !== 2 && subsystem !== 3) ||
      numberOfDataDirectories < 1 ||
      numberOfDataDirectories > 16
    ) {
      return false;
    }

    let hasRawData = false;
    let entryPointInExecutableCode = false;
    for (let index = 0; index < sectionCount; index += 1) {
      const sectionOffset = sectionTableOffset + index * WINDOWS_PE_SECTION_HEADER_BYTES;
      const virtualSize = image.readUInt32LE(sectionOffset + 8);
      const virtualAddress = image.readUInt32LE(sectionOffset + 12);
      const rawDataSize = image.readUInt32LE(sectionOffset + 16);
      const rawDataOffset = image.readUInt32LE(sectionOffset + 20);
      const sectionCharacteristics = image.readUInt32LE(sectionOffset + 36);
      const virtualSpan = Math.max(virtualSize, rawDataSize);
      if (
        virtualSpan === 0 ||
        virtualAddress < sectionAlignment ||
        virtualAddress % sectionAlignment !== 0 ||
        virtualAddress + virtualSpan > sizeOfImage
      ) {
        return false;
      }
      if (rawDataSize > 0) {
        if (
          rawDataOffset < sizeOfHeaders ||
          rawDataOffset % fileAlignment !== 0 ||
          rawDataSize % fileAlignment !== 0 ||
          rawDataOffset + rawDataSize > image.length
        ) {
          return false;
        }
        hasRawData = true;
      }
      if (
        addressOfEntryPoint >= virtualAddress &&
        addressOfEntryPoint < virtualAddress + virtualSpan &&
        (sectionCharacteristics & WINDOWS_PE_CODE_SECTION) !== 0 &&
        (sectionCharacteristics & WINDOWS_PE_EXECUTE_SECTION) !== 0
      ) {
        entryPointInExecutableCode = true;
      }
    }
    return hasRawData && entryPointInExecutableCode;
  } catch {
    return false;
  }
}

const defaultCompiler: AcpWindowsJobCompiler = (input) =>
  new Promise<void>((resolve, reject) => {
    execFile(
      input.powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        input.compilerPath,
        "-ExpectedSourceHash",
        input.sourceHash,
        "-OutputPath",
        input.outputPath,
      ],
      {
        encoding: "utf8",
        maxBuffer: ACP_WINDOWS_JOB_COMPILER_OUTPUT_MAX_BYTES,
        timeout: ACP_WINDOWS_JOB_COMPILER_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve();
          return;
        }
        const detail = stderr.trim() || error.message;
        reject(new Error(`Windows ACP Job Object helper compilation failed: ${detail}`));
      },
    );
  });

const helperPreparations = new Map<string, Promise<string>>();

export function ensureAcpWindowsJobExecutable(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly assets?: AcpWindowsJobAssets;
  readonly compile?: AcpWindowsJobCompiler;
}): Promise<string> {
  const assets = input.assets ?? defaultAcpWindowsJobAssets();
  const source = readFileSync(assets.nativeSourcePath);
  const compilerSource = readFileSync(assets.compilerPath);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const cacheHash = createHash("sha256")
    .update(source)
    .update("\0")
    .update(compilerSource)
    .digest("hex");
  const outputPath = Path.join(tmpdir(), `synara-acp-job-${cacheHash}.exe`);
  if (isUsableWindowsExecutable(outputPath)) return Promise.resolve(outputPath);

  const existing = helperPreparations.get(outputPath);
  if (existing !== undefined) return existing;
  const powershell = Path.win32.join(
    resolveWindowsSystemRoot(input.env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const prepare = (input.compile ?? defaultCompiler)({
    powershell,
    compilerPath: assets.compilerPath,
    sourceHash,
    outputPath,
  }).then(() => {
    if (!isUsableWindowsExecutable(outputPath)) {
      throw new Error("Windows ACP Job Object compiler did not produce a valid executable.");
    }
    return outputPath;
  });
  helperPreparations.set(outputPath, prepare);
  void prepare.then(
    () => {
      if (helperPreparations.get(outputPath) === prepare) helperPreparations.delete(outputPath);
    },
    () => {
      if (helperPreparations.get(outputPath) === prepare) helperPreparations.delete(outputPath);
    },
  );
  return prepare;
}

export function buildAcpWindowsJobLaunch(input: {
  readonly provider: WindowsSafeProcessCommand;
  readonly helperExecutablePath: string;
  readonly cwd?: string;
  readonly parentProcessId?: number;
}): AcpWindowsJobLaunch {
  if (
    !Path.win32.isAbsolute(input.helperExecutablePath) ||
    /[\0\r\n]/u.test(input.helperExecutablePath)
  ) {
    throw new Error("Windows ACP Job Object executable path must be an absolute clean path.");
  }
  const providerCommand = Path.win32.isAbsolute(input.provider.command)
    ? input.provider.command
    : Path.win32.resolve(input.cwd ?? process.cwd(), input.provider.command);
  const commandLine = buildWindowsCreateProcessCommandLine(
    providerCommand,
    input.provider.args,
    input.provider.windowsVerbatimArguments === true,
  );
  const parentProcessId = input.parentProcessId ?? process.pid;
  if (!Number.isSafeInteger(parentProcessId) || parentProcessId <= 0) {
    throw new Error("Windows ACP Job Object parent PID must be a positive integer.");
  }
  const args = [
    Buffer.from(providerCommand, "utf8").toString("base64"),
    Buffer.from(commandLine, "utf8").toString("base64"),
    String(parentProcessId),
  ] as const;
  const createProcessCommandLength = buildWindowsCreateProcessCommandLine(
    input.helperExecutablePath,
    args,
  ).length;
  if (createProcessCommandLength > WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_WITHOUT_NULL) {
    throw new Error("Windows ACP Job Object launch exceeds the CreateProcessW command-line limit.");
  }
  return {
    command: input.helperExecutablePath,
    args,
    shell: false,
    windowsHide: true,
  };
}

export async function prepareAcpWindowsJobLaunch(input: {
  readonly provider: WindowsSafeProcessCommand;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): Promise<AcpWindowsJobLaunch> {
  const helperExecutablePath = await ensureAcpWindowsJobExecutable({ env: input.env });
  return buildAcpWindowsJobLaunch({
    provider: input.provider,
    helperExecutablePath,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
}
