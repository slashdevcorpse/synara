import { existsSync, realpathSync } from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";

import { resolveCodexCliExecutable } from "@synara/shared/codexCliExecutable";

import { ServerConfig } from "../../config.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

const CodexTextGenerationTestLayer = CodexTextGenerationLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-codex-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

let codexEnvQueue = Promise.resolve();

function acquireCodexEnvLock() {
  return Effect.promise(async () => {
    let releaseLock = () => {};
    const previous = codexEnvQueue;
    codexEnvQueue = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previous;
    return releaseLock;
  });
}

function fakeCodexNodeScript(): string {
  return [
    'import fs from "node:fs";',
    "",
    "const args = process.argv.slice(2);",
    'let outputPath = "";',
    "let seenImage = false;",
    "let seenSkipGitRepoCheck = false;",
    "let seenApprovalNever = false;",
    "for (let index = 0; index < args.length; index += 1) {",
    "  const argument = args[index];",
    '  if (argument === "--image") {',
    "    index += 1;",
    "    seenImage = Boolean(args[index]);",
    "    continue;",
    "  }",
    '  if (argument === "--skip-git-repo-check") {',
    "    seenSkipGitRepoCheck = true;",
    "    continue;",
    "  }",
    '  if (argument === "--config") {',
    "    index += 1;",
    "    seenApprovalNever ||= args[index] === 'approval_policy=\"never\"';",
    "    continue;",
    "  }",
    '  if (argument === "--output-last-message") {',
    "    index += 1;",
    '    outputPath = args[index] ?? "";',
    "  }",
    "}",
    "",
    'const stdinContent = fs.readFileSync(0, "utf8");',
    "const fail = (message, code) => {",
    "  process.stderr.write(`${message}\\n`);",
    "  process.exit(code);",
    "};",
    'if (process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE === "1" && !seenImage) {',
    '  fail("missing --image input", 2);',
    "}",
    'if (process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK === "1" && !seenSkipGitRepoCheck) {',
    '  fail("missing --skip-git-repo-check", 9);',
    "}",
    'if (process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER === "1" && !seenApprovalNever) {',
    '  fail("missing approval_policy=never", 10);',
    "}",
    "if (process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN && !stdinContent.includes(process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN)) {",
    '  fail("stdin missing expected content", 3);',
    "}",
    "if (process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN && stdinContent.includes(process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN)) {",
    '  fail("stdin contained forbidden content", 4);',
    "}",
    'if (process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME === "1" && !process.env.CODEX_HOME) {',
    '  fail("missing CODEX_HOME", 5);',
    "}",
    'if (process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON === "1" && !fs.existsSync(`${process.env.CODEX_HOME}/auth.json`)) {',
    '  fail("missing auth.json in CODEX_HOME", 6);',
    "}",
    "if (process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN) {",
    '  const config = fs.readFileSync(`${process.env.CODEX_HOME}/config.toml`, "utf8");',
    "  if (!config.includes(process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN)) {",
    '    fail("CODEX_HOME config missing expected content", 7);',
    "  }",
    "}",
    "if (process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN) {",
    '  const config = fs.readFileSync(`${process.env.CODEX_HOME}/config.toml`, "utf8");',
    "  if (config.includes(process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN)) {",
    '    fail("CODEX_HOME config contained forbidden content", 8);',
    "  }",
    "}",
    "if (process.env.SYNARA_FAKE_CODEX_STDERR) {",
    "  process.stderr.write(`${process.env.SYNARA_FAKE_CODEX_STDERR}\\n`);",
    "}",
    "if (outputPath) {",
    '  fs.writeFileSync(outputPath, Buffer.from(process.env.SYNARA_FAKE_CODEX_OUTPUT_B64 ?? "e30=", "base64"));',
    "}",
    'process.exit(Number.parseInt(process.env.SYNARA_FAKE_CODEX_EXIT_CODE ?? "0", 10));',
    "",
  ].join("\n");
}

function inheritedPathWithoutNativeCodex(pathValue: string | undefined): string[] {
  const entries = (pathValue ?? "").split(NodePath.delimiter).filter(Boolean);
  if (process.platform !== "win32") return entries;

  return entries.filter((entry) => {
    const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    return !["codex.exe", "codex.com"].some((name) => existsSync(NodePath.join(directory, name)));
  });
}

function makeFakeCodexBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
    const scriptPath = path.join(binDir, "fake-codex.mjs");
    yield* fs.makeDirectory(binDir, { recursive: true });
    yield* fs.writeFileString(scriptPath, fakeCodexNodeScript());

    if (process.platform === "win32") {
      const escapedNodePath = process.execPath.replaceAll("%", "%%");
      yield* fs.writeFileString(
        codexPath,
        ["@echo off", `@"${escapedNodePath}" "%~dp0fake-codex.mjs" %*`, ""].join("\r\n"),
      );
    } else {
      const escapedNodePath = process.execPath.replaceAll("'", "'\\''");
      const escapedScriptPath = scriptPath.replaceAll("'", "'\\''");
      yield* fs.writeFileString(
        codexPath,
        ["#!/bin/sh", `exec '${escapedNodePath}' '${escapedScriptPath}' "$@"`, ""].join("\n"),
      );
      yield* fs.chmod(codexPath, 0o755);
    }
    return binDir;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
    requireCodexHome?: boolean;
    requireAuthJson?: boolean;
    requireSkipGitRepoCheck?: boolean;
    requireApprovalNever?: boolean;
    codexHomeConfigMustContain?: string;
    codexHomeConfigMustNotContain?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const releaseLock = yield* acquireCodexEnvLock();
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-codex-text-" });
      const binDir = yield* makeFakeCodexBinary(tempDir);
      const previousPath = process.env.PATH;
      const previousCodexInstallDir = process.env.CODEX_INSTALL_DIR;
      const previousLocalAppData = process.env.LOCALAPPDATA;
      const previousSynaraHome = process.env.SYNARA_HOME;
      const previousOutput = process.env.SYNARA_FAKE_CODEX_OUTPUT_B64;
      const previousExitCode = process.env.SYNARA_FAKE_CODEX_EXIT_CODE;
      const previousStderr = process.env.SYNARA_FAKE_CODEX_STDERR;
      const previousRequireImage = process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE;
      const previousStdinMustContain = process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN;
      const previousStdinMustNotContain = process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
      const previousRequireCodexHome = process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME;
      const previousRequireAuthJson = process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON;
      const previousRequireSkipGitRepoCheck =
        process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
      const previousRequireApprovalNever = process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
      const previousCodexHomeConfigMustContain =
        process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
      const previousCodexHomeConfigMustNotContain =
        process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;

      yield* Effect.sync(() => {
        process.env.PATH = [binDir, ...inheritedPathWithoutNativeCodex(previousPath)].join(
          NodePath.delimiter,
        );
        process.env.CODEX_INSTALL_DIR = tempDir;
        process.env.LOCALAPPDATA = tempDir;
        process.env.SYNARA_HOME = tempDir;
        if (process.platform === "win32") {
          expect(
            realpathSync.native(resolveCodexCliExecutable("codex", { env: process.env })),
          ).toBe(realpathSync.native(NodePath.join(binDir, "codex.cmd")));
        }
        process.env.SYNARA_FAKE_CODEX_OUTPUT_B64 = Buffer.from(input.output, "utf8").toString(
          "base64",
        );

        if (input.exitCode !== undefined) {
          process.env.SYNARA_FAKE_CODEX_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.SYNARA_FAKE_CODEX_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.SYNARA_FAKE_CODEX_STDERR = input.stderr;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_STDERR;
        }

        if (input.requireImage) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN;
        }

        if (input.stdinMustNotContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN = input.stdinMustNotContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        }

        if (input.requireCodexHome) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME;
        }

        if (input.requireAuthJson) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON;
        }

        if (input.requireSkipGitRepoCheck) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
        }

        if (input.requireApprovalNever) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
        }

        if (input.codexHomeConfigMustContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN =
            input.codexHomeConfigMustContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
        }

        if (input.codexHomeConfigMustNotContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN =
            input.codexHomeConfigMustNotContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;
        }
      });

      return {
        previousPath,
        previousCodexInstallDir,
        previousLocalAppData,
        previousSynaraHome,
        previousOutput,
        previousExitCode,
        previousStderr,
        previousRequireImage,
        previousStdinMustContain,
        previousStdinMustNotContain,
        previousRequireCodexHome,
        previousRequireAuthJson,
        previousRequireSkipGitRepoCheck,
        previousRequireApprovalNever,
        previousCodexHomeConfigMustContain,
        previousCodexHomeConfigMustNotContain,
        releaseLock,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env.PATH = previous.previousPath;
        if (previous.previousCodexInstallDir === undefined) {
          delete process.env.CODEX_INSTALL_DIR;
        } else {
          process.env.CODEX_INSTALL_DIR = previous.previousCodexInstallDir;
        }
        if (previous.previousLocalAppData === undefined) {
          delete process.env.LOCALAPPDATA;
        } else {
          process.env.LOCALAPPDATA = previous.previousLocalAppData;
        }
        if (previous.previousSynaraHome === undefined) {
          delete process.env.SYNARA_HOME;
        } else {
          process.env.SYNARA_HOME = previous.previousSynaraHome;
        }

        if (previous.previousOutput === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_OUTPUT_B64;
        } else {
          process.env.SYNARA_FAKE_CODEX_OUTPUT_B64 = previous.previousOutput;
        }

        if (previous.previousExitCode === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_EXIT_CODE;
        } else {
          process.env.SYNARA_FAKE_CODEX_EXIT_CODE = previous.previousExitCode;
        }

        if (previous.previousStderr === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_STDERR;
        } else {
          process.env.SYNARA_FAKE_CODEX_STDERR = previous.previousStderr;
        }

        if (previous.previousRequireImage === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE = previous.previousRequireImage;
        }

        if (previous.previousStdinMustContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN = previous.previousStdinMustContain;
        }

        if (previous.previousStdinMustNotContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN =
            previous.previousStdinMustNotContain;
        }

        if (previous.previousRequireCodexHome === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME = previous.previousRequireCodexHome;
        }

        if (previous.previousRequireAuthJson === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON = previous.previousRequireAuthJson;
        }

        if (previous.previousRequireSkipGitRepoCheck === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK =
            previous.previousRequireSkipGitRepoCheck;
        }

        if (previous.previousRequireApprovalNever === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER =
            previous.previousRequireApprovalNever;
        }

        if (previous.previousCodexHomeConfigMustContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN =
            previous.previousCodexHomeConfigMustContain;
        }

        if (previous.previousCodexHomeConfigMustNotContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN =
            previous.previousCodexHomeConfigMustNotContain;
        }

        previous.releaseLock();
      }),
  );
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive", (it) => {
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
        });

        expect(generated.subject.length).toBeLessThanOrEqual(72);
        expect(generated.subject.endsWith(".")).toBe(false);
        expect(generated.body).toBe("- added migration\n- updated tests");
        expect(generated.branch).toBeUndefined();
      }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          includeBranch: true,
        });

        expect(generated.subject).toBe("Add important change");
        expect(generated.branch).toBe("feature/fix/important-system-change");
      }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/codex-effect",
          commitSummary: "feat: improve orchestration flow",
          diffSummary: "2 files changed",
          diffPatch: "diff --git a/a.ts b/a.ts",
        });

        expect(generated.title).toBe("Improve orchestration flow");
        expect(generated.body.startsWith("## Summary")).toBe(true);
        expect(generated.body.endsWith("\n\n")).toBe(false);
      }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Please update session handling.",
        });

        expect(generated.branch).toBe("feat/session");
      }),
    ),
  );

  it.effect("generates compact thread titles from the first user message", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: ' "Polish sidebar loading state." ',
        }),
        stdinMustContain: "Never exceed 6 words.",
        requireSkipGitRepoCheck: true,
        requireApprovalNever: true,
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "The sidebar loading state feels noisy and needs polish.",
        });

        expect(generated.title).toBe("Polish sidebar loading state");
      }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Fix timeout behavior.",
        });

        expect(generated.branch).toBe("fix/session-timeout");
      }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-branch-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(Effect.ensuring(fs.remove(attachmentPath).pipe(Effect.catch(() => Effect.void))));

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(imagePath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(
            Effect.tap(() =>
              fs.stat(imagePath).pipe(
                Effect.map((fileInfo) => {
                  expect(fileInfo.type).toBe("File");
                }),
              ),
            ),
            Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
          );

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const missingAttachmentId = `thread-missing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
        yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: missingAttachmentId,
                name: "outside.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
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
          expect(result.left.message).toContain("missing --image input");
        }
      }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const result = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Fix websocket reconnect flake",
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
            expect(result.left.message).toContain("Codex returned invalid structured output");
          }
        }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const result = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-error",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
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
          expect(result.left.message).toContain("Codex CLI command failed: codex execution failed");
        }
      }),
    ),
  );

  it.effect("uses the provided codexHomePath and strips local skills config", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireCodexHome: true,
        requireAuthJson: true,
        codexHomeConfigMustContain: 'model_provider = "azure"',
        codexHomeConfigMustNotContain: "[[skills.config]]",
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const wrongCodexHome = yield* fs.makeTempDirectoryScoped({ prefix: "synara-wrong-codex-" });
        const customCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-custom-codex-",
        });
        const previousCodexHome = process.env.CODEX_HOME;
        const previousAzureApiKey = process.env.AZURE_OPENAI_API_KEY;

        yield* fs.writeFileString(
          path.join(customCodexHome, "config.toml"),
          [
            'model_provider = "azure"',
            "",
            "[model_providers.azure]",
            'env_key = "AZURE_OPENAI_API_KEY"',
            "",
            "[[skills.config]]",
            'path = "/broken/skill/SKILL.md"',
            "enabled = true",
            "",
            "[features]",
            "fast_mode = true",
            "",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(customCodexHome, "auth.json"),
          '{"access_token":"test"}',
        );
        yield* fs.writeFileString(path.join(wrongCodexHome, "config.toml"), 'model = "gpt-5.4"');

        yield* Effect.sync(() => {
          process.env.CODEX_HOME = wrongCodexHome;
          process.env.AZURE_OPENAI_API_KEY = "test-key";
        });

        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            codexHomePath: customCodexHome,
          })
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previousCodexHome === undefined) {
                  delete process.env.CODEX_HOME;
                } else {
                  process.env.CODEX_HOME = previousCodexHome;
                }

                if (previousAzureApiKey === undefined) {
                  delete process.env.AZURE_OPENAI_API_KEY;
                } else {
                  process.env.AZURE_OPENAI_API_KEY = previousAzureApiKey;
                }
              }),
            ),
          );

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );
});
