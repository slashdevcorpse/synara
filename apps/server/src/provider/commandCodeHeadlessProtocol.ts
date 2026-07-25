import { TextDecoder } from "node:util";

export const COMMAND_CODE_HEADLESS_MAX_LINE_BYTES = 16 * 1024 * 1024;
export const COMMAND_CODE_HEADLESS_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const COMMAND_CODE_HEADLESS_MAX_TRANSPORT_BYTES = 512 * 1024 * 1024;
export const COMMAND_CODE_HEADLESS_MAX_REDUNDANT_LINE_BYTES = 64 * 1024 * 1024;
export const COMMAND_CODE_HEADLESS_MAX_REDUNDANT_TOTAL_BYTES = 512 * 1024 * 1024;
export const COMMAND_CODE_HEADLESS_MAX_REDUNDANT_RECORDS = 1_048_576;

export type CommandCodeHeadlessProtocolErrorCode =
  | "invalid_options"
  | "already_finished"
  | "invalid_utf8"
  | "line_limit_exceeded"
  | "total_limit_exceeded"
  | "malformed_json"
  | "invalid_envelope"
  | "duplicate_result"
  | "content_after_result"
  | "missing_result";

export class CommandCodeHeadlessProtocolError extends Error {
  readonly code: CommandCodeHeadlessProtocolErrorCode;

  constructor(code: CommandCodeHeadlessProtocolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodeHeadlessProtocolError";
    this.code = code;
  }
}

export interface CommandCodeHeadlessProtocolParserOptions {
  readonly maxLineBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxTransportBytes?: number;
  readonly maxRedundantLineBytes?: number;
  readonly maxRedundantTotalBytes?: number;
  readonly maxRedundantRecords?: number;
}

