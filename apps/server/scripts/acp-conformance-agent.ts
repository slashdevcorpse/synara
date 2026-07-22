#!/usr/bin/env bun
// Official-SDK ACP subprocess used only by the transport conformance suite.

import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  agent,
  methods,
  ndJsonStream,
  type AnyMessage,
  type JsonRpcId,
  type Stream,
} from "@agentclientprotocol/sdk";
import { z } from "zod";

const sessionId = "official-sdk-session-1";
const logPath = process.env.SYNARA_ACP_CONFORMANCE_LOG_PATH;
const malformedPrefix = process.env.SYNARA_ACP_CONFORMANCE_MALFORMED_PREFIX === "1";
const EOF_DRAIN_TIMEOUT_MS = 5_000;

function messageIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function withEofResponseDrain(stream: Stream): Stream {
  const pendingRequestIds = new Set<string>();
  const drainWaiters = new Set<() => void>();
  let pendingWrites = 0;

  const isDrained = (): boolean => pendingRequestIds.size === 0 && pendingWrites === 0;
  const resolveDrainWaiters = (): void => {
    if (!isDrained()) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };
  const waitForDrain = async (): Promise<void> => {
    if (isDrained()) return;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
      drainWaiters.add(resolve);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        drained,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out draining ACP fixture responses for ${String(pendingRequestIds.size)} request(s)`,
                ),
              ),
            EOF_DRAIN_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      drainWaiters.delete(resolveDrain);
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        if ("method" in message && "id" in message) {
          pendingRequestIds.add(messageIdKey(message.id));
        }
        controller.enqueue(message);
      },
      async flush() {
        try {
          await waitForDrain();
        } catch (error) {
          process.exitCode = 1;
          console.error(error);
          throw error;
        }
      },
    }),
  );
  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      pendingWrites += 1;
      const writer = stream.writable.getWriter();
      try {
        await writer.write(message);
        if (!("method" in message) && "id" in message) {
          // SDK-generated error responses carry the same id, so failed handlers drain here too.
          pendingRequestIds.delete(messageIdKey(message.id));
        }
      } finally {
        writer.releaseLock();
        pendingWrites -= 1;
        resolveDrainWaiters();
      }
    },
    async close() {
      const writer = stream.writable.getWriter();
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    },
    async abort(reason) {
      const writer = stream.writable.getWriter();
      try {
        await writer.abort(reason);
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

function log(type: string, payload: unknown): void {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ type, payload })}\n`, "utf8");
  }
}

let finishCancelledPrompt: (() => void) | undefined;

process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));

if (malformedPrefix) {
  process.stdout.write("{not-json}\n");
}

const app = agent({ name: "synara-official-sdk-conformance-agent" })
  .onRequest(methods.agent.initialize, (ctx) => {
    log("initialize", ctx.params);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [{ id: "test", name: "Test authentication" }],
      agentInfo: { name: "official-sdk-conformance-agent", version: "1.0.0" },
      _meta: {
        primitive: "initialize-meta",
        nested: { source: "official-sdk" },
      },
    };
  })
  .onRequest(methods.agent.authenticate, (ctx) => {
    log("authenticate", ctx.params);
    return {};
  })
  .onRequest(methods.agent.session.new, async (ctx) => {
    log("session/new", ctx.params);
    await ctx.client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "early-new" },
      },
    });
    return {
      sessionId,
      _meta: {
        primitive: 7,
        nested: { phase: "new" },
      },
    };
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    log("session/prompt", ctx.params);
    const shouldWaitForCancel =
      ctx.params.prompt[0]?.type === "text" && ctx.params.prompt[0].text === "wait-for-cancel";

    if (shouldWaitForCancel) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "cancel-ready" },
        },
      });
      await new Promise<void>((resolve) => {
        finishCancelledPrompt = resolve;
      });
      return { stopReason: "cancelled" };
    }

    for (const text of ["prompt-one", "prompt-two"]) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    }
    return { stopReason: "end_turn" };
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    log("session/cancel", ctx.params);
    finishCancelledPrompt?.();
    finishCancelledPrompt = undefined;
  })
  .onRequest("conformance/echo", z.unknown(), (ctx) => {
    log("conformance/echo", ctx.params);
    return {
      echo: ctx.params,
      _meta: {
        primitive: true,
        nested: { source: "official-sdk" },
      },
    };
  })
  .onRequest("conformance/delayed-eof-response", z.object({ value: z.string() }), async (ctx) => {
    log("conformance/delayed-eof-response", ctx.params);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return { echoed: ctx.params.value, complete: true };
  })
  .onNotification("conformance/notice", z.unknown(), (ctx) => {
    log("conformance/notice", ctx.params);
  })
  .onRequest("conformance/wait-for-generic-cancel", z.unknown(), async (ctx) => {
    log("conformance/wait-for-generic-cancel", ctx.params);
    await ctx.client.notify("conformance/generic-cancel-ready", {});
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) {
        resolve();
        return;
      }
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    log("conformance/generic-cancel-observed", null);
    await ctx.client.notify("conformance/generic-cancel-observed", {});
    return { cancelled: true };
  })
  .onRequest("conformance/exit", z.unknown(), () => {
    log("conformance/exit", null);
    process.exit(17);
  });

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const connection = app.connect(withEofResponseDrain(ndJsonStream(output, input)));

void connection.closed.then(() => process.exit(process.exitCode ?? 0));
