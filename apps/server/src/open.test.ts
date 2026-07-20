import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import { EDITORS } from "@synara/contracts";
import { FileSystem, Path, Effect } from "effect";
import { expect, vi } from "vitest";

import {
  discoverAvailableEditors,
  isCommandAvailable,
  launchDetached,
  resolveAvailableEditors,
  resolveEditorDiscoveryIdentity,
  resolveEditorLaunch,
  resolveWindowsEditorUriLaunch,
} from "./open";
import {
  clearWindowsStorePackageDiscoveryCache,
  discoverWindowsStorePackageInstallLocations,
  getEditorWindowsStorePackages,
  resolveWindowsStorePackageDirectory,
  resolveWindowsStorePackageDirectoryFromPowerShell,
  resolveWindowsStorePackageInstallLocation,
  WINDOWS_STORE_BULK_LOOKUP_OUTPUT_LIMIT_BYTES,
  WINDOWS_STORE_BULK_LOOKUP_TERMINATION_GRACE_MS,
  WINDOWS_STORE_BULK_LOOKUP_TIMEOUT_MS,
} from "./editorAppDiscovery";

function encodeExpectedWindowsEditorUriPath(targetPath: string): string {
  return targetPath
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
}

type FakeAppxChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
};

function makeFakeAppxChild(kill: () => boolean = () => true): FakeAppxChild {
  const child = new EventEmitter() as FakeAppxChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = kill;
  return child;
}

function vscodeStorePackages() {
  const editor = EDITORS.find((candidate) => candidate.id === "vscode");
  assert.ok(editor);
  return getEditorWindowsStorePackages(editor) ?? [];
}

