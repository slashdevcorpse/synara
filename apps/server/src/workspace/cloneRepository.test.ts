import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as EffectNodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as EffectNodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as EffectNodePath from "@effect/platform-node/NodePath";
import { ProjectId, WorkspaceCloneId } from "@synara/contracts";
import { Deferred, Effect, Exit, Fiber, Layer, Scope, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config";
import { GitCommandError } from "../git/Errors";
import { makeGitCore, splitCompleteProcessOutputFrames } from "../git/Layers/GitCore";
import type { GitCoreShape } from "../git/Services/GitCore";
import {
  makeWorkspaceCloneJobs,
  parseGitCloneProgressFrame,
  validateWorkspaceCloneTarget,
  validateWorkspaceCloneUrl,
  WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS,
  WORKSPACE_CLONE_MAX_ACTIVE_JOBS,
  WORKSPACE_CLONE_MAX_RETAINED_JOBS,
} from "./cloneRepository";

const tempDirs: string[] = [];
const CLONE_FAILURE_TRUNCATION_MARKER = "\n[... clone diagnostic truncated ...]\n";
const ASTRAL_BOUNDARY_CHARACTER = "\u{1f680}";

interface BoundaryDiagnostic {
  readonly value: string;
  readonly headBoundary: number;
  readonly tailBoundary: number;
  readonly headContext: string;
  readonly tailContext: string;
}

function makeBoundaryDiagnostic(label: string): BoundaryDiagnostic {
  const retainedChars =
    WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS - CLONE_FAILURE_TRUNCATION_MARKER.length;
  const headBoundary = Math.ceil(retainedChars / 2);
  const tailChars = retainedChars - headBoundary;
  const totalChars = WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS * 2;
  const tailBoundary = totalChars - tailChars;
  const headContext = `${label} diagnostic head`;
  const tailContext = `${label} fatal diagnostic tail`;
  const betweenBoundaries = tailBoundary - headBoundary - 2;
  const trailingPadding = totalChars - tailBoundary - 1 - tailContext.length;
  const value =
    headContext +
    "h".repeat(headBoundary - 1 - headContext.length) +
    ASTRAL_BOUNDARY_CHARACTER +
    "m".repeat(betweenBoundaries) +
    ASTRAL_BOUNDARY_CHARACTER +
    "t".repeat(trailingPadding) +
    tailContext;
  return { value, headBoundary, tailBoundary, headContext, tailContext };
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function makeTempDir(): Promise<string> {
  const value = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "synara-workspace-clone-"));
  const canonical = await NodeFs.realpath(value);
  tempDirs.push(canonical);
  return canonical;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for clone job state.");
}

async function closeScopeThenRelease(
  scope: Scope.Closeable,
  release: Deferred.Deferred<void>,
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const closeFiber = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closeFiber);
    }),
  );
}

interface CapturedGitCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly cwd?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly stdin?: unknown;
  };
}

interface CapturedCloneCommands {
  readonly resolution: CapturedGitCommand;
  readonly clone: CapturedGitCommand;
}

function cloneCommandError(
  cwd: string,
  detail = "network failed",
  command = "git clone",
): GitCommandError {
  return new GitCommandError({
    operation: "workspace clone",
    command,
    cwd,
    detail,
  });
}

function withResolvedCloneUrl(executeClone: GitCoreShape["execute"]): GitCoreShape["execute"] {
  return (input) =>
    input.operation === "WorkspaceCloneJobs.resolveRepositoryUrl"
      ? Effect.succeed({ code: 0, stdout: `${input.args.at(-1) ?? ""}\n`, stderr: "" })
      : executeClone(input);
}

function successfulChildProcessHandle(stdout = "") {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: stdout.length > 0 ? Stream.make(new TextEncoder().encode(stdout)) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

async function captureSpawnedCloneCommands(url: string): Promise<CapturedCloneCommands> {
  const parent = await makeTempDir();
  const targetPath = NodePath.join(parent, "repo");
  let capturedResolution: CapturedGitCommand | null = null;
  let capturedClone: CapturedGitCommand | null = null;
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die(new Error("Expected workspace clone to spawn one standard git command."));
    }
    const captured = {
      command: command.command,
      args: command.args,
      options: command.options,
    };
    if (command.args.includes("ls-remote") && command.args.includes("--get-url")) {
      capturedResolution = captured;
      return Effect.succeed(successfulChildProcessHandle(`${url}\n`));
    }
    capturedClone = captured;
    return Effect.succeed(successfulChildProcessHandle());
  });
  const processLayer = Layer.mergeAll(
    EffectNodeFileSystem.layer,
    EffectNodePath.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const configLayer = ServerConfig.layerTest(parent, {
    prefix: "synara-workspace-clone-spawn-test-",
  }).pipe(Layer.provide(processLayer));
  const git = await Effect.runPromise(
    makeGitCore().pipe(Effect.provide(Layer.merge(processLayer, configLayer))),
  );
  const jobs = makeWorkspaceCloneJobs({ git, homeDir: parent });
  const result = Array.from(
    await Effect.runPromise(
      Stream.runCollect(
        jobs.cloneRepository({
          cloneId: WorkspaceCloneId.makeUnsafe(
            `clone-spawn-${url.startsWith("https:") ? "https" : "ssh"}`,
          ),
          url,
          targetPath,
          createProject: false,
          createParentDirectories: true,
        }),
      ),
    ),
  ).at(-1);
  expect(result).toMatchObject({ result: { clonedPath: targetPath, failure: null } });
  if (!capturedResolution || !capturedClone) {
    throw new Error("Workspace clone did not spawn URL resolution and clone commands.");
  }
  return { resolution: capturedResolution, clone: capturedClone };
}

