import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  createQuarantineInventoryEnvironment,
  formatQuarantineSummary,
  parseVitestQuarantineInventory,
  QUARANTINE_PLATFORMS,
  quarantineSuitesForPlatform,
  validateQuarantineCaseInventory,
  validateQuarantineRegistry,
  type QuarantinePlatform,
  type QuarantineRegistry,
} from "./lib/quarantine-registry.ts";

function usage(): never {
  throw new Error(
    "Usage: node scripts/quarantine-registry.ts <validate|inventory|run|summary> [--platform <linux|windows>] [--baseline-ref <commit-sha>] [--github-step-summary]",
  );
}

function parseArgs(args: readonly string[]): {
  readonly command: "validate" | "inventory" | "run" | "summary";
  readonly platform?: QuarantinePlatform;
  readonly baselineRef?: string;
  readonly githubStepSummary: boolean;
} {
  const command = args[0];
  if (
    command !== "validate" &&
    command !== "inventory" &&
    command !== "run" &&
    command !== "summary"
  )
    usage();
  let platform: QuarantinePlatform | undefined;
  let baselineRef: string | undefined;
  let githubStepSummary = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--platform") {
      const value = args[index + 1];
      if (platform !== undefined || !QUARANTINE_PLATFORMS.includes(value as QuarantinePlatform))
        usage();
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
  if ((command === "inventory" || command === "run") && !platform) usage();
  if (command !== "summary" && githubStepSummary) usage();
  if (command !== "summary" && baselineRef) usage();
  return {
    command,
    ...(platform === undefined ? {} : { platform }),
    ...(baselineRef === undefined ? {} : { baselineRef }),
    githubStepSummary,
  };
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

function runSuite(
  repositoryRoot: string,
  suite: QuarantineRegistry["entries"][number]["suite"],
): void {
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

function runtimeQuarantinePlatform(): QuarantinePlatform | null {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  return null;
}

function collectQuarantineInventory(
  repositoryRoot: string,
  platform: QuarantinePlatform,
  registry: QuarantineRegistry,
) {
  const runtimePlatform = runtimeQuarantinePlatform();
  if (runtimePlatform !== platform) {
    throw new Error(
      `Quarantine inventory requested ${platform}, but this runner is ${runtimePlatform ?? process.platform}.`,
    );
  }
  const webRoot = resolve(repositoryRoot, "apps/web");
  const vitestCli = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
  const registeredPaths = [
    ...new Set(registry.entries.map((entry) => resolve(repositoryRoot, entry.path))),
  ];
  if (registeredPaths.length === 0) return [];
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "synara-quarantine-inventory-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        vitestCli,
        "list",
        ...registeredPaths,
        "--config",
        "vitest.browser.config.ts",
        "--json",
      ],
      {
        cwd: webRoot,
        encoding: "utf8",
        env: createQuarantineInventoryEnvironment(
          process.env,
          resolve(temporaryDirectory, "routeTree.gen.ts"),
        ),
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
    );
    return parseVitestQuarantineInventory(
      {
        ...(result.error ? { error: result.error } : {}),
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      },
      { repositoryRoot },
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
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
  if (args.command === "inventory") {
    const inventory = collectQuarantineInventory(repositoryRoot, args.platform!, registry);
    const errors = validateQuarantineCaseInventory(registry, inventory);
    if (errors.length > 0) {
      throw new Error(`Quarantine case inventory validation failed:\n- ${errors.join("\n- ")}`);
    }
    console.log(
      `Quarantine case inventory validation passed for ${registry.entries.length} registered group(s) on ${args.platform}.`,
    );
    return;
  }
  if (args.command === "summary") {
    const baseline = args.baselineRef
      ? loadBaselineRegistry(repositoryRoot, args.baselineRef)
      : undefined;
    const summary = formatQuarantineSummary(registry, {
      ...(args.platform === undefined ? {} : { platform: args.platform }),
      ...(baseline === undefined ? {} : { baseline }),
    });
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
