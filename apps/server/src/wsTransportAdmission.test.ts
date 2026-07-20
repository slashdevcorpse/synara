import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  installWebSocketMessageAdmission,
  wsTransportAdmissionOptionsForServerConfig,
} from "./nodeHttpServer";
import {
  classifyWsMessage,
  makeWsMessageAdmission,
  makeWsTransportAdmission,
  normalizeWsPeerAddress,
} from "./wsTransportAdmission";

function terminalAckFrame(id: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({
    _tag: "Request",
    id,
    tag: "terminal.ackOutput",
    payload: {
      threadId: "thread-1",
      terminalId: "default",
      bytes: 4_096,
      ...payload,
    },
    headers: [],
  });
}

describe("WebSocket transport admission", () => {
  it("enforces global connection capacity and releases idempotently", () => {
    const admission = makeWsTransportAdmission({
      maxConcurrentConnections: 2,
      connectionBurstPerPeer: 10,
      connectionRatePerMinutePerPeer: 10,
    });
    const first = admission.acquireConnection("192.0.2.1");
    const second = admission.acquireConnection("192.0.2.2");
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(admission.acquireConnection("192.0.2.3")).toMatchObject({
      admitted: false,
      reason: "global-capacity",
    });

    if (!first.admitted) throw new Error("Expected first connection to be admitted");
    admission.releaseConnection(first.lease);
    admission.releaseConnection(first.lease);
    expect(admission.acquireConnection("192.0.2.3").admitted).toBe(true);
    expect(admission.snapshot()).toMatchObject({ activeConnections: 2 });
  });

  it("rate-limits normalized direct peers and refills independently", () => {
    let nowMs = 0;
    const admission = makeWsTransportAdmission({
      now: () => nowMs,
      maxConcurrentConnections: 20,
      connectionBurstPerPeer: 2,
      connectionRatePerMinutePerPeer: 2,
    });
    const first = admission.acquireConnection("::ffff:127.0.0.1");
    const second = admission.acquireConnection("127.0.0.1");
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(admission.acquireConnection("::ffff:127.0.0.1")).toMatchObject({
      admitted: false,
      reason: "peer-rate",
      retryAfterMs: 30_000,
    });
    expect(admission.acquireConnection("127.0.0.2").admitted).toBe(true);

    nowMs = 30_000;
    expect(admission.acquireConnection("127.0.0.1").admitted).toBe(true);
  });

  it("keeps publicUrl proxy traffic out of shared peer buckets while preserving the global cap", () => {
    const options = wsTransportAdmissionOptionsForServerConfig(
      { publicUrl: new URL("https://synara.example.test/") },
      {
        maxConcurrentConnections: 11,
        connectionBurstPerPeer: 2,
        connectionRatePerMinutePerPeer: 2,
      },
    );
    expect(options.connectionPeerRateLimitEnabled).toBe(false);
    const admission = makeWsTransportAdmission(options);

    // Two five-socket page loads plus one reconnect all arrive from the same
    // proxy socket address. Direct mode would reject the third connection.
    for (let index = 0; index < 11; index += 1) {
      expect(admission.acquireConnection("127.0.0.1").admitted).toBe(true);
    }
    expect(admission.snapshot()).toEqual({ activeConnections: 11, trackedPeers: 0 });
    expect(admission.acquireConnection("127.0.0.1")).toMatchObject({
      admitted: false,
      reason: "global-capacity",
    });
  });

  it("keeps peer limiting enabled when no publicUrl proxy is configured", () => {
    expect(
      wsTransportAdmissionOptionsForServerConfig({ publicUrl: undefined })
        .connectionPeerRateLimitEnabled,
    ).toBe(true);
  });

  it("bounds inbound messages with a sustained token bucket", () => {
    let nowMs = 0;
    const admission = makeWsMessageAdmission({
      now: () => nowMs,
      messageBurstPerConnection: 2,
      messageRatePerSecondPerConnection: 1,
    });
    expect(admission.admitMessage()).toEqual({ admitted: true });
    expect(admission.admitMessage()).toEqual({ admitted: true });
    expect(admission.admitMessage()).toEqual({ admitted: false, retryAfterMs: 1_000 });

    nowMs = 1_000;
    expect(admission.admitMessage()).toEqual({ admitted: true });
  });

  it("preserves the WebSocket bucket clock policy across a clock rollback", () => {
    let nowMs = 1_000;
    const admission = makeWsMessageAdmission({
      now: () => nowMs,
      messageBurstPerConnection: 1,
      messageRatePerSecondPerConnection: 1,
    });

    expect(admission.admitMessage()).toEqual({ admitted: true });
    expect(admission.admitMessage()).toEqual({ admitted: false, retryAfterMs: 1_000 });

    nowMs = 0;
    expect(admission.admitMessage()).toEqual({ admitted: false, retryAfterMs: 1_000 });
    nowMs = 500;
    expect(admission.admitMessage()).toEqual({ admitted: false, retryAfterMs: 500 });
    nowMs = 1_000;
    expect(admission.admitMessage()).toEqual({ admitted: true });
  });

  it("keeps terminal ACK admission independent and strictly bounded", () => {
    const admission = makeWsMessageAdmission({
      now: () => 0,
      messageBurstPerConnection: 1,
      messageRatePerSecondPerConnection: 1,
      terminalAckMessageBurstPerConnection: 1,
      terminalAckMessageRatePerSecondPerConnection: 1,
    });
    expect(admission.admitMessage("terminal-ack")).toEqual({ admitted: true });
    expect(admission.admitMessage("terminal-ack")).toEqual({
      admitted: false,
      retryAfterMs: 1_000,
    });
    expect(admission.admitMessage("standard")).toEqual({ admitted: true });
    expect(admission.admitMessage("standard")).toEqual({
      admitted: false,
      retryAfterMs: 1_000,
    });
  });

  it("recognizes only exact, bounded text terminal ACK request frames", () => {
    const valid = terminalAckFrame("ack-1");
    const validFrame = JSON.parse(valid) as Record<string, unknown>;
    expect(classifyWsMessage(Buffer.from(valid), false)).toBe("terminal-ack");
    expect(
      classifyWsMessage(
        JSON.stringify({
          ...validFrame,
          headers: [["traceparent", "00-example"]],
          traceId: "trace-1",
          spanId: "span-1",
          sampled: true,
        }),
        false,
      ),
    ).toBe("terminal-ack");
    expect(classifyWsMessage(Buffer.from(valid), true)).toBe("standard");
    expect(classifyWsMessage(JSON.stringify([JSON.parse(valid)]), false)).toBe("standard");
    expect(
      classifyWsMessage(JSON.stringify({ ...validFrame, headers: [["invalid"]] }), false),
    ).toBe("standard");
    expect(classifyWsMessage(terminalAckFrame("ack-2", { extra: true }), false)).toBe("standard");
    expect(classifyWsMessage(terminalAckFrame("ack-3", { bytes: 0 }), false)).toBe("standard");
    expect(
      classifyWsMessage(terminalAckFrame("ack-4", { terminalId: "t".repeat(128) }), false),
    ).toBe("terminal-ack");
    expect(
      classifyWsMessage(terminalAckFrame("ack-5", { terminalId: "t".repeat(129) }), false),
    ).toBe("standard");
    expect(classifyWsMessage(`${valid}${" ".repeat(4 * 1024)}`, false)).toBe("standard");
  });

  it("admits sustained 16ms terminal ACK batches without opening the standard lane", () => {
    let nowMs = 0;
    const emitter = new EventEmitter();
    const processed: string[] = [];
    const closes: Array<{ readonly code: number; readonly reason: string }> = [];
    const webSocket = Object.assign(emitter, {
      readyState: 1,
      close: (code: number, reason: string) => {
        closes.push({ code, reason });
        webSocket.readyState = 2;
      },
    });
    emitter.on("message", (data) => processed.push(String(data)));

    installWebSocketMessageAdmission(webSocket as never, {
      now: () => nowMs,
      messageBurstPerConnection: 1,
      messageRatePerSecondPerConnection: 1,
      terminalAckMessageBurstPerConnection: 2,
      terminalAckMessageRatePerSecondPerConnection: 65,
    });
    for (let index = 0; index < 1_000; index += 1) {
      nowMs = index * 16;
      webSocket.emit("message", Buffer.from(terminalAckFrame(String(index))), false);
    }
    expect(processed).toHaveLength(1_000);
    expect(closes).toEqual([]);

    // An ambiguous lookalike with an extra payload field stays on the normal
    // lane and cannot borrow terminal ACK capacity.
    const lookalike = Buffer.from(terminalAckFrame("lookalike", { extra: true }));
    webSocket.emit("message", lookalike, false);
    webSocket.emit("message", lookalike, false);
    expect(processed).toHaveLength(1_001);
    expect(closes).toEqual([{ code: 1013, reason: "WebSocket message rate exceeded" }]);
  });

  it("swallows the first over-limit frame before application listeners can process it", () => {
    const emitter = new EventEmitter();
    const processed: string[] = [];
    const closes: Array<{ readonly code: number; readonly reason: string }> = [];
    const webSocket = Object.assign(emitter, {
      readyState: 1,
      close: (code: number, reason: string) => {
        closes.push({ code, reason });
        webSocket.readyState = 2;
      },
    });
    emitter.on("message", (data) => processed.push(String(data)));

    installWebSocketMessageAdmission(webSocket as never, {
      now: () => 0,
      messageBurstPerConnection: 1,
      messageRatePerSecondPerConnection: 1,
    });
    webSocket.emit("message", "accepted");
    webSocket.emit("message", "must-not-dispatch");

    expect(processed).toEqual(["accepted"]);
    expect(closes).toEqual([{ code: 1013, reason: "WebSocket message rate exceeded" }]);
  });

  it("normalizes IPv4-mapped peers without trusting forwarded headers", () => {
    expect(normalizeWsPeerAddress("::ffff:203.0.113.8")).toBe("203.0.113.8");
    expect(normalizeWsPeerAddress("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeWsPeerAddress(undefined)).toBe("unknown");
  });
});
