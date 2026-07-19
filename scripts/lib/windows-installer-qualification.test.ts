import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

import {
  canonicalizeRegistryQueryOutput,
  createSilentInstallerCommand,
  createWindowsRegistrationTargets,
  parseRegistryQueryOutput,
  parseWindowsExecutableCommandLine,
  qualifySuperSynaraWindowsInstaller,
  type WindowsCommandSpec,
  type WindowsInstallerQualificationRuntime,
  type WindowsRegistryTarget,
} from "./windows-installer-qualification.ts";

const roots: string[] = [];
const identity = synaraDesktopIdentity("super");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installer(root: string, version: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, `Super-Synara-${version}-windows-x64-unsigned.exe`);
  writeFileSync(path, "fake-installer");
  return path;
}

function upstreamInstaller(root: string, version = "0.5.5"): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, `Synara-${version}-x64.exe`);
  writeFileSync(path, "fake-upstream-installer");
  return path;
}

function registryOutput(target: WindowsRegistryTarget, values: Record<string, string>): string {
  const hive = target.hive === "HKCU" ? "HKEY_CURRENT_USER" : "HKEY_LOCAL_MACHINE";
  return [
    "",
    `${hive}\\${target.key}`,
    ...Object.entries(values).map(([name, value]) => `    ${name}    REG_SZ    ${value}`),
    "",
  ].join("\r\n");
}

interface FakeRuntime extends WindowsInstallerQualificationRuntime {
  readonly commands: WindowsCommandSpec[];
  readonly registry: Map<string, string>;
  readonly startupEnvironments: NodeJS.ProcessEnv[];
  readonly lifecycleEvents: string[];
  upstreamRunning: boolean;
  exitUpstreamBeforeSuperStartup: boolean;
  failAfterCurrentInstall: boolean;
  mutateUpstreamOnSuperInstall: boolean;
  includeVendorExecutable: boolean;
}

