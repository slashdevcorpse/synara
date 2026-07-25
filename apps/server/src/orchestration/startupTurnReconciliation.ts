/**
 * startupTurnReconciliation - heal restart-orphaned turns at server boot.
 *
 * Provider runtimes (Codex app-server, ACP children, etc.) are purely
 * in-memory: every one of them dies with the server process. A turn only
 * leaves the "running" state when its runtime emits a terminal event, so any
 * turn that was still in flight when the process exited has no surviving runtime
 * to ever complete it. After a restart its persisted projection rows still say
 * `session.status = "running"` / `activeTurnId != null` / `latestTurn = running`,
 * and the UI shows "Working" forever (observed in the wild as multi-hour stuck
 * turns).
 *
 * `projectionPipeline.bootstrap` faithfully replays the event log into the
 * projection tables, so it restores that stale "running" state verbatim — it is
 * not its job to second-guess history. This module runs once, immediately after
 * bootstrap and before the server starts accepting client commands, and emits
 * stale pending-request failure activities plus a terminal
 * `thread.session.set { status: "interrupted", activeTurnId: null }` for each
 * orphaned thread. That reuses the normal event-sourced path: activity handlers
 * resolve dead approval/user-input requests, and the projection's session-set
 * handler closes the newest still-open turn (`finalizeTurnStateFromSessionStatus`
 * → "interrupted", with `completedAt`), so the UI clears blocked composers and
 * spinners instead of hanging.
 *
 * The runtime idle watchdog (AcpTurnIdleWatchdog) only protects turns started in
 * the *current* process; this is its restart-time counterpart for turns
 * orphaned by a process boundary the watchdog never saw.
 *
 * @module startupTurnReconciliation
 */
import type {
  OrchestrationCommand,
  OrchestrationThreadActivity,
  OrchestrationSession,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import { CommandId, EventId } from "@synara/contracts";
import {
  buildStalePendingRequestFailureDetail,
  derivePendingThreadRequestIds,
  type PendingThreadRequestKind,
} from "@synara/shared/threadSummary";
import { Effect, Option } from "effect";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { threadHasInFlightTurn } from "./commandInvariants.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "./Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/** The `thread.session.set` variant of the internal orchestration command union. */
type ThreadSessionSetCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.session.set" }
>;
type ThreadActivityAppendCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.activity.append" }
>;
type RestartReconciliationCommand = ThreadSessionSetCommand | ThreadActivityAppendCommand;

const RESTART_PROVIDER_DELIVERY_RECONCILIATION_LIMIT = 100;
const RESTART_PROVIDER_DELIVERY_RECONCILED_BY = "server-startup-recovery";
const RESTART_PROVIDER_DELIVERY_NOTE =
  "The provider runtime and its target turn ended with the previous server process; the uncertain interrupt is obsolete and must not be replayed.";

/** Minimal persisted thread shape the planner inspects (a superset is fine). */
export interface ReconcilableThread {
  readonly id: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: { readonly state: "running" | "interrupted" | "completed" | "error" } | null;
  readonly activities?: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "createdAt" | "id" | "kind" | "payload" | "sequence">
  >;
}

/**
 * True when a thread's persisted state implies a turn that only a now-dead
 * in-process runtime could ever advance. A clean session (idle/ready/interrupted/
 * stopped/error with no active turn and no open turn) is left untouched.
 */
function needsRestartReconciliation(thread: ReconcilableThread): boolean {
  return threadHasInFlightTurn(thread);
}

function planStalePendingRequestCommands(input: {
  readonly thread: ReconcilableThread;
  readonly now: string;
}): ReadonlyArray<ThreadActivityAppendCommand> {
  const pendingRequestIds = derivePendingThreadRequestIds({
    activities: input.thread.activities ?? [],
  });
  const commands: ThreadActivityAppendCommand[] = [];
  for (const requestId of pendingRequestIds.approvalRequestIds) {
    commands.push(
      buildStalePendingRequestCommand({
        threadId: input.thread.id,
        now: input.now,
        requestKind: "approval",
        requestId,
      }),
    );
  }

  for (const requestId of pendingRequestIds.userInputRequestIds) {
    commands.push(
      buildStalePendingRequestCommand({
        threadId: input.thread.id,
        now: input.now,
        requestKind: "user-input",
        requestId,
      }),
    );
  }

  return commands;
}

function buildStalePendingRequestCommand(input: {
  readonly threadId: ThreadId;
  readonly now: string;
  readonly requestKind: PendingThreadRequestKind;
  readonly requestId: string;
}): ThreadActivityAppendCommand {
  const commandKey = [
    "restart-reconcile",
    input.threadId,
    input.requestKind,
    input.requestId,
    input.now,
  ].join(":");
  const isApproval = input.requestKind === "approval";
  return {
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe(commandKey),
    threadId: input.threadId,
    activity: {
      id: EventId.makeUnsafe(commandKey),
      tone: "error",
      kind: isApproval ? "provider.approval.respond.failed" : "provider.user-input.respond.failed",
      summary: isApproval
        ? "Provider approval response failed"
        : "Provider user input response failed",
      payload: {
        detail: buildStalePendingRequestFailureDetail(input.requestKind, input.requestId),
        requestId: input.requestId,
      },
      turnId: null,
      createdAt: input.now,
    },
    createdAt: input.now,
  };
}

/**
 * Pure planner: maps persisted threads to stale-request resolution commands and
 * terminal `thread.session.set` commands. Extracted from the effectful runner so
 * the reliability-critical selection logic is unit-testable without a database,
 * clock, or engine.
 *
 * `now` is threaded in (rather than read from a clock) so the same inputs always
 * produce the same commands — including a deterministic, per-startup `commandId`
 * that lets the engine's receipt dedup treat a re-run as a no-op.
 */
export function planRestartTurnReconciliation(input: {
  readonly threads: ReadonlyArray<ReconcilableThread>;
  readonly now: string;
}): ReadonlyArray<RestartReconciliationCommand> {
  const commands: RestartReconciliationCommand[] = [];
  for (const thread of input.threads) {
    if (!needsRestartReconciliation(thread)) {
      continue;
    }
    commands.push(...planStalePendingRequestCommands({ thread, now: input.now }));
    commands.push({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`restart-reconcile:${thread.id}:${input.now}`),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "interrupted",
        providerName: thread.session?.providerName ?? null,
        // Prefer the session's own mode; fall back to the thread default when the
        // thread never had a materialized session row.
        runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        activeTurnId: null,
        // "interrupted" is a clean stop, not an error: no lastError banner.
        lastError: null,
        updatedAt: input.now,
      },
      createdAt: input.now,
    });
  }
  return commands;
}