export interface CommandCodeHeadlessEventRecord {
  readonly type: "event";
  readonly eventType: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type CommandCodeHeadlessResultSubtype = "success" | "error" | "max_turns";

export interface CommandCodeHeadlessResultRecord {
  readonly type: "result";
  readonly subtype: CommandCodeHeadlessResultSubtype;
  readonly sessionId?: string;
  readonly stopReason?: string;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
  readonly finalText: string;
  readonly error?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type CommandCodeHeadlessRecord =
  | CommandCodeHeadlessEventRecord
  | CommandCodeHeadlessResultRecord;

export interface CommandCodeRunStartEvent {
  readonly type: "run_start";
  readonly sessionId: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CommandCodeTextDeltaEvent {
  readonly type: "text_delta";
  readonly delta: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CommandCodeThinkingDeltaEvent {
  readonly type: "thinking_delta";
  readonly delta: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

interface CommandCodeToolEventBase {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CommandCodeToolQueuedEvent extends CommandCodeToolEventBase {
  readonly type: "tool_queued";
  readonly input: unknown;
}

export interface CommandCodeToolRunningEvent extends CommandCodeToolEventBase {
  readonly type: "tool_running";
  readonly description: string | null;
}

export interface CommandCodeToolUpdateEvent extends CommandCodeToolEventBase {
  readonly type: "tool_update";
  readonly partial: unknown;
}

export interface CommandCodeToolCompletedEvent extends CommandCodeToolEventBase {
  readonly type: "tool_completed";
  readonly result: unknown;
}

export interface CommandCodeToolErroredEvent extends CommandCodeToolEventBase {
  readonly type: "tool_errored";
  readonly error: string;
}

export interface CommandCodeToolDeniedEvent extends CommandCodeToolEventBase {
  readonly type: "tool_denied";
}

export interface CommandCodeToolHookBlockedEvent extends CommandCodeToolEventBase {
  readonly type: "tool_hook_blocked";
  readonly hookOutput: string;
}

export type CommandCodeToolEvent =
  | CommandCodeToolQueuedEvent
  | CommandCodeToolRunningEvent
  | CommandCodeToolUpdateEvent
  | CommandCodeToolCompletedEvent
  | CommandCodeToolErroredEvent
  | CommandCodeToolDeniedEvent
  | CommandCodeToolHookBlockedEvent;

const PRINT_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const UNSAFE_DISPLAY_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_TOOL_IDENTIFIER_LENGTH = 256;
const MAX_RESULT_STOP_REASON_LENGTH = 128;
const MAX_PROTOCOL_DETAIL_BYTES = 64 * 1024;
const REDUNDANT_SNAPSHOT_EVENT_TYPES = new Set(["message_update", "message_end", "run_end"]);
const PROJECTED_TOOL_EVENT_TYPES = new Set([
  "tool_queued",
  "tool_running",
  "tool_update",
  "tool_completed",
  "tool_errored",
  "tool_denied",
  "tool_hook_blocked",
]);

type CommandCodeTextRope =
  | string
  | {
      readonly left: CommandCodeTextRope;
      readonly right: CommandCodeTextRope;
    };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function boundedIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return undefined;
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const truncated = bytes.subarray(0, maxBytes).toString("utf8");
  return truncated.endsWith("\uFFFD") ? truncated.slice(0, -1) : truncated;
}

function boundedDisplayText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(UNSAFE_DISPLAY_CONTROL_PATTERN, "").trim();
  if (text.length === 0) return undefined;
  return truncateUtf8(text, maxBytes);
}

function truncatedDisplayText(value: string, maxBytes: number): string {
  return truncateUtf8(value.replace(UNSAFE_DISPLAY_CONTROL_PATTERN, ""), maxBytes);
}

function parseResultUsage(
  usage: Readonly<Record<string, unknown>>,
  lineNumber: number,
): Readonly<Record<string, unknown>> {
  const projected: Record<string, number> = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    const value = usage[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw envelopeError(lineNumber, `result.usage.${key} must be a non-negative safe integer`);
    }
    projected[key] = value;
  }
  return projected;
}

function envelopeError(lineNumber: number, issue: string): CommandCodeHeadlessProtocolError {
  return new CommandCodeHeadlessProtocolError(
    "invalid_envelope",
    `Invalid Command Code headless envelope at line ${String(lineNumber)}: ${issue}.`,
  );
}

function parseResultSubtype(value: unknown, lineNumber: number): CommandCodeHeadlessResultSubtype {
  if (value === "success" || value === "error" || value === "max_turns") return value;
  throw envelopeError(
    lineNumber,
    'result.subtype must be one of "success", "error", or "max_turns"',
  );
}

function recognizedEventPayloadIsValid(record: CommandCodeHeadlessEventRecord): boolean {
  switch (record.eventType) {
    case "run_start":
      return projectCommandCodeRunStartEvent(record) !== undefined;
    case "text_delta":
      return projectCommandCodeTextDeltaEvent(record) !== undefined;
    case "thinking_delta":
      return projectCommandCodeThinkingDeltaEvent(record) !== undefined;
    case "message_update":
    case "message_end":
      return Array.isArray(record.event.content);
    case "run_end":
      return isRecord(record.event.result);
    default:
      return PROJECTED_TOOL_EVENT_TYPES.has(record.eventType)
        ? projectCommandCodeToolEvent(record) !== undefined
        : true;
  }
}

function parseEventEnvelope(
  raw: Readonly<Record<string, unknown>>,
  lineNumber: number,
): CommandCodeHeadlessEventRecord {
  if (!isRecord(raw.event)) {
    throw envelopeError(lineNumber, "event must be a JSON object");
  }
  const event = raw.event;
  if (
    typeof event.type !== "string" ||
    event.type.trim().length === 0 ||
    event.type !== event.type.trim() ||
    event.type.length > MAX_EVENT_TYPE_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(event.type)
  ) {
    throw envelopeError(
      lineNumber,
      `event.type must be a non-empty control-free string of at most ${String(MAX_EVENT_TYPE_LENGTH)} characters`,
    );
  }
  if (event.type === "run_start" && parseCommandCodePrintSessionId(event.sessionId) === undefined) {
    throw envelopeError(lineNumber, "run_start sessionId must be a safe session identifier");
  }
  const record = {
    type: "event",
    eventType: event.type,
    event,
    raw,
  } as const;
  if (!recognizedEventPayloadIsValid(record)) {
    throw envelopeError(
      lineNumber,
      `event ${JSON.stringify(event.type)} does not match its supported v1 schema`,
    );
  }
  return record;
}

function parseResultEnvelope(
  raw: Readonly<Record<string, unknown>>,
  lineNumber: number,
): CommandCodeHeadlessResultRecord {
  const subtype = parseResultSubtype(raw.subtype, lineNumber);
  if (!isRecord(raw.usage)) {
    throw envelopeError(lineNumber, "result.usage must be a JSON object");
  }
  const usage = parseResultUsage(raw.usage, lineNumber);
  if (
    typeof raw.durationMs !== "number" ||
    !Number.isFinite(raw.durationMs) ||
    raw.durationMs < 0
  ) {
    throw envelopeError(lineNumber, "result.durationMs must be a finite non-negative number");
  }
  if (typeof raw.finalText !== "string") {
    throw envelopeError(lineNumber, "result.finalText must be a string");
  }

  let sessionId: string | undefined;
  if (hasOwn(raw, "sessionId")) {
    sessionId = parseCommandCodePrintSessionId(raw.sessionId);
    if (sessionId === undefined) {
      throw envelopeError(
        lineNumber,
        "result.sessionId must be a safe session identifier when present",
      );
    }
  }

  let stopReason: string | undefined;
  if (hasOwn(raw, "stopReason")) {
    stopReason = boundedIdentifier(raw.stopReason, MAX_RESULT_STOP_REASON_LENGTH);
    if (stopReason === undefined) {
      throw envelopeError(
        lineNumber,
        `result.stopReason must be a non-empty control-free string of at most ${String(MAX_RESULT_STOP_REASON_LENGTH)} characters when present`,
      );
    }
  }

  let error: string | undefined;
  if (subtype === "error") {
    error = boundedDisplayText(raw.error, MAX_PROTOCOL_DETAIL_BYTES);
    if (error === undefined) {
      throw envelopeError(
        lineNumber,
        "the error subtype requires result.error to be a non-empty string",
      );
    }
  } else if (hasOwn(raw, "error")) {
    throw envelopeError(lineNumber, "result.error is allowed only for the error subtype");
  }

  const normalizedRaw = {
    type: "result",
    subtype,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(stopReason === undefined ? {} : { stopReason }),
    usage,
    durationMs: raw.durationMs,
    finalText: raw.finalText,
    ...(error === undefined ? {} : { error }),
  } as const;
  return {
    ...normalizedRaw,
    raw: normalizedRaw,
  };
}

function parseEnvelope(value: unknown, lineNumber: number): CommandCodeHeadlessRecord {
  if (!isRecord(value)) {
    throw envelopeError(lineNumber, "the line must contain a JSON object");
  }
  if (value.type === "event") return parseEventEnvelope(value, lineNumber);
  if (value.type === "result") return parseResultEnvelope(value, lineNumber);
  throw envelopeError(lineNumber, 'type must be either "event" or "result"');
}

function eventHasType(record: CommandCodeHeadlessEventRecord, type: string): boolean {
  return record.eventType === type && record.event.type === type;
}

function nonEmptyEventString(
  event: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return boundedIdentifier(event[key], MAX_TOOL_IDENTIFIER_LENGTH);
}

function projectToolBase(
  record: CommandCodeHeadlessEventRecord,
): Pick<CommandCodeToolEventBase, "toolCallId" | "toolName" | "raw"> | undefined {
  const toolCallId = nonEmptyEventString(record.event, "toolCallId");
  const toolName = nonEmptyEventString(record.event, "toolName");
  if (toolCallId === undefined || toolName === undefined) return undefined;
  return { toolCallId, toolName, raw: record.event };
}

export function parseCommandCodePrintSessionId(value: unknown): string | undefined {
  return typeof value === "string" && PRINT_SESSION_ID_PATTERN.test(value) ? value : undefined;
}

export function projectCommandCodeRunStartEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeRunStartEvent | undefined {
  if (!eventHasType(record, "run_start")) return undefined;
  const sessionId = parseCommandCodePrintSessionId(record.event.sessionId);
  if (sessionId === undefined) return undefined;
  return { type: "run_start", sessionId, raw: record.event };
}

export function projectCommandCodeTextDeltaEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeTextDeltaEvent | undefined {
  if (!eventHasType(record, "text_delta") || typeof record.event.delta !== "string") {
    return undefined;
  }
  return { type: "text_delta", delta: record.event.delta, raw: record.event };
}

export function projectCommandCodeThinkingDeltaEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeThinkingDeltaEvent | undefined {
  if (!eventHasType(record, "thinking_delta") || typeof record.event.delta !== "string") {
    return undefined;
  }
  return { type: "thinking_delta", delta: record.event.delta, raw: record.event };
}

export function projectCommandCodeToolQueuedEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeToolQueuedEvent | undefined {
  if (!eventHasType(record, "tool_queued") || !hasOwn(record.event, "input")) {
    return undefined;
  }
  const base = projectToolBase(record);
  if (base === undefined) return undefined;
  return {
    type: "tool_queued",
    ...base,
    input: record.event.input,
  };
}

export function projectCommandCodeToolRunningEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeToolRunningEvent | undefined {
  if (!eventHasType(record, "tool_running") || !hasOwn(record.event, "description")) {
    return undefined;
  }
  const description = record.event.description;
  if (description !== null && typeof description !== "string") return undefined;
  const base = projectToolBase(record);
  if (base === undefined) return undefined;
  return {
    type: "tool_running",
    ...base,
    description:
      description === null ? null : truncatedDisplayText(description, MAX_PROTOCOL_DETAIL_BYTES),
  };
}

export function projectCommandCodeToolUpdateEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeToolUpdateEvent | undefined {
  if (!eventHasType(record, "tool_update") || !hasOwn(record.event, "partial")) {
    return undefined;
  }
  const base = projectToolBase(record);
  if (base === undefined) return undefined;
  return {
    type: "tool_update",
    ...base,
    partial: record.event.partial,
  };
}

export function projectCommandCodeToolCompletedEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeToolCompletedEvent | undefined {
  if (!eventHasType(record, "tool_completed") || !hasOwn(record.event, "result")) {
    return undefined;
  }
  const base = projectToolBase(record);
  if (base === undefined) return undefined;
  return {
    type: "tool_completed",
    ...base,
    result: record.event.result,
  };
}

export function projectCommandCodeToolErroredEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeToolErroredEvent | undefined {
  if (!eventHasType(record, "tool_errored")) return undefined;
  const error = boundedDisplayText(record.event.error, MAX_PROTOCOL_DETAIL_BYTES);
  if (error === undefined) return undefined;
  const base = projectToolBase(record);
  if (base === undefined) return undefined;
  return {
    type: "tool_errored",
    ...base,
    error,
  };
}

export function projectCommandCodeToolDeniedEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeToolDeniedEvent | undefined {
  if (!eventHasType(record, "tool_denied")) return undefined;
  const base = projectToolBase(record);
  if (base === undefined) return undefined;
  return {
    type: "tool_denied",
    ...base,
  };
}

export function projectCommandCodeToolHookBlockedEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeToolHookBlockedEvent | undefined {
  if (!eventHasType(record, "tool_hook_blocked")) return undefined;
  const hookOutput = boundedDisplayText(record.event.hookOutput, MAX_PROTOCOL_DETAIL_BYTES);
  if (hookOutput === undefined) return undefined;
  const base = projectToolBase(record);
  if (base === undefined) return undefined;
  return {
    type: "tool_hook_blocked",
    ...base,
    hookOutput,
  };
}

export function projectCommandCodeToolEvent(
  record: CommandCodeHeadlessEventRecord,
): CommandCodeToolEvent | undefined {
  switch (record.eventType) {
    case "tool_queued":
      return projectCommandCodeToolQueuedEvent(record);
    case "tool_running":
      return projectCommandCodeToolRunningEvent(record);
    case "tool_update":
      return projectCommandCodeToolUpdateEvent(record);
    case "tool_completed":
      return projectCommandCodeToolCompletedEvent(record);
    case "tool_errored":
      return projectCommandCodeToolErroredEvent(record);
    case "tool_denied":
      return projectCommandCodeToolDeniedEvent(record);
    case "tool_hook_blocked":
      return projectCommandCodeToolHookBlockedEvent(record);
    default:
      return undefined;
  }
}

export class CommandCodeHeadlessProtocolParser {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxLineBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxTransportBytes: number;
  readonly #maxRedundantLineBytes: number;
  readonly #maxRedundantTotalBytes: number;
  readonly #maxRedundantRecords: number;
  readonly #maxTransportLineBytes: number;
  readonly #lineRopeBins: Array<CommandCodeTextRope | undefined> = [];
  #lineCharacterLength = 0;
  #lineNumber = 0;
  #pendingLineBytes = 0;
  #pendingLineLastByte: number | undefined;
  #totalBytes = 0;
  #budgetedBytes = 0;
  #redundantBytes = 0;
  #redundantRecords = 0;
  readonly #redundantHighWaterBytes = new Map<"message" | "run", number>();
  #result: CommandCodeHeadlessResultRecord | undefined;
  #failure: CommandCodeHeadlessProtocolError | undefined;
  #finished = false;

