import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@synara/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
  VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { SYNARA_CSRF_HEADER_NAME, SYNARA_CSRF_HEADER_VALUE } from "@synara/shared/authSecurity";
import { DateTime, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { AuthError, ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "./auth/Services/SessionCredentialService";
import { ServerConfig, type ServerConfigShape } from "./config";
import { ManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments";
import {
  ManagedAttachmentRepository,
  type ManagedAttachmentUsage,
} from "./persistence/Services/ManagedAttachments";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import {
  AUTH_JSON_BODY_MAX_BYTES,
  authEffectRouteLayer,
  binaryUploadEffectRouteLayer,
  makeBinaryUploadEffectRouteLayer,
} from "./http";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { makeUploadAdmission } from "./uploadAdmission";

const currentSessionId = AuthSessionId.makeUnsafe("11111111-1111-4111-8111-111111111111");
const otherSessionId = AuthSessionId.makeUnsafe("22222222-2222-4222-8222-222222222222");

function makeSessionCredentialService(): SessionCredentialServiceShape {
  return {
    cookieName: "synara_session",
  } as SessionCredentialServiceShape;
}

function makeServerAuth(sideEffects: { count: number }): ServerAuthShape {
  const expiresAt = DateTime.toUtc(Effect.runSync(DateTime.now));
  const descriptor = {
    policy: "remote-reachable" as const,
    bootstrapMethods: ["one-time-token" as const],
    sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
    sessionCookieName: "synara_session",
  };
  const mutate = <A>(value: A) =>
    Effect.sync(() => {
      sideEffects.count += 1;
      return value;
    });
  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState: () => Effect.succeed({ authenticated: false, auth: descriptor }),
    exchangeBootstrapCredential: () =>
      mutate({
        response: {
          authenticated: true,
          role: "owner",
          sessionMethod: "browser-session-cookie",
          expiresAt,
        },
        sessionToken: "cookie-token",
      }),
    exchangeBootstrapCredentialForBearerSession: () =>
      mutate({
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        expiresAt,
        sessionToken: "bearer-token",
      }),
    issuePairingCredential: () =>
      mutate({ id: "pairing-id", credential: "PAIRINGTOKEN", expiresAt }),
    listPairingLinks: () => Effect.succeed([]),
    revokePairingLink: () => mutate(true),
    listClientSessions: () => Effect.succeed([]),
    revokeClientSession: () => mutate(true),
    revokeOtherClientSessions: () => mutate(1),
    logoutSession: () => mutate(true),
    authenticateHttpRequest: (request) => {
      const bearer = request.headers.authorization === "Bearer bearer-token";
      const cookie = request.cookies.synara_session === "cookie-token";
      if (!bearer && !cookie) {
        return Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }));
      }
      return Effect.succeed({
        sessionId: currentSessionId,
        subject: "owner",
        method: bearer ? "bearer-session-token" : "browser-session-cookie",
        role: "owner",
        expiresAt,
        credentialSource: bearer ? "bearer" : "cookie",
      });
    },
    authenticateWebSocketUpgrade: () =>
      Effect.fail(new AuthError({ message: "Not used in auth route tests.", status: 401 })),
    issueWebSocketToken: () => mutate({ token: "ws-token", expiresAt }),
    issueStartupPairingUrl: () =>
      Effect.succeed("https://synara.example.test/pair#token=PAIRINGTOKEN"),
  } satisfies ServerAuthShape;
}

