// FILE: browserWebPreferences.test.ts
// Purpose: Verifies immutable Electron hardening for attached browser guests.
// Layer: Desktop test

import { describe, expect, it } from "vitest";

import {
  hardenAttachedBrowserParams,
  hardenAttachedBrowserWebPreferences,
} from "./browserWebPreferences";

describe("browser web preferences", () => {
  it("removes renderer-supplied privileges before a guest attaches", () => {
    const preferences = {
      allowRunningInsecureContent: true,
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      preload: "C:\\attacker\\preload.js",
      sandbox: false,
      webSecurity: false,
    };

    hardenAttachedBrowserWebPreferences(preferences);

    expect(preferences).toMatchObject({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(preferences).not.toHaveProperty("preload");
  });

  it("forces every attached guest to start on an inert document", () => {
    const params = {
      partition: "persist:synara-browser",
      src: "http://127.0.0.1:58090/api/local-preview/bearer/index.html",
    };

    hardenAttachedBrowserParams(params);

    expect(params.src).toBe("about:blank");
    expect(params.partition).toBe("persist:synara-browser");
  });
});