  constructor(options: CommandCodeHeadlessProtocolParserOptions = {}) {
    const maxLineBytes = options.maxLineBytes ?? COMMAND_CODE_HEADLESS_MAX_LINE_BYTES;
    const maxTotalBytes = options.maxTotalBytes ?? COMMAND_CODE_HEADLESS_MAX_TOTAL_BYTES;
    const maxTransportBytes =
      options.maxTransportBytes ?? COMMAND_CODE_HEADLESS_MAX_TRANSPORT_BYTES;
    const maxRedundantLineBytes =
      options.maxRedundantLineBytes ?? COMMAND_CODE_HEADLESS_MAX_REDUNDANT_LINE_BYTES;
    const maxRedundantTotalBytes =
      options.maxRedundantTotalBytes ?? COMMAND_CODE_HEADLESS_MAX_REDUNDANT_TOTAL_BYTES;
    const maxRedundantRecords =
      options.maxRedundantRecords ?? COMMAND_CODE_HEADLESS_MAX_REDUNDANT_RECORDS;
    if (
      !validLimit(maxLineBytes) ||
      !validLimit(maxTotalBytes) ||
      !validLimit(maxTransportBytes) ||
      !validLimit(maxRedundantLineBytes) ||
      !validLimit(maxRedundantTotalBytes) ||
      !validLimit(maxRedundantRecords)
    ) {
      throw new CommandCodeHeadlessProtocolError(
        "invalid_options",
        "Command Code headless parser byte limits must be positive safe integers.",
      );
    }
    this.#maxLineBytes = maxLineBytes;
    this.#maxTotalBytes = maxTotalBytes;
    this.#maxTransportBytes = maxTransportBytes;
    this.#maxRedundantLineBytes = maxRedundantLineBytes;
    this.#maxRedundantTotalBytes = maxRedundantTotalBytes;
    this.#maxRedundantRecords = maxRedundantRecords;
    this.#maxTransportLineBytes = Math.max(maxLineBytes, maxRedundantLineBytes);
  }

