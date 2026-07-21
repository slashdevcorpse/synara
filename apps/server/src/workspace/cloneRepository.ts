import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type ProjectId,
  type WorkspaceCloneId,
  type WorkspaceCloneJobSnapshot,
  type WorkspaceCloneProgressEvent,
  type WorkspaceCloneRepositoryInput,
  type WorkspaceCloneRepositoryResult,
} from "@synara/contracts";
import { Effect, Exit, Layer, Queue, Scope, ServiceMap, Stream } from "effect";

import { ServerConfig } from "../config";
import { GitCore, type GitCoreShape } from "../git/Services/GitCore";

const CLONE_TIMEOUT_MS = 30 * 60 * 1_000;
const CLONE_URL_RESOLUTION_TIMEOUT_MS = 5_000;
const CLONE_MAX_OUTPUT_BYTES = 2_000_000;
const CLONE_URL_RESOLUTION_MAX_OUTPUT_BYTES = 64_000;
const CLONE_FAILURE_DIAGNOSTIC_TRUNCATION_MARKER = "\n[... clone diagnostic truncated ...]\n";
const CLONE_FAILURE_TARGET_PATH_MAX_CHARS = 4_096;
const CLONE_FAILURE_TARGET_PATH_TRUNCATION_MARKER = "[... target path truncated ...]";
const CLONE_PROMPT_ENV = ["DISPLAY", "WAYLAND_DISPLAY"] as const;
const CLONE_PRESERVED_SSH_ENV = new Set(["SSH_AGENT_PID", "SSH_AUTH_SOCK"]);
const CLONE_SSH_COMMAND = "ssh -F none -o BatchMode=yes -o StrictHostKeyChecking=yes";
export const WORKSPACE_CLONE_MAX_ACTIVE_JOBS = 4;
export const WORKSPACE_CLONE_MAX_RETAINED_JOBS = 100;
export const WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS = 8_192;

export class WorkspaceCloneValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly lockKey?: string,
  ) {
    super(message);
    this.name = "WorkspaceCloneValidationError";
  }
}

export interface GitCloneProgressFrame {
  readonly phase: string;
  readonly phasePercent: number;
  readonly percent: number;
  readonly completed: number | null;
  readonly total: number | null;
  readonly message: string;
}

const CLONE_PHASE_BASE: ReadonlyArray<readonly [RegExp, number, number]> = [
  [/enumerating objects/i, 0, 5],
  [/counting objects/i, 5, 10],
  [/compressing objects/i, 15, 10],
  [/receiving objects/i, 25, 55],
  [/resolving deltas/i, 80, 18],
  [/updating files/i, 98, 2],
];

export function parseGitCloneProgressFrame(frame: string): GitCloneProgressFrame | null {
  const normalized = frame.replace(/^remote:\s*/i, "").trim();
  const match = /^([^:]+):\s*(\d{1,3})%\s*\((\d+)\/(\d+)\)/.exec(normalized);
  if (!match) return null;
  const phase = match[1]?.trim() ?? "Cloning";
  const phasePercent = Math.min(100, Math.max(0, Number(match[2])));
  const completed = Number(match[3]);
  const total = Number(match[4]);
  const phaseRange = CLONE_PHASE_BASE.find(([pattern]) => pattern.test(phase));
  const percent = phaseRange
    ? Math.min(100, Math.round(phaseRange[1] + (phasePercent / 100) * phaseRange[2]))
    : phasePercent;
  return {
    phase,
    phasePercent,
    percent,
    completed: Number.isSafeInteger(completed) ? completed : null,
    total: Number.isSafeInteger(total) ? total : null,
    message: `${phase}: ${phasePercent}%`,
  };
}

