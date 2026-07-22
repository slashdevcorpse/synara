// FILE: electron-bootstrap.cjs
// Purpose: Installs E2E network guards before loading the built Electron main process.

"use strict";

const Net = require("node:net");
const { app, session } = require("electron");
const { appendRedactedJsonLine } = require("./diagnostic-redaction.cjs");

const networkLogPath = process.env.SYNARA_E2E_NETWORK_LOG_PATH;
const networkGuardPath = process.env.SYNARA_E2E_NETWORK_GUARD_PATH;
const desktopMainPath = process.env.SYNARA_E2E_DESKTOP_MAIN_PATH;
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

if (!networkLogPath || !networkGuardPath || !desktopMainPath) {
  throw new Error(
    "Desktop E2E bootstrap requires network log, network guard, and built main paths.",
  );
}

function recordNetworkEvent(event) {
  appendRedactedJsonLine(networkLogPath, {
    at: new Date().toISOString(),
    pid: process.pid,
    layer: "chromium",
    ...event,
  });
}

function normalizeHost(host) {
  return String(host ?? "")
    .trim()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
}

function isLoopbackHost(host) {
  const normalized = normalizeHost(host);
  if (normalized === "localhost") return true;
  if (Net.isIP(normalized) === 4) return Number(normalized.split(".", 1)[0]) === 127;
  if (Net.isIP(normalized) !== 6) return false;
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const mappedIpv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : "";
  return Net.isIP(mappedIpv4) === 4 && Number(mappedIpv4.split(".", 1)[0]) === 127;
}

function installChromiumNetworkGuard(partition, guardedSession) {
  recordNetworkEvent({ event: "guard-installed", partition });
  guardedSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let parsed;
    try {
      parsed = new URL(details.url);
    } catch {
      recordNetworkEvent({ event: "blocked", partition, url: details.url, reason: "invalid-url" });
      callback({ cancel: true });
      return;
    }
    if (!NETWORK_PROTOCOLS.has(parsed.protocol) || isLoopbackHost(parsed.hostname)) {
      callback({ cancel: false });
      return;
    }
    recordNetworkEvent({ event: "blocked", partition, url: details.url, reason: "non-loopback" });
    callback({ cancel: true });
  });
  guardedSession.webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => {
    let parsed;
    try {
      parsed = new URL(details.url);
    } catch {
      return;
    }
    if (NETWORK_PROTOCOLS.has(parsed.protocol) && isLoopbackHost(parsed.hostname)) {
      recordNetworkEvent({
        event: "request-completed",
        partition,
        url: details.url,
        statusCode: details.statusCode,
      });
    }
  });
  guardedSession.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, (details) => {
    let parsed;
    try {
      parsed = new URL(details.url);
    } catch {
      return;
    }
    if (NETWORK_PROTOCOLS.has(parsed.protocol) && isLoopbackHost(parsed.hostname)) {
      recordNetworkEvent({
        event: "request-error",
        partition,
        url: details.url,
        error: details.error,
      });
    }
  });
}

// Electron does not load NODE_OPTIONS into its browser process. Require the guard
// here for desktop-main, then restore NODE_OPTIONS before production main code
// derives the environment for its ELECTRON_RUN_AS_NODE backend child.
const nodeRequirePath =
  process.platform === "win32" ? networkGuardPath.replaceAll("\\", "/") : networkGuardPath;
process.env.NODE_OPTIONS = `--require="${nodeRequirePath.replaceAll('"', '\\"')}"`;
require(networkGuardPath);

app.on("web-contents-created", (_event, contents) => {
  const webContentsId = contents.id;
  const webContentsType = contents.getType();
  let lastKnownUrl = contents.getURL();
  const record = (event, details = {}) => {
    if (!contents.isDestroyed()) lastKnownUrl = contents.getURL();
    recordNetworkEvent({
      event,
      webContentsId,
      webContentsType,
      url: lastKnownUrl,
      ...details,
    });
  };
  record("web-contents-created");
  contents.on("did-start-navigation", (_navigationEvent, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) record("did-start-navigation", { url });
  });
  contents.on("did-finish-load", () => record("did-finish-load"));
  contents.on(
    "did-fail-load",
    (_loadEvent, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        record("did-fail-load", { errorCode, errorDescription, url: validatedURL });
      }
    },
  );
  contents.on("destroyed", () => record("web-contents-destroyed"));
});

app.once("ready", () => {
  const guardedSessions = [
    ["default", session.defaultSession],
    ["persist:synara-browser", session.fromPartition("persist:synara-browser")],
  ];
  for (const [partition, guardedSession] of guardedSessions) {
    installChromiumNetworkGuard(partition, guardedSession);
    void guardedSession
      .resolveProxy("ws://127.0.0.1:12345")
      .then((result) => recordNetworkEvent({ event: "proxy-resolved", partition, result }))
      .catch((error) =>
        recordNetworkEvent({
          event: "proxy-resolution-failed",
          partition,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
});

require(desktopMainPath);