  get result(): CommandCodeHeadlessResultRecord | undefined {
    return this.#result;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  push(chunk: string | Uint8Array): ReadonlyArray<CommandCodeHeadlessRecord> {
    this.#assertWritable();
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (bytes.byteLength === 0) return [];
    if (bytes.byteLength > this.#maxTransportBytes - this.#totalBytes) {
      return this.#fail(
        new CommandCodeHeadlessProtocolError(
          "total_limit_exceeded",
          `Command Code headless transport exceeded the ${String(this.#maxTransportBytes)}-byte absolute limit.`,
        ),
      );
    }

    this.#trackLineBytes(bytes);
    this.#totalBytes += bytes.byteLength;

    let decoded: string;
    try {
      decoded = this.#decoder.decode(bytes, { stream: true });
    } catch (cause) {
      return this.#fail(
        new CommandCodeHeadlessProtocolError(
          "invalid_utf8",
          "Command Code headless stdout is not valid UTF-8.",
          { cause },
        ),
      );
    }
    return this.#consumeDecodedText(decoded);
  }

  finish(): ReadonlyArray<CommandCodeHeadlessRecord> {
    this.#assertWritable();
    if (this.#pendingLineBytes > this.#maxTransportLineBytes) {
      return this.#fail(
        new CommandCodeHeadlessProtocolError(
          "line_limit_exceeded",
          `Command Code headless unfinished line exceeded the ${String(this.#maxTransportLineBytes)}-byte transport limit.`,
        ),
      );
    }

