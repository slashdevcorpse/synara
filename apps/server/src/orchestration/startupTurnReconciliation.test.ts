import { EventId, ThreadId, TurnId } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "./Services/ProviderCommandReactor.ts";
import {
  planRestartProviderDeliveryReconciliations,
  planRestartTurnReconciliation,
  reconcileRestartProviderInterruptDeliveries,
  type ReconcilableThread,
} from "./startupTurnReconciliation.ts";

const NOW = "2026-06-14T10:00:00.000Z";

const makeThread = (
  id: string,
  overrides: Partial<Omit<ReconcilableThread, "id">> = {},
): ReconcilableThread => ({
  id: ThreadId.makeUnsafe(id),
  runtimeMode: "full-access",
  session: null,
  latestTurn: null,
  ...overrides,
});

const makeSession = (
  threadId: string,
  overrides: Partial<NonNullable<ReconcilableThread["session"]>> = {},
): NonNullable<ReconcilableThread["session"]> => ({
  threadId: ThreadId.makeUnsafe(threadId),
  status: "running",
  providerName: "grok",
  runtimeMode: "approval-required",
  activeTurnId: TurnId.makeUnsafe(`${threadId}-turn`),
  lastError: null,
  updatedAt: "2026-06-13T09:00:00.000Z",
  ...overrides,
});

const makeActivity = (
  id: string,
  kind: string,
  payload: NonNullable<ReconcilableThread["activities"]>[number]["payload"],
  sequence: number,
): NonNullable<ReconcilableThread["activities"]>[number] => ({
  id: EventId.makeUnsafe(id),
  kind,
  payload,
  sequence,
  createdAt: `2026-06-13T09:00:0${sequence}.000Z`,
});

const expectSessionCommands = (commands: ReturnType<typeof planRestartTurnReconciliation>) =>
  commands.map((command) => {
    expect(command.type).toBe("thread.session.set");
    if (command.type !== "thread.session.set") {
      throw new Error(`expected thread.session.set command, got ${command.type}`);
    }
    return command;
  });

