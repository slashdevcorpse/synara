import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createBrowserPopupNavigationPolicy,
  enforceBrowserNavigationPolicy,
  enforceBrowserPopupNavigationPolicy,
  isAllowedBrowserNavigationUrl,
  secureBrowserWebviewAttachment,
} from "./browserSecurity";
import { BROWSER_SESSION_PARTITION } from "./browserSessionPolicy";

describe("desktop browser security policy", () => {
  it.each([
    "https://accounts.example.test/login",
    "https://sso.example.test/callback?code=abc",
    "http://127.0.0.1/oauth/callback",
    "about:blank",
    "about:blank#oauth",
  ])("allows normal cross-host web OAuth navigation to %s", (url) => {
    expect(isAllowedBrowserNavigationUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///etc/passwd",
    "shell:open",
    "synara-oauth://callback",
    "not a url",
  ])("denies dangerous or custom navigation to %s", (url) => {
    expect(isAllowedBrowserNavigationUrl(url)).toBe(false);
  });

  it("prevents a denied navigation before commit and reports it", () => {
    const preventDefault = vi.fn();
    const onBlocked = vi.fn();

    expect(
      enforceBrowserNavigationPolicy({ url: "file:///sensitive", preventDefault }, onBlocked),
    ).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onBlocked).toHaveBeenCalledWith("file:///sensitive");
  });

  it.each(["file:///sensitive", "data:text/html,unsafe", "synara-oauth://callback"])(
    "prevents dangerous normal-tab navigation to %s",
    (url) => {
      const preventDefault = vi.fn();

      expect(enforceBrowserNavigationPolicy({ url, preventDefault })).toBe(false);
      expect(preventDefault).toHaveBeenCalledOnce();
    },
  );

  it.each(["https://example.test/path", "http://127.0.0.1/callback", "about:blank"])(
    "allows normal-tab navigation to %s",
    (url) => {
      const preventDefault = vi.fn();

      expect(enforceBrowserNavigationPolicy({ url, preventDefault })).toBe(true);
      expect(preventDefault).not.toHaveBeenCalled();
    },
  );

  it("allows same-origin OAuth navigation and a callback to the opener origin", () => {
    const policy = createBrowserPopupNavigationPolicy({
      openerUrl: "https://app.example.test/settings/integrations",
      initialUrl: "https://accounts.example.test/oauth/authorize",
    });

    expect(policy.allowsNavigation("https://accounts.example.test/oauth/consent")).toBe(true);
    expect(policy.allowsNavigation("https://app.example.test/oauth/callback?code=abc")).toBe(true);
    expect(policy.allowedOrigins()).toEqual([
      "https://accounts.example.test",
      "https://app.example.test",
    ]);
  });

  it("blocks and closes a popup redirected to an unbound HTTPS origin", () => {
    const policy = createBrowserPopupNavigationPolicy({
      openerUrl: "https://app.example.test/",
      initialUrl: "https://accounts.example.test/oauth/authorize",
    });
    const preventDefault = vi.fn();
    const closePopup = vi.fn();

    expect(
      enforceBrowserPopupNavigationPolicy(
        policy,
        { url: "https://attacker.example/phish", preventDefault },
        closePopup,
      ),
    ).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(closePopup).toHaveBeenCalledWith("https://attacker.example/phish");
  });

  it("blocks dangerous schemes even when they target a bound popup", () => {
    const policy = createBrowserPopupNavigationPolicy({
      openerUrl: "https://app.example.test/",
      initialUrl: "https://accounts.example.test/oauth/authorize",
    });
    for (const url of ["javascript:alert(1)", "data:text/html,unsafe", "file:///secret"]) {
      const preventDefault = vi.fn();
      expect(enforceBrowserPopupNavigationPolicy(policy, { url, preventDefault })).toBe(false);
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  });

  it("binds an about:blank popup to its first web origin exactly once", () => {
    const policy = createBrowserPopupNavigationPolicy({
      openerUrl: "https://app.example.test/",
      initialUrl: "about:blank",
      allowAboutBlankOriginBinding: true,
    });

    expect(policy.allowsNavigation("about:blank#oauth")).toBe(true);
    expect(policy.allowsNavigation("https://accounts.example.test/oauth/authorize")).toBe(true);
    expect(policy.allowsNavigation("https://accounts.example.test/oauth/consent")).toBe(true);
    expect(policy.allowsNavigation("https://attacker.example/phish")).toBe(false);
  });

  it("propagates the parent's bound origins to nested popups without a new wildcard bind", () => {
    const parent = createBrowserPopupNavigationPolicy({
      openerUrl: "https://app.example.test/",
      initialUrl: "https://accounts.example.test/oauth/authorize",
    });
    const nested = parent.deriveNested("about:blank");

    expect(nested).not.toBeNull();
    expect(nested?.allowsNavigation("https://accounts.example.test/consent")).toBe(true);
    expect(nested?.allowsNavigation("https://app.example.test/oauth/callback")).toBe(true);
    expect(nested?.allowsNavigation("https://attacker.example/phish")).toBe(false);
    expect(parent.deriveNested("https://attacker.example/phish")).toBeNull();
  });

  it("hardens an approved browser webview and strips renderer-controlled preload", () => {
    const preferences = {
      partition: BROWSER_SESSION_PARTITION,
      preload: "C:/untrusted/preload.js",
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      webviewTag: true,
    };
    const params = {
      partition: BROWSER_SESSION_PARTITION,
      preload: "file:///C:/untrusted/preload.js",
      src: "https://example.test/",
    };

    expect(secureBrowserWebviewAttachment(preferences, params)).toEqual({ allowed: true });
    expect(preferences).toMatchObject({
      partition: BROWSER_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
    expect(preferences).not.toHaveProperty("preload");
    expect(params).not.toHaveProperty("preload");
  });

  it("rejects webviews outside the dedicated partition or with a dangerous source", () => {
    expect(
      secureBrowserWebviewAttachment(
        { partition: "persist:other" },
        { partition: "persist:other", src: "https://example.test/" },
      ),
    ).toEqual({ allowed: false, reason: "partition" });
    expect(
      secureBrowserWebviewAttachment(
        { partition: BROWSER_SESSION_PARTITION },
        { partition: BROWSER_SESSION_PARTITION, src: "file:///sensitive" },
      ),
    ).toEqual({ allowed: false, reason: "source" });
  });

  it("wires the policy into packaged responses, webview attachment, and nested popups", () => {
    const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const browserManagerSource = readFileSync(
      new URL("./browserManager.ts", import.meta.url),
      "utf8",
    );

    expect(mainSource).toContain("protocol.handle(DESKTOP_SCHEME");
    expect(mainSource).toContain("applyWebDocumentSecurityHeaders(");
    expect(mainSource).toContain('window.webContents.on("will-attach-webview"');
    expect(mainSource).toContain("secureBrowserWebviewAttachment(webPreferences, params)");
    const runtimeSecuritySource = browserManagerSource.slice(
      browserManagerSource.indexOf("private configureRuntimeWebContents"),
      browserManagerSource.indexOf("private syncRuntimeState"),
    );
    expect(runtimeSecuritySource).toContain("enforceBrowserNavigationPolicy(event)");
    expect(runtimeSecuritySource).toContain('webContents.on("will-navigate", willNavigate)');
    expect(runtimeSecuritySource).toContain('webContents.on("will-redirect", willRedirect)');
    expect(browserManagerSource).toContain("this.registerOAuthPopupWindow(nested");
    expect(browserManagerSource).toContain("runtime.navigationPolicy.deriveNested(details.url)");
    expect(browserManagerSource).toContain("createBrowserPopupNavigationPolicy({");
  });
});
