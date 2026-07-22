// FILE: diagnostic-redaction.cjs
// Purpose: Removes URL credentials and query values before desktop E2E diagnostics are persisted.

"use strict";

const FS = require("node:fs");
const Path = require("node:path");

const URL_IN_TEXT_PATTERN = /\b(?:https?|wss?|super-synara):\/\/[^\s"'<>]+/giu;
const SENSITIVE_QUERY_VALUE_PATTERN =
  /([?&](?:access_token|api_key|auth_token|authorization|token)=)[^&#\s"'<>]*/giu;

function redactSensitiveQueryValues(value) {
  return value.replace(SENSITIVE_QUERY_VALUE_PATTERN, "$1[REDACTED]");
}

function redactDiagnosticUrl(value) {
  const input = String(value);
  try {
    const parsed = new URL(input);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return redactSensitiveQueryValues(input);
  }
}

function redactDiagnosticText(value) {
  return redactSensitiveQueryValues(
    String(value).replace(URL_IN_TEXT_PATTERN, (url) => redactDiagnosticUrl(url)),
  );
}

function redactDiagnosticValue(value, key = "") {
  if (typeof value === "string") {
    return /url$/iu.test(key) ? redactDiagnosticUrl(value) : redactDiagnosticText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDiagnosticValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactDiagnosticValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function appendRedactedJsonLine(filePath, value) {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.appendFileSync(filePath, `${JSON.stringify(redactDiagnosticValue(value))}\n`, "utf8");
}

module.exports = {
  appendRedactedJsonLine,
  redactDiagnosticText,
  redactDiagnosticUrl,
  redactDiagnosticValue,
};
