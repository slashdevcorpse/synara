import * as os from "node:os";
import * as path from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const CursorTextGenerationTestLayer = CursorTextGenerationLive.pipe(
  Layer.provideMerge(NodeServices.layer),
);

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeAcpAgentWrapper(dir: string, env: Record<string, string>): string {
  const binDir = path.join(dir, "bin");
  const windowsLauncherRelativePath = path.join(
    "node_modules",
    "synara-cursor-text-fixture",
    "bin",
    "agent-launcher.mjs",
  );
  const launcherPath = path.join(
    binDir,
    process.platform === "win32" ? windowsLauncherRelativePath : "agent-launcher.ts",
  );
  const agentPath = path.join(binDir, process.platform === "win32" ? "agent.cmd" : "agent");
  mkdirSync(path.dirname(launcherPath), { recursive: true });
  writeFileSync(
    launcherPath,
    [
      'import { writeFileSync } from "node:fs";',
      `Object.assign(process.env, ${JSON.stringify(env)});`,
      "const pidLogPath = process.env.SYNARA_ACP_PID_LOG_PATH;",
      'if (pidLogPath) writeFileSync(pidLogPath, `${process.pid}\\n`, "utf8");',
      'if (process.argv[2] !== "acp") {',
      '  console.error(`unexpected args: ${process.argv.slice(2).join(" ")}`);',
      "  process.exit(11);",
      "}",
      `await import(${JSON.stringify(pathToFileURL(mockAgentPath).href)});`,
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    agentPath,
    process.platform === "win32"
      ? [
          "@ECHO off",
          `"%~dp0\\node.exe" "%~dp0\\${windowsLauncherRelativePath.replaceAll("/", "\\")}" %*`,
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(launcherPath)} "$@"`,
          "",
        ].join("\n"),
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(agentPath, 0o755);
  return agentPath;
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effect: (agentPath: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-cursor-text-acp-"));
      return {
        tempDir,
        agentPath: makeAcpAgentWrapper(tempDir, env),
      };
    }),
    ({ agentPath }) => effect(agentPath),
    ({ tempDir }) =>
      Effect.sync(() => {
        rmSync(tempDir, { recursive: true, force: true });
      }),
  );
}

function waitForFileContent(filePath: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        return readFileSync(filePath, "utf8");
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}

function waitForProcessExit(pid: number): Effect.Effect<void> {
  return Effect.promise(async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`ACP child process ${pid} did not exit`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}

it.layer(CursorTextGenerationTestLayer)("CursorTextGenerationLive", (it) => {
  it.effect("uses ACP model config options instead of raw CLI model ids", () => {
    const requestLogDir = mkdtempSync(path.join(os.tmpdir(), "synara-cursor-text-log-"));
    const requestLogPath = path.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        SYNARA_ACP_REQUEST_LOG_PATH: requestLogPath,
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify cursor acp model config path",
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-text-generation",
            stagedSummary: "M apps/server/src/git/Layers/CursorTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/git/Layers/CursorTextGeneration.ts b/apps/server/src/git/Layers/CursorTextGeneration.ts",
            modelSelection: {
              provider: "cursor",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "xhigh",
                fastMode: true,
                contextWindow: "1m",
              },
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.subject).toBe("Add generated commit message");
          expect(generated.body).toBe("- verify cursor acp model config path");

          const requests = readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );

          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toHaveProperty("_meta.parameterizedModelPicker");
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "gpt-5.4",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "reasoning" &&
                request.params?.value === "extra-high",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "context" &&
                request.params?.value === "1m",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "fast" &&
                request.params?.value === "true",
            ),
          ).toBe(true);

          rmSync(requestLogDir, { recursive: true, force: true });
        }),
    );
  });

  it.effect("accepts json objects with extra assistant text around them", () =>
    withFakeAcpAgent(
      {
        SYNARA_ACP_PROMPT_RESPONSE_TEXT:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-noisy-json",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.subject).toBe("Update README dummy comment with attribution and date");
          expect(generated.body).toBe("");
        }),
    ),
  );

  it.effect("generates diff summaries through Cursor ACP text generation", () =>
    withFakeAcpAgent(
      {
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          summary: "## Summary\n- Route git summaries through Cursor.",
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateDiffSummary({
            cwd: process.cwd(),
            patch: "diff --git a/file.ts b/file.ts",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.summary).toBe("## Summary\n- Route git summaries through Cursor.");
        }),
    ),
  );

  it.effect("falls back to raw text when Cursor replies without JSON for a thread title", () =>
    withFakeAcpAgent(
      {
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: "Sidebar Thread Row Spacing",
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Improve sidebar thread row spacing and hover states.",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.title).toBe("Sidebar Thread Row Spacing");
        }),
    ),
  );

  it.effect("recovers a thread title from a wrong-key JSON payload", () =>
    withFakeAcpAgent(
      {
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ name: "Reconnect Backoff Fix" }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the websocket reconnect backoff.",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.title).toBe("Reconnect Backoff Fix");
        }),
    ),
  );

  it.effect("rejects sentence-length prose instead of using it as a title", () =>
    withFakeAcpAgent(
      {
        SYNARA_ACP_PROMPT_RESPONSE_TEXT:
          "I'm sorry, but I cannot generate a concise title for this particular request right now.",
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const result = yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix the websocket reconnect backoff.",
              modelSelection: {
                provider: "cursor",
                model: "composer-2",
              },
              providerOptions: {
                cursor: {
                  binaryPath: agentPath,
                },
              },
            })
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: "Left" as const, left: error }),
                onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
              }),
            );

          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(TextGenerationError);
            expect(result.left.message).toContain(
              "Cursor Agent returned invalid structured output",
            );
          }
        }),
    ),
  );

  it.effect("closes the ACP child process after text generation completes", () => {
    const exitLogDir = mkdtempSync(path.join(os.tmpdir(), "synara-cursor-text-exit-log-"));
    const exitLogPath = path.join(exitLogDir, "exit.log");
    const pidLogPath = path.join(exitLogDir, "pid.log");

    return withFakeAcpAgent(
      {
        SYNARA_ACP_EXIT_LOG_PATH: exitLogPath,
        SYNARA_ACP_PID_LOG_PATH: pidLogPath,
        SYNARA_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: '"Trim reconnect spinner status after resume."',
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.title).toBe("Trim reconnect spinner status after resume");

          const childPid = Number.parseInt((yield* waitForFileContent(pidLogPath)).trim(), 10);
          expect(Number.isSafeInteger(childPid)).toBe(true);
          yield* waitForProcessExit(childPid);
          if (process.platform !== "win32") {
            const exitLog = yield* waitForFileContent(exitLogPath);
            expect(exitLog).toContain("exit:0");
          }

          rmSync(exitLogDir, { recursive: true, force: true });
        }),
    );
  });
});
