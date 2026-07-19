#!/usr/bin/env node
// FILE: collect-super-synara-macos-signatures.ts
// Purpose: Collects every signed macOS code object and validates it against a reviewed allowlist.
// Layer: Native release verification

import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  type MacSignatureAllowlist,
  type MacSignatureIdentity,
  type MacUnsignedSignatureReport,
  validateMacUnsignedSignatureReport,
} from "./lib/super-synara-macos-signatures.ts";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function run(
  command: string,
  args: ReadonlyArray<string>,
  allowFailure = false,
): { readonly status: number; readonly output: string } {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    shell: false,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  const status = result.status ?? -1;
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (!allowFailure && status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${output}`);
  }
  return { status, output };
}

function parseArgs(argv: ReadonlyArray<string>): {
  readonly zip: string;
  readonly allowlist: string;
  readonly output: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid macOS signature argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  const known = new Set(["--zip", "--allowlist", "--output"]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown macOS signature argument: ${name}.`);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing macOS signature argument: ${name}.`);
    return value;
  };
  return {
    zip: required("--zip"),
    allowlist: required("--allowlist"),
    output: required("--output"),
  };
}

function candidateFiles(root: string): string[] {
  const candidates: string[] = [];
  const visit = (directory: string): void => {
    for (const entryName of readdirSync(directory)) {
      const path = join(directory, entryName);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile() &&
        ((entry.mode & 0o111) !== 0 || /\.(?:dylib|node|so)$/i.test(entryName))
      ) {
        candidates.push(path);
      }
    }
  };
  visit(root);
  return candidates;
}

function parseSignature(path: string, appBundlePath: string): MacSignatureIdentity | null {
  const result = run("codesign", ["-d", "--verbose=4", path], true);
  if (result.status !== 0) return null;
  const value = (name: string): string | null =>
    new RegExp(`^${name}=(.*)$`, "m").exec(result.output)?.[1]?.trim() || null;
  const teamIdValue = value("TeamIdentifier");
  const teamId = !teamIdValue || teamIdValue === "not set" ? null : teamIdValue;
  const authorities = [...result.output.matchAll(/^Authority=(.*)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((entry): entry is string => Boolean(entry));
  const cdHash = value("CDHash");
  if (!cdHash) throw new Error(`codesign returned no CDHash for ${path}.`);
  return {
    path: path === appBundlePath ? "." : relative(appBundlePath, path).replaceAll("\\", "/"),
    identifier: value("Identifier"),
    teamId,
    authorities,
    cdHash,
    scheme: teamId || authorities.length > 0 ? "developer-id" : "ad-hoc-only",
  };
}

if (process.platform !== "darwin") {
  throw new Error("macOS signature collection must run on a macOS host.");
}
const options = parseArgs(process.argv.slice(2));
const allowlist = JSON.parse(readFileSync(options.allowlist, "utf8")) as MacSignatureAllowlist;
const extractionRoot = mkdtempSync(join(tmpdir(), "super-synara-signatures-"));
try {
  run("ditto", ["-x", "-k", options.zip, extractionRoot]);
  const appBundles = readdirSync(extractionRoot).filter((entry) => {
    const candidate = join(extractionRoot, entry);
    return entry.endsWith(".app") && lstatSync(candidate).isDirectory();
  });
  if (appBundles.length !== 1) {
    throw new Error(`Expected exactly one top-level app bundle, found ${appBundles.length}.`);
  }
  const appBundle = appBundles[0]!;
  const appBundlePath = join(extractionRoot, appBundle);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appBundlePath]);

  const signatures = [appBundlePath, ...candidateFiles(appBundlePath)]
    .map((path) => parseSignature(path, appBundlePath))
    .filter((identity): identity is MacSignatureIdentity => identity !== null);
  const productPaths = new Set(allowlist.productOwnedPaths);
  const notarization = run("xcrun", ["stapler", "validate", appBundlePath], true);
  const report: MacUnsignedSignatureReport = {
    schemaVersion: 1,
    appBundle,
    electronVersion: allowlist.electronVersion,
    notarizationTicket: notarization.status === 0 ? "present" : "absent",
    notarizationEvidence: {
      command: "xcrun stapler validate",
      exitCode: notarization.status,
      output: notarization.output,
    },
    productOwned: signatures.filter((identity) => productPaths.has(identity.path)),
    thirdParty: signatures.filter((identity) => !productPaths.has(identity.path)),
  };
  validateMacUnsignedSignatureReport(report, allowlist);
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(`Wrote reviewed macOS signature evidence to ${options.output}.`);
} finally {
  rmSync(extractionRoot, { recursive: true, force: true });
}