it.layer(NodeServices.layer)("resolveEditorLaunch", (it) => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const antigravityLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "antigravity" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(antigravityLaunch, {
        command: "agy",
        args: ["/tmp/workspace"],
      });

      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const traeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "trae" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(traeLaunch, {
        command: "trae",
        args: ["/tmp/workspace"],
      });

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });

      const windsurfLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "windsurf" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(windsurfLaunch, {
        command: "windsurf",
        args: ["/tmp/workspace"],
      });

      const sublimeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "sublime" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(sublimeLaunch, {
        command: "subl",
        args: ["/tmp/workspace"],
      });

      const ideaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "idea" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(ideaLaunch, {
        command: "idea",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("uses --goto when editor supports line/column suffixes", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const ideaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "idea" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(ideaLineAndColumn, {
        command: "idea",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("falls back to the VS Code URL handler on Windows when the CLI is absent", () =>
    Effect.gen(function* () {
      const launch = yield* resolveEditorLaunch(
        { cwd: "C:\\Users\\Chris\\Project Folder\\src\\open.ts:71:5", editor: "vscode" },
        "win32",
        { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" },
      );

      assert.deepEqual(launch, {
        command: "C:\\Windows\\explorer.exe",
        args: ["vscode://file/C:/Users/Chris/Project%20Folder/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("preserves UNC paths in VS Code URL-handler launches", () =>
    Effect.gen(function* () {
      const launch = yield* resolveEditorLaunch(
        { cwd: "\\\\server\\share\\Project Folder\\src\\open.ts:71:5", editor: "vscode" },
        "win32",
        { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" },
      );

      assert.deepEqual(launch, {
        command: "C:\\Windows\\explorer.exe",
        args: ["vscode://file//server/share/Project%20Folder/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("adds the VS Code URL-handler trailing slash for existing folders", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-vscode-folder-" });
      const folderPath = path.join(dir, "Project Folder");
      yield* fs.makeDirectory(folderPath);

      const launch = yield* resolveEditorLaunch({ cwd: folderPath, editor: "vscode" }, "win32", {
        PATH: "",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: "C:\\Windows",
      });

      assert.deepEqual(launch, {
        command: "C:\\Windows\\explorer.exe",
        args: [`vscode://file/${encodeExpectedWindowsEditorUriPath(folderPath)}/`],
      });
    }),
  );

  it("does not build URL-handler launches for non-Windows platforms", () => {
    const editor = EDITORS.find((candidate) => candidate.id === "vscode");
    assert.ok(editor);
    assert.equal(resolveWindowsEditorUriLaunch(editor, "/tmp/workspace", "linux"), null);
  });

  it.effect("opens terminal-style editors in the target working directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-terminal-" });
      const filePath = path.join(dir, "src", "open.ts");
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, "export const value = 1;\n");

      const ghosttyLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "ghostty" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(ghosttyLaunch, {
        command: "ghostty",
        args: [`--working-directory=${path.dirname(filePath)}`],
      });

      const muxyLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "muxy" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(muxyLaunch, {
        command: "muxy",
        args: [path.dirname(filePath)],
      });

      const binDir = path.join(dir, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(path.join(binDir, "konsole"), "#!/bin/sh\n");
      yield* fs.chmod(path.join(binDir, "konsole"), 0o755);

      const linuxTerminalLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "terminal" },
        "linux",
        { PATH: binDir },
      );
      assert.deepEqual(linuxTerminalLaunch, {
        command: "konsole",
        args: ["--workdir", path.dirname(filePath)],
      });

      const linuxTerminalFallbackLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "terminal" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(linuxTerminalFallbackLaunch, {
        command: "x-terminal-emulator",
        args: [`--working-directory=${path.dirname(filePath)}`],
      });

      yield* fs.writeFileString(path.join(binDir, "wt.CMD"), "@echo off\r\n");
      const windowsTerminalLaunch = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "terminal" },
        "win32",
        { PATH: binDir, PATHEXT: ".CMD" },
      );
      assert.deepEqual(windowsTerminalLaunch, {
        command: "wt",
        args: ["-d", "C:\\workspace"],
      });
    }),
  );

  it.effect("falls back to installed macOS app bundles when launchers are absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-apps-" });
      yield* fs.makeDirectory(path.join(home, "Applications", "Ghostty.app"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, "Applications", "Muxy.app"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, "Applications", "WebStorm.app"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, "Applications", "JetBrains Toolbox", "PyCharm.app"), {
        recursive: true,
      });

      const ghosttyLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "ghostty" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(ghosttyLaunch, {
        command: "open",
        args: ["-a", "Ghostty", "/tmp/workspace"],
      });

      const muxyLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "muxy" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(muxyLaunch, {
        command: "open",
        args: ["-a", "Muxy", "/tmp/workspace"],
      });

      const terminalLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "terminal" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(terminalLaunch, {
        command: "open",
        args: ["-a", "Terminal", "/tmp/workspace"],
      });

      const webstormLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "webstorm" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(webstormLaunch, {
        command: "open",
        args: [
          "-a",
          "WebStorm",
          "--args",
          "--line",
          "71",
          "--column",
          "5",
          "/tmp/workspace/src/open.ts",
        ],
      });

      const availableEditors = resolveAvailableEditors("darwin", { HOME: home, PATH: "" });
      assert.equal(availableEditors.includes("ghostty"), true);
      assert.equal(availableEditors.includes("muxy"), true);
      assert.equal(availableEditors.includes("webstorm"), true);
      assert.equal(availableEditors.includes("pycharm"), true);
    }),
  );

  it.effect("prefers the macOS Ghostty app launch even when a ghostty command is on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-ghostty-" });
      const binDir = path.join(home, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(path.join(binDir, "ghostty"), "#!/bin/sh\n");
      yield* fs.chmod(path.join(binDir, "ghostty"), 0o755);
      yield* fs.makeDirectory(path.join(home, "Applications", "Ghostty.app"), {
        recursive: true,
      });

      const launch = yield* resolveEditorLaunch(
        { cwd: "/tmp/with space/workspace", editor: "ghostty" },
        "darwin",
        { HOME: home, PATH: binDir },
      );

      assert.deepEqual(launch, {
        command: "open",
        args: ["-a", "Ghostty", "/tmp/with space/workspace"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
      );
      assert.deepEqual(launch2, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const launch3 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
      );
      assert.deepEqual(launch3, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

it.layer(NodeServices.layer)("launchDetached", (it) => {
  it.effect("resolves when command can be spawned", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `synara-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("resolves win32 commands with PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      yield* fs.writeFileString(path.join(dir, "code.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );

  it("returns false when a command is not on PATH", () => {
    const env = {
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(isCommandAvailable("definitely-not-installed", { platform: "win32", env }), false);
  });

  it.effect("does not treat bare files without executable extension as available on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      yield* fs.writeFileString(path.join(dir, "npm"), "echo nope\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("npm", { platform: "win32", env }), false);
    }),
  );

  it.effect("appends PATHEXT for commands with non-executable extensions on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      yield* fs.writeFileString(path.join(dir, "my.tool.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("my.tool", { platform: "win32", env }), true);
    }),
  );

  it.effect("uses platform-specific PATH delimiter for platform overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const firstDir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      yield* fs.writeFileString(path.join(firstDir, "code.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(secondDir, "code.CMD"), "MZ");
      const env = {
        PATH: `${firstDir};${secondDir}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );

  it.effect("preserves POSIX Path and path command lookup aliases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-posix-path-" });
      yield* fs.writeFileString(path.join(dir, "code"), "#!/bin/sh\n");
      yield* fs.chmod(path.join(dir, "code"), 0o755);

      for (const name of ["Path", "path"] as const) {
        assert.equal(isCommandAvailable("code", { platform: "linux", env: { [name]: dir } }), true);
      }
      assert.equal(
        isCommandAvailable("code", {
          platform: "linux",
          env: { PATH: dir, Path: "/missing-mixed", path: "/missing-lower" },
        }),
        true,
      );
    }),
  );
});

