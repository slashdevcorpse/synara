import { describe, expect, it } from "vitest";

import { parseCanonicalWindowsNpmNodeShim } from "./windowsNpmShim";

const target = "node_modules/@openai/codex/bin/codex.js";

describe("canonical Windows npm Node shim parsing", () => {
  it.each([
    [
      "direct host template",
      `@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\${target.replaceAll("/", "\\")}" %*\r\n`,
    ],
    [
      "PATH fallback template",
      [
        '@IF EXIST "%~dp0\\node.exe" (',
        `  "%~dp0\\node.exe" "%~dp0\\${target.replaceAll("/", "\\")}" %*`,
        ") ELSE (",
        "  @SETLOCAL",
        "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
        `  node "%~dp0\\${target.replaceAll("/", "\\")}" %*`,
        ")",
      ].join("\r\n"),
    ],
    [
      "cmd-shim template",
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        "",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        "",
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target.replaceAll("/", "\\")}" %*`,
      ].join("\r\n"),
    ],
  ])("recognizes the %s", (_name, contents) => {
    expect(parseCanonicalWindowsNpmNodeShim(contents)).toBe(target);
  });

  it.each([
    [
      "path traversal",
      '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\pkg\\..\\escape.js" %*\r\n',
    ],
    [
      "non-canonical separators",
      '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\\\pkg\\bin.js" %*\r\n',
    ],
    [
      "mismatched fallback targets",
      [
        '@IF EXIST "%~dp0\\node.exe" (',
        '  "%~dp0\\node.exe" "%~dp0\\node_modules\\pkg\\bin.js" %*',
        ") ELSE (",
        "  @SETLOCAL",
        "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
        '  node "%~dp0\\node_modules\\other\\bin.js" %*',
        ")",
      ].join("\r\n"),
    ],
    [
      "extra batch command",
      `@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\${target.replaceAll("/", "\\")}" %*\r\nother-tool.exe --version\r\n`,
    ],
    ["arbitrary wrapper", `@ECHO off\r\nCALL node "%~dp0\\${target.replaceAll("/", "\\")}" %*\r\n`],
  ])("rejects %s", (_name, contents) => {
    expect(parseCanonicalWindowsNpmNodeShim(contents)).toBeNull();
  });
});
