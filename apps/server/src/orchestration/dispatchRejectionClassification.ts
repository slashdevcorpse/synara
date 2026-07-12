import { Schema } from "effect";

import { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import {
  OrchestrationCommandDecodeError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "./Errors.ts";

export function isDefinitiveDispatchRejection(cause: unknown): boolean {
  return (
    Schema.is(OrchestrationCommandInvariantError)(cause) ||
    Schema.is(OrchestrationCommandDecodeError)(cause) ||
    Schema.is(OrchestrationCommandPreviouslyRejectedError)(cause) ||
    cause instanceof ServerRuntimeStartupError
  );
}
