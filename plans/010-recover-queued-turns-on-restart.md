# Plan 010: Recover queued-but-unstarted turns across a server restart

> **Executor instructions**: Phase 1 was completed and Option B was approved on
> 2026-07-07; its conclusions are recorded below. Continue from the implementation
> branch, but apply Corrections A and B before calling the work complete. Run every
> verification command and confirm the expected result before moving on. When the
> approved implementation is actually merged, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat d94f416d9..HEAD -- packages/contracts/src/orchestration.ts apps/server/src/effectServer.ts apps/server/src/orchestration/projector.ts apps/server/src/orchestration/Layers/ProjectionPipeline.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.ts apps/server/src/orchestration/startupTurnReconciliation.ts apps/server/src/persistence/Migrations.ts apps/server/src/persistence/Layers/ProjectionThreads.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Verification permission gate**: the commands below describe required pass
> criteria, not authorization. Do not run `bun fmt`, `bun lint`, or
> `bun typecheck` unless the operator explicitly asks in that execution
> conversation. Without that authorization, run allowed focused tests, record
> final validation as pending, and do not mark the plan DONE.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d94f416d9`, 2026-07-07

## Why this matters

When a thread already has an active turn running, additional user messages are
**queued** to dispatch afterward. That queue lives exclusively in an in-memory
`Map` in the reactor (`queuedTurnStartsByThread`), populated from the live-only
`thread.turn-queued` intent event. It is never persisted, and startup
reconciliation only heals turns that were already _running_ at crash time — not
merely queued ones. So if the server restarts (deploy, crash, update) while a
thread has queued turns behind an active turn, those queued turns vanish forever:
the underlying user message stays durably persisted and visible in the UI, but
nothing ever dispatches it. The thread is silently "stuck" and the user must
notice and manually resend. This violates the "reliability first" / "predictable
behavior during failures (session restarts)" priorities in `CLAUDE.md`.

## Current state

### The in-memory queue (no persistence)

`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:293-295`:

```ts
const queuedTurnStartsByThread = new Map<
  ThreadId,
  Array<Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>["payload"]>
>();
```

Mutated only by plain `Effect.sync` Map operations
(`ProviderCommandReactor.ts:447-499`): `enqueueQueuedTurnStart`,
`dequeueQueuedTurnStart`, `removeQueuedTurnStart`, `hasQueuedTurnStart`. No
persistence, no rehydration (`grep -n "rehydrat\|restoreQueued\|bootstrapQueued"
apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` → no matches).

### Where the queue decision is made

`apps/server/src/orchestration/decider.ts:1146` emits
`thread.turn-queued` (vs `thread.turn-start-requested`) when a turn should queue.

**Premise correction (2026-07-07, after Phase 1 investigation — supersedes the
original claim that this event is intent-only):** `thread.turn-queued` IS a
durably persisted event. It appears at `packages/contracts/src/orchestration.ts:1365`
inside `OrchestrationEventType` (the persisted event union), and
`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:398` appends every
decided event — including `thread.turn-queued` — to the event store via
`eventStore.append`. HOWEVER, `apps/server/src/orchestration/projector.ts` has a
`case "thread.turn-start-requested"` (line 648) but **no case for
`thread.turn-queued`** — it falls through to the no-op `default` (line 1057). A
user message's `turnId` is set to `null` at creation and is never stamped
afterward. **Consequence**: the durable event exists in the log, but the
projection cannot today distinguish "queued but never dispatched" from
"dispatched" — so a pure planner over projection state (Option A) would risk
double-dispatch. This makes **Option B the approved approach** (see Phase 2).

The reactor still consumes the live intent via `Stream.fromPubSub(eventPubSub)`
(live-only, no replay) into the in-memory map — that is why a restart loses the
queue even though the event is in the log.

### The existing restart-heal pattern to mirror

`apps/server/src/orchestration/startupTurnReconciliation.ts` runs once at boot,
after projection bootstrap and before accepting client commands. It is built as a
**pure planner** — `planRestartTurnReconciliation({ threads, now })` returns an
array of `OrchestrationCommand`s — with focused unit tests in
`startupTurnReconciliation.test.ts` (the planner is tested in complete isolation
using `makeThread`/`makeSession` fixtures). `needsRestartReconciliation`
(lines ~81-87) decides which threads need healing based purely on persisted
projection state. This supplies the pattern for the pure part of queued-turn
recovery. Its output must be ordered rehydration batches consumed by the
reactor's existing one-at-a-time drain, not one immediately dispatchable command
per queued message.

The Phase 1 answer is now known: queued turns have a durable event-log marker,
but no durable **projection** marker. Recovery therefore needs the approved
Option B projection extension described below; it must not guess from messages or
scan the full event log at boot.

## Commands you will need

| Purpose              | Command                                                                                  | Expected on success |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------- |
| Reactor tests        | `cd apps/server && bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts` | all pass            |
| Reconciliation tests | `cd apps/server && bun run test src/orchestration/startupTurnReconciliation.test.ts`     | all pass            |
| Typecheck            | `cd apps/server && bun run typecheck`                                                    | exit 0, no errors   |
| Full suite           | `bun run test`                                                                           | all pass            |

Repo rule (`AGENTS.md`): use `bun run test`, never `bun test`.

## Scope

**In scope (Phase 2, Option B approved)**:

- `packages/contracts/src/orchestration.ts` and the server projection schemas —
  add a safely-defaulted queued-turn projection entry and its lifecycle state.
- Both projection paths: `apps/server/src/orchestration/projector.ts` (pure replay)
  and `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (persisted
  projection), plus their focused tests. Keep their queue transitions in one
  shared `queuedTurnsProjection.ts` helper so the semantics cannot drift.