it.layer(NodeServices.layer)("resolveAvailableEditors", (it) => {
  it.effect("returns installed editors for command launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-editors-" });

      yield* fs.writeFileString(path.join(dir, "cursor.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "code-insiders.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "zeditor.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "explorer.CMD"), "MZ");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, ["cursor", "vscode-insiders", "zed", "file-manager"]);
    }),
  );

  it.effect("returns VS Code when the Windows Store package is installed without a CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const programFiles = yield* fs.makeTempDirectoryScoped({ prefix: "synara-vscode-store-" });
      const binDir = path.join(programFiles, "bin");
      const installLocation = path.join(
        programFiles,
        "WindowsApps",
        "Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe",
      );
      yield* fs.makeDirectory(installLocation, { recursive: true });
      yield* fs.makeDirectory(binDir, { recursive: true });
      clearWindowsStorePackageDiscoveryCache();

      const editors = resolveAvailableEditors(
        "win32",
        {
          PATH: binDir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          ProgramFiles: programFiles,
        },
        { lookupWindowsStorePackage: () => installLocation },
      );

      assert.equal(editors.includes("vscode"), true);
    }),
  );

  it.effect("does not treat Windows app-execution-alias folders as package installs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const localAppData = yield* fs.makeTempDirectoryScoped({
        prefix: "synara-vscode-store-alias-",
      });
      yield* fs.makeDirectory(
        path.join(
          localAppData,
          "Microsoft",
          "WindowsApps",
          "Microsoft.VisualStudioCode_8wekyb3d8bbwe",
        ),
        { recursive: true },
      );
      const editor = EDITORS.find((candidate) => candidate.id === "vscode");
      assert.ok(editor);

      assert.equal(
        resolveWindowsStorePackageDirectory(getEditorWindowsStorePackages(editor), "win32", {
          LOCALAPPDATA: localAppData,
        }),
        null,
      );
    }),
  );

  it("resolves Windows Store package locations through matching AppX registration", () => {
    const editor = EDITORS.find((candidate) => candidate.id === "vscode");
    assert.ok(editor);
    const installLocation =
      "C:\\Program Files\\WindowsApps\\Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe";
    let script = "";
    let childEnv: NodeJS.ProcessEnv | undefined;
    const callerEnv = {
      Path: "C:\\discarded-bin",
      PATH: "D:\\effective-bin",
      SystemRoot: "C:\\discarded-windows",
      SYSTEMROOT: "D:\\Windows",
    } satisfies NodeJS.ProcessEnv;
    const callerBefore = { ...callerEnv };

    const result = resolveWindowsStorePackageDirectoryFromPowerShell(
      getEditorWindowsStorePackages(editor),
      "win32",
      callerEnv,
      (_file, args, options) => {
        script = String(args[2]);
        childEnv = options.env;
        return `${installLocation}\r\n`;
      },
    );

    assert.equal(result, installLocation);
    assert.equal(script.includes("PackageFamilyName -ieq $packageDef.Family"), true);
    assert.equal(script.includes("Microsoft.VisualStudioCode_8wekyb3d8bbwe"), true);
    assert.equal(script.includes("-ErrorAction SilentlyContinue"), true);
    assert.equal(script.includes("-ErrorAction Stop"), false);
    assert.deepEqual(childEnv, {
      PATH: "D:\\effective-bin",
      SYSTEMROOT: "D:\\Windows",
    });
    assert.deepEqual(callerEnv, callerBefore);
  });

  it("caches Windows Store AppX registration probes", () => {
    clearWindowsStorePackageDiscoveryCache();
    const editor = EDITORS.find((candidate) => candidate.id === "vscode");
    assert.ok(editor);
    const installLocation =
      "C:\\Program Files\\WindowsApps\\Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe";
    let calls = 0;

    const first = resolveWindowsStorePackageDirectoryFromPowerShell(
      getEditorWindowsStorePackages(editor),
      "win32",
      { PATH: "C:\\Windows\\System32" },
      () => {
        calls += 1;
        return `${installLocation}\r\n`;
      },
      { useCache: true, now: () => 1_000 },
    );
    const second = resolveWindowsStorePackageDirectoryFromPowerShell(
      getEditorWindowsStorePackages(editor),
      "win32",
      { PATH: "C:\\Windows\\System32" },
      () => {
        calls += 1;
        return "C:\\wrong\r\n";
      },
      { useCache: true, now: () => 1_100 },
    );

    assert.equal(first, installLocation);
    assert.equal(second, installLocation);
    assert.equal(calls, 1);
    clearWindowsStorePackageDiscoveryCache();
  });

  it.effect("does not treat filesystem-only AppX package directories as installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const editor = EDITORS.find((candidate) => candidate.id === "vscode");
      assert.ok(editor);
      const programFiles = yield* fs.makeTempDirectoryScoped({ prefix: "synara-vscode-staged-" });
      yield* fs.makeDirectory(
        path.join(
          programFiles,
          "WindowsApps",
          "Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe",
        ),
        { recursive: true },
      );

      const installLocation = resolveWindowsStorePackageInstallLocation(
        getEditorWindowsStorePackages(editor),
        "win32",
        { PATH: "", ProgramFiles: programFiles },
        () => {
          throw new Error("not registered");
        },
        { useCache: false },
      );

      assert.equal(installLocation, null);
    }),
  );
});

