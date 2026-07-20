// Integration test for the production /api/local-image Effect-based route.
// Boots the same `localImageEffectRouteLayer` that `makeEffectHttpRouteLayer` wires
// into `effectServer.ts` and exercises it through a real HTTP listener.
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { DateTime, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { AuthError, ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "./config";
import { attachmentsEffectRouteLayer, localImageEffectRouteLayer } from "./http";
import { LOCAL_PREVIEW_GRANT_TTL_MS, createLocalPreviewGrant } from "./localImageFiles";
import { ManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeServerConfig(overrides: Partial<ServerConfigShape> = {}): ServerConfigShape {
  const baseDir = makeTempDir("synara-effect-route-");
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: baseDir,
    homeDir: os.homedir(),
    chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir: os.homedir() }),
    studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir: os.homedir() }),
    baseDir,
    keybindingsConfigPath: path.join(baseDir, "keybindings.json"),
    serverRuntimeStatePath: path.join(baseDir, "runtime.json"),
    serverSettingsPath: path.join(baseDir, "settings.json"),
    attachmentsDir: path.join(baseDir, "attachments"),
    sqlitePath: path.join(baseDir, "state.sqlite"),
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  } as ServerConfigShape;
}

function makeFakeServerAuth(options: { rejectHttpAuthentication?: boolean } = {}): ServerAuthShape {
  const expiresAt = Effect.runSync(DateTime.now);
  const descriptor = {
    policy: "loopback-browser" as const,
    bootstrapMethods: ["one-time-token" as const],
    sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
    sessionCookieName: "synara_session",
  };
  const session = {
    sessionId: "session-id" as never,
    subject: "owner",
    method: "browser-session-cookie" as const,
    role: "owner" as const,
    expiresAt,
  };
  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState: () => Effect.succeed({ authenticated: false, auth: descriptor }),
    exchangeBootstrapCredential: () =>
      Effect.succeed({
        response: {
          authenticated: true,
          role: "client" as const,
          sessionMethod: "browser-session-cookie" as const,
          expiresAt,
        },
        sessionToken: "session-token",
      }),
    exchangeBootstrapCredentialForBearerSession: () =>
      Effect.succeed({
        authenticated: true,
        role: "client" as const,
        sessionMethod: "bearer-session-token" as const,
        expiresAt,
        sessionToken: "bearer-session-token",
      }),
    issuePairingCredential: () =>
      Effect.succeed({ id: "pairing-id", credential: "PAIRINGTOKEN", expiresAt }),
    listPairingLinks: () => Effect.succeed([]),
    revokePairingLink: () => Effect.succeed(true),
    listClientSessions: () => Effect.succeed([]),
    revokeClientSession: () => Effect.succeed(true),
    revokeOtherClientSessions: () => Effect.succeed(1),
    logoutSession: () => Effect.succeed(true),
    authenticateHttpRequest: () =>
      options.rejectHttpAuthentication === true
        ? Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }))
        : Effect.succeed({ ...session, credentialSource: "cookie" }),
    authenticateWebSocketUpgrade: () => Effect.succeed(session),
    issueWebSocketToken: () => Effect.succeed({ token: "ws-token", expiresAt }),
    issueStartupPairingUrl: () => Effect.succeed("http://127.0.0.1:3773/pair#token=PAIRINGTOKEN"),
  } satisfies ServerAuthShape;
}

async function withEffectServer(
  config: ServerConfigShape,
  routeLayer: typeof localImageEffectRouteLayer | typeof attachmentsEffectRouteLayer,
  run: (origin: string) => Promise<void>,
  serverAuth: ServerAuthShape = makeFakeServerAuth(),
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
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
          const httpApp = yield* routeLayer === localImageEffectRouteLayer
            ? HttpRouter.toHttpEffect(localImageEffectRouteLayer)
            : HttpRouter.toHttpEffect(attachmentsEffectRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, config),
              Layer.succeed(ServerAuth, serverAuth),
              ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
              NodeHttpServer.layerHttpServices,
            ),
          ),
        ),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected effect server to expose an address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    await run(origin);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

