// FILE: wsTransport.ts
// Purpose: Browser-side Effect RPC transport over the Synara WebSocket endpoint.
// Layer: Web transport
// Exports: WsTransport plus stream-selection helpers used by tests.

import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_BOOTSTRAP_METHOD,
  WS_BOOTSTRAP_PATH,
  WS_CHANNELS,
  WS_COMPATIBILITY_QUERY,
  WS_FEATURE_PATH,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_SERVER_CAPABILITIES,
  WS_METHODS,
  TERMINAL_RESNAPSHOT_REQUIRED_CODE,
  WsBootstrapRpcGroup,
  WsCompatibilityError,
  WsFeatureRpcGroup,
  type AutomationStreamEvent,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type OrchestrationEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationSubscribeShellInput,
  type OrchestrationThreadStreamItem,
  type ProjectDevServerEvent,
  type ServerConfigStreamEvent,
  type ServerConfigUpdatedPayload,
  type ServerLifecycleStreamEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerSettingsUpdatedPayload,
  type TerminalEvent,
  type TerminalEventStreamItem,
  type TerminalEventStreamReady,
  type WorkspaceCloneProgressEvent,
  type WorkspaceCloneRepositoryResult,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
  type WsBootstrapNegotiateResult,
} from "@synara/contracts";
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime, Schema, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { APP_VERSION } from "./branding";
import { emitTerminalResnapshotRequired, type WsTransportState } from "./wsTransportEvents";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

type RpcClientEffect = typeof makeRpcClient;
type RpcClientInstance =
  RpcClientEffect extends Effect.Effect<infer Client, any, any> ? Client : never;

class WsTransportRpcError extends Data.TaggedError("WsTransportRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WsTransportRequestInterruptedError extends Data.TaggedError(
  "WsTransportRequestInterruptedError",
)<{
  readonly message: string;
  readonly code: "WS_REQUEST_TIMEOUT" | "WS_REQUEST_ABORTED";
  readonly method: string;
  readonly timeoutMs?: number;
  readonly cause?: unknown;
}> {}

export class WorkspaceCloneStreamIncompleteError extends Data.TaggedError(
  "WorkspaceCloneStreamIncompleteError",
)<{
  readonly message: string;
}> {}

export interface WsRequestOptions {
  readonly timeoutMs?: number | null;
  readonly signal?: AbortSignal;
}

export interface ShellSubscriptionResumeState {
  readonly input: OrchestrationSubscribeShellInput;
  readonly lastDeliveredSequence: number | null;
}

export function retainShellSubscription(
  current: ShellSubscriptionResumeState | null,
  input: OrchestrationSubscribeShellInput,
): ShellSubscriptionResumeState {
  return {
    input,
    lastDeliveredSequence: current?.lastDeliveredSequence ?? input.afterSequence ?? null,
  };
}

export function advanceShellSubscription(
  state: ShellSubscriptionResumeState,
  item: OrchestrationShellStreamItem,
): ShellSubscriptionResumeState {
  const sequence = item.kind === "snapshot" ? item.snapshot.snapshotSequence : item.sequence;
  return {
    input: state.input,
    lastDeliveredSequence:
      item.kind === "snapshot" ? sequence : Math.max(state.lastDeliveredSequence ?? -1, sequence),
  };
}

export function shellReconnectInput(
  state: ShellSubscriptionResumeState,
): OrchestrationSubscribeShellInput {
  return {
    ...state.input,
    ...(state.lastDeliveredSequence === null ? {} : { afterSequence: state.lastDeliveredSequence }),
  };
}

interface RequestAbortScope {
  readonly signal: AbortSignal | undefined;
  readonly didTimeout: () => boolean;
  readonly cleanup: () => void;
}