it.layer(NodeServices.layer)("discoverAvailableEditors", (it) => {
  it("keeps Unicode-distinct Windows cwd identities distinct in both comparison orders", () => {
    const dottedCapitalI = resolveEditorDiscoveryIdentity({
      platform: "win32",
      cwd: "C:\\workspace\\İ",
      env: { PATH: "C:\\bin", PATHEXT: ".EXE" },
    });
    const lowercaseIWithCombiningDot = resolveEditorDiscoveryIdentity({
      platform: "win32",
      cwd: "C:\\workspace\\i\u0307",
      env: { PATH: "C:\\bin", PATHEXT: ".EXE" },
    });

    assert.notEqual(dottedCapitalI, lowercaseIWithCombiningDot);
    assert.notEqual(lowercaseIWithCombiningDot, dottedCapitalI);
    assert.equal(
      resolveEditorDiscoveryIdentity({
        platform: "win32",
        cwd: "C:\\WORKSPACE\\ASCII",
        env: { PATH: "C:\\bin", PATHEXT: ".EXE" },
      }),
      resolveEditorDiscoveryIdentity({
        platform: "win32",
        cwd: "c:\\workspace\\ascii",
        env: { PATH: "C:\\bin", PATHEXT: ".EXE" },
      }),
    );
  });

  it("versions Windows editor identity by the Node-effective PSModulePath", () => {
    const windowsIdentity = (
      psModulePath: string,
      shadowPsModulePath: string,
      reverseInsertion: boolean,
    ) =>
      resolveEditorDiscoveryIdentity({
        platform: "win32",
        cwd: "C:\\workspace",
        env: reverseInsertion
          ? {
              PATH: "C:\\bin",
              PATHEXT: ".EXE",
              PSModulePath: psModulePath,
              psmodulepath: shadowPsModulePath,
            }
          : {
              PATH: "C:\\bin",
              PATHEXT: ".EXE",
              psmodulepath: shadowPsModulePath,
              PSModulePath: psModulePath,
            },
      });
    const modulesA = windowsIdentity("C:\\modules-a", "C:\\shadow-a", false);
    const modulesB = windowsIdentity("C:\\modules-b", "C:\\shadow-b", true);

    assert.notEqual(modulesA, modulesB);
    assert.notEqual(modulesB, modulesA);
    assert.equal(modulesA, windowsIdentity("C:\\modules-a", "C:\\different-shadow", true));
    assert.equal(
      resolveEditorDiscoveryIdentity({
        platform: "linux",
        cwd: "/workspace",
        env: { PATH: "/bin", PSModulePath: "/modules-a" },
      }),
      resolveEditorDiscoveryIdentity({
        platform: "linux",
        cwd: "/workspace",
        env: { PATH: "/bin", PSModulePath: "/modules-b" },
      }),
    );
  });

  it.effect(
    "discovers command editors asynchronously with mixed-case Windows environment keys",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-editor-async-é-" });
        yield* fs.writeFileString(path.join(dir, "code.CMD"), "@echo off\r\n");

        const result = yield* Effect.promise(() =>
          discoverAvailableEditors({
            platform: "win32",
            cwd: dir,
            env: { pAtH: dir, PaThExT: ".CMD" },
            lookupWindowsStorePackages: async () => ({
              status: "success",
              installLocationsByFamily: {},
              subprocessCount: 1,
            }),
          }),
        );

        assert.equal(result.status, "success");
        if (result.status === "success") {
          assert.equal(result.availableEditors.includes("vscode"), true);
          assert.equal(result.subprocessCount, 1);
        }
      }),
  );

  it.effect("preserves POSIX Path and path aliases during asynchronous discovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-editor-posix-path-" });
      yield* fs.writeFileString(path.join(dir, "code"), "#!/bin/sh\n");
      yield* fs.chmod(path.join(dir, "code"), 0o755);

      for (const name of ["Path", "path"] as const) {
        const result = yield* Effect.promise(() =>
          discoverAvailableEditors({
            platform: "linux",
            cwd: dir,
            env: { [name]: dir },
            lookupWindowsStorePackages: async () => ({
              status: "success",
              installLocationsByFamily: {},
              subprocessCount: 0,
            }),
          }),
        );
        assert.equal(result.status, "success");
        if (result.status === "success") {
          assert.equal(result.availableEditors.includes("vscode"), true);
        }
      }
    }),
  );

  it("caps outstanding asynchronous filesystem probes at eight", async () => {
    let active = 0;
    let maximumActive = 0;
    const result = await discoverAvailableEditors({
      platform: "win32",
      cwd: "C:\\workspace",
      env: { PATH: "C:\\bin", PATHEXT: ".CMD" },
      statPath: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        active -= 1;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      lookupWindowsStorePackages: async () => ({
        status: "success",
        installLocationsByFamily: {},
        subprocessCount: 1,
      }),
    });

    assert.equal(result.status, "success");
    assert.equal(maximumActive <= 8, true);
    assert.equal(maximumActive > 1, true);
  });

  it("classifies transient filesystem failures instead of confirming an empty snapshot", async () => {
    const result = await discoverAvailableEditors({
      platform: "win32",
      cwd: "C:\\workspace",
      env: { PATH: "C:\\bin", PATHEXT: ".CMD" },
      statPath: async () => {
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      },
      lookupWindowsStorePackages: async () => ({
        status: "success",
        installLocationsByFamily: {},
        subprocessCount: 1,
      }),
    });

    assert.equal(result.status, "failure");
    if (result.status === "failure") {
      assert.equal(result.category, "filesystem_transient");
      assert.equal(result.fileSystemOperations > 0, true);
      assert.equal(result.subprocessCount, 1);
    }
  });
});

