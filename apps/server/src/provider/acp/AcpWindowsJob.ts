// FILE: AcpWindowsJob.ts
// Purpose: Wraps Windows ACP providers in a kernel Job Object before provider code executes.
// Layer: Provider ACP process-launch infrastructure.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, rmdirSync, rmSync } from "node:fs";
import * as NodeFs from "node:fs/promises";
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
const ACP_WINDOWS_JOB_ASSET_MAX_BYTES = 2 * 1024 * 1024;
const ACP_WINDOWS_JOB_EXECUTABLE_MAX_BYTES = 8 * 1024 * 1024;
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
  readonly compilerHash: string;
  readonly sourceHash: string;
  readonly outputPath: string;
}) => Promise<void>;

interface PreparedAcpWindowsJobExecutable {
  readonly outputPath: string;
  readonly sha256: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFs.access(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

async function defaultAcpWindowsJobAssets(): Promise<AcpWindowsJobAssets> {
  const directories = [
    // Bundled CLI/desktop layout: the build copies both helpers beside dist/index.mjs.
    fileURLToPath(new URL("./", import.meta.url)),
    // Source/Vitest layout.
    fileURLToPath(new URL("../../../scripts/", import.meta.url)),
  ];
  for (const directory of directories) {
    const compilerPath = Path.join(directory, "acp-windows-job.ps1");
    const nativeSourcePath = Path.join(directory, "acp-windows-job-native.cs");
    const [hasCompiler, hasNativeSource] = await Promise.all([
      pathExists(compilerPath),
      pathExists(nativeSourcePath),
    ]);
    if (hasCompiler && hasNativeSource) {
      return { compilerPath, nativeSourcePath };
    }
  }
  throw new Error(`Windows ACP Job Object assets are missing (checked ${directories.join(", ")}).`);
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  minimumBytes = 1,
): Promise<Buffer> {
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await NodeFs.open(path, flags);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size < minimumBytes ||
      before.size > maximumBytes
    ) {
      throw new Error(
        `File size is outside the allowed ${minimumBytes}-${maximumBytes} byte range.`,
      );
    }

    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("File ended while it was being read.");
      offset += bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const overflowRead = await handle.read(overflow, 0, 1, bytes.length);
    const after = await handle.stat();
    if (
      overflowRead.bytesRead !== 0 ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error("File identity or size changed while it was being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function isUsableWindowsExecutableImage(image: Buffer): boolean {
  try {
    if (image.subarray(0, 2).toString("ascii") !== "MZ") return false;
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

async function attestWindowsExecutable(
  path: string,
): Promise<PreparedAcpWindowsJobExecutable | null> {
  try {
    const image = await readBoundedRegularFile(
      path,
      ACP_WINDOWS_JOB_EXECUTABLE_MAX_BYTES,
      WINDOWS_PE_MINIMUM_IMAGE_BYTES,
    );
    if (!isUsableWindowsExecutableImage(image)) return null;
    return {
      outputPath: path,
      sha256: createHash("sha256").update(image).digest("hex"),
    };
  } catch {
    return null;
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
        "-ExpectedCompilerHash",
        input.compilerHash,
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

interface AcpWindowsJobHelperState {
  readonly outputPath: string;
  prepared?: PreparedAcpWindowsJobExecutable;
  preparing?: Promise<PreparedAcpWindowsJobExecutable>;
}

const helperStates = new Map<string, AcpWindowsJobHelperState>();
const helperOutputPaths = new Set<string>();
let helperRootPreparation: Promise<string> | undefined;
let helperRootPath: string | undefined;
let helperRootCleanupRegistered = false;

async function prepareHelperRoot(): Promise<string> {
  const temporaryRoot = await NodeFs.realpath(tmpdir());
  const created = await NodeFs.mkdtemp(Path.join(temporaryRoot, "synara-acp-job-"));
  if (process.platform !== "win32") await NodeFs.chmod(created, 0o700);
  const stat = await NodeFs.lstat(created);
  const canonical = await NodeFs.realpath(created);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Path.dirname(canonical) !== temporaryRoot ||
    !Path.basename(canonical).startsWith("synara-acp-job-")
  ) {
    throw new Error("Windows ACP Job Object helper root is not a private temporary directory.");
  }
  helperRootPath = canonical;
  if (!helperRootCleanupRegistered) {
    helperRootCleanupRegistered = true;
    process.once("exit", () => {
      const root = helperRootPath;
      if (root === undefined) return;
      for (const outputPath of helperOutputPaths) {
        if (Path.dirname(outputPath) !== root) continue;
        try {
          rmSync(outputPath, { force: true });
        } catch {
          // Best-effort cleanup during process exit.
        }
      }
      try {
        rmdirSync(root);
      } catch {
        // Best-effort cleanup during process exit.
      }
    });
  }
  return canonical;
}

function getHelperRoot(): Promise<string> {
  helperRootPreparation ??= prepareHelperRoot();
  return helperRootPreparation;
}

async function prepareWindowsJobExecutable(input: {
  readonly state: AcpWindowsJobHelperState;
  readonly compiler: AcpWindowsJobCompiler;
  readonly powershell: string;
  readonly compilerPath: string;
  readonly compilerHash: string;
  readonly sourceHash: string;
}): Promise<PreparedAcpWindowsJobExecutable> {
  const previous = input.state.prepared;
  if (previous !== undefined) {
    const current = await attestWindowsExecutable(previous.outputPath);
    if (current?.sha256 === previous.sha256) return previous;
  }

  await NodeFs.rm(input.state.outputPath, { force: true });
  await input.compiler({
    powershell: input.powershell,
    compilerPath: input.compilerPath,
    compilerHash: input.compilerHash,
    sourceHash: input.sourceHash,
    outputPath: input.state.outputPath,
  });
  const prepared = await attestWindowsExecutable(input.state.outputPath);
  if (prepared === null) {
    await NodeFs.rm(input.state.outputPath, { force: true });
    throw new Error("Windows ACP Job Object compiler did not produce a valid executable.");
  }
  return prepared;
}

export async function ensureAcpWindowsJobExecutable(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly assets?: AcpWindowsJobAssets;
  readonly compile?: AcpWindowsJobCompiler;
}): Promise<string> {
  const assets = input.assets ?? (await defaultAcpWindowsJobAssets());
  const [source, compilerSource] = await Promise.all([
    readBoundedRegularFile(assets.nativeSourcePath, ACP_WINDOWS_JOB_ASSET_MAX_BYTES),
    readBoundedRegularFile(assets.compilerPath, ACP_WINDOWS_JOB_ASSET_MAX_BYTES),
  ]);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const compilerHash = createHash("sha256").update(compilerSource).digest("hex");
  const cacheHash = createHash("sha256")
    .update(source)
    .update("\0")
    .update(compilerSource)
    .digest("hex");
  let state = helperStates.get(cacheHash);
  if (state === undefined) {
    const helperRoot = await getHelperRoot();
    state = helperStates.get(cacheHash);
    if (state === undefined) {
      const outputPath = Path.join(helperRoot, `synara-acp-job-${cacheHash}.exe`);
      state = { outputPath };
      helperStates.set(cacheHash, state);
      helperOutputPaths.add(outputPath);
    }
  }
  if (state.preparing !== undefined) return (await state.preparing).outputPath;

  const powershell = Path.win32.join(
    resolveWindowsSystemRoot(input.env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const prepare = prepareWindowsJobExecutable({
    state,
    compiler: input.compile ?? defaultCompiler,
    powershell,
    compilerPath: assets.compilerPath,
    compilerHash,
    sourceHash,
  });
  state.preparing = prepare;
  try {
    const prepared = await prepare;
    state.prepared = prepared;
    return prepared.outputPath;
  } catch (cause) {
    if (helperStates.get(cacheHash) === state) helperStates.delete(cacheHash);
    throw cause;
  } finally {
    if (state.preparing === prepare) state.preparing = undefined;
  }
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
