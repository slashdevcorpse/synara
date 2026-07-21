import { describe, expect, it } from "vitest";

import {
  BROWSER_SEARCH_URL_PREFIX,
  BrowserLocalInputError,
  buildAcceptLanguageHeader,
  buildChromeClientHints,
  chromeMajorVersionFromUserAgent,
  classifyBrowserInput,
  classifyBrowserWindowOpen,
  deriveChromeUserAgent,
  isLikelyOAuthHost,
  normalizeBrowserUrlInput,
  isBlankBrowserTabUrl,
  resolveCopyableBrowserTabUrl,
} from "./browserSession";

const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Synara/0.3.1 Chrome/124.0.6367.91 Electron/30.0.1 Safari/537.36";

describe("deriveChromeUserAgent", () => {
  it("strips Electron and app product tokens to leave a vanilla Chrome UA", () => {
    expect(deriveChromeUserAgent(ELECTRON_UA, ["Synara"])).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.91 Safari/537.36",
    );
  });

  it("preserves the platform and Chrome version from the base UA", () => {
    const derived = deriveChromeUserAgent(ELECTRON_UA, ["Synara"]);
    expect(derived).toContain("Chrome/124.0.6367.91");
    expect(derived).not.toMatch(/Electron/i);
    expect(derived).not.toMatch(/Synara/i);
  });
});

describe("chromeMajorVersionFromUserAgent", () => {
  it("extracts the Chrome major version", () => {
    expect(chromeMajorVersionFromUserAgent(ELECTRON_UA)).toBe("124");
  });

  it("returns null when no Chrome token is present", () => {
    expect(chromeMajorVersionFromUserAgent("Mozilla/5.0 (X11; Linux)")).toBeNull();
  });
});

describe("buildChromeClientHints", () => {
  it("builds a Chrome-matching sec-ch-ua brand list per platform", () => {
    const derived = deriveChromeUserAgent(ELECTRON_UA, ["Synara"]);
    expect(buildChromeClientHints(derived, "darwin")).toEqual({
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not=A?Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    });
    expect(buildChromeClientHints(derived, "win32")?.["sec-ch-ua-platform"]).toBe('"Windows"');
    expect(buildChromeClientHints(derived, "linux")?.["sec-ch-ua-platform"]).toBe('"Linux"');
  });

  it("returns null when the Chrome version can't be parsed", () => {
    expect(buildChromeClientHints("Mozilla/5.0", "darwin")).toBeNull();
  });
});

describe("buildAcceptLanguageHeader", () => {
  it("builds a Chrome-style weighted language list", () => {
    expect(buildAcceptLanguageHeader(["en-US", "en", "it"])).toBe("en-US,en;q=0.9,it;q=0.8");
  });

  it("returns null for an empty list", () => {
    expect(buildAcceptLanguageHeader([])).toBeNull();
  });
});