it("runs one bounded, shell-free PowerShell process for bulk AppX discovery", async () => {
  const editor = EDITORS.find((candidate) => candidate.id === "vscode");
  assert.ok(editor);
  const packages = getEditorWindowsStorePackages(editor) ?? [];
  let captured:
    | {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: {
          readonly env: NodeJS.ProcessEnv;
          readonly shell: false;
          readonly windowsHide: true;
        };
      }
    | undefined;
  const callerEnv = {
    Path: "C:\\discarded-bin",
    PATH: "D:\\effective-bin",
    SystemRoot: "C:\\discarded-windows",
    SYSTEMROOT: "D:\\Windows",
  } satisfies NodeJS.ProcessEnv;
  const callerBefore = { ...callerEnv };

  const result = await discoverWindowsStorePackageInstallLocations(packages, {
    platform: "win32",
    env: callerEnv,
    spawnProcess: (command, args, options) => {
      captured = { command, args, options };
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.end(
          JSON.stringify([
            {
              Family: "Microsoft.VisualStudioCode_8wekyb3d8bbwe",
              InstallLocation: "C:\\Program Files\\WindowsApps\\VSCode",
            },
          ]),
        );
        child.emit("close", 0);
      });
      return child as never;
    },
  });

  assert.equal(result.status, "success");
  assert.equal(captured?.command, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(captured?.args.includes("-NoProfile"), true);
  assert.equal(captured?.args.includes("-NonInteractive"), true);
  assert.equal(captured?.options.shell, false);
  assert.equal(captured?.options.windowsHide, true);
  assert.equal(captured?.args.at(-1)?.includes("Microsoft.VisualStudioCode"), true);
  assert.equal(captured?.args.at(-1)?.includes("-ErrorAction Stop"), true);
  assert.equal(captured?.args.at(-1)?.includes("-ErrorAction SilentlyContinue"), false);
  assert.deepEqual(captured?.options.env, {
    PATH: "D:\\effective-bin",
    SYSTEMROOT: "D:\\Windows",
  });
  assert.deepEqual(callerEnv, callerBefore);
});

