/**
 * CursorAcpCommand tests - regression coverage for Cursor CLI executable/env resolution.
 *
 * Protects the Cursor/Grok collision where the bare `agent` name can belong to
 * Grok while Cursor's current ACP-capable executable is `cursor-agent`, and
 * keeps auth/status subprocesses browserless.
 *
 * @module CursorAcpCommand.test
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCursorAgentCommand,
  buildCursorAgentHeadlessEnv,
  resolveCursorAgentBinaryPath,
} from "./CursorAcpCommand.ts";

const executableExtension = process.platform === "win32" ? ".exe" : "";
const executablePath = (directory: string, command: string): string =>
  path.join(directory, `${command}${executableExtension}`);

describe("resolveCursorAgentBinaryPath", () => {
  it("defaults to cursor-agent when no binary is configured", () => {
    expect(resolveCursorAgentBinaryPath(undefined)).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath(null)).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath("   ")).toBe("cursor-agent");
  });

  it("maps the old ambiguous agent default to cursor-agent", () => {
    expect(resolveCursorAgentBinaryPath("agent")).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath("  agent  ")).toBe("cursor-agent");
  });

  it("honors explicit custom Cursor binary paths", () => {
    expect(resolveCursorAgentBinaryPath("cursor-agent")).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath("/usr/local/bin/agent")).toBe("/usr/local/bin/agent");
  });
});

describe("buildCursorAgentCommand", () => {
  it("runs default Cursor Agent commands directly", () => {
    expect(buildCursorAgentCommand(undefined, ["acp"])).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
    expect(buildCursorAgentCommand("agent", ["models"])).toEqual({
      command: "cursor-agent",
      args: ["models"],
    });
  });

  it("normalizes Cursor editor launchers before appending agent args", () => {
    const toolsDir = path.resolve("tools");
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: toolsDir },
        pathExists: (candidate) => candidate === executablePath(toolsDir, "cursor-agent"),
      }),
    ).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
    expect(
      buildCursorAgentCommand(
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        ["models"],
        { pathExists: () => false },
      ),
    ).toEqual({
      command: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      args: ["agent", "models"],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
        ["--version"],
        { pathExists: () => false },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
      args: ["agent", "--version"],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
        ["--version"],
        {
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.exe",
        },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.exe",
      args: ["--version"],
    });
  });

  it("does not use adjacent generic agent commands for bare cursor launchers", () => {
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/tools/cursor" || path === "/tools/agent",
      }),
    ).toEqual({
      command: "cursor",
      args: ["agent", "acp"],
    });
  });

  it("falls back through Cursor editor launchers when no agent command can be resolved", () => {
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/tools/cursor",
      }),
    ).toEqual({
      command: "cursor",
      args: ["agent", "acp"],
    });
  });

  it("falls back to PATH cursor-agent before inventing an agent sibling", () => {
    const toolsDir = path.resolve("tools");
    expect(
      buildCursorAgentCommand("/missing/bin/cursor", ["acp"], {
        env: { PATH: toolsDir },
        pathExists: (candidate) => candidate === executablePath(toolsDir, "cursor-agent"),
      }),
    ).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
  });

  it("prefers PATH cursor-agent over sibling legacy agent commands", () => {
    const toolsDir = path.resolve("tools");
    expect(
      buildCursorAgentCommand("/usr/local/bin/cursor", ["acp"], {
        env: { PATH: toolsDir },
        pathExists: (candidate) =>
          candidate === "/usr/local/bin/agent" ||
          candidate === executablePath(toolsDir, "cursor-agent"),
      }),
    ).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
  });

  it("uses bundled sibling agent commands for Cursor-owned editor paths", () => {
    const root = path.parse(process.cwd()).root;
    const cursorBinDir = path.join(
      root,
      "Applications",
      "Cursor.app",
      "Contents",
      "Resources",
      "app",
      "bin",
    );
    const cursorPath = executablePath(cursorBinDir, "cursor");
    const agentPath = executablePath(cursorBinDir, "agent");
    const cursorSymlinkDir = path.join(root, "usr", "local", "bin");
    const cursorSymlinkPath = executablePath(cursorSymlinkDir, "cursor");
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: cursorBinDir },
        pathExists: (candidate) => candidate === cursorPath || candidate === agentPath,
      }),
    ).toEqual({
      command: agentPath,
      args: ["acp"],
    });

    expect(
      buildCursorAgentCommand("cursor", ["models"], {
        env: { PATH: cursorSymlinkDir },
        pathExists: (candidate) => candidate === cursorSymlinkPath || candidate === agentPath,
        realpath: (candidate) => (candidate === cursorSymlinkPath ? cursorPath : candidate),
      }),
    ).toEqual({
      command: agentPath,
      args: ["models"],
    });

    expect(
      buildCursorAgentCommand(cursorPath, ["acp"], {
        env: { PATH: "" },
        pathExists: (path) => path === agentPath,
      }),
    ).toEqual({
      command: agentPath,
      args: ["acp"],
    });

    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
        ["status"],
        {
          env: { PATH: "" },
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\agent.cmd",
        },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\agent.cmd",
      args: ["status"],
    });
  });

  it("ignores adjacent generic agent commands for configured Cursor editor paths", () => {
    expect(
      buildCursorAgentCommand("/usr/local/bin/cursor", ["acp"], {
        env: { PATH: "" },
        pathExists: (path) => path === "/usr/local/bin/agent",
      }),
    ).toEqual({
      command: "/usr/local/bin/cursor",
      args: ["agent", "acp"],
    });
  });

  it("prefers safer Windows shims but accepts PowerShell-only Cursor agent siblings", () => {
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        ["acp"],
        {
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.ps1" ||
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.cmd",
        },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.cmd",
      args: ["acp"],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        ["status"],
        {
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.ps1",
        },
      ),
    ).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.ps1",
        "status",
      ],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        ["models"],
        {
          env: { PATH: "" },
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\agent.ps1",
        },
      ),
    ).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\agent.ps1",
        "models",
      ],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        ["status"],
        { pathExists: () => false },
      ),
    ).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        "agent",
        "status",
      ],
    });
  });

  it("prefers a sibling cursor-agent when a Cursor shim path is configured", () => {
    expect(
      buildCursorAgentCommand("/Users/me/.local/bin/cursor", ["acp"], {
        pathExists: (path) => path === "/Users/me/.local/bin/cursor-agent",
      }),
    ).toEqual({
      command: "/Users/me/.local/bin/cursor-agent",
      args: ["acp"],
    });
  });

  it("honors explicit agent paths without adding another subcommand", () => {
    expect(buildCursorAgentCommand("/Users/me/.local/bin/agent", ["acp"])).toEqual({
      command: "/Users/me/.local/bin/agent",
      args: ["acp"],
    });
    expect(buildCursorAgentCommand("/Users/me/.local/bin/cursor-agent", ["acp"])).toEqual({
      command: "/Users/me/.local/bin/cursor-agent",
      args: ["acp"],
    });
  });
});

describe("buildCursorAgentHeadlessEnv", () => {
  it("forces Cursor probe subprocesses into headless mode while preserving the base env", () => {
    expect(buildCursorAgentHeadlessEnv({ PATH: "/bin", BROWSER: "open" })).toMatchObject({
      PATH: "/bin",
      NO_BROWSER: "true",
      BROWSER: "www-browser",
      CI: "true",
      DEBIAN_FRONTEND: "noninteractive",
    });
  });
});
