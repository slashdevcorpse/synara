// FILE: super-synara-macos-signatures.ts
// Purpose: Validates fail-closed macOS ad-hoc and reviewed-vendor signature evidence.
// Layer: Release/build helper

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SYNARA_SUPER_BUNDLE_ID } from "@synara/shared/desktopIdentity";

export const SUPER_SYNARA_PRODUCT_OWNED_MAC_SIGNATURE_PATHS = [
  ".",
  "Contents/MacOS/Super Synara",
  "Contents/Helpers/synara-appsnap-helper",
] as const;

const MISSING_NOTARIZATION_TICKET_EXIT_CODE = 65;
const MISSING_NOTARIZATION_TICKET_QUERY =
  /CloudKit query for .+ failed due to ["“]Record not found["”]\./i;
const MISSING_NOTARIZATION_TICKET_RESPONSE =
  /Could not find base64 encoded ticket in response for /i;
const MISSING_NOTARIZATION_TICKET_STAPLER = /^[^\r\n]+ does not have a ticket stapled to it\.$/im;
const AMBIGUOUS_NOTARIZATION_FAILURE =
  /Could not validate ticket|NSURLError|timed?\s*out|Could not establish secure connection/i;
const SIGNED_BUNDLE_DIRECTORY = /\.(?:app|bundle|framework|xpc)$/i;

export interface MacSignatureIdentity {
  readonly path: string;
  readonly identifier: string | null;
  readonly teamId: string | null;
  readonly authorities: ReadonlyArray<string>;
  readonly cdHash: string;
  readonly signature: string | null;
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

export interface MacSignatureAuditInventory {
  readonly schemaVersion: 2;
  readonly kind: "macos-signature-audit-inventory";
  readonly diskImage: MacDiskImageEvidence;
  readonly appBundle: string;
  readonly electronVersion: string;
  readonly deepVerification: {
    readonly command: "codesign --verify --deep --strict --verbose=4";
    readonly exitCode: number;
    readonly output: string;
  };
  readonly notarization: MacNotarizationTargets;
  readonly codeObjects: ReadonlyArray<MacSignatureIdentity>;
}

export interface MacDiskImageEvidence {
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
  readonly codeSignature: {
    readonly command: "codesign -d --verbose=4";
    readonly exitCode: number;
    readonly output: string;
    readonly status: "unsigned" | "ad-hoc-only" | "developer-id" | "indeterminate";
    readonly teamId: string | null;
    readonly authorities: ReadonlyArray<string>;
    readonly cdHash: string | null;
    readonly signature: string | null;
  };
}

export interface MacNotarizationEvidence {
  readonly command: "xcrun stapler validate";
  readonly exitCode: number;
  readonly output: string;
}

export type MacNotarizationTicketState = "absent" | "present" | "indeterminate";

export interface MacNotarizationTargets {
  readonly diskImage: {
    readonly ticket: MacNotarizationTicketState;
    readonly evidence: MacNotarizationEvidence;
  };
  readonly appBundle: {
    readonly ticket: MacNotarizationTicketState;
    readonly evidence: MacNotarizationEvidence;
  };
}

export interface MacUnsignedSignatureReport {
  readonly schemaVersion: 2;
  readonly diskImage: MacDiskImageEvidence;
  readonly appBundle: string;
  readonly electronVersion: string;
  readonly deepVerification: {
    readonly command: "codesign --verify --deep --strict --verbose=4";
    readonly exitCode: number;
    readonly output: string;
  };
  readonly notarization: MacNotarizationTargets;
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
      throw new Error(
        `${label} path must be a normalized app-relative path: ${path || "<empty>"}.`,
      );
    }
  }
}

function bytewiseSort(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return values.toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
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
  if (
    identity.scheme === "developer-id" &&
    (!identity.teamId || identity.authorities.length === 0)
  ) {
    throw new Error(`${label} ${identity.path} has incomplete Developer ID evidence.`);
  }
  if (
    identity.scheme === "ad-hoc-only" &&
    (identity.teamId !== null ||
      identity.authorities.length !== 0 ||
      identity.signature !== "adhoc")
  ) {
    throw new Error(`${label} ${identity.path} lacks explicit purely ad-hoc signature evidence.`);
  }
}

function isSuperSynaraProductIdentity(input: {
  readonly path: string;
  readonly identifier: string | null;
}): boolean {
  return (
    /(?:^|\/)Super Synara Helper[^/]*(?:\/|$)/.test(input.path) ||
    input.identifier === SYNARA_SUPER_BUNDLE_ID ||
    input.identifier?.startsWith(`${SYNARA_SUPER_BUNDLE_ID}.`) === true
  );
}

