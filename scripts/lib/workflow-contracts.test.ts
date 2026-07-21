import { describe, expect, it } from "vitest";

import {
  parseWorkflowPolicy,
  validateRepositoryWorkflowStates,
  validateVouchedConfiguration,
  validateWorkflowContracts,
  type WorkflowPolicy,
} from "./workflow-contracts";

const pinnedCheckout = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6";
const pinnedCodecov = "codecov/codecov-action@0fb7174895f61a3b6b78fc075e0cd60383518dac # v5.5.5";
const codecovCondition =
  "${{ !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') }}";
const codecovToken = "${{ secrets.CODECOV_TOKEN }}";
const pinnedMergify = "Mergifyio/gha-mergify-ci@8173bc3c1d337d3367454672d50cfdf6f0273396 # v23";
const mergifyCondition =
  "${{ !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') && (github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository) }}";
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
      path: ".github/workflows/dependency-review.yml",
      requiredOnDefaultBranch: true,
      triggers: ["pull_request"],
    },
    {
      path: ".github/workflows/codeql.yml",
      requiredOnDefaultBranch: true,
      triggers: ["pull_request", "push", "schedule"],
    },
    {
      path: ".github/workflows/release-drafter.yml",
      requiredOnDefaultBranch: true,
      triggers: ["push", "schedule", "workflow_dispatch"],
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
const windowsPersistenceHome = "${{ runner.temp }}\\super-synara-persistence-windows-home";
const windowsStartupHome = "${{ runner.temp }}\\super-synara-ci-home";
const macosPersistenceHome = "${{ runner.temp }}/super-synara-persistence-macos-home";
const macosStartupHome = "${{ runner.temp }}/super-synara-ci-home";
const nativeDesktopBuildStep = [
  "      - env:",
  "          SYNARA_DESKTOP_FLAVOR: super",
  "        run: bun run build:desktop",
].join("\n");
const windowsPersistenceSmokeStep = [
  "      - name: Verify two-launch desktop persistence",
  "        timeout-minutes: 5",
  "        env:",
  '          SYNARA_DESKTOP_DISABLE_UPDATES: "1"',
  "          SYNARA_DESKTOP_FLAVOR: super",
  `          SYNARA_HOME: ${windowsPersistenceHome}`,
  "        run: bun run test:desktop-persistence-smoke",
].join("\n");
const windowsStartupSmokeStep = [
  "      - name: Smoke unpacked desktop in isolated state",
  "        env:",
  '          SYNARA_DESKTOP_DISABLE_UPDATES: "1"',
  "          SYNARA_DESKTOP_FLAVOR: super",
  `          SYNARA_HOME: ${windowsStartupHome}`,
  '          SYNARA_PORT_OFFSET: "2710"',
  "        run: bun run --cwd apps/desktop smoke-test",
].join("\n");
const macosPersistenceSmokeStep = [
  "      - name: Verify two-launch desktop persistence",
  "        timeout-minutes: 5",
  "        env:",
  '          SYNARA_DESKTOP_DISABLE_UPDATES: "1"',
  "          SYNARA_DESKTOP_FLAVOR: super",
  `          SYNARA_HOME: ${macosPersistenceHome}`,
  "        run: bun run test:desktop-persistence-smoke",
].join("\n");
const macosStartupSmokeStep = [
  "      - name: Smoke unpacked desktop in isolated state",
  "        env:",
  '          SYNARA_DESKTOP_DISABLE_UPDATES: "1"',
  "          SYNARA_DESKTOP_FLAVOR: super",
  `          SYNARA_HOME: ${macosStartupHome}`,
  '          SYNARA_PORT_OFFSET: "2810"',
  "        run: bun run test:desktop-smoke",
].join("\n");
const ciRootTestStep = [
  "      - name: Test with coverage and JUnit",
  "        id: unit_tests",
  "        run: bun run test:ci",
].join("\n");
const codecovCoverageUploadStep = [
  "      - name: Upload coverage reports to Codecov",
  `        if: ${codecovCondition}`,
  `        uses: ${pinnedCodecov}`,
  "        with:",
  `          token: ${codecovToken}`,
  "          files: ./apps/desktop/coverage/lcov.info,./apps/server/coverage/lcov.info,./apps/web/coverage/lcov.info,./packages/contracts/coverage/lcov.info,./packages/shared/coverage/lcov.info,./scripts/coverage/lcov.info",
  "          disable_search: true",
  "          fail_ci_if_error: true",
].join("\n");
const codecovTestResultsUploadStep = [
  "      - name: Upload test results to Codecov",
  `        if: ${codecovCondition}`,
  `        uses: ${pinnedCodecov}`,
  "        with:",
  `          token: ${codecovToken}`,
  "          files: ./apps/desktop/test-report.junit.xml,./apps/server/test-report.junit.xml,./apps/web/test-report.junit.xml,./packages/contracts/test-report.junit.xml,./packages/shared/test-report.junit.xml,./scripts/test-report.junit.xml",
  "          disable_search: true",
  "          fail_ci_if_error: true",
  "          report_type: test_results",
].join("\n");
const mergifyUploadStep = [
  "      - name: Upload test results to Mergify CI Insights",
  "        id: mergify_ci",
  `        if: ${mergifyCondition}`,
  `        uses: ${pinnedMergify}`,
  "        with:",
  "          action: junit-process",
  "          token: ${{ secrets.MERGIFY_TOKEN }}",
  "          job_name: quality",
  "          report_path: >-",
  "            ./apps/desktop/test-report.junit.xml",
  "            ./apps/server/test-report.junit.xml",
  "            ./apps/web/test-report.junit.xml",
  "            ./packages/contracts/test-report.junit.xml",
  "            ./packages/shared/test-report.junit.xml",
  "            ./scripts/test-report.junit.xml",
  "          test_step_outcome: ${{ steps.unit_tests.outcome }}",
].join("\n");
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
${ciRootTestStep}
${mergifyUploadStep}
${codecovCoverageUploadStep}
${codecovTestResultsUploadStep}
  windows_x64:
    runs-on: windows-2022
    steps:
      - run: bun run brand:check
      - run: bun run --cwd packages/shared test src/desktopIdentity.test.ts src/desktopIdentityProof.test.ts src/windowsCertificate.test.ts
      - run: bun run --cwd apps/desktop test src/backendShutdown.test.ts src/backendShutdown.windows.integration.test.ts
      - run: bun run --cwd packages/shared test src/windowsProcess.test.ts
      - run: bun run --cwd apps/server test src/windowsProcessEffect.test.ts src/codexAppServerManager.test.ts src/provider/Layers/ProviderHealth.test.ts src/persistence/MigrationBackup.test.ts src/restoreMigrationBackup.test.ts
      - run: bun run --cwd apps/desktop test src/desktopMigrationRecovery.test.ts src/desktopStorageMigration.test.ts src/windowState.test.ts src/updateState.test.ts
      - run: bun run --cwd scripts test check-brand-identity.test.ts verify-packaged-desktop-startup.test.ts lib/desktop-artifact-policy.test.ts lib/windows-authenticode.test.ts lib/windows-installer-qualification.test.ts lib/release-artifact-provenance.test.ts lib/super-synara-release-admission.test.ts lib/super-synara-workflow-contract.test.ts
      - run: node scripts/verify-workflow-contracts.ts
${nativeDesktopBuildStep}
${windowsPersistenceSmokeStep}
${windowsStartupSmokeStep}
  macos_arm64:
    runs-on: macos-15
    steps:
      - run: test "$(uname -m)" = arm64
      - run: bun run brand:check
      - run: node scripts/node-pty-smoke.mjs
      - run: bun run --cwd apps/desktop test
${nativeDesktopBuildStep}
${macosPersistenceSmokeStep}
${macosStartupSmokeStep}
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
const dependencyReviewWorkflow = `name: Dependency Review
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  dependency-review:
    name: dependency-review
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0
`;
const codeqlWorkflow = `name: CodeQL
on:
  pull_request:
  push:
  schedule:
    - cron: "41 6 * * 1"
permissions:
  contents: read
jobs:
  analyze_actions:
    name: codeql-actions
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: github/codeql-action/init@e0647621c2984b5ed2f768cb892365bf2a616ad1 # v4.37.2
        with:
          languages: actions
          build-mode: none
      - uses: github/codeql-action/analyze@e0647621c2984b5ed2f768cb892365bf2a616ad1 # v4.37.2
        with:
          category: /language:actions
  analyze_javascript_typescript:
    name: codeql-javascript-typescript
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: github/codeql-action/init@e0647621c2984b5ed2f768cb892365bf2a616ad1 # v4.37.2
        with:
          languages: javascript-typescript
          build-mode: none
      - uses: github/codeql-action/analyze@e0647621c2984b5ed2f768cb892365bf2a616ad1 # v4.37.2
        with:
          category: /language:javascript-typescript
  analyze_swift:
    name: codeql-swift
    runs-on: macos-15
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: github/codeql-action/init@e0647621c2984b5ed2f768cb892365bf2a616ad1 # v4.37.2
        with:
          languages: swift
          build-mode: manual
      - run: node apps/desktop/scripts/build-appsnap-helper.mjs --arch arm64 --output "\${{ runner.temp }}/synara-appsnap-helper"
      - uses: github/codeql-action/analyze@e0647621c2984b5ed2f768cb892365bf2a616ad1 # v4.37.2
        with:
          category: /language:swift
`;
const releaseDrafterWorkflow = `name: Release Drafter
on:
  push:
  schedule:
    - cron: "23 14 * * 1"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  draft:
    runs-on: ubuntu-24.04
    permissions:
      contents: write
      pull-requests: read
    steps:
      - uses: release-drafter/release-drafter@eada3c96a64734dd381cfbda23511034e328ddb0 # v7.6.0
  dispatch:
    runs-on: ubuntu-24.04
    permissions:
      actions: write
      contents: read
`;

function validFiles(): Map<string, string> {
  return new Map([
    ...disabledPaths.map((path) => [path, disabledWorkflow] as const),
    [".github/workflows/ci.yml", ciWorkflow],
    [".github/workflows/dependency-review.yml", dependencyReviewWorkflow],
    [".github/workflows/codeql.yml", codeqlWorkflow],
    [".github/workflows/release-drafter.yml", releaseDrafterWorkflow],
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
      ciWorkflow.replace(`${ciRootTestStep}\n`, ""),
    );
    expect(validateWorkflowContracts(missingQualitySuite, policy()).join("\n")).toContain(
      "quality must run exactly one bun run test:ci suite",
    );

    const duplicateQualitySuite = validFiles();
    duplicateQualitySuite.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(`${ciRootTestStep}\n`, `${ciRootTestStep}\n${ciRootTestStep}\n`),
    );
    expect(validateWorkflowContracts(duplicateQualitySuite, policy()).join("\n")).toContain(
      "quality must run exactly one bun run test:ci suite",
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

  it("requires fail-closed Codecov coverage and test-result uploads", () => {
    const missingCoverageUpload = validFiles();
    missingCoverageUpload.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(`${codecovCoverageUploadStep}\n`, ""),
    );
    expect(validateWorkflowContracts(missingCoverageUpload, policy()).join("\n")).toContain(
      "must define exactly one Upload coverage reports to Codecov step",
    );

    const wrongTestReportType = validFiles();
    wrongTestReportType.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("report_type: test_results", "report_type: coverage"),
    );
    expect(validateWorkflowContracts(wrongTestReportType, policy()).join("\n")).toContain(
      "Upload test results to Codecov must set report_type to test_results",
    );

    const nonBlockingCoverageUpload = validFiles();
    nonBlockingCoverageUpload.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        `${codecovCoverageUploadStep}`,
        codecovCoverageUploadStep.replace("fail_ci_if_error: true", "fail_ci_if_error: false"),
      ),
    );
    expect(validateWorkflowContracts(nonBlockingCoverageUpload, policy()).join("\n")).toContain(
      "Upload coverage reports to Codecov must fail closed on Codecov upload errors",
    );

    const missingUnitTestId = validFiles();
    missingUnitTestId.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("        id: unit_tests\n", ""),
    );
    expect(validateWorkflowContracts(missingUnitTestId, policy()).join("\n")).toContain(
      "bun run test:ci must use id unit_tests for report upload conditions",
    );

    const uploadBeforeTests = validFiles();
    uploadBeforeTests.set(
      ".github/workflows/ci.yml",
      ciWorkflow
        .replace(`${codecovCoverageUploadStep}\n`, "")
        .replace(`${ciRootTestStep}\n`, `${codecovCoverageUploadStep}\n${ciRootTestStep}\n`),
    );
    expect(validateWorkflowContracts(uploadBeforeTests, policy()).join("\n")).toContain(
      "Upload coverage reports to Codecov must run after bun run test:ci",
    );
  });

  it("requires fork-safe, fail-closed Mergify JUnit ingestion", () => {
    const missingUpload = validFiles();
    missingUpload.set(".github/workflows/ci.yml", ciWorkflow.replace(`${mergifyUploadStep}\n`, ""));
    expect(validateWorkflowContracts(missingUpload, policy()).join("\n")).toContain(
      "must define exactly one Upload test results to Mergify CI Insights step",
    );

    const unsafeForkUpload = validFiles();
    unsafeForkUpload.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(mergifyCondition, codecovCondition),
    );
    expect(validateWorkflowContracts(unsafeForkUpload, policy()).join("\n")).toContain(
      "Mergify upload must be completed-test and fork safe",
    );

    const wrongCredential = validFiles();
    wrongCredential.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("token: ${{ secrets.MERGIFY_TOKEN }}", "token: ${{ github.token }}"),
    );
    expect(validateWorkflowContracts(wrongCredential, policy()).join("\n")).toContain(
      "Mergify upload must ingest only the six expected JUnit reports",
    );
  });

  it("requires the pinned fail-closed Dependency Review lane", () => {
    const wrongAction = validFiles();
    wrongAction.set(
      ".github/workflows/dependency-review.yml",
      dependencyReviewWorkflow.replace(
        "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294",
        "actions/dependency-review-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    );
    expect(validateWorkflowContracts(wrongAction, policy()).join("\n")).toContain(
      "must run exactly one pinned Dependency Review v5 action",
    );

    const nonFailingReview = validFiles();
    nonFailingReview.set(
      ".github/workflows/dependency-review.yml",
      dependencyReviewWorkflow.replace(
        "      - uses: actions/dependency-review-action@",
        "      - continue-on-error: true\n        uses: actions/dependency-review-action@",
      ),
    );
    expect(validateWorkflowContracts(nonFailingReview, policy()).join("\n")).toContain(
      "dependency review must be unconditional and fail closed",
    );
  });

  it("locks CodeQL languages, permissions, action SHA, and result categories", () => {
    const missingPermission = validFiles();
    missingPermission.set(
      ".github/workflows/codeql.yml",
      codeqlWorkflow.replace("      security-events: write\n", ""),
    );
    expect(validateWorkflowContracts(missingPermission, policy()).join("\n")).toContain(
      "codeql-actions must grant only required CodeQL permissions",
    );

    const wrongAction = validFiles();
    wrongAction.set(
      ".github/workflows/codeql.yml",
      codeqlWorkflow.replaceAll(
        "e0647621c2984b5ed2f768cb892365bf2a616ad1",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    );
    expect(validateWorkflowContracts(wrongAction, policy()).join("\n")).toContain(
      "codeql-actions must initialize the expected language and build mode",
    );

    const wrongCategory = validFiles();
    wrongCategory.set(
      ".github/workflows/codeql.yml",
      codeqlWorkflow.replace(
        "category: /language:swift",
        "category: /language:javascript-typescript",
      ),
    );
    expect(validateWorkflowContracts(wrongCategory, policy()).join("\n")).toContain(
      "codeql-swift must publish the fixed analysis category",
    );
  });

  it("limits release scheduling writes to draft contents and workflow dispatch", () => {
    const excessiveDraftPermission = validFiles();
    excessiveDraftPermission.set(
      ".github/workflows/release-drafter.yml",
      releaseDrafterWorkflow.replace("      pull-requests: read", "      pull-requests: write"),
    );
    expect(validateWorkflowContracts(excessiveDraftPermission, policy()).join("\n")).toContain(
      "unsupported pull-requests: write at jobs.draft.permissions",
    );

    const excessiveDispatchPermission = validFiles();
    excessiveDispatchPermission.set(
      ".github/workflows/release-drafter.yml",
      releaseDrafterWorkflow.replace(
        "      actions: write\n      contents: read",
        "      actions: write\n      contents: write",
      ),
    );
    expect(validateWorkflowContracts(excessiveDispatchPermission, policy()).join("\n")).toContain(
      "unsupported contents: write at jobs.dispatch.permissions",
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
        .replace(`${nativeDesktopBuildStep}\n`, `${nativeDesktopBuildStep}\n${gate}`),
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
        nativeDesktopBuildStep,
        nativeDesktopBuildStep.replace(
          "        run: bun run build:desktop",
          "        continue-on-error: true\n        run: bun run build:desktop",
        ),
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
        windowsStartupSmokeStep,
        windowsStartupSmokeStep.replace(
          "        run: bun run --cwd apps/desktop smoke-test",
          "        run: bun run test:desktop-smoke",
        ),
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
          windowsStartupSmokeStep,
          `${windowsStartupSmokeStep}\n      - run: ${equivalentWrapper}`,
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
        windowsStartupSmokeStep,
        `${windowsStartupSmokeStep}\n      - run: bun run test:desktop-smoke-helper`,
      ),
    );
    expect(validateWorkflowContracts(distinctScript, policy()).join("\n")).not.toContain(
      "without the Turbo rebuild wrapper",
    );

    const earlySmoke = validFiles();
    earlySmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow
        .replace(`${windowsStartupSmokeStep}\n`, "")
        .replace(
          `${nativeDesktopBuildStep}\n`,
          `${windowsStartupSmokeStep}\n${nativeDesktopBuildStep}\n`,
        ),
    );
    expect(validateWorkflowContracts(earlySmoke, policy()).join("\n")).toContain(
      "post-build smoke must run after the desktop build",
    );

    const nonFailingSmoke = validFiles();
    nonFailingSmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        windowsStartupSmokeStep,
        windowsStartupSmokeStep.replace(
          "        run: bun run --cwd apps/desktop smoke-test",
          "        continue-on-error: true\n        run: bun run --cwd apps/desktop smoke-test",
        ),
      ),
    );
    expect(validateWorkflowContracts(nonFailingSmoke, policy()).join("\n")).toContain(
      "post-build smoke must be unconditional and fail closed",
    );
  });

  it("requires exactly one desktop persistence smoke in each native job", () => {
    const missingSmoke = validFiles();
    missingSmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(`${windowsPersistenceSmokeStep}\n`, ""),
    );
    expect(validateWorkflowContracts(missingSmoke, policy()).join("\n")).toContain(
      "windows_x64 must run exactly one post-build desktop persistence smoke command",
    );

    const duplicateSmoke = validFiles();
    duplicateSmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        macosPersistenceSmokeStep,
        `${macosPersistenceSmokeStep}\n${macosPersistenceSmokeStep}`,
      ),
    );
    expect(validateWorkflowContracts(duplicateSmoke, policy()).join("\n")).toContain(
      "macos_arm64 must run exactly one post-build desktop persistence smoke command",
    );
  });

  it("requires the desktop persistence smoke to run after the native build", () => {
    const preBuildSmoke = validFiles();
    preBuildSmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        `${nativeDesktopBuildStep}\n${windowsPersistenceSmokeStep}`,
        `${windowsPersistenceSmokeStep}\n${nativeDesktopBuildStep}`,
      ),
    );
    expect(validateWorkflowContracts(preBuildSmoke, policy()).join("\n")).toContain(
      "windows_x64 desktop persistence smoke must run after the build",
    );
  });

  it("requires desktop persistence smoke steps to be unconditional and fail closed", () => {
    const conditionalSmoke = validFiles();
    conditionalSmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        windowsPersistenceSmokeStep,
        windowsPersistenceSmokeStep.replace(
          "        timeout-minutes: 5",
          "        if: false\n        timeout-minutes: 5",
        ),
      ),
    );
    expect(validateWorkflowContracts(conditionalSmoke, policy()).join("\n")).toContain(
      "windows_x64 desktop persistence smoke must be unconditional and fail closed",
    );

    const nonFailingSmoke = validFiles();
    nonFailingSmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        macosPersistenceSmokeStep,
        macosPersistenceSmokeStep.replace(
          "        timeout-minutes: 5",
          "        continue-on-error: true\n        timeout-minutes: 5",
        ),
      ),
    );
    expect(validateWorkflowContracts(nonFailingSmoke, policy()).join("\n")).toContain(
      "macos_arm64 desktop persistence smoke must be unconditional and fail closed",
    );
  });

  it("requires Super flavor and updates disabled for desktop persistence smoke", () => {
    const wrongBuildFlavor = validFiles();
    wrongBuildFlavor.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        nativeDesktopBuildStep,
        nativeDesktopBuildStep.replace(
          "          SYNARA_DESKTOP_FLAVOR: super",
          "          SYNARA_DESKTOP_FLAVOR: production",
        ),
      ),
    );
    expect(validateWorkflowContracts(wrongBuildFlavor, policy()).join("\n")).toContain(
      "windows_x64 desktop build must set SYNARA_DESKTOP_FLAVOR to super",
    );

    const wrongFlavor = validFiles();
    wrongFlavor.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        windowsPersistenceSmokeStep,
        windowsPersistenceSmokeStep.replace(
          "          SYNARA_DESKTOP_FLAVOR: super",
          "          SYNARA_DESKTOP_FLAVOR: production",
        ),
      ),
    );
    expect(validateWorkflowContracts(wrongFlavor, policy()).join("\n")).toContain(
      "windows_x64 desktop persistence smoke must set SYNARA_DESKTOP_FLAVOR to super",
    );

    const updatesEnabled = validFiles();
    updatesEnabled.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        macosPersistenceSmokeStep,
        macosPersistenceSmokeStep.replace(
          '          SYNARA_DESKTOP_DISABLE_UPDATES: "1"',
          '          SYNARA_DESKTOP_DISABLE_UPDATES: "0"',
        ),
      ),
    );
    expect(validateWorkflowContracts(updatesEnabled, policy()).join("\n")).toContain(
      'macos_arm64 desktop persistence smoke must set SYNARA_DESKTOP_DISABLE_UPDATES to "1"',
    );
  });

  it("requires a bounded persistence timeout and an isolated home", () => {
    const unboundedSmoke = validFiles();
    unboundedSmoke.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        windowsPersistenceSmokeStep,
        windowsPersistenceSmokeStep.replace("        timeout-minutes: 5\n", ""),
      ),
    );
    expect(validateWorkflowContracts(unboundedSmoke, policy()).join("\n")).toContain(
      "windows_x64 desktop persistence smoke timeout-minutes must equal 5",
    );

    const sharedHome = validFiles();
    sharedHome.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        windowsPersistenceSmokeStep,
        windowsPersistenceSmokeStep.replace(windowsPersistenceHome, windowsStartupHome),
      ),
    );
    expect(validateWorkflowContracts(sharedHome, policy()).join("\n")).toContain(
      "windows_x64 desktop persistence smoke must not share SYNARA_HOME with startup smoke",
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
      { path: ".github/workflows/dependency-review.yml", state: "active" },
      { path: ".github/workflows/codeql.yml", state: "active" },
      { path: ".github/workflows/release-drafter.yml", state: "active" },
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
