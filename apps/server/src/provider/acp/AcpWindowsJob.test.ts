import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildWindowsCreateProcessCommandLine,
  type WindowsSafeProcessCommand,
} from "@synara/shared/windowsProcess";

import { buildAcpWindowsJobLaunch, ensureAcpWindowsJobExecutable } from "./AcpWindowsJob.ts";
import { headerOnlyPortableExecutableFixture } from "./AcpWindowsJobTestSupport.ts";

const ACP_WINDOWS_JOB_EXECUTABLE_MAX_BYTES = 8 * 1024 * 1024;

function validPortableExecutableFixture(): Buffer {
  const image = Buffer.alloc(0x400);
  const peOffset = 0x80;
  const optionalHeaderOffset = peOffset + 24;
  const sectionTableOffset = optionalHeaderOffset + 0xe0;
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(peOffset, 0x3c);
  image.writeUInt32LE(0x0000_4550, peOffset);
  image.writeUInt16LE(0x014c, peOffset + 4);
  image.writeUInt16LE(1, peOffset + 6);
  image.writeUInt16LE(0xe0, peOffset + 20);
  image.writeUInt16LE(0x0002, peOffset + 22);
  image.writeUInt16LE(0x010b, optionalHeaderOffset);
  image.writeUInt32LE(0x1000, optionalHeaderOffset + 16);
  image.writeUInt32LE(0x1000, optionalHeaderOffset + 20);
  image.writeUInt32LE(0x0040_0000, optionalHeaderOffset + 28);
  image.writeUInt32LE(0x1000, optionalHeaderOffset + 32);
  image.writeUInt32LE(0x200, optionalHeaderOffset + 36);
  image.writeUInt32LE(0x2000, optionalHeaderOffset + 56);
  image.writeUInt32LE(0x200, optionalHeaderOffset + 60);
  image.writeUInt16LE(3, optionalHeaderOffset + 68);
  image.writeUInt32LE(16, optionalHeaderOffset + 92);
  image.write(".text", sectionTableOffset, "ascii");
  image.writeUInt32LE(0x10, sectionTableOffset + 8);
  image.writeUInt32LE(0x1000, sectionTableOffset + 12);
  image.writeUInt32LE(0x200, sectionTableOffset + 16);
  image.writeUInt32LE(0x200, sectionTableOffset + 20);
  image.writeUInt32LE(0x6000_0020, sectionTableOffset + 36);
  image[0x200] = 0xc3;
  return image;
}

function launchInputAtOuterCommandLength(targetLength: number): {
  readonly helperExecutablePath: string;
  readonly provider: WindowsSafeProcessCommand;
} {
  const providerCommand = "C:\\provider.exe";
  for (let helperPadding = 0; helperPadding < 8; helperPadding += 1) {
    const helperExecutablePath = `C:\\h${"x".repeat(helperPadding)}.exe`;
    let low = 0;
    let high = 40_000;
    while (low <= high) {
      const argumentLength = Math.floor((low + high) / 2);
      const provider = {
        command: providerCommand,
        args: ["a".repeat(argumentLength)],
        shell: false as const,
      };
      const providerCommandLine = buildWindowsCreateProcessCommandLine(
        provider.command,
        provider.args,
        false,
      );
      const outerLength = buildWindowsCreateProcessCommandLine(helperExecutablePath, [
        Buffer.from(provider.command, "utf8").toString("base64"),
        Buffer.from(providerCommandLine, "utf8").toString("base64"),
        "42",
      ]).length;
      if (outerLength === targetLength) return { helperExecutablePath, provider };
      if (outerLength < targetLength) low = argumentLength + 1;
      else high = argumentLength - 1;
    }
  }
  throw new Error(`Could not construct a Windows launch of exactly ${targetLength} characters.`);
}