export function validateWorkspaceCloneUrl(input: string): string {
  const value = input.trim();
  if (!value || value.startsWith("-") || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new WorkspaceCloneValidationError(
      "WORKSPACE_CLONE_INVALID_URL",
      "Enter a valid GitHub HTTPS or SSH repository URL.",
    );
  }

  const scpMatch = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(value);
  if (scpMatch) return value;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkspaceCloneValidationError(
      "WORKSPACE_CLONE_INVALID_URL",
      "Enter a valid GitHub HTTPS or SSH repository URL.",
    );
  }
  if (
    parsed.hostname.toLowerCase() !== "github.com" ||
    (parsed.protocol === "ssh:"
      ? parsed.port !== "" && parsed.port !== "22"
      : parsed.port !== "") ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !new Set(["https:", "ssh:"]).has(parsed.protocol) ||
    (parsed.protocol === "https:" && parsed.username) ||
    (parsed.protocol === "ssh:" && parsed.username !== "git") ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/.test(parsed.pathname)
  ) {
    throw new WorkspaceCloneValidationError(
      "WORKSPACE_CLONE_INVALID_URL",
      "Only credential-free GitHub HTTPS and GitHub SSH repository URLs are supported.",
    );
  }
  return value;
}

function isWorkspaceSshCloneUrl(url: string): boolean {
  const normalized = url.toLowerCase();
  return normalized.startsWith("git@") || normalized.startsWith("ssh://");
}

function cloneInheritedEnvironmentKeysToUnset(
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const keys = new Set<string>(CLONE_PROMPT_ENV);
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized.startsWith("GIT_") ||
      (normalized.startsWith("SSH_") && !CLONE_PRESERVED_SSH_ENV.has(normalized))
    ) {
      keys.add(key);
    }
  }
  return [...keys];
}

function cloneGitEnvironment(url: string): {
  readonly unsetEnv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const ssh = isWorkspaceSshCloneUrl(url);
  return {
    unsetEnv: cloneInheritedEnvironmentKeysToUnset(process.env),
    env: {
      GIT_ALLOW_PROTOCOL: ssh ? "ssh" : "https",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      ...(ssh ? { GIT_SSH_COMMAND: CLONE_SSH_COMMAND } : {}),
    },
  };
}

function cloneGitConfigArgs(url: string): ReadonlyArray<string> {
  return [
    "-c",
    "credential.interactive=false",
    "-c",
    "core.askPass=",
    ...(isWorkspaceSshCloneUrl(url)
      ? []
      : ["-c", "http.curloptResolve=", "-c", "http.sslVerify=true"]),
  ];
}

export interface ValidatedWorkspaceCloneTarget {
  readonly targetPath: string;
  readonly parentPath: string;
  readonly lockKey: string;
  readonly existed: boolean;
}

function expandHomePath(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return NodePath.join(homeDir, input.slice(2));
  }
  return input;
}