describe("classifyBrowserInput", () => {
  it("classifies blank, explicit web, about, domain, local-host, and search inputs", () => {
    expect(classifyBrowserInput(undefined)).toEqual({ kind: "web-url", url: "about:blank" });
    expect(classifyBrowserInput("https://example.com/path")).toEqual({
      kind: "web-url",
      url: "https://example.com/path",
    });
    expect(classifyBrowserInput("about:blank")).toEqual({
      kind: "web-url",
      url: "about:blank",
    });
    expect(classifyBrowserInput("phodex.app")).toEqual({
      kind: "web-url",
      url: "https://phodex.app/",
    });
    expect(classifyBrowserInput("localhost:5173")).toEqual({
      kind: "web-url",
      url: "http://localhost:5173/",
    });
    expect(classifyBrowserInput("how to bake bread")).toEqual({
      kind: "search",
      query: "how to bake bread",
      url: `${BROWSER_SEARCH_URL_PREFIX}how%20to%20bake%20bread`,
    });
  });

  it("recognizes Windows drive paths in both slash styles, including spaces", () => {
    expect(classifyBrowserInput("C:\\work tree\\preview page.html")).toEqual({
      kind: "local-file",
      path: "C:\\work tree\\preview page.html",
      source: "path",
    });
    expect(classifyBrowserInput("d:/work tree/preview page.html")).toEqual({
      kind: "local-file",
      path: "d:/work tree/preview page.html",
      source: "path",
    });
  });

  it("recognizes POSIX absolute paths", () => {
    expect(classifyBrowserInput("/Users/test/work tree/index.html")).toEqual({
      kind: "local-file",
      path: "/Users/test/work tree/index.html",
      source: "path",
    });
  });

  it("decodes local Windows and POSIX file URLs", () => {
    expect(classifyBrowserInput("file:///C:/work%20tree/index.html")).toEqual({
      kind: "local-file",
      path: "C:/work tree/index.html",
      source: "file-url",
    });
    expect(classifyBrowserInput("file://localhost/Users/test/index.html")).toEqual({
      kind: "local-file",
      path: "/Users/test/index.html",
      source: "file-url",
    });
  });

  it("rejects UNC paths and non-local file URL hosts", () => {
    for (const input of [
      "\\\\server\\share\\index.html",
      "//server/share/index.html",
      String.raw`/\server\share\index.html`,
      String.raw`\/server/share/index.html`,
    ]) {
      expect(classifyBrowserInput(input)).toEqual({
        kind: "rejected-local",
        input,
        reason: "network-path",
      });
    }
    expect(classifyBrowserInput("file://server/share/index.html")).toEqual({
      kind: "rejected-local",
      input: "file://server/share/index.html",
      reason: "network-file-url",
    });
  });

  it("rejects Windows device and root-relative candidates instead of searching", () => {
    expect(classifyBrowserInput(String.raw`\\?\C:\work\index.html`)).toMatchObject({
      kind: "rejected-local",
    });
    expect(classifyBrowserInput(String.raw`\\.\C:\work\index.html`)).toMatchObject({
      kind: "rejected-local",
    });
    expect(classifyBrowserInput(String.raw`\??\C:\work\index.html`)).toEqual({
      kind: "rejected-local",
      input: String.raw`\??\C:\work\index.html`,
      reason: "malformed-windows-path",
    });
    expect(classifyBrowserInput(String.raw`\Windows\System32\drivers\etc\hosts`)).toEqual({
      kind: "rejected-local",
      input: String.raw`\Windows\System32\drivers\etc\hosts`,
      reason: "malformed-windows-path",
    });
  });

  it("rejects encoded UNC file URLs and relative file URL syntax", () => {
    expect(classifyBrowserInput("file:///%5C%5Cserver%5Cshare%5Cindex.html")).toMatchObject({
      kind: "rejected-local",
    });
    expect(classifyBrowserInput("file:///%5C%5C?%5CC:%5Cwork%5Cindex.html")).toMatchObject({
      kind: "rejected-local",
    });
    expect(classifyBrowserInput("file:///%5C%3F%3F%5CC:%5Cwork%5Cindex.html")).toMatchObject({
      kind: "rejected-local",
    });
    expect(
      classifyBrowserInput("file:///%5CWindows%5CSystem32%5Cdrivers%5Cetc%5Chosts"),
    ).toMatchObject({ kind: "rejected-local" });
    expect(classifyBrowserInput("file:relative/index.html")).toEqual({
      kind: "rejected-local",
      input: "file:relative/index.html",
      reason: "malformed-file-url",
    });
    expect(classifyBrowserInput("file:C:relative\\index.html")).toEqual({
      kind: "rejected-local",
      input: "file:C:relative\\index.html",
      reason: "malformed-file-url",
    });
  });

  it("rejects malformed local inputs instead of treating them as searches", () => {
    expect(classifyBrowserInput("C:relative\\index.html")).toEqual({
      kind: "rejected-local",
      input: "C:relative\\index.html",
      reason: "malformed-windows-path",
    });
    expect(classifyBrowserInput("file:///C:/bad%E0%A4%A.html")).toEqual({
      kind: "rejected-local",
      input: "file:///C:/bad%E0%A4%A.html",
      reason: "malformed-file-url",
    });
    expect(classifyBrowserInput("C:\\bad\0name.html")).toEqual({
      kind: "rejected-local",
      input: "C:\\bad\0name.html",
      reason: "nul-byte",
    });
  });
});

describe("normalizeBrowserUrlInput", () => {
  it("adds https to naked domains", () => {
    expect(normalizeBrowserUrlInput("phodex.app")).toBe("https://phodex.app/");
  });

  it("uses http for local hosts", () => {
    expect(normalizeBrowserUrlInput("localhost:5173")).toBe("http://localhost:5173/");
  });

  it("turns spaced text into a search url", () => {
    expect(normalizeBrowserUrlInput("how to bake bread")).toBe(
      `${BROWSER_SEARCH_URL_PREFIX}how%20to%20bake%20bread`,
    );
  });

  it("throws for recognized or rejected local inputs", () => {
    expect(() => normalizeBrowserUrlInput("C:\\work tree\\index.html")).toThrow(
      BrowserLocalInputError,
    );
    expect(() => normalizeBrowserUrlInput("file:///C:/work/index.html")).toThrow(
      "Local files require an authorized preview capability.",
    );
    expect(() => normalizeBrowserUrlInput("\\\\server\\share\\index.html")).toThrow(
      "This local file input is not supported.",
    );
    expect(() => normalizeBrowserUrlInput(String.raw`\Windows\System32\drivers\etc\hosts`)).toThrow(
      BrowserLocalInputError,
    );
  });
});

