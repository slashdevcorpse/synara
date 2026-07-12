import { CommandId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import {
  OrchestrationCommandDecodeError,
  OrchestrationCommandInternalError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandTimeoutError,
} from "./Errors.ts";
import { isDefinitiveDispatchRejection } from "./dispatchRejectionClassification.ts";

describe("dispatch rejection classification", () => {
  it("tags only structured failures that prove dispatch was not accepted", () => {
    expect(
      isDefinitiveDispatchRejection(
        new OrchestrationCommandInvariantError({
          commandType: "thread.turn.start",
          detail: "Thread was not found.",
        }),
      ),
    ).toBe(true);
    expect(
      isDefinitiveDispatchRejection(
        new OrchestrationCommandPreviouslyRejectedError({
          commandId: CommandId.makeUnsafe("cmd-previously-rejected"),
          detail: "Previously rejected.",
        }),
      ),
    ).toBe(true);
    expect(
      isDefinitiveDispatchRejection(
        new OrchestrationCommandDecodeError({
          issue: "Invalid payload.",
        }),
      ),
    ).toBe(true);
    expect(
      isDefinitiveDispatchRejection(new ServerRuntimeStartupError({ message: "startup failed" })),
    ).toBe(true);

    expect(
      isDefinitiveDispatchRejection(
        new OrchestrationCommandTimeoutError({
          commandId: CommandId.makeUnsafe("cmd-timeout"),
          commandType: "thread.checkpoint.files.restore",
          timeoutMs: 45_000,
        }),
      ),
    ).toBe(false);
    expect(
      isDefinitiveDispatchRejection(
        new OrchestrationCommandInternalError({
          commandId: CommandId.makeUnsafe("cmd-internal"),
          commandType: "thread.checkpoint.files.restore",
          detail: "Outcome is ambiguous.",
        }),
      ),
    ).toBe(false);
    expect(isDefinitiveDispatchRejection(new Error("post-accept workspace prep failed"))).toBe(
      false,
    );
  });
});