function pathLockKey(value: string): string {
  const normalized = NodePath.normalize(value);
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

export async function validateWorkspaceCloneTarget(input: {
  readonly targetPath: string;
  readonly homeDir: string;
  readonly createParentDirectories?: boolean;
}): Promise<ValidatedWorkspaceCloneTarget> {
  const expanded = expandHomePath(input.targetPath.trim(), input.homeDir);
  if (!NodePath.isAbsolute(expanded)) {
    throw new WorkspaceCloneValidationError(
      "WORKSPACE_CLONE_INVALID_TARGET",
      "Choose an absolute path for the repository folder.",
    );
  }
  const requestedTarget = NodePath.resolve(expanded);
  const requestedParent = NodePath.dirname(requestedTarget);
  if (
    requestedTarget === NodePath.parse(requestedTarget).root ||
    requestedParent === requestedTarget
  ) {
    throw new WorkspaceCloneValidationError(
      "WORKSPACE_CLONE_INVALID_TARGET",
      "Choose a repository folder below a writable parent directory.",
    );
  }

  let existingAncestor = requestedParent;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const ancestorStat = await NodeFs.stat(existingAncestor);
      if (!ancestorStat.isDirectory()) throw new Error("Parent is not a directory.");
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new WorkspaceCloneValidationError(
          "WORKSPACE_CLONE_INVALID_TARGET",
          "The clone target parent is not an accessible directory.",
        );
      }
      const nextAncestor = NodePath.dirname(existingAncestor);
      if (nextAncestor === existingAncestor) {
        throw new WorkspaceCloneValidationError(
          "WORKSPACE_CLONE_INVALID_TARGET",
          "The clone target has no accessible parent directory.",
        );
      }
      missingSegments.unshift(NodePath.basename(existingAncestor));
      existingAncestor = nextAncestor;
    }
  }
  const canonicalAncestor = await NodeFs.realpath(existingAncestor);
  const canonicalRequestedParent = NodePath.join(canonicalAncestor, ...missingSegments);
  if (missingSegments.length > 0 && input.createParentDirectories !== true) {
    throw new WorkspaceCloneValidationError(
      "WORKSPACE_CLONE_INVALID_TARGET",
      "The clone target parent directory does not exist.",
    );
  }
  if (missingSegments.length > 0) {
    await NodeFs.mkdir(canonicalRequestedParent, { recursive: true });
  }
  const parentPath = await NodeFs.realpath(canonicalRequestedParent);

  const targetPath = NodePath.join(parentPath, NodePath.basename(requestedTarget));
  let targetStat: Awaited<ReturnType<typeof NodeFs.lstat>> | null = null;
  try {
    targetStat = await NodeFs.lstat(targetPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  if (targetStat) {
    throw new WorkspaceCloneValidationError(
      "WORKSPACE_CLONE_TARGET_EXISTS",
      "The clone target must not already exist. Choose a new folder path.",
      pathLockKey(targetPath),
    );
  }

  return {
    targetPath,
    parentPath,
    lockKey: pathLockKey(targetPath),
    existed: false,
  };
}

interface CloneTargetDirectoryFileSystem {
  readonly mkdir: (path: string) => Promise<void>;
}

const DEFAULT_CLONE_TARGET_DIRECTORY_FILE_SYSTEM: CloneTargetDirectoryFileSystem = {
  mkdir: (path) => NodeFs.mkdir(path),
};

async function createCloneTargetDirectory(
  target: ValidatedWorkspaceCloneTarget,
  fileSystem: CloneTargetDirectoryFileSystem,
): Promise<string> {
  try {
    await fileSystem.mkdir(target.targetPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceCloneValidationError(
        "WORKSPACE_CLONE_TARGET_IN_USE",
        "The clone target was created by another operation.",
      );
    }
    throw cause;
  }
  return target.targetPath;
}

function redactError(cause: unknown, url: string): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw.replaceAll(url, "[repository URL]").trim() || "The clone operation failed.";
}

function splitsSurrogatePair(value: string, boundary: number): boolean {
  if (boundary <= 0 || boundary >= value.length) return false;
  const precedingCodeUnit = value.charCodeAt(boundary - 1);
  const followingCodeUnit = value.charCodeAt(boundary);
  return (
    precedingCodeUnit >= 0xd800 &&
    precedingCodeUnit <= 0xdbff &&
    followingCodeUnit >= 0xdc00 &&
    followingCodeUnit <= 0xdfff
  );
}

function truncateWithHeadAndTail(value: string, maxChars: number, marker: string): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const retainedChars = maxChars - marker.length;
  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = retainedChars - headChars;
  const headEnd = splitsSurrogatePair(value, headChars) ? headChars - 1 : headChars;
  const requestedTailStart = value.length - tailChars;
  const tailStart = splitsSurrogatePair(value, requestedTailStart)
    ? requestedTailStart + 1
    : requestedTailStart;
  return `${value.slice(0, headEnd)}${marker}${value.slice(tailStart)}`;
}

function retainedCloneTargetGuidance(targetPath: string): string {
  const displayedTargetPath = truncateWithHeadAndTail(
    targetPath,
    CLONE_FAILURE_TARGET_PATH_MAX_CHARS,
    CLONE_FAILURE_TARGET_PATH_TRUNCATION_MARKER,
  );
  return (
    ` Partial clone data may remain at ${displayedTargetPath}. ` +
    "Synara did not remove it because safe automatic cleanup cannot be guaranteed. " +
    "Inspect or remove that destination manually before retrying."
  );
}

function boundedCloneFailureMessage(
  cause: unknown,
  url: string,
  retainedTargetPath: string | null,
): string {
  const guidance = retainedTargetPath ? retainedCloneTargetGuidance(retainedTargetPath) : "";
  const diagnosticMaxChars = WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS - guidance.length;
  const diagnostic = truncateWithHeadAndTail(
    redactError(cause, url),
    diagnosticMaxChars,
    CLONE_FAILURE_DIAGNOSTIC_TRUNCATION_MARKER,
  );
  return `${diagnostic}${guidance}`;
}

