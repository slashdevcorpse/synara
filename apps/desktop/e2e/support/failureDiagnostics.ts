import * as FS from "node:fs";
import * as Path from "node:path";

const FAILURE_SUMMARY_KEYS = [
  "schemaVersion",
  "status",
  "expectedStatus",
  "forced",
  "unexpectedStatus",
  "validationErrorCount",
] as const;
const FAILURE_STATUS_VALUES = new Set([
  "unknown",
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);
const ATTEMPT_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;

export interface DesktopE2eFailureSummary {
  readonly schemaVersion: 1;
  readonly status: "unknown" | "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  readonly expectedStatus: "unknown" | "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  readonly forced: boolean;
  readonly unexpectedStatus: boolean;
  readonly validationErrorCount: number;
}

function expectedFailureDiagnosticsRoot(repositoryRoot: string): string {
  return Path.resolve(repositoryRoot, "apps/desktop/failure-diagnostics");
}

function assertExactFailureDiagnosticsRoot(repositoryRoot: string, failureRoot: string): string {
  const expectedRoot = expectedFailureDiagnosticsRoot(repositoryRoot);
  const resolvedRoot = Path.resolve(failureRoot);
  if (
    resolvedRoot !== expectedRoot ||
    Path.basename(resolvedRoot) !== "failure-diagnostics" ||
    Path.basename(Path.dirname(resolvedRoot)) !== "desktop"
  ) {
    throw new Error(`Invalid desktop E2E failure diagnostics root: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

function normalizeFailureStatus(value: string | undefined): DesktopE2eFailureSummary["status"] {
  return FAILURE_STATUS_VALUES.has(value ?? "")
    ? (value as DesktopE2eFailureSummary["status"])
    : "unknown";
}

function canonicalFailureSummary(value: unknown): DesktopE2eFailureSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Desktop E2E failure summary must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...FAILURE_SUMMARY_KEYS].sort())) {
    throw new Error("Desktop E2E failure summary must contain only the closed schema fields.");
  }
  const schemaVersion = record.schemaVersion;
  const status = record.status;
  const expectedStatus = record.expectedStatus;
  const forced = record.forced;
  const unexpectedStatus = record.unexpectedStatus;
  const validationErrorCount = record.validationErrorCount;
  if (
    schemaVersion !== 1 ||
    typeof status !== "string" ||
    !FAILURE_STATUS_VALUES.has(status) ||
    typeof expectedStatus !== "string" ||
    !FAILURE_STATUS_VALUES.has(expectedStatus) ||
    typeof forced !== "boolean" ||
    typeof unexpectedStatus !== "boolean" ||
    typeof validationErrorCount !== "number" ||
    !Number.isSafeInteger(validationErrorCount) ||
    validationErrorCount < 0
  ) {
    throw new Error("Desktop E2E failure summary contains an invalid closed-schema value.");
  }
  return Object.assign(Object.create(null) as DesktopE2eFailureSummary, {
    schemaVersion: 1 as const,
    status: status as DesktopE2eFailureSummary["status"],
    expectedStatus: expectedStatus as DesktopE2eFailureSummary["expectedStatus"],
    forced,
    unexpectedStatus,
    validationErrorCount,
  });
}

export function desktopFailureDiagnosticsRoot(repositoryRoot: string): string {
  return expectedFailureDiagnosticsRoot(repositoryRoot);
}

export function createDesktopE2eFailureSummary(input: {
  readonly status: string | undefined;
  readonly expectedStatus: string | undefined;
  readonly forced: boolean;
  readonly validationErrorCount: number;
}): DesktopE2eFailureSummary {
  const summary: DesktopE2eFailureSummary = {
    schemaVersion: 1,
    status: normalizeFailureStatus(input.status),
    expectedStatus: normalizeFailureStatus(input.expectedStatus),
    forced: input.forced,
    unexpectedStatus: input.status !== input.expectedStatus,
    validationErrorCount: input.validationErrorCount,
  };
  return canonicalFailureSummary(summary);
}

export async function clearFailureDiagnosticsRoot(
  repositoryRoot: string,
  failureRoot: string,
): Promise<void> {
  const resolvedRoot = assertExactFailureDiagnosticsRoot(repositoryRoot, failureRoot);
  await FS.promises.rm(resolvedRoot, { recursive: true, force: true });
}

export async function clearFailureDiagnosticsAttempt(
  repositoryRoot: string,
  attemptDirectory: string,
): Promise<void> {
  const failureRoot = expectedFailureDiagnosticsRoot(repositoryRoot);
  const resolvedAttemptDirectory = Path.resolve(attemptDirectory);
  assertExactFailureDiagnosticsRoot(repositoryRoot, failureRoot);
  if (
    Path.dirname(resolvedAttemptDirectory) !== failureRoot ||
    !ATTEMPT_NAME_PATTERN.test(Path.basename(resolvedAttemptDirectory))
  ) {
    throw new Error(
      `Refusing to remove an unverified desktop E2E failure directory: ${resolvedAttemptDirectory}`,
    );
  }
  await FS.promises.rm(resolvedAttemptDirectory, { recursive: true, force: true });
}

export async function writeDesktopE2eFailureSummary(
  repositoryRoot: string,
  attemptName: string,
  summary: DesktopE2eFailureSummary,
): Promise<string> {
  const failureRoot = expectedFailureDiagnosticsRoot(repositoryRoot);
  assertExactFailureDiagnosticsRoot(repositoryRoot, failureRoot);
  if (!ATTEMPT_NAME_PATTERN.test(attemptName)) {
    throw new Error(`Invalid desktop E2E failure diagnostics attempt: ${attemptName}`);
  }
  const canonicalSummary = canonicalFailureSummary(summary);
  const attemptDirectory = Path.resolve(failureRoot, attemptName);
  if (Path.dirname(attemptDirectory) !== failureRoot) {
    throw new Error(`Invalid desktop E2E failure diagnostics attempt: ${attemptName}`);
  }
  const destinationPath = Path.join(attemptDirectory, "failure-summary.json");
  await FS.promises.mkdir(attemptDirectory, { recursive: true });
  await FS.promises.writeFile(destinationPath, `${JSON.stringify(canonicalSummary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return destinationPath;
}
