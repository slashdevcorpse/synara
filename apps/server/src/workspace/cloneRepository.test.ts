import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as EffectNodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as EffectNodePath from "@effect/platform-node/NodePath";
import { ProjectId, WorkspaceCloneId } from "@synara/contracts";
import { Effect, Exit, Layer, Scope, Sink, Stream } from "effect";
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
  WORKSPACE_CLONE_MAX_ACTIVE_JOBS,
  WORKSPACE_CLONE_MAX_RETAINED_JOBS,
} from "./cloneRepository";

const tempDirs: string[] = [];

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

interface CapturedGitCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly cwd?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly stdin?: unknown;
  };
}

function cloneCommandError(cwd: string): GitCommandError {
  return new GitCommandError({
    operation: "workspace clone",
    command: "git clone",
    cwd,
    detail: "network failed",
  });
}

function successfulChildProcessHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

async function captureSpawnedCloneCommand(url: string): Promise<CapturedGitCommand> {
  const parent = await makeTempDir();
  const targetPath = NodePath.join(parent, "repo");
  let captured: CapturedGitCommand | null = null;
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die(new Error("Expected workspace clone to spawn one standard git command."));
    }
    captured = {
      command: command.command,
      args: command.args,
      options: command.options,
    };
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
  if (!captured) throw new Error("Workspace clone did not spawn git.");
  return captured;
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

  it("uses argv clone execution and removes only a job-created failed target", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "repo");
    const calls: Array<{ cwd: string; args: ReadonlyArray<string>; env?: NodeJS.ProcessEnv }> = [];
    const git: Pick<GitCoreShape, "execute"> = {
      execute: (input: Parameters<GitCoreShape["execute"]>[0]) => {
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
      },
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
          "clone",
          "--progress",
          "--",
          "https://github.com/example/repo.git",
          targetPath,
        ],
        env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      _tag: "clone_finished",
      result: { clonedPath: null, failure: { stage: "clone" } },
    });
    await expect(NodeFs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a successful clone when project creation fails and retries without cloning", async () => {
    const parent = await makeTempDir();
    const targetPath = NodePath.join(parent, "repo");
    let cloneCalls = 0;
    let projectCalls = 0;
    const git = {
      execute: () => {
        cloneCalls += 1;
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      },
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
      result: { clonedPath: targetPath, failure: { stage: "project" } },
    });
    await expect(NodeFs.stat(targetPath)).resolves.toBeDefined();

    const retried = Array.from(
      await Effect.runPromise(Stream.runCollect(jobs.retryProjectCreation(cloneId))),
    );
    expect(retried.at(-1)).toMatchObject({
      result: { clonedPath: targetPath, projectId: "project-1", failure: null },
    });
    expect(cloneCalls).toBe(1);
    expect(projectCalls).toBe(2);
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
        execute: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
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
      execute: () => {
        signalStarted();
        return Effect.tryPromise(() => blockedClone);
      },
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
        execute: () =>
          Effect.tryPromise(async () => {
            await cloneGate;
            return { code: 0, stdout: "", stderr: "" };
          }),
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
        execute: () =>
          Effect.tryPromise(async () => {
            await cloneGate;
            return { code: 0, stdout: "", stderr: "" };
          }),
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

  it("interrupts background git work and cleans its owned target on server-scope shutdown", async () => {
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
              execute: () => Effect.never,
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

    await expect(NodeFs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(jobs.getStatus(cloneId)).toMatchObject({
      status: "failed",
      result: { failure: { code: "WORKSPACE_CLONE_CANCELLED" } },
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
              execute: (command) =>
                command.args.at(-1) === NodePath.join(parent, "active-0")
                  ? Effect.never
                  : Effect.succeed({ code: 0, stdout: "", stderr: "" }),
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
        execute: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
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
    GIT_SSH: "inherited-ssh-wrapper",
    GIT_SSH_COMMAND: "inherited ssh command",
    GIT_SSH_VARIANT: "plink",
    SSH_ASKPASS: "inherited-ssh-askpass",
    SSH_ASKPASS_REQUIRE: "force",
    SYNARA_CLONE_TEST_INHERITED: "retained",
    WAYLAND_DISPLAY: "wayland-99",
  } as const;

  function expectCommonNoninteractiveSpawn(command: CapturedGitCommand, url: string): void {
    expect(command.command).toBe("git");
    expect(command.args).toEqual([
      "-c",
      "credential.interactive=false",
      "-c",
      "core.askPass=",
      "clone",
      "--progress",
      "--",
      url,
      expect.stringMatching(/[\\/]repo$/),
    ]);
    expect(command.options.stdin).toBe("ignore");
    expect(command.options.env).toMatchObject({
      GCM_INTERACTIVE: "Never",
      GIT_TERMINAL_PROMPT: "0",
      SYNARA_CLONE_TEST_INHERITED: "retained",
    });
    for (const key of [
      "DISPLAY",
      "GIT_ASKPASS",
      "GIT_SSH",
      "GIT_SSH_VARIANT",
      "SSH_ASKPASS",
      "SSH_ASKPASS_REQUIRE",
      "WAYLAND_DISPLAY",
    ]) {
      expect(command.options.env).not.toHaveProperty(key);
    }
  }

  it("spawns HTTPS clone with ignored stdin and no inherited prompt helpers", async () => {
    const url = "https://github.com/example/repo.git";
    await withTemporaryProcessEnvironment(inheritedPromptEnvironment, async () => {
      const command = await captureSpawnedCloneCommand(url);
      expectCommonNoninteractiveSpawn(command, url);
      expect(command.options.env).not.toHaveProperty("GIT_SSH_COMMAND");
    });
  });

  it("spawns accepted SSH forms with strict batch-mode OpenSSH and no inherited prompt helpers", async () => {
    await withTemporaryProcessEnvironment(inheritedPromptEnvironment, async () => {
      for (const url of [
        "git@github.com:example/repo.git",
        "ssh://git@github.com/example/repo.git",
      ]) {
        const command = await captureSpawnedCloneCommand(url);
        expectCommonNoninteractiveSpawn(command, url);
        expect(command.options.env?.GIT_SSH_COMMAND).toBe(
          "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
        );
      }
    });
  });
});