interface RestartProviderDeliveryBlocker {
  readonly eventSequence: number;
  readonly eventType: string;
  readonly threadId: ThreadId;
  readonly state: "dead" | "uncertain";
}

export interface RestartProviderDeliveryReconciliation {
  readonly eventSequence: number;
  readonly threadId: ThreadId;
  readonly expectedState: "uncertain";
  readonly outcome: "abandon";
  readonly reconciledBy: string;
  readonly note: string;
}

/**
 * Process loss is authoritative evidence that an old interrupt can no longer
 * control a live turn. Abandon only that obsolete uncertain command; ambiguous
 * starts and every other provider side effect remain fail-closed for explicit
 * operator reconciliation.
 */
export function planRestartProviderDeliveryReconciliations(input: {
  readonly blockers: ReadonlyArray<RestartProviderDeliveryBlocker>;
  readonly liveRuntimeThreadIds?: ReadonlySet<ThreadId>;
}): ReadonlyArray<RestartProviderDeliveryReconciliation> {
  const liveRuntimeThreadIds = input.liveRuntimeThreadIds ?? new Set<ThreadId>();
  return input.blockers
    .filter(
      (blocker) =>
        blocker.state === "uncertain" &&
        blocker.eventType === "thread.turn-interrupt-requested" &&
        !liveRuntimeThreadIds.has(blocker.threadId),
    )
    .toSorted((left, right) => left.eventSequence - right.eventSequence)
    .map((blocker) => ({
      eventSequence: blocker.eventSequence,
      threadId: blocker.threadId,
      expectedState: "uncertain" as const,
      outcome: "abandon" as const,
      reconciledBy: RESTART_PROVIDER_DELIVERY_RECONCILED_BY,
      note: RESTART_PROVIDER_DELIVERY_NOTE,
    }));
}

/**
 * Reconcile restart-orphaned turns once at boot.
 *
 * Reads the command read model (post-bootstrap projection state), hydrates only
 * stuck thread details to discover stale human requests, and dispatches the
 * resulting cleanup commands. Every failure mode is contained and logged: a
 * failed snapshot read or a failed individual dispatch must never block the
 * server from coming up.
 */
export const reconcileRestartStuckTurns: Effect.Effect<
  void,
  never,
  OrchestrationEngineService | ProjectionSnapshotQuery
> = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const readModel = yield* snapshotQuery.getCommandReadModel().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("restart turn reconciliation skipped: failed to read command snapshot", {
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  if (readModel === null) {
    return;
  }

  const now = new Date().toISOString();
  const stuckThreads = readModel.threads.filter(needsRestartReconciliation);
  if (stuckThreads.length === 0) {
    return;
  }

  const reconcilableThreads = yield* Effect.forEach(
    stuckThreads,
    (thread) =>
      snapshotQuery.getThreadDetailById(thread.id).pipe(
        Effect.map((detail) => Option.getOrElse(detail, () => thread)),
        Effect.catchCause((cause) =>
          Effect.logWarning("restart turn reconciliation continuing without thread activities", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as(thread)),
        ),
      ),
    { concurrency: 4 },
  );

  const commands = planRestartTurnReconciliation({ threads: reconcilableThreads, now });
  if (commands.length === 0) {
    return;
  }

  yield* Effect.logInfo("reconciling restart-stuck turns", {
    commandCount: commands.length,
    threadCount: stuckThreads.length,
    threadIds: stuckThreads.map((thread) => thread.id),
  });

  yield* Effect.forEach(
    commands,
    (command) =>
      engine.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to reconcile restart-stuck turn", {
            threadId: command.threadId,
            cause,
          }),
        ),
      ),
    { concurrency: 1, discard: true },
  );
});

/**
 * Release durable provider work that was quarantined behind an interrupt whose
 * target runtime died with the previous process. This runs after stale sessions
 * are event-sourced to `interrupted` and before commands are admitted.
 */
export const reconcileRestartProviderInterruptDeliveries: Effect.Effect<
  void,
  never,
  ProviderCommandReactor | ProviderService
> = Effect.gen(function* () {
  const providerCommandReactor = yield* ProviderCommandReactor;
  const providerService = yield* ProviderService;

  const liveRuntimeThreadIds = new Set(
    (yield* providerService.listSessions())
      .filter(
        (session) =>
          session.status === "connecting" ||
          session.status === "running" ||
          session.activeTurnId !== undefined,
      )
      .map((session) => session.threadId),
  );
  let afterEventSequence: number | undefined;
  while (true) {
    const blockers = yield* providerCommandReactor
      .listBlockingDeliveries({
        ...(afterEventSequence === undefined ? {} : { afterEventSequence }),
        limit: RESTART_PROVIDER_DELIVERY_RECONCILIATION_LIMIT,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "restart provider delivery reconciliation failed: could not list blockers",
            { cause },
          ).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
        Effect.orDie,
      );
    if (blockers.length === 0) {
      return;
    }

    const reconciliations = planRestartProviderDeliveryReconciliations({
      blockers,
      liveRuntimeThreadIds,
    });
    if (reconciliations.length > 0) {
      yield* Effect.logInfo("reconciling obsolete provider interrupts after restart", {
        reconciliationCount: reconciliations.length,
        eventSequences: reconciliations.map((entry) => entry.eventSequence),
        threadIds: reconciliations.map((entry) => entry.threadId),
      });

      yield* Effect.forEach(
        reconciliations,
        (reconciliation) =>
          providerCommandReactor.reconcileDelivery(reconciliation).pipe(
            Effect.tap((result) =>
              result === null
                ? Effect.logInfo("restart provider interrupt reconciliation became unnecessary", {
                    eventSequence: reconciliation.eventSequence,
                    threadId: reconciliation.threadId,
                  })
                : Effect.logInfo("restart provider interrupt reconciliation completed", {
                    eventSequence: result.eventSequence,
                    threadId: result.threadId,
                    outcome: result.outcome,
                    state: result.state,
                  }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to reconcile obsolete provider interrupt after restart", {
                eventSequence: reconciliation.eventSequence,
                threadId: reconciliation.threadId,
                cause,
              }).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
            Effect.orDie,
          ),
        { concurrency: 1, discard: true },
      );
    }

    if (blockers.length < RESTART_PROVIDER_DELIVERY_RECONCILIATION_LIMIT) {
      return;
    }
    const nextCursor = blockers[blockers.length - 1]?.eventSequence;
    if (
      nextCursor === undefined ||
      (afterEventSequence !== undefined && nextCursor <= afterEventSequence)
    ) {
      yield* Effect.logWarning(
        "restart provider delivery reconciliation stopped: blocker cursor did not advance",
        { afterEventSequence, nextCursor },
      );
      return;
    }
    afterEventSequence = nextCursor;
  }
});
