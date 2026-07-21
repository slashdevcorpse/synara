/**
 * DevServerManager - Server-owned dev-server process orchestration.
 *
 * Dev servers are first-class background processes keyed by project id, fully
 * decoupled from chat threads. Each runs in a managed PTY (via TerminalManager)
 * under a synthetic `dev-server:<projectId>` thread so its lifetime survives
 * WebSocket reconnects and never clutters the thread list. The manager keeps an
 * in-memory registry, broadcasts changes over a PubSub for the
 * `project.devServerEvent` push channel, and reaps entries when their PTY exits.
 *
 * @module DevServerManager
 */
import {
  DEFAULT_TERMINAL_ID,
  ProjectId,
  type ProjectDevServer,
  type ProjectDevServerEvent,
  type ProjectListDevServersResult,
  type ProjectRunDevServerInput,
  type ProjectRunDevServerResult,
  type ProjectStopDevServerInput,
  type ProjectStopDevServerResult,
  type ServerLocalServerProcess,
} from "@synara/contracts";
import { localServerMatchesRun } from "@synara/shared/localServers";
import { Effect, Layer, Option, PubSub, Ref, Semaphore, ServiceMap, Stream } from "effect";

import { TerminalError, TerminalManager } from "./terminal/Services/Manager";

// Dev servers reuse the terminal infrastructure under a reserved synthetic
// thread namespace so their PTYs never collide with real chat-thread terminals.
const DEV_SERVER_THREAD_PREFIX = "dev-server:";
const DEV_SERVER_TERMINAL_COLS = 120;
const DEV_SERVER_TERMINAL_ROWS = 30;

const devServerThreadId = (projectId: ProjectId): string =>
  `${DEV_SERVER_THREAD_PREFIX}${projectId}`;

const parseDevServerProjectId = (threadId: string): ProjectId | null => {
  if (!threadId.startsWith(DEV_SERVER_THREAD_PREFIX)) {
    return null;
  }
  const raw = threadId.slice(DEV_SERVER_THREAD_PREFIX.length);
  return raw.length > 0 ? ProjectId.makeUnsafe(raw) : null;
};

export function findProjectDevServerForLocalServer(input: {
  localServer: ServerLocalServerProcess;
  devServers: readonly ProjectDevServer[];
}): ProjectDevServer | null {
  for (const devServer of input.devServers) {
    if (localServerMatchesRun(input.localServer, devServer)) {
      return devServer;
    }
  }
  return null;
}

export type ProjectArchiveReservation =
  | { readonly status: "acquired"; readonly reservationId: string }
  | { readonly status: "already-reserved" }
  | { readonly status: "dev-server-active" };

/** Reject stale/direct starts when the durable active-project projection is absent. */
export function requireActiveProjectForDevServer<A>(input: {
  readonly projectId: ProjectId;
  readonly project: Option.Option<A>;
}): Effect.Effect<A, TerminalError> {
  return Option.match(input.project, {
    onNone: () =>
      Effect.fail(
        new TerminalError({
          message: `Project '${input.projectId}' is unavailable or archived. Restore it before starting a dev server.`,
        }),
      ),
    onSome: Effect.succeed,
  });
}

export interface DevServerManagerShape {
  /** Start (or restart) the dev server for a project and return its descriptor. */
  readonly run: (
    input: ProjectRunDevServerInput,
  ) => Effect.Effect<ProjectRunDevServerResult, TerminalError>;
  /** Stop the dev server for a project. Resolves with whether one was running. */
  readonly stop: (input: ProjectStopDevServerInput) => Effect.Effect<ProjectStopDevServerResult>;
  /** Snapshot of all currently tracked dev servers. */
  readonly list: Effect.Effect<ProjectListDevServersResult>;
  /**
   * Atomically reserve a project for archival against dev-server starts.
   * A successful reservation remains in force until archive rollback or restore.
   */
  readonly reserveProjectArchive: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectArchiveReservation>;
  /** Cancel only the archive reservation owned by this failed archive attempt. */
  readonly cancelProjectArchiveReservation: (input: {
    readonly projectId: ProjectId;
    readonly reservationId: string;
  }) => Effect.Effect<void>;
  /** Release any retained archive reservation after the project is restored. */
  readonly releaseProjectArchive: (projectId: ProjectId) => Effect.Effect<void>;
  /** Live stream of dev-server lifecycle events (excludes the initial snapshot). */
  readonly stream: Stream.Stream<ProjectDevServerEvent>;
}

export class DevServerManager extends ServiceMap.Service<DevServerManager, DevServerManagerShape>()(
  "synara/devServerManager",
) {}

