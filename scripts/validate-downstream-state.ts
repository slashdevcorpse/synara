import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  parseJsonCompatibleYaml,
  validateDownstreamState,
  type CommitGraph,
} from "./lib/downstream-state.ts";

function resolveRepositoryRoot(args: readonly string[]): string {
  if (args.length === 0) return process.cwd();
  if (args.length === 2 && args[0] === "--repository-root") return resolve(args[1]!);
  throw new Error("Usage: node scripts/validate-downstream-state.ts [--repository-root <path>]");
}

function createCommitGraph(repositoryRoot: string): CommitGraph {
  const git = (args: readonly string[]): string =>
    execFileSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" }).trim();
  const headSha = git(["rev-parse", "HEAD"]);
  return {
    headSha,
    commitExists(sha) {
      return (
        spawnSync("git", ["-C", repositoryRoot, "cat-file", "-e", `${sha}^{commit}`], {
          stdio: "ignore",
        }).status === 0
      );
    },
    isAncestor(ancestor, descendant) {
      return (
        spawnSync(
          "git",
          ["-C", repositoryRoot, "merge-base", "--is-ancestor", ancestor, descendant],
          { stdio: "ignore" },
        ).status === 0
      );
    },
  };
}

function resolveAssessment(repositoryRoot: string, repositoryPath: string): string {
  if (isAbsolute(repositoryPath)) throw new Error("Assessment path must be repository-relative.");
  const absolutePath = resolve(repositoryRoot, repositoryPath);
  const relativePath = relative(repositoryRoot, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(`Assessment path escapes the repository: ${repositoryPath}`);
  }
  return absolutePath;
}

function main(): void {
  const repositoryRoot = resolveRepositoryRoot(process.argv.slice(2));
  const inventoryPath = resolve(repositoryRoot, "docs/downstream/patches.yml");
  const statePath = resolve(repositoryRoot, "docs/downstream/upstream-state.json");
  const inventory = parseJsonCompatibleYaml(
    readFileSync(inventoryPath, "utf8"),
    "docs/downstream/patches.yml",
  );
  const state = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  const result = validateDownstreamState(inventory, state, {
    commits: createCommitGraph(repositoryRoot),
    assessments: {
      exists(path) {
        return existsSync(resolveAssessment(repositoryRoot, path));
      },
      read(path) {
        return readFileSync(resolveAssessment(repositoryRoot, path), "utf8");
      },
    },
  });

  if (result.errors.length > 0) {
    console.error("Downstream state validation failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Downstream state validation passed: ${result.patchCount} patches, ${result.syncCount} accepted sync, authority ${result.lastEffectiveUpstreamSha}.`,
  );
}

if (import.meta.main) main();
