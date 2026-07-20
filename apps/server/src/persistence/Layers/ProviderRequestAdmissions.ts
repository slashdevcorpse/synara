import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  PROVIDER_REQUEST_LIMIT_PER_THREAD,
  ProviderRequestAdmissionRepository,
  type ProviderRequestAdmissionIdentity,
  type ProviderRequestAdmissionRecord,
  type ProviderRequestAdmissionRepositoryShape,
} from "../Services/ProviderRequestAdmissions.ts";

const generationKey = (generation: string | undefined) => generation ?? "";

const makeProviderRequestAdmissionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectIdentity = (
    input: ProviderRequestAdmissionIdentity,
  ) => sql<ProviderRequestAdmissionRecord>`
    SELECT
      thread_id AS "threadId",
      provider_session_thread_id AS "providerSessionThreadId",
      interaction_kind AS "interactionKind",
      request_id AS "requestId",
      lifecycle_generation AS "lifecycleGeneration",
      provider,
      request_type AS "requestType",
      turn_id AS "turnId",
      status,
      opened_event_id AS "openedEventId",
      settlement_event_id AS "settlementEventId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM provider_request_admissions
    WHERE thread_id = ${input.threadId}
      AND interaction_kind = ${input.interactionKind}
      AND request_id = ${input.requestId}
      AND lifecycle_generation = ${generationKey(input.lifecycleGeneration)}
    LIMIT 1
  `;

  const service: ProviderRequestAdmissionRepositoryShape = {
    admit: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const lifecycleGeneration = generationKey(input.lifecycleGeneration);
            const inserted = yield* sql<ProviderRequestAdmissionRecord>`
          INSERT INTO provider_request_admissions (
            thread_id, provider_session_thread_id, interaction_kind, request_id,
            lifecycle_generation, provider, request_type, turn_id, status,
            opened_event_id, settlement_event_id, created_at, updated_at
          )
          SELECT
            ${input.threadId}, ${input.providerSessionThreadId}, ${input.interactionKind},
            ${input.requestId}, ${lifecycleGeneration}, ${input.provider},
            ${input.requestType ?? null}, ${input.turnId ?? null}, 'admitted',
            ${input.eventId}, NULL, ${input.createdAt}, ${input.createdAt}
          WHERE (
            SELECT COUNT(*)
            FROM provider_request_admissions
            WHERE thread_id = ${input.threadId}
              AND status IN ('admitted', 'open')
          ) < ${PROVIDER_REQUEST_LIMIT_PER_THREAD}
          ON CONFLICT (thread_id, interaction_kind, request_id, lifecycle_generation)
          DO NOTHING
          RETURNING
            thread_id AS "threadId",
            provider_session_thread_id AS "providerSessionThreadId",
            interaction_kind AS "interactionKind",
            request_id AS "requestId",
            lifecycle_generation AS "lifecycleGeneration",
            provider,
            request_type AS "requestType",
            turn_id AS "turnId",
            status,
            opened_event_id AS "openedEventId",
            settlement_event_id AS "settlementEventId",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `;
            if (inserted.length === 1) return { _tag: "Accepted" } as const;

            const existing = (yield* selectIdentity(input))[0];
            if (existing) {
              if (existing.status === "admitted" && existing.openedEventId === input.eventId) {
                return { _tag: "RetryAccepted" } as const;
              }
              if (
                existing.status === "overflowPending" &&
                existing.openedEventId === input.eventId
              ) {
                return { _tag: "RetryOverflow" } as const;
              }
              return { _tag: "Duplicate" } as const;
            }

            yield* sql`
          INSERT INTO provider_request_admissions (
            thread_id, provider_session_thread_id, interaction_kind, request_id,
            lifecycle_generation, provider, request_type, turn_id, status,
            opened_event_id, settlement_event_id, created_at, updated_at
          ) VALUES (
            ${input.threadId}, ${input.providerSessionThreadId}, ${input.interactionKind},
            ${input.requestId}, ${lifecycleGeneration}, ${input.provider},
            ${input.requestType ?? null}, ${input.turnId ?? null}, 'overflowPending',
            ${input.eventId}, NULL, ${input.createdAt}, ${input.createdAt}
          )
          ON CONFLICT (thread_id, interaction_kind, request_id, lifecycle_generation)
          DO NOTHING
        `;
            return { _tag: "Overflow" } as const;
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ProviderRequestAdmissionRepository.admit"))),

    markVisible: (input) =>
      sql`
        UPDATE provider_request_admissions
        SET status = 'open', updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
          AND interaction_kind = ${input.interactionKind}
          AND request_id = ${input.requestId}
          AND lifecycle_generation = ${generationKey(input.lifecycleGeneration)}
          AND status = 'admitted'
          AND opened_event_id = ${input.eventId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ProviderRequestAdmissionRepository.markVisible")),
      ),

    markOverflowSettled: (input) =>
      sql`
        UPDATE provider_request_admissions
        SET
          status = ${input.failed ? "overflowFailed" : "overflowSettled"},
          updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
          AND interaction_kind = ${input.interactionKind}
          AND request_id = ${input.requestId}
          AND lifecycle_generation = ${generationKey(input.lifecycleGeneration)}
          AND status = 'overflowPending'
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("ProviderRequestAdmissionRepository.markOverflowSettled"),
        ),
      ),

    beginResolution: (input) =>
      Effect.gen(function* () {
        const exact = (yield* selectIdentity(input))[0];
        if (!exact) {
          const otherGenerations = yield* sql<{ readonly present: number }>`
            SELECT 1 AS present
            FROM provider_request_admissions
            WHERE thread_id = ${input.threadId}
              AND interaction_kind = ${input.interactionKind}
              AND request_id = ${input.requestId}
            LIMIT 1
          `;
          return otherGenerations.length > 0
            ? ({ _tag: "StaleGeneration" } as const)
            : ({ _tag: "Untracked" } as const);
        }
        if (
          exact.status === "overflowPending" ||
          exact.status === "overflowSettled" ||
          exact.status === "overflowFailed"
        ) {
          return { _tag: "SuppressedOverflow" } as const;
        }
        if (exact.status === "resolutionPending" && exact.settlementEventId === input.eventId) {
          return { _tag: "Project" } as const;
        }
        if (exact.status !== "admitted" && exact.status !== "open") {
          return { _tag: "Duplicate" } as const;
        }
        yield* sql`
          UPDATE provider_request_admissions
          SET
            status = 'resolutionPending',
            settlement_event_id = ${input.eventId},
            updated_at = ${input.resolvedAt}
          WHERE thread_id = ${input.threadId}
            AND interaction_kind = ${input.interactionKind}
            AND request_id = ${input.requestId}
            AND lifecycle_generation = ${generationKey(input.lifecycleGeneration)}
            AND status IN ('admitted', 'open')
        `;
        return { _tag: "Project" } as const;
      }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProviderRequestAdmissionRepository.beginResolution"),
        ),
      ),

    markResolutionProjected: (input) =>
      sql`
        UPDATE provider_request_admissions
        SET status = 'resolved', updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
          AND interaction_kind = ${input.interactionKind}
          AND request_id = ${input.requestId}
          AND lifecycle_generation = ${generationKey(input.lifecycleGeneration)}
          AND status = 'resolutionPending'
          AND settlement_event_id = ${input.eventId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("ProviderRequestAdmissionRepository.markResolutionProjected"),
        ),
      ),

    beginTerminalTeardown: (input) =>
      Effect.gen(function* () {
        const lifecycleGeneration = generationKey(input.lifecycleGeneration);
        yield* sql`
          UPDATE provider_request_admissions
          SET
            status = 'cancelPending',
            settlement_event_id = ${input.eventId},
            updated_at = ${input.occurredAt}
          WHERE provider_session_thread_id = ${input.providerSessionThreadId}
            AND lifecycle_generation = ${lifecycleGeneration}
            AND status IN ('admitted', 'open')
        `;
        return yield* sql<ProviderRequestAdmissionRecord>`
          SELECT
            thread_id AS "threadId",
            provider_session_thread_id AS "providerSessionThreadId",
            interaction_kind AS "interactionKind",
            request_id AS "requestId",
            lifecycle_generation AS "lifecycleGeneration",
            provider,
            request_type AS "requestType",
            turn_id AS "turnId",
            status,
            opened_event_id AS "openedEventId",
            settlement_event_id AS "settlementEventId",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM provider_request_admissions
          WHERE provider_session_thread_id = ${input.providerSessionThreadId}
            AND lifecycle_generation = ${lifecycleGeneration}
            AND status = 'cancelPending'
            AND settlement_event_id = ${input.eventId}
          ORDER BY thread_id ASC, interaction_kind ASC, request_id ASC
        `;
      }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProviderRequestAdmissionRepository.beginTerminalTeardown"),
        ),
      ),

    markTerminalProjected: (input) =>
      sql`
        UPDATE provider_request_admissions
        SET status = 'cancelled', updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
          AND interaction_kind = ${input.interactionKind}
          AND request_id = ${input.requestId}
          AND lifecycle_generation = ${generationKey(input.lifecycleGeneration)}
          AND status = 'cancelPending'
          AND settlement_event_id = ${input.eventId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("ProviderRequestAdmissionRepository.markTerminalProjected"),
        ),
      ),

    deleteByThreadId: (threadId) =>
      sql`DELETE FROM provider_request_admissions WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("ProviderRequestAdmissionRepository.deleteByThreadId"),
        ),
      ),

    pruneSettled: (threadId) =>
      sql`
        DELETE FROM provider_request_admissions
        WHERE rowid IN (
          SELECT rowid
          FROM provider_request_admissions
          WHERE thread_id = ${threadId}
            AND status IN ('resolved', 'cancelled', 'overflowSettled', 'overflowFailed')
          ORDER BY updated_at DESC, rowid DESC
          LIMIT -1 OFFSET 256
        )
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ProviderRequestAdmissionRepository.pruneSettled")),
      ),
  };

  return service;
});

export const ProviderRequestAdmissionRepositoryLive = Layer.effect(
  ProviderRequestAdmissionRepository,
  makeProviderRequestAdmissionRepository,
);
