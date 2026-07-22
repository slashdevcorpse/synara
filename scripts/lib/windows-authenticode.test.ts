import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectUnsignedWindowsExecutable,
  type WindowsAuthenticodeCommandResult,
  type WindowsAuthenticodeInspectionRuntime,
} from "./windows-authenticode.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "windows-authenticode-test-"));
  roots.push(root);
  const path = join(root, "Super Synara's installer.exe");
  writeFileSync(path, "fixture");
  return path;
}

function runtime(
  path: string,
  overrides: Partial<WindowsAuthenticodeCommandResult> = {},
): WindowsAuthenticodeInspectionRuntime {
  return {
    platform: "win32",
    systemRoot: "C:\\Windows",
    runPowerShell: (command, args, env) => {
      expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(args).toContain("-Command");
      const commandText = args.join(" ");
      const securityModuleAssignment =
        "$securityModule = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'";
      const securityModuleImport = "Import-Module -Name $securityModule -Force -ErrorAction Stop";
      const signatureInspection = "Get-AuthenticodeSignature -LiteralPath";
      expect(commandText).toContain(securityModuleAssignment);
      expect(commandText).toContain(securityModuleImport);
      expect(commandText).toContain(signatureInspection);
      expect(commandText.indexOf(securityModuleAssignment)).toBeLessThan(
        commandText.indexOf(securityModuleImport),
      );
      expect(commandText.indexOf(securityModuleImport)).toBeLessThan(
        commandText.indexOf(signatureInspection),
      );
      expect(commandText).not.toContain(path);
      expect(env.SUPER_SYNARA_AUTHENTICODE_PATH).toBe(resolve(path));
      return {
        status: 0,
        stdout: JSON.stringify({
          Status: "NotSigned",
          Path: resolve(path),
          SignerCertificate: null,
          TimeStamperCertificate: null,
        }),
        stderr: "",
        ...overrides,
      };
    },
  };
}

describe("Windows unsigned Authenticode inspection", () => {
  it("accepts only exact native NotSigned evidence without certificates", () => {
    const path = fixture();
    expect(inspectUnsignedWindowsExecutable(path, runtime(path))).toEqual({
      path: resolve(path),
      status: "NotSigned",
      signerCertificate: null,
      timeStamperCertificate: null,
    });
  });

  it.runIf(process.platform === "win32")(
    "loads the native Windows PowerShell security module explicitly",
    () => {
      expect(process.env.SystemRoot).toBeTruthy();
      const powershell = win32.join(
        process.env.SystemRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      expect(() => inspectUnsignedWindowsExecutable(powershell)).toThrow(
        "Authenticode status is Valid, not NotSigned.",
      );
    },
    60_000,
  );

  for (const status of ["Valid", "UnknownError", "HashMismatch", "NotTrusted"]) {
    it(`rejects Authenticode status ${status}`, () => {
      const path = fixture();
      expect(() =>
        inspectUnsignedWindowsExecutable(
          path,
          runtime(path, {
            stdout: JSON.stringify({
              Status: status,
              Path: resolve(path),
              SignerCertificate: status === "Valid" ? { Subject: "CN=Self Signed" } : null,
              TimeStamperCertificate: null,
            }),
          }),
        ),
      ).toThrow("not NotSigned");
    });
  }

  it.each([
    ["signer", { Subject: "CN=Unexpected", Thumbprint: "a".repeat(40) }, null],
    ["timestamp", null, { Subject: "CN=Unexpected TSA", Thumbprint: "b".repeat(40) }],
  ])("rejects a NotSigned result containing a %s certificate", (_label, signer, timestamp) => {
    const path = fixture();
    expect(() =>
      inspectUnsignedWindowsExecutable(
        path,
        runtime(path, {
          stdout: JSON.stringify({
            Status: "NotSigned",
            Path: resolve(path),
            SignerCertificate: signer,
            TimeStamperCertificate: timestamp,
          }),
        }),
      ),
    ).toThrow("certificate");
  });

  it.each([
    [
      "wrong path",
      {
        stdout: JSON.stringify({
          Status: "NotSigned",
          Path: "C:\\other.exe",
          SignerCertificate: null,
          TimeStamperCertificate: null,
        }),
      },
      "path does not match",
    ],
    ["malformed JSON", { stdout: "not-json" }, "malformed JSON"],
    ["stderr", { stderr: "warning" }, "wrote stderr"],
    ["nonzero exit", { status: 1, stderr: "failed" }, "failed with exit 1"],
    ["spawn error", { status: null, error: new Error("spawn failed") }, "could not start"],
  ])("rejects %s", (_label, overrides, message) => {
    const path = fixture();
    expect(() => inspectUnsignedWindowsExecutable(path, runtime(path, overrides))).toThrow(message);
  });

  it("rejects execution on non-Windows platforms", () => {
    const path = fixture();
    expect(() =>
      inspectUnsignedWindowsExecutable(path, { ...runtime(path), platform: "linux" }),
    ).toThrow("must run on Windows");
  });
});