async function withAuthEffectServer(
  config: ServerConfigShape,
  serverAuth: ServerAuthShape,
  run: (
    origin: string,
    harness: {
      readonly getManagedAttachmentUsage: (input: {
        readonly ownerKind: string;
        readonly ownerId: string;
      }) => Promise<ManagedAttachmentUsage>;
    },
  ) => Promise<void>,
  routeLayer?: typeof binaryUploadEffectRouteLayer,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    const services = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, config),
          Layer.succeed(ServerAuth, serverAuth),
          Layer.succeed(SessionCredentialService, makeSessionCredentialService()),
          Layer.succeed(ProviderAdapterRegistry, {
            getByProvider: () => Effect.die("voice adapter not used in this test"),
            listProviders: () => Effect.succeed([]),
          }),
          ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
          NodeServices.layer,
        ),
        scope,
      ),
    );
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          if (routeLayer) {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(routeLayer));
          } else {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(authEffectRouteLayer));
          }
        }).pipe(Effect.provideServices(services)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Expected server address");
    const getManagedAttachmentUsage = (input: {
      readonly ownerKind: string;
      readonly ownerId: string;
    }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const repository = yield* ManagedAttachmentRepository;
          return yield* repository.getUsage(input);
        }).pipe(Effect.provideServices(services)),
      );
    await run(`http://127.0.0.1:${address.port}`, { getManagedAttachmentUsage });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

const mutationRoutes: ReadonlyArray<{ readonly path: string; readonly body?: unknown }> = [
  { path: "/api/auth/ws-token" },
  { path: "/api/auth/pairing-token" },
  { path: "/api/auth/pairing-links/revoke", body: { id: "pairing-id" } },
  { path: "/api/auth/clients/revoke", body: { sessionId: otherSessionId } },
  { path: "/api/auth/clients/revoke-others" },
  { path: "/api/auth/logout" },
] as const;

function mutationRequest(input: {
  readonly origin?: string;
  readonly credential: "bearer" | "cookie";
  readonly body?: unknown;
  readonly csrf?: boolean;
}): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(input.origin === undefined ? {} : { Origin: input.origin }),
      ...(input.credential === "bearer"
        ? { Authorization: "Bearer bearer-token" }
        : {
            Cookie: "synara_session=cookie-token",
            ...(input.csrf === false
              ? {}
              : { [SYNARA_CSRF_HEADER_NAME]: SYNARA_CSRF_HEADER_VALUE }),
          }),
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  };
}

