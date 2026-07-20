import * as Crypto from "node:crypto";

import { WS_METHODS } from "@synara/contracts";

export const MAX_CONCURRENT_WS_CONNECTIONS = 50;
export const MAX_WS_CONNECTIONS_PER_MINUTE_PER_PEER = 10;
export const WS_MESSAGE_RATE_BURST = 100;
export const WS_MESSAGE_RATE_PER_SECOND = 50;
export const WS_TERMINAL_ACK_MESSAGE_RATE_BURST = 240;
export const WS_TERMINAL_ACK_MESSAGE_RATE_PER_SECOND = 120;
export const MAX_WS_TERMINAL_ACK_MESSAGE_BYTES = 4 * 1024;

export interface WsTransportAdmissionOptions {
  readonly now?: () => number;
  readonly maxConcurrentConnections?: number;
  readonly connectionBurstPerPeer?: number;
  readonly connectionRatePerMinutePerPeer?: number;
  readonly connectionPeerRateLimitEnabled?: boolean;
  readonly messageBurstPerConnection?: number;
  readonly messageRatePerSecondPerConnection?: number;
  readonly terminalAckMessageBurstPerConnection?: number;
  readonly terminalAckMessageRatePerSecondPerConnection?: number;
}

export type WsMessageClass = "standard" | "terminal-ack";

interface TokenBucket {
  readonly tokens: number;
  readonly refilledAtMs: number;
  readonly lastSeenAtMs: number;
}

export interface WsConnectionLease {
  readonly id: string;
  readonly peer: string;
}

export type WsConnectionAdmissionOutcome =
  | { readonly admitted: true; readonly lease: WsConnectionLease }
  | {
      readonly admitted: false;
      readonly reason: "global-capacity" | "peer-rate";
      readonly retryAfterMs: number;
    };

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

export function normalizeWsPeerAddress(remoteAddress: string | null | undefined): string {
  const normalized = remoteAddress?.trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function readBoundedTextMessage(data: unknown, isBinary: unknown): string | null {
  if (isBinary !== false) return null;
  if (typeof data === "string") {
    return Buffer.byteLength(data) <= MAX_WS_TERMINAL_ACK_MESSAGE_BYTES ? data : null;
  }
  if (Buffer.isBuffer(data)) {
    return data.byteLength <= MAX_WS_TERMINAL_ACK_MESSAGE_BYTES ? data.toString("utf8") : null;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength <= MAX_WS_TERMINAL_ACK_MESSAGE_BYTES
      ? Buffer.from(data).toString("utf8")
      : null;
  }
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
    const byteLength = data.reduce((total, part) => total + part.byteLength, 0);
    return byteLength <= MAX_WS_TERMINAL_ACK_MESSAGE_BYTES
      ? Buffer.concat(data, byteLength).toString("utf8")
      : null;
  }
  return null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

const RPC_REQUEST_KEYS = new Set([
  "_tag",
  "id",
  "tag",
  "payload",
  "headers",
  "traceId",
  "spanId",
  "sampled",
]);
const TERMINAL_ACK_PAYLOAD_KEYS = new Set(["threadId", "terminalId", "bytes"]);

function hasEncodedRpcHeaders(value: unknown): value is ReadonlyArray<readonly [string, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (header) =>
        Array.isArray(header) &&
        header.length === 2 &&
        typeof header[0] === "string" &&
        typeof header[1] === "string",
    )
  );
}

/**
 * Recognizes only one complete, text-encoded Effect RPC terminal ACK request.
 * Oversized, binary, batched, malformed, or extended frames stay in the
 * standard lane so a lookalike cannot bypass the general message limiter.
 */
export function classifyWsMessage(data: unknown, isBinary: unknown): WsMessageClass {
  const text = readBoundedTextMessage(data, isBinary);
  if (!text) return "standard";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "standard";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "standard";
  const frame = parsed as Record<string, unknown>;
  if (
    !hasOnlyKeys(frame, RPC_REQUEST_KEYS) ||
    frame._tag !== "Request" ||
    typeof frame.id !== "string" ||
    frame.id.length === 0 ||
    frame.tag !== WS_METHODS.terminalAckOutput ||
    !hasEncodedRpcHeaders(frame.headers) ||
    (frame.traceId !== undefined && typeof frame.traceId !== "string") ||
    (frame.spanId !== undefined && typeof frame.spanId !== "string") ||
    (frame.sampled !== undefined && typeof frame.sampled !== "boolean") ||
    !frame.payload ||
    typeof frame.payload !== "object" ||
    Array.isArray(frame.payload)
  ) {
    return "standard";
  }

  const payload = frame.payload as Record<string, unknown>;
  const terminalId = payload.terminalId;
  if (
    !hasOnlyKeys(payload, TERMINAL_ACK_PAYLOAD_KEYS) ||
    typeof payload.threadId !== "string" ||
    payload.threadId.trim().length === 0 ||
    (terminalId !== undefined &&
      (typeof terminalId !== "string" || terminalId.trim().length === 0)) ||
    typeof payload.bytes !== "number" ||
    !Number.isSafeInteger(payload.bytes) ||
    payload.bytes <= 0 ||
    payload.bytes > 8_388_608
  ) {
    return "standard";
  }
  return "terminal-ack";
}

