import { describe, expect, it } from "vitest";

import {
  applyWebDocumentSecurityHeaders,
  WEB_DOCUMENT_CONTENT_SECURITY_POLICY,
  WEB_DOCUMENT_SECURITY_HEADERS,
} from "./webSecurity";

describe("web document security policy", () => {
  it("blocks executable cross-origin content while preserving required shell resources", () => {
    expect(WEB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(WEB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(WEB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(WEB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain(
      "connect-src 'self' http: https: ws: wss:",
    );
    expect(WEB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    );
    expect(WEB_DOCUMENT_CONTENT_SECURITY_POLICY).toContain("frame-src 'self' blob: http: https:");
    expect(WEB_DOCUMENT_CONTENT_SECURITY_POLICY).not.toContain("script-src 'unsafe-inline'");
  });

  it("adds the policy to an existing response without losing its body or metadata", async () => {
    const secured = applyWebDocumentSecurityHeaders(
      new Response("Synara", {
        status: 201,
        statusText: "Created",
        headers: { "Content-Type": "text/html; charset=utf-8", "X-Existing": "kept" },
      }),
    );

    expect(secured.status).toBe(201);
    expect(secured.statusText).toBe("Created");
    expect(secured.headers.get("content-security-policy")).toBe(
      WEB_DOCUMENT_SECURITY_HEADERS["Content-Security-Policy"],
    );
    expect(secured.headers.get("x-content-type-options")).toBe("nosniff");
    expect(secured.headers.get("x-existing")).toBe("kept");
    await expect(secured.text()).resolves.toBe("Synara");
  });
});
