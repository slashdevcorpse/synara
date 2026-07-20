// FILE: desktopWindowLifecycle.test.ts
// Purpose: Locks Super warm-close policy and desktop activation wiring.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  resolveDesktopWindowReopenDecision,
  shouldKeepDesktopRuntimeAliveAfterWindowAllClosed,
} from "./desktopWindowLifecycle";

const desktopMainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("shouldKeepDesktopRuntimeAliveAfterWindowAllClosed", () => {
  it.each(["production", "development", "canary", "super"] as const)(
    "preserves the existing macOS keep-alive behavior for %s",
    (flavor) => {
      expect(
        shouldKeepDesktopRuntimeAliveAfterWindowAllClosed({ flavor, platform: "darwin" }),
      ).toBe(true);
    },
  );

  it.each(["win32", "linux"] as const)(
    "keeps the Super runtime alive after the last window closes on %s",
    (platform) => {
      expect(
        shouldKeepDesktopRuntimeAliveAfterWindowAllClosed({ flavor: "super", platform }),
      ).toBe(true);
    },
  );

  it.each([
    ["production", "win32"],
    ["development", "win32"],
    ["canary", "win32"],
    ["production", "linux"],
    ["development", "linux"],
    ["canary", "linux"],
  ] as const)("retains quit-on-last-window for %s on %s", (flavor, platform) => {
    expect(shouldKeepDesktopRuntimeAliveAfterWindowAllClosed({ flavor, platform })).toBe(false);
  });

  it("does not broaden Super keep-alive to unsupported desktop platforms", () => {
    expect(
      shouldKeepDesktopRuntimeAliveAfterWindowAllClosed({
        flavor: "super",
        platform: "freebsd",
      }),
    ).toBe(false);
  });
});

describe("resolveDesktopWindowReopenDecision", () => {
  it("ignores reopen requests during migration recovery or shutdown", () => {
    expect(
      resolveDesktopWindowReopenDecision({
        startupBlocked: true,
        isQuitting: false,
        hasExistingWindow: false,
        hasBackendEndpoint: true,
      }),
    ).toBe("ignore");
    expect(
      resolveDesktopWindowReopenDecision({
        startupBlocked: false,
        isQuitting: true,
        hasExistingWindow: false,
        hasBackendEndpoint: true,
      }),
    ).toBe("ignore");
  });

  it("focuses an existing window without waiting for a backend endpoint", () => {
    expect(
      resolveDesktopWindowReopenDecision({
        startupBlocked: false,
        isQuitting: false,
        hasExistingWindow: true,
        hasBackendEndpoint: false,
      }),
    ).toBe("focus");
  });

  it("defers a headless reopen until bootstrap has reserved the backend endpoint", () => {
    expect(
      resolveDesktopWindowReopenDecision({
        startupBlocked: false,
        isQuitting: false,
        hasExistingWindow: false,
        hasBackendEndpoint: false,
      }),
    ).toBe("defer");
  });

  it("creates a missing window against the current backend endpoint", () => {
    expect(
      resolveDesktopWindowReopenDecision({
        startupBlocked: false,
        isQuitting: false,
        hasExistingWindow: false,
        hasBackendEndpoint: true,
      }),
    ).toBe("create");
  });
});

describe("desktop window lifecycle integration", () => {
  it("routes second-instance and macOS activation through one reopen function", () => {
    expect(desktopMainSource).toContain(
      'app.on("second-instance", () => {\n    reopenDesktopMainWindow("second-instance");',
    );
    expect(desktopMainSource).toContain(
      'app.on("activate", () => {\n        reopenDesktopMainWindow("activate");',
    );

    const reopenPath = sourceBetween(
      desktopMainSource,
      "function reopenDesktopMainWindow(",
      "// Show a native OS notification",
    );
    expect(reopenPath).toContain("resolveDesktopWindowReopenDecision");
    expect(reopenPath).toContain(
      "openDesktopMainWindowAgainstCurrentBackend(reason, backendHttpUrl)",
    );
    expect(reopenPath).not.toContain("beginAutomaticBackendStart");

    const openPath = sourceBetween(
      desktopMainSource,
      "function openDesktopMainWindowAgainstCurrentBackend(",
      "function reopenDesktopMainWindow(",
    );
    expect(openPath).toContain("ensureInitialBackendWindowOpen(baseUrl)");
    expect(openPath).toContain("waitForBackendWindowReady(baseUrl)");
    expect(openPath).not.toContain("beginAutomaticBackendStart");
  });

  it("uses the flavor policy only for window-all-closed and leaves bounded quit intact", () => {
    const lastWindowHandler = sourceBetween(
      desktopMainSource,
      'app.on("window-all-closed", () => {',
      'if (process.platform !== "win32") {',
    );
    expect(lastWindowHandler).toContain("shouldKeepDesktopRuntimeAliveAfterWindowAllClosed");
    expect(lastWindowHandler).toContain("flavor: desktopIdentity.flavor");
    expect(lastWindowHandler).toContain("platform: process.platform");
    expect(lastWindowHandler).toContain("app.quit()");
    expect(desktopMainSource).toContain('requestGracefulAppQuit("before-quit")');
  });

  it("consumes deferred startup reopen requests without starting another backend", () => {
    const bootstrap = sourceBetween(
      desktopMainSource,
      "async function bootstrap()",
      'app.on("before-quit",',
    );
    expect(bootstrap).toContain('deferredMainWindowReopenReason ?? "bootstrap"');
    expect(bootstrap).toContain("openDesktopMainWindowAgainstCurrentBackend");
    expect(bootstrap.match(/beginAutomaticBackendStart\(/g)).toHaveLength(1);
  });
});
