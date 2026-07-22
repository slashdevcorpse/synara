// FILE: loopback.cjs
// Purpose: Provides one loopback-host policy for every desktop E2E network guard.

"use strict";

const Net = require("node:net");

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

module.exports = { isLoopbackHost, normalizeHost };
