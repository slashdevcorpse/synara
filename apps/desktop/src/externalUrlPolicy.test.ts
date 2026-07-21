// FILE: externalUrlPolicy.test.ts
// Purpose: Prevents external-shell disclosure of internal local-preview capabilities.
// Layer: Desktop test
// Depends on: Vitest and the pure external URL policy

import { describe, expect, it } from "vitest";

import { getSafeExternalUrl } from "./externalUrlPolicy";

describe("getSafeExternalUrl", () => {
  it("keeps ordinary HTTP(S), including non-preview loopback pages", () => {
    expect(getSafeExternalUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(getSafeExternalUrl("http://127.0.0.1:5173/dashboard")).toBe(
      "http://127.0.0.1:5173/dashboard",
    );
  });

  it("rejects the reserved local-preview route on every hostname", () => {
    const blockedUrls = [
      "http://127.0.0.1:58090/api/local-preview/token/index.html",
      "http://127.0.0.2:58090/api/local-preview/token/index.html",
      "http://localhost.:58090/api/local-preview/token/index.html",
      "http://preview.localhost:58090/api/local-preview/token/index.html",
      "http://[::1]:58090/api/local-preview/token/index.html",
      "http://[::ffff:127.0.0.1]:58090/api/local-preview/token/index.html",
      "http://0.0.0.0:58090/api/local-preview/token/index.html",
      "http://user@127.0.0.1:58090/api/local-preview/token/index.html",
      "https://localhost:58090/api/local-preview",
      "https://example.com/api/local-preview/public-demo",
    ];

    for (const url of blockedUrls) {
      expect(getSafeExternalUrl(url)).toBeNull();
    }
  });

  it("rejects malformed values and non-web schemes", () => {
    expect(getSafeExternalUrl(null)).toBeNull();
    expect(getSafeExternalUrl("not a URL")).toBeNull();
    expect(getSafeExternalUrl("file:///C:/work/index.html")).toBeNull();
    expect(getSafeExternalUrl("synara://browser")).toBeNull();
  });
});
