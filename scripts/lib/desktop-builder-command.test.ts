import { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDesktopBuilderCommandPlan,
  resolveDesktopBuilderCliPath,
} from "./desktop-builder-command.ts";

describe("desktop builder command", () => {
  it("creates a shell-free Windows plan with exact platform arguments", () => {
    expect(
      createDesktopBuilderCommandPlan({
        repoRoot: "C:\\repo",
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        platformCliFlag: "--win",
        arch: "x64",
        pathJoiner: win32,
        fileExists: () => true,
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\repo\\scripts\\node_modules\\electron-builder\\out\\cli\\cli.js",
        "--win",
        "--x64",
        "--publish",
        "never",
      ],
      shell: false,
    });
  });

  it("creates a shell-free POSIX plan with identical argument ordering", () => {
    expect(
      createDesktopBuilderCommandPlan({
        repoRoot: "/repo",
        nodeExecutable: "/usr/bin/node",
        platformCliFlag: "--mac",
        arch: "arm64",
        pathJoiner: posix,
        fileExists: () => true,
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: [
        "/repo/scripts/node_modules/electron-builder/out/cli/cli.js",
        "--mac",
        "--arm64",
        "--publish",
        "never",
      ],
      shell: false,
    });
  });

  it("fails before spawning when the JavaScript CLI is missing", () => {
    expect(() => resolveDesktopBuilderCliPath("/repo", posix, () => false)).toThrow(
      "electron-builder JavaScript CLI is missing: /repo/scripts/node_modules/electron-builder/out/cli/cli.js",
    );
  });
});