describe("authEffectRouteLayer", () => {
  it("rejects declared and chunked oversized bootstrap JSON before auth exchange", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const oversizedBody = JSON.stringify({
        credential: "x".repeat(AUTH_JSON_BODY_MAX_BYTES),
      });
      const declaredResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversizedBody,
      });
      expect(declaredResponse.status).toBe(413);
      expect(sideEffects.count).toBe(0);

      const chunkedStatus = await new Promise<number>((resolve, reject) => {
        const url = new URL("/api/auth/bootstrap", serverOrigin);
        const request = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Transfer-Encoding": "chunked",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.once("error", reject);
        request.write('{"credential":"');
        request.write("x".repeat(AUTH_JSON_BODY_MAX_BYTES));
        request.end('"}');
      });
      expect(chunkedStatus).toBe(413);
      expect(sideEffects.count).toBe(0);

      const malformedResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(malformedResponse.status).toBe(400);

      const validResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      });
      expect(validResponse.status).toBe(200);
      expect(validResponse.headers.get("set-cookie")).toContain("SameSite=Strict");
      expect(sideEffects.count).toBe(1);
    });
  });

  it("advertises the CSRF header on trusted auth mutation preflights", async () => {
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth({ count: 0 }), async (serverOrigin) => {
      const response = await fetch(`${serverOrigin}/api/auth/logout`, {
        method: "OPTIONS",
        headers: {
          Origin: "synara-canary://app",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": `content-type, ${SYNARA_CSRF_HEADER_NAME}`,
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("synara-canary://app");
      expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
        SYNARA_CSRF_HEADER_NAME.toLowerCase(),
      );
    });
  });

  it("returns credentialed CORS headers to trusted custom-scheme auth callers", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const origin = "synara-canary://app";
      for (const rejectedOrigin of ["null", "not a url", "https://evil.example.test"]) {
        const rejectedBootstrapResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
          method: "POST",
          headers: { Origin: rejectedOrigin, "Content-Type": "application/json" },
          body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
        });
        expect(rejectedBootstrapResponse.status, rejectedOrigin).toBe(403);
      }
      expect(sideEffects.count).toBe(0);

      const bootstrapResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      });

      expect(bootstrapResponse.status).toBe(200);
      expect(bootstrapResponse.headers.get("access-control-allow-origin")).toBe(origin);
      expect(bootstrapResponse.headers.get("access-control-allow-credentials")).toBe("true");
      const bootstrapCookie = bootstrapResponse.headers.get("set-cookie") ?? "";
      expect(bootstrapCookie).toContain("SameSite=None");
      expect(bootstrapCookie).toContain("Secure");
      expect(bootstrapCookie).not.toContain("SameSite=Strict");

      const sessionResponse = await fetch(`${serverOrigin}/api/auth/session`, {
        headers: { Origin: origin },
      });
      expect(sessionResponse.status).toBe(200);
      expect(sessionResponse.headers.get("access-control-allow-origin")).toBe(origin);
      expect(sessionResponse.headers.get("access-control-allow-credentials")).toBe("true");

      const logoutResponse = await fetch(
        `${serverOrigin}/api/auth/logout`,
        mutationRequest({ origin, credential: "cookie" }),
      );
      expect(logoutResponse.status).toBe(200);
      const expiredCookie = logoutResponse.headers.get("set-cookie") ?? "";
      expect(expiredCookie).toContain("Max-Age=0");
      expect(expiredCookie).toContain("SameSite=None");
      expect(expiredCookie).toContain("Secure");
      expect(expiredCookie).not.toContain("SameSite=Strict");
      expect(sideEffects.count).toBe(2);
    });
  });

  it("rejects every cookie-authenticated mutation without a trusted origin", async () => {
    const sideEffects = { count: 0 };
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
    } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      for (const route of mutationRoutes) {
        for (const origin of [
          undefined,
          "null",
          "not a url",
          "https://evil.example.test",
          "https://cross-site.invalid",
        ]) {
          const response = await fetch(
            `${serverOrigin}${route.path}`,
            mutationRequest({
              ...(origin === undefined ? {} : { origin }),
              credential: "cookie",
              ...(route.body === undefined ? {} : { body: route.body }),
            }),
          );
          expect(response.status, `${route.path} with ${String(origin)}`).toBe(403);
        }
        for (const origin of [
          "null",
          "not a url",
          "https://evil.example.test",
          "https://cross-site.invalid",
        ]) {
          const response = await fetch(
            `${serverOrigin}${route.path}`,
            mutationRequest({
              origin,
              credential: "bearer",
              ...(route.body === undefined ? {} : { body: route.body }),
            }),
          );
          expect(response.status, `${route.path} bearer with ${origin}`).toBe(403);
        }
      }
      expect(sideEffects.count).toBe(0);
    });
  });

  it("allows trusted-origin cookies and originless explicit bearer credentials", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      for (const route of mutationRoutes) {
        const body = route.body === undefined ? {} : { body: route.body };
        const cookieResponse = await fetch(
          `${serverOrigin}${route.path}`,
          mutationRequest({ origin: serverOrigin, credential: "cookie", ...body }),
        );
        expect(cookieResponse.status, `${route.path} cookie`).toBe(200);

        const bearerResponse = await fetch(
          `${serverOrigin}${route.path}`,
          mutationRequest({ credential: "bearer", ...body }),
        );
        expect(bearerResponse.status, `${route.path} bearer`).toBe(200);
      }
      expect(sideEffects.count).toBe(mutationRoutes.length * 2);
    });
  });

  it("rejects a trusted-origin cookie mutation without the CSRF header", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const response = await fetch(
        `${serverOrigin}/api/auth/logout`,
        mutationRequest({
          origin: serverOrigin,
          credential: "cookie",
          csrf: false,
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "CSRF header required." });
      expect(sideEffects.count).toBe(0);
    });
  });

  it("logs out either role and clears the exact cookie with secure public-mode attributes", async () => {
    const sideEffects = { count: 0 };
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
    } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const response = await fetch(
        `${serverOrigin}/api/auth/logout`,
        mutationRequest({
          origin: "https://synara.example.test",
          credential: "cookie",
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ revoked: true });
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("synara_session=");
      expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Secure");
      expect(sideEffects.count).toBe(1);
    });
  });
});

