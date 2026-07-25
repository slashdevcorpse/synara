import { describe, expect, it } from "vitest";

import {
  CommandCodeHeadlessProtocolError,
  CommandCodeHeadlessProtocolParser,
  parseCommandCodePrintSessionId,
  projectCommandCodeRunStartEvent,
  projectCommandCodeTextDeltaEvent,
  projectCommandCodeThinkingDeltaEvent,
  projectCommandCodeToolCompletedEvent,
  projectCommandCodeToolDeniedEvent,
  projectCommandCodeToolErroredEvent,
  projectCommandCodeToolEvent,
  projectCommandCodeToolHookBlockedEvent,
  projectCommandCodeToolQueuedEvent,
  projectCommandCodeToolRunningEvent,
  projectCommandCodeToolUpdateEvent,
  type CommandCodeHeadlessResultRecord,
} from "./commandCodeHeadlessProtocol.ts";

const SESSION_ID = "908dc397-d18a-4d0e-a6ce-814c340e334b";

function resultRecord(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    type: "result",
    subtype: "success",
    sessionId: SESSION_ID,
    stopReason: "end_turn",
    usage: {
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    },
    durationMs: 8421,
    finalText: "done",
    ...overrides,
  };
}

function jsonLine(value: unknown, ending = "\n"): string {
  return `${JSON.stringify(value)}${ending}`;
}