    let decoded: string;
    try {
      decoded = this.#decoder.decode();
    } catch (cause) {
      return this.#fail(
        new CommandCodeHeadlessProtocolError(
          "invalid_utf8",
          "Command Code headless stdout is not valid UTF-8.",
          { cause },
        ),
      );
    }

    const records = [...this.#consumeDecodedText(decoded)];
    if (this.#lineCharacterLength > 0) {
      const line = this.#takeLineText();
      this.#pendingLineBytes = 0;
      this.#pendingLineLastByte = undefined;
      const record = this.#consumeLine(line, false);
      if (record !== undefined) records.push(record);
    }
    if (this.#result === undefined) {
      return this.#fail(
        new CommandCodeHeadlessProtocolError(
          "missing_result",
          "Command Code headless stream ended without a final result.",
        ),
      );
    }
    this.#finished = true;
    return records;
  }

  #assertWritable(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#finished) {
      throw new CommandCodeHeadlessProtocolError(
        "already_finished",
        "Command Code headless parser has already finished.",
      );
    }
  }

  #fail(error: CommandCodeHeadlessProtocolError): never {
    this.#failure = error;
    throw error;
  }

  #trackLineBytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (byte === 0x0a) {
        const lineBytes = this.#pendingLineBytes - (this.#pendingLineLastByte === 0x0d ? 1 : 0);
        if (lineBytes > this.#maxTransportLineBytes) {
          this.#fail(
            new CommandCodeHeadlessProtocolError(
              "line_limit_exceeded",
              `Command Code headless line exceeded the ${String(this.#maxTransportLineBytes)}-byte transport limit.`,
            ),
          );
        }
        this.#pendingLineBytes = 0;
        this.#pendingLineLastByte = undefined;
        continue;
      }

      this.#pendingLineBytes += 1;
      this.#pendingLineLastByte = byte;
      const awaitingPossibleCrLf =
        this.#pendingLineBytes === this.#maxTransportLineBytes + 1 && byte === 0x0d;
      if (this.#pendingLineBytes > this.#maxTransportLineBytes && !awaitingPossibleCrLf) {
        this.#fail(
          new CommandCodeHeadlessProtocolError(
            "line_limit_exceeded",
            `Command Code headless unfinished line exceeded the ${String(this.#maxTransportLineBytes)}-byte transport limit.`,
          ),
        );
      }
    }
  }

  #consumeDecodedText(decoded: string): ReadonlyArray<CommandCodeHeadlessRecord> {
    if (decoded.length === 0) return [];
    const records: CommandCodeHeadlessRecord[] = [];
    let offset = 0;
    let newlineIndex = decoded.indexOf("\n", offset);
    while (newlineIndex !== -1) {
      this.#appendLineText(decoded.slice(offset, newlineIndex));
      const record = this.#consumeLine(this.#takeLineText());
      if (record !== undefined) records.push(record);
      offset = newlineIndex + 1;
      newlineIndex = decoded.indexOf("\n", offset);
    }
    this.#appendLineText(decoded.slice(offset));
    return records;
  }

  #appendLineText(fragment: string): void {
    if (fragment.length === 0) return;
    this.#lineCharacterLength += fragment.length;
    let node: CommandCodeTextRope = fragment;
    let level = 0;
    while (true) {
      const existing = this.#lineRopeBins[level];
      if (existing === undefined) {
        this.#lineRopeBins[level] = node;
        return;
      }
      this.#lineRopeBins[level] = undefined;
      node = { left: existing, right: node };
      level += 1;
    }
  }

  #takeLineText(): string {
    if (this.#lineCharacterLength === 0) return "";
    const parts: string[] = [];
    for (let level = this.#lineRopeBins.length - 1; level >= 0; level -= 1) {
      const root = this.#lineRopeBins[level];
      this.#lineRopeBins[level] = undefined;
      if (root === undefined) continue;
      const stack: CommandCodeTextRope[] = [root];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (typeof node === "string") {
          parts.push(node);
        } else {
          stack.push(node.right, node.left);
        }
      }
    }
    this.#lineCharacterLength = 0;
    return parts.join("");
  }

  #consumeLine(rawLine: string, terminated = true): CommandCodeHeadlessRecord | undefined {
    this.#lineNumber += 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineBytes = Buffer.byteLength(line, "utf8");
    const transportBytes = Buffer.byteLength(rawLine, "utf8") + (terminated ? 1 : 0);
    if (line.trim().length === 0) {
      this.#chargeStandardBytes(lineBytes, transportBytes);
      return undefined;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (cause) {
      if (this.#result !== undefined) {
        return this.#fail(
          new CommandCodeHeadlessProtocolError(
            "content_after_result",
            `Command Code headless stream contained content after the final result at line ${String(this.#lineNumber)}.`,
            { cause },
          ),
        );
      }
      return this.#fail(
        new CommandCodeHeadlessProtocolError(
          "malformed_json",
          `Command Code headless stream contained malformed JSON at line ${String(this.#lineNumber)}.`,
          { cause },
        ),
      );
    }

    if (this.#result !== undefined) {
      const code =
        isRecord(value) && value.type === "result" ? "duplicate_result" : "content_after_result";
      const issue =
        code === "duplicate_result" ? "a duplicate final result" : "content after the final result";
      return this.#fail(
        new CommandCodeHeadlessProtocolError(
          code,
          `Command Code headless stream contained ${issue} at line ${String(this.#lineNumber)}.`,
        ),
      );
    }

    const redundantSnapshot =
      isRecord(value) &&
      value.type === "event" &&
      isRecord(value.event) &&
      typeof value.event.type === "string" &&
      REDUNDANT_SNAPSHOT_EVENT_TYPES.has(value.event.type);
    if (!redundantSnapshot) {
      this.#chargeStandardBytes(lineBytes, transportBytes);
    }

    let record: CommandCodeHeadlessRecord;
    try {
      record = parseEnvelope(value, this.#lineNumber);
    } catch (error) {
      if (error instanceof CommandCodeHeadlessProtocolError) return this.#fail(error);
      throw error;
    }
    if (redundantSnapshot && record.type === "event") {
      this.#chargeRedundantSnapshot(record.eventType, lineBytes, transportBytes);
      return undefined;
    }
    if (record.type === "result") this.#result = record;
    return record;
  }

  #chargeStandardBytes(lineBytes: number, transportBytes: number): void {
    if (lineBytes > this.#maxLineBytes) {
      this.#fail(
        new CommandCodeHeadlessProtocolError(
          "line_limit_exceeded",
          `Command Code headless line exceeded the ${String(this.#maxLineBytes)}-byte limit.`,
        ),
      );
    }
    if (transportBytes > this.#maxTotalBytes - this.#budgetedBytes) {
      this.#fail(
        new CommandCodeHeadlessProtocolError(
          "total_limit_exceeded",
          `Command Code headless stream exceeded the ${String(this.#maxTotalBytes)}-byte projected-record limit.`,
        ),
      );
    }
    this.#budgetedBytes += transportBytes;
  }

  #chargeRedundantSnapshot(eventType: string, lineBytes: number, transportBytes: number): void {
    if (lineBytes > this.#maxRedundantLineBytes) {
      this.#fail(
        new CommandCodeHeadlessProtocolError(
          "line_limit_exceeded",
          `Command Code redundant snapshot exceeded the ${String(this.#maxRedundantLineBytes)}-byte line limit.`,
        ),
      );
    }
    const budgetKey = eventType === "run_end" ? "run" : "message";
    const previousHighWater = this.#redundantHighWaterBytes.get(budgetKey) ?? 0;
    const additionalBytes = Math.max(0, transportBytes - previousHighWater);
    if (additionalBytes > this.#maxRedundantTotalBytes - this.#redundantBytes) {
      this.#fail(
        new CommandCodeHeadlessProtocolError(
          "total_limit_exceeded",
          `Command Code redundant snapshot high-water usage exceeded the ${String(this.#maxRedundantTotalBytes)}-byte limit.`,
        ),
      );
    }
    this.#redundantRecords += 1;
    if (this.#redundantRecords > this.#maxRedundantRecords) {
      this.#fail(
        new CommandCodeHeadlessProtocolError(
          "total_limit_exceeded",
          `Command Code emitted more than ${String(this.#maxRedundantRecords)} redundant snapshot records.`,
        ),
      );
    }
    this.#redundantBytes += additionalBytes;
    if (transportBytes > previousHighWater) {
      this.#redundantHighWaterBytes.set(budgetKey, transportBytes);
    }
  }
}