it("classifies terminating bulk AppX command failures as process exits", async () => {
  let script = "";
  const result = await discoverWindowsStorePackageInstallLocations(vscodeStorePackages(), {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnProcess: (_command, args) => {
      script = args.at(-1) ?? "";
      const child = makeFakeAppxChild();
      setImmediate(() => {
        child.stdout.end("[]");
        child.emit("close", 1);
      });
      return child as never;
    },
  });

  assert.deepEqual(result, { status: "failure", category: "process_exit", subprocessCount: 1 });
  assert.equal(script.includes("Get-AppxPackage"), true);
  assert.equal(script.includes("-ErrorAction Stop"), true);
});

it("kills AppX discovery when combined output crosses the 256 KiB cap", async () => {
  const editor = EDITORS.find((candidate) => candidate.id === "vscode");
  assert.ok(editor);
  let kills = 0;
  const result = await discoverWindowsStorePackageInstallLocations(
    getEditorWindowsStorePackages(editor) ?? [],
    {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: () => boolean;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
          kills += 1;
          setImmediate(() => child.emit("close", null));
          return true;
        };
        setImmediate(() =>
          child.stderr.write(Buffer.alloc(WINDOWS_STORE_BULK_LOOKUP_OUTPUT_LIMIT_BYTES + 1)),
        );
        return child as never;
      },
    },
  );

  assert.deepEqual(result, { status: "failure", category: "output_limit", subprocessCount: 1 });
  assert.equal(kills, 1);
});