async function requestRawPath(
  origin: string,
  requestPath: string,
): Promise<{ readonly status: number; readonly headers: http.IncomingHttpHeaders }> {
  const url = new URL(origin);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: "GET",
        path: requestPath,
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

describe("localImageEffectRouteLayer", () => {
  it("serves an allowlisted workspace image and signals downloads via Content-Disposition", async () => {
    const workspace = makeTempDir("synara-effect-image-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const imagePath = path.join(workspace, "hero.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: imagePath, cwd: workspace });
      const previewResponse = await fetch(`${origin}/api/local-image?${params}`);
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get("content-type")).toContain("image/png");
      expect(previewResponse.headers.get("content-disposition")).toBeNull();

      params.set("download", "1");
      const downloadResponse = await fetch(`${origin}/api/local-image?${params}`);
      expect(downloadResponse.status).toBe(200);
      expect(downloadResponse.headers.get("content-disposition")).toContain("hero.png");
    });
  });

  it("serves an absolute local image outside the workspace for file-panel previews", async () => {
    const workspace = makeTempDir("synara-effect-image-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const externalRoot = makeTempDir("synara-effect-external-preview-");
    const imagePath = path.join(externalRoot, "downloads-file.pdf");
    writeFileSync(imagePath, Buffer.from("%PDF-1.7"));
    const config = makeServerConfig({ cwd: workspace });

    const grant = await createLocalPreviewGrant({ requestedPath: imagePath });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: imagePath, cwd: workspace, grant: grant.grant });
      const response = await fetch(`${origin}/api/local-image?${params}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/pdf");

      params.delete("grant");
      const ungrantedResponse = await fetch(`${origin}/api/local-image?${params}`);
      expect(ungrantedResponse.status).toBe(404);
    });
  });

  it("serves an allowlisted workspace PDF and only allows the desktop app origin to read it", async () => {
    const workspace = makeTempDir("synara-effect-pdf-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "spec.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: pdfPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`, {
        headers: { Origin: "synara://app" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/pdf");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      // The in-app viewer fetches bytes cross-origin, but only trusted app
      // origins should get a CORS-readable response.
      expect(response.headers.get("access-control-allow-origin")).toBe("synara://app");
      expect(response.headers.get("vary")).toBe("Origin");
      // Streamed responses must still advertise their size so the browser's
      // PDF viewer can show load progress.
      expect(response.headers.get("content-length")).toBe("8");
      await expect(response.arrayBuffer()).resolves.toHaveProperty("byteLength", 8);
      // No Content-Disposition: the browser must render the PDF inline in the
      // preview iframe rather than trigger a download.
      expect(response.headers.get("content-disposition")).toBeNull();
    });
  });

  it("allows the configured Vite dev origin to read PDF bytes", async () => {
    const workspace = makeTempDir("synara-effect-pdf-dev-origin-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "spec.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    const config = makeServerConfig({
      cwd: workspace,
      devUrl: new URL("http://localhost:5173/"),
    });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: pdfPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`, {
        headers: { Origin: "http://localhost:5173" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    });
  });

  it("does not expose local preview bytes to untrusted web origins through CORS", async () => {
    const workspace = makeTempDir("synara-effect-pdf-untrusted-origin-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "spec.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: pdfPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`, {
        headers: { Origin: "https://example.test" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("vary")).toBeNull();
    });
  });

  it("returns 404 when the requested path has an unsupported extension", async () => {
    const workspace = makeTempDir("synara-effect-image-bad-ext-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const docPath = path.join(workspace, "notes.txt");
    writeFileSync(docPath, "hello");
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: docPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`);
      expect(response.status).toBe(404);
    });
  });

  it("returns 404 for missing files", async () => {
    const workspace = makeTempDir("synara-effect-image-missing-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const ghostPath = path.join(workspace, "does-not-exist.png");
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: ghostPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`);
      expect(response.status).toBe(404);
    });
  });

  it("serves a preview capability and nested assets without request authentication", async () => {
    const workspace = makeTempDir("synara-effect-directory-preview-");
    const siteDir = path.join(workspace, "site");
    const entryPath = path.join(siteDir, "index.html");
    const cssPath = path.join(siteDir, "assets", "site.css");
    const jsPath = path.join(siteDir, "assets", "app.js");
    const wasmPath = path.join(siteDir, "assets", "app.wasm");
    const imagePath = path.join(siteDir, "assets", "hero.png");
    const pdfPath = path.join(siteDir, "assets", "spec.pdf");
    mkdirSync(path.dirname(cssPath), { recursive: true });
    const entryContents = "<!doctype html><link rel=stylesheet href=assets/site.css>";
    writeFileSync(entryPath, entryContents);
    writeFileSync(cssPath, "body { color: red; }");
    writeFileSync(jsPath, "globalThis.loaded = true;");
    writeFileSync(wasmPath, Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    const grant = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "preview",
    });
    const config = makeServerConfig({ cwd: workspace, authToken: "desktop-secret" });

    await withEffectServer(
      config,
      localImageEffectRouteLayer,
      async (origin) => {
        const entryResponse = await fetch(`${origin}${grant.urlPath}`);
        expect(entryResponse.status).toBe(200);
        expect(entryResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(entryResponse.headers.get("content-length")).toBe(
          String(Buffer.byteLength(entryContents)),
        );
        expect(entryResponse.headers.get("cache-control")).toBe("no-store");
        expect(entryResponse.headers.get("x-content-type-options")).toBe("nosniff");
        expect(entryResponse.headers.get("referrer-policy")).toBe("no-referrer");
        const previewCsp = entryResponse.headers.get("content-security-policy") ?? "";
        expect(previewCsp).toContain("sandbox");
        expect(previewCsp).toContain("script-src 'none'");
        expect(previewCsp).toContain("connect-src 'none'");

        const routeRoot = grant.urlPath?.slice(0, grant.urlPath.lastIndexOf("/") + 1);
        const cssResponse = await fetch(`${origin}${routeRoot}assets/site.css`);
        const jsResponse = await fetch(`${origin}${routeRoot}assets/app.js`);
        const wasmResponse = await fetch(`${origin}${routeRoot}assets/app.wasm`);
        const imageResponse = await fetch(`${origin}${routeRoot}assets/hero.png`);
        const pdfResponse = await fetch(`${origin}${routeRoot}assets/spec.pdf`);
        expect(cssResponse.headers.get("content-type")).toBe("text/css; charset=utf-8");
        expect(jsResponse.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        expect(wasmResponse.headers.get("content-type")).toBe("application/wasm");
        expect(imageResponse.headers.get("content-type")).toBe("image/png");
        expect(pdfResponse.headers.get("content-type")).toBe("application/pdf");
      },
      makeFakeServerAuth({ rejectHttpAuthentication: true }),
    );
  });

  it("limits browser-purpose CSP access to the exact capability path", async () => {
    const workspace = makeTempDir("synara-effect-directory-browser-");
    const entryPath = path.join(workspace, "index.html");
    writeFileSync(entryPath, "<!doctype html><script src=app.js></script>");
    writeFileSync(path.join(workspace, "app.js"), "globalThis.loaded = true;");
    const grant = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "browser",
    });
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const response = await fetch(`${origin}${grant.urlPath}`);
      expect(response.status).toBe(200);
      const csp = response.headers.get("content-security-policy") ?? "";
      const capabilitySource = `${origin}${grant.urlPath?.slice(0, grant.urlPath.lastIndexOf("/") + 1)}`;
      expect(csp).toContain(`script-src 'unsafe-inline' 'wasm-unsafe-eval' ${capabilitySource}`);
      expect(csp).toContain(`connect-src ${capabilitySource}`);
      expect(csp).toContain("webrtc 'block'");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain("child-src 'none'");
      expect(csp).toContain("worker-src 'none'");
      expect(csp).not.toContain("'self'");
      expect(csp).not.toContain("ws:");
      expect(csp).not.toContain(`${origin}/api/auth`);
      expect(csp).toMatch(/(^|;)\s*sandbox allow-scripts(?:;|$)/);
      expect(csp).not.toContain("allow-same-origin");
      expect(response.headers.get("access-control-allow-origin")).toBe("null");
      expect(response.headers.get("x-dns-prefetch-control")).toBe("off");

      const scriptResponse = await fetch(
        `${origin}${grant.urlPath?.slice(0, grant.urlPath.lastIndexOf("/") + 1)}app.js`,
        { headers: { Origin: "null" } },
      );
      expect(scriptResponse.status).toBe(200);
      expect(scriptResponse.headers.get("access-control-allow-origin")).toBe("null");
    });
  });

  it("rejects wrong and expired capabilities, unsupported assets, and traversal", async () => {
    const workspace = makeTempDir("synara-effect-directory-rejections-");
    const entryPath = path.join(workspace, "index.html");
    writeFileSync(entryPath, "<!doctype html>");
    writeFileSync(path.join(workspace, "secret.js"), "globalThis.secret = true;");
    writeFileSync(path.join(workspace, "payload.bin"), Buffer.from([0, 1, 2]));
    const grant = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "preview",
    });
    const expiredGrant = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "preview",
      nowMs: Date.now() - LOCAL_PREVIEW_GRANT_TTL_MS - 1_000,
    });
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const routeRoot = grant.urlPath?.slice(0, grant.urlPath.lastIndexOf("/") + 1);
      expect((await fetch(`${origin}/api/local-preview/wrong-token/index.html`)).status).toBe(404);
      expect((await fetch(`${origin}${expiredGrant.urlPath}`)).status).toBe(404);
      expect((await fetch(`${origin}${routeRoot}payload.bin`)).status).toBe(404);

      const literalTraversal = await requestRawPath(
        origin,
        `/api/local-preview/${grant.grant}/../secret.js`,
      );
      const encodedTraversal = await requestRawPath(
        origin,
        `/api/local-preview/${grant.grant}/assets/%2e%2e/secret.js`,
      );
      const encodedBackslash = await requestRawPath(
        origin,
        `/api/local-preview/${grant.grant}/assets%5Csecret.js`,
      );
      expect(literalTraversal.status).toBe(404);
      expect(encodedTraversal.status).toBe(404);
      expect(encodedBackslash.status).toBe(404);
    });
  });

  it("preserves hardened SVG document headers under a directory capability", async () => {
    const workspace = makeTempDir("synara-effect-directory-svg-");
    const entryPath = path.join(workspace, "index.html");
    writeFileSync(entryPath, "<!doctype html>");
    writeFileSync(path.join(workspace, "graphic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const grant = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "browser",
    });
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const routeRoot = grant.urlPath?.slice(0, grant.urlPath.lastIndexOf("/") + 1);
      const response = await fetch(`${origin}${routeRoot}graphic.svg`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });

  it("rejects a symlinked asset that escapes the granted directory when supported", async () => {
    const workspace = makeTempDir("synara-effect-directory-symlink-");
    const siteDir = path.join(workspace, "site");
    const outsideDir = path.join(workspace, "site-private");
    const entryPath = path.join(siteDir, "index.html");
    const outsideScript = path.join(outsideDir, "secret.js");
    const linkedScript = path.join(siteDir, "secret.js");
    mkdirSync(siteDir);
    mkdirSync(outsideDir);
    writeFileSync(entryPath, "<!doctype html>");
    writeFileSync(outsideScript, "globalThis.secret = true;");
    try {
      symlinkSync(outsideScript, linkedScript, "file");
    } catch {
      return;
    }
    const grant = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "browser",
    });
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const routeRoot = grant.urlPath?.slice(0, grant.urlPath.lastIndexOf("/") + 1);
      expect((await fetch(`${origin}${routeRoot}secret.js`)).status).toBe(404);
    });
  });
});

describe("attachmentsEffectRouteLayer", () => {
  it("serves persisted image attachments by id without the file response helper", async () => {
    const config = makeServerConfig({ authToken: "desktop-secret" });
    mkdirSync(config.attachmentsDir, { recursive: true });
    writeFileSync(
      path.join(config.attachmentsDir, "thread-1-6ec544e7-9130-4a8b-993d-9635297d04d3.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    await withEffectServer(config, attachmentsEffectRouteLayer, async (origin) => {
      const response = await fetch(
        `${origin}/attachments/thread-1-6ec544e7-9130-4a8b-993d-9635297d04d3?token=desktop-secret`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/png");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      await expect(response.arrayBuffer()).resolves.toHaveProperty("byteLength", 4);
    });
  });
});
