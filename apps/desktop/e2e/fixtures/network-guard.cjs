// FILE: network-guard.cjs
// Purpose: Fail closed on non-loopback Node TCP connections in desktop E2E child processes.

"use strict";

const Net = require("node:net");
const FS = require("node:fs");
const Path = require("node:path");
const { appendRedactedJsonLine } = require("./diagnostic-redaction.cjs");
const { isLoopbackHost, normalizeHost } = require("./loopback.cjs");

const INSTALL_KEY = Symbol.for("synara.e2e.networkGuard.installed");

function fakeCodexSidecarNetworkLogPath() {
  const runtimePath = process.argv[1];
  if (!runtimePath || !/fake-codex-runtime\.mjs$/iu.test(runtimePath)) return undefined;
  try {
    const configPath = Path.join(Path.dirname(runtimePath), "fake-codex-config.json");
    const config = JSON.parse(FS.readFileSync(configPath, "utf8"));
    return typeof config.networkLogPath === "string" ? config.networkLogPath : undefined;
  } catch {
    return undefined;
  }
}

const networkLogPath =
  process.env.SYNARA_FAKE_CODEX_NETWORK_LOG_PATH ??
  process.env.SYNARA_E2E_NETWORK_LOG_PATH ??
  fakeCodexSidecarNetworkLogPath();

function networkRole() {
  if (process.env.SYNARA_E2E_NETWORK_ROLE === "approval-child") return "approval-child";
  if (process.env.SYNARA_E2E_NETWORK_ROLE === "guard-probe") return "guard-probe";
  if (process.env.ELECTRON_RUN_AS_NODE === "1") return "backend";
  if (
    process.argv.some((argument) => /[\\/]fake-codex(?:-runtime)?\.(?:mjs|ts)$/iu.test(argument))
  ) {
    return "fake-codex";
  }
  if (process.versions.electron) return "desktop-main";
  return "node";
}

function recordNetworkEvent(event) {
  if (!networkLogPath) return;
  appendRedactedJsonLine(networkLogPath, {
    at: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    layer: "node",
    role: networkRole(),
    ...event,
  });
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

  function blockConnection(socket, destination) {
    const host = normalizeHost(destination.host);
    recordNetworkEvent({ event: "blocked", host, port: destination.port });
    const error = Object.assign(
      new Error(
        `Desktop E2E blocked a non-loopback TCP connection to ${host}:${destination.port ?? "?"}.`,
      ),
      { code: "EACCES", host, port: destination.port },
    );
    process.nextTick(() => socket.destroy(error));
    return socket;
  }

  function permitsConnection(destination) {
    return destination.localPipe || isLoopbackHost(destination.host);
  }

  const originalSocketConnect = Net.Socket.prototype.connect;
  Net.Socket.prototype.connect = function guardedSocketConnect(...args) {
    const destination = connectionDestination(args);
    if (permitsConnection(destination)) {
      return Reflect.apply(originalSocketConnect, this, args);
    }
    return blockConnection(this, destination);
  };

  const originalCreateConnection = Net.createConnection;
  function guardedCreateConnection(...args) {
    const destination = connectionDestination(args);
    if (permitsConnection(destination)) {
      return Reflect.apply(originalCreateConnection, this, args);
    }
    return blockConnection(new Net.Socket(), destination);
  }
  Net.createConnection = guardedCreateConnection;
  Net.connect = guardedCreateConnection;
}