function expectProtocolError(
  run: () => unknown,
  code: CommandCodeHeadlessProtocolError["code"],
  message: RegExp,
): void {
  try {
    run();
    expect.fail("Expected CommandCodeHeadlessProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(CommandCodeHeadlessProtocolError);
    expect((error as CommandCodeHeadlessProtocolError).code).toBe(code);
    expect((error as Error).message).toMatch(message);
  }
}

describe("CommandCodeHeadlessProtocolParser", () => {
  it("frames fragmented UTF-8, CRLF, blank lines, and a final unterminated result", () => {
    const parser = new CommandCodeHeadlessProtocolParser();
    const source = [
      "\r\n",
      jsonLine(
        {
          type: "event",
          event: { type: "run_start", sessionId: SESSION_ID },
        },
        "\r\n",
      ),
      "   \n",
      jsonLine({
        type: "event",
        event: { type: "text_delta", delta: "hé🙂" },
      }),
      jsonLine({
        type: "event",
        event: { type: "thinking_delta", delta: "checking" },
      }),
      JSON.stringify(resultRecord({ finalText: "hé🙂" })),
    ].join("");
    const bytes = new TextEncoder().encode(source);
    const records = [];

    for (const byte of bytes) {
      records.push(...parser.push(Uint8Array.of(byte)));
    }
    records.push(...parser.finish());

    expect(records).toHaveLength(4);
    expect(records.map((record) => record.type)).toEqual(["event", "event", "event", "result"]);

    const runStart = records[0];
    const textDelta = records[1];
    const thinkingDelta = records[2];
    const result = records[3] as CommandCodeHeadlessResultRecord;
    expect(runStart?.type).toBe("event");
    expect(textDelta?.type).toBe("event");
    expect(thinkingDelta?.type).toBe("event");
    if (
      runStart?.type !== "event" ||
      textDelta?.type !== "event" ||
      thinkingDelta?.type !== "event"
    ) {
      expect.fail("Expected event records");
    }

    expect(projectCommandCodeRunStartEvent(runStart)).toEqual({
      type: "run_start",
      sessionId: SESSION_ID,
      raw: { type: "run_start", sessionId: SESSION_ID },
    });
    expect(projectCommandCodeTextDeltaEvent(textDelta)).toEqual({
      type: "text_delta",
      delta: "hé🙂",
      raw: { type: "text_delta", delta: "hé🙂" },
    });
    expect(projectCommandCodeThinkingDeltaEvent(thinkingDelta)).toEqual({
      type: "thinking_delta",
      delta: "checking",
      raw: { type: "thinking_delta", delta: "checking" },
    });
    expect(result).toMatchObject({
      type: "result",
      subtype: "success",
      sessionId: SESSION_ID,
      stopReason: "end_turn",
      durationMs: 8421,
      finalText: "hé🙂",
    });
    expect(result.raw).toEqual(resultRecord({ finalText: "hé🙂" }));
    expect(parser.result).toBe(result);
    expect(parser.totalBytes).toBe(bytes.byteLength);
  });

  it("projects stable tool lifecycle events and tolerates unknown event types", () => {
    const parser = new CommandCodeHeadlessProtocolParser();
    const envelopes = [
      {
        type: "event",
        event: {
          type: "tool_queued",
          toolCallId: "call_01",
          toolName: "read_file",
          input: { file_path: "package.json" },
        },
      },
      {
        type: "event",
        event: {
          type: "tool_running",
          toolCallId: "call_01",
          toolName: "read_file",
          description: null,
        },
      },
      {
        type: "event",
        event: {
          type: "tool_update",
          toolCallId: "call_01",
          toolName: "read_file",
          partial: { bytesRead: 128 },
        },
      },
      {
        type: "event",
        event: {
          type: "tool_completed",
          toolCallId: "call_01",
          toolName: "read_file",
          result: [{ type: "text", text: "{}" }],
        },
      },
      {
        type: "event",
        event: {
          type: "tool_errored",
          toolCallId: "call_02",
          toolName: "shell",
          error: "permission denied",
        },
      },
      {
        type: "event",
        event: {
          type: "tool_denied",
          toolCallId: "call_03",
          toolName: "shell",
        },
      },
      {
        type: "event",
        event: {
          type: "tool_hook_blocked",
          toolCallId: "call_04",
          toolName: "write_file",
          hookOutput: "Writes are disabled by policy.",
        },
      },
      {
        type: "event",
        event: { type: "future_event", payload: 42 },
      },
    ];
    const records = parser.push(
      `${envelopes.map((envelope) => jsonLine(envelope)).join("")}${jsonLine(resultRecord())}`,
    );
    expect(parser.finish()).toEqual([]);

    const events = records.filter((record) => record.type === "event");
    expect(events).toHaveLength(8);
    expect(events.map((event) => event.eventType)).toEqual([
      "tool_queued",
      "tool_running",
      "tool_update",
      "tool_completed",
      "tool_errored",
      "tool_denied",
      "tool_hook_blocked",
      "future_event",
    ]);

    expect(projectCommandCodeToolQueuedEvent(events[0]!)).toMatchObject({
      type: "tool_queued",
      toolCallId: "call_01",
      toolName: "read_file",
      input: { file_path: "package.json" },
    });
    expect(projectCommandCodeToolRunningEvent(events[1]!)).toMatchObject({
      type: "tool_running",
      toolCallId: "call_01",
      toolName: "read_file",
      description: null,
    });
    expect(projectCommandCodeToolUpdateEvent(events[2]!)).toMatchObject({
      type: "tool_update",
      toolCallId: "call_01",
      toolName: "read_file",
      partial: { bytesRead: 128 },
    });
    expect(projectCommandCodeToolCompletedEvent(events[3]!)).toMatchObject({
      type: "tool_completed",
      toolCallId: "call_01",
      toolName: "read_file",
      result: [{ type: "text", text: "{}" }],
    });
    expect(projectCommandCodeToolErroredEvent(events[4]!)).toMatchObject({
      type: "tool_errored",
      toolCallId: "call_02",
      toolName: "shell",
      error: "permission denied",
    });
    expect(projectCommandCodeToolDeniedEvent(events[5]!)).toMatchObject({
      type: "tool_denied",
      toolCallId: "call_03",
      toolName: "shell",
    });
    expect(projectCommandCodeToolHookBlockedEvent(events[6]!)).toMatchObject({
      type: "tool_hook_blocked",
      toolCallId: "call_04",
      toolName: "write_file",
      hookOutput: "Writes are disabled by policy.",
    });
    expect(events.slice(0, 7).map(projectCommandCodeToolEvent)).toEqual([
      projectCommandCodeToolQueuedEvent(events[0]!),
      projectCommandCodeToolRunningEvent(events[1]!),
      projectCommandCodeToolUpdateEvent(events[2]!),
      projectCommandCodeToolCompletedEvent(events[3]!),
      projectCommandCodeToolErroredEvent(events[4]!),
      projectCommandCodeToolDeniedEvent(events[5]!),
      projectCommandCodeToolHookBlockedEvent(events[6]!),
    ]);
    expect(projectCommandCodeToolEvent(events[7]!)).toBeUndefined();
    expect(events[7]!.raw).toEqual(envelopes[7]);
  });

  it.each([
    {
      name: "text delta with a non-string delta",
      event: { type: "text_delta", delta: 42 },
    },
    {
      name: "thinking delta without a delta",
      event: { type: "thinking_delta" },
    },
    {
      name: "message update without cumulative content",
      event: { type: "message_update", content: { type: "text", text: "partial" } },
    },
    {
      name: "message end without cumulative content",
      event: { type: "message_end", content: null },
    },
    {
      name: "run end without a result object",
      event: { type: "run_end", result: [] },
    },
    {
      name: "queued tool without input",
      event: { type: "tool_queued", toolCallId: "call_1", toolName: "read_file" },
    },
    {
      name: "running tool without a description field",
      event: { type: "tool_running", toolCallId: "call_1", toolName: "read_file" },
    },
    {
      name: "tool update without partial output",
      event: { type: "tool_update", toolCallId: "call_1", toolName: "read_file" },
    },
    {
      name: "completed tool without a result",
      event: { type: "tool_completed", toolCallId: "call_1", toolName: "read_file" },
    },
    {
      name: "errored tool without a displayable error",
      event: {
        type: "tool_errored",
        toolCallId: "call_1",
        toolName: "read_file",
        error: " \u0000 ",
      },
    },
    {
      name: "denied tool with an unsafe identifier",
      event: { type: "tool_denied", toolCallId: "call_\u0000", toolName: "read_file" },
    },
    {
      name: "hook-blocked tool without displayable output",
      event: {
        type: "tool_hook_blocked",
        toolCallId: "call_1",
        toolName: "write_file",
        hookOutput: "",
      },
    },
  ])("rejects a recognized v1 $name", ({ event }) => {
    expectProtocolError(
      () =>
        new CommandCodeHeadlessProtocolParser().push(
          jsonLine({
            type: "event",
            event,
          }),
        ),
      "invalid_envelope",
      /does not match its supported v1 schema/iu,
    );
  });

  it("independently budgets and drops redundant cumulative snapshots", () => {
    const parser = new CommandCodeHeadlessProtocolParser({
      maxLineBytes: 512,
      maxTotalBytes: 700,
      maxRedundantLineBytes: 4_096,
      maxRedundantTotalBytes: 8_192,
      maxRedundantRecords: 4_096,
    });
    let cumulativeText = "";
    const snapshots: Readonly<Record<string, unknown>>[] = [];
    for (let index = 0; index < 2_048; index += 1) {
      cumulativeText += "x";
      snapshots.push({
        type: "event",
        event: {
          type: "message_update",
          content: [{ type: "text", text: cumulativeText }],
        },
      });
    }
    snapshots.push(
      {
        type: "event",
        event: {
          type: "message_end",
          content: [{ type: "text", text: cumulativeText }],
        },
      },
      {
        type: "event",
        event: {
          type: "run_end",
          result: { nextState: { transcript: cumulativeText } },
        },
      },
    );
    const stream = `${snapshots.map((record) => jsonLine(record)).join("")}${jsonLine(
      resultRecord({ finalText: "done" }),
    )}`;

    const records = parser.push(stream);
    expect(parser.finish()).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "result", subtype: "success" });
    expect(parser.totalBytes).toBeGreaterThan(2_000_000);
  });

  it("bounds redundant snapshot counts independently from projected records", () => {
    const parser = new CommandCodeHeadlessProtocolParser({
      maxLineBytes: 512,
      maxTotalBytes: 4_096,
      maxRedundantLineBytes: 512,
      maxRedundantTotalBytes: 4_096,
      maxRedundantRecords: 2,
    });
    const snapshot = jsonLine({
      type: "event",
      event: {
        type: "message_update",
        content: [{ type: "text", text: "partial" }],
      },
    });

    expectProtocolError(
      () => parser.push(snapshot.repeat(3)),
      "total_limit_exceeded",
      /more than 2 redundant snapshot records/iu,
    );
  });

  it("caps cumulative transport work for repeated same-sized snapshots", () => {
    const snapshot = jsonLine({
      type: "event",
      event: {
        type: "message_update",
        content: [{ type: "text", text: "same snapshot" }],
      },
    });
    const parser = new CommandCodeHeadlessProtocolParser({
      maxLineBytes: 512,
      maxTotalBytes: 4_096,
      maxTransportBytes: snapshot.length * 2,
      maxRedundantLineBytes: 512,
      maxRedundantTotalBytes: 4_096,
      maxRedundantRecords: 100,
    });

    expect(parser.push(snapshot)).toEqual([]);
    expect(parser.push(snapshot)).toEqual([]);
    expectProtocolError(
      () => parser.push(snapshot),
      "total_limit_exceeded",
      /transport exceeded.*absolute limit/iu,
    );
  });

  it("assembles a large redundant line from many chunks without emitting it", () => {
    const parser = new CommandCodeHeadlessProtocolParser({
      maxLineBytes: 1_024,
      maxTotalBytes: 2_048,
      maxRedundantLineBytes: 2 * 1024 * 1024,
      maxRedundantTotalBytes: 2 * 1024 * 1024,
      maxRedundantRecords: 10,
    });
    const snapshot = Buffer.from(
      jsonLine({
        type: "event",
        event: {
          type: "message_update",
          content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
        },
      }),
      "utf8",
    );

    let emittedRecords = 0;
    for (let offset = 0; offset < snapshot.byteLength; offset += 257) {
      emittedRecords += parser.push(snapshot.subarray(offset, offset + 257)).length;
    }
    expect(emittedRecords).toBe(0);

    const records = parser.push(jsonLine(resultRecord({ finalText: "done" })));
    expect(records).toHaveLength(1);
    expect(parser.finish()).toEqual([]);
    expect(parser.totalBytes).toBeGreaterThan(1024 * 1024);
  });

  it("accepts bounded safe print-session identifiers", () => {
    expect(parseCommandCodePrintSessionId(SESSION_ID)).toBe(SESSION_ID);
    expect(parseCommandCodePrintSessionId(SESSION_ID.toUpperCase())).toBe(SESSION_ID.toUpperCase());
    expect(parseCommandCodePrintSessionId("sess_0123456789abcdef")).toBe("sess_0123456789abcdef");
    expect(parseCommandCodePrintSessionId("01JZ9HJRDX4G2MZQ6JBA6KP7RF")).toBe(
      "01JZ9HJRDX4G2MZQ6JBA6KP7RF",
    );

    for (const invalid of [
      "-session",
      ".session",
      "../session",
      "..\\session",
      `${SESSION_ID}/transcript`,
      ` ${SESSION_ID}`,
      `${SESSION_ID} `,
      "session:name",
      "session.name",
      "session$name",
      "a".repeat(129),
      "",
      42,
    ]) {
      expect(parseCommandCodePrintSessionId(invalid)).toBeUndefined();
    }

    expectProtocolError(
      () =>
        new CommandCodeHeadlessProtocolParser().push(
          jsonLine({
            type: "event",
            event: { type: "run_start", sessionId: "../session" },
          }),
        ),
      "invalid_envelope",
      /run_start.*sessionId.*identifier/iu,
    );
    expectProtocolError(
      () =>
        new CommandCodeHeadlessProtocolParser().push(
          jsonLine(resultRecord({ sessionId: "..\\session" })),
        ),
      "invalid_envelope",
      /result.*sessionId.*identifier/iu,
    );
  });

  it.each([
    {
      name: "malformed JSON",
      line: "{oops}\n",
      code: "malformed_json" as const,
      message: /malformed JSON.*line 1/iu,
    },
    {
      name: "an array envelope",
      line: "[]\n",
      code: "invalid_envelope" as const,
      message: /line 1.*JSON object/iu,
    },
    {
      name: "an unknown envelope type",
      line: jsonLine({ type: "progress", value: 1 }),
      code: "invalid_envelope" as const,
      message: /type.*event.*result/iu,
    },
    {
      name: "a missing event object",
      line: jsonLine({ type: "event" }),
      code: "invalid_envelope" as const,
      message: /event.*object/iu,
    },
    {
      name: "a missing event type",
      line: jsonLine({ type: "event", event: { value: 1 } }),
      code: "invalid_envelope" as const,
      message: /event.type.*non-empty.*string/iu,
    },
    {
      name: "an unsupported result subtype",
      line: jsonLine(resultRecord({ subtype: "cancelled" })),
      code: "invalid_envelope" as const,
      message: /subtype.*success.*error.*max_turns/iu,
    },
    {
      name: "a missing usage object",
      line: jsonLine(resultRecord({ usage: null })),
      code: "invalid_envelope" as const,
      message: /usage.*object/iu,
    },
    {
      name: "usage with a missing required counter",
      line: jsonLine(
        resultRecord({
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            cacheReadTokens: 3,
          },
        }),
      ),
      code: "invalid_envelope" as const,
      message: /usage\.cacheWriteTokens.*non-negative safe integer/iu,
    },
    {
      name: "usage with a fractional counter",
      line: jsonLine(
        resultRecord({
          usage: {
            inputTokens: 12,
            outputTokens: 4.5,
            cacheReadTokens: 3,
            cacheWriteTokens: 0,
          },
        }),
      ),
      code: "invalid_envelope" as const,
      message: /usage\.outputTokens.*non-negative safe integer/iu,
    },
    {
      name: "a negative duration",
      line: jsonLine(resultRecord({ durationMs: -1 })),
      code: "invalid_envelope" as const,
      message: /durationMs.*non-negative/iu,
    },
    {
      name: "a non-string final answer",
      line: jsonLine(resultRecord({ finalText: null })),
      code: "invalid_envelope" as const,
      message: /finalText.*string/iu,
    },
    {
      name: "an error outcome without an error",
      line: jsonLine(
        resultRecord({
          subtype: "error",
          stopReason: undefined,
          finalText: "",
          error: undefined,
        }),
      ),
      code: "invalid_envelope" as const,
      message: /error subtype.*error.*non-empty string/iu,
    },
    {
      name: "a successful outcome carrying an error",
      line: jsonLine(resultRecord({ error: "unexpected" })),
      code: "invalid_envelope" as const,
      message: /error.*only.*error subtype/iu,
    },
  ])("rejects $name", ({ line, code, message }) => {
    expectProtocolError(() => new CommandCodeHeadlessProtocolParser().push(line), code, message);
  });

  it("parses an early error result without a session id or stop reason", () => {
    const parser = new CommandCodeHeadlessProtocolParser();
    const [result] = parser.push(
      jsonLine({
        type: "result",
        subtype: "error",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        durationMs: 12,
        finalText: "",
        error: "Not authenticated",
      }),
    );

    expect(result).toMatchObject({
      type: "result",
      subtype: "error",
      durationMs: 12,
      finalText: "",
      error: "Not authenticated",
    });
    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("stopReason");
    expect(parser.finish()).toEqual([]);
  });

  it("accepts an error result with an upstream stop reason", () => {
    const parser = new CommandCodeHeadlessProtocolParser();
    const [result] = parser.push(
      jsonLine({
        type: "result",
        subtype: "error",
        stopReason: "authentication_error",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        durationMs: 12,
        finalText: "",
        error: "Not authenticated",
      }),
    );

    expect(result).toMatchObject({
      type: "result",
      subtype: "error",
      stopReason: "authentication_error",
      error: "Not authenticated",
    });
    expect(parser.finish()).toEqual([]);
  });

  it("rejects a duplicate result and non-blank content after the result", () => {
    const duplicateParser = new CommandCodeHeadlessProtocolParser();
    duplicateParser.push(jsonLine(resultRecord()));
    expectProtocolError(
      () => duplicateParser.push(jsonLine(resultRecord())),
      "duplicate_result",
      /duplicate final result.*line 2/iu,
    );

    const trailingParser = new CommandCodeHeadlessProtocolParser();
    trailingParser.push(jsonLine(resultRecord()));
    expectProtocolError(
      () => trailingParser.push(jsonLine({ type: "event", event: { type: "future_event" } })),
      "content_after_result",
      /content after.*final result.*line 2/iu,
    );
  });

  it("requires a final result when the stream finishes", () => {
    const parser = new CommandCodeHeadlessProtocolParser();
    parser.push(
      jsonLine({
        type: "event",
        event: { type: "text_delta", delta: "partial" },
      }),
    );

    expectProtocolError(() => parser.finish(), "missing_result", /ended without a final result/iu);
  });

  it("enforces unfinished-line and total stream byte budgets", () => {
    const lineLimited = new CommandCodeHeadlessProtocolParser({
      maxLineBytes: 5,
      maxTotalBytes: 100,
    });
    expect(lineLimited.push("12345")).toEqual([]);
    expect(lineLimited.push("6")).toEqual([]);
    expectProtocolError(() => lineLimited.finish(), "line_limit_exceeded", /exceeded.*5-byte/iu);

    const totalLimited = new CommandCodeHeadlessProtocolParser({
      maxLineBytes: 100,
      maxTotalBytes: 5,
    });
    expect(totalLimited.push("123")).toEqual([]);
    expect(totalLimited.push("45")).toEqual([]);
    expect(totalLimited.push("6")).toEqual([]);
    expectProtocolError(() => totalLimited.finish(), "total_limit_exceeded", /exceeded.*5-byte/iu);
  });

  it("treats CRLF as one delimiter when enforcing the line budget", () => {
    const serializedResult = JSON.stringify(resultRecord());
    const parser = new CommandCodeHeadlessProtocolParser({
      maxLineBytes: Buffer.byteLength(serializedResult, "utf8"),
      maxTotalBytes: Buffer.byteLength(serializedResult, "utf8") + 2,
    });

    expect(parser.push(`${serializedResult}\r`)).toEqual([]);
    expect(parser.push("\n")).toHaveLength(1);
    expect(parser.finish()).toEqual([]);
  });

  it("rejects malformed UTF-8 before attempting JSON parsing", () => {
    const parser = new CommandCodeHeadlessProtocolParser();
    expect(parser.push(Uint8Array.of(0xc3))).toEqual([]);
    expectProtocolError(
      () => parser.push(Uint8Array.of(0x28)),
      "invalid_utf8",
      /not valid UTF-8/iu,
    );
  });
});
