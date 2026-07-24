import http from "node:http";
import { Socket, type ListenOptions } from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Scope } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ServeError } from "effect/unstable/http/HttpServerError";
import { WebSocket, WebSocketServer } from "ws";

import type { ServerConfigShape } from "./config";
import { isLoopbackHost } from "./startupAccess";
import {
  classifyWsMessage,
  makeWsMessageAdmission,
  makeWsTransportAdmission,
  type WsTransportAdmissionOptions,
} from "./wsTransportAdmission";

export const MAX_WEBSOCKET_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * Private desktop renderer traffic shares one loopback peer identity while
 * bootstrap and feature sockets reconnect together, so its pre-auth peer
 * bucket is disabled while the global connection cap, origin/auth checks, and
 * per-connection message limits remain in force. Public URL proxy mode
 * preserves its existing shared-peer handling. Every direct web or non-loopback
 * deployment retains peer throttling, and no forwarded request header is
 * consulted.
 */
export function wsTransportAdmissionOptionsForServerConfig(
  config: Pick<ServerConfigShape, "publicUrl"> & Partial<Pick<ServerConfigShape, "mode" | "host">>,
  overrides: WsTransportAdmissionOptions = {},
): WsTransportAdmissionOptions {
  const isPrivateDesktopLoopback =
    config.mode === "desktop" && config.publicUrl === undefined && isLoopbackHost(config.host);
  return {
    ...overrides,
    connectionPeerRateLimitEnabled: config.publicUrl === undefined && !isPrivateDesktopLoopback,
  };
}

export function installWebSocketMessageAdmission(
  webSocket: WebSocket,
  admissionOptions: WsTransportAdmissionOptions,
): void {
  const messageAdmission = makeWsMessageAdmission(admissionOptions);
  const originalEmit = webSocket.emit;
  webSocket.emit = function admittedEmit(
    this: WebSocket,
    eventName: string | symbol,
    ...args: ReadonlyArray<unknown>
  ) {
    if (eventName === "message" || eventName === "ping") {
      const messageClass =
        eventName === "message" ? classifyWsMessage(args[0], args[1]) : "standard";
      const outcome = messageAdmission.admitMessage(messageClass);
      if (!outcome.admitted) {
        if (this.readyState < WebSocket.CLOSING) {
          this.close(1013, "WebSocket message rate exceeded");
        }
        return false;
      }
    }
    return Reflect.apply(originalEmit, this, [eventName, ...args]);
  } as WebSocket["emit"];
}

/**
 * Owns the Node HTTP/WebSocket transport so Synara, rather than the platform
 * adapter's 100 MiB default, controls admission before a message is decoded.
 */
export const makeBoundedNodeHttpServer = Effect.fnUntraced(function* (
  evaluate: () => http.Server,
  options: ListenOptions,
  admissionOptions: WsTransportAdmissionOptions = {},
) {
  const scope = yield* Effect.scope;
  const server = evaluate();

  yield* Scope.addFinalizer(
    scope,
    Effect.callback<void>((resume) => {
      if (!server.listening) {
        resume(Effect.void);
        return;
      }
      server.close((error) => {
        if (error) resume(Effect.die(error));
        else resume(Effect.void);
      });
    }),
  );

  yield* Effect.callback<void, ServeError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new ServeError({ cause })));
    server.on("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
  });

  const address = server.address()!;
  const webSocketServer = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const webSocketServer = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
        perMessageDeflate: false,
      });
      const originalHandleUpgrade = webSocketServer.handleUpgrade.bind(webSocketServer);
      webSocketServer.handleUpgrade = (request, socket, head, callback) =>
        originalHandleUpgrade(request, socket, head, (webSocket, upgradeRequest) => {
          installWebSocketMessageAdmission(webSocket, admissionOptions);
          callback(webSocket, upgradeRequest);
        });
      return webSocketServer;
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Scope.provide(scope));
  const transportAdmission = makeWsTransportAdmission(admissionOptions);

  return HttpServer.make({
    address:
      typeof address === "string"
        ? { _tag: "UnixAddress", path: address }
        : {
            _tag: "TcpAddress",
            hostname: address.address === "::" ? "0.0.0.0" : address.address,
            port: address.port,
          },
    serve: Effect.fnUntraced(function* (httpApp, middleware) {
      const serveScope = yield* Effect.scope;
      const handler = yield* NodeHttpServer.makeHandler(httpApp, {
        middleware: middleware as any,
        scope: serveScope,
      }) as Effect.Effect<
        (nodeRequest: http.IncomingMessage, nodeResponse: http.ServerResponse) => void
      >;
      const upgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(
        Effect.succeed(webSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );

      const admittedUpgradeHandler: typeof upgradeHandler = (request, socket, head) => {
        const outcome = transportAdmission.acquireConnection(
          socket instanceof Socket ? socket.remoteAddress : undefined,
        );
        if (!outcome.admitted) {
          const retryAfterSeconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1_000));
          const body = "Too Many WebSocket Connections";
          socket.end(
            `HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nCache-Control: no-store\r\nRetry-After: ${retryAfterSeconds}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
          return;
        }

        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          transportAdmission.releaseConnection(outcome.lease);
        };
        socket.once("close", release);
        socket.once("error", release);
        upgradeHandler(request, socket, head);
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.off("request", handler);
          server.off("upgrade", admittedUpgradeHandler);
        }),
      );
      server.on("request", handler);
      server.on("upgrade", admittedUpgradeHandler);
    }),
  });
});
