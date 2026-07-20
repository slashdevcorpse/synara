// FILE: windows-authenticode.ts
// Purpose: Performs and validates fail-closed native Windows Authenticode inspection.

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve, win32 } from "node:path";

export interface WindowsUnsignedAuthenticodeEvidence {
  readonly path: string;
  readonly status: "NotSigned";
  readonly signerCertificate: null;
  readonly timeStamperCertificate: null;
}

export interface WindowsAuthenticodeCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface WindowsAuthenticodeInspectionRuntime {
  readonly platform: NodeJS.Platform;
  readonly systemRoot?: string;
  readonly runPowerShell: (
    command: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) => WindowsAuthenticodeCommandResult;
}

const MAX_POWERSHELL_OUTPUT_BYTES = 1024 * 1024;

const AUTHENTICODE_INSPECTION_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$securityModule = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'",
  "Import-Module -Name $securityModule -Force -ErrorAction Stop",
  "$signature = Get-AuthenticodeSignature -LiteralPath $env:SUPER_SYNARA_AUTHENTICODE_PATH",
  "$signer = if ($null -eq $signature.SignerCertificate) { $null } else { [pscustomobject]@{ Subject = $signature.SignerCertificate.Subject; Thumbprint = $signature.SignerCertificate.Thumbprint } }",
  "$timestamp = if ($null -eq $signature.TimeStamperCertificate) { $null } else { [pscustomobject]@{ Subject = $signature.TimeStamperCertificate.Subject; Thumbprint = $signature.TimeStamperCertificate.Thumbprint } }",
  "[pscustomobject]@{ Status = [string]$signature.Status; Path = [string]$signature.Path; SignerCertificate = $signer; TimeStamperCertificate = $timestamp } | ConvertTo-Json -Compress -Depth 4",
].join("; ");

function nativeRuntime(): WindowsAuthenticodeInspectionRuntime {
  return {
    platform: process.platform,
    ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
    runPowerShell: (command, args, env) => {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        env,
        maxBuffer: MAX_POWERSHELL_OUTPUT_BYTES,
        shell: false,
        windowsHide: true,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(result.error ? { error: result.error } : {}),
      };
    },
  };
}

function requireExactUnsignedResult(
  executablePath: string,
  result: WindowsAuthenticodeCommandResult,
): WindowsUnsignedAuthenticodeEvidence {
  if (result.error) {
    throw new Error(`PowerShell Authenticode inspection could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `PowerShell Authenticode inspection failed with exit ${result.status ?? "unknown"}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  if (result.stderr.trim().length > 0) {
    throw new Error(`PowerShell Authenticode inspection wrote stderr: ${result.stderr.trim()}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("PowerShell Authenticode inspection returned malformed JSON.", {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PowerShell Authenticode inspection returned a non-object result.");
  }
  const signature = parsed as Record<string, unknown>;
  if (signature.Status !== "NotSigned") {
    throw new Error(`Authenticode status is ${String(signature.Status)}, not NotSigned.`);
  }
  if (
    typeof signature.Path !== "string" ||
    resolve(signature.Path).toLowerCase() !== executablePath.toLowerCase()
  ) {
    throw new Error("Authenticode inspection path does not match the exact executable.");
  }
  if (signature.SignerCertificate !== null) {
    throw new Error("Unsigned Authenticode evidence unexpectedly contains a signer certificate.");
  }
  if (signature.TimeStamperCertificate !== null) {
    throw new Error(
      "Unsigned Authenticode evidence unexpectedly contains a timestamp certificate.",
    );
  }
  return {
    path: executablePath,
    status: "NotSigned",
    signerCertificate: null,
    timeStamperCertificate: null,
  };
}

export function inspectUnsignedWindowsExecutable(
  inputPath: string,
  runtime: WindowsAuthenticodeInspectionRuntime = nativeRuntime(),
): WindowsUnsignedAuthenticodeEvidence {
  if (runtime.platform !== "win32") {
    throw new Error("Windows Authenticode inspection must run on Windows.");
  }
  const executablePath = resolve(inputPath);
  const entry = lstatSync(executablePath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Authenticode target must be a regular file: ${executablePath}.`);
  }
  const systemRoot = runtime.systemRoot?.trim();
  if (!systemRoot) {
    throw new Error("SystemRoot is required for Windows Authenticode inspection.");
  }
  const powershell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = runtime.runPowerShell(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "None",
      "-Command",
      AUTHENTICODE_INSPECTION_COMMAND,
    ],
    { ...process.env, SUPER_SYNARA_AUTHENTICODE_PATH: executablePath },
  );
  return requireExactUnsignedResult(executablePath, result);
}