function refillBucket(input: {
  readonly bucket: TokenBucket | undefined;
  readonly nowMs: number;
  readonly capacity: number;
  readonly refillPerMs: number;
}): TokenBucket {
  if (!input.bucket) {
    return {
      tokens: input.capacity,
      refilledAtMs: input.nowMs,
      lastSeenAtMs: input.nowMs,
    };
  }
  const elapsedMs = Math.max(0, input.nowMs - input.bucket.refilledAtMs);
  return {
    tokens: Math.min(input.capacity, input.bucket.tokens + elapsedMs * input.refillPerMs),
    refilledAtMs: input.nowMs,
    lastSeenAtMs: input.nowMs,
  };
}

export function makeWsTransportAdmission(options: WsTransportAdmissionOptions = {}) {
  const now = options.now ?? Date.now;
  const maxConcurrentConnections = normalizePositiveInteger(
    options.maxConcurrentConnections,
    MAX_CONCURRENT_WS_CONNECTIONS,
  );
  const connectionBurstPerPeer = normalizePositiveInteger(
    options.connectionBurstPerPeer,
    MAX_WS_CONNECTIONS_PER_MINUTE_PER_PEER,
  );
  const connectionRatePerMinutePerPeer = normalizePositiveInteger(
    options.connectionRatePerMinutePerPeer,
    MAX_WS_CONNECTIONS_PER_MINUTE_PER_PEER,
  );
  const connectionPeerRateLimitEnabled = options.connectionPeerRateLimitEnabled ?? true;
  const connectionRefillPerMs = connectionRatePerMinutePerPeer / 60_000;
  const activeLeases = new Map<string, WsConnectionLease>();
  const peerBuckets = new Map<string, TokenBucket>();

  const pruneIdlePeerBuckets = (nowMs: number): void => {
    const fullyRefilledAfterMs = Math.ceil(connectionBurstPerPeer / connectionRefillPerMs);
    for (const [peer, bucket] of peerBuckets) {
      if (nowMs - bucket.lastSeenAtMs >= fullyRefilledAfterMs) peerBuckets.delete(peer);
    }
  };

  const acquireConnection = (
    remoteAddress: string | null | undefined,
  ): WsConnectionAdmissionOutcome => {
    if (activeLeases.size >= maxConcurrentConnections) {
      return { admitted: false, reason: "global-capacity", retryAfterMs: 1_000 };
    }

    const peer = normalizeWsPeerAddress(remoteAddress);
    if (connectionPeerRateLimitEnabled) {
      const nowMs = now();
      pruneIdlePeerBuckets(nowMs);
      const bucket = refillBucket({
        bucket: peerBuckets.get(peer),
        nowMs,
        capacity: connectionBurstPerPeer,
        refillPerMs: connectionRefillPerMs,
      });
      if (bucket.tokens < 1) {
        peerBuckets.set(peer, bucket);
        return {
          admitted: false,
          reason: "peer-rate",
          retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) / connectionRefillPerMs)),
        };
      }
      peerBuckets.set(peer, { ...bucket, tokens: bucket.tokens - 1 });
    }

    const lease: WsConnectionLease = { id: Crypto.randomUUID(), peer };
    activeLeases.set(lease.id, lease);
    return { admitted: true, lease };
  };

  const releaseConnection = (lease: WsConnectionLease): void => {
    activeLeases.delete(lease.id);
  };

  const snapshot = () => ({
    activeConnections: activeLeases.size,
    trackedPeers: peerBuckets.size,
  });

  return { acquireConnection, releaseConnection, snapshot } as const;
}

export function makeWsMessageAdmission(options: WsTransportAdmissionOptions = {}) {
  const now = options.now ?? Date.now;
  const standardCapacity = normalizePositiveInteger(
    options.messageBurstPerConnection,
    WS_MESSAGE_RATE_BURST,
  );
  const standardRefillPerMs =
    normalizePositiveInteger(
      options.messageRatePerSecondPerConnection,
      WS_MESSAGE_RATE_PER_SECOND,
    ) / 1_000;
  const terminalAckCapacity = normalizePositiveInteger(
    options.terminalAckMessageBurstPerConnection,
    WS_TERMINAL_ACK_MESSAGE_RATE_BURST,
  );
  const terminalAckRefillPerMs =
    normalizePositiveInteger(
      options.terminalAckMessageRatePerSecondPerConnection,
      WS_TERMINAL_ACK_MESSAGE_RATE_PER_SECOND,
    ) / 1_000;
  let standardBucket: TokenBucket | undefined;
  let terminalAckBucket: TokenBucket | undefined;

  const admitMessage = (
    messageClass: WsMessageClass = "standard",
  ): { readonly admitted: true } | { readonly admitted: false; readonly retryAfterMs: number } => {
    const nowMs = now();
    const terminalAck = messageClass === "terminal-ack";
    const capacity = terminalAck ? terminalAckCapacity : standardCapacity;
    const refillPerMs = terminalAck ? terminalAckRefillPerMs : standardRefillPerMs;
    let bucket = refillBucket({
      bucket: terminalAck ? terminalAckBucket : standardBucket,
      nowMs,
      capacity,
      refillPerMs,
    });
    if (bucket.tokens < 1) {
      if (terminalAck) terminalAckBucket = bucket;
      else standardBucket = bucket;
      return {
        admitted: false,
        retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs)),
      };
    }
    bucket = { ...bucket, tokens: bucket.tokens - 1 };
    if (terminalAck) terminalAckBucket = bucket;
    else standardBucket = bucket;
    return { admitted: true };
  };

  return { admitMessage } as const;
}
