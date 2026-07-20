// FILE: check-brand-identity.ts
// Purpose: Prevents retired first-party identities from returning to tracked files.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const retiredShortName = characters(116, 51);
const retiredFirstName = `${retiredShortName}${characters(99, 111, 100, 101)}`;
const retiredCompanyName = `${retiredShortName}${characters(116, 111, 111, 108, 115)}`;
const retiredSecondName = characters(100, 112, 99, 111, 100, 101);
const retiredPredecessorName = characters(99, 111, 100, 101, 116, 104, 105, 110, 103);
const incorrectBundleDomain = characters(99, 111, 109, 46, 115, 121, 110, 97, 114, 97);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const joinedWithOptionalSeparator = (left: string, right: string): string =>
  `${escapeRegExp(left)}[\\s._/@:-]*${escapeRegExp(right)}`;

const forbiddenPatterns = [
  new RegExp(
    joinedWithOptionalSeparator(retiredShortName, retiredFirstName.slice(retiredShortName.length)),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(
      retiredShortName,
      retiredCompanyName.slice(retiredShortName.length),
    ),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(retiredSecondName.slice(0, 2), retiredSecondName.slice(2)),
    "i",
  ),
  new RegExp(escapeRegExp(retiredPredecessorName), "i"),
  new RegExp(`@${escapeRegExp(retiredCompanyName)}`, "i"),
  new RegExp(
    `(?:^|[\\s"'\\x60./:@_-])${escapeRegExp(retiredShortName)}(?:$|[\\s"'\\x60./:@_-])`,
    "i",
  ),
  new RegExp(escapeRegExp(incorrectBundleDomain), "i"),
] as const;

// Raster images cannot be searched for embedded text. Keep user-facing screenshots
// and the canonical Super Synara desktop artwork behind reviewed digests so changing
// them requires another explicit visual identity audit.
const approvedVisualAssetDigests = new Map<string, string>([
  [
    "apps/marketing/public/screenshot.jpeg",
    "0b4be139f13dd08885a1aac26fc1f7c623697db157777d16360e985c93d47bcf",
  ],
  [
    "assets/prod/readme-screenshot.jpeg",
    "0b4be139f13dd08885a1aac26fc1f7c623697db157777d16360e985c93d47bcf",
  ],
  [
    "assets/super/super-synara-source.jpg",
    "beaeeb2ea812801acc01365e5ccc999310ee9ea8fb10d1085900cae1d77ab3c4",
  ],
  [
    "assets/super/super-synara-1024.png",
    "ea72cdd5ba37f5f0e274b9f4f8517a3797c007d4d26158706ca41598cdfc2001",
  ],
  [
    "assets/super/super-synara-macos-legacy-1024.png",
    "1bb3f27bb1a143e64a8c7c29fa28e5f8decc1616d190bd0c90d4e8f57943ad6a",
  ],
  [
    "assets/super/super-synara-windows.ico",
    "3f05e1348e6aad6a6eb690be11f2d655676c6005d403759c8eb78afc5186bf0a",
  ],
]);

export interface BrandIdentityFile {
  readonly path: string;
  readonly contents: string;
}

export interface BrandIdentityViolation {
  readonly path: string;
  readonly line: number | null;
  readonly text: string;
}

export interface BrandIdentityBinaryFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

function containsForbiddenIdentity(value: string): boolean {
  return forbiddenPatterns.some((pattern) => pattern.test(value));
}

export function findBrandIdentityViolations(
  files: readonly BrandIdentityFile[],
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  for (const file of files) {
    if (containsForbiddenIdentity(file.path)) {
      violations.push({ path: file.path, line: null, text: file.path });
    }
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      if (!containsForbiddenIdentity(line)) continue;
      violations.push({ path: file.path, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

export function findVisualBrandAssetViolations(
  files: readonly BrandIdentityBinaryFile[],
  approvedDigests: ReadonlyMap<string, string> = approvedVisualAssetDigests,
): BrandIdentityViolation[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const violations: BrandIdentityViolation[] = [];
  for (const [path, approvedDigest] of approvedDigests) {
    const file = filesByPath.get(path);
    if (!file) {
      violations.push({
        path,
        line: null,
        text: "Required visual brand asset is missing.",
      });
      continue;
    }
    const digest = createHash("sha256").update(file.contents).digest("hex");
    if (digest !== approvedDigest) {
      violations.push({
        path,
        line: null,
        text: "Visual brand asset changed; perform a visual identity review before approving it.",
      });
    }
  }
  return violations;
}

function readTrackedFiles(): BrandIdentityBinaryFile[] {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  return paths.map((path) => ({ path, contents: readFileSync(path) }));
}

function main(): void {
  const trackedFiles = readTrackedFiles();
  const searchableFiles = trackedFiles.map((file) => ({
    path: file.path,
    contents: file.contents.includes(0) ? "" : Buffer.from(file.contents).toString("utf8"),
  }));
  const violations = [
    ...findBrandIdentityViolations(searchableFiles),
    ...findVisualBrandAssetViolations(trackedFiles),
  ];
  if (violations.length === 0) {
    console.log("Synara identity check passed.");
    return;
  }

  console.error("Retired first-party identity found:");
  for (const violation of violations) {
    const location =
      violation.line === null ? violation.path : `${violation.path}:${violation.line}`;
    console.error(`- ${location}: ${violation.text}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
