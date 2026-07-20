import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  formatQuarantineSummary,
  QUARANTINE_PLATFORMS,
  quarantineSuitesForPlatform,
  validateQuarantineRegistry,
  type QuarantinePlatform,
  type QuarantineRegistry,
} from "./lib/quarantine-registry.ts";

function usage(): never {
  throw new Error(
    "Usage: node scripts/quarantine-registry.ts <validate|run|summary> [--platform <linux|windows>] [--baseline-ref <commit-sha>] [--github-step-summary]",
  );
}

function parseArgs(args: readonly string[]): {
  readonly command: "validate" | "run" | "summary";
  readonly platform?: QuarantinePlatform;
  readonly baselineRef?: string;
  readonly githubStepSummary: boolean;
} {
  const command = args[0];
  if (command !== "validate" && command !== "run" && command !== "summary") usage();
  let platform: QuarantinePlatform | undefined;
  let baselineRef: string | undefined;
  let githubStepSummary = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--platform") {
      const value = args[index + 1];
      if (!QUARANTINE_PLATFORMS.includes(value as QuarantinePlatform)) usage();
      platform = value as QuarantinePlatform;
      index += 1;
    } else if (arg === "--baseline-ref") {
      const value = args[index + 1];
      if (!value || baselineRef !== undefined) usage();
      baselineRef = value;
      index += 1;
    } else if (arg === "--github-step-summary") {
      githubStepSummary = true;
    } else {
      usage();
    }
  }
  if (command === "run" && !platform) usage();
  if (command !== "summary" && githubStepSummary) usage();
  if (command !== "summary" && baselineRef) usage();
  return { command, platform, baselineRef, githubStepSummary };
}

function loadRegistry(repositoryRoot: string): QuarantineRegistry {
  const registryPath = resolve(repositoryRoot, ".github/quarantine.yml");
  const result = validateQuarantineRegistry(readFileSync(registryPath, "utf8"), {
    repositoryRoot,
  });
  if (result.errors.length > 0 || !result.registry) {
    throw new Error(`Quarantine registry validation failed:\n- ${result.errors.join("\n- ")}`);
  }
  return result.registry;
}

function emptyRegistry(): QuarantineRegistry {
  return { schemaVersion: 1, entries: [] };
}

function git(repositoryRoot: string, args: readonly string[]) {
  return spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

function loadBaselineRegistry(
  repositoryRoot: string,
  ref: string,
): { readonly ref: string; readonly registry: QuarantineRegistry } {
  if (!/^[0-9a-f]{40}$/i.test(ref)) {
    throw new Error(`Quarantine baseline ref must be a full commit SHA: ${ref}`);
  }
  if (/^0{40}$/.test(ref)) return { ref, registry: emptyRegistry() };

  const commit = git(repositoryRoot, ["cat-file", "-e", `${ref}^{commit}`]);
  if (commit.error) throw commit.error;
  if (commit.status !== 0) {
    throw new Error(`Quarantine baseline commit is unavailable: ${ref}.`);
  }

  const registryObject = `${ref}:.github/quarantine.yml`;
  const exists = git(repositoryRoot, ["cat-file", "-e", registryObject]);
  if (exists.error) throw exists.error;
  if (exists.status !== 0) return { ref, registry: emptyRegistry() };

  const source = git(repositoryRoot, ["show", registryObject]);
  if (source.error) throw source.error;
  if (source.status !== 0 || typeof source.stdout !== "string") {
    throw new Error(`Unable to read quarantine registry at baseline ${ref}.`);
  }
  const result = validateQuarantineRegistry(source.stdout, {
    repositoryRoot,
    validateSources: false,
  });
  if (result.errors.length > 0 || !result.registry) {
    throw new Error(
      `Baseline quarantine registry validation failed for ${ref}:\n- ${result.errors.join("\n- ")}`,
    );
  }
  return { ref, registry: result.registry };
}

function runSuite(repositoryRoot: string, suite: QuarantineRegistry["entries"][number]["suite"]): void {
  const commands = {
    "browser-geometry": ["run", "--cwd", "apps/web", "test:browser:geometry"],
  } as const;
  const result = spawnSync("bun", commands[suite], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repositoryRoot = process.cwd();
  const registry = loadRegistry(repositoryRoot);
  if (args.command === "validate") {
    console.log(
      `Quarantine registry validation passed for ${registry.entries.length} registered group(s).`,
    );
    return;
  }
  if (args.command === "summary") {
    const baseline = args.baselineRef
      ? loadBaselineRegistry(repositoryRoot, args.baselineRef)
      : undefined;
    const summary = formatQuarantineSummary(registry, { platform: args.platform, baseline });
    process.stdout.write(summary);
    if (args.githubStepSummary) {
      const outputPath = process.env.GITHUB_STEP_SUMMARY;
      if (!outputPath) throw new Error("GITHUB_STEP_SUMMARY is required.");
      appendFileSync(outputPath, summary);
    }
    return;
  }
  for (const suite of quarantineSuitesForPlatform(registry, args.platform!)) {
    runSuite(repositoryRoot, suite);
    if (process.exitCode) return;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