describe("planRestartTurnReconciliation", () => {
  it("returns nothing for an empty thread set", () => {
    expect(planRestartTurnReconciliation({ threads: [], now: NOW })).toEqual([]);
  });

  it("leaves clean threads untouched (no active turn, no in-flight session, no open turn)", () => {
    const threads = [
      makeThread("idle-no-session"),
      makeThread("ready", {
        session: makeSession("ready", { status: "ready", activeTurnId: null }),
        latestTurn: { state: "completed" },
      }),
      makeThread("stopped", {
        session: makeSession("stopped", { status: "stopped", activeTurnId: null }),
        latestTurn: { state: "interrupted" },
      }),
      makeThread("errored", {
        session: makeSession("errored", {
          status: "error",
          activeTurnId: null,
          lastError: "boom",
        }),
        latestTurn: { state: "error" },
      }),
    ];

    expect(planRestartTurnReconciliation({ threads, now: NOW })).toEqual([]);
  });

  it("reconciles a thread whose session still points at an active turn", () => {
    const threads = [
      makeThread("stuck", {
        session: makeSession("stuck", {
          status: "running",
          activeTurnId: TurnId.makeUnsafe("stuck-turn"),
        }),
        latestTurn: { state: "running" },
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command).toEqual({
      type: "thread.session.set",
      commandId: `restart-reconcile:stuck:${NOW}`,
      threadId: "stuck",
      createdAt: NOW,
      session: {
        threadId: "stuck",
        status: "interrupted",
        providerName: "grok",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });
  });

  it("resolves stale pending approval and user-input requests before interrupting the session", () => {
    const threads = [
      makeThread("stuck-with-requests", {
        session: makeSession("stuck-with-requests", {
          status: "running",
          activeTurnId: TurnId.makeUnsafe("stuck-with-requests-turn"),
        }),
        latestTurn: { state: "running" },
        activities: [
          makeActivity(
            "approval-requested",
            "approval.requested",
            {
              requestId: "approval-1",
              requestKind: "command",
            },
            1,
          ),
          makeActivity(
            "approval-requested-resolved",
            "approval.requested",
            {
              requestId: "approval-resolved",
              requestKind: "command",
            },
            2,
          ),
          makeActivity(
            "approval-resolved",
            "approval.resolved",
            {
              requestId: "approval-resolved",
              decision: "cancel",
            },
            3,
          ),
          makeActivity(
            "user-input-requested",
            "user-input.requested",
            {
              requestId: "input-1",
              questions: [
                {
                  id: "next_step",
                  header: "Next",
                  question: "How should the recovered turn continue?",
                  options: [
                    {
                      label: "Cancel",
                      description: "Stop the stale request.",
                    },
                  ],
                },
              ],
            },
            4,
          ),
          makeActivity(
            "user-input-requested-resolved",
            "user-input.requested",
            {
              requestId: "input-resolved",
              questions: [
                {
                  id: "next_step",
                  header: "Next",
                  question: "How should the recovered turn continue?",
                  options: [
                    {
                      label: "Cancel",
                      description: "Stop the stale request.",
                    },
                  ],
                },
              ],
            },
            5,
          ),
          makeActivity(
            "user-input-resolved",
            "user-input.resolved",
            {
              requestId: "input-resolved",
              answers: {},
            },
            6,
          ),
        ],
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });

    expect(commands.map((command) => command.type)).toEqual([
      "thread.activity.append",
      "thread.activity.append",
      "thread.session.set",
    ]);
    expect(commands[0]).toMatchObject({
      type: "thread.activity.append",
      commandId: `restart-reconcile:stuck-with-requests:approval:approval-1:${NOW}`,
      threadId: "stuck-with-requests",
      activity: {
        kind: "provider.approval.respond.failed",
        payload: {
          requestId: "approval-1",
          detail: expect.stringContaining("Stale pending approval request: approval-1"),
        },
      },
    });
    expect(commands[1]).toMatchObject({
      type: "thread.activity.append",
      commandId: `restart-reconcile:stuck-with-requests:user-input:input-1:${NOW}`,
      threadId: "stuck-with-requests",
      activity: {
        kind: "provider.user-input.respond.failed",
        payload: {
          requestId: "input-1",
          detail: expect.stringContaining("Stale pending user-input request: input-1"),
        },
      },
    });
    expect(commands[2]).toMatchObject({
      type: "thread.session.set",
      threadId: "stuck-with-requests",
      session: {
        status: "interrupted",
        activeTurnId: null,
      },
    });
  });

  it("reconciles an in-flight session even with no active turn id (starting/running)", () => {
    const threads = [
      makeThread("starting", {
        session: makeSession("starting", { status: "starting", activeTurnId: null }),
      }),
      makeThread("running-no-turn", {
        session: makeSession("running-no-turn", { status: "running", activeTurnId: null }),
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    const sessionCommands = expectSessionCommands(commands);
    expect(sessionCommands.map((command) => command.threadId)).toEqual([
      "starting",
      "running-no-turn",
    ]);
    expect(sessionCommands.every((command) => command.session.activeTurnId === null)).toBe(true);
    expect(sessionCommands.every((command) => command.session.status === "interrupted")).toBe(true);
  });

  it("heals an open turn projection even when the session already looks terminal", () => {
    const threads = [
      makeThread("orphan-turn", {
        session: makeSession("orphan-turn", { status: "interrupted", activeTurnId: null }),
        latestTurn: { state: "running" },
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.threadId).toBe("orphan-turn");
  });

  it("falls back to the thread runtime mode and a null provider when no session row exists", () => {
    const threads = [
      makeThread("no-session-open-turn", {
        runtimeMode: "approval-required",
        session: null,
        latestTurn: { state: "running" },
      }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    expect(commands).toHaveLength(1);
    const sessionCommands = expectSessionCommands(commands);
    expect(sessionCommands[0]?.session).toMatchObject({
      providerName: null,
      runtimeMode: "approval-required",
      status: "interrupted",
      activeTurnId: null,
    });
  });

  it("selects only the stuck threads from a mixed set, preserving order", () => {
    const threads = [
      makeThread("clean-a", {
        session: makeSession("clean-a", { status: "ready", activeTurnId: null }),
        latestTurn: { state: "completed" },
      }),
      makeThread("stuck-a", {
        session: makeSession("stuck-a", {
          status: "running",
          activeTurnId: TurnId.makeUnsafe("stuck-a-turn"),
        }),
      }),
      makeThread("clean-b"),
      makeThread("stuck-b", { latestTurn: { state: "running" } }),
    ];

    const commands = planRestartTurnReconciliation({ threads, now: NOW });
    expect(commands.map((command) => command.threadId)).toEqual(["stuck-a", "stuck-b"]);
  });

  it("produces deterministic command ids for identical inputs", () => {
    const threads = [
      makeThread("stuck", {
        session: makeSession("stuck", { status: "running" }),
      }),
    ];

    const first = planRestartTurnReconciliation({ threads, now: NOW });
    const second = planRestartTurnReconciliation({ threads, now: NOW });
    expect(first[0]?.commandId).toBe(second[0]?.commandId);
    expect(first[0]?.commandId).toBe(`restart-reconcile:stuck:${NOW}`);
  });
});

describe("planRestartProviderDeliveryReconciliations", () => {
  const blocker = (
    eventSequence: number,
    overrides: Partial<{
      eventType: string;
      threadId: ThreadId;
      state: "dead" | "uncertain";
    }> = {},
  ) => ({
    eventSequence,
    eventType: "thread.turn-interrupt-requested",
    threadId: ThreadId.makeUnsafe(`thread-${eventSequence}`),
    state: "uncertain" as const,
    ...overrides,
  });

  const deliveryEvidence = (
    eventSequence: number,
    overrides: Parameters<typeof blocker>[1] = {},
  ) => ({
    ...blocker(eventSequence, overrides),
    consumerName: "provider-command-reactor.v1",
    eventId: EventId.makeUnsafe(`event-${eventSequence}`),
    occurredAt: NOW,
    attemptCount: 1,
    lastError: "Timed out waiting for provider delivery.",
    updatedAt: NOW,
    lastReconciliationOutcome: null,
    lastReconciledAt: null,
    lastReconciledBy: null,
    lastReconciliationNote: null,
  });

  it("abandons only obsolete uncertain interrupts in source order", () => {
    const reconciliations = planRestartProviderDeliveryReconciliations({
      blockers: [
        blocker(8),
        blocker(3),
        blocker(4, { state: "dead" }),
        blocker(5, { eventType: "thread.turn-start-requested" }),
      ],
    });

    expect(reconciliations).toEqual([
      expect.objectContaining({
        eventSequence: 3,
        threadId: "thread-3",
        expectedState: "uncertain",
        outcome: "abandon",
        reconciledBy: "server-startup-recovery",
      }),
      expect.objectContaining({
        eventSequence: 8,
        threadId: "thread-8",
        expectedState: "uncertain",
        outcome: "abandon",
        reconciledBy: "server-startup-recovery",
      }),
    ]);
    expect(reconciliations.every((entry) => entry.note.includes("must not be replayed"))).toBe(
      true,
    );
  });

  it("leaves an uncertain interrupt quarantined when a replacement runtime is live", () => {
    const liveThreadId = ThreadId.makeUnsafe("thread-live");

    expect(
      planRestartProviderDeliveryReconciliations({
        blockers: [blocker(10, { threadId: liveThreadId })],
        liveRuntimeThreadIds: new Set([liveThreadId]),
      }),
    ).toEqual([]);
  });

  it("reconciles eligible blockers sequentially through the provider reactor", async () => {
    const reconciledSequences: number[] = [];
    const liveThreadId = ThreadId.makeUnsafe("thread-live");
    const connectingThreadId = ThreadId.makeUnsafe("thread-connecting");
    const activeTurnThreadId = ThreadId.makeUnsafe("thread-active-turn");
    const reactor = {
      start: Effect.void,
      drain: Effect.void,
      listBlockingDeliveries: () =>
        Effect.succeed([
          {
            ...blocker(12),
            consumerName: "provider-command-reactor.v1",
            eventId: EventId.makeUnsafe("event-12"),
            occurredAt: NOW,
            attemptCount: 1,
            lastError: "Timed out waiting for turn/interrupt.",
            updatedAt: NOW,
            lastReconciliationOutcome: null,
            lastReconciledAt: null,
            lastReconciledBy: null,
            lastReconciliationNote: null,
          },
          {
            ...blocker(14, { threadId: connectingThreadId }),
            consumerName: "provider-command-reactor.v1",
            eventId: EventId.makeUnsafe("event-14"),
            occurredAt: NOW,
            attemptCount: 1,
            lastError: "Timed out waiting for turn/interrupt.",
            updatedAt: NOW,
            lastReconciliationOutcome: null,
            lastReconciledAt: null,
            lastReconciledBy: null,
            lastReconciliationNote: null,
          },
          {
            ...blocker(13, { threadId: activeTurnThreadId }),
            consumerName: "provider-command-reactor.v1",
            eventId: EventId.makeUnsafe("event-13"),
            occurredAt: NOW,
            attemptCount: 1,
            lastError: "Timed out waiting for turn/interrupt.",
            updatedAt: NOW,
            lastReconciliationOutcome: null,
            lastReconciledAt: null,
            lastReconciledBy: null,
            lastReconciliationNote: null,
          },
          {
            ...blocker(11, { threadId: liveThreadId }),
            consumerName: "provider-command-reactor.v1",
            eventId: EventId.makeUnsafe("event-11"),
            occurredAt: NOW,
            attemptCount: 1,
            lastError: "Timed out waiting for turn/interrupt.",
            updatedAt: NOW,
            lastReconciliationOutcome: null,
            lastReconciledAt: null,
            lastReconciledBy: null,
            lastReconciliationNote: null,
          },
          {
            ...blocker(10),
            consumerName: "provider-command-reactor.v1",
            eventId: EventId.makeUnsafe("event-10"),
            occurredAt: NOW,
            attemptCount: 1,
            lastError: "Timed out waiting for turn/interrupt.",
            updatedAt: NOW,
            lastReconciliationOutcome: null,
            lastReconciledAt: null,
            lastReconciledBy: null,
            lastReconciliationNote: null,
          },
        ]),
      reconcileDelivery: (input: { readonly eventSequence: number; readonly threadId: ThreadId }) =>
        Effect.sync(() => {
          reconciledSequences.push(input.eventSequence);
          return {
            eventSequence: input.eventSequence,
            threadId: input.threadId,
            outcome: "abandon" as const,
            state: "succeeded" as const,
            reconciledAt: NOW,
          };
        }),
    } as unknown as ProviderCommandReactorShape;
    const providerService = {
      listSessions: () =>
        Effect.succeed([
          {
            provider: "codex",
            status: "running",
            runtimeMode: "full-access",
            threadId: liveThreadId,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            provider: "codex",
            status: "connecting",
            runtimeMode: "full-access",
            threadId: connectingThreadId,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            provider: "codex",
            status: "ready",
            runtimeMode: "full-access",
            threadId: activeTurnThreadId,
            activeTurnId: TurnId.makeUnsafe("turn-active"),
            createdAt: NOW,
            updatedAt: NOW,
          },
        ]),
    } as unknown as ProviderServiceShape;

    await Effect.runPromise(
      reconcileRestartProviderInterruptDeliveries.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderCommandReactor, reactor),
            Layer.succeed(ProviderService, providerService),
          ),
        ),
      ),
    );

    expect(reconciledSequences).toEqual([10, 12]);
  });

  it("pages past unrelated blockers to reconcile a later obsolete interrupt", async () => {
    const observedCursors: Array<number | undefined> = [];
    const reconciledSequences: number[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      deliveryEvidence(index + 1, {
        eventType: "thread.turn-start-requested",
      }),
    );
    const reactor = {
      start: Effect.void,
      drain: Effect.void,
      listBlockingDeliveries: (input: { readonly afterEventSequence?: number | undefined }) => {
        observedCursors.push(input.afterEventSequence);
        if (input.afterEventSequence === undefined) {
          return Effect.succeed(firstPage);
        }
        if (input.afterEventSequence === 100) {
          return Effect.succeed([deliveryEvidence(101)]);
        }
        return Effect.succeed([]);
      },
      reconcileDelivery: (input: { readonly eventSequence: number; readonly threadId: ThreadId }) =>
        Effect.sync(() => {
          reconciledSequences.push(input.eventSequence);
          return {
            eventSequence: input.eventSequence,
            threadId: input.threadId,
            outcome: "abandon" as const,
            state: "succeeded" as const,
            reconciledAt: NOW,
          };
        }),
    } as unknown as ProviderCommandReactorShape;
    const providerService = {
      listSessions: () => Effect.succeed([]),
    } as unknown as ProviderServiceShape;

    await Effect.runPromise(
      reconcileRestartProviderInterruptDeliveries.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderCommandReactor, reactor),
            Layer.succeed(ProviderService, providerService),
          ),
        ),
      ),
    );

    expect(observedCursors).toEqual([undefined, 100]);
    expect(reconciledSequences).toEqual([101]);
  });

  it("fails closed when startup cannot list blocking deliveries", async () => {
    const listingFailure = new Error("injected blocker listing failure");
    let reconciliationAttempted = false;
    let continuedAfterReconciliation = false;
    const reactor = {
      start: Effect.void,
      drain: Effect.void,
      listBlockingDeliveries: () => Effect.fail(listingFailure),
      reconcileDelivery: () =>
        Effect.sync(() => {
          reconciliationAttempted = true;
          return null;
        }),
    } as unknown as ProviderCommandReactorShape;
    const providerService = {
      listSessions: () => Effect.succeed([]),
    } as unknown as ProviderServiceShape;
    const program = reconcileRestartProviderInterruptDeliveries.pipe(
      Effect.andThen(
        Effect.sync(() => {
          continuedAfterReconciliation = true;
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderCommandReactor, reactor),
          Layer.succeed(ProviderService, providerService),
        ),
      ),
    );

    await expect(Effect.runPromise(program)).rejects.toThrow("injected blocker listing failure");
    expect(reconciliationAttempted).toBe(false);
    expect(continuedAfterReconciliation).toBe(false);
  });

  it("fails closed on the first delivery reconciliation error", async () => {
    const reconciliationFailure = new Error("injected delivery reconciliation failure");
    const attemptedSequences: number[] = [];
    let continuedAfterReconciliation = false;
    const reactor = {
      start: Effect.void,
      drain: Effect.void,
      listBlockingDeliveries: () => Effect.succeed([deliveryEvidence(10), deliveryEvidence(11)]),
      reconcileDelivery: (input: { readonly eventSequence: number; readonly threadId: ThreadId }) =>
        Effect.gen(function* () {
          attemptedSequences.push(input.eventSequence);
          if (input.eventSequence === 10) {
            return yield* Effect.fail(reconciliationFailure);
          }
          return {
            eventSequence: input.eventSequence,
            threadId: input.threadId,
            outcome: "abandon" as const,
            state: "succeeded" as const,
            reconciledAt: NOW,
          };
        }),
    } as unknown as ProviderCommandReactorShape;
    const providerService = {
      listSessions: () => Effect.succeed([]),
    } as unknown as ProviderServiceShape;
    const program = reconcileRestartProviderInterruptDeliveries.pipe(
      Effect.andThen(
        Effect.sync(() => {
          continuedAfterReconciliation = true;
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderCommandReactor, reactor),
          Layer.succeed(ProviderService, providerService),
        ),
      ),
    );

    await expect(Effect.runPromise(program)).rejects.toThrow(
      "injected delivery reconciliation failure",
    );
    expect(attemptedSequences).toEqual([10]);
    expect(continuedAfterReconciliation).toBe(false);
  });
});
