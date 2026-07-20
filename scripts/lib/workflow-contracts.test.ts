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
const ciWorkflow = `name: CI
on:
  pull_request:
  push:
permissions:
  contents: read
jobs:
  quality:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${pinnedCheckout}
      - run: bun run test
  windows_x64:
    runs-on: windows-2022
    steps:
      - run: bun run brand:check
      - run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64
      - run: node apps/server/scripts/build-windows-job-launcher.mjs --arch arm64
      - run: bun run --cwd apps/server test src/provider/windowsProviderProcess.test.ts src/provider/windowsProviderProcess.windows.test.ts
      - run: bun run --cwd packages/shared test src/desktopIdentity.test.ts src/desktopIdentityProof.test.ts src/windowsCertificate.test.ts
      - run: bun run --cwd apps/desktop test src/backendShutdown.test.ts src/backendShutdown.windows.integration.test.ts
      - run: bun run --cwd packages/shared test src/windowsProcess.test.ts
      - run: bun run --cwd apps/server test src/windowsProcessEffect.test.ts src/codexAppServerManager.test.ts src/provider/Layers/ProviderHealth.test.ts src/persistence/MigrationBackup.test.ts src/restoreMigrationBackup.test.ts
      - run: bun run --cwd apps/desktop test src/desktopMigrationRecovery.test.ts src/desktopStorageMigration.test.ts src/windowState.test.ts src/updateState.test.ts
      - run: bun run --cwd scripts test check-brand-identity.test.ts verify-packaged-desktop-startup.test.ts lib/desktop-artifact-policy.test.ts lib/windows-authenticode.test.ts lib/windows-installer-qualification.test.ts lib/release-artifact-provenance.test.ts lib/super-synara-release-admission.test.ts lib/super-synara-workflow-contract.test.ts
      - run: node scripts/verify-workflow-contracts.ts
      - run: bun run build:desktop
      - run: bun run --cwd apps/desktop smoke-test
  macos_arm64:
    runs-on: macos-15
    steps:
      - run: test "$(uname -m)" = arm64
      - run: bun run brand:check
      - run: node scripts/node-pty-smoke.mjs
      - run: bun run --cwd apps/desktop test
      - run: bun run build:desktop
  release_smoke:
    runs-on: ubuntu-24.04
    steps:
      - run: echo bun run test
      - run: bun run test:desktop-smoke
      - run: bun run --cwd scripts test
      - run: |
          # bun run test
          echo safe
`;
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

  it("requires exact native CI gates and rejects broad suites only in native jobs", () => {
    const missingWindowsGate = validFiles();
    missingWindowsGate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("src/desktopIdentityProof.test.ts", "src/forgedIdentityProof.test.ts"),
    );
    expect(validateWorkflowContracts(missingWindowsGate, policy()).join("\n")).toContain(
      "windows_x64 must run exact native gate command",
    );

    const missingArm64LauncherBuild = validFiles();
    missingArm64LauncherBuild.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "node apps/server/scripts/build-windows-job-launcher.mjs --arch arm64",
        "node apps/server/scripts/build-windows-job-launcher.mjs --arch x64",
      ),
    );
    expect(validateWorkflowContracts(missingArm64LauncherBuild, policy()).join("\n")).toContain(
      "windows_x64 must run exact native gate command: node apps/server/scripts/build-windows-job-launcher.mjs --arch arm64",
    );

    const broadWindowsSuite = validFiles();
    broadWindowsSuite.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: bun run brand:check\n",
        "      - run: bun run brand:check\n      - run: bun run test\n",
      ),
    );
    expect(validateWorkflowContracts(broadWindowsSuite, policy()).join("\n")).toContain(
      "windows_x64 must not run the monorepo-wide bun run test suite",
    );

    const broadMacosSuite = validFiles();
    broadMacosSuite.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: bun run --cwd apps/desktop test\n",
        "      - run: bun run --cwd apps/desktop test\n      - run: bun run test\n",
      ),
    );
    expect(validateWorkflowContracts(broadMacosSuite, policy()).join("\n")).toContain(
      "macos_arm64 must not run the monorepo-wide bun run test suite",
    );
  });

  it("binds CI suite ownership and native runners", () => {
    const missingQualitySuite = validFiles();
    missingQualitySuite.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("      - run: bun run test\n", ""),
    );
    expect(validateWorkflowContracts(missingQualitySuite, policy()).join("\n")).toContain(
      "quality must run exactly one bare bun run test suite",
    );

    const duplicateQualitySuite = validFiles();
    duplicateQualitySuite.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: bun run test\n",
        "      - run: bun run test\n      - run: bun run test\n",
      ),
    );
    expect(validateWorkflowContracts(duplicateQualitySuite, policy()).join("\n")).toContain(
      "quality must run exactly one bare bun run test suite",
    );

    const swappedWindowsRunner = validFiles();
    swappedWindowsRunner.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("    runs-on: windows-2022", "    runs-on: ubuntu-24.04"),
    );
    expect(validateWorkflowContracts(swappedWindowsRunner, policy()).join("\n")).toContain(
      "windows_x64 must run on windows-2022",
    );

    const conditionalQuality = validFiles();
    conditionalQuality.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("  quality:\n", "  quality:\n    if: false\n"),
    );
    expect(validateWorkflowContracts(conditionalQuality, policy()).join("\n")).toContain(
      "quality job must be unconditional and fail closed",
    );

    const chainedReleaseSuite = validFiles();
    chainedReleaseSuite.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("          echo safe", "          bun run test && echo done"),
    );
    expect(validateWorkflowContracts(chainedReleaseSuite, policy()).join("\n")).toContain(
      "release_smoke must not own an additional or chained monorepo-wide bun run test suite",
    );
  });

  it("requires native CI gates to fail closed before the build", () => {
    const skippedGate = validFiles();
    skippedGate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: node scripts/verify-workflow-contracts.ts",
        "      - run: node scripts/verify-workflow-contracts.ts\n        continue-on-error: true",
      ),
    );
    expect(validateWorkflowContracts(skippedGate, policy()).join("\n")).toContain(
      "native gate must be unconditional and fail closed",
    );

    const gate = "      - run: node scripts/verify-workflow-contracts.ts\n";
    const reorderedGate = validFiles();
    reorderedGate.set(
      ".github/workflows/ci.yml",
      ciWorkflow
        .replace(gate, "")
        .replace(
          "      - run: bun run build:desktop\n",
          `      - run: bun run build:desktop\n${gate}`,
        ),
    );
    expect(validateWorkflowContracts(reorderedGate, policy()).join("\n")).toContain(
      "native gate must run before the desktop build",
    );

    const conditionalArchitecture = validFiles();
    conditionalArchitecture.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        '      - run: test "$(uname -m)" = arm64',
        '      - if: false\n        run: test "$(uname -m)" = arm64',
      ),
    );
    expect(validateWorkflowContracts(conditionalArchitecture, policy()).join("\n")).toContain(
      "native gate must be unconditional and fail closed",
    );

    const conditionalJob = validFiles();
    conditionalJob.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("  windows_x64:\n", "  windows_x64:\n    if: false\n"),
    );
    expect(validateWorkflowContracts(conditionalJob, policy()).join("\n")).toContain(
      "windows_x64 job must be unconditional and fail closed",
    );

    const nonFailingBuild = validFiles();
    nonFailingBuild.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: bun run build:desktop\n",
        "      - run: bun run build:desktop\n        continue-on-error: true\n",
      ),
    );
    expect(validateWorkflowContracts(nonFailingBuild, policy()).join("\n")).toContain(
      "native desktop build must be unconditional and fail closed",
    );
  });

  it("requires the Windows smoke to invoke the built desktop directly after the build", () => {
    const wrapperSmoke = validFiles();
    wrapperSmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: bun run --cwd apps/desktop smoke-test\n",
        "      - run: bun run test:desktop-smoke\n",
      ),
    );
    const wrapperErrors = validateWorkflowContracts(wrapperSmoke, policy()).join("\n");
    expect(wrapperErrors).toContain("must run exact post-build smoke command");
    expect(wrapperErrors).toContain("without the Turbo rebuild wrapper");

    for (const equivalentWrapper of [
      "echo preparing && bun run test:desktop-smoke -- --flag",
      "echo input | bun run test:desktop-smoke",
      '"& bun run test:desktop-smoke"',
      "bun run test:desktop-smoke>smoke.log",
    ]) {
      const wrapperFiles = validFiles();
      wrapperFiles.set(
        ".github/workflows/ci.yml",
        ciWorkflow.replace(
          "      - run: bun run --cwd apps/desktop smoke-test\n",
          `      - run: bun run --cwd apps/desktop smoke-test\n      - run: ${equivalentWrapper}\n`,
        ),
      );
      expect(validateWorkflowContracts(wrapperFiles, policy()).join("\n")).toContain(
        "without the Turbo rebuild wrapper",
      );
    }

    const distinctScript = validFiles();
    distinctScript.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: bun run --cwd apps/desktop smoke-test\n",
        "      - run: bun run --cwd apps/desktop smoke-test\n      - run: bun run test:desktop-smoke-helper\n",
      ),
    );
    expect(validateWorkflowContracts(distinctScript, policy()).join("\n")).not.toContain(
      "without the Turbo rebuild wrapper",
    );

    const earlySmoke = validFiles();
    earlySmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow
        .replace("      - run: bun run --cwd apps/desktop smoke-test\n", "")
        .replace(
          "      - run: bun run build:desktop\n",
          "      - run: bun run --cwd apps/desktop smoke-test\n      - run: bun run build:desktop\n",
        ),
    );
    expect(validateWorkflowContracts(earlySmoke, policy()).join("\n")).toContain(
      "post-build smoke must run after the desktop build",
    );

    const nonFailingSmoke = validFiles();
    nonFailingSmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: bun run --cwd apps/desktop smoke-test\n",
        "      - run: bun run --cwd apps/desktop smoke-test\n        continue-on-error: true\n",
      ),
    );
    expect(validateWorkflowContracts(nonFailingSmoke, policy()).join("\n")).toContain(
      "post-build smoke must be unconditional and fail closed",
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