export const DevServerManagerLive = Layer.effect(
  DevServerManager,
  Effect.gen(function* () {
    const terminalManager = yield* TerminalManager;
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProjectDevServerEvent>(),
      PubSub.shutdown,
    );
    const registry = yield* Ref.make<Record<ProjectId, ProjectDevServer>>({});
    const archiveReservations = yield* Ref.make<Record<ProjectId, string>>({});
    const lifecycleLock = yield* Semaphore.make(1);

    const publish = (event: ProjectDevServerEvent) => PubSub.publish(pubsub, event);

    // Reap a tracked dev server whose PTY exited or errored. Guarded so that a
    // deliberate stop (which removes the entry first) cannot double-publish, and
    // so a stale exit for an already-replaced project is ignored.
    const reapExited = (projectId: ProjectId) =>
      Ref.modify(registry, (current) => {
        if (!current[projectId]) {
          return [false, current] as const;
        }
        const next = { ...current };
        delete next[projectId];
        return [true, next] as const;
      }).pipe(
        Effect.flatMap((removed) =>
          removed ? publish({ type: "removed", projectId, reason: "exited" }) : Effect.void,
        ),
      );

    const unsubscribe = yield* terminalManager.subscribe((event) => {
      if (event.type !== "exited" && event.type !== "error") {
        return;
      }
      const projectId = parseDevServerProjectId(event.threadId);
      if (!projectId) {
        return;
      }
      Effect.runFork(reapExited(projectId));
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const run: DevServerManagerShape["run"] = (input) =>
      lifecycleLock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(archiveReservations))[input.projectId]) {
            return yield* new TerminalError({
              message: `Project '${input.projectId}' is archived or being archived. Restore it before starting a dev server.`,
            });
          }

          const threadId = devServerThreadId(input.projectId);

          // If a dev server is already tracked for this project, tear its PTY down
          // first so the command always lands in a fresh shell. A deliberate close
          // emits no exit event, so the reaper stays quiet during the swap.
          const existing = (yield* Ref.get(registry))[input.projectId];
          if (existing) {
            yield* terminalManager
              .close({ threadId, deleteHistory: true })
              .pipe(Effect.catch(() => Effect.void));
          }

          const snapshot = yield* terminalManager.open({
            threadId,
            terminalId: DEFAULT_TERMINAL_ID,
            cwd: input.cwd,
            cols: DEV_SERVER_TERMINAL_COLS,
            rows: DEV_SERVER_TERMINAL_ROWS,
            // Dev servers are headless: drain + retain history, but never broadcast
            // their continuous output to clients that have no terminal UI for them.
            streamOutput: false,
            ...(input.env ? { env: input.env } : {}),
          });

          yield* terminalManager.write({
            threadId,
            terminalId: DEFAULT_TERMINAL_ID,
            data: `${input.command}\r`,
          });

          const server: ProjectDevServer = {
            projectId: input.projectId,
            command: input.command,
            cwd: input.cwd,
            pid: snapshot.pid,
            startedAt: new Date().toISOString(),
            status: "running",
          };
          yield* Ref.update(registry, (current) => ({ ...current, [input.projectId]: server }));
          yield* publish({ type: "upserted", server });
          return { server };
        }),
      );

    const stop: DevServerManagerShape["stop"] = (input) =>
      lifecycleLock.withPermits(1)(
        Effect.gen(function* () {
          // Remove from the registry *before* closing so the PTY teardown cannot be
          // mistaken for a crash by the reaper.
          const removed = yield* Ref.modify(registry, (current) => {
            if (!current[input.projectId]) {
              return [false, current] as const;
            }
            const next = { ...current };
            delete next[input.projectId];
            return [true, next] as const;
          });
          if (!removed) {
            return { stopped: false };
          }
          yield* publish({ type: "removed", projectId: input.projectId, reason: "stopped" });
          yield* terminalManager
            .close({ threadId: devServerThreadId(input.projectId), deleteHistory: true })
            .pipe(Effect.catch(() => Effect.void));
          return { stopped: true };
        }),
      );

    const list: DevServerManagerShape["list"] = Ref.get(registry).pipe(
      Effect.map((current) => ({ servers: Object.values(current) })),
    );

    const reserveProjectArchive: DevServerManagerShape["reserveProjectArchive"] = (projectId) =>
      lifecycleLock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(registry))[projectId]) {
            return { status: "dev-server-active" } as const;
          }
          if ((yield* Ref.get(archiveReservations))[projectId]) {
            return { status: "already-reserved" } as const;
          }
          const reservationId = crypto.randomUUID();
          yield* Ref.update(archiveReservations, (current) => ({
            ...current,
            [projectId]: reservationId,
          }));
          return { status: "acquired", reservationId } as const;
        }),
      );

    const cancelProjectArchiveReservation: DevServerManagerShape["cancelProjectArchiveReservation"] =
      (input) =>
        lifecycleLock.withPermits(1)(
          Ref.update(archiveReservations, (current) => {
            if (current[input.projectId] !== input.reservationId) {
              return current;
            }
            const next = { ...current };
            delete next[input.projectId];
            return next;
          }),
        );

    const releaseProjectArchive: DevServerManagerShape["releaseProjectArchive"] = (projectId) =>
      lifecycleLock.withPermits(1)(
        Ref.update(archiveReservations, (current) => {
          if (!current[projectId]) {
            return current;
          }
          const next = { ...current };
          delete next[projectId];
          return next;
        }),
      );

    return {
      run,
      stop,
      list,
      reserveProjectArchive,
      cancelProjectArchiveReservation,
      releaseProjectArchive,
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies DevServerManagerShape;
  }),
);