function fakeRuntime(): FakeRuntime {
  const commands: WindowsCommandSpec[] = [];
  const registry = new Map<string, string>();
  const startupEnvironments: NodeJS.ProcessEnv[] = [];
  const lifecycleEvents: string[] = [];
  let upstreamInstallDirectory: string | null = null;
  const runtime: FakeRuntime = {
    platform: "win32",
    arch: "x64",
    isEphemeralHostedRunner: true,
    commands,
    registry,
    startupEnvironments,
    lifecycleEvents,
    upstreamRunning: false,
    exitUpstreamBeforeSuperStartup: false,
    failAfterCurrentInstall: false,
    mutateUpstreamOnSuperInstall: false,
    includeVendorExecutable: false,
    readRegistry: (target) => registry.get(`${target.id}:${target.key}`) ?? null,
    runCommand: (spec) => {
      commands.push(spec);
      lifecycleEvents.push(spec.label);
      const commandName = spec.command.split(/[\\/]/).at(-1) ?? "";
      const superInstallerMatch = /^Super-Synara-(.+)-windows-x64-unsigned\.exe$/.exec(commandName);
      const upstreamInstallerMatch = /^Synara-(.+)-x64\.exe$/.exec(commandName);
      const installerMatch = superInstallerMatch ?? upstreamInstallerMatch;
      if (installerMatch) {
        expect(spec.args[0]).toBe("/S");
        expect(spec.args.at(-1)).toMatch(/^\/D=/);
        const installDirectory = spec.args.at(-1)!.slice(3);
        mkdirSync(installDirectory, { recursive: true });
        const installedIdentity = superInstallerMatch
          ? identity
          : synaraDesktopIdentity("production");
        writeFileSync(
          join(installDirectory, `${installedIdentity.executableName}.exe`),
          `fake-${installedIdentity.flavor}-executable`,
        );
        writeFileSync(
          join(installDirectory, `Uninstall ${installedIdentity.displayName}.exe`),
          `fake-${installedIdentity.flavor}-uninstaller`,
        );
        if (runtime.includeVendorExecutable && superInstallerMatch) {
          mkdirSync(join(installDirectory, "resources", "vendor"), { recursive: true });
          writeFileSync(
            join(installDirectory, "resources", "vendor", "vendor-helper.exe"),
            "vendor-signed-fixture",
          );
        }
        const version = installerMatch[1]!;
        if (upstreamInstallerMatch) upstreamInstallDirectory = installDirectory;
        const targets = createWindowsRegistrationTargets(installedIdentity.windowsInstallerGuid);
        const installTarget = targets.find((target) => target.id === "HKCU:64:install")!;
        const uninstallTarget = targets.find((target) => target.id === "HKCU:64:uninstall")!;
        registry.set(
          `${installTarget.id}:${installTarget.key}`,
          registryOutput(installTarget, { InstallLocation: installDirectory }),
        );
        registry.set(
          `${uninstallTarget.id}:${uninstallTarget.key}`,
          registryOutput(uninstallTarget, {
            DisplayName: `${installedIdentity.displayName} ${version}`,
            DisplayVersion: version,
            QuietUninstallString: `"${join(installDirectory, `Uninstall ${installedIdentity.displayName}.exe`)}" /currentuser /S`,
          }),
        );
        if (runtime.failAfterCurrentInstall && superInstallerMatch && version.endsWith("super.2")) {
          throw new Error("simulated installer post-write failure");
        }
        if (
          runtime.mutateUpstreamOnSuperInstall &&
          superInstallerMatch &&
          upstreamInstallDirectory
        ) {
          writeFileSync(
            join(upstreamInstallDirectory, "Synara.exe"),
            "mutated-upstream-executable",
          );
        }
        return;
      }
      const uninstallerMatch = /Uninstall (Super Synara|Synara)\.exe$/.exec(spec.command);
      if (uninstallerMatch) {
        const installedIdentity =
          uninstallerMatch[1] === "Super Synara" ? identity : synaraDesktopIdentity("production");
        for (const target of createWindowsRegistrationTargets(
          installedIdentity.windowsInstallerGuid,
        )) {
          registry.delete(`${target.id}:${target.key}`);
        }
        rmSync(join(spec.command, ".."), { recursive: true, force: true });
        return;
      }
      throw new Error(`Unexpected fake command: ${spec.command}.`);
    },
    readExecutableIdentity: (path) =>
      basename(path).includes("Super Synara") || basename(path).startsWith("Super-Synara-")
        ? { productName: "Super Synara" }
        : { productName: "Synara" },
    inspectUnsignedAuthenticode: (path) => {
      if (basename(path) === "vendor-helper.exe") {
        throw new Error("Vendor executable must not be classified as product-owned unsigned code.");
      }
      return {
        path: resolve(path),
        status: "NotSigned",
        signerCertificate: null,
        timeStamperCertificate: null,
      };
    },
    launchStartupAndKeepRunning: vi.fn(async (options) => {
      startupEnvironments.push(options.env);
      expect(options.command.endsWith("Synara.exe")).toBe(true);
      expect(options.command.endsWith("Super Synara.exe")).toBe(false);
      expect(options.env.SYNARA_HOME).toContain("super-synara-installer-qualification-");
      expect(options.env.APPDATA).toContain("super-synara-installer-qualification-");
      expect(options.env.SYNARA_DESKTOP_QUALIFICATION_EXIT_AFTER_STARTUP).toBeUndefined();
      runtime.upstreamRunning = true;
      lifecycleEvents.push("upstream-startup-proven");
      return {
        pid: 1001,
        assertRunning: () => {
          if (!runtime.upstreamRunning) throw new Error("fake upstream Synara is not running");
        },
        waitForExit: async () => (runtime.upstreamRunning ? null : { code: 0, signal: null }),
        stopControlled: async () => {
          if (!runtime.upstreamRunning) {
            lifecycleEvents.push("upstream-already-exited");
            return { mode: "already-exited" as const, code: 0, signal: null };
          }
          runtime.upstreamRunning = false;
          lifecycleEvents.push("upstream-controlled-process-tree-cleanup");
          return {
            mode: "controlled-process-tree-cleanup" as const,
            code: 1,
            signal: null,
          };
        },
      };
    }),
    verifyStartup: vi.fn(async (options) => {
      startupEnvironments.push(options.env);
      expect(options.command.endsWith("Super Synara.exe")).toBe(true);
      expect(options.env.SYNARA_HOME).toContain("super-synara-installer-qualification-");
      expect(options.env.APPDATA).toContain("super-synara-installer-qualification-");
      expect(options.env.SYNARA_DESKTOP_QUALIFICATION_EXIT_AFTER_STARTUP).toBe("1");
      expect(options.expectedIdentityProof).toEqual({
        flavor: "super",
        appUserModelId: "io.github.slashdevcorpse.supersynara",
        bundleId: "io.github.slashdevcorpse.supersynara",
        internalProtocolScheme: "super-synara",
        internalProtocolRegistered: true,
        userDataDirectoryName: "super-synara",
        userDataPath: join(options.env.APPDATA!, "super-synara"),
        backendHomePath: options.env.SYNARA_HOME,
      });
      if (runtime.exitUpstreamBeforeSuperStartup) {
        runtime.upstreamRunning = false;
        lifecycleEvents.push("upstream-exited-before-super-startup");
      }
      if (!runtime.upstreamRunning) {
        throw new Error("Super Synara startup was not concurrent with upstream Synara");
      }
      lifecycleEvents.push("super-startup-and-clean-exit-proven");
    }),
    sleep: async () => undefined,
  };
  return runtime;
}

