#!/usr/bin/env node
// FILE: write-release-artifact-provenance.ts
// Purpose: CLI entrypoint for post-build release asset trust proof.
// Layer: Release verification script

import { readFileSync } from "node:fs";

import {
  type ReleaseArtifactPlatform,
  type ReleaseDistributionKind,
  writeReleaseArtifactProvenance,
} from "./lib/release-artifact-provenance.ts";
import type {
  MacSignatureAllowlist,
  MacUnsignedSignatureReport,
} from "./lib/super-synara-macos-signatures.ts";

interface CliOptions {
  readonly assetsDirectory: string;
  readonly platform: ReleaseArtifactPlatform;
  readonly arch: string;
  readonly target: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly sourceTag: string | null;
  readonly lockfileSha256: string;
  readonly publication: boolean;
  readonly signed: boolean;
  readonly distributionKind?: ReleaseDistributionKind;
  readonly distributionRepository?: string;
  readonly distributionPrerelease?: boolean;
  readonly distributionLatest?: boolean;
  readonly updaterFeed?: boolean;
  readonly absorbedUpstreamSha?: string;
  readonly macSignatureReport?: MacUnsignedSignatureReport;
  readonly macSignatureAllowlist?: MacSignatureAllowlist;
  readonly artifactFileNames?: ReadonlyArray<string>;
  readonly outputFileName?: string;
  readonly expectedMacTeamId?: string;
  readonly expectedWindowsPublisher?: string;
  readonly expectedWindowsSubjectDn?: string;
}

function parseBoolean(name: string, value: string | undefined): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function parseOptionalBoolean(name: string, value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : parseBoolean(name, value);
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid artifact provenance argument near ${name ?? "<end>"}.`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate artifact provenance argument: ${name}.`);
    }
    values.set(name, value);
  }

  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing artifact provenance argument: ${name}.`);
    return value;
  };
  const platform = required("--platform");
  if (platform !== "linux" && platform !== "mac" && platform !== "win") {
    throw new Error(`Unsupported artifact provenance platform: ${platform}.`);
  }

  const knownArguments = new Set([
    "--assets-dir",
    "--platform",
    "--arch",
    "--target",
    "--version",
    "--source-commit",
    "--source-tag",
    "--lockfile-sha256",
    "--publication",
    "--signed",
    "--distribution-kind",
    "--distribution-repository",
    "--distribution-prerelease",
    "--distribution-latest",
    "--updater-feed",
    "--absorbed-upstream-sha",
    "--mac-signature-report",
    "--mac-signature-allowlist",
    "--artifact-files",
    "--output-file-name",
    "--expected-mac-team-id",
    "--expected-windows-publisher",
    "--expected-windows-subject-dn",
  ]);
  for (const name of values.keys()) {
    if (!knownArguments.has(name))
      throw new Error(`Unknown artifact provenance argument: ${name}.`);
  }

  const expectedMacTeamId = values.get("--expected-mac-team-id") || undefined;
  const expectedWindowsPublisher = values.get("--expected-windows-publisher") || undefined;
  const expectedWindowsSubjectDn = values.get("--expected-windows-subject-dn") || undefined;
  const distributionKind = values.get("--distribution-kind") || undefined;
  if (
    distributionKind !== undefined &&
    distributionKind !== "build-only" &&
    distributionKind !== "github-unsigned-prerelease" &&
    distributionKind !== "signed-release"
  ) {
    throw new Error(`Unsupported distribution kind: ${distributionKind}.`);
  }
  const macSignatureReportPath = values.get("--mac-signature-report");
  const macSignatureAllowlistPath = values.get("--mac-signature-allowlist");
  if (Boolean(macSignatureReportPath) !== Boolean(macSignatureAllowlistPath)) {
    throw new Error("macOS signature report and allowlist must be provided together.");
  }
  const artifactFileNames = values
    .get("--artifact-files")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    assetsDirectory: required("--assets-dir"),
    platform,
    arch: required("--arch"),
    target: required("--target"),
    version: required("--version"),
    sourceCommit: required("--source-commit"),
    sourceTag: values.get("--source-tag") || null,
    lockfileSha256: required("--lockfile-sha256"),
    publication: parseBoolean("--publication", values.get("--publication")),
    signed: parseBoolean("--signed", values.get("--signed")),
    ...(distributionKind ? { distributionKind } : {}),
    ...(values.get("--distribution-repository")
      ? { distributionRepository: values.get("--distribution-repository")! }
      : {}),
    ...(parseOptionalBoolean("--distribution-prerelease", values.get("--distribution-prerelease")) ===
    undefined
      ? {}
      : {
          distributionPrerelease: parseBoolean(
            "--distribution-prerelease",
            values.get("--distribution-prerelease"),
          ),
        }),
    ...(parseOptionalBoolean("--distribution-latest", values.get("--distribution-latest")) ===
    undefined
      ? {}
      : {
          distributionLatest: parseBoolean(
            "--distribution-latest",
            values.get("--distribution-latest"),
          ),
        }),
    ...(parseOptionalBoolean("--updater-feed", values.get("--updater-feed")) === undefined
      ? {}
      : { updaterFeed: parseBoolean("--updater-feed", values.get("--updater-feed")) }),
    ...(values.get("--absorbed-upstream-sha")
      ? { absorbedUpstreamSha: values.get("--absorbed-upstream-sha")! }
      : {}),
    ...(macSignatureReportPath && macSignatureAllowlistPath
      ? {
          macSignatureReport: JSON.parse(
            readFileSync(macSignatureReportPath, "utf8"),
          ) as MacUnsignedSignatureReport,
          macSignatureAllowlist: JSON.parse(
            readFileSync(macSignatureAllowlistPath, "utf8"),
          ) as MacSignatureAllowlist,
        }
      : {}),
    ...(artifactFileNames && artifactFileNames.length > 0 ? { artifactFileNames } : {}),
    ...(values.get("--output-file-name")
      ? { outputFileName: values.get("--output-file-name")! }
      : {}),
    ...(expectedMacTeamId ? { expectedMacTeamId } : {}),
    ...(expectedWindowsPublisher ? { expectedWindowsPublisher } : {}),
    ...(expectedWindowsSubjectDn ? { expectedWindowsSubjectDn } : {}),
  };
}

const result = await writeReleaseArtifactProvenance(parseArgs(process.argv.slice(2)));
console.log(`Wrote ${result.path}`);
