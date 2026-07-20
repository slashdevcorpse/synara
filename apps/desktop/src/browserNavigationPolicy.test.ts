import { describe, expect, it } from "vitest";

import {
  isAllowedBrowserNavigation,
  isLocalPreviewRouteUrl,
  isLoopbackLocalPreviewRouteUrl,
  parseLocalPreviewCapabilityUrl,
  resolveManagedBrowserNavigation,
} from "./browserNavigationPolicy";

const PREVIEW_URL = "http://127.0.0.1:58090/api/local-preview/grant_token-123/index.html";

describe("isLoopbackLocalPreviewRouteUrl", () => {
  it("recognizes route candidates across loopback aliases without matching ordinary pages", () => {
    const routeCandidates = [
      PREVIEW_URL,
      "http://localhost.:58090/api/local-preview/token/index.html",
      "http://preview.localhost:58090/api/local-preview/token/index.html",
      "http://127.0.0.2:58090/api/local-preview/token/index.html",
      "http://[::ffff:127.0.0.1]:58090/api/local-preview/token/index.html",
      "https://[::1]:58090/api/local-preview",
    ];
    for (const url of routeCandidates) {
      expect(isLoopbackLocalPreviewRouteUrl(url)).toBe(true);
    }

    expect(isLoopbackLocalPreviewRouteUrl("http://127.0.0.1:58090/ordinary-page")).toBe(false);
    expect(
      isLoopbackLocalPreviewRouteUrl("https://example.com/api/local-preview/token/index.html"),
    ).toBe(false);
  });
});

describe("isLocalPreviewRouteUrl", () => {
  it("reserves the internal route on every hostname", () => {
    expect(isLocalPreviewRouteUrl(PREVIEW_URL)).toBe(true);
    expect(isLocalPreviewRouteUrl("http://0.0.0.0:58090/api/local-preview/token/index.html")).toBe(
      true,
    );
    expect(isLocalPreviewRouteUrl("https://example.com/api/local-preview/token/index.html")).toBe(
      true,
    );
    expect(isLocalPreviewRouteUrl("https://example.com/ordinary-page")).toBe(false);
  });
});

describe("parseLocalPreviewCapabilityUrl", () => {
  it("parses an exact loopback preview capability", () => {
    expect(parseLocalPreviewCapabilityUrl(PREVIEW_URL)).toEqual({
      origin: "http://127.0.0.1:58090",
      pathPrefix: "/api/local-preview/grant_token-123",
      token: "grant_token-123",
    });
  });

  it("accepts localhost and IPv6 loopback origins", () => {
    expect(
      parseLocalPreviewCapabilityUrl("http://localhost:58090/api/local-preview/token_1"),
    ).not.toBeNull();
    expect(
      parseLocalPreviewCapabilityUrl("http://[::1]:58090/api/local-preview/token_1"),
    ).not.toBeNull();
  });

  it("rejects arbitrary loopback pages, remote preview routes, credentials, and invalid tokens", () => {
    expect(parseLocalPreviewCapabilityUrl("http://127.0.0.1:58090/index.html")).toBeNull();
    expect(
      parseLocalPreviewCapabilityUrl("https://example.com/api/local-preview/token_1"),
    ).toBeNull();
    expect(
      parseLocalPreviewCapabilityUrl("http://user@127.0.0.1:58090/api/local-preview/token_1"),
    ).toBeNull();
    expect(
      parseLocalPreviewCapabilityUrl("http://127.0.0.1:58090/api/local-preview/%2Fescape"),
    ).toBeNull();
  });
});

