import { ThreadId, TurnId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper";

const unsupported = () => Effect.die(new Error("Unsupported test call")) as never;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeThreadShell(input: {
  readonly threadId: ThreadId;
  readonly activeTurnId: TurnId | null;
}): OrchestrationThreadShell {
  return {
    id: input.threadId,
    session: input.activeTurnId
      ? {
          activeTurnId: input.activeTurnId,
        }
      : null,
  } as unknown as OrchestrationThreadShell;
}

function makeLayer(input: {
  readonly threadShell: OrchestrationThreadShell;
  readonly directory: ProviderSessionDirectoryShape;
  readonly providerService: ProviderServiceShape;
  readonly onThreadLookup?: () => void;
}) {
  return makeProviderSessionReaperLive({
    inactivityThresholdMs: 1,
    sweepIntervalMs: 60_000,
  }).pipe(
    Layer.provide(Layer.succeed(ProviderSessionDirectory, input.directory)),
    Layer.provide(Layer.succeed(ProviderService, input.providerService)),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getSnapshot: () => unsupported(),
        getCommandReadModel: () => unsupported(),
        getCounts: () => unsupported(),
        getSnapshotSequence: () => unsupported(),
        getShellSnapshot: () => unsupported(),
        listArchivedProjects: () => unsupported(),
        getActiveProjectByWorkspaceRoot: () => unsupported(),
        getProjectShellById: () => unsupported(),
        getFirstActiveThreadIdByProjectId: () => unsupported(),
        getThreadCheckpointContext: () => unsupported(),
        listGeneratedImageActivitiesByTurn: () => unsupported(),
        getFullThreadDiffContext: () => unsupported(),
        getThreadShellById: () =>
          Effect.sync(() => {
            input.onThreadLookup?.();
            return Option.some(input.threadShell);
          }),
        findSyntheticSubagentParentThread: () => unsupported(),
        getThreadDetailById: () => unsupported(),
        getThreadDetailForExportById: () => unsupported(),
        getThreadDetailSnapshotById: () => unsupported(),
      }),
    ),
  );
}

function makeProviderService(input: {
  readonly stopSession: ProviderServiceShape["stopSession"];
  readonly stopRuntimeSession?: NonNullable<ProviderServiceShape["stopRuntimeSession"]>;
  readonly stopRuntimeSessionIfIdle?: NonNullable<ProviderServiceShape["stopRuntimeSessionIfIdle"]>;
  readonly hasLiveRuntimeTasks?: NonNullable<ProviderServiceShape["hasLiveRuntimeTasks"]>;
}): ProviderServiceShape {
  return {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    interruptTurn: () => unsupported(),
    stopTask: () => unsupported(),
    backgroundTask: () => unsupported(),
    steerSubagent: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: input.stopSession,
    ...(input.stopRuntimeSession ? { stopRuntimeSession: input.stopRuntimeSession } : {}),
    ...(input.stopRuntimeSessionIfIdle
      ? { stopRuntimeSessionIfIdle: input.stopRuntimeSessionIfIdle }
      : {}),
    ...(input.hasLiveRuntimeTasks ? { hasLiveRuntimeTasks: input.hasLiveRuntimeTasks } : {}),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => unsupported(),
    rollbackConversation: () => unsupported(),
    compactThread: () => unsupported(),
    closeRuntimeEvents: Effect.void,
    streamEvents: Stream.empty,
  };
}

