#!/usr/bin/env node
// FILE: collect-super-synara-macos-signatures.ts
// Purpose: Collects every signed macOS code object and validates it against a reviewed allowlist.
// Layer: Native release verification

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import {
  type MacDiskImageEvidence,
  type MacSignatureAuditInventory,
  type MacSignatureAllowlist,
  type MacSignatureIdentity,
  type MacUnsignedSignatureReport,
  classifyMacSignatureCandidateFileDescription,
  classifyMacNotarizationTicket,
  collectMacSignatureCandidatePaths,
  validateMacSignatureAllowlist,
  validateMacSignatureAuditInventory,
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
  readonly mode: "audit" | "admit";
  readonly dmg: string;
  readonly electronVersion: string;
  readonly allowlist: string | null;
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
  const known = new Set(["--mode", "--dmg", "--electron-version", "--allowlist", "--output"]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown macOS signature argument: ${name}.`);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing macOS signature argument: ${name}.`);
    return value;
  };
  const mode = required("--mode");
  if (mode !== "audit" && mode !== "admit") {
    throw new Error(`macOS signature mode must be audit or admit, got ${mode}.`);
  }
  const allowlist = values.get("--allowlist") || null;
  if (mode === "admit" && allowlist === null) {
    throw new Error("Admission mode requires --allowlist with a committed reviewed policy.");
  }
  if (mode === "audit" && allowlist !== null) {
    throw new Error("Audit mode does not accept an allowlist; it produces unclassified evidence.");
  }
  return {
    mode,
    dmg: required("--dmg"),
    electronVersion: required("--electron-version"),
    allowlist,
    output: required("--output"),
  };
}