it("settles and removes listeners when AppX termination cannot signal the child", async () => {
  for (const kill of [
    () => false,
    () => {
      throw new Error("kill failed");
    },
  ]) {
    const child = makeFakeAppxChild(kill);
    const lookup = discoverWindowsStorePackageInstallLocations(vscodeStorePackages(), {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnProcess: () => child as never,
    });
    child.stderr.write(Buffer.alloc(WINDOWS_STORE_BULK_LOOKUP_OUTPUT_LIMIT_BYTES + 1));

    await expect(lookup).resolves.toEqual({
      status: "failure",
      category: "output_limit",
      subprocessCount: 1,
    });
    assert.equal(child.listenerCount("error"), 0);
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
  }
});

it("settles AppX abort and error races exactly once", async () => {
  const abortController = new AbortController();
  let abortChild!: FakeAppxChild;
  abortChild = makeFakeAppxChild(() => {
    setImmediate(() => abortChild.emit("close", 0));
    return true;
  });
  const aborted = discoverWindowsStorePackageInstallLocations(vscodeStorePackages(), {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    signal: abortController.signal,
    spawnProcess: () => abortChild as never,
  });
  abortController.abort();
  abortChild.stdout.end("[]");
  await expect(aborted).resolves.toEqual({
    status: "failure",
    category: "cancelled",
    subprocessCount: 1,
  });

  const errorChild = makeFakeAppxChild();
  const errored = discoverWindowsStorePackageInstallLocations(vscodeStorePackages(), {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnProcess: () => errorChild as never,
  });
  errorChild.emit("error", new Error("spawn error"));
  errorChild.emit("close", 0);
  await expect(errored).resolves.toEqual({
    status: "failure",
    category: "process_error",
    subprocessCount: 1,
  });
  assert.equal(errorChild.listenerCount("close"), 0);
});

it("prefers a completed AppX close over a later abort and clears the deadline", async () => {
  vi.useFakeTimers();
  try {
    const abortController = new AbortController();
    const child = makeFakeAppxChild();
    const lookup = discoverWindowsStorePackageInstallLocations(vscodeStorePackages(), {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      signal: abortController.signal,
      spawnProcess: () => child as never,
    });
    child.stdout.write("[]");
    child.emit("close", 0);
    abortController.abort();

    await expect(lookup).resolves.toEqual({
      status: "success",
      installLocationsByFamily: {},
      subprocessCount: 1,
    });
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(child.listenerCount("close"), 0);
  } finally {
    vi.useRealTimers();
  }
});

