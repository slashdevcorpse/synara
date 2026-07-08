# Plan 008: Cut redundant per-delta streaming scans and allocations

> **Accuracy note (added after PR review):** an earlier version of this plan
> claimed an "O(1) per delta" update. That claim is **wrong** and has been
> removed. Even with the one-pass slice builder below, the writer still visits
> every message, so per-delta cost stays **O(thread history)** — capped at 2,000.
> What this plan actually buys is narrower: (a) removing the redundant second
> lookup scan and (b) building the
> ids array and id→message record in one pass without the
> `Object.fromEntries(...map(...))` tuple-array allocation. The old implementation
> already preserved the exact message object references for unchanged entries;
> this plan must preserve that behavior, but it cannot claim it as a new win. The
> top-level ids array and by-id record still change on every delta, so downstream
> selectors that subscribe to those containers may still re-derive.
> A genuinely O(1) update is possible but out of scope here (see "Truly-O(1)
> follow-up" at the end); do not mark the perf work "complete" on an O(1) basis.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat d94f416d9..HEAD -- apps/web/src/store.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.
>
> **Verification permission gate**: the commands below describe required pass
> criteria, not authorization. Do not run `bun fmt`, `bun lint`, or
> `bun typecheck` unless the operator explicitly asks in that execution
> conversation. Without that authorization, run allowed focused tests, record
> final validation as pending, and do not mark the plan DONE.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `d94f416d9`, 2026-07-07

## Why this matters

`thread.message-sent` is the highest-frequency streaming event in the app — it
fires on every assistant text delta. Its reducer currently scans the whole
per-thread messages array **twice** (`find` then `findIndex` for the same id),
copies the entire array with `.map()`, and then the state-writer rebuilds the
`messageByThreadId` id→message `Record` from scratch via `Object.fromEntries` over
every message in the thread. On a long conversation (capped at 2,000 messages)
this is O(history) work repeated dozens-to-hundreds of times per turn. This plan
does not change that complexity or the top-level container identities, but it
removes redundant traversals and a short-lived tuple array from the hottest path
in the client. "Performance first" is the repo's stated #1 priority, so this
constant-factor cleanup is worthwhile as long as its benefit is described
accurately.

## Current state

File: `apps/web/src/store.ts`. Relevant constants: `MAX_THREAD_MESSAGES = 2_000`
(`store.ts:107`).

The double scan in `applyThreadMessageSentEvent` (`store.ts:3025-3061`):

```ts
function applyThreadMessageSentEvent(thread: Thread, event: ThreadMessageSentEvent): Thread {
  const payload = event.payload;
  const incomingMessage = normalizeChatMessage(
    {
      /* …payload fields… */
    },
    thread.messages.find((message) => message.id === payload.messageId), // scan #1
  );
  const existingIndex = thread.messages.findIndex((message) => message.id === payload.messageId); // scan #2 (same id)
  let messages = thread.messages;

  if (existingIndex >= 0) {
    const existingMessage = thread.messages[existingIndex];
    if (!existingMessage) {
      return thread;
    }
    const mergedMessage = mergeStreamingMessage(existingMessage, incomingMessage);
    if (mergedMessage !== null) {
      messages = thread.messages.map((message, index) =>
        index === existingIndex ? mergedMessage : message,
      );
    }
  } else {
    messages = [...thread.messages, incomingMessage].slice(-MAX_THREAD_MESSAGES);
  }
  // …builds turnDiffSummaries etc., returns updated thread…
}
```

`normalizeChatMessage(payload, existing?)` takes the existing message (found by
scan #1) as its second argument. Scan #2 re-finds the same message to get its
index. These can be a single pass.

The full-record rebuild in the state writer (`store.ts:481-491, 2344-2357`):

```ts
function buildMessageSlice(thread: Thread): {
  ids: MessageId[];
  byId: Record<MessageId, ChatMessage>;
} {
  return {
    ids: thread.messages.map((message) => message.id),
    byId: Object.fromEntries(
      thread.messages.map((message) => [message.id, message] as const),
    ) as Record<MessageId, ChatMessage>,
  };
}

// writeThreadState (store.ts:2344):
if (previousThread?.messages !== nextThread.messages) {
  const nextMessageSlice = buildMessageSlice(nextThread);
  nextState = {
    ...nextState,
    messageIdsByThreadId: {
      ...(nextState.messageIdsByThreadId ?? EMPTY_MESSAGE_IDS_BY_THREAD),
      [nextThread.id]: nextMessageSlice.ids,
    },
    messageByThreadId: {
      ...(nextState.messageByThreadId ?? EMPTY_MESSAGE_BY_THREAD),
      [nextThread.id]: nextMessageSlice.byId,
    },
  };
}
```

Every event that changes the `messages` array reference (i.e. every streaming
delta) rebuilds the entire `ids` array and `byId` record for the thread.

## Commands you will need

| Purpose             | Command                                         | Expected on success                                 |
| ------------------- | ----------------------------------------------- | --------------------------------------------------- |
| Focused store tests | `cd apps/web && bun run test src/store.test.ts` | all pass                                            |
| Typecheck (web)     | `cd apps/web && bun run typecheck`              | exit 0, no errors                                   |
| Full suite          | `bun run test`                                  | all pass                                            |

Repo rule (`AGENTS.md`): use `bun run test`, never `bun test`. The existing
`apps/web/src/store.test.ts` already exercises the real reducer entry point; add
the focused streaming cases there instead of creating a parallel harness.

## Scope

**In scope**:

- `apps/web/src/store.ts` — `applyThreadMessageSentEvent`, `buildMessageSlice`,
  and the `writeThreadState` messages branch.
- `apps/web/src/store.test.ts` — add the focused streaming characterization cases.

**Out of scope** (do NOT touch in this plan):

- Activities / proposedPlans / turnDiffSummaries slices (`buildActivitySlice`,
  `buildProposedPlanSlice`, `buildTurnDiffSlice`). They share the same pattern and
  are worth a follow-up, but bundling them here inflates risk. Note them in
  Maintenance notes only.
- `mergeStreamingMessage` semantics — do not change how merges compute text; only
  change how the message is located.
- Any downstream selector/component. The observable state shape
  (`messageByThreadId`, `messageIdsByThreadId`, `thread.messages`) must be
  byte-for-byte equivalent after this change.

## Git workflow

- Branch: `advisor/008-streaming-store-hot-path`
- Commit style: match `git log` (short imperative subjects). One commit per step.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add characterization tests FIRST (lock current behavior)

Before changing anything, write tests that pin the current observable behavior so
the optimization can be proven equivalent. In `apps/web/src/store.test.ts`,
cover these cases using its real reducer entry-point harness for applying a
`thread.message-sent` event:

1. **New assistant message** appended → appears in `thread.messages` and in
   `messageByThreadId[threadId]` with the right text.
2. **Streaming delta to an existing message** (same `messageId`, longer text) →
   the message text updates in place, array length unchanged, `messageByThreadId`
   entry updated.
3. **Out-of-order / duplicate delta** (same id, same-or-shorter text) → behavior
   matches current `mergeStreamingMessage` result (assert whatever the current
   code produces — run it once to observe, then encode that expectation).
4. **Cap behavior**: appending beyond `MAX_THREAD_MESSAGES` keeps the last 2,000
   and `messageByThreadId` contains exactly those ids.
5. **Reference-stability regression guard**: after a delta to one message,
   unrelated messages remain the same object references (`===`) as before. This
   is existing behavior that the optimization must not regress.

**Verify**: `cd apps/web && bun run test src/store.test.ts` → all pass
against the **unchanged** implementation. If any assertion is wrong, fix the
assertion to match current behavior (this step documents reality, it does not
change it).

### Step 2: Collapse the double scan in `applyThreadMessageSentEvent`

Compute the index once and reuse it:

```ts
const existingIndex = thread.messages.findIndex((message) => message.id === payload.messageId);
const existingMessage = existingIndex >= 0 ? thread.messages[existingIndex] : undefined;
const incomingMessage = normalizeChatMessage(
  {
    /* …payload fields… */
  },
  existingMessage,
);
let messages = thread.messages;
if (existingIndex >= 0) {
  if (!existingMessage) return thread;
  const mergedMessage = mergeStreamingMessage(existingMessage, incomingMessage);
  if (mergedMessage !== null) {
    messages = thread.messages.map((message, index) =>
      index === existingIndex ? mergedMessage : message,
    );
  }
} else {
  messages = [...thread.messages, incomingMessage].slice(-MAX_THREAD_MESSAGES);
}
```

This removes one full-array scan per delta and changes nothing observable.

**Verify**: `cd apps/web && bun run test src/store.test.ts` → still all pass.
`cd apps/web && bun run typecheck` → exit 0.

### Step 3: Build the message slice in one pass without a tuple array

The earlier draft called this step "incremental," but it still visited every
message and rebuilt both top-level containers. Keep the honest O(history) shape
and simplify `buildMessageSlice` itself so ids and the id→message record are
produced in one loop:

```ts
function buildMessageSlice(thread: Thread): {
  ids: MessageId[];
  byId: Record<MessageId, ChatMessage>;
} {
  const ids: MessageId[] = [];
  const byId: Record<MessageId, ChatMessage> = {};
  for (const message of thread.messages) {
    ids.push(message.id);
    byId[message.id] = message;
  }
  return { ids, byId };
}
```

Keep the existing `writeThreadState` call to `buildMessageSlice(nextThread)`.
This removes one full traversal and the temporary `[id, message]` tuple array
without pretending to patch only one id. It also assigns the same `message`
objects that the previous `Object.fromEntries` implementation assigned, so
unchanged per-message reference identity remains exactly as before. Do not read
or spread the previous by-id record in this step; that would still be O(history)
and would obscure the actual optimization.

**Verify**: run the focused store test file selected in Step 1 → all pass,
including the reference-stability regression guard (case 5). `cd apps/web && bun
run typecheck` → exit 0.

### Step 4: Confirm no downstream selector regressed

Run the full web test suite to catch any selector that depended on the old
record's identity semantics.

**Verify**: `cd apps/web && bun run test` → all pass.

## Test plan

- `apps/web/src/store.test.ts` (Step 1): append, in-place delta,
  out-of-order/duplicate delta, cap at `MAX_THREAD_MESSAGES`, unchanged-message
  reference stability.
- Structural pattern: whatever existing web test dispatches events into the store
  (reuse its harness); fall back to `session-logic.test.ts` style if none exists.
- Verification: `cd apps/web && bun run test src/store.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] `cd apps/web && bun run typecheck` exits 0.
- [ ] `bun run test` exits 0; new streaming tests exist and pass.
- [ ] `grep -n "thread.messages.find(" apps/web/src/store.ts` no longer shows the redundant `find` inside `applyThreadMessageSentEvent` (only the single `findIndex` remains for message-sent).
- [ ] `buildMessageSlice` produces ids and `byId` in one pass and no longer uses
  `Object.fromEntries(...map(...))`.
- [ ] Observable state (`thread.messages`, `messageByThreadId`, `messageIdsByThreadId`) is equivalent to before for all Step-1 cases.
- [ ] `bun run fmt` and `bun run lint` pass (final validation pass).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 008 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code (drift).
- Any Step-1 characterization test cannot be made to pass against the **unchanged**
  code — it means the current behavior differs from this plan's understanding;
  report before optimizing.
- After Step 3, a downstream test shows any observable state or reference
  identity changed; this step is only a traversal/allocation rewrite.
- You find the reducer path for `thread.message-sent` is not
  `applyThreadMessageSentEvent` (drift) — report.

## Maintenance notes

- The same 2×-scan + `Object.fromEntries` rebuild pattern exists for
  **activities** (`buildActivitySlice`, `store.ts:493`, with a 500-item cap),
  **proposedPlans** (`buildProposedPlanSlice`), and **turnDiffSummaries**
  (`buildTurnDiffSlice`). They are deliberately out of scope here; a follow-up can
  apply the same one-pass construction once this lands and is proven.
- `deriveWorkLogEntries` (`session-logic.ts`) re-runs whenever the activities
  slice reference changes; reducing activity-slice churn later will compound with
  this fix.
- Reviewer should scrutinize that the claimed win stays limited to fewer scans
  and allocations, and that unchanged message objects retain their existing
  identity (case 5).

## Truly-O(1) follow-up (deferred — do not claim O(1) until this lands)

This plan reduces constant factors while preserving existing reference behavior,
but per-delta cost is still O(thread history) because it rebuilds the whole id
array and iterates every message to rebuild `byId`. A genuinely O(1) per-delta
update would require:

- Retaining the previous `messageIdsByThreadId[threadId]` array and, for an
  in-place delta (existing id, unchanged length/order), reusing it verbatim
  (append one id for the new-message case; no rebuild for the update case).
- Patching the previous `byId` record for only the single changed id
  (`{ ...prevById, [changedId]: merged }`) instead of iterating all messages.

That needs the reducer to thread the changed-id (and whether it was an append vs
update vs cap-eviction) down to `writeThreadState`, which is a larger change to the
state-writer contract. Scope it as its own plan. Until then, describe this work as
"fewer per-delta scans and allocations," never "O(1)."
