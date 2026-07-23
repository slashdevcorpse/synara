// FILE: windowsProcessEffect.test.ts
// Purpose: Verifies Effect forwards verbatim Windows command lines to Node spawn.
// Layer: Server process integration test

import * as NodeServices from "@effect/platform-node/NodeServices";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect, it } from "vitest";

import { collectUint8StreamText } from "./stream/collectUint8StreamText.ts";

it.runIf(process.platform === "win32")(
  "forwards encoded Codex arguments verbatim through the Effect Node spawner",
  async () => {
    const root = mkdtempSync(Path.join(tmpdir(), "synara-effect-windows-process-"));
    const commandDir = Path.join(root, "tools(x86)");
    const scriptPath = Path.join(commandDir, "capture.mjs");
    const commandPath = Path.join(commandDir, "codex.cmd");
    const outputPath = Path.join(root, "args.json");
    const expectedArgs = [
      "exec",
      "--config",
      'approval_policy="never"',
      "--config",
      'model_reasoning_effort="high"',
    ];

    try {
      mkdirSync(commandDir);
      writeFileSync(
        scriptPath,
        [
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.env.SYNARA_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));",
          "",
        ].join("\n"),
      );
      writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0capture.mjs" %*\r\n`);

      const env = { ...process.env, SYNARA_CAPTURE_PATH: outputPath };
      const prepared = prepareWindowsSafeProcess(commandPath, expectedArgs, {
        platform: "win32",
        env,
      });
      const options = {
        env,
        shell: prepared.shell,
        ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      };

      const exitCode = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(prepared.command, prepared.args, options),
          );
          return yield* child.exitCode;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );

      expect(Number(exitCode)).toBe(0);
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(expectedArgs);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

it.runIf(process.platform === "win32")(
  "preserves npm's nested prefix probe through the Effect Node spawner",
  async () => {
    const root = mkdtempSync(Path.join(tmpdir(), "synara-effect-npm-prefix-"));
    const nodeDirectory = Path.join(root, "Program Files", "nodejs");
    const nodePath = Path.join(nodeDirectory, "node.exe");
    const npmPrefixScriptPath = Path.join(
      nodeDirectory,
      "node_modules",
      "npm",
      "bin",
      "npm-prefix.js",
    );
    const npmCommandPath = Path.join(nodeDirectory, "npm.cmd");
    const expectedPrefix = Path.join(root, "User Data", "npm");

    try {
      mkdirSync(Path.dirname(npmPrefixScriptPath), { recursive: true });
      copyFileSync(process.execPath, nodePath);
      writeFileSync(
        npmPrefixScriptPath,
        'process.stdout.write(`${process.env.SYNARA_EXPECTED_NPM_PREFIX}\\n`);\n',
      );
      writeFileSync(
        npmCommandPath,
        [
          "@ECHO OFF",
          "SETLOCAL",
          'SET "NODE_EXE=%~dp0node.exe"',
          'SET "NPM_PREFIX_JS=%~dp0node_modules\\npm\\bin\\npm-prefix.js"',
          'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
          '  SET "NPM_PREFIX=%%F"',
          ")",
          "IF NOT DEFINED NPM_PREFIX EXIT /B 41",
          "ECHO %NPM_PREFIX%",
          "",
        ].join("\r\n"),
      );

      const env = { ...process.env, SYNARA_EXPECTED_NPM_PREFIX: expectedPrefix };
      const prepared = prepareWindowsSafeProcess(npmCommandPath, [], {
        platform: "win32",
        env,
      });
      const options = {
        env,
        shell: prepared.shell,
        ...(prepared.windowsHide ? { windowsHide: true } : {}),
        ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      };

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(prepared.command, prepared.args, options),
          );
          const [stdout, exitCode] = yield* Effect.all(
            [collectUint8StreamText({ stream: child.stdout }), child.exitCode],
            { concurrency: "unbounded" },
          );
          return { exitCode: Number(exitCode), stdout: stdout.text };
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(expectedPrefix);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);
