import { ApprovalRequestId, EventId, ThreadId } from "@synara/contracts";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderRequestAdmissionRepositoryLive } from "./ProviderRequestAdmissions.ts";
import { ProviderRequestAdmissionRepository } from "../Services/ProviderRequestAdmissions.ts";

const layer = it.layer(
  ProviderRequestAdmissionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const threadId = ThreadId.makeUnsafe("thread-admission-test");
const generation = "generation-admission-test";

const admissionInput = (index: number, targetThreadId = threadId) => ({
  threadId: targetThreadId,
  providerSessionThreadId: targetThreadId,
  interactionKind: "approval" as const,
  requestId: ApprovalRequestId.makeUnsafe(`request-admission-${index}`),
  lifecycleGeneration: generation,
  provider: "codex" as const,
  requestType: "command_execution_approval",
  eventId: EventId.makeUnsafe(`event-admission-${index}`),
  createdAt: `2026-07-20T12:00:${String(index).padStart(2, "0")}.000Z`,
});

layer("ProviderRequestAdmissionRepository", (it) => {
  it.effect("atomically admits exactly ten concurrent unresolved requests", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRequestAdmissionRepository;
      const results = yield* Effect.all(
        Array.from({ length: 24 }, (_, index) => repository.admit(admissionInput(index))),
        { concurrency: "unbounded" },
      );

      const accepted = results.filter((result) => result._tag === "Accepted");
      const overflowed = results.filter((result) => result._tag === "Overflow");
      if (accepted.length !== 10 || overflowed.length !== 14) {
        return yield* Effect.die(
          new Error(
            `Expected 10 accepted and 14 overflowed, got ${accepted.length} and ${overflowed.length}`,
          ),
        );
      }
    }),
  );

  it.effect("preserves crash retry states and suppresses settled duplicates", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderRequestAdmissionRepository;
      const crashThreadId = ThreadId.makeUnsafe("thread-admission-crash-test");
      const opened = admissionInput(100, crashThreadId);
      const identity = {
        threadId: opened.threadId,
        interactionKind: opened.interactionKind,
        requestId: opened.requestId,
        lifecycleGeneration: opened.lifecycleGeneration,
      };

      const accepted = yield* repository.admit(opened);
      if (accepted._tag !== "Accepted") {
        return yield* Effect.die(new Error(`Expected Accepted, got ${accepted._tag}`));
      }
      const retriedAccepted = yield* repository.admit(opened);
      if (retriedAccepted._tag !== "RetryAccepted") {
        return yield* Effect.die(new Error(`Expected RetryAccepted, got ${retriedAccepted._tag}`));
      }
      const duplicateOpen = yield* repository.admit({
        ...opened,
        eventId: EventId.makeUnsafe("event-admission-duplicate"),
      });
      if (duplicateOpen._tag !== "Duplicate") {
        return yield* Effect.die(new Error(`Expected Duplicate, got ${duplicateOpen._tag}`));
      }

      yield* repository.markVisible({
        ...identity,
        eventId: opened.eventId,
        updatedAt: opened.createdAt,
      });
      const resolutionEventId = EventId.makeUnsafe("event-admission-resolution");
      const resolution = yield* repository.beginResolution({
        ...identity,
        eventId: resolutionEventId,
        resolvedAt: "2026-07-20T12:02:00.000Z",
      });
      if (resolution._tag !== "Project") {
        return yield* Effect.die(new Error(`Expected Project, got ${resolution._tag}`));
      }
      const retriedResolution = yield* repository.beginResolution({
        ...identity,
        eventId: resolutionEventId,
        resolvedAt: "2026-07-20T12:02:01.000Z",
      });
      if (retriedResolution._tag !== "Project") {
        return yield* Effect.die(
          new Error(`Expected retried Project, got ${retriedResolution._tag}`),
        );
      }
      yield* repository.markResolutionProjected({
        ...identity,
        eventId: resolutionEventId,
        updatedAt: "2026-07-20T12:02:02.000Z",
      });
      const settledResolution = yield* repository.beginResolution({
        ...identity,
        eventId: resolutionEventId,
        resolvedAt: "2026-07-20T12:02:03.000Z",
      });
      if (settledResolution._tag !== "Duplicate") {
        return yield* Effect.die(
          new Error(`Expected settled Duplicate, got ${settledResolution._tag}`),
        );
      }

      for (let index = 101; index < 111; index++) {
        const result = yield* repository.admit(admissionInput(index, crashThreadId));
        if (result._tag !== "Accepted") {
          return yield* Effect.die(
            new Error(`Expected capacity fill Accepted, got ${result._tag}`),
          );
        }
      }
      const overflow = admissionInput(111, crashThreadId);
      const overflowed = yield* repository.admit(overflow);
      if (overflowed._tag !== "Overflow") {
        return yield* Effect.die(new Error(`Expected Overflow, got ${overflowed._tag}`));
      }
      const retriedOverflow = yield* repository.admit(overflow);
      if (retriedOverflow._tag !== "RetryOverflow") {
        return yield* Effect.die(new Error(`Expected RetryOverflow, got ${retriedOverflow._tag}`));
      }
      yield* repository.markOverflowSettled({
        threadId: overflow.threadId,
        interactionKind: overflow.interactionKind,
        requestId: overflow.requestId,
        lifecycleGeneration: overflow.lifecycleGeneration,
        failed: false,
        updatedAt: "2026-07-20T12:03:00.000Z",
      });
      const settledOverflow = yield* repository.admit(overflow);
      if (settledOverflow._tag !== "Duplicate") {
        return yield* Effect.die(
          new Error(`Expected settled overflow Duplicate, got ${settledOverflow._tag}`),
        );
      }
    }),
  );
});
