/**
 * Command Code v1 adapter backed by the CLI's supported headless JSON interface.
 *
 * Synara owns the session/process lifecycle: one
 * `commandcode -p --output-format json` process runs per turn, emits newline-delimited v1
 * events, and resumes with the structured print-session identifier. The adapter
 * projects supported text, reasoning, tool, usage, and result records while
 * ignoring unknown upstream event types for forward compatibility.
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
  type ThreadTokenUsageSnapshot,
} from "@synara/contracts";
import { resolveCommandCodeCliExecutableAsync } from "@synara/shared/commandCodeCliExecutable";
import { Effect, Exit, Layer, Queue, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  CommandCodeHeadlessProtocolParser,
  parseCommandCodePrintSessionId,
  projectCommandCodeRunStartEvent,
  projectCommandCodeTextDeltaEvent,
  projectCommandCodeThinkingDeltaEvent,
  projectCommandCodeToolEvent,
  type CommandCodeHeadlessRecord,
  type CommandCodeHeadlessResultRecord,
  type CommandCodeToolEvent,
} from "../commandCodeHeadlessProtocol.ts";
import { prepareWindowsProviderProcessAsync } from "../windowsProviderProcess.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildInlineSkillInstructions } from "../skillPromptInjection.ts";
import {
  findProviderProcessExitUnprovenError,
  teardownChildProcessTree,
} from "../supervisedProcessTeardown.ts";
import {
  makeProviderMaintenanceOwnedResourceCoordinator,
  type ProviderMaintenanceOwnedResourceCoordinator,
} from "../providerMaintenanceOwnedResources.ts";
import {
  makeProviderProcessOwnerTracker,
  type TrackedProviderProcessOwner,
} from "../providerProcessOwnerTracker.ts";
import {
  installPreparedNodeProcessSupervisor,
  type NodeProviderProcessSupervisor,
  observeNodeProviderProcessSpawn,
  supervisePreparedNodeProcess,
  windowsJobNodeProcessSupervisor,
} from "../windowsJobProcessSupervisor.ts";
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
const MAX_PROJECTED_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_HEADLESS_RECORDS = 1_048_576;
const MAX_TOOL_DETAIL_LENGTH = 4_096;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_MODEL_LIST_BYTES = 2 * 1024 * 1024;
const MODEL_LIST_TIMEOUT_MS = 15_000;
const PENDING_OWNERSHIP_DRAIN_TIMEOUT_MS = 15_000;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

type SpawnProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;
type TeardownProcessTree = (child: ChildProcess) => Promise<unknown>;
type ResolveExecutable = (
  command: string,
  input: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  },
) => string | Promise<string>;
type PrepareCommandCodeProcess = (
  ...args: Parameters<typeof prepareWindowsProviderProcessAsync>
) =>
  | Awaited<ReturnType<typeof prepareWindowsProviderProcessAsync>>
  | ReturnType<typeof prepareWindowsProviderProcessAsync>;

export interface CommandCodeAdapterLiveOptions {
  readonly spawnProcess?: SpawnProcess;
  readonly prepareProcess?: PrepareCommandCodeProcess;
  readonly teardownProcessTree?: TeardownProcessTree;
  readonly resolveExecutable?: ResolveExecutable;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly platform?: NodeJS.Platform;
  readonly superviseProcess?: typeof supervisePreparedNodeProcess;
  readonly maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator;
}

interface CommandCodeTurn {
  readonly id: TurnId;
  readonly items: unknown[];
}

interface CommandCodeTextSegment {
  readonly kind: "assistant" | "reasoning";
  readonly itemId: RuntimeItemId;
  readonly chunks: string[];
  settled: boolean;
}

interface ActiveCommandCodeTurn {
  readonly turnId: TurnId;
  readonly maxTurns: number;
  readonly child: ChildProcess;
  readonly stdoutParser: CommandCodeHeadlessProtocolParser;
  readonly stderrDecoder: StringDecoder;
  readonly toolItems: Map<
    string,
    {
      readonly itemId: RuntimeItemId;
      readonly toolName: string;
      settled: boolean;
    }
  >;
  stderr: string;
  stderrBytes: number;
  projectedOutputBytes: number;
  headlessRecordCount: number;
  observedSessionId?: string;
  hasAssistantText: boolean;
  readonly textSegments: CommandCodeTextSegment[];
  activeTextSegment?: CommandCodeTextSegment;
  result?: CommandCodeHeadlessResultRecord;
  interrupted: boolean;
  settled: boolean;
  failure?: Error;
  settlementOwnedByTeardown: boolean;
  teardownPromise?: Promise<unknown>;
}

interface CommandCodeSessionContext {
  session: ProviderSession;
  readonly lifecycleGeneration?: string;
  readonly executable: string;
  resumeSessionSelector?: string;
  providerSessionId?: string;
  cumulativeProcessedTokens: number;
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

interface CommandCodeResumeCursor {
  readonly sessionId: string;
  readonly totalProcessedTokens: number;
}

interface PendingCommandCodeProcessOwnership {
  readonly child: ChildProcess;
  establishment: Promise<void>;
  cancelled: boolean;
  committed: boolean;
  teardownPromise?: Promise<unknown>;
}

function isPathLikeExecutable(command: string): boolean {
  return Path.isAbsolute(command) || Path.win32.isAbsolute(command) || /[\\/]/u.test(command);
}

async function resolveAndValidateExecutable(
  command: string,
  input: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  },
): Promise<string> {
  const executable = await resolveCommandCodeCliExecutableAsync(command, input);
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
    "--output-format",
    "json",
    "--skip-onboarding",
    "--trust",
    "--no-auto-update",
    "--max-turns",
    String(input.maxTurns ?? DEFAULT_MAX_TURNS),
    ...(input.providerSessionId ? ["--resume", input.providerSessionId] : []),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.plan ? ["--plan"] : []),
    ...(input.runtimeMode === "full-access" && !input.plan ? ["--yolo"] : []),
  ];
}

function readCommandCodeResumeCursor(value: unknown): CommandCodeResumeCursor | undefined {
  if (typeof value === "string") {
    const sessionId = parseCommandCodePrintSessionId(value);
    return sessionId ? { sessionId, totalProcessedTokens: 0 } : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const cursor = value as { sessionId?: unknown; totalProcessedTokens?: unknown };
  const sessionId = parseCommandCodePrintSessionId(cursor.sessionId);
  const totalProcessedTokens =
    cursor.totalProcessedTokens === undefined ? 0 : nonNegativeInteger(cursor.totalProcessedTokens);
  return sessionId && totalProcessedTokens !== undefined
    ? { sessionId, totalProcessedTokens }
    : undefined;
}

export function commandCodeExitCodeMessage(
  exitCode: number | null,
  maxTurns = DEFAULT_MAX_TURNS,
): string | undefined {
  switch (exitCode) {
    case 3:
      return "Command Code is not authenticated. Run `cmdc login` on native Windows or `commandcode login` on macOS/Linux, then try again.";
    case 4:
      return "Command Code could not continue because the requested operation was denied.";
    case 5:
      return "Command Code was rate limited. Wait briefly, then try again.";
    case 6:
      return "Command Code could not reach its model provider because of a network failure.";
    case 7:
      return "Command Code's model provider returned an API server error.";
    case 8:
      return `Command Code reached the configured ${maxTurns}-turn limit.`;
    case 9:
      return "Command Code's model produced no response.";
    case 10:
      return "Command Code cannot continue because the configured account has insufficient credits.";
    default:
      return undefined;
  }
}

function processErrorMessage(
  stderr: string,
  exitCode: number | null,
  maxTurns = DEFAULT_MAX_TURNS,
): string {
  const documentedMessage = commandCodeExitCodeMessage(exitCode, maxTurns);
  if (documentedMessage) return documentedMessage;
  const lines = stripAnsi(stderr)
    .split(/[\r\n]+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? `Command Code exited with code ${exitCode ?? "unknown"}.`;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeCommandCodeTokenUsage(
  result: CommandCodeHeadlessResultRecord,
  toolUses: number,
  previousTotalProcessedTokens = 0,
): ThreadTokenUsageSnapshot | undefined {
  const inputTokens = nonNegativeInteger(result.usage.inputTokens);
  const outputTokens = nonNegativeInteger(result.usage.outputTokens);
  const cacheReadTokens = nonNegativeInteger(result.usage.cacheReadTokens);
  const cacheWriteTokens = nonNegativeInteger(result.usage.cacheWriteTokens);
  const previousTotal = nonNegativeInteger(previousTotalProcessedTokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined ||
    previousTotal === undefined
  ) {
    return undefined;
  }
  // Command Code maps AI SDK totalUsage.inputTokens directly. Cache reads and
  // writes are details within that total, so adding them would double count.
  // Synara's totalProcessedTokens is a running per-thread counter, while the
  // remaining counters describe the just-completed Command Code run.
  const usedTokens = inputTokens + outputTokens;
  const totalProcessedTokens = previousTotal + usedTokens;
  if (!Number.isSafeInteger(usedTokens) || !Number.isSafeInteger(totalProcessedTokens)) {
    return undefined;
  }
  const durationMs = nonNegativeInteger(Math.floor(result.durationMs));
  return {
    usedTokens,
    totalProcessedTokens,
    inputTokens,
    cachedInputTokens: cacheReadTokens,
    outputTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cacheReadTokens,
    lastOutputTokens: outputTokens,
    toolUses,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function compactCommandCodeValue(value: unknown): unknown {
  const maxBytes = 64 * 1024;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") <= maxBytes) return value;
  const previewBytes = Buffer.from(serialized, "utf8").subarray(0, maxBytes);
  let preview = previewBytes.toString("utf8");
  if (preview.endsWith("\uFFFD")) preview = preview.slice(0, -1);
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    preview,
  };
}

function compactCommandCodeDetail(value: string, fallback: string): string {
  const detail = value.trim() || fallback;
  if (detail.length <= MAX_TOOL_DETAIL_LENGTH) return detail;
  let end = MAX_TOOL_DETAIL_LENGTH;
  const lastIncludedCodeUnit = detail.charCodeAt(end - 1);
  const firstExcludedCodeUnit = detail.charCodeAt(end);
  if (
    lastIncludedCodeUnit >= 0xd800 &&
    lastIncludedCodeUnit <= 0xdbff &&
    firstExcludedCodeUnit >= 0xdc00 &&
    firstExcludedCodeUnit <= 0xdfff
  ) {
    end -= 1;
  }
  return `${detail.slice(0, end)}…`;
}

const makeCommandCodeAdapter = (options?: CommandCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, CommandCodeSessionContext>();
    const spawnProcess = options?.spawnProcess ?? spawn;
    const prepareProcess = options?.prepareProcess ?? prepareWindowsProviderProcessAsync;
    const teardown = options?.teardownProcessTree;
    const resolveExecutable = options?.resolveExecutable ?? resolveAndValidateExecutable;
    const processSupervisors = new WeakMap<ChildProcess, NodeProviderProcessSupervisor>();
    const processOwners = new WeakMap<ChildProcess, TrackedProviderProcessOwner>();
    const pendingProcessOwnerships = new Set<PendingCommandCodeProcessOwnership>();
    let stopAllDepth = 0;
    let processDrainGeneration = 0;
    const maintenanceOwnedResources =
      options?.maintenanceOwnedResources ??
      (yield* makeProviderMaintenanceOwnedResourceCoordinator);
    const processOwnerTracker = makeProviderProcessOwnerTracker({
      provider: PROVIDER,
      resourcePrefix: "command-code-process",
      maintenanceOwnedResources,
    });

    const superviseProcess = (
      prepared: Awaited<ReturnType<typeof prepareWindowsProviderProcessAsync>>,
      child: ChildProcess,
    ): Promise<void> | undefined => {
      const spawnOutcome = observeNodeProviderProcessSpawn(child);
      const install = (): void => {
        let supervisor: NodeProviderProcessSupervisor | undefined;
        try {
          const installation = installPreparedNodeProcessSupervisor(
            prepared,
            child,
            {
              platform: options?.platform ?? globalThis.process.platform,
              ...((options?.platform ?? globalThis.process.platform) === "win32"
                ? {}
                : { ownedProcessGroupId: Number(child.pid) }),
            },
            options?.superviseProcess,
          );
          supervisor = installation.supervisor;
          processSupervisors.set(child, supervisor);
          processOwners.set(child, Effect.runSync(processOwnerTracker.register(supervisor)));
          if (installation._tag === "Recovered") {
            throw installation.requestedSupervisorFailure;
          }
        } catch (cause) {
          const retainedOwner = supervisor ? processOwnerTracker.findOwner(supervisor) : undefined;
          if (retainedOwner) processOwners.set(child, retainedOwner);
          child.once("error", () => undefined);
          throw cause;
        }
      };
      const rootPid = Number(child.pid);
      if (Number.isInteger(rootPid) && rootPid > 0) {
        install();
        return undefined;
      }
      return spawnOutcome.then((outcome) => {
        if (outcome._tag !== "Spawned") throw outcome.cause;
        install();
      });
    };

    const teardownProcess = (child: ChildProcess): Promise<unknown> => {
      const owner = processOwners.get(child);
      return owner
        ? Effect.runPromise(processOwnerTracker.teardown(owner))
        : (processSupervisors.get(child)?.teardown() ??
            (teardown ? teardown(child) : teardownChildProcessTree(child)));
    };

    const establishProcessOwnership = async (
      prepared: Awaited<ReturnType<typeof prepareWindowsProviderProcessAsync>>,
      child: ChildProcess,
    ): Promise<void> => {
      try {
        await superviseProcess(prepared, child);
      } catch (cause) {
        const ownershipError = cause instanceof Error ? cause : new Error(String(cause));
        const rootPid = Number(child.pid);
        const hasLiveProcessCandidate =
          processOwners.has(child) ||
          processSupervisors.has(child) ||
          (Number.isInteger(rootPid) && rootPid > 0);
        if (!hasLiveProcessCandidate) throw ownershipError;
        try {
          await teardownProcess(child);
        } catch (teardownCause) {
          throw new AggregateError(
            [
              ownershipError,
              teardownCause instanceof Error ? teardownCause : new Error(String(teardownCause)),
            ],
            ownershipError.message,
          );
        }
        throw ownershipError;
      }
    };

    const beginPendingProcessOwnership = (
      prepared: Awaited<ReturnType<typeof prepareWindowsProviderProcessAsync>>,
      child: ChildProcess,
    ): PendingCommandCodeProcessOwnership => {
      const pending: PendingCommandCodeProcessOwnership = {
        child,
        establishment: Promise.resolve(),
        cancelled: false,
        committed: false,
      };
      pendingProcessOwnerships.add(pending);
      pending.establishment = establishProcessOwnership(prepared, child);
      void pending.establishment.catch(() => {
        pendingProcessOwnerships.delete(pending);
      });
      return pending;
    };

    const commitPendingProcessOwnership = (
      pending: PendingCommandCodeProcessOwnership,
    ): boolean => {
      if (pending.cancelled) return false;
      pending.committed = true;
      pendingProcessOwnerships.delete(pending);
      return true;
    };

    const beginPendingProcessTeardown = (
      pending: PendingCommandCodeProcessOwnership,
    ): Promise<unknown> => {
      pending.cancelled = true;
      if (pending.committed) return Promise.resolve();
      if (pending.teardownPromise === undefined) {
        const attempt = pending.establishment
          .then(() => teardownProcess(pending.child))
          .finally(() => pendingProcessOwnerships.delete(pending));
        pending.teardownPromise = attempt;
        void attempt.catch(() => undefined);
      }
      return pending.teardownPromise;
    };

    const awaitPendingProcessTeardown = (
      pending: PendingCommandCodeProcessOwnership,
    ): Promise<unknown> => {
      const teardownPromise = beginPendingProcessTeardown(pending);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out after ${String(PENDING_OWNERSHIP_DRAIN_TIMEOUT_MS)}ms while waiting for a spawned Command Code process to establish teardown ownership.`,
              ),
            ),
          PENDING_OWNERSHIP_DRAIN_TIMEOUT_MS,
        );
        void teardownPromise.then(
          (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          (cause) => {
            clearTimeout(timeout);
            reject(cause);
          },
        );
      });
    };

    const proveProcessExit = (child: ChildProcess): Promise<unknown> => {
      const owner = processOwners.get(child);
      if (owner) return Effect.runPromise(processOwnerTracker.proveExit(owner));
      const supervisor = processSupervisors.get(child) ?? windowsJobNodeProcessSupervisor(child);
      return supervisor ? supervisor.proveExit() : Promise.resolve();
    };

    const beginTurnTeardown = (active: ActiveCommandCodeTurn): Promise<unknown> => {
      if (active.teardownPromise === undefined) {
        const attempt = Promise.resolve().then(() => teardownProcess(active.child));
        active.teardownPromise = attempt;
        void attempt.catch(() => {
          if (active.teardownPromise === attempt) delete active.teardownPromise;
        });
      }
      return active.teardownPromise;
    };

    const teardownTurn = (active: ActiveCommandCodeTurn, method: string) =>
      Effect.tryPromise({
        try: () => beginTurnTeardown(active),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail:
              cause instanceof Error
                ? cause.message
                : "Failed to prove Command Code process-tree exit.",
            cause,
          }),
      }).pipe(Effect.asVoid);

    const offerEvent = (event: ProviderRuntimeEvent): void => {
      Effect.runSyncExit(Queue.offer(runtimeEventQueue, event));
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

    const resumeCursorForContext = (
      context: CommandCodeSessionContext,
    ): CommandCodeResumeCursor | undefined => {
      const sessionId = context.providerSessionId ?? context.resumeSessionSelector;
      return sessionId
        ? { sessionId, totalProcessedTokens: context.cumulativeProcessedTokens }
        : undefined;
    };

    const snapshotSession = (context: CommandCodeSessionContext): ProviderSession => {
      const resumeCursor = resumeCursorForContext(context);
      return {
        ...context.session,
        status: context.stopped ? "closed" : context.active ? "running" : "ready",
        updatedAt: new Date().toISOString(),
        ...(context.active ? { activeTurnId: context.active.turnId } : {}),
        ...(resumeCursor ? { resumeCursor } : {}),
      };
    };

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CommandCodeSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const updateProviderSessionId = (
      context: CommandCodeSessionContext,
      sessionId: string,
      method: string,
    ): void => {
      if (
        !sessionId ||
        (context.providerSessionId === sessionId && context.resumeSessionSelector === sessionId)
      ) {
        return;
      }
      context.providerSessionId = sessionId;
      context.resumeSessionSelector = sessionId;
      context.session = snapshotSession(context);
      offerEvent({
        ...eventBase(context),
        type: "thread.started",
        payload: { providerThreadId: sessionId },
        raw: { source: "command-code.cli.event", method, payload: { sessionId } },
      } satisfies ProviderRuntimeEvent);
    };

    const consumeStderr = (active: ActiveCommandCodeTurn, chunk: string) => {
      active.stderr += chunk;
    };

    const terminateTurnWithError = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      error: Error,
    ): void => {
      if (active.settled || active.settlementOwnedByTeardown) return;
      active.failure = error;
      active.settlementOwnedByTeardown = true;
      void beginTurnTeardown(active).then(
        () => {
          active.settlementOwnedByTeardown = false;
          finishTurn(context, active, null, null, error);
        },
        (teardownError) => {
          const aggregate = new AggregateError([error, teardownError], error.message);
          active.failure = aggregate;
          active.settlementOwnedByTeardown = false;
          finishTurn(context, active, null, null, aggregate);
        },
      );
    };

    const observeProviderSessionId = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      sessionId: string,
      method: string,
    ): boolean => {
      if (active.observedSessionId && active.observedSessionId !== sessionId) {
        terminateTurnWithError(
          context,
          active,
          new Error(
            `Command Code changed session identifiers within one turn (expected ${active.observedSessionId}, received ${sessionId}).`,
          ),
        );
        return false;
      }
      active.observedSessionId = sessionId;
      updateProviderSessionId(context, sessionId, method);
      return true;
    };

    const completeTextSegment = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      segment: CommandCodeTextSegment,
      status: "completed" | "failed",
      method: string,
      payload: unknown,
    ): void => {
      if (segment.settled) return;
      segment.settled = true;
      if (active.activeTextSegment === segment) delete active.activeTextSegment;
      const assistant = segment.kind === "assistant";
      offerEvent({
        ...eventBase(context, { turnId: active.turnId, itemId: segment.itemId }),
        type: "item.completed",
        payload: {
          itemType: assistant ? "assistant_message" : "reasoning",
          status,
          title: assistant ? "Assistant" : "Reasoning",
        },
        raw: {
          source: "command-code.cli.event",
          method,
          payload,
        },
      } satisfies ProviderRuntimeEvent);
    };

    const completeActiveTextSegment = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      status: "completed" | "failed",
      method: string,
      payload: unknown,
    ): void => {
      const segment = active.activeTextSegment;
      if (segment) completeTextSegment(context, active, segment, status, method, payload);
    };

    const emitTextChunk = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      kind: "assistant" | "reasoning",
      chunk: string,
      method: string,
    ): void => {
      if (!chunk) return;
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (chunkBytes > MAX_PROJECTED_OUTPUT_BYTES - active.projectedOutputBytes) {
        terminateTurnWithError(
          context,
          active,
          new Error(`Command Code transcript output exceeded ${MAX_PROJECTED_OUTPUT_BYTES} bytes.`),
        );
        return;
      }
      active.projectedOutputBytes += chunkBytes;
      let segment = active.activeTextSegment;
      if (segment?.kind !== kind) {
        completeActiveTextSegment(context, active, "completed", "text/segment-complete", {
          nextKind: kind,
        });
        segment = {
          kind,
          itemId: RuntimeItemId.makeUnsafe(`command-code-${kind}-${randomUUID()}`),
          chunks: [],
          settled: false,
        };
        active.textSegments.push(segment);
        active.activeTextSegment = segment;
        const assistant = kind === "assistant";
        offerEvent({
          ...eventBase(context, { turnId: active.turnId, itemId: segment.itemId }),
          type: "item.started",
          payload: {
            itemType: assistant ? "assistant_message" : "reasoning",
            status: "inProgress",
            title: assistant ? "Assistant" : "Reasoning",
          },
          raw: { source: "command-code.cli.event", method: `${method}/start`, payload: null },
        } satisfies ProviderRuntimeEvent);
      }
      if (kind === "assistant") active.hasAssistantText = true;
      segment.chunks.push(chunk);
      offerEvent({
        ...eventBase(context, { turnId: active.turnId, itemId: segment.itemId }),
        type: "content.delta",
        payload: {
          streamKind: kind === "assistant" ? "assistant_text" : "reasoning_text",
          delta: chunk,
        },
        raw: { source: "command-code.cli.event", method, payload: chunk },
      } satisfies ProviderRuntimeEvent);
    };

    const emitAssistantChunk = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      chunk: string,
      method: string,
    ): void => {
      emitTextChunk(context, active, "assistant", chunk, method);
    };

    const emitReasoningChunk = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      chunk: string,
    ): void => {
      emitTextChunk(context, active, "reasoning", chunk, "event/thinking_delta");
    };

    const emitToolEvent = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      toolEvent: CommandCodeToolEvent,
    ): void => {
      let toolItem = active.toolItems.get(toolEvent.toolCallId);
      const detail =
        toolEvent.type === "tool_running"
          ? toolEvent.description
            ? compactCommandCodeDetail(toolEvent.description, "Tool is running.")
            : undefined
          : toolEvent.type === "tool_errored"
            ? compactCommandCodeDetail(toolEvent.error, "Tool execution failed.")
            : toolEvent.type === "tool_denied"
              ? "Tool permission was denied."
              : toolEvent.type === "tool_hook_blocked"
                ? compactCommandCodeDetail(toolEvent.hookOutput, "Blocked by a pre-tool hook.")
                : undefined;
      const data = compactCommandCodeValue({
        toolCallId: toolEvent.toolCallId,
        toolName: toolEvent.toolName,
        ...(toolEvent.type === "tool_queued" ? { input: toolEvent.input } : {}),
        ...(toolEvent.type === "tool_update" ? { partial: toolEvent.partial } : {}),
        ...(toolEvent.type === "tool_completed" ? { result: toolEvent.result } : {}),
        ...(toolEvent.type === "tool_errored" ? { error: toolEvent.error } : {}),
        ...(toolEvent.type === "tool_denied" ? { denied: true } : {}),
        ...(toolEvent.type === "tool_hook_blocked" ? { hookOutput: toolEvent.hookOutput } : {}),
      });

      if (toolItem === undefined) {
        toolItem = {
          itemId: RuntimeItemId.makeUnsafe(`command-code-tool-${randomUUID()}`),
          toolName: toolEvent.toolName,
          settled: false,
        };
        active.toolItems.set(toolEvent.toolCallId, toolItem);
        offerEvent({
          ...eventBase(context, { turnId: active.turnId, itemId: toolItem.itemId }),
          type: "item.started",
          payload: {
            itemType: "dynamic_tool_call",
            status: "inProgress",
            title: toolEvent.toolName,
            ...(detail ? { detail } : {}),
            data,
          },
          raw: {
            source: "command-code.cli.event",
            method: `event/${toolEvent.type}/start`,
            payload: data,
          },
        } satisfies ProviderRuntimeEvent);
      } else if (
        !toolItem.settled &&
        (toolEvent.type === "tool_queued" ||
          toolEvent.type === "tool_running" ||
          toolEvent.type === "tool_update")
      ) {
        offerEvent({
          ...eventBase(context, { turnId: active.turnId, itemId: toolItem.itemId }),
          type: "item.updated",
          payload: {
            itemType: "dynamic_tool_call",
            status: "inProgress",
            title: toolItem.toolName,
            ...(detail ? { detail } : {}),
            data,
          },
          raw: {
            source: "command-code.cli.event",
            method: `event/${toolEvent.type}`,
            payload: data,
          },
        } satisfies ProviderRuntimeEvent);
      }

      if (
        !toolItem.settled &&
        (toolEvent.type === "tool_completed" ||
          toolEvent.type === "tool_errored" ||
          toolEvent.type === "tool_denied" ||
          toolEvent.type === "tool_hook_blocked")
      ) {
        toolItem.settled = true;
        offerEvent({
          ...eventBase(context, { turnId: active.turnId, itemId: toolItem.itemId }),
          type: "item.completed",
          payload: {
            itemType: "dynamic_tool_call",
            status: toolEvent.type === "tool_completed" ? "completed" : "failed",
            title: toolItem.toolName,
            ...(detail ? { detail } : {}),
            data,
          },
          raw: {
            source: "command-code.cli.event",
            method: `event/${toolEvent.type}`,
            payload: data,
          },
        } satisfies ProviderRuntimeEvent);
      }
    };

    const consumeHeadlessRecords = (
      context: CommandCodeSessionContext,
      active: ActiveCommandCodeTurn,
      records: ReadonlyArray<CommandCodeHeadlessRecord>,
    ): void => {
      let pendingDeltaKind: "assistant" | "reasoning" | undefined;
      let pendingDeltaChunks: string[] = [];
      const flushPendingDelta = (): void => {
        if (pendingDeltaChunks.length === 0) return;
        const chunk = pendingDeltaChunks.join("");
        if (pendingDeltaKind === "assistant") {
          emitAssistantChunk(context, active, chunk, "event/text_delta");
        } else {
          emitReasoningChunk(context, active, chunk);
        }
        pendingDeltaKind = undefined;
        pendingDeltaChunks = [];
      };

      for (const record of records) {
        if (active.failure || active.settlementOwnedByTeardown || active.settled) break;
        active.headlessRecordCount += 1;
        if (active.headlessRecordCount > MAX_HEADLESS_RECORDS) {
          flushPendingDelta();
          if (!active.failure && !active.settlementOwnedByTeardown && !active.settled) {
            terminateTurnWithError(
              context,
              active,
              new Error(`Command Code emitted more than ${MAX_HEADLESS_RECORDS} headless records.`),
            );
          }
          break;
        }

        if (record.type === "result") {
          flushPendingDelta();
          if (active.failure || active.settlementOwnedByTeardown || active.settled) break;
          if (record.sessionId) {
            if (!observeProviderSessionId(context, active, record.sessionId, "result/session")) {
              break;
            }
          }
          active.result = record;
          if (!active.hasAssistantText && record.finalText) {
            emitAssistantChunk(context, active, record.finalText, "result/finalText");
          }
          continue;
        }

        const runStart = projectCommandCodeRunStartEvent(record);
        if (runStart) {
          flushPendingDelta();
          if (active.failure || active.settlementOwnedByTeardown || active.settled) break;
          if (!observeProviderSessionId(context, active, runStart.sessionId, "event/run_start")) {
            break;
          }
          continue;
        }
        const textDelta = projectCommandCodeTextDeltaEvent(record);
        if (textDelta) {
          if (pendingDeltaKind !== "assistant") {
            flushPendingDelta();
            pendingDeltaKind = "assistant";
          }
          pendingDeltaChunks.push(textDelta.delta);
          continue;
        }
        const thinkingDelta = projectCommandCodeThinkingDeltaEvent(record);
        if (thinkingDelta) {
          if (pendingDeltaKind !== "reasoning") {
            flushPendingDelta();
            pendingDeltaKind = "reasoning";
          }
          pendingDeltaChunks.push(thinkingDelta.delta);
          continue;
        }
        const toolEvent = projectCommandCodeToolEvent(record);
        if (toolEvent) {
          flushPendingDelta();
          if (active.failure || active.settlementOwnedByTeardown || active.settled) break;
          completeActiveTextSegment(context, active, "completed", "text/tool-boundary", {
            toolCallId: toolEvent.toolCallId,
            toolName: toolEvent.toolName,
          });
          emitToolEvent(context, active, toolEvent);
        }
      }
      if (!active.failure && !active.settlementOwnedByTeardown && !active.settled) {
        flushPendingDelta();
      }
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
      const interrupted = active.interrupted || exitCode === 130;
      const processFailure = processError instanceof Error ? processError : undefined;
      const failure =
        active.failure && processFailure && active.failure !== processFailure
          ? new AggregateError([active.failure, processFailure], active.failure.message)
          : (active.failure ?? processFailure);
      const result = active.result;
      const succeeded =
        !interrupted && exitCode === 0 && failure === undefined && result?.subtype === "success";
      const state = interrupted ? "interrupted" : succeeded ? "completed" : "failed";
      const message =
        interrupted || succeeded
          ? undefined
          : failure
            ? failure.message
            : result?.error
              ? result.error
              : result?.subtype === "max_turns"
                ? commandCodeExitCodeMessage(8, active.maxTurns)
                : processErrorMessage(active.stderr, exitCode, active.maxTurns);

      completeActiveTextSegment(
        context,
        active,
        succeeded ? "completed" : "failed",
        "text/turn-complete",
        { exitCode, signal, resultSubtype: result?.subtype },
      );
      for (const toolItem of active.toolItems.values()) {
        if (toolItem.settled) continue;
        toolItem.settled = true;
        offerEvent({
          ...eventBase(context, { turnId: active.turnId, itemId: toolItem.itemId }),
          type: "item.completed",
          payload: {
            itemType: "dynamic_tool_call",
            status: "failed",
            title: toolItem.toolName,
            detail: interrupted
              ? "Tool execution was interrupted."
              : "Command Code ended before reporting tool completion.",
          },
          raw: {
            source: "command-code.cli.event",
            method: "tool/incomplete",
            payload: { exitCode, signal },
          },
        } satisfies ProviderRuntimeEvent);
      }
      const normalizedUsage =
        failure === undefined && result
          ? normalizeCommandCodeTokenUsage(
              result,
              active.toolItems.size,
              context.cumulativeProcessedTokens,
            )
          : undefined;
      if (normalizedUsage) {
        context.cumulativeProcessedTokens =
          normalizedUsage.totalProcessedTokens ?? context.cumulativeProcessedTokens;
        context.session = snapshotSession(context);
        offerEvent({
          ...eventBase(context, { turnId: active.turnId }),
          type: "thread.token-usage.updated",
          payload: { usage: normalizedUsage },
          raw: {
            source: "command-code.cli.event",
            method: "result/usage",
            payload: {
              usage: result?.usage,
              durationMs: result?.durationMs,
            },
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
          stopReason: interrupted
            ? "user_cancel"
            : (result?.stopReason ??
              (result?.subtype === "max_turns" ? "max_turns" : succeeded ? null : "error")),
          ...(result ? { usage: result.usage } : {}),
          ...(message ? { errorMessage: message } : {}),
        },
        raw: {
          source: "command-code.cli.event",
          method: "result/complete",
          payload: {
            exitCode,
            signal,
            subtype: result?.subtype,
            sessionId: result?.sessionId,
            stopReason: result?.stopReason,
            usage: result?.usage,
            durationMs: result?.durationMs,
            error: result?.error,
          },
        },
      } satisfies ProviderRuntimeEvent);

      const turn = context.turns.find((candidate) => candidate.id === active.turnId);
      if (turn) {
        for (const segment of active.textSegments) {
          const text = segment.chunks.join("");
          if (text) {
            turn.items.push({
              type: segment.kind === "assistant" ? "assistant_message" : "reasoning",
              text,
            });
          }
        }
      }
      if (
        context.active === active &&
        findProviderProcessExitUnprovenError(failure ?? processError) === null
      ) {
        delete context.active;
      }
      context.session = snapshotSession(context);
    };

    const startSession: CommandCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (stopAllDepth > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "A Command Code session cannot start during stopAll.",
          });
        }
        const startGeneration = processDrainGeneration;
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const now = new Date().toISOString();
        const resumeCursor = readCommandCodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && resumeCursor === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue:
              "The Command Code resume cursor must contain a safe session identifier and an optional non-negative totalProcessedTokens counter.",
          });
        }
        const resumeSessionSelector = resumeCursor?.sessionId;
        const binaryPath = input.providerOptions?.commandCode?.binaryPath?.trim() || DEFAULT_BINARY;
        const cwd = input.cwd ?? process.cwd();
        const env = buildProviderChildEnvironment({ provider: PROVIDER });
        const platform = options?.platform ?? globalThis.process.platform;
        const executable = yield* Effect.tryPromise({
          try: () => Promise.resolve(resolveExecutable(binaryPath, { cwd, env, platform })),
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (stopAllDepth > 0 || processDrainGeneration !== startGeneration) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "A Command Code session cannot start across a stopAll boundary.",
          });
        }
        const model =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : DEFAULT_MODEL;
        const existing = sessions.get(input.threadId);
        if (existing) {
          existing.stopped = true;
          sessions.delete(input.threadId);
          const active = existing.active;
          if (active) {
            active.interrupted = true;
            yield* Effect.promise(() => teardownProcess(active.child));
          }
        }
        if (stopAllDepth > 0 || processDrainGeneration !== startGeneration) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "A Command Code session cannot start across a stopAll boundary.",
          });
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
          ...(resumeSessionSelector
            ? {
                resumeCursor: {
                  sessionId: resumeSessionSelector,
                  totalProcessedTokens: resumeCursor.totalProcessedTokens,
                },
              }
            : {}),
        };
        const context: CommandCodeSessionContext = {
          session,
          ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
          executable,
          ...(resumeSessionSelector ? { resumeSessionSelector } : {}),
          cumulativeProcessedTokens: resumeCursor?.totalProcessedTokens ?? 0,
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
          payload: {},
          raw: {
            source: "command-code.cli.event",
            method: "thread/start",
            payload: null,
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
        const platform = options?.platform ?? globalThis.process.platform;
        const executable = context.executable;
        const maxTurns = DEFAULT_MAX_TURNS;
        const resumeSessionId = context.providerSessionId ?? context.resumeSessionSelector;
        const args = buildCommandCodeTurnArgs({
          ...(resumeSessionId ? { providerSessionId: resumeSessionId } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          runtimeMode: context.session.runtimeMode,
          plan: input.interactionMode === "plan",
          maxTurns,
        });
        const prepared = yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              prepareProcess(executable, args, {
                cwd,
                env,
                platform,
              }),
            ),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause instanceof Error ? cause.message : "Failed to prepare Command Code.",
              cause,
            }),
        });
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (stopAllDepth > 0 || context.stopped || sessions.get(input.threadId) !== context) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "The Command Code session was stopped or replaced while preparing the turn.",
              });
            }
            const child = yield* Effect.try({
              try: () => {
                return spawnProcess(prepared.command, prepared.args, {
                  cwd,
                  detached: platform !== "win32",
                  env,
                  stdio: ["pipe", "pipe", "pipe"],
                  shell: prepared.shell,
                  windowsHide: prepared.windowsHide,
                  windowsVerbatimArguments: prepared.windowsVerbatimArguments,
                });
              },
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause instanceof Error ? cause.message : "Failed to launch Command Code.",
                  cause,
                }),
            });
            const pendingOwnership = beginPendingProcessOwnership(prepared, child);
            yield* restore(
              Effect.tryPromise({
                try: () => pendingOwnership.establishment,
                catch: (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail:
                      cause instanceof Error
                        ? cause.message
                        : "Failed to establish Command Code process ownership.",
                    cause,
                  }),
              }),
            ).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  void beginPendingProcessTeardown(pendingOwnership);
                }),
              ),
            );
            if (
              pendingOwnership.cancelled ||
              context.stopped ||
              sessions.get(input.threadId) !== context
            ) {
              yield* Effect.tryPromise({
                try: () => beginPendingProcessTeardown(pendingOwnership),
                catch: (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail:
                      cause instanceof Error
                        ? cause.message
                        : "Failed to stop the stale Command Code process.",
                    cause,
                  }),
              });
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "The Command Code session was stopped or replaced while launching the turn.",
              });
            }
            if (!commitPendingProcessOwnership(pendingOwnership)) {
              yield* Effect.promise(() => beginPendingProcessTeardown(pendingOwnership));
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "The Command Code process was cancelled while establishing ownership.",
              });
            }
            const turnId = TurnId.makeUnsafe(randomUUID());
            const active: ActiveCommandCodeTurn = {
              turnId,
              maxTurns,
              child,
              stdoutParser: new CommandCodeHeadlessProtocolParser(),
              stderrDecoder: new StringDecoder("utf8"),
              toolItems: new Map(),
              stderr: "",
              stderrBytes: 0,
              projectedOutputBytes: 0,
              headlessRecordCount: 0,
              ...(context.providerSessionId
                ? { observedSessionId: context.providerSessionId }
                : {}),
              hasAssistantText: false,
              textSegments: [],
              interrupted: false,
              settled: false,
              settlementOwnedByTeardown: false,
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
              try {
                consumeHeadlessRecords(context, active, active.stdoutParser.push(chunk));
              } catch (cause) {
                terminateTurnWithError(
                  context,
                  active,
                  cause instanceof Error ? cause : new Error(String(cause)),
                );
              }
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
              consumeStderr(active, decodeChunk(active.stderrDecoder, chunk));
            });
            child.once("error", (cause) =>
              terminateTurnWithError(
                context,
                active,
                cause instanceof Error ? cause : new Error(String(cause)),
              ),
            );
            child.once("close", (code, signal) => {
              consumeStderr(active, active.stderrDecoder.end());
              if (active.settlementOwnedByTeardown) return;
              if (!active.interrupted && code !== 130) {
                try {
                  consumeHeadlessRecords(context, active, active.stdoutParser.finish());
                } catch (cause) {
                  active.failure = cause instanceof Error ? cause : new Error(String(cause));
                }
              }
              void proveProcessExit(child)
                .then(() => finishTurn(context, active, code, signal))
                .catch((cause) =>
                  finishTurn(
                    context,
                    active,
                    code,
                    signal,
                    cause instanceof Error ? cause : new Error(String(cause)),
                  ),
                );
            });
            child.stdin?.once("error", (cause) =>
              terminateTurnWithError(
                context,
                active,
                cause instanceof Error ? cause : new Error(String(cause)),
              ),
            );
            child.stdin?.end(prompt);

            const turnResumeCursor = resumeCursorForContext(context);
            return {
              threadId: input.threadId,
              turnId,
              ...(turnResumeCursor ? { resumeCursor: turnResumeCursor } : {}),
            };
          }),
        );
      });

    const interruptTurn: CommandCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const active = context.active;
        if (!active || (turnId && active.turnId !== turnId)) return;
        active.interrupted = true;
        yield* teardownTurn(active, "turn/interrupt");
      });

    const stopSessionContext = (
      threadId: ThreadId,
      context: CommandCodeSessionContext,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        context.stopped = true;
        const active = context.active;
        if (active) {
          active.interrupted = true;
          yield* teardownTurn(active, "session/stop");
        }
        if (sessions.get(threadId) !== context) return;
        sessions.delete(threadId);
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

    const stopSession: CommandCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.flatMap(requireSession(threadId), (context) => stopSessionContext(threadId, context));

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
      Effect.gen(function* () {
        if (stopAllDepth > 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: "Command Code model discovery cannot start during stopAll.",
          });
        }
        const launchGeneration = processDrainGeneration;
        const cwd = input.cwd ?? process.cwd();
        const env = buildProviderChildEnvironment({ provider: PROVIDER });
        const platform = options?.platform ?? globalThis.process.platform;
        const configured = input.binaryPath?.trim() || DEFAULT_BINARY;
        const executable = yield* Effect.tryPromise({
          try: () => Promise.resolve(resolveExecutable(configured, { cwd, env, platform })),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "model/list",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
        const prepared = yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              prepareProcess(executable, ["--list-models"], {
                cwd,
                env,
                platform,
              }),
            ),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "model/list",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
        return yield* Effect.tryPromise({
          try: (signal) =>
            new Promise<ProviderListModelsResult>((resolve, reject) => {
              if (stopAllDepth > 0 || processDrainGeneration !== launchGeneration) {
                reject(new Error("Command Code model discovery cannot start during stopAll."));
                return;
              }
              const child = spawnProcess(prepared.command, prepared.args, {
                cwd,
                detached: platform !== "win32",
                env,
                stdio: ["ignore", "pipe", "pipe"],
                shell: prepared.shell,
                windowsHide: prepared.windowsHide,
                windowsVerbatimArguments: prepared.windowsVerbatimArguments,
              });
              const pendingOwnership = beginPendingProcessOwnership(prepared, child);
              let stdout = "";
              let stderr = "";
              let stdoutBytes = 0;
              let stderrBytes = 0;
              let settled = false;
              let settlementOwnedByTeardown = false;
              let collectionStarted = false;
              let timeout: ReturnType<typeof setTimeout> | undefined;
              const stdoutDecoder = new StringDecoder("utf8");
              const stderrDecoder = new StringDecoder("utf8");
              const interruptionError = new Error("Command Code model discovery was interrupted.");
              let onAbort = (): void => undefined;
              const finish = (error?: Error, result?: ProviderListModelsResult): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                signal.removeEventListener("abort", onAbort);
                if (error) reject(error);
                else if (result) resolve(result);
              };
              const terminate = (error: Error): void => {
                if (settled || settlementOwnedByTeardown) return;
                settlementOwnedByTeardown = true;
                void Promise.resolve()
                  .then(() =>
                    collectionStarted
                      ? teardownProcess(child)
                      : beginPendingProcessTeardown(pendingOwnership),
                  )
                  .then(
                    () => finish(error),
                    (teardownError) =>
                      finish(new AggregateError([error, teardownError], error.message)),
                  );
              };
              onAbort = () => terminate(interruptionError);
              const startCollection = (): void => {
                if (pendingOwnership.cancelled || signal.aborted) {
                  terminate(interruptionError);
                  return;
                }
                if (!commitPendingProcessOwnership(pendingOwnership)) {
                  terminate(interruptionError);
                  return;
                }
                collectionStarted = true;
                timeout = setTimeout(
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
                  if (settlementOwnedByTeardown) return;
                  void proveProcessExit(child)
                    .then(() => {
                      if (code !== 0) {
                        finish(new Error(processErrorMessage(stderr, code)));
                        return;
                      }
                      const models = parseCommandCodeModelList(stdout);
                      if (models.length === 0) {
                        finish(new Error("Command Code model discovery returned no models."));
                        return;
                      }
                      finish(undefined, {
                        models,
                        source: "command-code.cli",
                        cached: false,
                      });
                    })
                    .catch((cause) =>
                      finish(cause instanceof Error ? cause : new Error(String(cause))),
                    );
                });
              };
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) onAbort();
              void pendingOwnership.establishment.then(startCollection, (cause) =>
                finish(cause instanceof Error ? cause : new Error(String(cause))),
              );
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "model/list",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
      });

    const stopAll: CommandCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        stopAllDepth += 1;
        processDrainGeneration += 1;
      }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const sessionEntries = Array.from(sessions.entries());
            const activeOwners = sessionEntries.flatMap(([, context]) => {
              const owner = context.active ? processOwners.get(context.active.child) : undefined;
              return owner ? [owner] : [];
            });
            const pendingOwnerships = Array.from(pendingProcessOwnerships);
            for (const pending of pendingOwnerships) {
              void beginPendingProcessTeardown(pending);
            }
            const results = yield* Effect.forEach(sessionEntries, ([threadId, context]) =>
              stopSessionContext(threadId, context).pipe(Effect.exit),
            );
            const pendingResults = yield* Effect.forEach(
              pendingOwnerships,
              (pending) =>
                Effect.tryPromise({
                  try: () => awaitPendingProcessTeardown(pending),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "stopAll",
                      detail:
                        cause instanceof Error
                          ? cause.message
                          : "Failed to stop a pending Command Code process.",
                      cause,
                    }),
                }).pipe(Effect.exit),
              { concurrency: "unbounded" },
            );
            const attemptedPendingOwners = pendingOwnerships.flatMap((pending) => {
              const owner = processOwners.get(pending.child);
              return owner ? [owner] : [];
            });
            const ownedProcessExit = yield* Effect.exit(
              processOwnerTracker
                .drainExcluding(new Set([...activeOwners, ...attemptedPendingOwners]))
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "stopAll",
                        detail:
                          cause instanceof Error
                            ? cause.message
                            : "Failed to prove all Command Code process trees exited.",
                        cause,
                      }),
                  ),
                ),
            );
            for (const result of results) {
              if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
            }
            for (const pendingResult of pendingResults) {
              if (Exit.isFailure(pendingResult)) {
                return yield* Effect.failCause(pendingResult.cause);
              }
            }
            if (Exit.isFailure(ownedProcessExit)) {
              return yield* Effect.failCause(ownedProcessExit.cause);
            }
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            stopAllDepth = Math.max(0, stopAllDepth - 1);
          }),
        ),
      );

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ignore,
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