describe("buildAcpWindowsJobLaunch", () => {
  it("encodes an exact native provider launch for the Job Object helper", () => {
    const launch = buildAcpWindowsJobLaunch({
      provider: {
        command: "C:\\Program Files\\provider.exe",
        args: ["--mode", "value with spaces"],
        shell: false,
        windowsHide: true,
      },
      helperExecutablePath: "C:\\Synara\\cache\\acp-windows-job.exe",
    });

    expect(launch.command).toBe("C:\\Synara\\cache\\acp-windows-job.exe");
    expect(Buffer.from(launch.args[0] ?? "", "base64").toString("utf8")).toBe(
      "C:\\Program Files\\provider.exe",
    );
    expect(Buffer.from(launch.args[1] ?? "", "base64").toString("utf8")).toBe(
      '"C:\\Program Files\\provider.exe" --mode "value with spaces"',
    );
    expect(launch.args[2]).toBe(String(process.pid));
  });

  it("preserves the already-safe verbatim cmd.exe command tail", () => {
    const launch = buildAcpWindowsJobLaunch({
      provider: {
        command: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/v:off", "/c", 'call "C:\\npm\\provider.cmd" "app-server"'],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
      helperExecutablePath: "C:\\Synara\\acp-windows-job.exe",
    });
    expect(Buffer.from(launch.args[1] ?? "", "base64").toString("utf8")).toBe(
      'C:\\Windows\\System32\\cmd.exe /d /s /v:off /c call "C:\\npm\\provider.cmd" "app-server"',
    );
  });

  it("rejects a helper path that is not absolute and clean", () => {
    expect(() =>
      buildAcpWindowsJobLaunch({
        provider: { command: "C:\\provider.exe", args: [], shell: false },
        helperExecutablePath: "relative\\acp-windows-job.exe",
      }),
    ).toThrow("absolute clean path");
  });

  it("resolves a relative provider path against the exact provider cwd", () => {
    const launch = buildAcpWindowsJobLaunch({
      provider: {
        command: ".\\bin\\provider.exe",
        args: [],
        shell: false,
      },
      helperExecutablePath: "C:\\Synara\\acp-windows-job.exe",
      cwd: "C:\\workspace",
      parentProcessId: 42,
    });

    expect(Buffer.from(launch.args[0] ?? "", "base64").toString("utf8")).toBe(
      "C:\\workspace\\bin\\provider.exe",
    );
    expect(launch.args[2]).toBe("42");
  });

  it("reserves the terminating NUL in the CreateProcessW command-line limit", () => {
    const accepted = launchInputAtOuterCommandLength(32_766);
    expect(
      buildAcpWindowsJobLaunch({
        ...accepted,
        parentProcessId: 42,
      }).command,
    ).toBe(accepted.helperExecutablePath);

    const rejected = launchInputAtOuterCommandLength(32_767);
    expect(() =>
      buildAcpWindowsJobLaunch({
        ...rejected,
        parentProcessId: 42,
      }),
    ).toThrow("CreateProcessW command-line limit");
  });

  it("rejects a header-shaped PE without a loadable image layout", async () => {
    const fixtureDirectory = await mkdtemp(Path.join(tmpdir(), "synara-acp-job-invalid-pe-"));
    const compilerPath = Path.join(fixtureDirectory, "acp-windows-job.ps1");
    const nativeSourcePath = Path.join(fixtureDirectory, "acp-windows-job-native.cs");
    await writeFile(compilerPath, "compiler fixture");
    await writeFile(nativeSourcePath, `invalid PE fixture ${fixtureDirectory}`);
    let executablePath: string | undefined;

    try {
      await expect(
        ensureAcpWindowsJobExecutable({
          env: { SystemRoot: "C:\\Windows" },
          assets: { compilerPath, nativeSourcePath },
          compile: async ({ outputPath }) => {
            executablePath = outputPath;
            await writeFile(outputPath, headerOnlyPortableExecutableFixture());
          },
        }),
      ).rejects.toThrow("did not produce a valid executable");
    } finally {
      if (executablePath !== undefined) await rm(executablePath, { force: true });
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("recompiles when a previously prepared cached executable is removed", async () => {
    const fixtureDirectory = await mkdtemp(Path.join(tmpdir(), "synara-acp-job-test-"));
    const compilerPath = Path.join(fixtureDirectory, "acp-windows-job.ps1");
    const nativeSourcePath = Path.join(fixtureDirectory, "acp-windows-job-native.cs");
    await writeFile(compilerPath, "compiler fixture");
    await writeFile(nativeSourcePath, `native fixture ${fixtureDirectory}`);
    let compileCalls = 0;
    let executablePath: string | undefined;

    try {
      const prepare = () =>
        ensureAcpWindowsJobExecutable({
          env: { SystemRoot: "C:\\Windows" },
          assets: { compilerPath, nativeSourcePath },
          compile: async ({ outputPath }) => {
            compileCalls += 1;
            await writeFile(outputPath, validPortableExecutableFixture());
          },
        });

      const [firstPreparation, concurrentPreparation] = await Promise.all([prepare(), prepare()]);
      executablePath = firstPreparation;
      expect(concurrentPreparation).toBe(executablePath);
      expect(compileCalls).toBe(1);
      await unlink(executablePath);
      expect(await prepare()).toBe(executablePath);
      expect(compileCalls).toBe(2);
    } finally {
      if (executablePath !== undefined) await rm(executablePath, { force: true });
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("recompiles when a valid cached executable is replaced with different bytes", async () => {
    const fixtureDirectory = await mkdtemp(Path.join(tmpdir(), "synara-acp-job-attestation-"));
    const compilerPath = Path.join(fixtureDirectory, "acp-windows-job.ps1");
    const nativeSourcePath = Path.join(fixtureDirectory, "acp-windows-job-native.cs");
    const compilerSource = Buffer.from(`compiler fixture ${fixtureDirectory}`, "utf8");
    const nativeSource = Buffer.from(`native fixture ${fixtureDirectory}`, "utf8");
    await writeFile(compilerPath, compilerSource);
    await writeFile(nativeSourcePath, nativeSource);
    const expectedExecutable = validPortableExecutableFixture();
    let compileCalls = 0;
    let executablePath: string | undefined;

    try {
      const prepare = () =>
        ensureAcpWindowsJobExecutable({
          env: { SystemRoot: "C:\\Windows" },
          assets: { compilerPath, nativeSourcePath },
          compile: async ({ compilerHash, outputPath, sourceHash }) => {
            compileCalls += 1;
            expect(compilerHash).toBe(createHash("sha256").update(compilerSource).digest("hex"));
            expect(sourceHash).toBe(createHash("sha256").update(nativeSource).digest("hex"));
            await writeFile(outputPath, expectedExecutable);
          },
        });

      executablePath = await prepare();
      const unrelatedExecutable = Buffer.from(expectedExecutable);
      unrelatedExecutable[0x201] = 0x90;
      await writeFile(executablePath, unrelatedExecutable);

      expect(await prepare()).toBe(executablePath);
      expect(compileCalls).toBe(2);
      expect(await readFile(executablePath)).toEqual(expectedExecutable);
    } finally {
      if (executablePath !== undefined) await rm(executablePath, { force: true });
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized cached executable without reading it into memory", async () => {
    const fixtureDirectory = await mkdtemp(Path.join(tmpdir(), "synara-acp-job-bounded-"));
    const compilerPath = Path.join(fixtureDirectory, "acp-windows-job.ps1");
    const nativeSourcePath = Path.join(fixtureDirectory, "acp-windows-job-native.cs");
    await writeFile(compilerPath, `compiler fixture ${fixtureDirectory}`);
    await writeFile(nativeSourcePath, `native fixture ${fixtureDirectory}`);
    let compileCalls = 0;
    let executablePath: string | undefined;

    try {
      const prepare = () =>
        ensureAcpWindowsJobExecutable({
          env: { SystemRoot: "C:\\Windows" },
          assets: { compilerPath, nativeSourcePath },
          compile: async ({ outputPath }) => {
            compileCalls += 1;
            await writeFile(outputPath, validPortableExecutableFixture());
          },
        });

      executablePath = await prepare();
      await truncate(executablePath, ACP_WINDOWS_JOB_EXECUTABLE_MAX_BYTES + 1);

      expect(await prepare()).toBe(executablePath);
      expect(compileCalls).toBe(2);
      expect((await readFile(executablePath)).byteLength).toBeLessThanOrEqual(
        ACP_WINDOWS_JOB_EXECUTABLE_MAX_BYTES,
      );
    } finally {
      if (executablePath !== undefined) await rm(executablePath, { force: true });
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
