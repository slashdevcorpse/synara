import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderKind,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const PROVIDER_REQUEST_LIMIT_PER_THREAD = 10;
export const PROVIDER_REQUEST_LEGACY_GENERATION = "legacy";

export const ProviderRequestAdmissionKind = Schema.Literals(["approval", "userInput"]);
export type ProviderRequestAdmissionKind = typeof ProviderRequestAdmissionKind.Type;

export const ProviderRequestAdmissionStatus = Schema.Literals([
  "admitted",
  "open",
  "resolutionPending",
  "resolved",
  "cancelPending",
  "cancelled",
  "overflowPending",
  "overflowSettled",
  "overflowFailed",
]);
export type ProviderRequestAdmissionStatus = typeof ProviderRequestAdmissionStatus.Type;

export const ProviderRequestAdmissionRecord = Schema.Struct({
  threadId: ThreadId,
  providerSessionThreadId: ThreadId,
  interactionKind: ProviderRequestAdmissionKind,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.String,
  provider: ProviderKind,
  requestType: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(TurnId),
  status: ProviderRequestAdmissionStatus,
  openedEventId: EventId,
  settlementEventId: Schema.NullOr(EventId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProviderRequestAdmissionRecord = typeof ProviderRequestAdmissionRecord.Type;

export type ProviderRequestAdmissionIdentity = {
  readonly threadId: ThreadId;
  readonly interactionKind: ProviderRequestAdmissionKind;
  readonly requestId: RuntimeRequestId | ApprovalRequestId;
  readonly lifecycleGeneration?: string;
};

export type AdmitProviderRequestInput = ProviderRequestAdmissionIdentity & {
  readonly providerSessionThreadId: ThreadId;
  readonly provider: ProviderKind;
  readonly requestType?: string;
  readonly turnId?: TurnId;
  readonly eventId: EventId;
  readonly createdAt: string;
};

export type ProviderRequestAdmissionResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "RetryAccepted" }
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "Overflow" }
  | { readonly _tag: "RetryOverflow" };

export type BeginProviderRequestResolutionInput = ProviderRequestAdmissionIdentity & {
  readonly eventId: EventId;
  readonly resolvedAt: string;
};

export type ProviderRequestResolutionResult =
  | { readonly _tag: "Project" }
  | { readonly _tag: "SuppressedOverflow" }
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "StaleGeneration" }
  | { readonly _tag: "Untracked" };

export type BeginProviderRequestTerminalTeardownInput = {
  readonly providerSessionThreadId: ThreadId;
  readonly lifecycleGeneration?: string;
  readonly eventId: EventId;
  readonly occurredAt: string;
};

export interface ProviderRequestAdmissionRepositoryShape {
  readonly admit: (
    input: AdmitProviderRequestInput,
  ) => Effect.Effect<ProviderRequestAdmissionResult, ProjectionRepositoryError>;
  readonly markVisible: (
    input: ProviderRequestAdmissionIdentity & {
      readonly eventId: EventId;
      readonly updatedAt: string;
    },
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markOverflowSettled: (
    input: ProviderRequestAdmissionIdentity & {
      readonly failed: boolean;
      readonly updatedAt: string;
    },
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly beginResolution: (
    input: BeginProviderRequestResolutionInput,
  ) => Effect.Effect<ProviderRequestResolutionResult, ProjectionRepositoryError>;
  readonly markResolutionProjected: (
    input: ProviderRequestAdmissionIdentity & {
      readonly eventId: EventId;
      readonly updatedAt: string;
    },
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly beginTerminalTeardown: (
    input: BeginProviderRequestTerminalTeardownInput,
  ) => Effect.Effect<ReadonlyArray<ProviderRequestAdmissionRecord>, ProjectionRepositoryError>;
  readonly markTerminalProjected: (
    input: ProviderRequestAdmissionIdentity & {
      readonly eventId: EventId;
      readonly updatedAt: string;
    },
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly pruneSettled: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProviderRequestAdmissionRepository extends ServiceMap.Service<
  ProviderRequestAdmissionRepository,
  ProviderRequestAdmissionRepositoryShape
>()("synara/persistence/Services/ProviderRequestAdmissions/ProviderRequestAdmissionRepository") {}
