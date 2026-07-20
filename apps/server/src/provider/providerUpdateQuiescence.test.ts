import type { ProviderSession, ThreadId } from "@synara/contracts";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderServiceShape } from "./Services/ProviderService.ts";
import { ProviderValidationError } from "./Errors.ts";
import {
  ProviderUpdateBlockedError,
  quiesceProviderRuntimesForUpdate,
} from "./providerUpdateQuiescence.ts";

const THREAD_ID = "00000000-0000-4000-8000-000000000001" as ThreadId;

function session(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    provider: "codex",
    status: "ready",
    runtimeMode: "full-access",
    threadId: THREAD_ID,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

function providerService(input: {
  readonly sessions: Array<ProviderSession>;
  readonly hasLiveTasks?: boolean;
  readonly onStop?: (threadId: ThreadId) => void;
}): ProviderServiceShape {
  return {
    listSessions: () => Effect.succeed(input.sessions),
    hasLiveRuntimeTasks: () => Effect.succeed(input.hasLiveTasks ?? false),
    stopRuntimeSession: ({ threadId }) =>
      Effect.sync(() => {
        input.onStop?.(threadId);
        const index = input.sessions.findIndex((candidate) => candidate.threadId === threadId);
        if (index >= 0) input.sessions.splice(index, 1);
      }),
  } as unknown as ProviderServiceShape;
}

describe("providerUpdateQuiescence", () => {
  it("stops idle matching runtimes and leaves other providers alone", async () => {
    const sessions = [session(), session({ provider: "claudeAgent" })];
    const stopped: Array<ThreadId> = [];
    const stoppedThreadIds = await Effect.runPromise(
      quiesceProviderRuntimesForUpdate({
        provider: "codex",
        providerService: providerService({
          sessions,
          onStop: (threadId) => stopped.push(threadId),
        }),
      }),
    );

    expect(stoppedThreadIds).toEqual([THREAD_ID]);
    expect(stopped).toEqual([THREAD_ID]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.provider).toBe("claudeAgent");
  });

  it("rejects active work before stopping any runtime", async () => {
    const sessions = [session(), session({ status: "running", activeTurnId: "turn-1" as never })];
    let stopCount = 0;
    const result = await Effect.runPromise(
      quiesceProviderRuntimesForUpdate({
        provider: "codex",
        providerService: providerService({
          sessions,
          onStop: () => (stopCount += 1),
        }),
      }).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ProviderUpdateBlockedError);
      expect(result.failure.message).toContain("active work");
    }
    expect(stopCount).toBe(0);
  });

  it("treats provider-native background tasks as active work", async () => {
    const sessions = [session()];
    const result = await Effect.runPromise(
      quiesceProviderRuntimesForUpdate({
        provider: "codex",
        providerService: providerService({ sessions, hasLiveTasks: true }),
      }).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(sessions).toHaveLength(1);
  });

  it("uses the atomic maintenance API and preserves conservative session ownership", async () => {
    const prepareCalls: Array<{ provider: string; stopIdleSessions: boolean }> = [];
    let legacyStopCount = 0;
    const service = {
      prepareForMaintenance: (input: {
        readonly provider: "opencode";
        readonly stopIdleSessions: boolean;
      }) => {
        prepareCalls.push(input);
        return Effect.fail(
          new ProviderValidationError({
            operation: "ProviderService.prepareForMaintenance",
            issue: "Close the affected sessions and retry.",
          }),
        );
      },
      listSessions: () => Effect.succeed([session({ provider: "opencode" })]),
      stopRuntimeSession: () =>
        Effect.sync(() => {
          legacyStopCount += 1;
        }),
    } as unknown as ProviderServiceShape;

    const result = await Effect.runPromise(
      quiesceProviderRuntimesForUpdate({
        provider: "opencode",
        providerService: service,
        stopIdleSessions: false,
      }).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ProviderUpdateBlockedError);
      expect(result.failure.message).toContain("Close the affected sessions");
    }
    expect(prepareCalls).toEqual([{ provider: "opencode", stopIdleSessions: false }]);
    expect(legacyStopCount).toBe(0);
  });

  it("refuses conservative legacy quiescence before stopping any matching runtime", async () => {
    const sessions = [session({ provider: "opencode" })];
    let stopCount = 0;

    const result = await Effect.runPromise(
      quiesceProviderRuntimesForUpdate({
        provider: "opencode",
        providerService: providerService({
          sessions,
          onStop: () => (stopCount += 1),
        }),
        stopIdleSessions: false,
      }).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ProviderUpdateBlockedError);
      expect(result.failure.message).toContain("process ownership cannot be proven safely");
      expect(result.failure.message).toContain("Close the affected sessions and retry");
    }
    expect(stopCount).toBe(0);
    expect(sessions).toHaveLength(1);
  });
});
