import { describe, expect, it } from "vitest";

import {
  parseWorkflowPolicy,
  validateRepositoryWorkflowStates,
  validateVouchedConfiguration,
  validateWorkflowContracts,
  type WorkflowPolicy,
} from "./workflow-contracts";

const pinnedCheckout = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6";
const disabledPaths = [
  ".github/workflows/issue-labels.yml",
  ".github/workflows/pr-size.yml",
  ".github/workflows/pr-vouch.yml",
  ".github/workflows/release.yml",
] as const;

const policy = (): WorkflowPolicy => ({
  schemaVersion: 1,
  repository: "slashdevcorpse/synara",
  disabledWorkflows: disabledPaths.map((path) => ({
    path,
    requiredState: "disabled_manually",
    reason: "Inherited write-capable workflow is disabled downstream.",
  })),
  allowedWorkflows: [
    {
      path: ".github/workflows/ci.yml",
      requiredOnDefaultBranch: true,
      triggers: ["pull_request", "push"],
    },
    {
      path: ".github/workflows/upstream-watch.yml",
      requiredOnDefaultBranch: true,
      triggers: ["schedule", "workflow_dispatch"],
    },
    {
      path: ".github/workflows/super-synara-prerelease.yml",
      requiredOnDefaultBranch: false,
      triggers: ["workflow_dispatch"],
    },
    {
      path: ".github/workflows/super-synara-macos-signature-audit.yml",
      requiredOnDefaultBranch: false,
      triggers: ["workflow_dispatch"],
    },
  ],
});

const disabledWorkflow = `name: Disabled\non: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: ${pinnedCheckout}\n`;
const ciWorkflow = `name: CI\non:\n  pull_request:\n  push:\npermissions:\n  contents: read\njobs:\n  quality:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: ${pinnedCheckout}\n  macos_arm64:\n    runs-on: macos-15\n    steps:\n      - run: test "$(uname -m)" = arm64\n`;
const watchWorkflow = `name: Watch\non:\n  schedule:\n    - cron: "17 */6 * * *"\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  inspect:\n    runs-on: ubuntu-24.04\n  report:\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n      issues: write\n`;

function validFiles(): Map<string, string> {
  return new Map([
    ...disabledPaths.map((path) => [path, disabledWorkflow] as const),
    [".github/workflows/ci.yml", ciWorkflow],
    [".github/workflows/upstream-watch.yml", watchWorkflow],
  ]);
}

describe("workflow contracts", () => {
  it("accepts pinned, read-only PR CI and the narrowly scoped watcher", () => {
    expect(validateWorkflowContracts(validFiles(), policy())).toEqual([]);
  });

  it("rejects mutable action tags even in disabled workflows", () => {
    const files = validFiles();
    files.set(
      ".github/workflows/release.yml",
      disabledWorkflow.replace(pinnedCheckout, "actions/checkout@v6"),
    );
    expect(validateWorkflowContracts(files, policy()).join("\n")).toContain(
      "must use a full commit SHA",
    );
  });

  it("rejects pull_request_target and write permission in allowed CI", () => {
    const files = validFiles();
    files.set(
      ".github/workflows/ci.yml",
      ciWorkflow
        .replace("pull_request:", "pull_request_target:")
        .replace("contents: read", "contents: write"),
    );
    const errors = validateWorkflowContracts(files, policy()).join("\n");
    expect(errors).toContain("must not use pull_request_target");
    expect(errors).toContain("unsupported contents: write");
  });

  it("rejects non-standard runners in allowed workflows", () => {
    const files = validFiles();
    files.set(".github/workflows/ci.yml", ciWorkflow.replace("ubuntu-24.04", "macos-15-intel"));
    expect(validateWorkflowContracts(files, policy()).join("\n")).toContain(
      "references unsupported runner macos-15-intel",
    );
  });

  it("requires the macOS lane to prove its arm64 architecture", () => {
    const files = validFiles();
    files.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace('test "$(uname -m)" = arm64', "uname -m"),
    );
    expect(validateWorkflowContracts(files, policy()).join("\n")).toContain(
      "macos_arm64 must fail closed",
    );
  });

  it("rejects job-level write-all in allowed workflows", () => {
    const files = validFiles();
    files.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "    runs-on: ubuntu-24.04",
        "    permissions: write-all\n    runs-on: ubuntu-24.04",
      ),
    );
    expect(validateWorkflowContracts(files, policy()).join("\n")).toContain(
      "unsupported *: write at jobs.quality.permissions",
    );
  });

  it("requires the exact four inherited workflows to remain manually disabled", () => {
    const states = [
      ...disabledPaths.map((path) => ({ path, state: "disabled_manually" })),
      { path: ".github/workflows/ci.yml", state: "active" },
      { path: ".github/workflows/upstream-watch.yml", state: "active" },
    ];
    expect(validateRepositoryWorkflowStates(states, policy())).toEqual([]);
    states[0] = { path: states[0]!.path, state: "active" };
    expect(validateRepositoryWorkflowStates(states, policy()).join("\n")).toContain(
      "expected disabled_manually",
    );
  });

  it("parses and validates the policy identity", () => {
    expect(parseWorkflowPolicy(JSON.stringify(policy())).repository).toBe("slashdevcorpse/synara");
    expect(() =>
      parseWorkflowPolicy(JSON.stringify({ ...policy(), repository: "other/repository" })),
    ).toThrow("must equal slashdevcorpse/synara");
  });

  it("allows only slashdevcorpse in the downstream vouch source", () => {
    expect(validateVouchedConfiguration("# owner only\ngithub:slashdevcorpse\n")).toEqual([]);
    expect(validateVouchedConfiguration("github:slashdevcorpse\ngithub:Emanuele-web04\n")).toEqual([
      ".github/VOUCHED.td must contain exactly one trusted identity: github:slashdevcorpse.",
    ]);
  });
});