async function withTemporaryProcessEnvironment<A>(
  values: Readonly<Record<string, string>>,
  run: () => Promise<A>,
): Promise<A> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => NodeFs.rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace clone validation", () => {
  it("accepts only credential-free GitHub HTTPS and SSH forms", () => {
    expect(validateWorkspaceCloneUrl("https://github.com/example/repo.git")).toBe(
      "https://github.com/example/repo.git",
    );
    expect(validateWorkspaceCloneUrl("ssh://git@github.com/example/repo.git")).toBe(
      "ssh://git@github.com/example/repo.git",
    );
    expect(validateWorkspaceCloneUrl("ssh://git@github.com:22/example/repo.git")).toBe(
      "ssh://git@github.com:22/example/repo.git",
    );
    expect(validateWorkspaceCloneUrl("git@github.com:example/repo.git")).toBe(
      "git@github.com:example/repo.git",
    );

    for (const invalid of [
      "file:///tmp/repo",
      "ext::sh -c evil",
      "../repo",
      "https://token@github.com/example/repo.git",
      "https://github.com/example/repo.git?token=secret",
      "ssh://git@github.com:2222/example/repo.git",
      "--upload-pack=evil",
    ]) {
      expect(() => validateWorkspaceCloneUrl(invalid)).toThrow(/GitHub|supported|valid/);
    }
  });

  it("accepts only a missing target and rejects pre-existing empty or populated paths", async () => {
    const parent = await makeTempDir();
    await expect(
      validateWorkspaceCloneTarget({
        targetPath: NodePath.join(parent, "missing"),
        homeDir: parent,
      }),
    ).resolves.toMatchObject({ existed: false });

    const empty = NodePath.join(parent, "empty");
    await NodeFs.mkdir(empty);
    await expect(
      validateWorkspaceCloneTarget({ targetPath: empty, homeDir: parent }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CLONE_TARGET_EXISTS" });

    const populated = NodePath.join(parent, "populated");
    await NodeFs.mkdir(populated);
    await NodeFs.writeFile(NodePath.join(populated, "README.md"), "occupied");
    await expect(
      validateWorkspaceCloneTarget({ targetPath: populated, homeDir: parent }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CLONE_TARGET_EXISTS" });
  });

  it("rejects relative targets at the server boundary", async () => {
    const homeDir = await makeTempDir();
    await expect(
      validateWorkspaceCloneTarget({ targetPath: "relative/repo", homeDir }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CLONE_INVALID_TARGET" });
  });

  it("creates explicitly allowed missing parents and rejects them when disabled", async () => {
    const parent = await makeTempDir();
    const allowedTarget = NodePath.join(parent, "allowed", "nested", "repo");
    await expect(
      validateWorkspaceCloneTarget({
        targetPath: allowedTarget,
        homeDir: parent,
        createParentDirectories: true,
      }),
    ).resolves.toMatchObject({ targetPath: allowedTarget, existed: false });
    await expect(NodeFs.stat(NodePath.dirname(allowedTarget))).resolves.toBeDefined();

    const deniedTarget = NodePath.join(parent, "denied", "nested", "repo");
    await expect(
      validateWorkspaceCloneTarget({
        targetPath: deniedTarget,
        homeDir: parent,
        createParentDirectories: false,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CLONE_INVALID_TARGET" });
    await expect(NodeFs.stat(NodePath.dirname(deniedTarget))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("workspace clone progress", () => {
  it("parses CR/LF-fragmented clone output and maps phase progress monotonically", () => {
    const first = splitCompleteProcessOutputFrames(
      "remote: Counting objects: 50% (5/10)\rReceiving objects: 25% (25/100)\rResolving",
    );
    expect(first.frames).toEqual([
      "remote: Counting objects: 50% (5/10)",
      "Receiving objects: 25% (25/100)",
    ]);
    const second = splitCompleteProcessOutputFrames(
      `${first.remainder} deltas: 100% (2/2)\r\n`,
      true,
    );
    expect(second.frames).toEqual(["Resolving deltas: 100% (2/2)"]);

    const counting = parseGitCloneProgressFrame(first.frames[0]!);
    const receiving = parseGitCloneProgressFrame(first.frames[1]!);
    const resolving = parseGitCloneProgressFrame(second.frames[0]!);
    expect(counting).toMatchObject({ phase: "Counting objects", phasePercent: 50 });
    expect(receiving!.percent).toBeGreaterThan(counting!.percent);
    expect(resolving!.percent).toBeGreaterThan(receiving!.percent);
  });

  it("uses argv clone execution and retains a job-created failed target for safe cleanup", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "repo");
    const calls: Array<{ cwd: string; args: ReadonlyArray<string>; env?: NodeJS.ProcessEnv }> = [];
    const git: Pick<GitCoreShape, "execute"> = {
      execute: withResolvedCloneUrl((input) => {
        calls.push({
          cwd: input.cwd,
          args: input.args,
          ...(input.env === undefined ? {} : { env: input.env }),
        });
        const failure = Effect.fail(cloneCommandError(input.cwd));
        return input.progress?.onStderrLine
          ? input.progress
              .onStderrLine("Receiving objects: 50% (5/10)")
              .pipe(Effect.andThen(failure))
          : failure;
      }),
    };
    const jobs = makeWorkspaceCloneJobs({
      git,
      homeDir: parent,
      createProject: () => Effect.succeed(ProjectId.makeUnsafe("project-1")),
    });

    const events = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId: WorkspaceCloneId.makeUnsafe("clone-1"),
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: true,
            createParentDirectories: true,
          }),
        ),
      ),
    );

    expect(calls).toEqual([
      {
        cwd: parent,
        args: [
          "-c",
          "credential.interactive=false",
          "-c",
          "core.askPass=",
          "-c",
          "http.curloptResolve=",
          "-c",
          "http.sslVerify=true",
          "clone",
          "--progress",
          "--",
          "https://github.com/example/repo.git",
          targetPath,
        ],
        env: {
          GIT_ALLOW_PROTOCOL: "https",
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
        },
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      _tag: "clone_finished",
      result: {
        clonedPath: null,
        failure: {
          stage: "clone",
          retryable: false,
          message: expect.stringContaining(
            "Synara did not remove it because safe automatic cleanup cannot be guaranteed.",
          ),
        },
      },
    });
    expect(events.at(-1)?.snapshot.message).toContain("network failed");
    expect(events.at(-1)?.snapshot.message).not.toContain("[... clone diagnostic truncated ...]");
    expect(events.at(-1)?.snapshot.message.length).toBeLessThanOrEqual(
      WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS,
    );
    await expect(NodeFs.stat(targetPath)).resolves.toBeDefined();
    await expect(NodeFs.readdir(targetPath)).resolves.toEqual([]);
  });

  it("bounds and redacts large clone diagnostics in terminal and retained state", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "large-failure");
    const url = "https://github.com/example/private-repo.git";
    const headContext = `remote: starting fetch from ${url}`;
    const tailContext = `fatal: unable to access ${url}: connection reset by peer`;
    const hugeDetail =
      `${headContext}\n` +
      "x".repeat(WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS * 4) +
      `\n${tailContext}`;
    const git = {
      execute: withResolvedCloneUrl((input) =>
        Effect.fail(cloneCommandError(input.cwd, hugeDetail, `git clone ${url}`)),
      ),
    } as Pick<GitCoreShape, "execute">;
    const jobs = makeWorkspaceCloneJobs({ git, homeDir: parent });
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-large-failure");

    const events = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId,
            url,
            targetPath,
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    const terminal = events.at(-1);
    if (!terminal || terminal._tag !== "clone_finished" || !terminal.result.failure) {
      throw new Error("Expected clone failure terminal event.");
    }

    const failureMessage = terminal.result.failure.message;
    const retained = jobs.getStatus(cloneId);
    expect(failureMessage).toHaveLength(WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS);
    expect(failureMessage).toContain("[... clone diagnostic truncated ...]");
    expect(failureMessage).toContain(headContext.replaceAll(url, "[repository URL]"));
    expect(failureMessage).toContain(tailContext.replaceAll(url, "[repository URL]"));
    expect(failureMessage).toContain(`Partial clone data may remain at ${targetPath}.`);
    expect(failureMessage).toContain(
      "Synara did not remove it because safe automatic cleanup cannot be guaranteed.",
    );
    expect(failureMessage).not.toContain(url);
    expect(terminal.snapshot.message).toBe(failureMessage);
    expect(terminal.snapshot.result?.failure?.message).toBe(failureMessage);
    expect(retained?.message).toBe(failureMessage);
    expect(retained?.result?.failure?.message).toBe(failureMessage);
    expect(retained?.result).toEqual(terminal.result);
    await expect(NodeFs.stat(targetPath)).resolves.toBeDefined();
  });

  it("never mutates a target substituted after clone ownership was established", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "repo");
    const displacedOwnedPath = NodePath.join(parent, "owned-partial-clone");
    const git = {
      execute: withResolvedCloneUrl((input) =>
        Effect.promise(async () => {
          await NodeFs.writeFile(NodePath.join(targetPath, "partial.txt"), "owned partial clone");
          await NodeFs.rename(targetPath, displacedOwnedPath);
          await NodeFs.mkdir(targetPath);
          await NodeFs.writeFile(NodePath.join(targetPath, "foreign.txt"), "must survive");
        }).pipe(Effect.andThen(Effect.fail(cloneCommandError(input.cwd)))),
      ),
    } as Pick<GitCoreShape, "execute">;
    const jobs = makeWorkspaceCloneJobs({ git, homeDir: parent });

    const events = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId: WorkspaceCloneId.makeUnsafe("clone-replaced-target"),
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );

    expect(events.at(-1)).toMatchObject({
      result: {
        clonedPath: null,
        failure: {
          stage: "clone",
          retryable: false,
          message: expect.stringContaining(
            "Inspect or remove that destination manually before retrying.",
          ),
        },
      },
    });
    await expect(NodeFs.readFile(NodePath.join(targetPath, "foreign.txt"), "utf8")).resolves.toBe(
      "must survive",
    );
    await expect(
      NodeFs.readFile(NodePath.join(displacedOwnedPath, "partial.txt"), "utf8"),
    ).resolves.toBe("owned partial clone");
  });

  it("publishes retained-target guidance when shutdown overlaps mkdir completion", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "mkdir-interrupted");
    const mkdirCompleted = Deferred.makeUnsafe<void>();
    const releaseMkdirResult = Deferred.makeUnsafe<void>();
    const serverScope = await Effect.runPromise(Scope.make("sequential"));
    let cloneCalls = 0;
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: withResolvedCloneUrl(() => {
          cloneCalls += 1;
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        }),
      } as Pick<GitCoreShape, "execute">,
      homeDir: parent,
      targetDirectoryFileSystem: {
        mkdir: async (path) => {
          await NodeFs.mkdir(path);
          await Effect.runPromise(Deferred.succeed(mkdirCompleted, undefined));
          await Effect.runPromise(Deferred.await(releaseMkdirResult));
        },
      },
      startBackground: (effect) => effect.pipe(Effect.forkIn(serverScope), Effect.asVoid),
    });
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-mkdir-interrupted");

    try {
      const interruptedClone = Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId,
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      );
      await Effect.runPromise(Deferred.await(mkdirCompleted));
      await closeScopeThenRelease(serverScope, releaseMkdirResult);

      const interruptedEvents = Array.from(await interruptedClone);
      expect(interruptedEvents.at(-1)).toMatchObject({
        _tag: "clone_finished",
        result: {
          clonedPath: null,
          failure: {
            stage: "clone",
            code: "WORKSPACE_CLONE_CANCELLED",
            retryable: false,
            message: expect.stringContaining(`Partial clone data may remain at ${targetPath}.`),
          },
        },
      });
      expect(cloneCalls).toBe(0);
      await expect(NodeFs.stat(targetPath)).resolves.toBeDefined();
    } finally {
      await Effect.runPromise(Scope.close(serverScope, Exit.void));
    }
  });

  it("retains a successful clone when project creation fails and retries without cloning", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "repo");
    let cloneCalls = 0;
    let projectCalls = 0;
    const git = {
      execute: withResolvedCloneUrl((input) => {
        cloneCalls += 1;
        return (input.progress?.onStderrLine?.("Updating files: 100% (1/1)") ?? Effect.void).pipe(
          Effect.andThen(Effect.succeed({ code: 0, stdout: "", stderr: "" })),
        );
      }),
    } as Pick<GitCoreShape, "execute">;
    const jobs = makeWorkspaceCloneJobs({
      git,
      homeDir: parent,
      createProject: () => {
        projectCalls += 1;
        return projectCalls === 1
          ? Effect.fail(new Error("projection unavailable"))
          : Effect.succeed(ProjectId.makeUnsafe("project-1"));
      },
    });
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-project-retry");

    const first = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId,
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: true,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    expect(first.at(-1)).toMatchObject({
      result: {
        clonedPath: targetPath,
        failure: { stage: "project", message: "projection unavailable" },
      },
    });
    expect(first.map((event) => event.snapshot.percent)).toEqual([0, 100, 100, 100]);
    await expect(NodeFs.stat(targetPath)).resolves.toBeDefined();

    const retried = Array.from(
      await Effect.runPromise(Stream.runCollect(jobs.retryProjectCreation(cloneId))),
    );
    expect(retried.at(-1)).toMatchObject({
      result: { clonedPath: targetPath, projectId: "project-1", failure: null },
    });
    expect(retried.map((event) => event.snapshot.percent)).toEqual([100, 100]);
    expect(cloneCalls).toBe(1);
    expect(projectCalls).toBe(2);
  });

  it("bounds Unicode-safe project creation and retry diagnostics", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "project-failure-boundaries");
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-project-failure-boundaries");
    const diagnostics = [makeBoundaryDiagnostic("initial"), makeBoundaryDiagnostic("retry")];
    let projectCalls = 0;
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: withResolvedCloneUrl(() => Effect.succeed({ code: 0, stdout: "", stderr: "" })),
      } as Pick<GitCoreShape, "execute">,
      homeDir: parent,
      createProject: () => {
        const diagnostic = diagnostics[projectCalls];
        projectCalls += 1;
        return Effect.fail(new Error(diagnostic?.value ?? "unexpected project creation call"));
      },
    });

    const initialEvents = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId,
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: true,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    const initialRetained = jobs.getStatus(cloneId);
    const retryEvents = Array.from(
      await Effect.runPromise(Stream.runCollect(jobs.retryProjectCreation(cloneId))),
    );
    const retryRetained = jobs.getStatus(cloneId);

    const outcomes = [
      { events: initialEvents, retained: initialRetained, diagnostic: diagnostics[0]! },
      { events: retryEvents, retained: retryRetained, diagnostic: diagnostics[1]! },
    ];
    for (const { events, retained, diagnostic } of outcomes) {
      expect(diagnostic.value).toHaveLength(WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS * 2);
      expect([
        diagnostic.value.charCodeAt(diagnostic.headBoundary - 1),
        diagnostic.value.charCodeAt(diagnostic.headBoundary),
        diagnostic.value.charCodeAt(diagnostic.tailBoundary - 1),
        diagnostic.value.charCodeAt(diagnostic.tailBoundary),
      ]).toEqual([0xd83d, 0xde80, 0xd83d, 0xde80]);

      const terminal = events.at(-1);
      if (!terminal || terminal._tag !== "clone_finished" || !terminal.result.failure) {
        throw new Error("Expected project failure terminal event.");
      }
      const failureMessage = terminal.result.failure.message;
      expect(terminal.result.failure.stage).toBe("project");
      expect(failureMessage).toHaveLength(WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS - 2);
      expect(failureMessage).toContain(CLONE_FAILURE_TRUNCATION_MARKER);
      expect(failureMessage).toContain(diagnostic.headContext);
      expect(failureMessage).toContain(diagnostic.tailContext);
      expect(failureMessage).not.toContain(ASTRAL_BOUNDARY_CHARACTER);
      expect(failureMessage).not.toContain("\uFFFD");
      expect(hasLoneSurrogate(failureMessage)).toBe(false);
      expect(new TextDecoder().decode(new TextEncoder().encode(failureMessage))).toBe(
        failureMessage,
      );
      expect(terminal.snapshot.message).toBe(failureMessage);
      expect(terminal.snapshot.result?.failure?.message).toBe(failureMessage);
      expect(retained?.message).toBe(failureMessage);
      expect(retained?.result?.failure?.message).toBe(failureMessage);
      expect(retained?.result).toEqual(terminal.result);
    }
    expect(projectCalls).toBe(2);
  });

  it("retains a clone and permits project retry when initial project creation is interrupted", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "repo");
    const firstBackgroundScope = await Effect.runPromise(Scope.make("sequential"));
    const secondBackgroundScope = await Effect.runPromise(Scope.make("sequential"));
    let backgroundScope = firstBackgroundScope;
    let cloneCalls = 0;
    let projectCalls = 0;
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: withResolvedCloneUrl(() => {
          cloneCalls += 1;
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        }),
      } as Pick<GitCoreShape, "execute">,
      homeDir: parent,
      createProject: () => {
        projectCalls += 1;
        return projectCalls === 1
          ? Effect.never
          : Effect.succeed(ProjectId.makeUnsafe("project-after-initial-interruption"));
      },
      startBackground: (effect) => effect.pipe(Effect.forkIn(backgroundScope), Effect.asVoid),
    });
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-project-initial-interrupted");

    try {
      const interruptedClone = Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId,
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: true,
            createParentDirectories: true,
          }),
        ),
      );
      await waitFor(
        () =>
          projectCalls === 1 &&
          jobs.getStatus(cloneId)?.status === "running" &&
          jobs.getStatus(cloneId)?.stage === "creating-project",
      );
      await Effect.runPromise(Scope.close(firstBackgroundScope, Exit.void));

      const interruptedEvents = Array.from(await interruptedClone);
      expect(interruptedEvents.at(-1)).toMatchObject({
        _tag: "clone_finished",
        snapshot: { status: "failed", stage: "complete" },
        result: {
          clonedPath: targetPath,
          projectId: null,
          failure: {
            stage: "project",
            code: "WORKSPACE_CLONE_PROJECT_CREATE_CANCELLED",
            retryable: true,
          },
        },
      });
      await expect(NodeFs.stat(targetPath)).resolves.toBeDefined();

      backgroundScope = secondBackgroundScope;
      const retriedEvents = Array.from(
        await Effect.runPromise(Stream.runCollect(jobs.retryProjectCreation(cloneId))),
      );
      expect(retriedEvents.at(-1)).toMatchObject({
        _tag: "clone_finished",
        result: {
          clonedPath: targetPath,
          projectId: "project-after-initial-interruption",
          failure: null,
        },
      });
      expect(cloneCalls).toBe(1);
      expect(projectCalls).toBe(2);
    } finally {
      await Effect.runPromise(Scope.close(firstBackgroundScope, Exit.void));
      await Effect.runPromise(Scope.close(secondBackgroundScope, Exit.void));
    }
  });

  it("preserves selected terminal outcomes when shutdown overlaps publication", async () => {
    const scenarios = [
      {
        name: "clone-only",
        createProject: false,
        projectEffect: Effect.succeed(ProjectId.makeUnsafe("unused-clone-only-project")),
        expectedStatus: "succeeded",
        projectId: null,
        failure: null,
      },
      {
        name: "with-project",
        createProject: true,
        projectEffect: Effect.succeed(ProjectId.makeUnsafe("project-terminal-publication")),
        expectedStatus: "succeeded",
        projectId: ProjectId.makeUnsafe("project-terminal-publication"),
        failure: null,
      },
      {
        name: "project-failure",
        createProject: true,
        projectEffect: Effect.fail(new Error("terminal project creation failed")),
        expectedStatus: "failed",
        projectId: null,
        failure: {
          stage: "project",
          code: "WORKSPACE_CLONE_PROJECT_CREATE_FAILED",
          message: "terminal project creation failed",
          retryable: true,
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const parent = await makeTempDir();
      const targetPath = NodePath.join(parent, scenario.name);
      const terminalPublishEntered = Deferred.makeUnsafe<void>();
      const releaseTerminalPublish = Deferred.makeUnsafe<void>();
      const serverScope = await Effect.runPromise(Scope.make("sequential"));
      let terminalPublishCalls = 0;
      const jobs = makeWorkspaceCloneJobs({
        git: {
          execute: withResolvedCloneUrl(() => Effect.succeed({ code: 0, stdout: "", stderr: "" })),
        } as Pick<GitCoreShape, "execute">,
        homeDir: parent,
        createProject: () => scenario.projectEffect,
        beforeTerminalPublish: () => {
          terminalPublishCalls += 1;
          if (terminalPublishCalls !== 1) return Effect.void;
          return Deferred.succeed(terminalPublishEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseTerminalPublish)),
          );
        },
        startBackground: (effect) => effect.pipe(Effect.forkIn(serverScope), Effect.asVoid),
      });
      const cloneId = WorkspaceCloneId.makeUnsafe(`clone-terminal-${scenario.name}`);

      try {
        const interruptedClone = Effect.runPromise(
          Stream.runCollect(
            jobs.cloneRepository({
              cloneId,
              url: "https://github.com/example/repo.git",
              targetPath,
              createProject: scenario.createProject,
              createParentDirectories: true,
            }),
          ),
        );
        await Effect.runPromise(Deferred.await(terminalPublishEntered));
        await closeScopeThenRelease(serverScope, releaseTerminalPublish);

        const events = Array.from(await interruptedClone);
        expect(events.at(-1)).toMatchObject({
          _tag: "clone_finished",
          snapshot: { status: scenario.expectedStatus, stage: "complete" },
          result: {
            clonedPath: targetPath,
            projectId: scenario.projectId,
            failure: scenario.failure,
          },
        });
        expect(jobs.getStatus(cloneId)).toMatchObject({
          status: scenario.expectedStatus,
          result: {
            clonedPath: targetPath,
            projectId: scenario.projectId,
            failure: scenario.failure,
          },
        });
        expect(terminalPublishCalls).toBe(1);
      } finally {
        await Effect.runPromise(Scope.close(serverScope, Exit.void));
      }
    }
  });

  it("preserves retry success when shutdown overlaps terminal publication", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "retry-terminal-publication");
    const retryProjectId = ProjectId.makeUnsafe("project-retry-terminal-publication");
    const retryPublishEntered = Deferred.makeUnsafe<void>();
    const releaseRetryPublish = Deferred.makeUnsafe<void>();
    const serverScope = await Effect.runPromise(Scope.make("sequential"));
    let projectCalls = 0;
    let retryPublishCalls = 0;
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: withResolvedCloneUrl(() => Effect.succeed({ code: 0, stdout: "", stderr: "" })),
      } as Pick<GitCoreShape, "execute">,
      homeDir: parent,
      createProject: () => {
        projectCalls += 1;
        return projectCalls === 1
          ? Effect.fail(new Error("initial project creation failed"))
          : Effect.succeed(retryProjectId);
      },
      beforeTerminalPublish: ({ result }) => {
        if (result.projectId !== retryProjectId) return Effect.void;
        retryPublishCalls += 1;
        if (retryPublishCalls !== 1) return Effect.void;
        return Deferred.succeed(retryPublishEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRetryPublish)),
        );
      },
      startBackground: (effect) => effect.pipe(Effect.forkIn(serverScope), Effect.asVoid),
    });
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-retry-terminal-publication");

    try {
      const initialEvents = Array.from(
        await Effect.runPromise(
          Stream.runCollect(
            jobs.cloneRepository({
              cloneId,
              url: "https://github.com/example/repo.git",
              targetPath,
              createProject: true,
              createParentDirectories: true,
            }),
          ),
        ),
      );
      expect(initialEvents.at(-1)).toMatchObject({
        result: {
          clonedPath: targetPath,
          projectId: null,
          failure: {
            stage: "project",
            code: "WORKSPACE_CLONE_PROJECT_CREATE_FAILED",
          },
        },
      });

      const interruptedRetry = Effect.runPromise(
        Stream.runCollect(jobs.retryProjectCreation(cloneId)),
      );
      await Effect.runPromise(Deferred.await(retryPublishEntered));
      await closeScopeThenRelease(serverScope, releaseRetryPublish);

      const retryEvents = Array.from(await interruptedRetry);
      expect(retryEvents.at(-1)).toMatchObject({
        _tag: "clone_finished",
        snapshot: { status: "succeeded", stage: "complete" },
        result: {
          clonedPath: targetPath,
          projectId: retryProjectId,
          failure: null,
        },
      });
      expect(jobs.getStatus(cloneId)).toMatchObject({
        status: "succeeded",
        result: {
          clonedPath: targetPath,
          projectId: retryProjectId,
          failure: null,
        },
      });
      expect(projectCalls).toBe(2);
      expect(retryPublishCalls).toBe(1);
    } finally {
      await Effect.runPromise(Scope.close(serverScope, Exit.void));
    }
  });

  it("ends retry subscribers and restores retryability when background project creation stops", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "repo");
    const firstBackgroundScope = await Effect.runPromise(Scope.make("sequential"));
    const secondBackgroundScope = await Effect.runPromise(Scope.make("sequential"));
    let backgroundScope = firstBackgroundScope;
    let projectCalls = 0;
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: withResolvedCloneUrl(() => Effect.succeed({ code: 0, stdout: "", stderr: "" })),
      } as Pick<GitCoreShape, "execute">,
      homeDir: parent,
      createProject: () => {
        projectCalls += 1;
        if (projectCalls === 1) return Effect.fail(new Error("projection unavailable"));
        if (projectCalls === 2) return Effect.never;
        return Effect.succeed(ProjectId.makeUnsafe("project-after-interruption"));
      },
      startBackground: (effect) => effect.pipe(Effect.forkIn(backgroundScope), Effect.asVoid),
    });
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-project-retry-interrupted");

    try {
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId,
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: true,
            createParentDirectories: true,
          }),
        ),
      );
      const originalFailure = jobs.getStatus(cloneId)?.result;
      expect(originalFailure).toMatchObject({
        clonedPath: targetPath,
        failure: { stage: "project", code: "WORKSPACE_CLONE_PROJECT_CREATE_FAILED" },
      });

      const interruptedRetry = Effect.runPromise(
        Stream.runCollect(jobs.retryProjectCreation(cloneId)),
      );
      await waitFor(
        () =>
          projectCalls === 2 &&
          jobs.getStatus(cloneId)?.status === "running" &&
          jobs.getStatus(cloneId)?.stage === "creating-project",
      );
      await Effect.runPromise(Scope.close(firstBackgroundScope, Exit.void));

      const interruptedEvents = Array.from(await interruptedRetry);
      expect(interruptedEvents.at(-1)).toMatchObject({
        _tag: "clone_finished",
        snapshot: { status: "failed", stage: "complete" },
        result: originalFailure,
      });
      expect(jobs.getStatus(cloneId)).toMatchObject({
        status: "failed",
        stage: "complete",
        result: originalFailure,
      });

      backgroundScope = secondBackgroundScope;
      const retriedEvents = Array.from(
        await Effect.runPromise(Stream.runCollect(jobs.retryProjectCreation(cloneId))),
      );
      expect(retriedEvents.at(-1)).toMatchObject({
        _tag: "clone_finished",
        result: {
          clonedPath: targetPath,
          projectId: "project-after-interruption",
          failure: null,
        },
      });
      expect(projectCalls).toBe(3);
    } finally {
      await Effect.runPromise(Scope.close(firstBackgroundScope, Exit.void));
      await Effect.runPromise(Scope.close(secondBackgroundScope, Exit.void));
    }
  });

  it("serializes clones targeting the same canonical path", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "shared-target");
    let signalStarted!: () => void;
    let failFirstClone!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const blockedClone = new Promise<never>((_resolve, reject) => {
      failFirstClone = () => reject(new Error("release first clone"));
    });
    const git = {
      execute: withResolvedCloneUrl(() => {
        signalStarted();
        return Effect.tryPromise(() => blockedClone);
      }),
    } as Pick<GitCoreShape, "execute">;
    const jobs = makeWorkspaceCloneJobs({
      git,
      homeDir: parent,
      createProject: () => Effect.succeed(ProjectId.makeUnsafe("project-1")),
    });
    const firstPromise = Effect.runPromise(
      Stream.runCollect(
        jobs.cloneRepository({
          cloneId: WorkspaceCloneId.makeUnsafe("clone-target-first"),
          url: "https://github.com/example/repo.git",
          targetPath,
          createProject: false,
          createParentDirectories: true,
        }),
      ),
    );
    await started;

    const second = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId: WorkspaceCloneId.makeUnsafe("clone-target-second"),
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    expect(second.at(-1)).toMatchObject({
      _tag: "clone_finished",
      result: { failure: { code: "WORKSPACE_CLONE_TARGET_IN_USE", retryable: false } },
    });

    failFirstClone();
    await firstPromise;
  });

  it("keeps cloning after subscriber interruption and exposes terminal state on reconnect", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "background-clone");
    let releaseClone!: () => void;
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: withResolvedCloneUrl(() =>
          Effect.tryPromise(async () => {
            await cloneGate;
            return { code: 0, stdout: "", stderr: "" };
          }),
        ),
      } as Pick<GitCoreShape, "execute">,
      homeDir: parent,
      createProject: () => Effect.succeed(ProjectId.makeUnsafe("project-1")),
    });
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-background");
    const firstSubscriber = Array.from(
      await Effect.runPromise(
        jobs
          .cloneRepository({
            cloneId,
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: false,
            createParentDirectories: true,
          })
          .pipe(Stream.take(1), Stream.runCollect),
      ),
    );
    expect(firstSubscriber).toHaveLength(1);
    expect(jobs.getStatus(cloneId)).toMatchObject({ status: "running", stage: "cloning" });

    const competing = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId: WorkspaceCloneId.makeUnsafe("clone-background-competing"),
            url: "https://github.com/example/other.git",
            targetPath,
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    expect(competing.at(-1)).toMatchObject({
      result: { failure: { code: "WORKSPACE_CLONE_TARGET_IN_USE" } },
    });

    const duplicate = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId,
            url: "https://github.com/example/different.git",
            targetPath: NodePath.join(parent, "different-target"),
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    expect(duplicate.at(-1)).toMatchObject({
      result: { failure: { code: "WORKSPACE_CLONE_ID_IN_USE" } },
    });
    expect(jobs.getStatus(cloneId)).toMatchObject({ status: "running", stage: "cloning" });

    releaseClone();
    await waitFor(() => jobs.getStatus(cloneId)?.status === "succeeded");
    expect(jobs.getStatus(cloneId)).toMatchObject({
      status: "succeeded",
      result: { clonedPath: targetPath, failure: null },
    });
    await expect(NodeFs.stat(targetPath)).resolves.toBeDefined();
  });

  it("holds global clone capacity after subscribers disconnect and releases it on completion", async () => {
    const parent = await makeTempDir();
    let releaseClones!: () => void;
    const cloneGate = new Promise<void>((resolve) => {
      releaseClones = resolve;
    });
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: withResolvedCloneUrl(() =>
          Effect.tryPromise(async () => {
            await cloneGate;
            return { code: 0, stdout: "", stderr: "" };
          }),
        ),
      } as Pick<GitCoreShape, "execute">,
      homeDir: parent,
    });
    const activeCloneIds: WorkspaceCloneId[] = [];

    for (let index = 0; index < WORKSPACE_CLONE_MAX_ACTIVE_JOBS; index += 1) {
      const cloneId = WorkspaceCloneId.makeUnsafe(`clone-capacity-active-${index}`);
      activeCloneIds.push(cloneId);
      const firstEvent = Array.from(
        await Effect.runPromise(
          jobs
            .cloneRepository({
              cloneId,
              url: "https://github.com/example/repo.git",
              targetPath: NodePath.join(parent, `capacity-active-${index}`),
              createProject: false,
              createParentDirectories: true,
            })
            .pipe(Stream.take(1), Stream.runCollect),
        ),
      );
      expect(firstEvent[0]?._tag).toBe("clone_started");
    }

    const rejectedCloneId = WorkspaceCloneId.makeUnsafe("clone-capacity-rejected");
    const rejected = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId: rejectedCloneId,
            url: "https://github.com/example/repo.git",
            targetPath: NodePath.join(parent, "capacity-rejected"),
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    expect(rejected.at(-1)).toMatchObject({
      _tag: "clone_finished",
      result: {
        failure: { code: "WORKSPACE_CLONE_CAPACITY_EXCEEDED", retryable: true },
      },
    });
    expect(jobs.getStatus(rejectedCloneId)).toBeNull();

    releaseClones();
    await Promise.all(
      activeCloneIds.map((cloneId) =>
        waitFor(() => jobs.getStatus(cloneId)?.status === "succeeded"),
      ),
    );

    const afterCapacity = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId: rejectedCloneId,
            url: "https://github.com/example/repo.git",
            targetPath: NodePath.join(parent, "capacity-rejected"),
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    expect(afterCapacity.at(-1)).toMatchObject({
      result: { failure: null },
    });
    expect(jobs.getStatus(rejectedCloneId)).toMatchObject({
      status: "succeeded",
      result: { failure: null },
    });
  });

  it("interrupts background git work and retains its target on server-scope shutdown", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "shutdown-clone");
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-server-shutdown");
    let jobs!: ReturnType<typeof makeWorkspaceCloneJobs>;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const serverScope = yield* Scope.make("sequential");
          yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
          jobs = makeWorkspaceCloneJobs({
            git: {
              execute: withResolvedCloneUrl(() => Effect.never),
            } as Pick<GitCoreShape, "execute">,
            homeDir: parent,
            createProject: () => Effect.succeed(ProjectId.makeUnsafe("project-1")),
            startBackground: (effect) => effect.pipe(Effect.forkIn(serverScope), Effect.asVoid),
          });

          yield* jobs
            .cloneRepository({
              cloneId,
              url: "https://github.com/example/repo.git",
              targetPath,
              createProject: false,
              createParentDirectories: true,
            })
            .pipe(Stream.take(1), Stream.runCollect);
          expect(jobs.getStatus(cloneId)).toMatchObject({ status: "running" });
          expect(yield* Effect.promise(() => NodeFs.stat(targetPath))).toBeDefined();
        }),
      ),
    );

    await expect(NodeFs.stat(targetPath)).resolves.toBeDefined();
    expect(jobs.getStatus(cloneId)).toMatchObject({
      status: "failed",
      result: {
        failure: {
          code: "WORKSPACE_CLONE_CANCELLED",
          retryable: false,
          message: expect.stringContaining(
            "Inspect or remove that destination manually before retrying.",
          ),
        },
      },
    });
  });

  it("never evicts active jobs when the completed-job retention bound is exceeded", async () => {
    const parent = await makeTempDir();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const serverScope = yield* Scope.make("sequential");
          yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
          const jobs = makeWorkspaceCloneJobs({
            git: {
              execute: withResolvedCloneUrl((command) =>
                command.args.at(-1) === NodePath.join(parent, "active-0")
                  ? Effect.never
                  : Effect.succeed({ code: 0, stdout: "", stderr: "" }),
              ),
            } as Pick<GitCoreShape, "execute">,
            homeDir: parent,
            startBackground: (effect) => effect.pipe(Effect.forkIn(serverScope), Effect.asVoid),
          });
          const firstCloneId = WorkspaceCloneId.makeUnsafe("clone-retained-active-0");

          yield* jobs
            .cloneRepository({
              cloneId: firstCloneId,
              url: "https://github.com/example/repo.git",
              targetPath: NodePath.join(parent, "active-0"),
              createProject: false,
              createParentDirectories: true,
            })
            .pipe(Stream.take(1), Stream.runDrain);

          for (let index = 1; index <= WORKSPACE_CLONE_MAX_RETAINED_JOBS; index += 1) {
            yield* jobs
              .cloneRepository({
                cloneId: WorkspaceCloneId.makeUnsafe(`clone-retained-completed-${index}`),
                url: "https://github.com/example/repo.git",
                targetPath: NodePath.join(parent, `completed-${index}`),
                createProject: false,
                createParentDirectories: true,
              })
              .pipe(Stream.runDrain);
          }

          expect(jobs.getStatus(firstCloneId)).toMatchObject({
            status: "running",
            stage: "cloning",
          });
        }),
      ),
    );
  }, 20_000);

  it("preserves the original job snapshot when a clone id is reused", async () => {
    const parent = await makeTempDir();
    const originalTarget = NodePath.join(parent, "original");
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-id-single-use");
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: withResolvedCloneUrl(() => Effect.succeed({ code: 0, stdout: "", stderr: "" })),
      } as Pick<GitCoreShape, "execute">,
      homeDir: parent,
      createProject: () => Effect.succeed(ProjectId.makeUnsafe("project-1")),
    });

    const original = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId,
            url: "https://github.com/example/repo.git",
            targetPath: originalTarget,
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    const originalSnapshot = jobs.getStatus(cloneId);
    expect(original.at(-1)).toMatchObject({
      result: { clonedPath: originalTarget, failure: null },
    });

    const duplicate = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId,
            url: "https://github.com/example/other.git",
            targetPath: NodePath.join(parent, "other"),
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );
    expect(duplicate.at(-1)).toMatchObject({
      result: { failure: { code: "WORKSPACE_CLONE_ID_IN_USE", retryable: false } },
    });
    expect(jobs.getStatus(cloneId)).toEqual(originalSnapshot);
  });

  it("rejects and never removes a pre-existing empty target", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "pre-existing");
    await NodeFs.mkdir(targetPath);
    let gitCalls = 0;
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: (input) => {
          gitCalls += 1;
          return Effect.fail(cloneCommandError(input.cwd));
        },
      },
      homeDir: parent,
      createProject: () => Effect.succeed(ProjectId.makeUnsafe("project-1")),
    });

    const events = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId: WorkspaceCloneId.makeUnsafe("clone-existing-empty"),
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: true,
            createParentDirectories: true,
          }),
        ),
      ),
    );

    expect(events.at(-1)).toMatchObject({
      result: { failure: { stage: "clone", code: "WORKSPACE_CLONE_TARGET_EXISTS" } },
    });
    expect(gitCalls).toBe(0);
    await expect(NodeFs.stat(targetPath)).resolves.toBeDefined();
    await expect(NodeFs.readdir(targetPath)).resolves.toEqual([]);
  });
});

