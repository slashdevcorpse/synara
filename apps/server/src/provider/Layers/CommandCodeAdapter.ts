/**
 * Command Code adapter backed by the CLI's supported headless interface.
 *
 * Command Code's interactive TUI can be hosted directly by terminal-first apps,
 * where its JSON hooks expose tool lifecycle events. Synara's native transcript
 * instead uses the supported headless interface and owns the session/process
 * lifecycle: `commandcode -p --verbose` runs once per turn and resumes with the
 * stable session id printed by the CLI. Command Code 0.52.1 does not dispatch
 * those hooks from its headless tool loop, so stdout is projected as assistant
 * content without promoting human-readable stderr into synthetic tool or
 * approval events.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import * as Path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderComposerCapabilities,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@synara/contracts";
import { resolveCommandCodeCliExecutable } from "@synara/shared/commandCodeCliExecutable";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { Effect, Layer, Queue, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildInlineSkillInstructions } from "../skillPromptInjection.ts";
import { teardownChildProcessTree } from "../supervisedProcessTeardown.ts";
import {
  CommandCodeAdapter,
  type CommandCodeAdapterShape,
} from "../Services/CommandCodeAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "commandCode" as const;
const DEFAULT_BINARY = "commandcode";
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_MAX_TURNS = 10;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_MODEL_LIST_BYTES = 2 * 1024 * 1024;
const MODEL_LIST_TIMEOUT_MS = 15_000;
const SESSION_LINE_PATTERN =
  /^session:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*$/iu;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

type SpawnProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;
type TeardownProcessTree = (child: ChildProcess) => Promise<unknown>;
type ResolveExecutable = (
  command: string,
  input: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => string;

export interface CommandCodeAdapterLiveOptions {
  readonly spawnProcess?: SpawnProcess;
  readonly teardownProcessTree?: TeardownProcessTree;
  readonly resolveExecutable?: ResolveExecutable;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface CommandCodeTurn {
  readonly id: TurnId;
  readonly items: unknown[];
}

interface ActiveCommandCodeTurn {
  readonly turnId: TurnId;
  readonly itemId: RuntimeItemId;
  readonly child: ChildProcess;
  readonly stdoutDecoder: StringDecoder;
  readonly stderrDecoder: StringDecoder;
  stderr: string;
  stderrLineBuffer: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutStarted: boolean;
  output: string;
  interrupted: boolean;
  settled: boolean;
  failure?: Error;
}

interface CommandCodeSessionContext {
  session: ProviderSession;
  readonly lifecycleGeneration?: string;
  readonly executable: string;
  providerSessionId?: string;
  active?: ActiveCommandCodeTurn;
  readonly turns: CommandCodeTurn[];
  stopped: boolean;
}

export interface CommandCodeModelDescriptor {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly upstreamProviderName?: string;
}

function isPathLikeExecutable(command: string): boolean {
  return Path.isAbsolute(command) || Path.win32.isAbsolute(command) || /[\\/]/u.test(command);
}

function resolveAndValidateExecutable(
  command: string,
  input: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): string {
  const executable = resolveCommandCodeCliExecutable(command, input);
  if (
    isPathLikeExecutable(command) ||
    Path.isAbsolute(executable) ||
    Path.win32.isAbsolute(executable)
  ) {
    try {
      if (!statSync(executable).isFile()) throw new Error("not a regular file");
    } catch {
      throw new Error(`Command Code executable does not exist or is not a file: ${executable}`);
    }
  }
  return executable;
}

function decodeChunk(decoder: StringDecoder, chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : decoder.write(chunk);
}

function chunkByteLength(chunk: Buffer | string): number {
  return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function parseCommandCodeSessionLine(line: string): string | undefined {
  return SESSION_LINE_PATTERN.exec(stripAnsi(line).trim())?.[1];
}

function humanizeModelSlug(slug: string): string {
  const leaf = slug.includes("/") ? (slug.split("/").at(-1) ?? slug) : slug;
  if (leaf.toLowerCase().startsWith("gpt-")) {
    return leaf.replace(/^gpt-/iu, "GPT-").replaceAll("-", " ");
  }
  return leaf.replace(/[-_]+/gu, " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

export function parseCommandCodeModelList(stdout: string): CommandCodeModelDescriptor[] {
  const models: CommandCodeModelDescriptor[] = [];
  const seen = new Set<string>();
  let providerName: string | undefined;

  for (const rawLine of stripAnsi(stdout).split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (
      !trimmed ||
      /^Available models\b/iu.test(trimmed) ||
      /^Pass the full id\b/iu.test(trimmed)
    ) {
      continue;
    }
    if (/^Docs:/iu.test(trimmed) || /^cmdc\s+--model\b/iu.test(trimmed)) break;
    if (!/^\s/u.test(rawLine) && /^[A-Za-z][A-Za-z ]+$/u.test(trimmed)) {
      providerName = trimmed;
      continue;
    }

    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._/-]+)\s{2,}(.+)$/u.exec(rawLine);
    if (!match?.[1]) continue;
    const slug = match[1].trim();
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = match[2]?.trim().replace(/\s+\(default\)$/iu, "");
    models.push({
      slug,
      name: humanizeModelSlug(slug),
      ...(description ? { description } : {}),
      ...(providerName ? { upstreamProviderName: providerName } : {}),
    });
  }
  return models;
}

export function buildCommandCodeTurnArgs(input: {
  readonly providerSessionId?: string;
  readonly model?: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly plan?: boolean;
  readonly maxTurns?: number;
}): string[] {
  return [
    "-p",
    "--verbose",
    "--skip-onboarding",
    "--trust",
    "--max-turns",
    String(input.maxTurns ?? DEFAULT_MAX_TURNS),
    ...(input.providerSessionId ? ["--resume", input.providerSessionId] : []),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.plan ? ["--plan"] : []),
    ...(input.runtimeMode === "full-access" && !input.plan ? ["--yolo"] : []),
  ];
}

function readResumeSessionId(value: unknown): string | undefined {
  if (typeof value === "string") return parseCommandCodeSessionLine(`session: ${value}`);
  if (!value || typeof value !== "object") return undefined;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string"
    ? parseCommandCodeSessionLine(`session: ${sessionId}`)
    : undefined;
}

function processErrorMessage(stderr: string, exitCode: number | null): string {
  if (exitCode === 8) {
    return `Command Code reached the configured ${DEFAULT_MAX_TURNS}-turn limit.`;
  }
  const lines = stripAnsi(stderr)
    .split(/[\r\n]+/u)
    .map((line) => line.trim())
    .filter((line) => line && !parseCommandCodeSessionLine(line));
  return lines.at(-1) ?? `Command Code exited with code ${exitCode ?? "unknown"}.`;
}

const makeCommandCodeAdapter = (options?: CommandCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, CommandCodeSessionContext>();
    const spawnProcess = options?.spawnProcess ?? spawn;
    const teardown = options?.teardownProcessTree;
    const resolveExecutable = options?.resolveExecutable ?? resolveAndValidateExecutable;

    const offerEvent = (event: ProviderRuntimeEvent): void => {
      Effect.runFork(Queue.offer(runtimeEventQueue, event));
      if (options?.nativeEventLogger) {
        Effect.runFork(options.nativeEventLogger.write(event.raw ?? event, event.threadId));
      }
    };

    const eventBase = (
      context: CommandCodeSessionContext,
      input: { readonly turnId?: TurnId; readonly itemId?: RuntimeItemId } = {},
    ) => ({
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(context.lifecycleGeneration ? { lifecycleGeneration: context.lifecycleGeneration } : {}),
      ...(context.providerSessionId
        ? { providerRefs: { providerThreadId: context.providerSessionId } }
        : {}),
    });

    const snapshotSession = (context: CommandCodeSessionContext): ProviderSession => ({
      ...context.session,
      status: context.stopped ? "closed" : context.active ? "running" : "ready",
      updatedAt: new Date().toISOString(),
      ...(context.active ? { activeTurnId: context.active.turnId } : {}),
      ...(context.providerSessionId
        ? { resumeCursor: { sessionId: context.providerSessionId } }
        : {}),
    });

    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const updateProviderSessionId = (context: CommandCodeSessionContext, line: string): void => {
      const sessionId = parseCommandCodeSessionLine(line);
      if (!sessionId || context.providerSessionId === sessionId) return;
      context.providerSessionId = sessionId;
      context.session = snapshotSession(context);
      offerEvent({
        ...eventBase(context),
        type: "thread.started",
        payload: { providerThreadId: sessionId },
        raw: { source: "command-code.cli.event", method: "session", payload: { sessionId } },
      } satisfies ProviderRuntimeEvent);
    };

    const consumeStderr = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      chunk: string,
    ) => {
      active.stderr += chunk;
      active.stderrLineBuffer += chunk;
      const lines = active.stderrLineBuffer.split(/\r?\n/u);
      active.stderrLineBuffer = lines.pop() ?? "";
      for (const line of lines) updateProviderSessionId(context, line);
    };

    const terminateTurnWithError = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      error: Error,
    ): void => {
      if (active.settled || active.failure) return;
      active.failure = error;
      void teardownChildProcessTree(active.child, teardown)
        .catch(() => undefined)
        .then(() => finishTurn(context, active, null, null, error));
    };

    const emitAssistantChunk = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      chunk: string,
    ): void => {
      if (!chunk) return;
      if (!active.stdoutStarted) {
        active.stdoutStarted = true;
        offerEvent({
          ...eventBase(context, { turnId: active.turnId, itemId: active.itemId }),
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
          raw: { source: "command-code.cli.event", method: "stdout/start", payload: null },
        } satisfies ProviderRuntimeEvent);
      }
      active.output += chunk;
      offerEvent({
        ...eventBase(context, { turnId: active.turnId, itemId: active.itemId }),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: chunk },
        raw: { source: "command-code.cli.event", method: "stdout", payload: chunk },
      } satisfies ProviderRuntimeEvent);
    };

    const finishTurn = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      processError?: unknown,
    ): void => {
      if (active.settled) return;
      active.settled = true;
      updateProviderSessionId(context, active.stderrLineBuffer);
      const interrupted = active.interrupted || exitCode === 130;
      const failure = active.failure ?? (processError instanceof Error ? processError : undefined);
      const succeeded = exitCode === 0 && failure === undefined;
      const state = interrupted ? "interrupted" : succeeded ? "completed" : "failed";
      const message =
        interrupted || succeeded
          ? undefined
          : failure
            ? failure.message
            : processErrorMessage(active.stderr, exitCode);

      if (active.stdoutStarted) {
        offerEvent({
          ...eventBase(context, { turnId: active.turnId, itemId: active.itemId }),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: succeeded ? "completed" : "failed",
            title: "Assistant",
          },
          raw: {
            source: "command-code.cli.event",
            method: "stdout/complete",
            payload: { exitCode, signal },
          },
        } satisfies ProviderRuntimeEvent);
      }
      if (message) {
        offerEvent({
          ...eventBase(context, { turnId: active.turnId }),
          type: "runtime.error",
          payload: { message, class: "provider_error", detail: { exitCode, signal } },
          raw: {
            source: "command-code.cli.event",
            method: "process/error",
            payload: { exitCode, signal, message },
          },
        } satisfies ProviderRuntimeEvent);
      }
      offerEvent({
        ...eventBase(context, { turnId: active.turnId }),
        type: "turn.completed",
        payload: {
          state,
          stopReason: interrupted ? "user_cancel" : succeeded ? null : "error",
          ...(message ? { errorMessage: message } : {}),
        },
        raw: {
          source: "command-code.cli.event",
          method: "process/exit",
          payload: { exitCode, signal },
        },
      } satisfies ProviderRuntimeEvent);

      const turn = context.turns.find((candidate) => candidate.id === active.turnId);
      if (turn && active.output) {
        turn.items.push({ type: "assistant_message", text: active.output });
      }
      if (context.active === active) context.active = undefined;
      context.session = snapshotSession(context);
    };

    const startSession: CommandCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const now = new Date().toISOString();
        const providerSessionId = readResumeSessionId(input.resumeCursor);
        const binaryPath = input.providerOptions?.commandCode?.binaryPath?.trim() || DEFAULT_BINARY;
        const cwd = input.cwd ?? process.cwd();
        const env = buildProviderChildEnvironment({ provider: PROVIDER });
        const executable = yield* Effect.try({
          try: () => resolveExecutable(binaryPath, { cwd, env }),
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        const model =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : DEFAULT_MODEL;
        const existing = sessions.get(input.threadId);
        if (existing) {
          existing.stopped = true;
          sessions.delete(input.threadId);
          if (existing.active) {
            existing.active.interrupted = true;
            yield* Effect.promise(() => teardownChildProcessTree(existing.active.child, teardown));
          }
        }
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
          cwd,
          model,
          ...(providerSessionId ? { resumeCursor: { sessionId: providerSessionId } } : {}),
        };
        const context: CommandCodeSessionContext = {
          session,
          ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
          executable,
          ...(providerSessionId ? { providerSessionId } : {}),
          turns: [],
          stopped: false,
        };
        sessions.set(input.threadId, context);
        offerEvent({
          ...eventBase(context),
          type: "session.started",
          payload: { message: "Command Code session ready", resume: session.resumeCursor },
          raw: { source: "command-code.cli.event", method: "session/start", payload: null },
        } satisfies ProviderRuntimeEvent);
        offerEvent({
          ...eventBase(context),
          type: "thread.started",
          payload: providerSessionId ? { providerThreadId: providerSessionId } : {},
          raw: {
            source: "command-code.cli.event",
            method: "thread/start",
            payload: providerSessionId ? { sessionId: providerSessionId } : null,
          },
        } satisfies ProviderRuntimeEvent);
        return session;
      });

    const buildPrompt = (input: Parameters<CommandCodeAdapterShape["sendTurn"]>[0]) =>
      Effect.tryPromise({
        try: async () => {
          const userText =
            appendFileAttachmentsPromptBlock({
              text: input.input,
              attachments: input.attachments,
              attachmentsDir: serverConfig.attachmentsDir,
              include: "all-files",
            }) ?? "";
          const skillText = await buildInlineSkillInstructions({
            provider: PROVIDER,
            skills: input.skills ?? [],
            maxChars: 48_000,
          });
          const mentionText = (input.mentions ?? [])
            .map(
              (mention) =>
                `<mention name=${JSON.stringify(mention.name)} path=${JSON.stringify(mention.path)} />`,
            )
            .join("\n");
          return [skillText, mentionText, userText].filter(Boolean).join("\n\n").trim();
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt/build",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

    const sendTurn: CommandCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.stopped) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "The Command Code session has been stopped.",
          });
        }
        if (context.active) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "A Command Code turn is already active for this thread.",
          });
        }
        const prompt = yield* buildPrompt(input);
        if (!prompt) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Command Code requires a non-empty prompt.",
          });
        }
        const selectedModel =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.model
            : context.session.model;
        const cwd = context.session.cwd ?? process.cwd();
        const env = buildProviderChildEnvironment({ provider: PROVIDER });
        const executable = context.executable;
        const args = buildCommandCodeTurnArgs({
          ...(context.providerSessionId ? { providerSessionId: context.providerSessionId } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          runtimeMode: context.session.runtimeMode,
          plan: input.interactionMode === "plan",
        });
        const prepared = prepareWindowsSafeProcess(executable, args, { cwd, env });
        const child = yield* Effect.try({
          try: () =>
            spawnProcess(prepared.command, prepared.args, {
              cwd,
              env,
              stdio: ["pipe", "pipe", "pipe"],
              shell: prepared.shell,
              windowsHide: prepared.windowsHide,
              windowsVerbatimArguments: prepared.windowsVerbatimArguments,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause instanceof Error ? cause.message : "Failed to launch Command Code.",
              cause,
            }),
        });
        const turnId = TurnId.makeUnsafe(randomUUID());
        const active: ActiveCommandCodeTurn = {
          turnId,
          itemId: RuntimeItemId.makeUnsafe(`command-code-assistant-${randomUUID()}`),
          child,
          stdoutDecoder: new StringDecoder("utf8"),
          stderrDecoder: new StringDecoder("utf8"),
          stderr: "",
          stderrLineBuffer: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutStarted: false,
          output: "",
          interrupted: false,
          settled: false,
        };
        context.active = active;
        context.turns.push({ id: turnId, items: [] });
        context.session = {
          ...snapshotSession(context),
          ...(selectedModel ? { model: selectedModel } : {}),
        };
        offerEvent({
          ...eventBase(context, { turnId }),
          type: "turn.started",
          payload: selectedModel ? { model: selectedModel } : {},
          raw: {
            source: "command-code.cli.event",
            method: "process/start",
            payload: { executable, args },
          },
        } satisfies ProviderRuntimeEvent);

        child.stdout?.on("data", (chunk: Buffer | string) => {
          active.stdoutBytes += chunkByteLength(chunk);
          if (active.stdoutBytes > MAX_STDOUT_BYTES) {
            terminateTurnWithError(
              context,
              active,
              new Error(`Command Code stdout exceeded ${MAX_STDOUT_BYTES} bytes.`),
            );
            return;
          }
          emitAssistantChunk(context, active, decodeChunk(active.stdoutDecoder, chunk));
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          active.stderrBytes += chunkByteLength(chunk);
          if (active.stderrBytes > MAX_STDERR_BYTES) {
            terminateTurnWithError(
              context,
              active,
              new Error(`Command Code stderr exceeded ${MAX_STDERR_BYTES} bytes.`),
            );
            return;
          }
          consumeStderr(context, active, decodeChunk(active.stderrDecoder, chunk));
        });
        child.once("error", (cause) =>
          terminateTurnWithError(
            context,
            active,
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
        );
        child.once("close", (code, signal) => {
          emitAssistantChunk(context, active, active.stdoutDecoder.end());
          consumeStderr(context, active, active.stderrDecoder.end());
          finishTurn(context, active, code, signal);
        });
        child.stdin?.once("error", (cause) =>
          terminateTurnWithError(
            context,
            active,
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
        );
        child.stdin?.end(prompt);

        return {
          threadId: input.threadId,
          turnId,
          ...(context.providerSessionId
            ? { resumeCursor: { sessionId: context.providerSessionId } }
            : {}),
        };
      });

    const interruptTurn: CommandCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const active = context.active;
        if (!active || (turnId && active.turnId !== turnId)) return;
        active.interrupted = true;
        yield* Effect.promise(() => teardownChildProcessTree(active.child, teardown));
      });

    const stopSession: CommandCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.stopped = true;
        sessions.delete(threadId);
        const active = context.active;
        if (active) {
          active.interrupted = true;
          yield* Effect.promise(() => teardownChildProcessTree(active.child, teardown));
        }
        offerEvent({
          ...eventBase(context),
          type: "thread.state.changed",
          payload: { state: "closed", detail: { reason: "stopped" } },
        } satisfies ProviderRuntimeEvent);
        offerEvent({
          ...eventBase(context),
          type: "session.exited",
          payload: { reason: "stopped", exitKind: "graceful" },
        } satisfies ProviderRuntimeEvent);
      });

    const readThread: CommandCodeAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.map(
          (context) =>
            ({
              threadId,
              turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
              ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
            }) satisfies ProviderThreadSnapshot,
        ),
      );

    const unsupported = (threadId: ThreadId, method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Command Code's headless CLI does not support '${method}' for thread ${threadId}.`,
        }),
      );

    const listModels: NonNullable<CommandCodeAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          new Promise<ProviderListModelsResult>((resolve, reject) => {
            const cwd = input.cwd ?? process.cwd();
            const env = buildProviderChildEnvironment({ provider: PROVIDER });
            const configured = input.binaryPath?.trim() || DEFAULT_BINARY;
            const executable = resolveExecutable(configured, { cwd, env });
            const prepared = prepareWindowsSafeProcess(executable, ["--list-models"], { cwd, env });
            const child = spawnProcess(prepared.command, prepared.args, {
              cwd,
              env,
              stdio: ["ignore", "pipe", "pipe"],
              shell: prepared.shell,
              windowsHide: prepared.windowsHide,
              windowsVerbatimArguments: prepared.windowsVerbatimArguments,
            });
            let stdout = "";
            let stderr = "";
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let settled = false;
            const stdoutDecoder = new StringDecoder("utf8");
            const stderrDecoder = new StringDecoder("utf8");
            const finish = (error?: Error, result?: ProviderListModelsResult): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              if (error) reject(error);
              else if (result) resolve(result);
            };
            const terminate = (error: Error): void => {
              if (settled) return;
              void teardownChildProcessTree(child, teardown)
                .catch(() => undefined)
                .then(() => finish(error));
            };
            const timeout = setTimeout(
              () => terminate(new Error("Command Code model discovery timed out.")),
              MODEL_LIST_TIMEOUT_MS,
            );
            child.stdout?.on("data", (chunk: Buffer | string) => {
              stdoutBytes += chunkByteLength(chunk);
              if (stdoutBytes > MAX_MODEL_LIST_BYTES) {
                terminate(
                  new Error(
                    `Command Code model discovery stdout exceeded ${MAX_MODEL_LIST_BYTES} bytes.`,
                  ),
                );
                return;
              }
              stdout += decodeChunk(stdoutDecoder, chunk);
            });
            child.stderr?.on("data", (chunk: Buffer | string) => {
              stderrBytes += chunkByteLength(chunk);
              if (stderrBytes > MAX_MODEL_LIST_BYTES) {
                terminate(
                  new Error(
                    `Command Code model discovery stderr exceeded ${MAX_MODEL_LIST_BYTES} bytes.`,
                  ),
                );
                return;
              }
              stderr += decodeChunk(stderrDecoder, chunk);
            });
            child.once("error", (cause) =>
              terminate(cause instanceof Error ? cause : new Error(String(cause))),
            );
            child.once("close", (code) => {
              stdout += stdoutDecoder.end();
              stderr += stderrDecoder.end();
              if (code !== 0) {
                finish(new Error(processErrorMessage(stderr, code)));
                return;
              }
              const models = parseCommandCodeModelList(stdout);
              if (models.length === 0) {
                finish(new Error("Command Code model discovery returned no models."));
                return;
              }
              finish(undefined, { models, source: "command-code.cli", cached: false });
            });
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

    const stopAll: CommandCodeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        Array.from(sessions.keys()),
        (threadId) => stopSession(threadId).pipe(Effect.catch(() => Effect.void)),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ensuring(options?.nativeEventLogger?.close() ?? Effect.void),
        Effect.ensuring(Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsTurnSteering: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (threadId) => unsupported(threadId, "request/respond"),
      respondToUserInput: (threadId) => unsupported(threadId, "user-input/respond"),
      stopSession,
      listSessions: () => Effect.sync(() => Array.from(sessions.values(), snapshotSession)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread,
      rollbackThread: (threadId) => unsupported(threadId, "thread/rollback"),
      stopAll,
      listModels,
      getComposerCapabilities: () =>
        Effect.succeed({
          provider: PROVIDER,
          supportsSkillMentions: true,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: false,
          supportsThreadImport: false,
        } satisfies ProviderComposerCapabilities),
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies CommandCodeAdapterShape;
  });

export const CommandCodeAdapterLive = Layer.effect(CommandCodeAdapter, makeCommandCodeAdapter());

export function makeCommandCodeAdapterLive(options?: CommandCodeAdapterLiveOptions) {
  return Layer.effect(CommandCodeAdapter, makeCommandCodeAdapter(options));
}