export function makeRequestAbortScope(options?: WsRequestOptions): RequestAbortScope {
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("WebSocket RPC timeoutMs must be a finite non-negative number or null.");
    }
  }
  if (timeoutMs === undefined || timeoutMs === null) {
    return {
      signal: options?.signal,
      didTimeout: () => false,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let cleanedUp = false;
  const externalSignal = options?.signal;
  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timeoutId = globalThis.setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      globalThis.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function awaitWithAbort<A>(promise: Promise<A>, signal: AbortSignal | undefined): Promise<A> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const makeRpcClient = RpcClient.make(WsFeatureRpcGroup);
const makeBootstrapRpcClient = RpcClient.make(WsBootstrapRpcGroup);
const REQUEST_TIMEOUT_MS = 60_000;

function resolveRpcUrl(rawUrl: string, path: string): string {
  const url = new URL(rawUrl);
  url.pathname = path;
  return url.toString();
}

function rawSocketUrl(explicitUrl: string | null): string {
  if (explicitUrl) return explicitUrl;
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  return bridgeUrl && bridgeUrl.length > 0
    ? bridgeUrl
    : envUrl && envUrl.length > 0
      ? envUrl
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
}

function makeSocketUrl(explicitUrl: string | null, path: string): string {
  return resolveRpcUrl(rawSocketUrl(explicitUrl), path);
}

export function makeFeatureSocketUrl(
  explicitUrl: string | null,
  compatibility: WsBootstrapNegotiateResult,
): string {
  const url = new URL(makeSocketUrl(explicitUrl, WS_FEATURE_PATH));
  url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, APP_VERSION);
  url.searchParams.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(compatibility.protocolEpoch));
  url.searchParams.set(
    WS_COMPATIBILITY_QUERY.protocolRevision,
    String(compatibility.negotiatedRevision),
  );
  url.searchParams.set(WS_COMPATIBILITY_QUERY.serverInstanceId, compatibility.serverInstanceId);
  return url.toString();
}

function makeProtocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  // JSON keeps the wire format symmetric with any server build: a serialization
  // mismatch on this single multiplexed socket is a hard connect failure, and the
  // desktop/dev setup routinely runs web and server on independently-built copies.
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}

function causeToError(cause: Cause.Cause<unknown>): Error {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error(String(error));
}

const STREAM_ADMISSION_ERROR_CODES = new Set([
  "STREAM_DUPLICATE_SUBSCRIPTION",
  "STREAM_CAPACITY_EXCEEDED",
  "THREAD_STREAM_CAPACITY_EXCEEDED",
  "WS_NEGOTIATION_REQUIRED",
  "WS_PROTOCOL_INCOMPATIBLE",
  "WS_CAPABILITIES_INCOMPATIBLE",
  TERMINAL_RESNAPSHOT_REQUIRED_CODE,
]);
const TERMINAL_COMPATIBILITY_ERROR_CODES = new Set([
  "WS_NEGOTIATION_REQUIRED",
  "WS_PROTOCOL_INCOMPATIBLE",
  "WS_CAPABILITIES_INCOMPATIBLE",
]);

export function isTerminalCompatibilityFailure(error: unknown): boolean {
  return (
    (Schema.is(WsCompatibilityError)(error) && error.retryable === false) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      TERMINAL_COMPATIBILITY_ERROR_CODES.has(error.code))
  );
}

export function getTerminalCompatibilityError(error: unknown): WsCompatibilityError | null {
  return Schema.is(WsCompatibilityError)(error) && error.retryable === false ? error : null;
}

export function shouldReconnectAfterStreamFailure(cause: Cause.Cause<unknown>): boolean {
  return !cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) return false;
    const error = reason.error;
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? error.code : undefined;
    return typeof code === "string" && STREAM_ADMISSION_ERROR_CODES.has(code);
  });
}

export function isTerminalResnapshotRequiredFailure(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) return false;
    const error = reason.error;
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === TERMINAL_RESNAPSHOT_REQUIRED_CODE
    );
  });
}

export function handleTerminalResnapshotRequiredFailure(
  cause: Cause.Cause<unknown>,
  restartStream: () => void | Promise<void>,
  notifyRuntimes: () => void = emitTerminalResnapshotRequired,
): boolean {
  if (!isTerminalResnapshotRequiredFailure(cause)) return false;

  // Reattach the stream before asking terminal runtimes for authoritative
  // snapshots, so bytes emitted after terminal.open returns have a live sink.
  let restarted: void | Promise<void>;
  try {
    restarted = restartStream();
  } catch {
    return true;
  }
  void Promise.resolve(restarted).then(notifyRuntimes, () => undefined);
  return true;
}

function omitNullUserInputAnswers(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const command = input as { type?: unknown; answers?: unknown };
  if (command.type !== "thread.user-input.respond" || !command.answers) {
    return input;
  }
  if (typeof command.answers !== "object") {
    return input;
  }
  return {
    ...command,
    answers: Object.fromEntries(
      Object.entries(command.answers).filter(
        ([, answer]) => answer !== null && answer !== undefined,
      ),
    ),
  };
}