it("reports timeout after a successful kill/close race and clears the deadline", async () => {
  vi.useFakeTimers();
  try {
    let child!: FakeAppxChild;
    child = makeFakeAppxChild(() => {
      queueMicrotask(() => child.emit("close", 0));
      return true;
    });
    const lookup = discoverWindowsStorePackageInstallLocations(vscodeStorePackages(), {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnProcess: () => child as never,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(lookup).resolves.toEqual({
      status: "failure",
      category: "timeout",
      subprocessCount: 1,
    });
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.stdout.listenerCount("data"), 0);
  } finally {
    vi.useRealTimers();
  }
});

it("bounds true/no-close AppX termination and removes every owned listener", async () => {
  vi.useFakeTimers();
  try {
    const scenarios = [
      {
        category: "cancelled" as const,
        begin: async (child: FakeAppxChild, abortController: AbortController) => {
          abortController.abort();
        },
      },
      {
        category: "output_limit" as const,
        begin: async (child: FakeAppxChild) => {
          child.stderr.write(Buffer.alloc(WINDOWS_STORE_BULK_LOOKUP_OUTPUT_LIMIT_BYTES + 1));
        },
      },
      {
        category: "timeout" as const,
        begin: async () => {
          await vi.advanceTimersByTimeAsync(WINDOWS_STORE_BULK_LOOKUP_TIMEOUT_MS);
        },
      },
    ];

    for (const scenario of scenarios) {
      const abortController = new AbortController();
      const child = makeFakeAppxChild();
      const externalErrorListener = () => undefined;
      let kills = 0;
      child.on("error", externalErrorListener);
      child.kill = () => {
        kills += 1;
        return true;
      };
      let resolved = false;
      const lookup = discoverWindowsStorePackageInstallLocations(vscodeStorePackages(), {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        signal: abortController.signal,
        spawnProcess: () => child as never,
      }).then((result) => {
        resolved = true;
        return result;
      });

      await scenario.begin(child, abortController);
      await vi.advanceTimersByTimeAsync(WINDOWS_STORE_BULK_LOOKUP_TERMINATION_GRACE_MS - 1);
      assert.equal(resolved, false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(lookup).resolves.toEqual({
        status: "failure",
        category: scenario.category,
        subprocessCount: 1,
      });

      assert.equal(kills, 1);
      assert.equal(vi.getTimerCount(), 0);
      assert.deepEqual(child.listeners("error"), [externalErrorListener]);
      assert.equal(child.listenerCount("close"), 0);
      assert.equal(child.stdout.listenerCount("data"), 0);
      assert.equal(child.stderr.listenerCount("data"), 0);
      assert.equal(getEventListeners(abortController.signal, "abort").length, 0);

      child.emit("close", 0);
      child.emit("error", new Error("late child error"));
      child.stdout.write("late output");
      abortController.abort();
      assert.equal(kills, 1);
      child.removeListener("error", externalErrorListener);
    }
  } finally {
    vi.useRealTimers();
  }
});

it("preserves the latched AppX termination category through synchronous child errors", async () => {
  vi.useFakeTimers();
  try {
    const scenarios = [
      {
        category: "cancelled" as const,
        begin: async (child: FakeAppxChild, abortController: AbortController) => {
          abortController.abort();
        },
      },
      {
        category: "output_limit" as const,
        begin: async (child: FakeAppxChild) => {
          child.stdout.write(Buffer.alloc(WINDOWS_STORE_BULK_LOOKUP_OUTPUT_LIMIT_BYTES + 1));
        },
      },
      {
        category: "timeout" as const,
        begin: async () => {
          await vi.advanceTimersByTimeAsync(WINDOWS_STORE_BULK_LOOKUP_TIMEOUT_MS);
        },
      },
    ];

    for (const scenario of scenarios) {
      const abortController = new AbortController();
      const child = makeFakeAppxChild();
      let kills = 0;
      child.kill = () => {
        kills += 1;
        child.emit("error", new Error("kill race"));
        return true;
      };
      const lookup = discoverWindowsStorePackageInstallLocations(vscodeStorePackages(), {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        signal: abortController.signal,
        spawnProcess: () => child as never,
      });

      await scenario.begin(child, abortController);
      await expect(lookup).resolves.toEqual({
        status: "failure",
        category: scenario.category,
        subprocessCount: 1,
      });
      assert.equal(kills, 1);
      assert.equal(vi.getTimerCount(), 0);
      assert.equal(child.listenerCount("error"), 0);
      assert.equal(child.listenerCount("close"), 0);
      assert.equal(child.stdout.listenerCount("data"), 0);
      assert.equal(child.stderr.listenerCount("data"), 0);
      assert.equal(getEventListeners(abortController.signal, "abort").length, 0);
    }
  } finally {
    vi.useRealTimers();
  }
});