describe("Windows installer qualification primitives", () => {
  it("constructs NSIS silent install with the unquoted directory override last", () => {
    const command = createSilentInstallerCommand(
      "C:\\artifacts\\Super Synara.exe",
      "C:\\isolated root\\Super Synara",
      { PATH: "C:\\Windows" },
    );
    expect(command.args).toEqual(["/S", "/D=C:\\isolated root\\Super Synara"]);
    expect(command.env?.PATH).toBe("C:\\Windows");
  });

  it("parses typed registry values and quoted uninstall commands", () => {
    const output = [
      "HKEY_CURRENT_USER\\Software\\example",
      "    DisplayName    REG_SZ    Super Synara 0.5.5-super.1",
      "    EstimatedSize    REG_DWORD    0x1234",
    ].join("\r\n");
    expect(parseRegistryQueryOutput(output)[0]?.values).toEqual([
      { name: "DisplayName", type: "REG_SZ", data: "Super Synara 0.5.5-super.1" },
      { name: "EstimatedSize", type: "REG_DWORD", data: "0x1234" },
    ]);
    expect(canonicalizeRegistryQueryOutput(output)).toContain("EstimatedSize");
    expect(
      parseWindowsExecutableCommandLine(
        '"C:\\Isolated Root\\Uninstall Super Synara.exe" /currentuser /S',
      ),
    ).toEqual({
      command: "C:\\Isolated Root\\Uninstall Super Synara.exe",
      args: ["/currentuser", "/S"],
    });
  });
});

