// FILE: webSecurity.ts
// Purpose: Defines the security policy shared by HTTP-served and packaged desktop web shells.
// Layer: Shared runtime utility

export const WEB_DOCUMENT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: http: https:",
  "connect-src 'self' http: https: ws: wss:",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob: http: https:",
  "frame-src 'self' blob: http: https:",
  "form-action 'self'",
].join("; ");

export const WEB_DOCUMENT_SECURITY_HEADERS = {
  "Content-Security-Policy": WEB_DOCUMENT_CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
} as const;

export function applyWebDocumentSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(WEB_DOCUMENT_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