describe("resolveCopyableBrowserTabUrl", () => {
  it("prefers a non-blank live url over cached tab urls", () => {
    expect(
      resolveCopyableBrowserTabUrl(
        { url: "https://current.example/", lastCommittedUrl: "https://committed.example/" },
        "https://live.example/",
      ),
    ).toBe("https://live.example/");
  });

  it("falls back to committed then current urls while ignoring blank placeholders", () => {
    expect(
      resolveCopyableBrowserTabUrl({
        url: "https://current.example/",
        lastCommittedUrl: "about:blank",
      }),
    ).toBe("https://current.example/");
    expect(resolveCopyableBrowserTabUrl({ url: "about:blank", lastCommittedUrl: null })).toBeNull();
  });

  it("never exposes an internal capability URL for a local-file tab", () => {
    expect(
      resolveCopyableBrowserTabUrl(
        {
          url: "http://127.0.0.1:58090/api/local-preview/token/index.html",
          lastCommittedUrl: "http://127.0.0.1:58090/api/local-preview/token/index.html",
          localFilePath: "C:\\work\\index.html",
        },
        "http://127.0.0.1:58090/api/local-preview/token/index.html",
      ),
    ).toBeNull();
  });
});

describe("isBlankBrowserTabUrl", () => {
  it("treats empty and about:blank tab urls as blank", () => {
    expect(isBlankBrowserTabUrl(null)).toBe(true);
    expect(isBlankBrowserTabUrl({ url: "", lastCommittedUrl: null })).toBe(true);
    expect(isBlankBrowserTabUrl({ url: "about:blank", lastCommittedUrl: "" })).toBe(true);
  });

  it("requires both current and committed urls to be blank", () => {
    expect(
      isBlankBrowserTabUrl({
        url: "about:blank",
        lastCommittedUrl: "https://example.com/",
      }),
    ).toBe(false);
    expect(
      isBlankBrowserTabUrl({
        url: "https://example.com/",
        lastCommittedUrl: "about:blank",
      }),
    ).toBe(false);
  });
});

describe("isLikelyOAuthHost", () => {
  it("matches known auth hosts and their subdomains", () => {
    expect(isLikelyOAuthHost("accounts.google.com")).toBe(true);
    expect(isLikelyOAuthHost("appleid.apple.com")).toBe(true);
    expect(isLikelyOAuthHost("login.microsoftonline.com")).toBe(true);
  });

  it("does not match arbitrary hosts", () => {
    expect(isLikelyOAuthHost("example.com")).toBe(false);
    expect(isLikelyOAuthHost("github.com")).toBe(false);
    expect(isLikelyOAuthHost("")).toBe(false);
  });
});

describe("classifyBrowserWindowOpen", () => {
  it("does not treat new-window disposition alone as a popup", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://example.com/article",
        frameName: "",
        features: "",
        disposition: "new-window",
      }),
    ).toBe("tab");
  });

  it("treats window features as a popup signal", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://example.com/oauth",
        frameName: "oauthWindow",
        features: "width=480,height=640",
        disposition: "foreground-tab",
      }),
    ).toBe("popup");
  });

  it("treats known auth hosts opened via _blank as popups", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://accounts.google.com/o/oauth2/auth",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("popup");
  });

  it("treats known OAuth endpoints on multi-purpose hosts as popups", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://github.com/login/oauth/authorize?client_id=abc",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("popup");
  });

  it("treats reserved frame targets case-insensitively", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://example.com/article",
        frameName: "_BLANK",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("tab");
  });

  it("treats blank staging windows as popups so OAuth SDKs can assign the provider URL", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "about:blank",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("popup");
  });

  it("keeps ordinary _blank links to non-auth hosts as tabs", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://example.com/article",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("tab");
  });

  it("keeps ordinary _blank links to multi-purpose provider hosts as tabs", () => {
    for (const url of [
      "https://github.com/openai/codex",
      "https://gitlab.com/gitlab-org/gitlab",
      "https://slack.com/help/articles/360017938993",
      "https://facebook.com/openai",
      "https://discord.com/channels/@me",
      "https://linkedin.com/company/openai",
    ]) {
      expect(
        classifyBrowserWindowOpen({
          url,
          frameName: "_blank",
          features: "",
          disposition: "foreground-tab",
        }),
      ).toBe("tab");
    }
  });
});