describe("Super Synara Windows installer qualification", () => {
  it("qualifies a first prerelease without pretending an upgrade occurred", async () => {
    const artifactRoot = join(process.cwd(), `.qualification-fixture-${process.pid}-fresh`);
    roots.push(artifactRoot);
    const runtime = fakeRuntime();
    const before = new Map(runtime.registry);

    const report = await qualifySuperSynaraWindowsInstaller(
      {
        installerPath: installer(artifactRoot, "0.5.5-super.1"),
        upstreamInstallerPath: upstreamInstaller(artifactRoot),
        version: "0.5.5-super.1",
        startupTimeoutMs: 10_000,
      },
      runtime,
    );

    expect(report.schemaVersion).toBe(3);
    expect(report.upgrade).toBe("not-run-no-previous-release");
    expect(report.previousVersion).toBeNull();
    expect(report.sideBySide).toMatchObject({
      upstreamVersion: "0.5.5",
      upstreamTag: "v0.5.5",
      upstreamInstallerSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      upstreamStartupProven: true,
      upstreamGracefulExitProven: false,
      upstreamExitMode: "controlled-process-tree-cleanup",
      upstreamControlledCleanupProven: true,
      concurrentOverlapProven: true,
      distinctProcessLocksProven: true,
      distinctProfileRootsProven: true,
      upstreamExecutablePreserved: true,
      upstreamRegistrationPreserved: true,
    });
    expect(report.installation.uninstallCleanupProven).toBe(true);
    expect(report.installation).toMatchObject({
      appUserModelId: "io.github.slashdevcorpse.supersynara",
      bundleId: "io.github.slashdevcorpse.supersynara",
      internalProtocolScheme: "super-synara",
      userDataDirectoryName: "super-synara",
      isolatedIdentityPathsProven: true,
    });
    expect(report.installer).toMatchObject({
      role: "installer",
      fileName: "Super-Synara-0.5.5-super.1-windows-x64-unsigned.exe",
      productName: "Super Synara",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      authenticode: {
        status: "NotSigned",
        signerCertificate: null,
        timeStamperCertificate: null,
      },
    });
    expect(report.installation.productOwnedExecutables).toEqual([
      expect.objectContaining({
        role: "main-executable",
        fileName: "Super Synara.exe",
        productName: "Super Synara",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        role: "uninstaller",
        fileName: "Uninstall Super Synara.exe",
        productName: "Super Synara",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(report.installation.vendorExecutables).toEqual([]);
    expect(runtime.startupEnvironments).toHaveLength(2);
    expect(runtime.lifecycleEvents).toEqual([
      "silent installer Synara-0.5.5-x64.exe",
      "silent installer Super-Synara-0.5.5-super.1-windows-x64-unsigned.exe",
      "upstream-startup-proven",
      "super-startup-and-clean-exit-proven",
      "upstream-controlled-process-tree-cleanup",
      "silent Super Synara uninstaller",
      "silent Synara uninstaller",
    ]);
    expect(runtime.registry).toEqual(before);
  });

  it("installs the exact prior prerelease before qualifying upgrade and profile preservation", async () => {
    const artifactRoot = join(process.cwd(), `.qualification-fixture-${process.pid}-upgrade`);
    roots.push(artifactRoot);
    const runtime = fakeRuntime();

    const report = await qualifySuperSynaraWindowsInstaller(
      {
        installerPath: installer(artifactRoot, "0.5.5-super.2"),
        upstreamInstallerPath: upstreamInstaller(artifactRoot),
        previousInstallerPath: installer(artifactRoot, "0.5.5-super.1"),
        version: "0.5.5-super.2",
        startupTimeoutMs: 10_000,
      },
      runtime,
    );

    expect(report.upgrade).toBe("qualified");
    expect(report.previousVersion).toBe("0.5.5-super.1");
    expect(runtime.commands.map((command) => command.label)).toEqual([
      "silent installer Synara-0.5.5-x64.exe",
      "silent installer Super-Synara-0.5.5-super.1-windows-x64-unsigned.exe",
      "silent installer Super-Synara-0.5.5-super.2-windows-x64-unsigned.exe",
      "silent Super Synara uninstaller",
      "silent Synara uninstaller",
    ]);
  });

  it("inventories vendor executables without claiming they are product-owned or unsigned", async () => {
    const artifactRoot = join(process.cwd(), `.qualification-fixture-${process.pid}-vendor`);
    roots.push(artifactRoot);
    const runtime = fakeRuntime();
    runtime.includeVendorExecutable = true;

    const report = await qualifySuperSynaraWindowsInstaller(
      {
        installerPath: installer(artifactRoot, "0.5.5-super.2"),
        upstreamInstallerPath: upstreamInstaller(artifactRoot),
        version: "0.5.5-super.2",
        startupTimeoutMs: 10_000,
      },
      runtime,
    );

    expect(report.installation.vendorExecutables).toEqual([
      expect.objectContaining({
        role: "vendor-executable",
        fileName: "vendor-helper.exe",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(report.installation.vendorExecutables[0]).not.toHaveProperty("authenticode");
  });

  it("rejects a sequential-only startup when upstream exits before Super is proven", async () => {
    const artifactRoot = join(process.cwd(), `.qualification-fixture-${process.pid}-sequential`);
    roots.push(artifactRoot);
    const runtime = fakeRuntime();
    runtime.exitUpstreamBeforeSuperStartup = true;

    await expect(
      qualifySuperSynaraWindowsInstaller(
        {
          installerPath: installer(artifactRoot, "0.5.5-super.2"),
          upstreamInstallerPath: upstreamInstaller(artifactRoot),
          version: "0.5.5-super.2",
          startupTimeoutMs: 10_000,
        },
        runtime,
      ),
    ).rejects.toThrow("qualification failed");

    expect(runtime.lifecycleEvents).toContain("upstream-startup-proven");
    expect(runtime.lifecycleEvents).toContain("upstream-exited-before-super-startup");
    expect(runtime.lifecycleEvents).toContain("upstream-already-exited");
    expect(runtime.lifecycleEvents).not.toContain("super-startup-and-clean-exit-proven");
    expect(runtime.registry.size).toBe(0);
  });

  it("runs owned cleanup and preserves upstream registration after installer failure", async () => {
    const artifactRoot = join(process.cwd(), `.qualification-fixture-${process.pid}-failure`);
    roots.push(artifactRoot);
    const runtime = fakeRuntime();
    runtime.failAfterCurrentInstall = true;
    const before = new Map(runtime.registry);

    await expect(
      qualifySuperSynaraWindowsInstaller(
        {
          installerPath: installer(artifactRoot, "0.5.5-super.2"),
          upstreamInstallerPath: upstreamInstaller(artifactRoot),
          version: "0.5.5-super.2",
          startupTimeoutMs: 10_000,
        },
        runtime,
      ),
    ).rejects.toThrow("qualification failed");

    expect(runtime.commands.at(-1)?.label).toBe("silent Synara uninstaller");
    expect(runtime.registry).toEqual(before);
  });

  it("fails when a Super lifecycle transition changes installed upstream bytes", async () => {
    const artifactRoot = join(process.cwd(), `.qualification-fixture-${process.pid}-cross-talk`);
    roots.push(artifactRoot);
    const runtime = fakeRuntime();
    runtime.mutateUpstreamOnSuperInstall = true;

    await expect(
      qualifySuperSynaraWindowsInstaller(
        {
          installerPath: installer(artifactRoot, "0.5.5-super.2"),
          upstreamInstallerPath: upstreamInstaller(artifactRoot),
          version: "0.5.5-super.2",
          startupTimeoutMs: 10_000,
        },
        runtime,
      ),
    ).rejects.toThrow("qualification failed");
    expect(runtime.registry.size).toBe(0);
  });

  it("refuses to touch a pre-existing Super Synara registration", async () => {
    const artifactRoot = join(process.cwd(), `.qualification-fixture-${process.pid}-existing`);
    roots.push(artifactRoot);
    const runtime = fakeRuntime();
    const target = createWindowsRegistrationTargets(identity.windowsInstallerGuid).find(
      (candidate) => candidate.id === "HKCU:64:install",
    )!;
    runtime.registry.set(
      `${target.id}:${target.key}`,
      registryOutput(target, { InstallLocation: "C:\\Users\\person\\Super Synara" }),
    );

    await expect(
      qualifySuperSynaraWindowsInstaller(
        {
          installerPath: installer(artifactRoot, "0.5.5-super.2"),
          upstreamInstallerPath: upstreamInstaller(artifactRoot),
          version: "0.5.5-super.2",
          startupTimeoutMs: 10_000,
        },
        runtime,
      ),
    ).rejects.toThrow("qualification failed");
    expect(runtime.commands).toHaveLength(0);
    expect(existsSync("C:\\Users\\person\\Super Synara")).toBe(false);
  });

  it("records and preserves a pre-existing upstream registration without installing anything", async () => {
    const artifactRoot = join(process.cwd(), `.qualification-fixture-${process.pid}-upstream-live`);
    roots.push(artifactRoot);
    const runtime = fakeRuntime();
    const target = createWindowsRegistrationTargets(
      synaraDesktopIdentity("production").windowsInstallerGuid,
    ).find((candidate) => candidate.id === "HKCU:64:install")!;
    runtime.registry.set(
      `${target.id}:${target.key}`,
      registryOutput(target, { InstallLocation: "C:\\Users\\person\\Synara" }),
    );
    const before = new Map(runtime.registry);

    await expect(
      qualifySuperSynaraWindowsInstaller(
        {
          installerPath: installer(artifactRoot, "0.5.5-super.2"),
          upstreamInstallerPath: upstreamInstaller(artifactRoot),
          version: "0.5.5-super.2",
          startupTimeoutMs: 10_000,
        },
        runtime,
      ),
    ).rejects.toThrow("qualification failed");
    expect(runtime.commands).toHaveLength(0);
    expect(runtime.registry).toEqual(before);
  });

  it("refuses native installer execution outside an ephemeral hosted Windows lane", async () => {
    const artifactRoot = join(process.cwd(), `.qualification-fixture-${process.pid}-workstation`);
    roots.push(artifactRoot);
    const runtime = fakeRuntime();
    Object.assign(runtime, { isEphemeralHostedRunner: false });

    await expect(
      qualifySuperSynaraWindowsInstaller(
        {
          installerPath: installer(artifactRoot, "0.5.5-super.2"),
          upstreamInstallerPath: upstreamInstaller(artifactRoot),
          version: "0.5.5-super.2",
          startupTimeoutMs: 10_000,
        },
        runtime,
      ),
    ).rejects.toThrow("restricted to the ephemeral GitHub-hosted Windows lane");
    expect(runtime.commands).toHaveLength(0);
  });
});