function hashFileSha256(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function parseSignature(path: string, appBundlePath: string): MacSignatureIdentity {
  const result = run("codesign", ["-d", "--verbose=4", path], true);
  if (result.status !== 0) {
    throw new Error(`Signed code candidate lacks readable codesign identity: ${path}.`);
  }
  const value = (name: string): string | null =>
    new RegExp(`^${name}=(.*)$`, "m").exec(result.output)?.[1]?.trim() || null;
  const teamIdValue = value("TeamIdentifier");
  const teamId = !teamIdValue || teamIdValue === "not set" ? null : teamIdValue;
  const authorities = [...result.output.matchAll(/^Authority=(.*)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((entry): entry is string => Boolean(entry));
  const cdHash = value("CDHash");
  if (!cdHash) throw new Error(`codesign returned no CDHash for ${path}.`);
  const signature = value("Signature");
  const scheme = teamId || authorities.length > 0 ? "developer-id" : "ad-hoc-only";
  if (scheme === "ad-hoc-only" && signature !== "adhoc") {
    throw new Error(`Signed code candidate lacks explicit Signature=adhoc evidence: ${path}.`);
  }
  return {
    path: path === appBundlePath ? "." : relative(appBundlePath, path).replaceAll("\\", "/"),
    identifier: value("Identifier"),
    teamId,
    authorities,
    cdHash,
    signature,
    scheme,
  };
}

function signedCodeCandidatePaths(appBundlePath: string): ReadonlyArray<string> {
  return collectMacSignatureCandidatePaths(appBundlePath).filter((path) => {
    if (lstatSync(path).isDirectory()) return true;
    const fileType = run("/usr/bin/file", ["-b", path], true);
    if (fileType.status !== 0) {
      throw new Error(`Could not classify executable candidate ${path}: ${fileType.output}.`);
    }
    const candidatePath = relative(appBundlePath, path).replaceAll("\\", "/");
    return (
      classifyMacSignatureCandidateFileDescription(fileType.output, candidatePath) === "mach-o"
    );
  });
}

function inspectDiskImageCodeSignature(
  diskImagePath: string,
): MacDiskImageEvidence["codeSignature"] {
  const result = run("codesign", ["-d", "--verbose=4", diskImagePath], true);
  const value = (name: string): string | null =>
    new RegExp(`^${name}=(.*)$`, "m").exec(result.output)?.[1]?.trim() || null;
  const teamIdValue = value("TeamIdentifier");
  const teamId = !teamIdValue || teamIdValue === "not set" ? null : teamIdValue;
  const authorities = [...result.output.matchAll(/^Authority=(.*)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((entry): entry is string => Boolean(entry));
  if (result.status !== 0) {
    return {
      command: "codesign -d --verbose=4",
      exitCode: result.status,
      output: result.output,
      status: /code object is not signed at all/i.test(result.output)
        ? "unsigned"
        : "indeterminate",
      teamId,
      authorities,
      cdHash: value("CDHash"),
      signature: value("Signature"),
    };
  }
  const signature = value("Signature");
  return {
    command: "codesign -d --verbose=4",
    exitCode: result.status,
    output: result.output,
    status:
      teamId || authorities.length > 0
        ? "developer-id"
        : signature === "adhoc"
          ? "ad-hoc-only"
          : "indeterminate",
    teamId,
    authorities,
    cdHash: value("CDHash"),
    signature,
  };
}

if (process.platform !== "darwin") {
  throw new Error("macOS signature collection must run on a macOS host.");
}
const options = parseArgs(process.argv.slice(2));
const extractionRoot = mkdtempSync(join(tmpdir(), "super-synara-signatures-"));
const mountPoint = join(extractionRoot, "mounted-dmg");
let mounted = false;
let inspectionFailure: Error | null = null;
let detachFailure: Error | null = null;
let removalFailure: Error | null = null;
try {
  const diskImageStat = lstatSync(options.dmg);
  if (!diskImageStat.isFile() || diskImageStat.isSymbolicLink()) {
    throw new Error(`macOS signature input must be a regular DMG file: ${options.dmg}.`);
  }
  mkdirSync(mountPoint);
  run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, options.dmg]);
  mounted = true;
  const appBundles = readdirSync(mountPoint).filter((entry) => {
    const candidate = join(mountPoint, entry);
    return entry.endsWith(".app") && lstatSync(candidate).isDirectory();
  });
  if (appBundles.length !== 1) {
    throw new Error(`Expected exactly one top-level app bundle, found ${appBundles.length}.`);
  }
  const appBundle = appBundles[0]!;
  if (appBundle !== "Super Synara.app") {
    throw new Error(`Expected locked Super Synara.app in DMG, found ${appBundle}.`);
  }
  const appBundlePath = join(mountPoint, appBundle);
  const deepVerification = run(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appBundlePath],
    true,
  );

  const signatures = [appBundlePath, ...signedCodeCandidatePaths(appBundlePath)].map((path) =>
    parseSignature(path, appBundlePath),
  );
  const appNotarization = run("xcrun", ["stapler", "validate", appBundlePath], true);
  const diskImageNotarization = run("xcrun", ["stapler", "validate", options.dmg], true);
  const appNotarizationEvidence = {
    command: "xcrun stapler validate" as const,
    exitCode: appNotarization.status,
    output: appNotarization.output,
  };
  const diskImageNotarizationEvidence = {
    command: "xcrun stapler validate" as const,
    exitCode: diskImageNotarization.status,
    output: diskImageNotarization.output,
  };
  const diskImage = {
    fileName: basename(options.dmg),
    size: diskImageStat.size,
    sha256: await hashFileSha256(options.dmg),
    codeSignature: inspectDiskImageCodeSignature(options.dmg),
  };
  if (options.mode === "audit") {
    const inventory: MacSignatureAuditInventory = {
      schemaVersion: 2,
      kind: "macos-signature-audit-inventory",
      diskImage,
      appBundle,
      electronVersion: options.electronVersion,
      deepVerification: {
        command: "codesign --verify --deep --strict --verbose=4",
        exitCode: deepVerification.status,
        output: deepVerification.output,
      },
      notarization: {
        diskImage: {
          ticket: classifyMacNotarizationTicket(diskImageNotarizationEvidence),
          evidence: diskImageNotarizationEvidence,
        },
        appBundle: {
          ticket: classifyMacNotarizationTicket(appNotarizationEvidence),
          evidence: appNotarizationEvidence,
        },
      },
      codeObjects: signatures,
    };
    validateMacSignatureAuditInventory(inventory);
    writeFileSync(options.output, `${JSON.stringify(inventory, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    console.log(`Wrote unclassified macOS signature audit inventory to ${options.output}.`);
  } else {
    if (deepVerification.status !== 0) {
      throw new Error(
        `Strict macOS code-signature verification failed: ${deepVerification.output}`,
      );
    }
    const allowlist = validateMacSignatureAllowlist(
      JSON.parse(readFileSync(options.allowlist!, "utf8")) as MacSignatureAllowlist,
    );
    if (allowlist.electronVersion !== options.electronVersion) {
      throw new Error(
        `Requested Electron ${options.electronVersion} does not match reviewed ${allowlist.electronVersion}.`,
      );
    }
    const productPaths = new Set(allowlist.productOwnedPaths);
    const report: MacUnsignedSignatureReport = {
      schemaVersion: 2,
      diskImage,
      appBundle,
      electronVersion: options.electronVersion,
      deepVerification: {
        command: "codesign --verify --deep --strict --verbose=4",
        exitCode: deepVerification.status,
        output: deepVerification.output,
      },
      notarization: {
        diskImage: {
          ticket: classifyMacNotarizationTicket(diskImageNotarizationEvidence),
          evidence: diskImageNotarizationEvidence,
        },
        appBundle: {
          ticket: classifyMacNotarizationTicket(appNotarizationEvidence),
          evidence: appNotarizationEvidence,
        },
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
  }
} catch (cause) {
  inspectionFailure = cause instanceof Error ? cause : new Error(String(cause));
} finally {
  if (mounted) {
    try {
      const detached = run("hdiutil", ["detach", mountPoint], true);
      if (detached.status !== 0) {
        detachFailure = new Error(`Could not detach inspected DMG: ${detached.output}.`);
      }
    } catch (cause) {
      detachFailure = cause instanceof Error ? cause : new Error(String(cause));
    }
  }
  try {
    rmSync(extractionRoot, { recursive: true, force: true });
  } catch (cause) {
    removalFailure = cause instanceof Error ? cause : new Error(String(cause));
  }
}
if (detachFailure || removalFailure) {
  throw new AggregateError(
    [inspectionFailure, detachFailure, removalFailure].filter(
      (error): error is Error => error !== null,
    ),
    "macOS signature inspection cleanup failed.",
  );
}
if (inspectionFailure) throw inspectionFailure;
