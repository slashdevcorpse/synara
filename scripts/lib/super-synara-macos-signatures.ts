// FILE: super-synara-macos-signatures.ts
// Purpose: Validates fail-closed macOS ad-hoc and reviewed-vendor signature evidence.
// Layer: Release/build helper

export interface MacSignatureIdentity {
  readonly path: string;
  readonly identifier: string | null;
  readonly teamId: string | null;
  readonly authorities: ReadonlyArray<string>;
  readonly cdHash: string;
  readonly scheme: "ad-hoc-only" | "developer-id";
}

export interface MacThirdPartySignatureExpectation {
  readonly path: string;
  readonly identifier: string | null;
  readonly teamId: string | null;
  readonly authorities: ReadonlyArray<string>;
  readonly scheme: "ad-hoc-only" | "developer-id";
}

export interface MacSignatureAllowlist {
  readonly schemaVersion: 1;
  readonly electronVersion: string;
  readonly productOwnedPaths: ReadonlyArray<string>;
  readonly thirdParty: ReadonlyArray<MacThirdPartySignatureExpectation>;
}

export interface MacUnsignedSignatureReport {
  readonly schemaVersion: 1;
  readonly appBundle: string;
  readonly electronVersion: string;
  readonly notarizationTicket: "absent" | "present";
  readonly productOwned: ReadonlyArray<MacSignatureIdentity>;
  readonly thirdParty: ReadonlyArray<MacSignatureIdentity>;
}

function assertUniquePaths(label: string, entries: ReadonlyArray<{ readonly path: string }>): void {
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error(`${label} paths must be unique.`);
  }
  for (const path of paths) {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`${label} path must be a normalized app-relative path: ${path || "<empty>"}.`);
    }
  }
}

function bytewiseSort(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function assertSamePathSet(
  label: string,
  expected: ReadonlyArray<string>,
  actual: ReadonlyArray<string>,
): void {
  const sortedExpected = bytewiseSort(expected);
  const sortedActual = bytewiseSort(actual);
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error(
      `${label} paths differ from the reviewed allowlist. Expected ${JSON.stringify(sortedExpected)}, got ${JSON.stringify(sortedActual)}.`,
    );
  }
}

function assertCompleteIdentity(label: string, identity: MacSignatureIdentity): void {
  if (!/^[0-9a-f]{40,64}$/i.test(identity.cdHash)) {
    throw new Error(`${label} ${identity.path} has an invalid code-directory hash.`);
  }
  if (new Set(identity.authorities).size !== identity.authorities.length) {
    throw new Error(`${label} ${identity.path} has duplicate signing authorities.`);
  }
  if (identity.scheme === "developer-id" && (!identity.teamId || identity.authorities.length === 0)) {
    throw new Error(`${label} ${identity.path} has incomplete Developer ID evidence.`);
  }
  if (
    identity.scheme === "ad-hoc-only" &&
    (identity.teamId !== null || identity.authorities.length !== 0)
  ) {
    throw new Error(`${label} ${identity.path} is not purely ad-hoc signed.`);
  }
}

export function validateMacUnsignedSignatureReport(
  report: MacUnsignedSignatureReport,
  allowlist: MacSignatureAllowlist,
): MacUnsignedSignatureReport {
  if (report.schemaVersion !== 1 || allowlist.schemaVersion !== 1) {
    throw new Error("Unsupported macOS signature evidence schema version.");
  }
  if (!report.appBundle.endsWith(".app") || report.appBundle.includes("/") || report.appBundle.includes("\\")) {
    throw new Error("macOS signature report must name one top-level app bundle.");
  }
  if (report.electronVersion !== allowlist.electronVersion) {
    throw new Error(
      `macOS signature evidence Electron ${report.electronVersion} does not match reviewed ${allowlist.electronVersion}.`,
    );
  }
  if (report.notarizationTicket !== "absent") {
    throw new Error("Unsigned prerelease app unexpectedly has a notarization ticket.");
  }

  assertUniquePaths("Product-owned signature", report.productOwned);
  assertUniquePaths("Reviewed third-party signature", report.thirdParty);
  assertUniquePaths(
    "Signature allowlist",
    allowlist.productOwnedPaths.map((path) => ({ path })).concat(allowlist.thirdParty),
  );
  assertSamePathSet(
    "Product-owned signature",
    allowlist.productOwnedPaths,
    report.productOwned.map((entry) => entry.path),
  );
  assertSamePathSet(
    "Third-party signature",
    allowlist.thirdParty.map((entry) => entry.path),
    report.thirdParty.map((entry) => entry.path),
  );

  for (const identity of report.productOwned) {
    assertCompleteIdentity("Product-owned signature", identity);
    if (identity.scheme !== "ad-hoc-only") {
      throw new Error(`Product-owned binary ${identity.path} unexpectedly has Developer ID signing.`);
    }
  }

  const expectationsByPath = new Map(allowlist.thirdParty.map((entry) => [entry.path, entry]));
  for (const identity of report.thirdParty) {
    assertCompleteIdentity("Third-party signature", identity);
    const expected = expectationsByPath.get(identity.path);
    if (!expected) {
      throw new Error(`Unreviewed third-party binary: ${identity.path}.`);
    }
    if (
      identity.identifier !== expected.identifier ||
      identity.teamId !== expected.teamId ||
      identity.scheme !== expected.scheme ||
      JSON.stringify(identity.authorities) !== JSON.stringify(expected.authorities)
    ) {
      throw new Error(`Third-party signature identity changed for ${identity.path}.`);
    }
  }

  return report;
}