- The projection-thread repository, snapshot query, and a new additive migration.
  `051` is already occupied on current `main`; rebase the implementation branch
  and use the next available migration id (currently `052`) instead of keeping
  the branch's conflicting `051_ProjectionThreadsQueuedTurns` migration.
- `apps/server/src/orchestration/startupTurnReconciliation.ts` and tests — add a
  pure planner that returns ordered per-thread rehydration batches.
- `ProviderCommandReactor.ts` and tests — expose a minimal idempotent
  rehydrate-and-drain entry point that preserves the normal one-at-a-time gate.
- Boot wiring (currently `effectServer.ts`) — run recovery after projections are
  ready and before client commands are accepted.
- No brand-new durable event or table is needed — the `thread.turn-queued` event
  already exists; this only adds projection state derived from it.

**Out of scope**:

- Changing the queueing _policy_ in `decider.ts` (when to queue vs start). This
  plan recovers existing queued turns; it does not change queue semantics.
- The `startupTurnReconciliation` running-turn healing behavior — do not alter how
  already-running orphaned turns are reconciled.
- Any UI change. Recovery is server-side; the UI already shows the durable message.

## Phase 1 — Completed investigation

The approved design rests on three findings:

1. `thread.turn-queued` already persists the full queued request payload in the
   event log, but neither projection path materializes it. The user message alone
   is insufficient because its `turnId` remains `null` for both queued and
   immediately-dispatched messages.
2. Existing projection state cannot distinguish a queued message that never
   dispatched from one that later ran. Option A (guessing from the current thread
   shell or scanning the whole event log at boot) is therefore rejected.
3. Option B was approved: project the existing event into an ordered queue,
   retain an entry while dispatch is merely requested, and clear it only after a
   durable runtime-start signal proves the provider turn began. The reactor's
   in-memory duplicate guards remain a second, process-local layer.

The remaining work is to correct the already-started Option B implementation and
verify the crash windows below; no additional design-note file or approval stop
is required.

## Phase 2 — Implementation (Option B APPROVED 2026-07-07)

**Approved approach — Option B (project the existing durable event):** The
`thread.turn-queued` event is already persisted; the gap is that it is not
projected and cannot be queried at boot. Phase 2:

1. **Add a queued-turns field to the projected thread shell**, defaulted safely
   for old rows. Keep enough payload to re-dispatch in original order, and record
   lifecycle as `queued` or `dispatch-requested`; the latter remains recoverable
   until provider start is durably observed.
2. **Teach both projection paths the same queue lifecycle.** Use a shared pure
   helper from `projector.ts` and `ProjectionPipeline.ts`: `thread.turn-queued`
   appends/deduplicates by message id; `thread.turn-start-requested` marks the
   matching entry `dispatch-requested` but does not remove it; withdrawal events
   remove withdrawn entries; and the durable `thread.session-set` transition to
   `running` removes only the message correlated with that accepted provider
   start. In the persisted pipeline, reuse its pending-turn-start row to retain
   the message-id correlation until the running session event arrives.
3. **Rehydrate the queue and drain one-at-a-time (NOT fire-all).** See the
   "Correction A" box below — recovery must re-populate the reactor's in-memory
   queue and let the normal single-dispatch gate drain it, rather than emitting a
   dispatch command per queued turn.

> **Correction A (added after PR review — serialization) — comment #4.**
> An earlier draft had `planQueuedTurnRecovery` emit a dispatch/enqueue command
> for **every** queued turn at boot. That is wrong: the reactor promotes queued
> turns strictly one at a time via `dequeueQueuedTurnStart`
> (`ProviderCommandReactor.ts:1531`), only starting the next after the current
> provider turn settles. Firing N dispatch commands at boot bypasses that gate and
> can promote several messages concurrently before the first turn opens its
> provider thread. Instead, recovery must **rehydrate** the in-memory
> `queuedTurnStartsByThread` map from the projected `queuedTurns` (in original
> order, honoring the steer/queue ordering `enqueueQueuedTurnStart` encodes at
> `ProviderCommandReactor.ts:452-456`) and then kick the normal drain so only the
> head dispatches; the rest wait behind it exactly as they would have pre-restart.
> Make the serialization guarantee testable: a restart with 3 queued turns behind
> a killed active turn must result in exactly one provider-turn start, not three.
> If the reactor has no public entry point to rehydrate + drain, add a minimal one
> rather than fanning out dispatch commands.

