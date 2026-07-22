// FILE: wsTransport.test.ts
// Purpose: Verifies browser WebSocket construction around the Effect RPC transport.
// Layer: Web transport tests
// Depends on: the global WebSocket constructor shim and desktop bridge URL contract.

import { Cause, Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_COMPATIBILITY_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_METHODS,
  TERMINAL_RESNAPSHOT_REQUIRED_CODE,
  ProjectId,
  type OrchestrationShellStreamItem,
  type TerminalEventStreamItem,
  WorkspaceCloneId,
  WsCompatibilityError,
} from "@synara/contracts";

import {
  advanceShellSubscription,
  shouldKeepServerLifecycleStream,
  getTerminalCompatibilityError,
  handleTerminalResnapshotRequiredFailure,
  isTerminalCompatibilityFailure,
  isTerminalResnapshotRequiredFailure,
  makeFeatureSocketUrl,
  makeRequestAbortScope,
  projectServerConfigUpdatedPayload,
  retainShellSubscription,
  shellReconnectInput,
  shouldReconnectAfterStreamFailure,
  shouldRecoverUnaryRequest,
  consumeWorkspaceCloneProgressStream,
  WsTransport,
} from "./wsTransport";
import {
  addWsCompatibilityIssueListener,
  emitWsCompatibilityIssue,
  readLatestWsCompatibilityIssue,
} from "./wsTransportEvents";

type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  sockets.length = 0;
  vi.stubEnv("VITE_WS_URL", "");

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", hostname: "localhost", port: "3020" },
      desktopBridge: undefined,
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubUnaryTransport(
  initialClient: unknown,
  reconnectedClient: unknown = initialClient,
): {
  readonly transport: WsTransport;
  readonly getClient: ReturnType<typeof vi.fn>;
  readonly reconnect: ReturnType<typeof vi.fn>;
} {
  const transport = new WsTransport("ws://localhost:3020");
  const getClient = vi.fn().mockResolvedValue(initialClient);
  const reconnect = vi.fn().mockResolvedValue(reconnectedClient);
  const internals = transport as unknown as {
    getClient: () => Promise<unknown>;
    getClientRuntime: (client: unknown) => unknown;
    reconnect: () => Promise<unknown>;
    state: "open";
  };
  internals.getClient = getClient;
  internals.getClientRuntime = () => ({ runPromiseExit: Effect.runPromiseExit });
  internals.reconnect = reconnect;
  internals.state = "open";
  return { transport, getClient, reconnect };
}