describe("workspace clone process hardening", () => {
  const inheritedPromptEnvironment = {
    DISPLAY: ":99",
    GIT_ASKPASS: "inherited-git-askpass",
    GIT_ALLOW_PROTOCOL: "file:ssh",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: "inherited-global-config",
    GIT_CONFIG_KEY_0: "url.file:///attacker/.insteadOf",
    GIT_CONFIG_SYSTEM: "inherited-system-config",
    GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_EXEC_PATH: "inherited-git-exec-path",
    GIT_SSH: "inherited-ssh-wrapper",
    GIT_SSH_COMMAND: "inherited ssh command",
    GIT_SSH_VARIANT: "plink",
    SSH_AGENT_PID: "1234",
    SSH_AUTH_SOCK: "/tmp/synara-test-agent.sock",
    SSH_ASKPASS: "inherited-ssh-askpass",
    SSH_ASKPASS_REQUIRE: "force",
    SSH_SK_PROVIDER: "inherited-security-key-provider",
    GCM_CREDENTIAL_STORE: "inherited-credential-store",
    HTTPS_PROXY: "http://proxy.example:8080",
    SYNARA_CLONE_TEST_INHERITED: "retained",
    WAYLAND_DISPLAY: "wayland-99",
  } as const;

  function expectHardenedSpawnEnvironment(command: CapturedGitCommand, url: string): void {
    expect(command.command).toBe("git");
    expect(command.options.stdin).toBe("ignore");
    expect(command.options.env).toMatchObject({
      GCM_INTERACTIVE: "Never",
      GCM_CREDENTIAL_STORE: "inherited-credential-store",
      GIT_ALLOW_PROTOCOL: url.startsWith("https:") ? "https" : "ssh",
      GIT_TERMINAL_PROMPT: "0",
      HTTPS_PROXY: "http://proxy.example:8080",
      SSH_AGENT_PID: "1234",
      SSH_AUTH_SOCK: "/tmp/synara-test-agent.sock",
      SYNARA_CLONE_TEST_INHERITED: "retained",
    });
    for (const key of [
      "DISPLAY",
      "GIT_ASKPASS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_VALUE_0",
      "GIT_EXEC_PATH",
      "GIT_SSH",
      "GIT_SSH_VARIANT",
      "SSH_ASKPASS",
      "SSH_ASKPASS_REQUIRE",
      "SSH_SK_PROVIDER",
      "WAYLAND_DISPLAY",
    ]) {
      expect(command.options.env).not.toHaveProperty(key);
    }
  }

  function expectResolutionSpawn(command: CapturedGitCommand, url: string): void {
    expect(command.args).toEqual([
      "-c",
      "credential.interactive=false",
      "-c",
      "core.askPass=",
      ...(url.startsWith("https:")
        ? ["-c", "http.curloptResolve=", "-c", "http.sslVerify=true"]
        : []),
      "ls-remote",
      "--get-url",
      "--",
      url,
    ]);
    expectHardenedSpawnEnvironment(command, url);
  }

  function expectCloneSpawn(command: CapturedGitCommand, url: string): void {
    expect(command.args).toEqual([
      "-c",
      "credential.interactive=false",
      "-c",
      "core.askPass=",
      ...(url.startsWith("https:")
        ? ["-c", "http.curloptResolve=", "-c", "http.sslVerify=true"]
        : []),
      "clone",
      "--progress",
      "--",
      url,
      expect.stringMatching(/[\\/]repo$/),
    ]);
    expectHardenedSpawnEnvironment(command, url);
  }

  it("rejects an effective Git config URL rewrite before cloning", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "repo");
    let cloneCalls = 0;
    const jobs = makeWorkspaceCloneJobs({
      git: {
        execute: (input) => {
          if (input.operation === "WorkspaceCloneJobs.resolveRepositoryUrl") {
            return Effect.succeed({
              code: 0,
              stdout: "ssh://git@attacker.example/example/repo.git\n",
              stderr: "",
            });
          }
          cloneCalls += 1;
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        },
      },
      homeDir: parent,
    });

    const events = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          jobs.cloneRepository({
            cloneId: WorkspaceCloneId.makeUnsafe("clone-rewritten-url"),
            url: "https://github.com/example/repo.git",
            targetPath,
            createProject: false,
            createParentDirectories: true,
          }),
        ),
      ),
    );

    expect(events.at(-1)).toMatchObject({
      _tag: "clone_finished",
      result: {
        clonedPath: null,
        failure: {
          code: "WORKSPACE_CLONE_URL_REWRITE_BLOCKED",
          retryable: false,
        },
      },
    });
    expect(cloneCalls).toBe(0);
    await expect(NodeFs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a URL rewrite loaded by GitCore from the user config file", async () => {
    const parent = await makeTempDir();
    const gitHome = await makeTempDir();
    const targetPath = NodePath.join(parent, "repo");
    await NodeFs.writeFile(
      NodePath.join(gitHome, ".gitconfig"),
      '[url "ssh://git@attacker.example/"]\n\tinsteadOf = https://github.com/\n',
      "utf8",
    );

    await withTemporaryProcessEnvironment(
      {
        HOME: gitHome,
        XDG_CONFIG_HOME: NodePath.join(gitHome, ".config"),
      },
      async () => {
        const fileSystemAndPathLayer = Layer.merge(
          EffectNodeFileSystem.layer,
          EffectNodePath.layer,
        );
        const processLayer = Layer.merge(
          fileSystemAndPathLayer,
          EffectNodeChildProcessSpawner.layer.pipe(Layer.provide(fileSystemAndPathLayer)),
        );
        const configLayer = ServerConfig.layerTest(parent, {
          prefix: "synara-workspace-clone-global-config-test-",
        }).pipe(Layer.provide(processLayer));
        const git = await Effect.runPromise(
          makeGitCore().pipe(Effect.provide(Layer.merge(processLayer, configLayer))),
        );
        const jobs = makeWorkspaceCloneJobs({ git, homeDir: parent });
        const events = Array.from(
          await Effect.runPromise(
            Stream.runCollect(
              jobs.cloneRepository({
                cloneId: WorkspaceCloneId.makeUnsafe("clone-global-config-rewrite"),
                url: "https://github.com/example/repo.git",
                targetPath,
                createProject: false,
                createParentDirectories: true,
              }),
            ),
          ),
        );

        expect(events.at(-1)).toMatchObject({
          result: {
            clonedPath: null,
            failure: { code: "WORKSPACE_CLONE_URL_REWRITE_BLOCKED", retryable: false },
          },
        });
        await expect(NodeFs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it("spawns HTTPS resolution and clone with inherited Git and SSH controls neutralized", async () => {
    const url = "https://github.com/example/repo.git";
    await withTemporaryProcessEnvironment(inheritedPromptEnvironment, async () => {
      const commands = await captureSpawnedCloneCommands(url);
      expectResolutionSpawn(commands.resolution, url);
      expectCloneSpawn(commands.clone, url);
      expect(commands.resolution.options.env).not.toHaveProperty("GIT_SSH_COMMAND");
      expect(commands.clone.options.env).not.toHaveProperty("GIT_SSH_COMMAND");
    });
  });

  it("spawns accepted SSH forms with config-free batch-mode OpenSSH and agent auth", async () => {
    await withTemporaryProcessEnvironment(inheritedPromptEnvironment, async () => {
      for (const url of [
        "git@github.com:example/repo.git",
        "ssh://git@github.com/example/repo.git",
      ]) {
        const commands = await captureSpawnedCloneCommands(url);
        expectResolutionSpawn(commands.resolution, url);
        expectCloneSpawn(commands.clone, url);
        for (const command of [commands.resolution, commands.clone]) {
          expect(command.options.env?.GIT_SSH_COMMAND).toBe(
            "ssh -F none -o BatchMode=yes -o StrictHostKeyChecking=yes",
          );
        }
      }
    });
  });
});
