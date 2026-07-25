import { describe, expect, it } from "vitest";

import { OpenCodeRuntimeError } from "./opencodeRuntime.ts";
import {
  classifyOpenCodeCompatibilityFailure,
  isStructuredOpenCodeSessionNotFound,
} from "./opencodeCompatibility.ts";

const OBSERVED_ERROR = "SQLiteError: NOT NULL constraint failed: session_message.seq";

const classify = (error: unknown) =>
  classifyOpenCodeCompatibilityFailure({
    provider: "opencode",
    source: "provider_event",
    operation: "session.error",
    lifecycleStage: "first_prompt",
    error,
  });

describe("classifyOpenCodeCompatibilityFailure", () => {
  it("classifies the observed OpenCode session.error envelope", () => {
    expect(
      classify({
        name: "UnknownError",
        data: {
          message: `${OBSERVED_ERROR}\n    at appendMessage (provider-runtime.js:1:1)`,
        },
      }),
    ).toEqual({
      reason: "opencode_storage_schema_incompatible",
      provider: "opencode",
      lifecycleStage: "first_prompt",
      retryable: false,
      diagnosticSummary:
        "OpenCode could not use its current data format. Update OpenCode, refresh provider status, then start a new attempt. Super Synara did not modify OpenCode data.",
    });
  });

  it("classifies the SDK tuple error through the retained cause chain", () => {
    const runtimeError = new OpenCodeRuntimeError({
      operation: "session.promptAsync",
      detail: "sanitized by the adapter",
      cause: {
        response: { status: 500 },
        error: {
          name: "UnknownError",
          data: { message: OBSERVED_ERROR },
        },
      },
    });

    expect(
      classifyOpenCodeCompatibilityFailure({
        provider: "opencode",
        source: "sdk_response",
        operation: "session.promptAsync",
        lifecycleStage: "first_prompt",
        error: runtimeError,
      })?.reason,
    ).toBe("opencode_storage_schema_incompatible");
  });

  it.each([
    ["same text in a prompt", { prompt: OBSERVED_ERROR }],
    ["same text in assistant output", { assistant: { text: OBSERVED_ERROR } }],
    [
      "another provider",
      {
        provider: "codex",
        error: { name: "UnknownError", data: { message: OBSERVED_ERROR } },
      },
    ],
    ["another column", { message: "SQLiteError: NOT NULL constraint failed: session_message.id" }],
    ["another table", { message: "SQLiteError: NOT NULL constraint failed: message.seq" }],
    ["generic constraint", { message: "SQLITE_CONSTRAINT" }],
    ["authentication", { name: "ProviderAuthError", data: { message: "Not authenticated" } }],
    ["executable missing", new Error("ENOENT: opencode")],
    ["port conflict", new Error("EADDRINUSE")],
    ["timeout", new Error("Request timed out")],
    ["cancellation", new Error("AbortError")],
    ["malformed response", { body: OBSERVED_ERROR }],
    ["ordinary process exit", new Error("OpenCode exited with code 1")],
    ["network disconnect", new Error("ECONNRESET")],
    ["update advisory", { latestVersion: "1.18.5", message: "Update available" }],
  ])("does not classify %s", (_name, candidate) => {
    const provider =
      candidate &&
      typeof candidate === "object" &&
      "provider" in candidate &&
      typeof candidate.provider === "string"
        ? candidate.provider
        : "opencode";
    const error =
      candidate && typeof candidate === "object" && "error" in candidate
        ? candidate.error
        : candidate;
    expect(
      classifyOpenCodeCompatibilityFailure({
        provider,
        source: "provider_event",
        operation: "session.error",
        lifecycleStage: "first_prompt",
        error,
      }),
    ).toBeNull();
  });

  it("does not classify later prompts or session creation", () => {
    const error = { name: "UnknownError", data: { message: OBSERVED_ERROR } };
    expect(
      classifyOpenCodeCompatibilityFailure({
        provider: "opencode",
        source: "provider_event",
        operation: "session.error",
        lifecycleStage: "later_prompt",
        error,
      }),
    ).toBeNull();
    expect(
      classifyOpenCodeCompatibilityFailure({
        provider: "opencode",
        source: "sdk_response",
        operation: "session.create",
        lifecycleStage: "first_prompt",
        error,
      }),
    ).toBeNull();
  });
});

describe("isStructuredOpenCodeSessionNotFound", () => {
  it("accepts the typed SDK 404 response tuple", () => {
    expect(
      isStructuredOpenCodeSessionNotFound(
        new OpenCodeRuntimeError({
          operation: "session.get",
          detail: "status=404",
          cause: {
            response: { status: 404 },
            error: {
              name: "NotFoundError",
              data: { message: "Session not found" },
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("accepts the SDK's thrown 404 envelope through retained runtime causes", () => {
    const sdkError = new Error("Session not found", {
      cause: {
        body: {
          name: "NotFoundError",
          data: { message: "Session not found" },
        },
        status: 404,
      },
    });
    const nestedRuntimeError = new OpenCodeRuntimeError({
      operation: "session.get",
      detail: "Session not found",
      cause: sdkError,
    });

    expect(
      isStructuredOpenCodeSessionNotFound(
        new OpenCodeRuntimeError({
          operation: "session.get",
          detail: "resume failed",
          cause: nestedRuntimeError,
        }),
      ),
    ).toBe(true);
  });

  it("rejects the SDK's thrown 404 envelope for another operation", () => {
    expect(
      isStructuredOpenCodeSessionNotFound(
        new OpenCodeRuntimeError({
          operation: "session.create",
          detail: "Session not found",
          cause: new Error("Session not found", {
            cause: {
              body: {
                name: "NotFoundError",
                data: { message: "Session not found" },
              },
              status: 404,
            },
          }),
        }),
      ),
    ).toBe(false);
  });

  it.each([
    [
      "wrong status",
      { response: { status: 500 }, error: { name: "NotFoundError", data: { message: "missing" } } },
    ],
    [
      "wrong type",
      { response: { status: 404 }, error: { name: "UnknownError", data: { message: "missing" } } },
    ],
    ["missing response", { error: { name: "NotFoundError", data: { message: "missing" } } }],
    ["malformed data", { response: { status: 404 }, error: { name: "NotFoundError", data: {} } }],
    [
      "thrown wrong status",
      new Error("Session not found", {
        cause: {
          body: { name: "NotFoundError", data: { message: "missing" } },
          status: 500,
        },
      }),
    ],
    [
      "thrown wrong type",
      new Error("Session not found", {
        cause: {
          body: { name: "UnknownError", data: { message: "missing" } },
          status: 404,
        },
      }),
    ],
    [
      "thrown malformed data",
      new Error("Session not found", {
        cause: {
          body: { name: "NotFoundError", data: {} },
          status: 404,
        },
      }),
    ],
    ["unstructured thrown 404 text", new Error("404 Session not found")],
  ])("rejects a %s resume failure", (_name, cause) => {
    expect(
      isStructuredOpenCodeSessionNotFound(
        new OpenCodeRuntimeError({
          operation: "session.get",
          detail: "resume failed",
          cause,
        }),
      ),
    ).toBe(false);
  });
});
