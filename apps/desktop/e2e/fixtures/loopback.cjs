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
  const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  if (canonical === "::1") return true;
  const mappedIpv4 = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(canonical);
  return mappedIpv4 !== null && Number.parseInt(mappedIpv4[1], 16) >> 8 === 127;
}

module.exports = { isLoopbackHost, normalizeHost };