> **Correction B (added after PR review — do not clear on the request event) —
> comment #6.** Clearing the `queuedTurns` entry when `thread.turn-start-requested`
> is *projected* is premature. `turn-start-requested` is a request; the reactor
> still has to run `processTurnStartRequested` to actually open the provider turn.
> If the server crashes AFTER that event is appended but BEFORE the provider turn
> starts, then on restart: the in-memory queue is empty (rebuilt), no session is
> "running" so `planRestartTurnReconciliation` won't catch it, and if
> `queuedTurns` was already cleared the message vanishes with nothing to recover
> it. Therefore mark the entry `dispatch-requested` on that event and clear it
> only when the durable `thread.session-set` projection reports
> `status: "running"` with a non-null `activeTurnId`, correlated back to the
> pending start's message id. Equivalently: a turn that is "requested but not yet
> running" remains in `queuedTurns` and recovery re-drives it. Keep the
> withdrawal clears (revert / rollback / edit-resend) as already specified. Add
> a test for the crash-between-request-and-start window: a thread with
> `turn-start-requested` projected but no running turn still has its entry and is
> recovered. If either projection path cannot preserve that message-id
> correlation until `thread.session-set`, STOP rather than clearing by position
> or by request alone.

4. **Add the recovery entry point** (replacing the old "pure planner emits
   commands" step per Correction A): at the same boot stage as
   `planRestartTurnReconciliation` (after projection bootstrap, before accepting
   client commands), read each thread's projected `queuedTurns` and rehydrate +
   drain-head through the reactor. Keep the decision logic (which threads/turns to
   rehydrate, in what order) in a pure, unit-tested function with fixtures, exactly
   like `startupTurnReconciliation.test.ts`; the impure part is only the
   rehydrate+kick call into the reactor.

Implementation requirements:

- Reuse the pure-planner + isolated-unit-test pattern of
  `startupTurnReconciliation.ts` / `.test.ts`. Any recovery decision logic must be
  a pure function tested with fixtures (no live runtime in the unit test).
- Recovery must be **idempotent**: running it twice (or a message that actually
  ran) must not double-dispatch. Add an explicit test for this.
- Recovery must run at the same boot stage as `startupTurnReconciliation` (after
  projection bootstrap, before accepting client commands) so recovered turns
  dispatch through the normal path.
- The additive schema and migration MUST decode pre-existing rows safely; old
  data with no queue records must project as an empty queue and boot normally.

**Verify** (Phase 2): `cd apps/server && bun run test
src/orchestration/startupTurnReconciliation.test.ts
src/orchestration/Layers/ProviderCommandReactor.test.ts` → all pass, including new
recovery + idempotency cases. `cd apps/server && bun run typecheck` → exit 0.

## Test plan

- Projection tests in both `projector.test.ts` and `ProjectionPipeline.test.ts`:
  queued → dispatch-requested remains durable; a running session clears only the
  correlated message; revert/rollback/edit-resend clear withdrawn entries; old
  rows default to an empty queue.
- Planner/reactor tests:
  - One recoverable entry produces one rehydration item and one initial dispatch.
  - Three recovered entries preserve steer/queue ordering but start exactly one
    provider turn; each terminal event drains only the next item.
  - A dispatch-requested entry with no running session is recovered after restart.
  - An entry whose provider turn durably reached running is absent and emits
    nothing (idempotency / no double-dispatch).
  - Rehydrating the same batch twice does not duplicate the in-memory queue.
  - Empty/clean thread set → empty recovery batches.
- Structural pattern: `apps/server/src/orchestration/startupTurnReconciliation.test.ts`.

## Done criteria

Phase 1:

- [x] Q1–Q3 are recorded in this plan and Option B was approved on 2026-07-07.

Phase 2 (after approval), ALL must hold:

- [ ] `cd apps/server && bun run typecheck` exits 0.
- [ ] `bun run test` exits 0; new recovery + idempotency tests exist and pass.
- [ ] A pure planner returns ordered rehydration batches and is unit-tested in isolation.
- [ ] Both projection paths retain request-only entries and clear only the
  message correlated with a durable provider-start transition.
- [ ] Multiple recovered messages still dispatch one-at-a-time through the
  reactor's normal drain gate.
- [ ] Recovery runs at boot before client commands are accepted.
- [ ] `bun run fmt` and `bun run lint` pass (final validation pass).
- [ ] No files outside the approved in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 010 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code (drift).
- Either projection path cannot correlate a `thread.session-set` running
  transition to the pending queued message id — do not clear by queue position.
- The rebased implementation would reuse an occupied migration id or rewrite an
  already-landed migration; allocate a new additive id instead.
- Rehydrating the same batch twice can duplicate an in-memory queue entry, or
  boot recovery can bypass the existing one-at-a-time drain gate.
- Recovery would require changing `decider.ts` queue policy — that is out of scope.

## Maintenance notes

- The durable queue record is part of the projection schema contract; document it
  where other durable orchestration projections are documented.
- Reviewer should scrutinize idempotency above all: a recovery that double-runs a
  turn is worse than the bug it fixes.
- Related: `startupTurnReconciliation` handles running-turn orphans; this is its
  queued-turn counterpart. Keep the two planners consistent in style and boot
  ordering.