describe("binaryUploadEffectRouteLayer", () => {
  it("allows credentialed Canary attachment upload preflights", async () => {
    const config = {
      host: "127.0.0.1",
      attachmentsDir: fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-cors-")),
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin) => {
          const response = await fetch(`${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}`, {
            method: "OPTIONS",
            headers: {
              Origin: "synara-canary://app",
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "content-type",
            },
          });

          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe("synara-canary://app");
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");
          expect(response.headers.get("access-control-allow-methods")).toContain("POST");
          expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
            "content-type",
          );
          expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
            SYNARA_CSRF_HEADER_NAME.toLowerCase(),
          );
        },
        binaryUploadEffectRouteLayer,
      );
    } finally {
      fs.rmSync(config.attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects ambient cookie uploads without an origin and accepts explicit bearer auth", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-route-"));
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
      attachmentsDir,
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin) => {
          const params = new URLSearchParams({
            type: "image",
            threadId: "thread-1",
            name: "screen.png",
            mimeType: "image/png",
          });
          const url = `${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}?${params.toString()}`;
          const trustedOrigin = "https://synara.example.test";
          const untrustedPreflightResponse = await fetch(url, {
            method: "OPTIONS",
            headers: {
              Origin: "https://evil.example.test",
              "Access-Control-Request-Method": "POST",
            },
          });
          expect(untrustedPreflightResponse.status).toBe(403);
          expect(untrustedPreflightResponse.headers.get("access-control-allow-origin")).toBeNull();

          const preflightResponse = await fetch(url, {
            method: "OPTIONS",
            headers: {
              Origin: trustedOrigin,
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": SYNARA_CSRF_HEADER_NAME,
            },
          });
          expect(preflightResponse.status).toBe(204);
          expect(preflightResponse.headers.get("access-control-allow-origin")).toBe(trustedOrigin);

          const unauthenticatedResponse = await fetch(url, {
            method: "POST",
            headers: { Origin: trustedOrigin },
            body: Uint8Array.from([1]),
          });
          expect(unauthenticatedResponse.status).toBe(401);
          expect(unauthenticatedResponse.headers.get("access-control-allow-origin")).toBe(
            trustedOrigin,
          );
          expect(unauthenticatedResponse.headers.get("access-control-allow-credentials")).toBe(
            "true",
          );

          const cookieResponse = await fetch(url, {
            method: "POST",
            headers: { Cookie: "synara_session=cookie-token" },
            body: Uint8Array.from([1]),
          });
          expect(cookieResponse.status).toBe(403);
          expect(fs.readdirSync(attachmentsDir)).toEqual([]);

          const missingCsrfResponse = await fetch(url, {
            method: "POST",
            headers: {
              Origin: trustedOrigin,
              Cookie: "synara_session=cookie-token",
            },
            body: Uint8Array.from([1]),
          });
          expect(missingCsrfResponse.status).toBe(403);
          expect(missingCsrfResponse.headers.get("access-control-allow-origin")).toBe(
            trustedOrigin,
          );
          expect(missingCsrfResponse.headers.get("access-control-allow-credentials")).toBe("true");

          const cookieWithCsrfResponse = await fetch(
            `${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}`,
            {
              method: "POST",
              headers: {
                Origin: trustedOrigin,
                Cookie: "synara_session=cookie-token",
                [SYNARA_CSRF_HEADER_NAME]: SYNARA_CSRF_HEADER_VALUE,
              },
              body: Uint8Array.from([1]),
            },
          );
          expect(cookieWithCsrfResponse.status).toBe(400);

          const oversizedStatus = await new Promise<number>((resolve, reject) => {
            const target = new URL(url);
            const request = http.request(
              {
                hostname: target.hostname,
                port: target.port,
                path: `${target.pathname}${target.search}`,
                method: "POST",
                headers: {
                  Authorization: "Bearer bearer-token",
                  "Content-Length": String(10 * 1024 * 1024 + 1),
                },
              },
              (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 0));
              },
            );
            request.once("error", reject);
            request.end();
          });
          expect(oversizedStatus).toBe(413);
          expect(fs.readdirSync(attachmentsDir)).toEqual([]);

          const bearerResponse = await fetch(url, {
            method: "POST",
            headers: { Authorization: "Bearer bearer-token" },
            body: Uint8Array.from([1]),
          });
          const bearerPayload = (await bearerResponse.json()) as {
            readonly error?: unknown;
            readonly id?: unknown;
          };
          expect(bearerResponse.status, JSON.stringify(bearerPayload)).toBe(201);
          expect(bearerPayload).toEqual(expect.objectContaining({ type: "image", sizeBytes: 1 }));
          expect(
            fs
              .readdirSync(path.join(attachmentsDir, "objects"), { recursive: true })
              .some((entry) => String(entry).endsWith(`${String(bearerPayload.id)}.png`)),
          ).toBe(true);
          expect(fs.readdirSync(path.join(attachmentsDir, ".staging"))).toEqual([]);

          const cancel = () =>
            fetch(`${serverOrigin}${ATTACHMENT_CANCEL_ROUTE_PATH}`, {
              method: "POST",
              headers: {
                Authorization: "Bearer bearer-token",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ attachmentId: bearerPayload.id }),
            });
          expect((await cancel()).status).toBe(200);
          expect((await cancel()).status).toBe(200);
        },
        binaryUploadEffectRouteLayer,
      );
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rate-limits before body, reservation, and file side effects, then refills by clock", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-rate-"));
    let nowMs = 0;
    const admission = makeUploadAdmission({
      now: () => nowMs,
      uploadsPerMinutePerPrincipal: 1,
      uploadsPerMinutePerPeer: 5,
    });
    const config = {
      host: "127.0.0.1",
      authToken: "desktop-secret",
      attachmentsDir,
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin, harness) => {
          const params = new URLSearchParams({
            type: "image",
            threadId: "thread-1",
            name: "screen.png",
            mimeType: "image/png",
          });
          const uploadUrl = `${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}?${params.toString()}`;
          const first = await fetch(uploadUrl, {
            method: "POST",
            headers: { Authorization: "Bearer bearer-token" },
            body: Uint8Array.from([1]),
          });
          expect(first.status).toBe(201);
          const firstPayload = (await first.json()) as { readonly id: string };

          const usageBefore = await harness.getManagedAttachmentUsage({
            ownerKind: "session",
            ownerId: currentSessionId,
          });
          const filesBefore = fs
            .readdirSync(attachmentsDir, { recursive: true })
            .map(String)
            .sort();
          const rejected = await fetch(uploadUrl, {
            method: "POST",
            headers: { Authorization: "Bearer bearer-token" },
            body: Uint8Array.from([9]),
          });
          expect(rejected.status).toBe(429);
          expect(rejected.headers.get("retry-after")).toBe("60");
          await expect(rejected.json()).resolves.toEqual({ error: "Upload rate limit exceeded." });
          expect(
            await harness.getManagedAttachmentUsage({
              ownerKind: "session",
              ownerId: currentSessionId,
            }),
          ).toEqual(usageBefore);
          expect(fs.readdirSync(attachmentsDir, { recursive: true }).map(String).sort()).toEqual(
            filesBefore,
          );

          const cancel = await fetch(`${serverOrigin}${ATTACHMENT_CANCEL_ROUTE_PATH}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer bearer-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ attachmentId: firstPayload.id }),
          });
          expect(cancel.status).toBe(200);

          const legacy = await fetch(`${uploadUrl}&token=desktop-secret`, {
            method: "POST",
            body: Uint8Array.from([2]),
          });
          expect(legacy.status).toBe(201);

          nowMs = 60_000;
          const refilled = await fetch(uploadUrl, {
            method: "POST",
            headers: { Authorization: "Bearer bearer-token" },
            body: Uint8Array.from([3]),
          });
          expect(refilled.status).toBe(201);
        },
        makeBinaryUploadEffectRouteLayer(admission),
      );
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("uses the normalized direct peer for legacy uploads and ignores forwarded IPs", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-peer-"));
    const admission = makeUploadAdmission({
      now: () => 0,
      uploadsPerMinutePerPrincipal: 10,
      uploadsPerMinutePerPeer: 1,
    });
    const admissionInputs: Array<{
      readonly principalKey: string;
      readonly remoteAddress: string | null | undefined;
      readonly rateLimitPeer?: boolean;
    }> = [];
    const recordingAdmission = {
      admit: (input: (typeof admissionInputs)[number]) => {
        admissionInputs.push(input);
        return admission.admit(input);
      },
      snapshot: admission.snapshot,
    };
    const config = {
      host: "127.0.0.1",
      authToken: "desktop-secret",
      attachmentsDir,
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin) => {
          const first = await fetch(`${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer bearer-token",
              "X-Forwarded-For": "198.51.100.10",
            },
          });
          expect(first.status).toBe(400);

          const legacy = await fetch(
            `${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}?token=desktop-secret`,
            {
              method: "POST",
              headers: { "X-Forwarded-For": "203.0.113.20" },
            },
          );
          const voice = await fetch(
            `${serverOrigin}${VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH}?provider=codex&cwd=C%3A%5Crepo&mimeType=audio%2Fwebm&sampleRateHz=48000&durationMs=1000`,
            {
              method: "POST",
              headers: {
                Authorization: "Bearer bearer-token",
                "X-Forwarded-For": "192.0.2.30",
              },
              body: Uint8Array.from([1]),
            },
          );
          expect(admissionInputs).toHaveLength(3);
          expect(new Set(admissionInputs.map((input) => input.remoteAddress)).size).toBe(1);
          expect(admissionInputs.map((input) => input.principalKey)).toEqual([
            `session:${currentSessionId}`,
            "local-loopback:local-loopback",
            `session:${currentSessionId}`,
          ]);
          expect(admissionInputs.map((input) => input.rateLimitPeer)).toEqual([true, true, true]);
          expect(legacy.status).toBe(429);
          expect(legacy.headers.get("retry-after")).toBe("60");
          expect(voice.status).toBe(429);
          expect(fs.readdirSync(attachmentsDir)).toEqual([]);
        },
        makeBinaryUploadEffectRouteLayer(recordingAdmission),
      );
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("isolates publicUrl session uploads from the shared proxy peer", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-proxy-"));
    const admission = makeUploadAdmission({
      now: () => 0,
      uploadsPerMinutePerPrincipal: 10,
      uploadsPerMinutePerPeer: 1,
    });
    const admissionInputs: Array<{
      readonly principalKey: string;
      readonly remoteAddress: string | null | undefined;
      readonly rateLimitPeer?: boolean;
    }> = [];
    const recordingAdmission = {
      admit: (input: (typeof admissionInputs)[number]) => {
        admissionInputs.push(input);
        return admission.admit(input);
      },
      snapshot: admission.snapshot,
    };
    const config = {
      host: "127.0.0.1",
      publicUrl: new URL("https://synara.example.test/"),
      authToken: "proxy-secret",
      attachmentsDir,
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin) => {
          const unauthenticated = await fetch(`${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}`, {
            method: "POST",
            headers: { "X-Forwarded-For": "192.0.2.1" },
          });
          expect(unauthenticated.status).toBe(401);
          expect(admissionInputs).toEqual([]);

          const authenticatedAttachment = await fetch(
            `${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}`,
            {
              method: "POST",
              headers: {
                Authorization: "Bearer bearer-token",
                "X-Forwarded-For": "198.51.100.10",
              },
            },
          );
          const authenticatedVoice = await fetch(
            `${serverOrigin}${VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH}`,
            {
              method: "POST",
              headers: {
                Authorization: "Bearer bearer-token",
                "X-Forwarded-For": "203.0.113.20",
              },
            },
          );
          expect(authenticatedAttachment.status).toBe(400);
          expect(authenticatedVoice.status).toBe(400);
          expect(admissionInputs.map((input) => input.rateLimitPeer)).toEqual([false, false]);
          expect(new Set(admissionInputs.map((input) => input.remoteAddress)).size).toBe(1);
          expect(admission.snapshot()).toMatchObject({
            trackedPrincipals: 1,
            trackedPeers: 0,
          });
          expect(fs.readdirSync(attachmentsDir)).toEqual([]);
        },
        makeBinaryUploadEffectRouteLayer(recordingAdmission),
      );
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