export function isServerLifecyclePushChannel(channel: string): boolean {
  return channel === WS_CHANNELS.serverWelcome || channel === WS_CHANNELS.serverMaintenanceUpdated;
}

export function shouldKeepServerLifecycleStream(activeChannels: ReadonlySet<string>): boolean {
  return (
    activeChannels.has(WS_CHANNELS.serverWelcome) ||
    activeChannels.has(WS_CHANNELS.serverMaintenanceUpdated)
  );
}

export function projectServerConfigUpdatedPayload(
  event: ServerConfigStreamEvent,
): ServerConfigUpdatedPayload | null {
  if (event.type === "snapshot") {
    return {
      issues: event.config.issues,
      providers: event.config.providers,
      availableEditors: event.config.availableEditors,
    };
  }
  return event.type === "configUpdated" ? event.payload : null;
}

export function consumeWorkspaceCloneProgressStream<E>(
  stream: Stream.Stream<WorkspaceCloneProgressEvent, E>,
  onEvent: (event: WorkspaceCloneProgressEvent) => void,
): Effect.Effect<WorkspaceCloneRepositoryResult, E | WorkspaceCloneStreamIncompleteError> {
  let terminalResult: WorkspaceCloneRepositoryResult | null = null;
  return Stream.runForEach(stream, (event) =>
    Effect.sync(() => {
      onEvent(event);
      if (event._tag === "clone_finished") {
        terminalResult = event.result;
      }
    }),
  ).pipe(
    Effect.flatMap(() =>
      terminalResult
        ? Effect.succeed(terminalResult)
        : Effect.fail(
            new WorkspaceCloneStreamIncompleteError({
              message: "Workspace clone stream completed without a final result.",
            }),
          ),
    ),
  );
}

export class WsTransport {
  private readonly explicitUrl: string | null;
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly stateListeners = new Set<(state: WsTransportState) => void>();
  private readonly compatibilityListeners = new Set<(issue: WsCompatibilityError | null) => void>();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private sequence = 0;
  private sessionVersion = 0;
  private state: WsTransportState = "connecting";
  private disposed = false;
  private readonly runtimeByClient = new WeakMap<
    RpcClientInstance,
    ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>
  >();
  private runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private clientScope: Scope.Closeable;
  private clientPromise: Promise<RpcClientInstance>;
  private reconnectPromise: Promise<RpcClientInstance> | null = null;
  private reconnectFailures = 0;
  private readonly streamCleanups = new Map<string, () => void>();
  private readonly streamSettled = new Map<string, Promise<void>>();
  private terminalEventStreamReady: {
    readonly promise: Promise<TerminalEventStreamReady>;
    readonly resolve: (ready: TerminalEventStreamReady) => void;
    readonly reject: (error: unknown) => void;
  } | null = null;
  // Terminal readiness is a transport-lifetime contract: once a runtime can
  // open or snapshot a terminal, its event stream must survive temporary gaps
  // in ordinary push listeners until the transport itself is disposed.
  private terminalEventStreamRequired = false;
  private shellSubscription: ShellSubscriptionResumeState | null = null;
  private readonly threadSubscriptions = new Map<string, unknown>();
  private compatibility: WsBootstrapNegotiateResult | null = null;
  private compatibilityIssue: WsCompatibilityError | null = null;