describe("WsTransport", () => {
  it("retains the shell input and resumes after the last delivered sequence", () => {
    let state = retainShellSubscription(null, { afterSequence: 10 });
    state = advanceShellSubscription(state, {
      kind: "project-removed",
      sequence: 12,
      projectId: ProjectId.makeUnsafe("project-1"),
    });
    state = retainShellSubscription(state, {});

    expect(state.input).toEqual({});
    expect(state.lastDeliveredSequence).toBe(12);
    expect(shellReconnectInput(state)).toEqual({ afterSequence: 12 });
  });

  it("resets an ahead shell cursor to the sequence of a fallback snapshot", () => {
    const state = advanceShellSubscription(retainShellSubscription(null, { afterSequence: 100 }), {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 20,
        projects: [],
        threads: [],
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    } as OrchestrationShellStreamItem);

    expect(shellReconnectInput(state)).toEqual({ afterSequence: 20 });
  });

  it("emits every workspace clone event and extracts the terminal result", async () => {
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-transport");
    const started = {
      _tag: "clone_started" as const,
      snapshot: {
        cloneId,
        status: "running" as const,
        stage: "cloning" as const,
        percent: 0,
        message: "Cloning repository…",
        result: null,
        updatedAt: "2026-07-20T12:00:00.000Z",
      },
    };
    const result = {
      cloneId,
      clonedPath: "C:\\work\\repo",
      projectId: null,
      failure: null,
    };
    const finished = {
      _tag: "clone_finished" as const,
      snapshot: {
        ...started.snapshot,
        status: "succeeded" as const,
        stage: "complete" as const,
        percent: 100,
        result,
      },
      result,
    };
    const seen: string[] = [];

    await expect(
      Effect.runPromise(
        consumeWorkspaceCloneProgressStream(Stream.fromIterable([started, finished]), (event) =>
          seen.push(event._tag),
        ),
      ),
    ).resolves.toEqual(result);
    expect(seen).toEqual(["clone_started", "clone_finished"]);
  });

  it("rejects a workspace clone stream that ends without a terminal result", async () => {
    const cloneId = WorkspaceCloneId.makeUnsafe("clone-incomplete");
    const started = {
      _tag: "clone_started" as const,
      snapshot: {
        cloneId,
        status: "running" as const,
        stage: "cloning" as const,
        percent: 0,
        message: "Cloning repository…",
        result: null,
        updatedAt: "2026-07-20T12:00:00.000Z",
      },
    };

    await expect(
      Effect.runPromise(consumeWorkspaceCloneProgressStream(Stream.make(started), () => undefined)),
    ).rejects.toMatchObject({
      _tag: "WorkspaceCloneStreamIncompleteError",
      message: "Workspace clone stream completed without a final result.",
    });
  });

  it("does not reconnect the socket for typed stream-admission failures", () => {
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({
          code: "STREAM_CAPACITY_EXCEEDED",
          retryable: true,
          retryAfterMs: 1_000,
        }),
      ),
    ).toBe(false);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "STREAM_DUPLICATE_SUBSCRIPTION", retryable: false }),
      ),
    ).toBe(false);
    expect(shouldReconnectAfterStreamFailure(Cause.fail(new Error("transient")))).toBe(true);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "WS_PROTOCOL_INCOMPATIBLE", retryable: false }),
      ),
    ).toBe(false);
    expect(
      isTerminalCompatibilityFailure({
        code: "WS_PROTOCOL_INCOMPATIBLE",
        retryable: false,
      }),
    ).toBe(true);
  });

  it("reattaches the terminal stream before requesting authoritative snapshot replacement", async () => {
    const cause = Cause.fail({
      code: TERMINAL_RESNAPSHOT_REQUIRED_CODE,
      retryable: true,
      retryAfterMs: 0,
    });
    const order: string[] = [];

    expect(isTerminalResnapshotRequiredFailure(cause)).toBe(true);
    expect(shouldReconnectAfterStreamFailure(cause)).toBe(false);
    expect(
      handleTerminalResnapshotRequiredFailure(
        cause,
        () => {
          order.push("reattach-stream");
        },
        () => {
          order.push("replace-from-snapshot");
        },
      ),
    ).toBe(true);
    expect(order).toEqual(["reattach-stream"]);

    await Promise.resolve();
    expect(order).toEqual(["reattach-stream", "replace-from-snapshot"]);
  });

  it("waits for an asynchronous terminal stream reattach before replacing from snapshot", async () => {
    const cause = Cause.fail({
      code: TERMINAL_RESNAPSHOT_REQUIRED_CODE,
      retryable: true,
      retryAfterMs: 0,
    });
    const order: string[] = [];
    let resolveRestart: (() => void) | undefined;

    expect(
      handleTerminalResnapshotRequiredFailure(
        cause,
        () => {
          order.push("reattach-requested");
          return new Promise<void>((resolve) => {
            resolveRestart = () => {
              order.push("reattach-started");
              resolve();
            };
          });
        },
        () => {
          order.push("replace-from-snapshot");
        },
      ),
    ).toBe(true);
    expect(order).toEqual(["reattach-requested"]);

    await Promise.resolve();
    expect(order).toEqual(["reattach-requested"]);

    resolveRestart?.();
    await Promise.resolve();
    expect(order).toEqual(["reattach-requested", "reattach-started", "replace-from-snapshot"]);
  });

  it("keeps a readiness-only terminal stream live across recovery and reconnect", async () => {
    vi.useFakeTimers();
    (window as unknown as { setTimeout: typeof globalThis.setTimeout }).setTimeout =
      globalThis.setTimeout;
    const transport = new WsTransport("ws://localhost:3020");
    const subscribeTerminalEvents = vi.fn(() => ({ stream: "terminal" }));
    const subscribeServerConfig = vi.fn(() => ({ stream: "server-config" }));
    const client = {
      [WS_METHODS.subscribeTerminalEvents]: subscribeTerminalEvents,
      [WS_METHODS.subscribeServerConfig]: subscribeServerConfig,
    };
    type TerminalStreamAttempt = {
      readonly listener: (event: TerminalEventStreamItem) => void;
      readonly restart?: () => void | Promise<void>;
      readonly handleFailure?: (cause: Cause.Cause<unknown>) => boolean;
      readonly onExit?: () => void;
      readonly cleanup: ReturnType<typeof vi.fn>;
    };
    const attempts: TerminalStreamAttempt[] = [];
    const internals = transport as unknown as {
      getClient: () => Promise<unknown>;
      startStream: <T>(
        client: unknown,
        key: string,
        stream: unknown,
        listener: (event: T) => void,
        restart?: () => void | Promise<void>,
        handleFailure?: (cause: Cause.Cause<unknown>) => boolean,
        onExit?: () => void,
      ) => void;
      streamCleanups: Map<string, () => void>;
      listeners: Map<string, Set<(message: unknown) => void>>;
      runtime: unknown;
      clientScope: unknown;
      createSession: () => {
        runtime: unknown;
        clientScope: unknown;
        clientPromise: Promise<unknown>;
      };
      openReconnectSession: () => Promise<unknown>;
      invalidateTerminalEventStreamReady: (error: unknown) => void;
    };
    internals.getClient = () => Promise.resolve(client);
    internals.startStream = <T>(
      _client: unknown,
      key: string,
      _stream: unknown,
      listener: (event: T) => void,
      restart?: () => void | Promise<void>,
      handleFailure?: (cause: Cause.Cause<unknown>) => boolean,
      onExit?: () => void,
    ) => {
      if (internals.streamCleanups.has(key)) return;
      const cleanup = vi.fn();
      internals.streamCleanups.set(key, cleanup);
      attempts.push({
        listener: listener as (event: TerminalEventStreamItem) => void,
        ...(restart ? { restart } : {}),
        ...(handleFailure ? { handleFailure } : {}),
        ...(onExit ? { onExit } : {}),
        cleanup,
      });
    };

    try {
      const initialReady = transport.waitForTerminalEventStreamReady();
      await Promise.resolve();
      expect(internals.listeners.has(WS_CHANNELS.terminalEvent)).toBe(false);
      expect(attempts).toHaveLength(1);
      expect(subscribeServerConfig).not.toHaveBeenCalled();

      attempts[0]?.listener({ type: "ready", generation: "generation-1" });
      await expect(initialReady).resolves.toEqual({
        type: "ready",
        generation: "generation-1",
      });

      internals.streamCleanups.delete("terminal.events");
      attempts[0]?.onExit?.();
      expect(
        attempts[0]?.handleFailure?.(
          Cause.fail({
            code: TERMINAL_RESNAPSHOT_REQUIRED_CODE,
            retryable: true,
            retryAfterMs: 0,
          }),
        ),
      ).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(attempts).toHaveLength(2);

      attempts[1]?.listener({ type: "ready", generation: "generation-2" });
      const recoveredOutput = {
        type: "output" as const,
        threadId: "thread-1",
        terminalId: "terminal-1",
        createdAt: "2026-07-21T00:00:00.000Z",
        generation: "generation-2",
        sequence: 1,
        data: "recovered output",
      };
      attempts[1]?.listener(recoveredOutput);
      expect(transport.getLatestPush(WS_CHANNELS.terminalEvent)?.data).toEqual(recoveredOutput);
      const unsubscribe = transport.subscribe(WS_CHANNELS.terminalEvent, vi.fn());
      await Promise.resolve();
      unsubscribe();
      expect(internals.listeners.has(WS_CHANNELS.terminalEvent)).toBe(false);
      expect(internals.streamCleanups.has("terminal.events")).toBe(true);
      expect(attempts).toHaveLength(2);

      internals.invalidateTerminalEventStreamReady(new Error("socket reconnecting"));
      internals.streamCleanups.clear();
      const runtime = internals.runtime;
      const clientScope = internals.clientScope;
      internals.createSession = () => ({
        runtime,
        clientScope,
        clientPromise: Promise.resolve(client),
      });
      const reconnect = internals.openReconnectSession();
      await vi.advanceTimersByTimeAsync(500);
      await reconnect;
      await Promise.resolve();

      expect(internals.listeners.has(WS_CHANNELS.terminalEvent)).toBe(false);
      expect(attempts).toHaveLength(3);
      attempts[2]?.listener({ type: "ready", generation: "generation-3" });
      const reconnectedOutput = {
        ...recoveredOutput,
        generation: "generation-3",
        sequence: 2,
        data: "reconnected output",
      };
      attempts[2]?.listener(reconnectedOutput);
      expect(transport.getLatestPush(WS_CHANNELS.terminalEvent)?.data).toEqual(reconnectedOutput);
      expect(subscribeServerConfig).not.toHaveBeenCalled();
      await transport.dispose();
      expect(attempts[2]?.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await transport.dispose();
      vi.useRealTimers();
    }
  });

  it("does not start a readiness-only terminal stream after disposal wins the client race", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    let resolveClient!: (client: unknown) => void;
    const getClient = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveClient = resolve;
        }),
    );
    const startStream = vi.fn();
    const internals = transport as unknown as {
      getClient: () => Promise<unknown>;
      startStream: typeof startStream;
      streamCleanups: Map<string, () => void>;
      terminalEventStreamReady: unknown;
    };
    internals.getClient = getClient;
    internals.startStream = startStream;

    const ready = transport.waitForTerminalEventStreamReady();
    await transport.dispose();
    resolveClient({
      [WS_METHODS.subscribeTerminalEvents]: () => ({ stream: "terminal" }),
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(ready).rejects.toThrow("Transport disposed");
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(startStream).not.toHaveBeenCalled();
    expect(internals.terminalEventStreamReady).toBeNull();
    expect(internals.streamCleanups.size).toBe(0);
  });

  it("latches terminal compatibility guidance for late UI subscribers", () => {
    const issue = new WsCompatibilityError({
      message: "Update this client.",
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
      serverBuild: "0.5.2",
      protocolEpoch: WS_PROTOCOL_EPOCH,
      minRevision: WS_PROTOCOL_MIN_REVISION,
      maxRevision: WS_PROTOCOL_MAX_REVISION,
    });
    const listener = vi.fn();

    emitWsCompatibilityIssue(issue);
    const unsubscribe = addWsCompatibilityIssueListener(listener, { replayCurrent: true });

    expect(readLatestWsCompatibilityIssue()).toBe(issue);
    expect(listener).toHaveBeenCalledWith(issue);
    expect(getTerminalCompatibilityError(issue)).toBe(issue);

    unsubscribe();
    emitWsCompatibilityIssue(null);
  });

  it("rejects terminal readiness on compatibility failure without retrying", async () => {
    vi.useFakeTimers();
    const issue = new WsCompatibilityError({
      message: "Update this client.",
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
      serverBuild: "0.5.2",
      protocolEpoch: WS_PROTOCOL_EPOCH,
      minRevision: WS_PROTOCOL_MIN_REVISION,
      maxRevision: WS_PROTOCOL_MAX_REVISION,
    });
    const transport = new WsTransport("ws://localhost:3020");
    const getClient = vi.fn().mockRejectedValue(issue);
    const internals = transport as unknown as {
      getClient: () => Promise<never>;
    };
    internals.getClient = getClient;

    try {
      await expect(transport.waitForTerminalEventStreamReady()).rejects.toBe(issue);
      await vi.advanceTimersByTimeAsync(500);
      expect(getClient).toHaveBeenCalledTimes(1);
    } finally {
      await transport.dispose();
      vi.useRealTimers();
    }
  });

  it("owns request deadlines and external aborts without leaving timers active", async () => {
    vi.useFakeTimers();
    try {
      const deadline = makeRequestAbortScope({ timeoutMs: 25 });
      expect(deadline.signal?.aborted).toBe(false);
      expect(deadline.didTimeout()).toBe(false);

      await vi.advanceTimersByTimeAsync(25);
      expect(deadline.signal?.aborted).toBe(true);
      expect(deadline.didTimeout()).toBe(true);
      deadline.cleanup();
      deadline.cleanup();

      const external = new AbortController();
      const cancelled = makeRequestAbortScope({ timeoutMs: 1_000, signal: external.signal });
      external.abort(new Error("cancelled by caller"));
      expect(cancelled.signal?.aborted).toBe(true);
      expect(cancelled.didTimeout()).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(cancelled.didTimeout()).toBe(false);
      cancelled.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays an interrupted dispatch with the exact normalized command", async () => {
    const command = {
      type: "thread.user-input.respond",
      commandId: "command-1",
      threadId: "thread-1",
      requestId: "request-1",
      answers: { Language: null, Runtime: "Bun" },
      createdAt: "2026-07-21T00:00:00.000Z",
    };
    const firstDispatch = vi.fn((_input: unknown) => Effect.interrupt);
    const secondDispatch = vi.fn((_input: unknown) => Effect.succeed({ sequence: 4 }));
    const firstClient = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: firstDispatch };
    const secondClient = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: secondDispatch };
    const { transport, reconnect } = stubUnaryTransport(firstClient, secondClient);

    try {
      await expect(
        transport.request(
          ORCHESTRATION_WS_METHODS.dispatchCommand,
          { command },
          { retryOnSessionInterruption: true },
        ),
      ).resolves.toEqual({ sequence: 4 });
      expect(reconnect).toHaveBeenCalledTimes(1);
      const firstInput = firstDispatch.mock.calls[0]?.[0];
      const secondInput = secondDispatch.mock.calls[0]?.[0];
      expect(firstInput).not.toBe(command);
      expect(firstInput).toEqual({
        ...command,
        answers: { Runtime: "Bun" },
      });
      expect(secondInput).toBe(firstInput);
    } finally {
      await transport.dispose();
    }
  });

  it("stops after one replay when the replacement session is also interrupted", async () => {
    const firstDispatch = vi.fn(() => Effect.interrupt);
    const secondDispatch = vi.fn(() => Effect.interrupt);
    const firstClient = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: firstDispatch };
    const secondClient = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: secondDispatch };
    const { transport, reconnect } = stubUnaryTransport(firstClient, secondClient);

    try {
      await expect(
        transport.request(
          ORCHESTRATION_WS_METHODS.dispatchCommand,
          { command: { type: "project.archive", commandId: "command-2" } },
          { retryOnSessionInterruption: true },
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(firstDispatch).toHaveBeenCalledTimes(1);
      expect(secondDispatch).toHaveBeenCalledTimes(1);
    } finally {
      await transport.dispose();
    }
  });

  it("shares reconnect across concurrent callers while preserving independent deadlines", async () => {
    vi.useFakeTimers();
    const firstDispatch = vi.fn(() => Effect.interrupt);
    const secondDispatch = vi.fn((command: { readonly commandId?: string }) =>
      Effect.succeed({ sequence: command.commandId === "command-long" ? 12 : 11 }),
    );
    const firstClient = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: firstDispatch };
    const secondClient = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: secondDispatch };
    const transport = new WsTransport("ws://localhost:3020");
    let resolveReconnect!: (client: unknown) => void;
    const reconnectGate = new Promise<unknown>((resolve) => {
      resolveReconnect = resolve;
    });
    let resolveSharedWaiter!: () => void;
    const sharedWaiter = new Promise<void>((resolve) => {
      resolveSharedWaiter = resolve;
    });
    const internals = transport as unknown as {
      getClient: () => Promise<unknown>;
      getClientRuntime: (client: unknown) => unknown;
      reconnect: () => Promise<unknown>;
      reconnectPromise: Promise<unknown> | null;
      sessionVersion: number;
      state: "connecting" | "open";
    };
    internals.getClient = vi.fn(() => {
      if (internals.reconnectPromise) {
        resolveSharedWaiter();
        return internals.reconnectPromise;
      }
      return Promise.resolve(firstClient);
    });
    internals.getClientRuntime = () => ({ runPromiseExit: Effect.runPromiseExit });
    const reconnect = vi.fn(() => {
      if (internals.reconnectPromise) return internals.reconnectPromise;
      internals.state = "connecting";
      const pending = reconnectGate
        .then((client) => {
          internals.sessionVersion += 1;
          internals.state = "open";
          return client;
        })
        .finally(() => {
          internals.reconnectPromise = null;
        });
      internals.reconnectPromise = pending;
      return pending;
    });
    internals.reconnect = reconnect;
    internals.reconnectPromise = null;
    internals.state = "open";

    try {
      const shortRequest = transport.request(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        { command: { type: "project.archive", commandId: "command-short" } },
        { timeoutMs: 30, retryOnSessionInterruption: true },
      );
      const shortOutcome = shortRequest.catch((error: unknown) => error);
      let longSettled = false;
      const longRequest = transport.request(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        { command: { type: "project.archive", commandId: "command-long" } },
        { timeoutMs: 300, retryOnSessionInterruption: true },
      );
      void longRequest.then(
        () => {
          longSettled = true;
        },
        () => {
          longSettled = true;
        },
      );

      await sharedWaiter;
      expect(firstDispatch).toHaveBeenCalledTimes(2);
      expect(reconnect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30);
      await expect(shortOutcome).resolves.toMatchObject({
        _tag: "WsTransportRequestInterruptedError",
        code: "WS_REQUEST_TIMEOUT",
      });
      expect(longSettled).toBe(false);

      resolveReconnect(secondClient);
      await vi.advanceTimersByTimeAsync(0);
      await expect(longRequest).resolves.toEqual({ sequence: 12 });
      expect(secondDispatch).toHaveBeenCalledTimes(1);
      expect(reconnect).toHaveBeenCalledTimes(1);
    } finally {
      await transport.dispose();
      vi.useRealTimers();
    }
  });

  it("recovers an opted-in read request but not an ordinary interrupted request", async () => {
    const firstShellSnapshot = vi.fn(() => Effect.interrupt);
    const secondShellSnapshot = vi.fn(() => Effect.succeed({ snapshotSequence: 5 }));
    const firstClient = { [ORCHESTRATION_WS_METHODS.getShellSnapshot]: firstShellSnapshot };
    const secondClient = { [ORCHESTRATION_WS_METHODS.getShellSnapshot]: secondShellSnapshot };
    const recovered = stubUnaryTransport(firstClient, secondClient);

    try {
      await expect(
        recovered.transport.request(ORCHESTRATION_WS_METHODS.getShellSnapshot, undefined, {
          retryOnSessionInterruption: true,
        }),
      ).resolves.toEqual({ snapshotSequence: 5 });
      expect(recovered.reconnect).toHaveBeenCalledTimes(1);
    } finally {
      await recovered.transport.dispose();
    }

    const notRecovered = stubUnaryTransport(firstClient, secondClient);
    try {
      await expect(
        notRecovered.transport.request(ORCHESTRATION_WS_METHODS.getShellSnapshot),
      ).rejects.toBeInstanceOf(Error);
      expect(notRecovered.reconnect).not.toHaveBeenCalled();
      expect(secondShellSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await notRecovered.transport.dispose();
    }
  });

  it("does not retry typed unary failures", async () => {
    const failure = new Error("domain rejection");
    const dispatch = vi.fn(() => Effect.fail(failure));
    const client = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch };
    const { transport, reconnect } = stubUnaryTransport(client);

    try {
      await expect(
        transport.request(
          ORCHESTRATION_WS_METHODS.dispatchCommand,
          { command: { type: "project.archive", commandId: "command-3" } },
          { retryOnSessionInterruption: true },
        ),
      ).rejects.toBe(failure);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      await transport.dispose();
    }
  });

  it("shares the outer deadline across both dispatch attempts", async () => {
    vi.useFakeTimers();
    const firstDispatch = vi.fn(() => Effect.sleep(10).pipe(Effect.andThen(Effect.interrupt)));
    const secondDispatch = vi.fn(() => Effect.never);
    const firstClient = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: firstDispatch };
    const secondClient = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: secondDispatch };
    const { transport, reconnect } = stubUnaryTransport(firstClient, secondClient);

    try {
      const pending = transport.request(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        { command: { type: "project.archive", commandId: "command-4" } },
        { timeoutMs: 60, retryOnSessionInterruption: true },
      );
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(firstDispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(9);
      expect(secondDispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(secondDispatch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).rejects.toMatchObject({
        _tag: "WsTransportRequestInterruptedError",
        code: "WS_REQUEST_TIMEOUT",
      });
      expect(settled).toBe(true);
      expect(firstDispatch).toHaveBeenCalledTimes(1);
      expect(secondDispatch).toHaveBeenCalledTimes(1);
    } finally {
      await transport.dispose();
      vi.useRealTimers();
    }
  });

  it("does not replay a dispatch cancelled by its caller", async () => {
    const dispatch = vi.fn(() => Effect.never);
    const client = { [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch };
    const { transport, reconnect } = stubUnaryTransport(client);
    const controller = new AbortController();

    try {
      const pending = transport.request(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        { command: { type: "project.archive", commandId: "command-5" } },
        {
          timeoutMs: null,
          signal: controller.signal,
          retryOnSessionInterruption: true,
        },
      );
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      controller.abort(new Error("cancelled by test"));

      await expect(pending).rejects.toMatchObject({
        _tag: "WsTransportRequestInterruptedError",
        code: "WS_REQUEST_ABORTED",
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      await transport.dispose();
    }
  });

  it("restricts session recovery to explicitly safe unary methods", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    try {
      await expect(
        transport.request(
          WS_METHODS.serverUpdateProvider,
          {},
          {
            retryOnSessionInterruption: true,
          },
        ),
      ).rejects.toThrow("WebSocket RPC session recovery is not permitted");
    } finally {
      await transport.dispose();
    }
  });

  it("classifies only interruptions and socket failures for unary session recovery", () => {
    const socketFailure = Cause.fail({
      _tag: "RpcClientError",
      reason: { _tag: "SocketCloseError", code: 1006 },
    });
    expect(shouldRecoverUnaryRequest(Cause.interrupt(1))).toBe(true);
    expect(shouldRecoverUnaryRequest(Cause.fail(new Error("domain rejection")))).toBe(false);
    expect(
      shouldRecoverUnaryRequest(Cause.fail(new Error("All fibers interrupted without error"))),
    ).toBe(false);
    expect(shouldRecoverUnaryRequest(socketFailure)).toBe(true);
    expect(
      shouldRecoverUnaryRequest(
        Cause.die({
          _tag: "SocketError",
          reason: { _tag: "SocketWriteError", cause: new Error("closed") },
        }),
      ),
    ).toBe(true);
    expect(
      shouldRecoverUnaryRequest(
        Cause.fail({
          _tag: "RpcClientError",
          reason: { _tag: "RpcClientDefect", message: "decode failed" },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRecoverUnaryRequest(
        Cause.fail({ _tag: "SocketWriteError", cause: new Error("unwrapped") }),
      ),
    ).toBe(false);
    expect(
      shouldRecoverUnaryRequest(Cause.combine(socketFailure, Cause.fail(new Error("domain")))),
    ).toBe(false);
    expect(
      shouldRecoverUnaryRequest(Cause.combine(socketFailure, Cause.die(new Error("defect")))),
    ).toBe(false);
  });

  it("keeps the shared lifecycle stream while either lifecycle channel is active", () => {
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverWelcome]))).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverMaintenanceUpdated]))).toBe(
      true,
    );
    expect(
      shouldKeepServerLifecycleStream(
        new Set([WS_CHANNELS.serverWelcome, WS_CHANNELS.serverMaintenanceUpdated]),
      ),
    ).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverConfigUpdated]))).toBe(false);
  });

  it("projects editor availability from config snapshots before replay caching", () => {
    expect(
      projectServerConfigUpdatedPayload({
        type: "snapshot",
        config: {
          cwd: "/repo/project",
          worktreesDir: "/repo/worktrees",
          keybindingsConfigPath: "/repo/project/.synara-keybindings.json",
          keybindings: [],
          issues: [],
          providers: [],
          availableEditors: ["vscode", "cursor"],
        },
      }),
    ).toEqual({ issues: [], providers: [], availableEditors: ["vscode", "cursor"] });

    const update = {
      issues: [],
      providers: [],
      availableEditors: ["zed"] as const,
    };
    expect(projectServerConfigUpdatedPayload({ type: "configUpdated", payload: update })).toBe(
      update,
    );
    expect(
      projectServerConfigUpdatedPayload({
        type: "providerStatuses",
        payload: { providers: [] },
      }),
    ).toBeNull();
  });

  it("opens the stable bootstrap endpoint before the feature RPC socket", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");
    expect(transport.getState()).toBe("connecting");

    await transport.dispose();
  });

  it("uses the desktop bridge URL before falling back to the browser location", async () => {
    const getWsUrl = vi.fn().mockReturnValue("ws://127.0.0.1:53036/?token=old");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "http:", hostname: "localhost", port: "3020" },
        desktopBridge: { getWsUrl },
      },
    });

    const transport = new WsTransport();

    expect(getWsUrl).toHaveBeenCalledTimes(1);
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:53036/ws/bootstrap?token=old");

    await transport.dispose();
  });

  it("falls back to the current browser host when no desktop bridge URL exists", async () => {
    const transport = new WsTransport();

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");

    await transport.dispose();
  });

  it("pins the feature socket to the negotiated revision and server generation", () => {
    const resolved = new URL(
      makeFeatureSocketUrl("ws://127.0.0.1:53036/?token=old", {
        protocolEpoch: WS_PROTOCOL_EPOCH,
        negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
        serverBuild: "0.5.2",
        serverInstanceId: "server-instance",
        capabilities: ["orchestration.cursor-safe-streams"],
      }),
    );

    expect(resolved.pathname).toBe("/ws");
    expect(resolved.searchParams.get("token")).toBe("old");
    expect(resolved.searchParams.get(WS_COMPATIBILITY_QUERY.protocolRevision)).toBe(
      String(WS_PROTOCOL_MAX_REVISION),
    );
    expect(resolved.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      "server-instance",
    );
  });

  it("notifies state listeners and replays the current state on demand", async () => {
    const transport = new WsTransport();
    const listener = vi.fn();

    const unsubscribe = transport.onStateChange(listener, { replayCurrent: true });

    expect(listener).toHaveBeenCalledWith("connecting");

    listener.mockClear();
    await transport.dispose();

    expect(listener).toHaveBeenCalledWith("disposed");

    listener.mockClear();
    unsubscribe();
    await transport.dispose();

    expect(listener).not.toHaveBeenCalled();
  });
});
