// FILE: browserSecurity.ts
// Purpose: Defines testable navigation and webview-attachment policy for the desktop browser.
// Layer: Desktop main-process security policy

import type { WebContents } from "electron";

import { BROWSER_SESSION_PARTITION } from "./browserSessionPolicy";

const ABOUT_BLANK_URL = "about:blank";

function isAboutBlankUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "about:" && url.pathname === "blank";
  } catch {
    return false;
  }
}

function browserWebOrigin(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function isAllowedBrowserNavigationUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return true;
    }
    return isAboutBlankUrl(rawUrl);
  } catch {
    return false;
  }
}

export interface BrowserPopupNavigationPolicy {
  allowsNavigation(url: string): boolean;
  allowsNestedOpen(url: string): boolean;
  deriveNested(initialUrl: string): BrowserPopupNavigationPolicy | null;
  allowedOrigins(): ReadonlyArray<string>;
}

export function createBrowserPopupNavigationPolicy(input: {
  readonly openerUrl?: string;
  readonly initialUrl: string;
  readonly inheritedOrigins?: ReadonlyArray<string>;
  readonly allowAboutBlankOriginBinding?: boolean;
}): BrowserPopupNavigationPolicy {
  const origins = new Set<string>();
  for (const inherited of input.inheritedOrigins ?? []) {
    const origin = browserWebOrigin(inherited);
    if (origin) origins.add(origin);
  }
  const openerOrigin = browserWebOrigin(input.openerUrl);
  if (openerOrigin) origins.add(openerOrigin);
  const initialOrigin = browserWebOrigin(input.initialUrl);
  if (initialOrigin) origins.add(initialOrigin);
  let canBindInitialOrigin =
    initialOrigin === null &&
    isAboutBlankUrl(input.initialUrl) &&
    input.allowAboutBlankOriginBinding === true;

  const allowsNavigation = (rawUrl: string): boolean => {
    if (isAboutBlankUrl(rawUrl)) return true;
    const origin = browserWebOrigin(rawUrl);
    if (!origin) return false;
    if (canBindInitialOrigin) {
      canBindInitialOrigin = false;
      origins.add(origin);
      return true;
    }
    return origins.has(origin);
  };
  const allowsNestedOpen = (rawUrl: string): boolean => {
    if (isAboutBlankUrl(rawUrl)) return true;
    const origin = browserWebOrigin(rawUrl);
    return origin !== null && origins.has(origin);
  };

  return {
    allowsNavigation,
    allowsNestedOpen,
    deriveNested: (initialUrl) =>
      allowsNestedOpen(initialUrl)
        ? createBrowserPopupNavigationPolicy({
            initialUrl,
            inheritedOrigins: [...origins],
            allowAboutBlankOriginBinding: false,
          })
        : null,
    allowedOrigins: () => [...origins].sort(),
  };
}

export interface PreventableBrowserNavigation {
  readonly url: string;
  preventDefault(): void;
}

export function enforceBrowserNavigationPolicy(
  event: PreventableBrowserNavigation,
  onBlocked?: (url: string) => void,
): boolean {
  if (isAllowedBrowserNavigationUrl(event.url)) {
    return true;
  }
  event.preventDefault();
  onBlocked?.(event.url);
  return false;
}

const guardedBrowserWebContents = new WeakSet<WebContents>();
const attachmentSecuredBrowserWebContents = new WeakSet<WebContents>();
const securedBrowserWebviewHosts = new WeakSet<WebContents>();

/**
 * Install the normal-tab scheme policy once for the full lifetime of a guest.
 * Keeping the listeners until WebContents destruction closes the interval
 * between Electron attachment and the renderer's later browser IPC handshake.
 */
export function ensureBrowserNavigationPolicy(webContents: WebContents): boolean {
  if (guardedBrowserWebContents.has(webContents)) return false;
  guardedBrowserWebContents.add(webContents);

  webContents.on(
    "will-navigate",
    (event: Electron.Event<Electron.WebContentsWillNavigateEventParams>) => {
      enforceBrowserNavigationPolicy(event);
    },
  );
  webContents.on(
    "will-redirect",
    (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
      enforceBrowserNavigationPolicy(event);
    },
  );
  return true;
}

/**
 * Close the interval between Electron attaching a guest and the browser runtime
 * adopting it. Runtime configuration replaces this deny-all handler with the
 * normal popup/tab policy once the guest has an owning terminal tab.
 */
export function ensureAttachedBrowserWebContentsSecurity(webContents: WebContents): boolean {
  if (attachmentSecuredBrowserWebContents.has(webContents)) return false;

  ensureBrowserNavigationPolicy(webContents);
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  attachmentSecuredBrowserWebContents.add(webContents);
  return true;
}

export function enforceBrowserPopupNavigationPolicy(
  policy: BrowserPopupNavigationPolicy,
  event: PreventableBrowserNavigation,
  onBlocked?: (url: string) => void,
): boolean {
  if (policy.allowsNavigation(event.url)) {
    return true;
  }
  event.preventDefault();
  onBlocked?.(event.url);
  return false;
}

export interface BrowserWebviewPreferences {
  partition?: string;
  preload?: string;
  contextIsolation?: boolean;
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  nodeIntegrationInWorker?: boolean;
  sandbox?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  webviewTag?: boolean;
}

export type BrowserWebviewAttachmentDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "partition" | "source" };

export function secureBrowserWebviewAttachment(
  webPreferences: BrowserWebviewPreferences,
  params: Record<string, string>,
): BrowserWebviewAttachmentDecision {
  const partition = params.partition ?? webPreferences.partition;
  if (partition !== BROWSER_SESSION_PARTITION) {
    return { allowed: false, reason: "partition" };
  }
  if (!isAllowedBrowserNavigationUrl(params.src ?? ABOUT_BLANK_URL)) {
    return { allowed: false, reason: "source" };
  }

  delete webPreferences.preload;
  delete params.preload;
  webPreferences.partition = BROWSER_SESSION_PARTITION;
  webPreferences.contextIsolation = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webviewTag = false;
  return { allowed: true };
}

/** Install the browser webview policy on a desktop window exactly once. */
export function installBrowserWebviewAttachmentSecurity(webContents: WebContents): boolean {
  if (securedBrowserWebviewHosts.has(webContents)) return false;

  webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const decision = secureBrowserWebviewAttachment(webPreferences, params);
    if (!decision.allowed) {
      event.preventDefault();
    }
  });
  webContents.on("did-attach-webview", (_event, guestWebContents) => {
    ensureAttachedBrowserWebContentsSecurity(guestWebContents);
  });
  securedBrowserWebviewHosts.add(webContents);
  return true;
}