export function hasExplicitMissingNotarizationTicketEvidence(evidence: {
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
}): boolean {
  const hasCloudKitAbsence =
    MISSING_NOTARIZATION_TICKET_QUERY.test(evidence.output) &&
    MISSING_NOTARIZATION_TICKET_RESPONSE.test(evidence.output);
  return (
    evidence.command === "xcrun stapler validate" &&
    evidence.exitCode === MISSING_NOTARIZATION_TICKET_EXIT_CODE &&
    (hasCloudKitAbsence || MISSING_NOTARIZATION_TICKET_STAPLER.test(evidence.output)) &&
    !AMBIGUOUS_NOTARIZATION_FAILURE.test(evidence.output)
  );
}

export function classifyMacNotarizationTicket(
  evidence: MacNotarizationEvidence,
): MacNotarizationTicketState {
  if (evidence.exitCode === 0) return "present";
  return hasExplicitMissingNotarizationTicketEvidence(evidence) ? "absent" : "indeterminate";
}

export function collectMacSignatureCandidatePaths(root: string): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const visit = (directory: string): void => {
    for (const entryName of readdirSync(directory)) {
      const path = join(directory, entryName);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SIGNED_BUNDLE_DIRECTORY.test(entryName)) candidates.add(path);
        visit(path);
      } else if (
        entry.isFile() &&
        ((entry.mode & 0o111) !== 0 || /\.(?:dylib|node|so)$/i.test(entryName))
      ) {
        candidates.add(path);
      }
    }
  };
  visit(root);
  return [...candidates].toSorted((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

export function classifyMacSignatureCandidateFileDescription(
  description: string,
  candidatePath?: string,
): "mach-o" | "script" {
  if (/\bMach-O\b/i.test(description)) return "mach-o";
  if (/\bscript\b|\btext executable\b/i.test(description)) return "script";
  throw new Error(
    `Executable candidate${candidatePath ? ` ${candidatePath}` : ""} has unsupported native file type: ${description}.`,
  );
}

function assertDiskImageEvidence(evidence: MacDiskImageEvidence): void {
  if (
    !/^Super-Synara-\d+\.\d+\.\d+-super\.[1-9]\d*-macos-arm64-unsigned\.dmg$/.test(
      evidence.fileName,
    ) ||
    !Number.isSafeInteger(evidence.size) ||
    evidence.size <= 0 ||
    !/^[0-9a-f]{64}$/.test(evidence.sha256)
  ) {
    throw new Error("macOS signature evidence has invalid disk-image identity evidence.");
  }
  const signature = evidence.codeSignature;
  if (
    signature.command !== "codesign -d --verbose=4" ||
    !Number.isInteger(signature.exitCode) ||
    signature.teamId !== null ||
    signature.authorities.length !== 0 ||
    (signature.status !== "unsigned" && signature.status !== "ad-hoc-only")
  ) {
    throw new Error("macOS disk image must be unsigned or purely ad-hoc signed.");
  }
  if (
    signature.status === "unsigned" &&
    (signature.exitCode === 0 || !/code object is not signed at all/i.test(signature.output))
  ) {
    throw new Error("macOS disk image lacks explicit unsigned codesign evidence.");
  }
  if (
    signature.status === "ad-hoc-only" &&
    (signature.exitCode !== 0 ||
      signature.signature !== "adhoc" ||
      !signature.cdHash ||
      !/^[0-9a-f]{40,64}$/i.test(signature.cdHash))
  ) {
    throw new Error("macOS disk image has incomplete ad-hoc codesign evidence.");
  }
}

export function validateMacSignatureAuditInventory(
  inventory: MacSignatureAuditInventory,
): MacSignatureAuditInventory {
  if (inventory.schemaVersion !== 2 || inventory.kind !== "macos-signature-audit-inventory") {
    throw new Error("Unsupported macOS signature audit inventory schema.");
  }
  assertDiskImageEvidence(inventory.diskImage);
  if (inventory.appBundle !== "Super Synara.app") {
    throw new Error("macOS signature audit must name the locked Super Synara.app bundle.");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(inventory.electronVersion)) {
    throw new Error("macOS signature audit must record an explicit Electron version.");
  }
  if (
    inventory.deepVerification.command !== "codesign --verify --deep --strict --verbose=4" ||
    !Number.isInteger(inventory.deepVerification.exitCode)
  ) {
    throw new Error("macOS signature audit has invalid deep-verification evidence.");
  }
  for (const target of [inventory.notarization.diskImage, inventory.notarization.appBundle]) {
    if (
      target.evidence.command !== "xcrun stapler validate" ||
      !Number.isInteger(target.evidence.exitCode)
    ) {
      throw new Error("macOS signature audit has invalid notarization evidence.");
    }
    if (target.ticket !== classifyMacNotarizationTicket(target.evidence)) {
      throw new Error("macOS signature audit misclassifies notarization ticket evidence.");
    }
  }
  if (inventory.codeObjects.length === 0) {
    throw new Error("macOS signature audit found no signed code objects.");
  }
  assertUniquePaths("Audited signature", inventory.codeObjects);
  for (const identity of inventory.codeObjects) {
    assertCompleteIdentity("Audited signature", identity);
  }
  return inventory;
}

export function validateMacSignatureAllowlist(
  allowlist: MacSignatureAllowlist,
): MacSignatureAllowlist {
  if (allowlist.schemaVersion !== 1) {
    throw new Error("Unsupported macOS signature allowlist schema version.");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(allowlist.electronVersion)) {
    throw new Error("macOS signature allowlist must pin an explicit Electron version.");
  }
  if (allowlist.productOwnedPaths.length === 0 || allowlist.thirdParty.length === 0) {
    throw new Error(
      "macOS signature allowlist must contain reviewed product-owned and third-party paths.",
    );
  }
  const productOwnedPaths = new Set(allowlist.productOwnedPaths);
  const misclassifiedProduct = allowlist.thirdParty.find(isSuperSynaraProductIdentity);
  if (misclassifiedProduct) {
    throw new Error(
      `Super Synara product identity ${misclassifiedProduct.path} must not be classified as third-party.`,
    );
  }
  for (const protectedPath of SUPER_SYNARA_PRODUCT_OWNED_MAC_SIGNATURE_PATHS) {
    if (!productOwnedPaths.has(protectedPath)) {
      throw new Error(
        `macOS signature allowlist must classify locked Super Synara path ${protectedPath} as product-owned.`,
      );
    }
    if (allowlist.thirdParty.some((entry) => entry.path === protectedPath)) {
      throw new Error(
        `Locked Super Synara path ${protectedPath} must not be classified as third-party.`,
      );
    }
  }
  assertUniquePaths(
    "Signature allowlist",
    allowlist.productOwnedPaths.map((path) => ({ path })).concat(allowlist.thirdParty),
  );
  return allowlist;
}

export function validateMacUnsignedSignatureReport(
  report: MacUnsignedSignatureReport,
  allowlist: MacSignatureAllowlist,
): MacUnsignedSignatureReport {
  if (report.schemaVersion !== 2) {
    throw new Error("Unsupported macOS signature evidence schema version.");
  }
  validateMacSignatureAllowlist(allowlist);
  if (report.appBundle !== "Super Synara.app") {
    throw new Error("macOS signature report must name the locked Super Synara.app bundle.");
  }
  assertDiskImageEvidence(report.diskImage);
  if (
    report.deepVerification.command !== "codesign --verify --deep --strict --verbose=4" ||
    report.deepVerification.exitCode !== 0
  ) {
    throw new Error(
      "macOS signature admission requires successful strict deep verification evidence.",
    );
  }
  if (report.electronVersion !== allowlist.electronVersion) {
    throw new Error(
      `macOS signature evidence Electron ${report.electronVersion} does not match reviewed ${allowlist.electronVersion}.`,
    );
  }
  for (const [label, target] of [
    ["disk image", report.notarization.diskImage],
    ["app bundle", report.notarization.appBundle],
  ] as const) {
    if (target.ticket !== "absent") {
      throw new Error(`Unsigned prerelease ${label} unexpectedly has a notarization ticket.`);
    }
    if (!hasExplicitMissingNotarizationTicketEvidence(target.evidence)) {
      throw new Error(
        `Unsigned prerelease ${label} lacks fail-closed notarization-ticket absence evidence.`,
      );
    }
  }

  assertUniquePaths("Product-owned signature", report.productOwned);
  assertUniquePaths("Reviewed third-party signature", report.thirdParty);
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
      throw new Error(
        `Product-owned binary ${identity.path} unexpectedly has Developer ID signing.`,
      );
    }
  }

  const mainBundleIdentity = report.productOwned.find((identity) => identity.path === ".");
  if (mainBundleIdentity?.identifier !== SYNARA_SUPER_BUNDLE_ID) {
    throw new Error(
      `Product-owned main bundle identifier must be ${SYNARA_SUPER_BUNDLE_ID}, got ${mainBundleIdentity?.identifier ?? "<missing>"}.`,
    );
  }

  const expectationsByPath = new Map(allowlist.thirdParty.map((entry) => [entry.path, entry]));
  for (const identity of report.thirdParty) {
    assertCompleteIdentity("Third-party signature", identity);
    if (isSuperSynaraProductIdentity(identity)) {
      throw new Error(
        `Super Synara product identity ${identity.path} must not be classified as third-party.`,
      );
    }
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
