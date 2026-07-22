#!/usr/bin/env node
// FILE: qualify-super-synara-windows-installer.ts
// Purpose: Runs the native Windows install, upgrade, startup, and uninstall qualification lane.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  launchPackagedDesktopAndWaitForStartup,
  verifyPackagedDesktopExecutableStartup,
} from "./verify-packaged-desktop-startup.ts";
import {
  qualifySuperSynaraWindowsInstaller,
  runNativeWindowsCommand,
  type WindowsExecutableIdentity,
  type WindowsInstallerQualificationOptions,
  type WindowsInstallerQualificationRuntime,
  type WindowsRegistryTarget,
} from "./lib/windows-installer-qualification.ts";
import { inspectUnsignedWindowsExecutable } from "./lib/windows-authenticode.ts";

interface CliOptions extends WindowsInstallerQualificationOptions {
  readonly reportPath: string;
}

export function parseWindowsInstallerQualificationArgs(argv: ReadonlyArray<string>): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid Windows qualification argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  const known = new Set([
    "--installer",
    "--upstream-installer",
    "--version",
    "--previous-installer",
    "--startup-timeout-ms",
    "--report",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown Windows qualification argument: ${name}.`);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing Windows qualification argument: ${name}.`);
    return value;
  };
  const startupTimeoutMs = Number(values.get("--startup-timeout-ms") ?? "60000");
  if (
    !Number.isInteger(startupTimeoutMs) ||
    startupTimeoutMs < 5_000 ||
    startupTimeoutMs > 180_000
  ) {
    throw new Error("--startup-timeout-ms must be an integer between 5000 and 180000.");
  }
  const installerPath = resolve(required("--installer"));
  const reportPath = resolve(required("--report"));
  const runnerTemp = process.env.RUNNER_TEMP?.trim();
  if (!runnerTemp) {
    throw new Error("RUNNER_TEMP is required for the native Windows qualification report.");
  }
  if (
    basename(reportPath) !== "windows-installer-qualification.json" ||
    dirname(reportPath).toLowerCase() !== resolve(runnerTemp).toLowerCase()
  ) {
    throw new Error(
      "--report must be windows-installer-qualification.json directly under RUNNER_TEMP.",
    );
  }
  return {
    installerPath,
    upstreamInstallerPath: resolve(required("--upstream-installer")),
    version: required("--version"),
    ...(values.get("--previous-installer")
      ? { previousInstallerPath: resolve(values.get("--previous-installer")!) }
      : {}),
    startupTimeoutMs,
    reportPath,
  };
}

function readRegistry(target: WindowsRegistryTarget): string | null {
  const result = spawnSync(
    "reg.exe",
    ["query", `${target.hive}\\${target.key}`, `/reg:${target.view}`],
    { encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  if (result.status === 1) return null;
  if (result.error || result.status !== 0) {
    throw new Error(
      `Registry query failed for ${target.id}: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function readExecutableIdentity(executablePath: string): WindowsExecutableIdentity {
  const identityEnvironment = { ...process.env, SUPER_SYNARA_QUALIFICATION_EXE: executablePath };
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$value = [Diagnostics.FileVersionInfo]::GetVersionInfo($env:SUPER_SYNARA_QUALIFICATION_EXE)",
    "[pscustomobject]@{ productName = $value.ProductName } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      env: identityEnvironment,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not read installed executable identity: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Partial<WindowsExecutableIdentity>;
  if (parsed.productName !== null && typeof parsed.productName !== "string") {
    throw new Error("Installed executable version resource omitted product identity.");
  }
  return { productName: parsed.productName ?? null };
}

export function createNativeWindowsInstallerQualificationRuntime(): WindowsInstallerQualificationRuntime {
  return {
    platform: process.platform,
    arch: process.arch,
    isEphemeralHostedRunner:
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.CI === "true" &&
      process.env.RUNNER_OS === "Windows" &&
      process.env.RUNNER_ARCH === "X64" &&
      typeof process.env.RUNNER_TEMP === "string" &&
      process.env.RUNNER_TEMP.length > 0,
    readRegistry,
    runCommand: runNativeWindowsCommand,
    readExecutableIdentity,
    inspectUnsignedAuthenticode: inspectUnsignedWindowsExecutable,
    launchStartupAndKeepRunning: launchPackagedDesktopAndWaitForStartup,
    verifyStartup: verifyPackagedDesktopExecutableStartup,
    sleep: (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseWindowsInstallerQualificationArgs(process.argv.slice(2));
  const report = await qualifySuperSynaraWindowsInstaller(
    options,
    createNativeWindowsInstallerQualificationRuntime(),
  );
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(options.reportPath, rendered, { encoding: "utf8", flag: "wx" });
  process.stdout.write(rendered);
}