  constructor(url?: string) {
    this.explicitUrl = url ?? null;
    const session = this.createSession();
    this.runtime = session.runtime;
    this.clientScope = session.clientScope;
    this.clientPromise = session.clientPromise;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: WsRequestOptions,
  ): Promise<T> {
    if (this.disposed) throw new Error("Transport disposed");
    const requestOptions: WsRequestOptions =
      options?.timeoutMs === undefined ? { ...options, timeoutMs: REQUEST_TIMEOUT_MS } : options;
    const abortScope = makeRequestAbortScope(requestOptions);
    try {
      const client = await awaitWithAbort(this.getClient(), abortScope.signal);
      const clientRuntime = this.getClientRuntime(client);

      if (method === WS_METHODS.gitRunStackedAction) {
        return (await this.runGitActionStream(client, params, abortScope.signal)) as T;
      }
      if (
        method === WS_METHODS.workspaceCloneRepository ||
        method === WS_METHODS.workspaceRetryCloneProjectCreation
      ) {
        return (await this.runWorkspaceCloneStream(client, method, params, abortScope.signal)) as T;
      }

      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        this.shellSubscription = retainShellSubscription(
          this.shellSubscription,
          (params ?? {}) as OrchestrationSubscribeShellInput,
        );
        this.startShellStream(client);
        return undefined as T;
      }
      if (method === ORCHESTRATION_WS_METHODS.unsubscribeShell) {
        this.shellSubscription = null;
        this.stopStream("orchestration.shell");
        return undefined as T;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread) {
        const threadId = (params as { threadId: string }).threadId;
        this.threadSubscriptions.set(threadId, params);
        await this.startThreadStream(client, threadId, params as never);
        return undefined as T;
      }
      if (method === ORCHESTRATION_WS_METHODS.unsubscribeThread) {
        const threadId = (params as { threadId: string }).threadId;
        this.threadSubscriptions.delete(threadId);
        this.stopStream(`orchestration.thread:${threadId}`);
        return undefined as T;
      }

      const rpcInput =
        method === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? (params as { command: unknown }).command
          : (params ?? {});
      const normalizedRpcInput = omitNullUserInputAnswers(rpcInput);
      const call = (
        client as unknown as Record<
          string,
          (input: unknown) => Effect.Effect<unknown, WsTransportRpcError, never>
        >
      )[method];
      if (!call) throw new WsTransportRpcError({ message: `Unknown RPC method: ${method}` });
      return (await clientRuntime.runPromise(
        call(normalizedRpcInput),
        abortScope.signal ? { signal: abortScope.signal } : undefined,
      )) as T;
    } catch (error) {
      if (abortScope.didTimeout()) {
        throw new WsTransportRequestInterruptedError({
          message: `WebSocket RPC ${method} timed out after ${requestOptions.timeoutMs}ms.`,
          code: "WS_REQUEST_TIMEOUT",
          method,
          ...(requestOptions.timeoutMs !== undefined && requestOptions.timeoutMs !== null
            ? { timeoutMs: requestOptions.timeoutMs }
            : {}),
          cause: error,
        });
      }
      if (requestOptions.signal?.aborted) {
        throw new WsTransportRequestInterruptedError({
          message: `WebSocket RPC ${method} was cancelled.`,
          code: "WS_REQUEST_ABORTED",
          method,
          cause: requestOptions.signal.reason ?? error,
        });
      }
      throw error;
    } finally {
      abortScope.cleanup();
    }
  }

  subscribe<C extends WsPushChannel>(
    channel: C,
    listener: PushListener<C>,
    options?: { readonly replayLatest?: boolean },
  ): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<(message: WsPush) => void>();
      this.listeners.set(channel, channelListeners);
      void this.startChannelStream(channel);
    }

    const wrappedListener = (message: WsPush) => listener(message as WsPushMessage<C>);
    channelListeners.add(wrappedListener);

    if (options?.replayLatest) {
      const latest = this.latestPushByChannel.get(channel);
      if (latest) wrappedListener(latest);
    }

    return () => {
      channelListeners?.delete(wrappedListener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
        this.stopChannelStream(channel);
      }
    };
  }

  waitForTerminalEventStreamReady(): Promise<TerminalEventStreamReady> {
    if (this.disposed) return Promise.reject(new Error("Transport disposed"));
    this.terminalEventStreamRequired = true;
    const ready = this.ensureTerminalEventStreamReady();
    if (!this.streamCleanups.has("terminal.events")) {
      void this.startChannelStream(WS_CHANNELS.terminalEvent);
    }
    return ready.promise;
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    const latest = this.latestPushByChannel.get(channel);
    return latest ? (latest as WsPushMessage<C>) : null;
  }

  onStateChange(
    listener: (state: WsTransportState) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.stateListeners.add(listener);
    if (options?.replayCurrent) {
      listener(this.state);
    }

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): WsTransportState {
    return this.state;
  }

  getSessionSnapshot(): { readonly state: WsTransportState; readonly generation: number } {
    return { state: this.state, generation: this.sessionVersion };
  }

  getCompatibility(): WsBootstrapNegotiateResult | null {
    return this.compatibility;
  }

  onCompatibilityIssue(
    listener: (issue: WsCompatibilityError | null) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.compatibilityListeners.add(listener);
    if (options?.replayCurrent) listener(this.compatibilityIssue);
    return () => {
      this.compatibilityListeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.terminalEventStreamRequired = false;
    this.invalidateTerminalEventStreamReady(new Error("Transport disposed"));
    this.setState("disposed");
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    // Dispose can race with initial connection or reconnect promises. Mark them
    // handled before closing the runtime so test/browser teardown stays quiet.
    void this.clientPromise.catch(() => undefined);
    void this.reconnectPromise?.catch(() => undefined);
    const runtime = this.runtime;
    const clientScope = this.clientScope;
    await runtime.runPromise(Scope.close(clientScope, Exit.void)).catch(() => undefined);
    await runtime.dispose().catch(() => undefined);
  }

  private createSession() {
    const sessionVersion = ++this.sessionVersion;
    const runtime = ManagedRuntime.make(
      makeProtocolLayer(makeSocketUrl(this.explicitUrl, WS_BOOTSTRAP_PATH)),
    );
    const clientScope = runtime.runSync(Scope.make());
    const clientPromise = (async () => {
      let compatibility: WsBootstrapNegotiateResult;
      try {
        const bootstrapClient = await runtime.runPromise(
          Scope.provide(clientScope)(makeBootstrapRpcClient),
        );
        compatibility = await runtime.runPromise(
          bootstrapClient[WS_BOOTSTRAP_METHOD]({
            protocolEpoch: WS_PROTOCOL_EPOCH,
            minRevision: WS_PROTOCOL_MIN_REVISION,
            maxRevision: WS_PROTOCOL_MAX_REVISION,
            clientBuild: APP_VERSION,
            requiredCapabilities: [...WS_SERVER_CAPABILITIES],
          }),
        );
      } finally {
        await runtime.runPromise(Scope.close(clientScope, Exit.void)).catch(() => undefined);
        await runtime.dispose().catch(() => undefined);
      }
      if (this.disposed || this.sessionVersion !== sessionVersion) {
        throw new Error("WebSocket session superseded during compatibility negotiation.");
      }

      const featureRuntime = ManagedRuntime.make(
        makeProtocolLayer(makeFeatureSocketUrl(this.explicitUrl, compatibility)),
      );
      const featureScope = featureRuntime.runSync(Scope.make());
      this.runtime = featureRuntime;
      this.clientScope = featureScope;
      const client = await featureRuntime.runPromise(Scope.provide(featureScope)(makeRpcClient));
      this.runtimeByClient.set(client, featureRuntime);
      if (!this.disposed && this.sessionVersion === sessionVersion) {
        if (
          this.compatibility &&
          this.compatibility.serverInstanceId !== compatibility.serverInstanceId
        ) {
          this.latestPushByChannel.clear();
          this.sequence = 0;
        }
        this.compatibility = compatibility;
        this.setCompatibilityIssue(null);
        this.setState("open");
      }
      return client;
    })().catch((error) => {
      if (!this.disposed && this.sessionVersion === sessionVersion) {
        this.compatibility = null;
        const compatibilityError = getTerminalCompatibilityError(error);
        if (compatibilityError) {
          this.setCompatibilityIssue(compatibilityError);
          this.setState("incompatible");
        } else {
          this.setState("closed");
        }
      }
      throw error;
    });
    return { runtime, clientScope, clientPromise };
  }

  private async getClient(): Promise<RpcClientInstance> {
    try {
      return await this.clientPromise;
    } catch (error) {
      if (this.disposed) throw new Error("Transport disposed");
      if (isTerminalCompatibilityFailure(error)) throw error;
      return this.reconnect();
    }
  }

  private getClientRuntime(
    client: RpcClientInstance,
  ): ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> {
    const runtime = this.runtimeByClient.get(client);
    if (!runtime) {
      throw new Error("Missing runtime for WebSocket RPC client");
    }
    return runtime;
  }

  private reconnect(): Promise<RpcClientInstance> {
    if (this.reconnectPromise) return this.reconnectPromise;

    const oldRuntime = this.runtime;
    const oldClientScope = this.clientScope;
    this.invalidateTerminalEventStreamReady(new Error("Terminal event stream reconnecting"));
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();

    this.setState("connecting");

    void oldRuntime
      .runPromise(Scope.close(oldClientScope, Exit.void))
      .catch(() => undefined)
      .finally(() => {
        void oldRuntime.dispose().catch(() => undefined);
      });

    this.reconnectPromise = this.openReconnectSession().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  private setState(state: WsTransportState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Listener errors must not break reconnect or RPC state transitions.
      }
    }
  }

  private setCompatibilityIssue(issue: WsCompatibilityError | null): void {
    if (this.compatibilityIssue === issue) return;
    this.compatibilityIssue = issue;
    for (const listener of this.compatibilityListeners) {
      try {
        listener(issue);
      } catch {
        // Compatibility UI listeners must not break transport teardown.
      }
    }
  }

  private async openReconnectSession(): Promise<RpcClientInstance> {
    const delayMs = Math.min(500 * 2 ** this.reconnectFailures, 5_000);
    this.reconnectFailures += 1;
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.createSession();
    this.runtime = session.runtime;
    this.clientScope = session.clientScope;
    this.clientPromise = session.clientPromise;

    const client = await session.clientPromise;
    this.reconnectFailures = 0;
    for (const channel of this.listeners.keys()) {
      void this.startChannelStream(channel as WsPushChannel);
    }
    if (this.terminalEventStreamRequired && !this.listeners.has(WS_CHANNELS.terminalEvent)) {
      void this.startChannelStream(WS_CHANNELS.terminalEvent);
    }
    if (this.shellSubscription !== null) {
      this.startShellStream(client);
    }
    for (const [threadId, input] of this.threadSubscriptions) {
      await this.startThreadStream(client, threadId, input);
    }
    return client;
  }

  private emit<C extends WsPushChannel>(channel: C, data: WsPushMessage<C>["data"]): void {
    const message = {
      type: "push" as const,
      sequence: ++this.sequence,
      channel,
      data,
    } as WsPush;
    this.latestPushByChannel.set(channel, message);
    const listeners = this.listeners.get(channel);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  private startChannelStream(channel: WsPushChannel): Promise<void> {
    return this.getClient()
      .then((client) => {
        if (this.disposed || !this.shouldKeepChannelStream(channel)) return;
        const restartChannel = () => {
          if (this.shouldKeepChannelStream(channel)) {
            return this.startChannelStream(channel);
          }
          return Promise.resolve();
        };

        if (isServerLifecyclePushChannel(channel)) {
          this.startLifecycleStream(client);
        } else if (channel === WS_CHANNELS.serverConfigUpdated) {
          this.startStream(
            client,
            "server.config",
            client[WS_METHODS.subscribeServerConfig]({}),
            (event: ServerConfigStreamEvent) => {
              const payload = projectServerConfigUpdatedPayload(event);
              if (payload) this.emit(WS_CHANNELS.serverConfigUpdated, payload);
            },
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverProviderStatusesUpdated) {
          this.startStream(
            client,
            "server.providers",
            client[WS_METHODS.subscribeServerProviderStatuses]({}),
            (payload: ServerProviderStatusesUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverProviderStatusesUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverSettingsUpdated) {
          this.startStream(
            client,
            "server.settings",
            client[WS_METHODS.subscribeServerSettings]({}),
            (payload: ServerSettingsUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverSettingsUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.terminalEvent) {
          const ready = this.ensureTerminalEventStreamReady();
          this.startStream(
            client,
            "terminal.events",
            client[WS_METHODS.subscribeTerminalEvents]({}),
            (item: TerminalEventStreamItem) => {
              if (item.type === "ready") {
                ready.resolve(item);
                return;
              }
              this.emit(WS_CHANNELS.terminalEvent, item);
            },
            restartChannel,
            (cause) => handleTerminalResnapshotRequiredFailure(cause, restartChannel),
            () => {
              if (this.terminalEventStreamReady === ready) {
                this.invalidateTerminalEventStreamReady(
                  new Error("Terminal event stream ended before recovery completed"),
                );
              }
            },
          );
          return ready.promise.then(() => undefined);
        } else if (channel === WS_CHANNELS.projectDevServerEvent) {
          this.startStream(
            client,
            "project.devServers",
            client[WS_METHODS.subscribeProjectDevServerEvents]({}),
            (event: ProjectDevServerEvent) => this.emit(WS_CHANNELS.projectDevServerEvent, event),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.automationEvent) {
          this.startStream(
            client,
            "automation.events",
            client[WS_METHODS.subscribeAutomationEvents]({}),
            (event: AutomationStreamEvent) => this.emit(WS_CHANNELS.automationEvent, event),
            restartChannel,
          );
        } else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent) {
          this.startStream(
            client,
            "orchestration.domain",
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
            (event: OrchestrationEvent) => this.emit(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
            restartChannel,
          );
        }
      })
      .catch((error) => {
        if (channel === WS_CHANNELS.terminalEvent && isTerminalCompatibilityFailure(error)) {
          this.invalidateTerminalEventStreamReady(error);
          return;
        }
        if (
          !this.disposed &&
          this.shouldKeepChannelStream(channel) &&
          !isTerminalCompatibilityFailure(error)
        ) {
          console.warn("WebSocket RPC channel failed to start", error);
          return new Promise<void>((resolve) => window.setTimeout(resolve, 500)).then(() =>
            this.startChannelStream(channel),
          );
        }
      });
  }

  private stopChannelStream(channel: WsPushChannel): void {
    if (isServerLifecyclePushChannel(channel)) {
      if (!this.shouldKeepLifecycleStream()) this.stopStream("server.lifecycle");
    } else if (channel === WS_CHANNELS.serverConfigUpdated) this.stopStream("server.config");
    else if (channel === WS_CHANNELS.serverProviderStatusesUpdated)
      this.stopStream("server.providers");
    else if (channel === WS_CHANNELS.serverSettingsUpdated) this.stopStream("server.settings");
    else if (channel === WS_CHANNELS.terminalEvent) {
      if (this.shouldKeepChannelStream(channel)) return;
      this.invalidateTerminalEventStreamReady(new Error("Terminal event stream stopped"));
      this.stopStream("terminal.events");
    } else if (channel === WS_CHANNELS.projectDevServerEvent) this.stopStream("project.devServers");
    else if (channel === WS_CHANNELS.automationEvent) this.stopStream("automation.events");
    else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent)
      this.stopStream("orchestration.domain");
  }

  private shouldKeepLifecycleStream(): boolean {
    return shouldKeepServerLifecycleStream(new Set(this.listeners.keys()));
  }

  private shouldKeepChannelStream(channel: WsPushChannel): boolean {
    return (
      this.listeners.has(channel) ||
      (channel === WS_CHANNELS.terminalEvent && this.terminalEventStreamRequired)
    );
  }

  private startLifecycleStream(client: RpcClientInstance): void {
    const restartLifecycle = () => {
      if (!this.shouldKeepLifecycleStream()) return;
      void this.getClient()
        .then((nextClient) => this.startLifecycleStream(nextClient))
        .catch((error) => console.warn("WebSocket RPC lifecycle stream failed to restart", error));
    };
    this.startStream(
      client,
      "server.lifecycle",
      client[WS_METHODS.subscribeServerLifecycle]({}),
      (event: ServerLifecycleStreamEvent) => {
        if (event.type === "welcome") {
          this.emit(WS_CHANNELS.serverWelcome, event.payload);
        } else if (event.type === "maintenance") {
          this.emit(WS_CHANNELS.serverMaintenanceUpdated, event);
        }
      },
      restartLifecycle,
    );
  }

  private startShellStream(client: RpcClientInstance): void {
    const restartShell = () => {
      if (this.shellSubscription === null) return;
      void this.getClient()
        .then((nextClient) => this.startShellStream(nextClient))
        .catch((error) => console.warn("WebSocket RPC shell stream failed to restart", error));
    };
    const subscription = this.shellSubscription;
    if (subscription === null) return;
    this.startStream(
      client,
      "orchestration.shell",
      client[ORCHESTRATION_WS_METHODS.subscribeShell](shellReconnectInput(subscription)),
      (event: OrchestrationShellStreamItem) => {
        if (this.shellSubscription !== null) {
          this.shellSubscription = advanceShellSubscription(this.shellSubscription, event);
        }
        this.emit(ORCHESTRATION_WS_CHANNELS.shellEvent, event);
      },
      restartShell,
    );
  }

  private async startThreadStream(
    client: RpcClientInstance,
    threadId: string,
    input: unknown,
  ): Promise<void> {
    const key = `orchestration.thread:${threadId}`;
    const sessionVersion = this.sessionVersion;
    await this.stopStream(key);
    if (
      this.disposed ||
      this.sessionVersion !== sessionVersion ||
      this.threadSubscriptions.get(threadId) !== input
    ) {
      return;
    }
    const restartThread = () => {
      const desiredInput = this.threadSubscriptions.get(threadId);
      if (desiredInput === undefined) return;
      void this.getClient()
        .then((nextClient) => this.startThreadStream(nextClient, threadId, desiredInput))
        .catch((error) => console.warn("WebSocket RPC thread stream failed to restart", error));
    };
    this.startStream(
      client,
      key,
      client[ORCHESTRATION_WS_METHODS.subscribeThread](input as never),
      (event: OrchestrationThreadStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.threadEvent, event),
      restartThread,
    );
  }

  private startStream<T>(
    client: RpcClientInstance,
    key: string,
    stream: unknown,
    listener: (event: T) => void,
    restart?: (() => void | Promise<void>) | undefined,
    handleFailure?: ((cause: Cause.Cause<unknown>) => boolean) | undefined,
    onExit?: (() => void) | undefined,
  ): void {
    if (this.streamCleanups.has(key)) return;
    const runnableStream = stream as Stream.Stream<T, WsTransportRpcError, never>;
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const cancel = this.getClientRuntime(client).runCallback(
      Stream.runForEach(runnableStream, (event) => Effect.sync(() => listener(event))),
      {
        onExit: (exit) => {
          if (this.streamSettled.get(key) === settled) {
            this.streamSettled.delete(key);
          }
          resolveSettled();
          const wasReplacedOrStopped = this.streamCleanups.get(key) !== cancel;
          if (!wasReplacedOrStopped) {
            this.streamCleanups.delete(key);
          }
          onExit?.();
          if (wasReplacedOrStopped || this.disposed) {
            return;
          }
          if (Exit.isFailure(exit) && handleFailure?.(exit.cause)) {
            return;
          }
          if (restart && Exit.isFailure(exit) && shouldReconnectAfterStreamFailure(exit.cause)) {
            window.setTimeout(
              () => {
                if (!this.disposed && !this.streamCleanups.has(key)) {
                  void this.reconnect()
                    .then(() => restart())
                    .catch((error) => {
                      if (!this.disposed) {
                        console.warn("WebSocket RPC stream reconnect failed", error);
                      }
                    });
                }
              },
              Cause.hasInterruptsOnly(exit.cause) ? 0 : 500,
            );
            return;
          }
          if (Exit.isFailure(exit) && !this.disposed && !Cause.hasInterruptsOnly(exit.cause)) {
            console.warn("WebSocket RPC stream failed", causeToError(exit.cause));
          }
        },
      },
    );
    this.streamCleanups.set(key, cancel);
    this.streamSettled.set(key, settled);
  }

  private stopStream(key: string): Promise<void> {
    const cleanup = this.streamCleanups.get(key);
    const settled = this.streamSettled.get(key) ?? Promise.resolve();
    if (!cleanup) return settled;
    this.streamCleanups.delete(key);
    cleanup();
    return settled;
  }

  private ensureTerminalEventStreamReady() {
    if (this.terminalEventStreamReady) return this.terminalEventStreamReady;
    let resolve!: (ready: TerminalEventStreamReady) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<TerminalEventStreamReady>((resolveReady, rejectReady) => {
      resolve = resolveReady;
      reject = rejectReady;
    });
    void promise.catch(() => undefined);
    this.terminalEventStreamReady = { promise, resolve, reject };
    return this.terminalEventStreamReady;
  }

  private invalidateTerminalEventStreamReady(error: unknown): void {
    const ready = this.terminalEventStreamReady;
    this.terminalEventStreamReady = null;
    ready?.reject(error);
  }

  private async runGitActionStream(
    client: RpcClientInstance,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<GitRunStackedActionResult> {
    let result: GitRunStackedActionResult | null = null;
    await this.getClientRuntime(client).runPromise(
      Stream.runForEach(client[WS_METHODS.gitRunStackedAction](params as never), (event) =>
        Effect.sync(() => {
          this.emit(WS_CHANNELS.gitActionProgress, event as GitActionProgressEvent);
          if ((event as GitActionProgressEvent).kind === "action_finished") {
            result = (event as Extract<GitActionProgressEvent, { kind: "action_finished" }>).result;
          }
        }),
      ),
      signal ? { signal } : undefined,
    );
    if (!result) throw new Error("Git action stream completed without a final result.");
    return result;
  }

  private async runWorkspaceCloneStream(
    client: RpcClientInstance,
    method:
      | typeof WS_METHODS.workspaceCloneRepository
      | typeof WS_METHODS.workspaceRetryCloneProjectCreation,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<WorkspaceCloneRepositoryResult> {
    const stream =
      method === WS_METHODS.workspaceCloneRepository
        ? client[WS_METHODS.workspaceCloneRepository](params as never)
        : client[WS_METHODS.workspaceRetryCloneProjectCreation](params as never);
    return this.getClientRuntime(client).runPromise(
      consumeWorkspaceCloneProgressStream(stream, (event) =>
        this.emit(WS_CHANNELS.workspaceCloneProgress, event),
      ),
      signal ? { signal } : undefined,
    );
  }
}
