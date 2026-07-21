// FILE: DroidSessionTeardownGate.ts
// Purpose: Prevents a replacement Droid ACP runtime from starting before its predecessor exits.
// Layer: Provider ACP lifecycle coordination

import type { ThreadId } from "@synara/contracts";
import { Effect } from "effect";

import { type AcpSessionTeardownState, awaitAcpSessionTeardown } from "./AcpSessionTeardown.ts";

export interface DroidSessionTeardownGate {
  readonly track: (threadId: ThreadId, teardown: AcpSessionTeardownState) => void;
  readonly isPending: (threadId: ThreadId) => boolean;
  readonly awaitPending: (threadId: ThreadId) => Effect.Effect<void>;
  readonly release: (threadId: ThreadId, teardown: AcpSessionTeardownState) => Effect.Effect<void>;
}

export function makeDroidSessionTeardownGate(): DroidSessionTeardownGate {
  const pendingByThreadId = new Map<ThreadId, AcpSessionTeardownState>();

  return {
    track: (threadId, teardown) => {
      pendingByThreadId.set(threadId, teardown);
    },
    isPending: (threadId) => pendingByThreadId.has(threadId),
    awaitPending: (threadId) =>
      Effect.suspend(() => {
        const pending = pendingByThreadId.get(threadId);
        return pending === undefined ? Effect.void : awaitAcpSessionTeardown(pending);
      }),
    release: (threadId, teardown) =>
      Effect.sync(() => {
        if (pendingByThreadId.get(threadId) === teardown) {
          pendingByThreadId.delete(threadId);
        }
      }),
  };
}
