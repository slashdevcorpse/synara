import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  renderPackagedDesktopIdentityProof,
  type PackagedDesktopIdentityProof,
} from "@synara/shared/desktopIdentityProof";

import {
  assertPackagedMacBundleIdentity,
  createPackagedDesktopSmokeEnvironment,
  createExpectedPackagedDesktopIdentityProof,
  hasPackagedDesktopStartupProof,
  launchPackagedDesktopAndWaitForStartup,
  packagedDesktopExecutableFileName,
  parsePackagedDesktopStartupArgs,
  resolveNativePackagedDesktopPlatform,
  type SyncTextCommandRunner,
  verifyPackagedDesktopExecutableStartup,
} from "./verify-packaged-desktop-startup.ts";

const temporaryRoots: string[] = [];

function plistRunnerFor(
  executable: string,
  identifier: string,
  displayName = executable,
): SyncTextCommandRunner {
  return () => ({
    status: 0,
    stdout: JSON.stringify({
      CFBundleExecutable: executable,
      CFBundleIdentifier: identifier,
      CFBundleName: displayName,
      CFBundleDisplayName: displayName,
    }),
    stderr: "",
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("packaged desktop startup verification", () => {
  it("parses a bounded native payload request", () => {
    expect(
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--flavor",
        "super",
      ]),
    ).toEqual({
      assetsDirectory: expect.stringMatching(/release-publish$/),
      platform: "linux",
      arch: "x64",
      version: "1.2.3",
      flavor: "super",
      timeoutMs: 60_000,
    });

    expect(() =>
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--timeout-ms",
        "4999",
      ]),
    ).toThrow("--timeout-ms must be an integer between 5000 and 180000");
  });

  it("isolates user state and removes inherited runtime authority", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-packaged-smoke-env-test-"));
    temporaryRoots.push(root);

    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "linux", version: "1.2.3" },
      {
        PATH: process.env.PATH,
        SYNARA_AUTH_TOKEN: "must-not-leak",
        ELECTRON_RUN_AS_NODE: "1",
      },
    );

    expect(env.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    for (const name of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "SYNARA_HOME",
    ] as const) {
      expect(env[name]?.startsWith(root)).toBe(true);
      expect(existsSync(env[name]!)).toBe(true);
    }
  });

  it("uses Super Synara executable, profile, and backend-home names without inherited overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "super-synara-packaged-smoke-env-test-"));
    temporaryRoots.push(root);

    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "win", version: "1.2.3", flavor: "super" },
      {
        PATH: process.env.PATH,
        SYNARA_HOME: "C:\\Users\\tester\\.synara",
        SYNARA_DESKTOP_FLAVOR: "production",
      },
    );

    expect(env.SYNARA_HOME).toBe(join(root, "super-synara-home"));
    expect(env.SYNARA_DESKTOP_FLAVOR).toBe("super");
    expect(env.SYNARA_DISABLE_AUTO_UPDATE).toBe("1");
    expect(env.SYNARA_DESKTOP_QUALIFICATION_EXIT_AFTER_STARTUP).toBe("1");
    expect(existsSync(join(root, "appdata", "super-synara"))).toBe(true);
    expect(existsSync(join(root, "appdata", "synara"))).toBe(false);
  });

  it("maps Node host platforms to release platform names", () => {
    expect(resolveNativePackagedDesktopPlatform("darwin")).toBe("mac");
    expect(resolveNativePackagedDesktopPlatform("win32")).toBe("win");
    expect(resolveNativePackagedDesktopPlatform("linux")).toBe("linux");
  });

  it("derives packaged executable names from desktop identity", () => {
    expect(packagedDesktopExecutableFileName("production", "win")).toBe("Synara.exe");
    expect(packagedDesktopExecutableFileName("super", "win")).toBe("Super Synara.exe");
    expect(packagedDesktopExecutableFileName("super", "mac")).toBe("Super Synara");
  });

  it.each([
    { platform: "win" as const, appUserModelId: "io.github.slashdevcorpse.supersynara" },
    { platform: "mac" as const, appUserModelId: null },
  ])(
    "requires exact baked Super identity and isolated $platform profile paths",
    ({ platform, appUserModelId }) => {
      const root = mkdtempSync(join(tmpdir(), `packaged-${platform}-identity-proof-test-`));
      temporaryRoots.push(root);
      const logPath = join(root, "desktop-main.log");
      const env = createPackagedDesktopSmokeEnvironment(
        join(root, "state"),
        { platform, version: "1.2.3", flavor: "super" },
        {},
      );
      const expectedIdentity = createExpectedPackagedDesktopIdentityProof(
        { platform, flavor: "super" },
        env,
      );
      expect(expectedIdentity.appUserModelId).toBe(appUserModelId);
      const writeStartupProof = (proof: PackagedDesktopIdentityProof): void => {
        writeFileSync(
          logPath,
          [
            "app ready",
            `[desktop] ${renderPackagedDesktopIdentityProof(proof)}`,
            "bootstrap main window created",
            "bootstrap backend ready source=listening",
          ].join("\n"),
        );
      };

      writeStartupProof(expectedIdentity);
      expect(hasPackagedDesktopStartupProof(logPath, expectedIdentity)).toBe(true);
      const invalidProofs: PackagedDesktopIdentityProof[] = [
        { ...expectedIdentity, appUserModelId: "wrong.app-user-model-id" },
        { ...expectedIdentity, bundleId: "wrong.bundle" },
        { ...expectedIdentity, internalProtocolScheme: "wrong-scheme" },
        { ...expectedIdentity, userDataDirectoryName: "wrong-profile" },
        { ...expectedIdentity, userDataPath: join(root, "wrong-user-data") },
        { ...expectedIdentity, backendHomePath: join(root, "wrong-home") },
      ];
      for (const invalidProof of invalidProofs) {
        writeStartupProof(invalidProof);
        expect(hasPackagedDesktopStartupProof(logPath, expectedIdentity)).toBe(false);
      }
    },
  );

  it("keeps a startup-proven process alive until controlled tree cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "packaged-running-handle-test-"));
    temporaryRoots.push(root);
    const logPath = join(root, "desktop-main.log");
    writeFileSync(
      logPath,
      [
        "app ready",
        "bootstrap main window created",
        "bootstrap backend ready source=listening",
      ].join("\n"),
    );
    const running = await launchPackagedDesktopAndWaitForStartup({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      env: process.env,
      logPath,
      timeoutMs: 5_000,
      description: "Fake long-running packaged app",
    });
    try {
      expect(() => running.assertRunning()).not.toThrow();
      const result = await running.stopControlled();
      expect(result.mode).toBe("controlled-process-tree-cleanup");
      expect(() => running.assertRunning()).toThrow("is not running");
    } finally {
      await running.stopControlled();
    }
  });

  it("reads and locks Super macOS bundle identity before launch", () => {
    const root = mkdtempSync(join(tmpdir(), "super-synara-packaged-plist-test-"));
    temporaryRoots.push(root);
    const appBundle = join(root, "Super Synara.app");
    const plistPath = join(appBundle, "Contents", "Info.plist");
    const executablePath = join(appBundle, "Contents", "MacOS", "Super Synara");
    mkdirSync(join(appBundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(plistPath, "binary plist fixture");
    writeFileSync(executablePath, "executable fixture");

    const invocations: ReadonlyArray<string>[] = [];
    const runner = (command: string, args: ReadonlyArray<string>) => {
      invocations.push([command, ...args]);
      return {
        status: 0,
        stdout: JSON.stringify({
          CFBundleExecutable: "Super Synara",
          CFBundleIdentifier: "io.github.slashdevcorpse.supersynara",
          CFBundleName: "Super Synara",
          CFBundleDisplayName: "Super Synara",
        }),
        stderr: "",
      };
    };

    expect(assertPackagedMacBundleIdentity(appBundle, "super", runner)).toBe(executablePath);
    expect(invocations).toEqual([["/usr/bin/plutil", "-convert", "json", "-o", "-", plistPath]]);
  });

  it("fails closed on macOS plist identity drift while preserving production identity", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-packaged-plist-drift-test-"));
    temporaryRoots.push(root);
    const createApp = (name: string, executableName: string): string => {
      const appBundle = join(root, name);
      mkdirSync(join(appBundle, "Contents", "MacOS"), { recursive: true });
      writeFileSync(join(appBundle, "Contents", "Info.plist"), "binary plist fixture");
      writeFileSync(join(appBundle, "Contents", "MacOS", executableName), "executable fixture");
      return appBundle;
    };
    const superApp = createApp("Super Synara.app", "Super Synara");
    const productionApp = createApp("Synara.app", "Synara");
    expect(() =>
      assertPackagedMacBundleIdentity(
        superApp,
        "super",
        plistRunnerFor("Super Synara", "com.emanueledipietro.synara"),
      ),
    ).toThrow("CFBundleIdentifier mismatch");
    expect(() =>
      assertPackagedMacBundleIdentity(
        superApp,
        "super",
        plistRunnerFor("Synara", "io.github.slashdevcorpse.supersynara"),
      ),
    ).toThrow("CFBundleExecutable mismatch");
    expect(() =>
      assertPackagedMacBundleIdentity(
        superApp,
        "super",
        plistRunnerFor("Super Synara", "io.github.slashdevcorpse.supersynara", "Synara"),
      ),
    ).toThrow("CFBundleName mismatch");
    expect(
      assertPackagedMacBundleIdentity(
        productionApp,
        "production",
        plistRunnerFor("Synara", "com.emanueledipietro.synara"),
      ),
    ).toBe(join(productionApp, "Contents", "MacOS", "Synara"));
    expect(() =>
      assertPackagedMacBundleIdentity(superApp, "super", () => ({
        status: 1,
        stdout: "",
        stderr: "missing plist key",
      })),
    ).toThrow("Could not read packaged macOS Info.plist");
  });

  it("requires both startup and graceful clean-exit log proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "packaged-clean-exit-proof-test-"));
    temporaryRoots.push(root);
    const logPath = join(root, "desktop-main.log");
    writeFileSync(
      logPath,
      [
        "app ready",
        "bootstrap main window created",
        "bootstrap backend ready source=listening",
        "packaged startup qualification exit requested",
        "packaged startup qualification shutdown complete",
      ].join("\n"),
    );

    await expect(
      verifyPackagedDesktopExecutableStartup({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: root,
        env: process.env,
        logPath,
        timeoutMs: 5_000,
        description: "Fake packaged app",
      }),
    ).resolves.toBeUndefined();

    writeFileSync(logPath, "app ready\nbootstrap main window created\n");
    await expect(
      verifyPackagedDesktopExecutableStartup({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: root,
        env: process.env,
        logPath,
        timeoutMs: 5_000,
        description: "Incomplete fake packaged app",
      }),
    ).rejects.toThrow("exited before startup proof");
  });
});
