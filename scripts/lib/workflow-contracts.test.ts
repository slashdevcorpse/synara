import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseWorkflowPolicy,
  validateMergifyConfiguration,
  validateRepositoryWorkflowStates,
  validateVouchedConfiguration,
  validateWorkflowContracts,
  type WorkflowPolicy,
} from "./workflow-contracts";

const pinnedCheckout = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6";
const pinnedCodecov = "codecov/codecov-action@0fb7174895f61a3b6b78fc075e0cd60383518dac # v5.5.5";
const pinnedMergify = "Mergifyio/gha-mergify-ci@8173bc3c1d337d3367454672d50cfdf6f0273396 # v23";
const codecovCondition =
  "${{ matrix.platform == 'linux' && !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') }}";
const mergifyCondition =
  "${{ matrix.platform == 'linux' && !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') && (github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository) }}";
const codecovToken = "${{ secrets.CODECOV_TOKEN }}";
const disabledPaths = [
  ".github/workflows/issue-labels.yml",
  ".github/workflows/pr-size.yml",
  ".github/workflows/pr-vouch.yml",
  ".github/workflows/release.yml",
] as const;
const ciWorkflow = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");

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
      triggers: ["workflow_call"],
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
  "      - name: Build desktop pipeline",
  "        env:",
  '          SYNARA_DESKTOP_DISABLE_UPDATES: "1"',
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
  "        if: matrix.platform == 'linux'",
  "        timeout-minutes: 30",
  "        run: bun run test:ci",
].join("\n");
const nonLinuxUnitTestStep = [
  "      - name: Run cross-platform unit suite",
  "        if: matrix.platform != 'linux'",
  "        timeout-minutes: 30",
  "        run: bun turbo test",
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
  "          flags: unit",
  "          name: super-synara-unit-coverage",
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
  "          flags: unit",
  "          name: super-synara-unit-test-results",
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
const mergifyVerificationStep = [
  "      - name: Verify Mergify test results upload",
  `        if: ${mergifyCondition}`,
  "        env:",
  "          MERGIFY_UPLOAD_OUTCOME: ${{ steps.mergify_ci.outputs.test_results_upload }}",
  '        run: test "$MERGIFY_UPLOAD_OUTCOME" = "success"',
].join("\n");
const watchWorkflow = `name: Watch
on:
  schedule:
    - cron: "17 */6 * * *"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-24.04
  report:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      issues: write
`;
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
    timeout-minutes: 60
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
    uses: ./.github/workflows/super-synara-prerelease.yml
    permissions:
      contents: write
`;
const mergifyConfiguration = `merge_queue:
  mode: serial
  max_parallel_checks: 1
merge_protections_settings:
  auto_merge_conditions:
    - label = ready-to-merge
merge_protections:
  - name: protected-main
    if:
      - base = main
    success_conditions:
      - -draft
      - -conflict
queue_rules:
  - name: default
    batch_size: 1
    branch_protection_injection_mode: queue
    merge_method: squash
    queue_conditions:
      - base = main
    merge_conditions:
      - base = main
`;

function validFiles(ci = ciWorkflow): Map<string, string> {
  return new Map([
    ...disabledPaths.map((path) => [path, disabledWorkflow] as const),
    [".github/workflows/ci.yml", ci],
    [".github/workflows/dependency-review.yml", dependencyReviewWorkflow],
    [".github/workflows/codeql.yml", codeqlWorkflow],
    [".github/workflows/release-drafter.yml", releaseDrafterWorkflow],
    [".github/workflows/upstream-watch.yml", watchWorkflow],
  ]);
}

function errorsFor(ci: string): string {
  return validateWorkflowContracts(validFiles(ci), policy()).join("\n");
}

function replaceOccurrence(
  source: string,
  search: string,
  replacement: string,
  occurrence: number,
): string {
  let offset = 0;
  for (let index = 1; index <= occurrence; index += 1) {
    const match = source.indexOf(search, offset);
    if (match < 0) throw new Error(`Missing occurrence ${occurrence}: ${search}`);
    if (index === occurrence) {
      return source.slice(0, match) + replacement + source.slice(match + search.length);
    }
    offset = match + search.length;
  }
  return source;
}

describe("workflow contracts", () => {
  it("accepts the pinned, cross-platform CI architecture and narrowly scoped watcher", () => {
    expect(validateWorkflowContracts(validFiles(), policy())).toEqual([]);
    expect(validateMergifyConfiguration(mergifyConfiguration)).toEqual([]);
  });

  it("locks Mergify to the protected-main queue ruleset", () => {
    expect(
      validateMergifyConfiguration(
        mergifyConfiguration.replace(
          "branch_protection_injection_mode: queue",
          "branch_protection_injection_mode: none",
        ),
      ).join("\n"),
    ).toContain("inject the strict protected-main ruleset");

    expect(
      validateMergifyConfiguration(
        mergifyConfiguration.replace("max_parallel_checks: 1", "max_parallel_checks: 2"),
      ).join("\n"),
    ).toContain("strict-ruleset-compatible in-place checks");

    expect(
      validateMergifyConfiguration(
        mergifyConfiguration.replace(
          "merge_conditions:\n      - base = main",
          "merge_conditions:\n      - check-success = impossible",
        ),
      ).join("\n"),
    ).toContain("strict-ruleset-compatible in-place checks");
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
    const errors = errorsFor(
      ciWorkflow
        .replace("pull_request:", "pull_request_target:")
        .replace("contents: read", "contents: write"),
    );
    expect(errors).toContain("must not use pull_request_target");
    expect(errors).toContain("unsupported contents: write");
  });

  it("requires approved direct and static-matrix runners", () => {
    expect(errorsFor(ciWorkflow.replace("runner: macos-15", "runner: macos-15-intel"))).toContain(
      "references unsupported runner macos-15-intel",
    );
    expect(
      errorsFor(
        ciWorkflow.replace("runs-on: ${{ matrix.runner }}", "runs-on: ${{ inputs.runner }}"),
      ),
    ).toContain("references unsupported runner ${{ inputs.runner }}");
  });

  it("requires the exact three-runner unit matrix with fail-fast disabled", () => {
    expect(errorsFor(ciWorkflow.replace("fail-fast: false", "fail-fast: true"))).toContain(
      "unit must use a fail-fast: false static include matrix",
    );
    expect(
      errorsFor(
        ciWorkflow.replace(
          "runner: windows-2022\n          - platform: macos",
          "runner: ubuntu-24.04\n          - platform: macos",
        ),
      ),
    ).toContain("unit matrix entry 2 has drifted");
  });

  it("requires Linux coverage tests and non-Linux full unit suites", () => {
    const filteredLinux = errorsFor(
      ciWorkflow.replace("run: bun run test:ci", "run: bun run test:ci --filter=@synara/web"),
    );
    expect(filteredLinux).toContain("unit must run exactly one Linux-only bun run test:ci command");
    expect(filteredLinux).toContain("must not own an additional, filtered, or chained");

    const filteredNonLinux = errorsFor(
      ciWorkflow.replace("run: bun turbo test", "run: bun turbo test --filter=@synara/web"),
    );
    expect(filteredNonLinux).toContain(
      "unit must run exactly one non-Linux bun turbo test command",
    );
    expect(filteredNonLinux).toContain("must not own an additional, filtered, or chained");

    const broadLinuxCondition = errorsFor(
      ciWorkflow.replace(
        ciRootTestStep,
        ciRootTestStep.replace(
          "if: matrix.platform == 'linux'",
          "if: matrix.platform != 'windows'",
        ),
      ),
    );
    expect(broadLinuxCondition).toContain(
      "unit bun run test:ci command must run only for matrix.platform == 'linux' and fail closed",
    );

    const broadNonLinuxCondition = errorsFor(
      ciWorkflow.replace(
        nonLinuxUnitTestStep,
        nonLinuxUnitTestStep.replace(
          "if: matrix.platform != 'linux'",
          "if: matrix.platform != 'windows'",
        ),
      ),
    );
    expect(broadNonLinuxCondition).toContain(
      "unit bun turbo test command must run only when matrix.platform != 'linux' and fail closed",
    );

    const nonFailingLinux = errorsFor(
      ciWorkflow.replace(
        ciRootTestStep,
        ciRootTestStep.replace(
          "        timeout-minutes: 30",
          "        continue-on-error: true\n        timeout-minutes: 30",
        ),
      ),
    );
    expect(nonFailingLinux).toContain(
      "unit bun run test:ci command must run only for matrix.platform == 'linux' and fail closed",
    );

    const nonFailingNonLinux = errorsFor(
      ciWorkflow.replace(
        nonLinuxUnitTestStep,
        nonLinuxUnitTestStep.replace(
          "        timeout-minutes: 30",
          "        continue-on-error: true\n        timeout-minutes: 30",
        ),
      ),
    );
    expect(nonFailingNonLinux).toContain(
      "unit bun turbo test command must run only when matrix.platform != 'linux' and fail closed",
    );
  });

  it("prepares the Windows Job launcher before the Windows full-suite member", () => {
    const missingSetup = errorsFor(
      ciWorkflow.replace(
        "run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64",
        "run: echo skipped-launcher-build",
      ),
    );
    expect(missingSetup).toContain("unit must run exactly one Windows launcher setup command");

    const broadSetup = errorsFor(
      ciWorkflow.replace("if: matrix.platform == 'windows'", "if: matrix.platform != 'macos'"),
    );
    expect(broadSetup).toContain(
      "unit Windows launcher setup must run only for matrix.platform == 'windows' and fail closed",
    );

    const setupStep = [
      "      - name: Build Windows Job launcher for unit suite",
      "        if: matrix.platform == 'windows'",
      "        run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64",
    ].join("\n");
    const misplacedSetup = errorsFor(
      ciWorkflow
        .replace(`${setupStep}\n\n`, "")
        .replace(`${nonLinuxUnitTestStep}\n`, `${nonLinuxUnitTestStep}\n\n${setupStep}\n`),
    );
    expect(misplacedSetup).toContain("unit Windows launcher setup must run before bun turbo test");
  });

  it("retains unit-matrix timeout headroom", () => {
    const shortJob = errorsFor(
      ciWorkflow.replace(
        "  unit:\n    name: unit_${{ matrix.platform }}\n    runs-on: ${{ matrix.runner }}\n    timeout-minutes: 40",
        "  unit:\n    name: unit_${{ matrix.platform }}\n    runs-on: ${{ matrix.runner }}\n    timeout-minutes: 30",
      ),
    );
    expect(shortJob).toContain("unit job timeout must be 40 minutes");

    const shortLinuxStep = errorsFor(
      ciWorkflow.replace(
        ciRootTestStep,
        ciRootTestStep.replace("timeout-minutes: 30", "timeout-minutes: 20"),
      ),
    );
    expect(shortLinuxStep).toContain("unit bun run test:ci timeout must be 30 minutes");

    const shortNonLinuxStep = errorsFor(
      ciWorkflow.replace(
        nonLinuxUnitTestStep,
        nonLinuxUnitTestStep.replace("timeout-minutes: 30", "timeout-minutes: 20"),
      ),
    );
    expect(shortNonLinuxStep).toContain("unit bun turbo test timeout must be 30 minutes");
  });

  it("rejects duplicated curated or broad unit suites in native jobs", () => {
    const curatedWindows = replaceOccurrence(
      ciWorkflow,
      "      - name: Verify Super Synara identity\n        run: bun run brand:check",
      "      - name: Verify Super Synara identity\n        run: bun run brand:check\n\n      - name: Curated regression\n        run: bun run --cwd apps/server test src/main.test.ts",
      1,
    );
    expect(errorsFor(curatedWindows)).toContain(
      "windows_x64 must not duplicate unit suites or maintain a curated test allowlist",
    );

    const broadMac = replaceOccurrence(
      ciWorkflow,
      "      - name: Build desktop pipeline\n        env:",
      "      - name: Duplicate desktop suite\n        run: bun run --cwd apps/desktop test\n\n      - name: Build desktop pipeline\n        env:",
      2,
    );
    expect(errorsFor(broadMac)).toContain(
      "macos_arm64 must not duplicate unit suites or maintain a curated test allowlist",
    );
  });

  it("retains the exact Windows Job launcher and containment gates", () => {
    for (const [command, sourceCommand, occurrence] of [
      [
        "node apps/server/scripts/build-windows-job-launcher.mjs --arch x64",
        "node apps/server/scripts/build-windows-job-launcher.mjs --arch x64",
        2,
      ],
      [
        "node apps/server/scripts/build-windows-job-launcher.mjs --arch arm64",
        "node apps/server/scripts/build-windows-job-launcher.mjs --arch arm64",
        1,
      ],
      [
        "bun run --cwd apps/server test src/provider/windowsProviderProcess.test.ts src/provider/windowsProviderProcess.windows.test.ts",
        "bun run --cwd apps/server test\n          src/provider/windowsProviderProcess.test.ts\n          src/provider/windowsProviderProcess.windows.test.ts",
        1,
      ],
    ] as const) {
      const drifted = replaceOccurrence(
        ciWorkflow,
        sourceCommand,
        `echo replaced ${command}`,
        occurrence,
      );
      expect(errorsFor(drifted)).toContain(`windows_x64 must run exact gate command: ${command}`);
    }
  });

  it("binds monorepo test ownership to the unit matrix only", () => {
    const missingLinux = errorsFor(ciWorkflow.replace("run: bun run test:ci", "run: echo skipped"));
    expect(missingLinux).toContain("unit must run exactly one Linux-only bun run test:ci command");

    const missingNonLinux = errorsFor(
      ciWorkflow.replace("run: bun turbo test", "run: echo skipped"),
    );
    expect(missingNonLinux).toContain("unit must run exactly one non-Linux bun turbo test command");

    const duplicateLinux = errorsFor(
      ciWorkflow.replace(`${ciRootTestStep}\n`, `${ciRootTestStep}\n\n${ciRootTestStep}\n`),
    );
    expect(duplicateLinux).toContain(
      "unit must run exactly one Linux-only bun run test:ci command",
    );

    const duplicateNonLinux = errorsFor(
      ciWorkflow.replace(
        `${nonLinuxUnitTestStep}\n`,
        `${nonLinuxUnitTestStep}\n\n${nonLinuxUnitTestStep}\n`,
      ),
    );
    expect(duplicateNonLinux).toContain(
      "unit must run exactly one non-Linux bun turbo test command",
    );

    const missingUnitTestId = errorsFor(
      ciWorkflow.replace(ciRootTestStep, ciRootTestStep.replace("        id: unit_tests\n", "")),
    );
    expect(missingUnitTestId).toContain(
      "unit bun run test:ci must use id unit_tests for report upload conditions",
    );

    const duplicate = errorsFor(
      ciWorkflow.replace(
        "      - name: Build desktop pipeline\n        run: bun run build:desktop",
        "      - name: Duplicate full suite\n        run: bun run test\n\n      - name: Build desktop pipeline\n        run: bun run build:desktop",
      ),
    );
    expect(duplicate).toContain(
      "quality_linux must not own an additional, filtered, or chained monorepo-wide unit suite",
    );
  });

  it("requires fail-closed, Linux-only Codecov coverage and test-result uploads", () => {
    const missingCoverageUpload = errorsFor(
      ciWorkflow.replace(`${codecovCoverageUploadStep}\n\n`, ""),
    );
    expect(missingCoverageUpload).toContain(
      "unit must define exactly one Upload coverage reports to Codecov step",
    );

    const wrongTestReportType = errorsFor(
      ciWorkflow.replace("report_type: test_results", "report_type: coverage"),
    );
    expect(wrongTestReportType).toContain(
      "Upload test results to Codecov must set report_type to test_results",
    );

    const permissiveCoverageInput = errorsFor(
      ciWorkflow.replace(
        codecovCoverageUploadStep,
        codecovCoverageUploadStep.replace("fail_ci_if_error: true", "fail_ci_if_error: false"),
      ),
    );
    expect(permissiveCoverageInput).toContain(
      "Upload coverage reports to Codecov must fail closed on Codecov upload errors",
    );

    const nonBlockingCoverageStep = errorsFor(
      ciWorkflow.replace(
        codecovCoverageUploadStep,
        codecovCoverageUploadStep.replace(
          "      - name: Upload coverage reports to Codecov",
          "      - name: Upload coverage reports to Codecov\n        continue-on-error: true",
        ),
      ),
    );
    expect(nonBlockingCoverageStep).toContain(
      "Upload coverage reports to Codecov must fail closed",
    );

    const nonLinuxCoverage = errorsFor(
      ciWorkflow.replace(
        codecovCondition,
        codecovCondition.replace("matrix.platform == 'linux' && ", ""),
      ),
    );
    expect(nonLinuxCoverage).toContain(
      "Upload coverage reports to Codecov must run only for completed Linux unit tests",
    );

    const uploadBeforeTests = errorsFor(
      ciWorkflow
        .replace(`${codecovCoverageUploadStep}\n\n`, "")
        .replace(`${ciRootTestStep}\n`, `${codecovCoverageUploadStep}\n\n${ciRootTestStep}\n`),
    );
    expect(uploadBeforeTests).toContain(
      "Upload coverage reports to Codecov must run after bun run test:ci",
    );
  });

  it("requires fork-safe, fail-closed, Linux-only Mergify JUnit ingestion", () => {
    const missingUpload = errorsFor(ciWorkflow.replace(`${mergifyUploadStep}\n\n`, ""));
    expect(missingUpload).toContain(
      "unit must define exactly one Upload test results to Mergify CI Insights step",
    );

    const unsafeForkUpload = errorsFor(ciWorkflow.replace(mergifyCondition, codecovCondition));
    expect(unsafeForkUpload).toContain(
      "Mergify upload must be Linux-only, completed-test, and fork safe",
    );

    const nonLinuxUpload = errorsFor(
      ciWorkflow.replace(
        mergifyCondition,
        mergifyCondition.replace("matrix.platform == 'linux' && ", ""),
      ),
    );
    expect(nonLinuxUpload).toContain(
      "Mergify upload must be Linux-only, completed-test, and fork safe",
    );

    const wrongCredential = errorsFor(
      ciWorkflow.replace("token: ${{ secrets.MERGIFY_TOKEN }}", "token: ${{ github.token }}"),
    );
    expect(wrongCredential).toContain(
      "Mergify upload must ingest only the six expected JUnit reports",
    );

    const nonBlockingUpload = errorsFor(
      ciWorkflow.replace(
        mergifyUploadStep,
        mergifyUploadStep.replace(
          "      - name: Upload test results to Mergify CI Insights",
          "      - name: Upload test results to Mergify CI Insights\n        continue-on-error: true",
        ),
      ),
    );
    expect(nonBlockingUpload).toContain("Mergify upload must fail closed");

    const missingVerification = errorsFor(ciWorkflow.replace(`${mergifyVerificationStep}\n\n`, ""));
    expect(missingVerification).toContain(
      "unit must define exactly one Verify Mergify test results upload step",
    );

    const permissiveVerification = errorsFor(
      ciWorkflow.replace(
        'run: test "$MERGIFY_UPLOAD_OUTCOME" = "success"',
        'run: test "$MERGIFY_UPLOAD_OUTCOME" != "rejected"',
      ),
    );
    expect(permissiveVerification).toContain(
      "Mergify upload verification must fail closed unless the Linux upload succeeds",
    );
  });

  it("keeps test reporting owned by the Linux member of the unit matrix", () => {
    const offOwnerCoverage = errorsFor(
      ciWorkflow
        .replace(`${codecovCoverageUploadStep}\n\n`, "")
        .replace(
          "      - name: Build desktop pipeline\n        run: bun run build:desktop",
          `${codecovCoverageUploadStep}\n\n      - name: Build desktop pipeline\n        run: bun run build:desktop`,
        ),
    );
    expect(offOwnerCoverage).toContain("must define exactly two unit-owned Codecov upload actions");
    expect(offOwnerCoverage).toContain(
      "test reporting steps must belong only to the Linux member of the unit matrix",
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

    const undersizedSwiftTimeout = validFiles();
    undersizedSwiftTimeout.set(
      ".github/workflows/codeql.yml",
      codeqlWorkflow.replace("    timeout-minutes: 60", "    timeout-minutes: 30"),
    );
    expect(validateWorkflowContracts(undersizedSwiftTimeout, policy()).join("\n")).toContain(
      "codeql-swift timeout-minutes must equal 60",
    );
  });

  it("limits release scheduling writes to draft and called publication contents", () => {
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
        "  dispatch:\n    uses: ./.github/workflows/super-synara-prerelease.yml\n    permissions:\n      contents: write",
        "  dispatch:\n    uses: ./.github/workflows/super-synara-prerelease.yml\n    permissions:\n      actions: write\n      contents: write",
      ),
    );
    expect(validateWorkflowContracts(excessiveDispatchPermission, policy()).join("\n")).toContain(
      "unsupported actions: write at jobs.dispatch.permissions",
    );

    const publication = validFiles();
    publication.set(
      ".github/workflows/super-synara-prerelease.yml",
      `name: Super Synara prerelease
on:
  workflow_call:
permissions:
  contents: read
jobs:
  draft_admission:
    runs-on: ubuntu-24.04
    permissions:
      contents: write
  publish:
    runs-on: ubuntu-24.04
    permissions:
      contents: write
`,
    );
    expect(validateWorkflowContracts(publication, policy())).toEqual([]);

    const excessivePreflightPermission = new Map(publication);
    excessivePreflightPermission.set(
      ".github/workflows/super-synara-prerelease.yml",
      publication
        .get(".github/workflows/super-synara-prerelease.yml")!
        .replace("  draft_admission:", "  preflight:"),
    );
    expect(validateWorkflowContracts(excessivePreflightPermission, policy()).join("\n")).toContain(
      "unsupported contents: write at jobs.preflight.permissions",
    );
  });

  it("keeps formatting, lint, and typechecking blocking on Linux and Windows", () => {
    expect(errorsFor(ciWorkflow.replace("run: bun run fmt:check", "run: bun run fmt"))).toContain(
      "quality_linux must run exact gate command: bun run fmt:check",
    );
    expect(
      errorsFor(
        ciWorkflow.replace(
          "      - name: Typecheck\n        run: bun run typecheck",
          "      - name: Typecheck\n        continue-on-error: true\n        run: bun run typecheck",
        ),
      ),
    ).toContain("quality_linux gate must be unconditional and fail closed: bun run typecheck");

    const windowsTypecheck = ciWorkflow.lastIndexOf("run: bun run typecheck");
    const driftedWindows =
      ciWorkflow.slice(0, windowsTypecheck) +
      "run: bun run typecheck --filter=web" +
      ciWorkflow.slice(windowsTypecheck + "run: bun run typecheck".length);
    expect(errorsFor(driftedWindows)).toContain(
      "quality_windows must run exact gate command: bun run typecheck",
    );

    const serializedQuality = errorsFor(
      ciWorkflow.replace(
        "      - name: Verify Super Synara identity\n        run: bun run brand:check",
        "      - name: Verify Super Synara identity\n        run: bun run brand:check\n\n      - name: Duplicate format gate\n        run: bun run fmt:check",
      ),
    );
    expect(serializedQuality).toContain(
      "windows_x64 must not serialize Windows formatting, lint, or typechecking before its artifact",
    );

    const delayedQuality = errorsFor(
      ciWorkflow.replace(
        "  quality_windows:\n    name: quality_windows\n    runs-on: windows-2022",
        "  quality_windows:\n    name: quality_windows\n    needs: windows_x64\n    runs-on: windows-2022",
      ),
    );
    expect(delayedQuality).toContain(
      "quality_windows must run independently of artifact producers",
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
        `${nativeDesktopBuildStep}\n\n${windowsPersistenceSmokeStep}`,
        `${windowsPersistenceSmokeStep}\n\n${nativeDesktopBuildStep}`,
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

  it("keeps stable browser tests blocking and only registry-backed geometry nonblocking", () => {
    const stableNonblocking = ciWorkflow.replace(
      "      - name: Browser test (stable)\n        timeout-minutes: 20",
      "      - name: Browser test (stable)\n        continue-on-error: true\n        timeout-minutes: 20",
    );
    expect(errorsFor(stableNonblocking)).toContain(
      "quality_linux gate must be unconditional and fail closed: bun run --cwd apps/web test:browser:stable",
    );
    expect(errorsFor(stableNonblocking)).toContain(
      "may use continue-on-error only for registered quarantine runs",
    );

    const directGeometry = errorsFor(
      ciWorkflow.replace(
        "node scripts/quarantine-registry.ts run --platform linux",
        "bun run --cwd apps/web test:browser:geometry",
      ),
    );
    expect(directGeometry).toContain(
      "must run the registered linux quarantine as the sole nonblocking test step",
    );

    const missingBaseline = errorsFor(
      ciWorkflow.replace(
        ' --baseline-ref "${{ github.event.pull_request.base.sha || github.event.before }}"',
        "",
      ),
    );
    expect(missingBaseline).toContain("must publish the linux quarantine summary");
  });

  it("keeps the required quality context as an exact fail-closed aggregate", () => {
    const missingBrowserDependency = errorsFor(ciWorkflow.replace("      - browser_windows\n", ""));
    expect(missingBrowserDependency).toContain(
      "quality aggregate must depend on the exact merge-blocking quality job set",
    );

    const missingUnitDependency = errorsFor(ciWorkflow.replace("      - unit\n", ""));
    expect(missingUnitDependency).toContain(
      "quality aggregate must depend on the exact merge-blocking quality job set",
    );

    const weakenedBrowserResult = errorsFor(
      ciWorkflow.replace(
        '          test "${{ needs.browser_windows.result }}" = success',
        '          test "${{ needs.browser_windows.result }}" != failure',
      ),
    );
    expect(weakenedBrowserResult).toContain("quality must run exact gate command");

    const weakenedUnitResult = errorsFor(
      ciWorkflow.replace(
        '          test "${{ needs.unit.result }}" = success',
        '          test "${{ needs.unit.result }}" != failure',
      ),
    );
    expect(weakenedUnitResult).toContain("quality must run exact gate command");

    const reportingInAggregate = errorsFor(
      ciWorkflow.replace(
        "      - name: Require every quality dependency to succeed",
        `${codecovCoverageUploadStep}\n\n      - name: Require every quality dependency to succeed`,
      ),
    );
    expect(reportingInAggregate).toContain(
      "test reporting steps must belong only to the Linux member of the unit matrix",
    );
    expect(reportingInAggregate).toContain("quality aggregate must contain only its result gate");

    expect(
      errorsFor(
        ciWorkflow.replace(
          "  quality:\n    name: quality\n    if: always()",
          "  quality:\n    name: quality\n    if: success()",
        ),
      ),
    ).toContain("quality aggregate must run with always() and fail closed");
  });

  it("pins artifact layout so E2E downloads land at repository-relative runtime paths", () => {
    expect(errorsFor(ciWorkflow.replace("            apps/web/dist/**\n", ""))).toContain(
      "artifact desktop-build-linux paths have drifted",
    );
    expect(
      errorsFor(
        ciWorkflow.replace(
          "          path: .\n\n      - name: Install Linux desktop browser dependencies",
          "          path: apps\n\n      - name: Install Linux desktop browser dependencies",
        ),
      ),
    ).toContain("e2e_linux artifact desktop-build-linux must use path .");
  });

  it("keeps Linux and Windows E2E blocking and independently bound to their producers", () => {
    expect(
      errorsFor(ciWorkflow.replace("xvfb-run -a bun run test:e2e", "bun run test:e2e")),
    ).toContain("e2e_linux must run exact gate command: xvfb-run -a bun run test:e2e");

    expect(
      errorsFor(
        ciWorkflow.replace(
          "  e2e_linux:\n    name: e2e_linux\n    needs: quality_linux",
          "  e2e_linux:\n    name: e2e_linux\n    needs: windows_x64",
        ),
      ),
    ).toContain("e2e_linux must depend only on its quality_linux artifact producer");

    expect(
      errorsFor(
        ciWorkflow.replace(
          "      - name: Run Windows desktop E2E\n        run: bun run test:e2e",
          "      - name: Run Windows desktop E2E\n        continue-on-error: true\n        run: bun run test:e2e",
        ),
      ),
    ).toContain("may use continue-on-error only for registered quarantine runs");

    expect(
      errorsFor(
        ciWorkflow.replace(
          "  e2e_windows:\n    name: e2e_windows\n    needs: windows_x64",
          "  e2e_windows:\n    name: e2e_windows\n    needs: quality",
        ),
      ),
    ).toContain("e2e_windows must depend only on its windows_x64 artifact producer");
  });

  it("requires native architecture, build, and smoke gates in order", () => {
    expect(errorsFor(ciWorkflow.replace('test "$(uname -m)" = arm64', "uname -m"))).toContain(
      'macos_arm64 must run exact gate command: test "$(uname -m)" = arm64',
    );
    expect(
      errorsFor(
        replaceOccurrence(
          ciWorkflow,
          "      - name: Smoke unpacked desktop in isolated state\n        env:",
          "      - name: Smoke unpacked desktop in isolated state\n        continue-on-error: true\n        env:",
          2,
        ),
      ),
    ).toContain("gate must be unconditional and fail closed: bun run test:desktop-smoke");
  });

  it("rejects job-level write-all in allowed workflows", () => {
    expect(
      errorsFor(
        ciWorkflow.replace(
          "  quality:\n    name: quality",
          "  quality:\n    permissions: write-all\n    name: quality",
        ),
      ),
    ).toContain("unsupported *: write at jobs.quality.permissions");
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

  it("parses policy identity and restricts the downstream vouch source", () => {
    expect(parseWorkflowPolicy(JSON.stringify(policy())).repository).toBe("slashdevcorpse/synara");
    expect(() =>
      parseWorkflowPolicy(JSON.stringify({ ...policy(), repository: "other/repository" })),
    ).toThrow("must equal slashdevcorpse/synara");
    expect(validateVouchedConfiguration("# owner only\ngithub:slashdevcorpse\n")).toEqual([]);
    expect(validateVouchedConfiguration("github:slashdevcorpse\ngithub:Emanuele-web04\n")).toEqual([
      ".github/VOUCHED.td must contain exactly one trusted identity: github:slashdevcorpse.",
    ]);
  });
});