function describeError(cause: unknown): string {
  const description =
    cause instanceof Error && cause.message.trim() ? cause.message.trim() : String(cause);
  return truncateWithHeadAndTail(
    description,
    WORKSPACE_CLONE_FAILURE_MESSAGE_MAX_CHARS,
    CLONE_FAILURE_DIAGNOSTIC_TRUNCATION_MARKER,
  );
}

export interface WorkspaceCloneJobsShape {
  readonly cloneRepository: (
    input: WorkspaceCloneRepositoryInput,
    createProject?: WorkspaceProjectCreator,
  ) => Stream.Stream<WorkspaceCloneProgressEvent>;
  readonly getStatus: (cloneId: WorkspaceCloneId) => WorkspaceCloneJobSnapshot | null;
  readonly retryProjectCreation: (
    cloneId: WorkspaceCloneId,
    createProject?: WorkspaceProjectCreator,
  ) => Stream.Stream<WorkspaceCloneProgressEvent>;
}

export type WorkspaceProjectCreator = (workspaceRoot: string) => Effect.Effect<ProjectId, unknown>;

export class WorkspaceCloneJobs extends ServiceMap.Service<
  WorkspaceCloneJobs,
  WorkspaceCloneJobsShape
>()("synara/workspace/WorkspaceCloneJobs") {}