describe("isAllowedBrowserNavigation", () => {
  it("allows ordinary HTTP, HTTPS, and about:blank navigation", () => {
    expect(isAllowedBrowserNavigation({ url: "https://example.com/path" })).toBe(true);
    expect(isAllowedBrowserNavigation({ url: "http://localhost:5173/" })).toBe(true);
    expect(isAllowedBrowserNavigation({ url: "about:blank" })).toBe(true);
  });

  it("denies username and password credentials on ordinary HTTP(S) navigation", () => {
    expect(isAllowedBrowserNavigation({ url: "https://user@example.com/private" })).toBe(false);
    expect(isAllowedBrowserNavigation({ url: "http://user:password@localhost:5173/private" })).toBe(
      false,
    );
  });

  it("denies raw file URLs, custom schemes, malformed URLs, and unmarked capability routes", () => {
    expect(isAllowedBrowserNavigation({ url: "file:///C:/work/index.html" })).toBe(false);
    expect(isAllowedBrowserNavigation({ url: "synara://browser" })).toBe(false);
    expect(isAllowedBrowserNavigation({ url: "about:srcdoc" })).toBe(false);
    expect(isAllowedBrowserNavigation({ url: "not a url" })).toBe(false);
    expect(isAllowedBrowserNavigation({ url: "http://127.0.0.1:58090/api/local-preview" })).toBe(
      false,
    );
    expect(isAllowedBrowserNavigation({ url: PREVIEW_URL })).toBe(false);
    expect(
      isAllowedBrowserNavigation({
        url: "http://0.0.0.0:58090/api/local-preview/grant_token-123/index.html",
      }),
    ).toBe(false);
    expect(
      isAllowedBrowserNavigation({
        url: "https://example.com/api/local-preview/grant_token-123/index.html",
      }),
    ).toBe(false);
  });

  it("keeps a local tab inside its exact origin and capability token", () => {
    const capability = parseLocalPreviewCapabilityUrl(PREVIEW_URL);
    expect(capability).not.toBeNull();

    expect(
      isAllowedBrowserNavigation({ url: PREVIEW_URL, localPreviewCapability: capability }),
    ).toBe(true);
    expect(
      isAllowedBrowserNavigation({
        url: new URL("assets/site.css", PREVIEW_URL).toString(),
        localPreviewCapability: capability,
      }),
    ).toBe(true);
    expect(
      isAllowedBrowserNavigation({
        url: `${PREVIEW_URL}?theme=dark#content`,
        localPreviewCapability: capability,
      }),
    ).toBe(true);
  });

  it("denies sibling tokens, prefix collisions, different origins, and external URLs", () => {
    const capability = parseLocalPreviewCapabilityUrl(PREVIEW_URL);
    expect(capability).not.toBeNull();

    const deniedUrls = [
      "http://127.0.0.1:58090/api/local-preview/other-token/index.html",
      "http://127.0.0.1:58090/api/local-preview/grant_token-1234/index.html",
      "http://localhost:58090/api/local-preview/grant_token-123/index.html",
      "http://127.0.0.1:58091/api/local-preview/grant_token-123/index.html",
      "https://example.com/",
      "about:blank",
    ];
    for (const url of deniedUrls) {
      expect(isAllowedBrowserNavigation({ url, localPreviewCapability: capability })).toBe(false);
    }
  });
});

describe("resolveManagedBrowserNavigation", () => {
  it("normalizes ordinary browser commands without local metadata", () => {
    expect(resolveManagedBrowserNavigation({ url: "example.com" })).toEqual({
      localFilePath: null,
      localPreviewCapability: null,
      url: "https://example.com/",
    });
  });

  it("rejects ordinary browser commands containing URL credentials", () => {
    expect(() =>
      resolveManagedBrowserNavigation({ url: "https://user@example.com/private" }),
    ).toThrow("This browser URL is not allowed.");
    expect(() =>
      resolveManagedBrowserNavigation({ url: "http://user:password@localhost:5173/private" }),
    ).toThrow("This browser URL is not allowed.");
  });

  it("accepts a trusted capability only when paired with a display path", () => {
    expect(
      resolveManagedBrowserNavigation({
        url: PREVIEW_URL,
        localFilePath: " C:\\work tree\\index.html ",
      }),
    ).toEqual({
      localFilePath: "C:\\work tree\\index.html",
      localPreviewCapability: {
        origin: "http://127.0.0.1:58090",
        pathPrefix: "/api/local-preview/grant_token-123",
        token: "grant_token-123",
      },
      url: PREVIEW_URL,
    });
  });

  it("rejects unpaired capabilities, fake metadata, and raw local inputs", () => {
    expect(() => resolveManagedBrowserNavigation({ url: PREVIEW_URL })).toThrow(
      "This browser URL is not allowed.",
    );
    expect(() =>
      resolveManagedBrowserNavigation({
        url: "https://example.com/",
        localFilePath: "C:\\work\\index.html",
      }),
    ).toThrow("Local files require a trusted preview capability URL.");
    expect(() => resolveManagedBrowserNavigation({ url: "file:///C:/work/index.html" })).toThrow(
      "Local files require an authorized preview capability.",
    );
    expect(() => resolveManagedBrowserNavigation({ url: "C:\\work\\index.html" })).toThrow(
      "Local files require an authorized preview capability.",
    );
  });

  it("requires paired metadata to be an absolute non-network local path", () => {
    const invalidDisplayPaths = [
      "relative/index.html",
      "file:///C:/work/index.html",
      String.raw`\\server\share\index.html`,
      String.raw`\\?\C:\work\index.html`,
      String.raw`\Windows\System32\drivers\etc\hosts`,
      "C:\\bad\0name.html",
    ];

    for (const localFilePath of invalidDisplayPaths) {
      expect(() =>
        resolveManagedBrowserNavigation({
          url: PREVIEW_URL,
          localFilePath,
        }),
      ).toThrow("Local preview metadata must be an absolute local file path.");
    }
  });
});
