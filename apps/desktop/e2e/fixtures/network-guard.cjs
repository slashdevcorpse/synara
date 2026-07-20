// FILE: network-guard.cjs
// Purpose: Fail closed on non-loopback Node TCP connections in desktop E2E child processes.

"use strict";

const FS = require("node:fs");
const Net = require("node:net");
const Path = require("node:path");

const INSTALL_KEY = Symbol.for("synara.e2e.networkGuard.installed");
const networkLogPath =
  process.env.SYNARA_FAKE_CODEX_NETWORK_LOG_PATH ?? process.env.SYNARA_E2E_NETWORK_LOG_PATH;

function networkRole() {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") return "backend";
  if (process.argv.some((argument) => /[\\/]launcher-log\.cjs$/iu.test(argument))) {
    return "fake-launcher";
  }
  if (process.argv.some((argument) => /[\\/]fake-codex\.ts$/iu.test(argument))) {
    return "fake-codex";
  }
  if (process.versions.electron) return "desktop-main";
  return "node";
}

function recordNetworkEvent(event) {
  if (!networkLogPath) return;
  FS.mkdirSync(Path.dirname(networkLogPath), { recursive: true });
  FS.appendFileSync(
    networkLogPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      layer: "node",
      role: networkRole(),
      ...event,
    })}\n`,
    "utf8",
  );
}

function normalizeHost(host) {
  return String(host ?? "localhost")
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

function connectionDestination(args) {
  const first = args[0];
  if (typeof first === "string") {
    return { localPipe: true, host: null, port: null };
  }
  if (typeof first === "number") {
    return {
      localPipe: false,
      host: typeof args[1] === "string" ? args[1] : "localhost",
      port: first,
    };
  }
  if (first && typeof first === "object") {
    if (typeof first.path === "string") {
      return { localPipe: true, host: null, port: null };
    }
    return {
      localPipe: false,
      host:
        typeof first.hostname === "string"
          ? first.hostname
          : typeof first.host === "string"
            ? first.host
            : "localhost",
      port: typeof first.port === "number" || typeof first.port === "string" ? first.port : null,
    };
  }
  return { localPipe: false, host: "localhost", port: null };
}

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;
  recordNetworkEvent({ event: "guard-installed", args: process.argv.slice(2) });

  const originalConnect = Net.Socket.prototype.connect;
  Net.Socket.prototype.connect = function guardedConnect(...args) {
    const destination = connectionDestination(args);
    if (destination.localPipe || isLoopbackHost(destination.host)) {
      return Reflect.apply(originalConnect, this, args);
    }

    const host = normalizeHost(destination.host);
    recordNetworkEvent({ event: "blocked", host, port: destination.port });
    const error = Object.assign(
      new Error(
        `Desktop E2E blocked a non-loopback TCP connection to ${host}:${destination.port ?? "?"}.`,
      ),
      { code: "EACCES", host, port: destination.port },
    );
    process.nextTick(() => this.destroy(error));
    return this;
  };
}
