import {
  OPENCODE_STORAGE_SCHEMA_INCOMPATIBLE_REASON,
  type ProviderAdapterCompatibilityReason,
} from "./Errors.ts";

const OPENCODE_SCHEMA_CONSTRAINT_MESSAGE =
  "SQLiteError: NOT NULL constraint failed: session_message.seq";
const MAX_ERROR_ENVELOPE_DEPTH = 5;

export const OPENCODE_STORAGE_SCHEMA_INCOMPATIBLE_MESSAGE =
  "OpenCode could not use its current data format. Update OpenCode, refresh provider status, then start a new attempt. Super Synara did not modify OpenCode data.";

export interface OpenCodeCompatibilityFailure {
  readonly reason: ProviderAdapterCompatibilityReason;
  readonly provider: "opencode";
  readonly lifecycleStage: "first_prompt";
  readonly retryable: false;
  readonly diagnosticSummary: string;
}

export interface OpenCodeCompatibilityClassifierInput {
  readonly provider: string;
  readonly source: "provider_event" | "sdk_response";
  readonly operation: string;
  readonly lifecycleStage: string;
  readonly error: unknown;
}

function hasExactConstraintLine(message: string): boolean {
  return message.split(/\r?\n/u).some((line) => line.trim() === OPENCODE_SCHEMA_CONSTRAINT_MESSAGE);
}

function errorEnvelopeContainsExactConstraint(
  value: unknown,
  depth: number,
  seen: Set<object>,
): boolean {
  if (depth > MAX_ERROR_ENVELOPE_DEPTH) {
    return false;
  }
  if (value instanceof Error) {
    if (hasExactConstraintLine(value.message)) {
      return true;
    }
    if (value.cause !== undefined) {
      return errorEnvelopeContainsExactConstraint(value.cause, depth + 1, seen);
    }
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && hasExactConstraintLine(record.message)) {
    return true;
  }

  // Only traverse fields that are part of observed provider/SDK error envelopes.
  // Prompt bodies, assistant messages, and arbitrary response payload fields are
  // deliberately excluded so content cannot trigger compatibility handling.
  for (const key of ["cause", "error", "data"] as const) {
    if (errorEnvelopeContainsExactConstraint(record[key], depth + 1, seen)) {
      return true;
    }
  }
  return false;
}

export function classifyOpenCodeCompatibilityFailure(
  input: OpenCodeCompatibilityClassifierInput,
): OpenCodeCompatibilityFailure | null {
  if (
    input.provider !== "opencode" ||
    input.lifecycleStage !== "first_prompt" ||
    (input.source === "provider_event"
      ? input.operation !== "session.error"
      : input.operation !== "session.promptAsync")
  ) {
    return null;
  }
  if (!errorEnvelopeContainsExactConstraint(input.error, 0, new Set())) {
    return null;
  }
  return {
    reason: OPENCODE_STORAGE_SCHEMA_INCOMPATIBLE_REASON,
    provider: "opencode",
    lifecycleStage: "first_prompt",
    retryable: false,
    diagnosticSummary: OPENCODE_STORAGE_SCHEMA_INCOMPATIBLE_MESSAGE,
  };
}

export function isStructuredOpenCodeSessionNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const runtimeError = error as Record<string, unknown>;
  if (runtimeError.operation !== "session.get") {
    return false;
  }
  const cause = runtimeError.cause;
  if (!cause || typeof cause !== "object" || Array.isArray(cause)) {
    return false;
  }
  const result = cause as Record<string, unknown>;
  const response = result.response;
  const responseStatus =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>).status
      : undefined;
  const responseError = result.error;
  if (!responseError || typeof responseError !== "object" || Array.isArray(responseError)) {
    return false;
  }
  const errorRecord = responseError as Record<string, unknown>;
  const data = errorRecord.data;
  return (
    responseStatus === 404 &&
    errorRecord.name === "NotFoundError" &&
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof (data as Record<string, unknown>).message === "string"
  );
}