export function makeWorkspaceCloneJobs(input: {
  readonly git: Pick<GitCoreShape, "execute">;
  readonly homeDir: string;
  readonly createProject?: WorkspaceProjectCreator;
  readonly startBackground?: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  readonly targetDirectoryFileSystem?: CloneTargetDirectoryFileSystem;
  readonly beforeTerminalPublish?: (input: {
    readonly cloneId: WorkspaceCloneId;
    readonly result: WorkspaceCloneRepositoryResult;
  }) => Effect.Effect<void>;
}): WorkspaceCloneJobsShape {
  const jobs = new Map<WorkspaceCloneId, WorkspaceCloneJobSnapshot>();
  const activeTargets = new Map<string, WorkspaceCloneId>();
  const activeCloneIds = new Set<WorkspaceCloneId>();
  const activeProjectRetries = new Set<WorkspaceCloneId>();
  interface CloneSubscriber {
    readonly offer: (event: WorkspaceCloneProgressEvent) => Effect.Effect<void>;
    readonly end: Effect.Effect<void>;
    readonly awaitEnd: Effect.Effect<void>;
  }
  const subscribers = new Map<WorkspaceCloneId, Set<CloneSubscriber>>();
  const startBackground =
    input.startBackground ??
    ((effect: Effect.Effect<void>) =>
      Effect.sync(() => {
        Effect.runFork(effect);
      }));
  const targetDirectoryFileSystem =
    input.targetDirectoryFileSystem ?? DEFAULT_CLONE_TARGET_DIRECTORY_FILE_SYSTEM;
  const beforeTerminalPublish = input.beforeTerminalPublish ?? (() => Effect.void);

  const retain = (snapshot: WorkspaceCloneJobSnapshot) => {
    jobs.delete(snapshot.cloneId);
    jobs.set(snapshot.cloneId, snapshot);
    while (jobs.size > WORKSPACE_CLONE_MAX_RETAINED_JOBS) {
      const oldest = [...jobs.keys()].find(
        (cloneId) => !activeCloneIds.has(cloneId) && !activeProjectRetries.has(cloneId),
      );
      if (oldest === undefined) break;
      jobs.delete(oldest);
    }
    return snapshot;
  };

  const snapshot = (
    cloneId: WorkspaceCloneId,
    values: Omit<WorkspaceCloneJobSnapshot, "cloneId" | "updatedAt">,
  ): WorkspaceCloneJobSnapshot =>
    retain({ cloneId, ...values, updatedAt: new Date().toISOString() });

  const addSubscriber = (cloneId: WorkspaceCloneId, subscriber: CloneSubscriber): void => {
    const current = subscribers.get(cloneId) ?? new Set<CloneSubscriber>();
    current.add(subscriber);
    subscribers.set(cloneId, current);
  };

  const removeSubscriber = (cloneId: WorkspaceCloneId, subscriber: CloneSubscriber): void => {
    const current = subscribers.get(cloneId);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) subscribers.delete(cloneId);
  };

  const publish = (
    cloneId: WorkspaceCloneId,
    event: WorkspaceCloneProgressEvent,
    terminal = false,
  ): Effect.Effect<void> => {
    const current = [...(subscribers.get(cloneId) ?? [])];
    const offered = Effect.forEach(current, (subscriber) => subscriber.offer(event), {
      discard: true,
    });
    if (!terminal) return offered;
    return offered.pipe(
      Effect.andThen(Effect.forEach(current, (subscriber) => subscriber.end, { discard: true })),
      Effect.tap(() => Effect.sync(() => subscribers.delete(cloneId))),
    );
  };

  const directTerminal = (
    subscriber: CloneSubscriber,
    cloneId: WorkspaceCloneId,
    result: WorkspaceCloneRepositoryResult,
  ) => {
    const terminal: WorkspaceCloneJobSnapshot = {
      cloneId,
      status: "failed",
      stage: "complete",
      percent: null,
      message: result.failure?.message ?? "Clone request rejected.",
      result,
      updatedAt: new Date().toISOString(),
    };
    return subscriber
      .offer({ _tag: "clone_finished", snapshot: terminal, result })
      .pipe(Effect.andThen(subscriber.end), Effect.asVoid);
  };

  const cloneRepository = (
    request: WorkspaceCloneRepositoryInput,
    createProject: WorkspaceProjectCreator | undefined = input.createProject,
  ): Stream.Stream<WorkspaceCloneProgressEvent> =>
    Stream.callback((queue) => {
      let resolveSubscriberEnd!: () => void;
      const subscriberEnded = new Promise<void>((resolve) => {
        resolveSubscriberEnd = resolve;
      });
      const subscriber: CloneSubscriber = {
        offer: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
        end: Effect.sync(resolveSubscriberEnd).pipe(
          Effect.andThen(Queue.end(queue)),
          Effect.asVoid,
        ),
        awaitEnd: Effect.promise(() => subscriberEnded),
      };
      let target: ValidatedWorkspaceCloneTarget | null = null;
      let createdTargetPath: string | null = null;
      let clonedPath: string | null = null;
      let projectCreationStarted = false;
      let terminalOutcome: {
        readonly result: WorkspaceCloneRepositoryResult;
        readonly snapshot: WorkspaceCloneJobSnapshot;
      } | null = null;
      let latestPercent = 0;

      const finish = (requestedResult: WorkspaceCloneRepositoryResult) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const outcome = yield* Effect.sync(() => {
              if (terminalOutcome) return terminalOutcome;
              const terminal = snapshot(request.cloneId, {
                status: requestedResult.failure ? "failed" : "succeeded",
                stage: "complete",
                percent: requestedResult.failure?.stage === "clone" ? latestPercent : 100,
                message: requestedResult.failure?.message ?? "Clone complete.",
                result: requestedResult,
              });
              terminalOutcome = { result: requestedResult, snapshot: terminal };
              return terminalOutcome;
            });
            yield* beforeTerminalPublish({
              cloneId: request.cloneId,
              result: outcome.result,
            });
            yield* publish(
              request.cloneId,
              { _tag: "clone_finished", snapshot: outcome.snapshot, result: outcome.result },
              true,
            );
          }),
        );
      const cloneFailure = (code: string, cause: unknown, retryable: boolean) => {
        const retainedTargetPath = createdTargetPath;
        const failureMessage = boundedCloneFailureMessage(cause, request.url, retainedTargetPath);
        // Node has no portable descriptor-relative recursive delete. Any
        // path-based cleanup after Git starts can race with replacement, so
        // fail closed and leave the exact target entry untouched.
        return finish({
          cloneId: request.cloneId,
          clonedPath: null,
          projectId: null,
          failure: {
            stage: "clone",
            code,
            message: failureMessage,
            retryable: retainedTargetPath ? false : retryable,
          },
        });
      };

      if (activeCloneIds.has(request.cloneId) || jobs.has(request.cloneId)) {
        return directTerminal(subscriber, request.cloneId, {
          cloneId: request.cloneId,
          clonedPath: null,
          projectId: null,
          failure: {
            stage: "clone",
            code: "WORKSPACE_CLONE_ID_IN_USE",
            message: "A clone operation has already used this identifier.",
            retryable: false,
          },
        });
      }
      if (activeCloneIds.size >= WORKSPACE_CLONE_MAX_ACTIVE_JOBS) {
        return directTerminal(subscriber, request.cloneId, {
          cloneId: request.cloneId,
          clonedPath: null,
          projectId: null,
          failure: {
            stage: "clone",
            code: "WORKSPACE_CLONE_CAPACITY_EXCEEDED",
            message:
              `The server is already running ${WORKSPACE_CLONE_MAX_ACTIVE_JOBS} clone operations. ` +
              "Retry after one finishes.",
            retryable: true,
          },
        });
      }
      activeCloneIds.add(request.cloneId);
      addSubscriber(request.cloneId, subscriber);
      snapshot(request.cloneId, {
        status: "pending",
        stage: "validating",
        percent: null,
        message: "Validating clone request…",
        result: null,
      });

      const program = Effect.gen(function* () {
        const url = yield* Effect.try({
          try: () => validateWorkspaceCloneUrl(request.url),
          catch: (cause) => cause,
        });
        target = yield* Effect.tryPromise({
          try: () =>
            validateWorkspaceCloneTarget({
              targetPath: request.targetPath,
              homeDir: input.homeDir,
              ...(request.createParentDirectories === undefined
                ? {}
                : { createParentDirectories: request.createParentDirectories }),
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof WorkspaceCloneValidationError &&
            cause.code === "WORKSPACE_CLONE_TARGET_EXISTS" &&
            cause.lockKey !== undefined &&
            activeTargets.has(cause.lockKey)
              ? new WorkspaceCloneValidationError(
                  "WORKSPACE_CLONE_TARGET_IN_USE",
                  "Another clone operation is already using this target.",
                  cause.lockKey,
                )
              : cause,
          ),
        );
        if (activeTargets.has(target.lockKey)) {
          return yield* Effect.fail(
            new WorkspaceCloneValidationError(
              "WORKSPACE_CLONE_TARGET_IN_USE",
              "Another clone operation is already using this target.",
            ),
          );
        }
        activeTargets.set(target.lockKey, request.cloneId);
        const gitEnvironment = cloneGitEnvironment(url);
        const gitConfigArgs = cloneGitConfigArgs(url);
        // Keep installed/user credential helpers available, but reject any
        // url.*.insteadOf expansion before Git talks to the remote.
        const resolution = yield* input.git.execute({
          operation: "WorkspaceCloneJobs.resolveRepositoryUrl",
          cwd: target.parentPath,
          args: [...gitConfigArgs, "ls-remote", "--get-url", "--", url],
          ...gitEnvironment,
          stdin: "ignore",
          timeoutMs: CLONE_URL_RESOLUTION_TIMEOUT_MS,
          maxOutputBytes: CLONE_URL_RESOLUTION_MAX_OUTPUT_BYTES,
        });
        if (resolution.stdout.trim() !== url) {
          return yield* Effect.fail(
            new WorkspaceCloneValidationError(
              "WORKSPACE_CLONE_URL_REWRITE_BLOCKED",
              "Git configuration must not rewrite the validated GitHub repository URL.",
            ),
          );
        }
        yield* Effect.uninterruptible(
          Effect.tryPromise({
            try: () => createCloneTargetDirectory(target!, targetDirectoryFileSystem),
            catch: (cause) => cause,
          }).pipe(
            Effect.tap((path) =>
              Effect.sync(() => {
                createdTargetPath = path;
              }),
            ),
          ),
        );

        const started = snapshot(request.cloneId, {
          status: "running",
          stage: "cloning",
          percent: 0,
          message: "Cloning repository…",
          result: null,
        });
        yield* publish(request.cloneId, { _tag: "clone_started", snapshot: started });

        const completedClonePath = target.targetPath;
        const shouldCreateProject = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(
              input.git.execute({
                operation: "WorkspaceCloneJobs.cloneRepository",
                cwd: target!.parentPath,
                args: [...gitConfigArgs, "clone", "--progress", "--", url, completedClonePath],
                ...gitEnvironment,
                stdin: "ignore",
                timeoutMs: CLONE_TIMEOUT_MS,
                maxOutputBytes: CLONE_MAX_OUTPUT_BYTES,
                progress: {
                  onStderrLine: (line) => {
                    const parsed = parseGitCloneProgressFrame(line);
                    if (!parsed) return Effect.void;
                    latestPercent = Math.max(latestPercent, parsed.percent);
                    const progressSnapshot = snapshot(request.cloneId, {
                      status: "running",
                      stage: "cloning",
                      percent: latestPercent,
                      message: parsed.message,
                      result: null,
                    });
                    return publish(request.cloneId, {
                      _tag: "clone_progress",
                      snapshot: progressSnapshot,
                      phase: parsed.phase,
                      completed: parsed.completed,
                      total: parsed.total,
                    });
                  },
                },
              }),
            );
            clonedPath = completedClonePath;
            createdTargetPath = null;

            if (!request.createProject) {
              yield* finish({
                cloneId: request.cloneId,
                clonedPath: completedClonePath,
                projectId: null,
                failure: null,
              });
              return false;
            }

            projectCreationStarted = true;
            return true;
          }),
        );
        if (!shouldCreateProject) return;

        const projectSnapshot = snapshot(request.cloneId, {
          status: "running",
          stage: "creating-project",
          percent: Math.max(latestPercent, 99),
          message: "Creating Synara project…",
          result: null,
        });
        yield* publish(request.cloneId, {
          _tag: "clone_progress",
          snapshot: projectSnapshot,
          phase: "Creating project",
          completed: null,
          total: null,
        });
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const projectResult = yield* restore(
              Effect.result(
                createProject
                  ? createProject(completedClonePath)
                  : Effect.fail(new Error("Workspace project creation is unavailable.")),
              ),
            );
            yield* finish(
              projectResult._tag === "Failure"
                ? {
                    cloneId: request.cloneId,
                    clonedPath: completedClonePath,
                    projectId: null,
                    failure: {
                      stage: "project",
                      code: "WORKSPACE_CLONE_PROJECT_CREATE_FAILED",
                      message: describeError(projectResult.failure),
                      retryable: true,
                    },
                  }
                : {
                    cloneId: request.cloneId,
                    clonedPath: completedClonePath,
                    projectId: projectResult.success,
                    failure: null,
                  },
            );
          }),
        );
      }).pipe(
        Effect.catch((cause) =>
          cloneFailure(
            cause instanceof WorkspaceCloneValidationError ? cause.code : "WORKSPACE_CLONE_FAILED",
            cause,
            !(cause instanceof WorkspaceCloneValidationError),
          ),
        ),
        Effect.onInterrupt(() => {
          if (terminalOutcome) return Effect.void;
          const interruptedClonedPath = clonedPath;
          if (projectCreationStarted && interruptedClonedPath) {
            return finish({
              cloneId: request.cloneId,
              clonedPath: interruptedClonedPath,
              projectId: null,
              failure: {
                stage: "project",
                code: "WORKSPACE_CLONE_PROJECT_CREATE_CANCELLED",
                message: "Project creation was cancelled because the server stopped.",
                retryable: true,
              },
            });
          }
          return cloneFailure(
            "WORKSPACE_CLONE_CANCELLED",
            new Error("Clone cancelled because the server stopped."),
            true,
          );
        }),
        Effect.ensuring(
          Effect.sync(() => {
            activeCloneIds.delete(request.cloneId);
            if (target && activeTargets.get(target.lockKey) === request.cloneId) {
              activeTargets.delete(target.lockKey);
            }
          }),
        ),
      );
      return Effect.uninterruptible(startBackground(program)).pipe(
        Effect.andThen(subscriber.awaitEnd),
        Effect.ensuring(
          Effect.sync(() => {
            removeSubscriber(request.cloneId, subscriber);
          }),
        ),
      );
    });

  const retryProjectCreation = (
    cloneId: WorkspaceCloneId,
    createProject: WorkspaceProjectCreator | undefined = input.createProject,
  ): Stream.Stream<WorkspaceCloneProgressEvent> =>
    Stream.callback((queue) => {
      let resolveSubscriberEnd!: () => void;
      const subscriberEnded = new Promise<void>((resolve) => {
        resolveSubscriberEnd = resolve;
      });
      const subscriber: CloneSubscriber = {
        offer: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
        end: Effect.sync(resolveSubscriberEnd).pipe(
          Effect.andThen(Queue.end(queue)),
          Effect.asVoid,
        ),
        awaitEnd: Effect.promise(() => subscriberEnded),
      };
      const current = jobs.get(cloneId);
      const clonedPath = current?.result?.clonedPath ?? null;
      if (
        activeProjectRetries.has(cloneId) ||
        !current ||
        current.result?.failure?.stage !== "project" ||
        !clonedPath
      ) {
        const result: WorkspaceCloneRepositoryResult = {
          cloneId,
          clonedPath,
          projectId: current?.result?.projectId ?? null,
          failure: {
            stage: "project",
            code: "WORKSPACE_CLONE_PROJECT_RETRY_UNAVAILABLE",
            message: "Project creation can only be retried after a successful clone.",
            retryable: false,
          },
        };
        return directTerminal(subscriber, cloneId, result);
      }
      activeProjectRetries.add(cloneId);
      addSubscriber(cloneId, subscriber);
      let terminalOutcome: {
        readonly result: WorkspaceCloneRepositoryResult;
        readonly snapshot: WorkspaceCloneJobSnapshot;
      } | null = null;
      const finishRetry = (requestedResult: WorkspaceCloneRepositoryResult) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const outcome = yield* Effect.sync(() => {
              if (terminalOutcome) return terminalOutcome;
              const terminal = snapshot(cloneId, {
                status: requestedResult.failure ? "failed" : "succeeded",
                stage: "complete",
                percent: 100,
                message: requestedResult.failure?.message ?? "Project created.",
                result: requestedResult,
              });
              terminalOutcome = { result: requestedResult, snapshot: terminal };
              return terminalOutcome;
            });
            yield* beforeTerminalPublish({ cloneId, result: outcome.result });
            yield* publish(
              cloneId,
              { _tag: "clone_finished", snapshot: outcome.snapshot, result: outcome.result },
              true,
            );
          }),
        );

      const program = Effect.gen(function* () {
        const progress = snapshot(cloneId, {
          status: "running",
          stage: "creating-project",
          percent: Math.max(current.percent ?? 0, 99),
          message: "Retrying Synara project creation…",
          result: null,
        });
        yield* publish(cloneId, { _tag: "clone_started", snapshot: progress });
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const created = yield* restore(
              Effect.result(
                createProject
                  ? createProject(clonedPath)
                  : Effect.fail(new Error("Workspace project creation is unavailable.")),
              ),
            );
            yield* finishRetry(
              created._tag === "Success"
                ? { cloneId, clonedPath, projectId: created.success, failure: null }
                : {
                    cloneId,
                    clonedPath,
                    projectId: null,
                    failure: {
                      stage: "project",
                      code: "WORKSPACE_CLONE_PROJECT_CREATE_FAILED",
                      message: describeError(created.failure),
                      retryable: true,
                    },
                  },
            );
          }),
        );
      }).pipe(
        Effect.onInterrupt(() => {
          if (terminalOutcome) return Effect.void;
          const restored = current.result;
          return restored ? finishRetry(restored) : Effect.void;
        }),
        Effect.ensuring(Effect.sync(() => activeProjectRetries.delete(cloneId))),
      );
      return Effect.uninterruptible(startBackground(program)).pipe(
        Effect.andThen(subscriber.awaitEnd),
        Effect.ensuring(
          Effect.sync(() => {
            removeSubscriber(cloneId, subscriber);
          }),
        ),
      );
    });

  return {
    cloneRepository,
    getStatus: (cloneId) => jobs.get(cloneId) ?? null,
    retryProjectCreation,
  };
}

export const WorkspaceCloneJobsLive = Layer.effect(
  WorkspaceCloneJobs,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const git = yield* GitCore;
    const serverScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
    return makeWorkspaceCloneJobs({
      git,
      homeDir: config.homeDir,
      startBackground: (effect) => effect.pipe(Effect.forkIn(serverScope), Effect.asVoid),
    });
  }),
);
