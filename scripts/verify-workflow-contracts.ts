import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseWorkflowPolicy,
  validateRepositoryWorkflowStates,
  validateVouchedConfiguration,
  validateWorkflowContracts,
  type RepositoryWorkflowState,
} from "./lib/workflow-contracts.ts";

interface GitHubWorkflowResponse {
  readonly total_count: number;
  readonly workflows: readonly RepositoryWorkflowState[];
}

function loadWorkflowFiles(repositoryRoot: string): Map<string, string> {
  const workflowDirectory = resolve(repositoryRoot, ".github/workflows");
  return new Map(
    readdirSync(workflowDirectory)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort()
      .map((name) => {
        const path = `.github/workflows/${name}`;
        return [path, readFileSync(resolve(repositoryRoot, path), "utf8")] as const;
      }),
  );
}

async function loadGitHubWorkflowStates(
  token: string,
): Promise<readonly RepositoryWorkflowState[]> {
  const response = await fetch(
    "https://api.github.com/repos/slashdevcorpse/synara/actions/workflows?per_page=100",
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "super-synara-workflow-contract",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub workflow-state request failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as GitHubWorkflowResponse;
  return body.workflows.map((workflow) => ({ path: workflow.path, state: workflow.state }));
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const knownArgs = new Set(["--check-github-state"]);
  for (const arg of args) {
    if (!knownArgs.has(arg)) {
      throw new Error("Usage: node scripts/verify-workflow-contracts.ts [--check-github-state]");
    }
  }
  const repositoryRoot = process.cwd();
  const policy = parseWorkflowPolicy(
    readFileSync(resolve(repositoryRoot, "docs/downstream/workflow-policy.json"), "utf8"),
  );
  const errors = [...validateWorkflowContracts(loadWorkflowFiles(repositoryRoot), policy)];
  errors.push(
    ...validateVouchedConfiguration(
      readFileSync(resolve(repositoryRoot, ".github/VOUCHED.td"), "utf8"),
    ),
  );
  if (args.has("--check-github-state")) {
    const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
    if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required for --check-github-state.");
    errors.push(...validateRepositoryWorkflowStates(await loadGitHubWorkflowStates(token), policy));
  }

  if (errors.length > 0) {
    console.error("Workflow contract validation failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Workflow contract validation passed for ${policy.allowedWorkflows.length} allowed and ${policy.disabledWorkflows.length} disabled workflow paths.`,
  );
}

if (import.meta.main) await main();
