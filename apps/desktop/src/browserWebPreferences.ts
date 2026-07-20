// FILE: browserWebPreferences.ts
// Purpose: Enforces immutable Electron preferences before an in-app browser guest attaches.
// Layer: Desktop browser security policy

import type { WebPreferences } from "electron";

export const ATTACHED_BROWSER_INITIAL_URL = "about:blank";

/**
 * Renderer attributes are a useful first line, but Electron's main-process
 * attachment boundary is authoritative. Never accept a renderer-supplied
 * preload or a guest that weakens Chromium's process isolation.
 */
export function hardenAttachedBrowserWebPreferences(webPreferences: WebPreferences): void {
  webPreferences.contextIsolation = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  delete webPreferences.preload;
}

/**
 * A renderer-owned guest must start inert. The desktop browser manager adopts
 * it before loading the requested page, which lets local previews install and
 * verify their document-start guard before any untrusted document can run.
 */
export function hardenAttachedBrowserParams(params: Record<string, string>): void {
  params.src = ATTACHED_BROWSER_INITIAL_URL;
}