describe("ProviderSessionReaperLive", () => {
  it("stops only the stale runtime and preserves its durable resume identity", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-stale");
    const resumeCursor = { threadId: "provider-native-thread-reaper-stale" };
    let durableBinding: ProviderRuntimeBinding | undefined = {
      threadId,
      provider: "codex",
      status: "running",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      resumeCursor,
    };
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() =>
      Effect.sync(() => {
        durableBinding = undefined;
      }),
    );
    const stopRuntimeSessionIfIdle = vi.fn<
      NonNullable<ProviderServiceShape["stopRuntimeSessionIfIdle"]>
    >(() =>
      Effect.sync(() => {
        if (durableBinding) {
          durableBinding = {
            ...durableBinding,
            status: "stopped",
          };
        }
      }),
    );
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () =>
        Effect.sync(() => {
          durableBinding = undefined;
        }),
      listThreadIds: () => Effect.succeed([]),
      listBindings: () => Effect.succeed(durableBinding ? [durableBinding] : []),
    };
    const providerService = makeProviderService({
      stopSession,
      stopRuntimeSessionIfIdle,
    });

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            threadShell: makeThreadShell({ threadId, activeTurnId: null }),
            directory,
            providerService,
          }),
        ),
        Effect.runPromise,
      );
      await waitFor(() => stopRuntimeSessionIfIdle.mock.calls.length === 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopRuntimeSessionIfIdle).toHaveBeenCalledWith({ threadId });
    expect(stopSession).not.toHaveBeenCalled();
    expect(durableBinding).toMatchObject({
      threadId,
      status: "stopped",
      resumeCursor,
    });
  });

  it("skips both runtime-only and destructive cleanup for an active turn", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-active");
    const turnId = TurnId.makeUnsafe("turn-reaper-active");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const stopRuntimeSession = vi.fn<NonNullable<ProviderServiceShape["stopRuntimeSession"]>>(
      () => Effect.void,
    );
    const stopRuntimeSessionIfIdle = vi.fn<
      NonNullable<ProviderServiceShape["stopRuntimeSessionIfIdle"]>
    >(() => Effect.void);
    const threadLookup = vi.fn();
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
    };
    const providerService = makeProviderService({
      stopSession,
      stopRuntimeSession,
      stopRuntimeSessionIfIdle,
    });

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            threadShell: makeThreadShell({ threadId, activeTurnId: turnId }),
            directory,
            providerService,
            onThreadLookup: threadLookup,
          }),
        ),
        Effect.runPromise,
      );
      await waitFor(() => threadLookup.mock.calls.length === 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopRuntimeSession).not.toHaveBeenCalled();
    expect(stopRuntimeSessionIfIdle).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("preserves stale identity when runtime-only cleanup is unavailable", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-no-runtime-stop");
    const resumeCursor = { threadId: "provider-native-thread-reaper-no-runtime-stop" };
    const durableBinding: ProviderRuntimeBinding = {
      threadId,
      provider: "codex",
      status: "running",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      resumeCursor,
    };
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const threadLookup = vi.fn();
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => Effect.succeed(Option.some(durableBinding)),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([threadId]),
      listBindings: () => Effect.succeed([durableBinding]),
    };
    const providerService = makeProviderService({ stopSession });

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            threadShell: makeThreadShell({ threadId, activeTurnId: null }),
            directory,
            providerService,
            onThreadLookup: threadLookup,
          }),
        ),
        Effect.runPromise,
      );
      await waitFor(() => threadLookup.mock.calls.length === 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopSession).not.toHaveBeenCalled();
    expect(durableBinding.resumeCursor).toBe(resumeCursor);
  });

  it("delegates all background-task safety to the atomic runtime operation", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-background-task");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const stopRuntimeSession = vi.fn<NonNullable<ProviderServiceShape["stopRuntimeSession"]>>(
      () => Effect.void,
    );
    const hasLiveRuntimeTasks = vi.fn<NonNullable<ProviderServiceShape["hasLiveRuntimeTasks"]>>(
      () => Effect.succeed(true),
    );
    const stopRuntimeSessionIfIdle = vi.fn<
      NonNullable<ProviderServiceShape["stopRuntimeSessionIfIdle"]>
    >(() => Effect.void);
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
    };
    const providerService = makeProviderService({
      stopSession,
      stopRuntimeSession,
      stopRuntimeSessionIfIdle,
      hasLiveRuntimeTasks,
    });

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            threadShell: makeThreadShell({ threadId, activeTurnId: null }),
            directory,
            providerService,
          }),
        ),
        Effect.runPromise,
      );
      await waitFor(() => stopRuntimeSessionIfIdle.mock.calls.length === 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopRuntimeSession).not.toHaveBeenCalled();
    expect(stopRuntimeSessionIfIdle).toHaveBeenCalledWith({ threadId });
    expect(hasLiveRuntimeTasks).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("contains atomic idle-stop failures without falling back to destructive cleanup", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-atomic-stop-failure");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const stopRuntimeSession = vi.fn<NonNullable<ProviderServiceShape["stopRuntimeSession"]>>(
      () => Effect.void,
    );
    const hasLiveRuntimeTasks = vi.fn<NonNullable<ProviderServiceShape["hasLiveRuntimeTasks"]>>(
      () => Effect.succeed(false),
    );
    const stopRuntimeSessionIfIdle = vi.fn<
      NonNullable<ProviderServiceShape["stopRuntimeSessionIfIdle"]>
    >(() => Effect.die(new Error("synthetic atomic stop failure")));
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
    };
    const providerService = makeProviderService({
      stopSession,
      stopRuntimeSession,
      stopRuntimeSessionIfIdle,
      hasLiveRuntimeTasks,
    });

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            threadShell: makeThreadShell({ threadId, activeTurnId: null }),
            directory,
            providerService,
          }),
        ),
        Effect.runPromise,
      );
      await waitFor(() => stopRuntimeSessionIfIdle.mock.calls.length === 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopRuntimeSession).not.toHaveBeenCalled();
    expect(hasLiveRuntimeTasks).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });
});
