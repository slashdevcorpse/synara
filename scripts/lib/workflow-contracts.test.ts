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
const pinnedSetupBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2";
const pinnedSetupNode = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6";
const pinnedCache = "actions/cache@caa296126883cff596d87d8935842f9db880ef25 # v5";
const pinnedUploadArtifact =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7";
const pinnedDownloadArtifact =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8";
const pinnedCodecov = "codecov/codecov-action@0fb7174895f61a3b6b78fc075e0cd60383518dac # v5.5.5";
const codecovCondition =
  "${{ matrix.platform == 'linux' && !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') }}";
const codecovToken = "${{ secrets.CODECOV_TOKEN }}";
const pinnedMergify = "Mergifyio/gha-mergify-ci@8173bc3c1d337d3367454672d50cfdf6f0273396 # v23";
const mergifyCondition =
  "${{ matrix.platform == 'linux' && !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') && (github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository) }}";
const disabledPaths = [
  ".github/workflows/issue-labels.yml",
  ".github/workflows/pr-size.yml",
  ".github/workflows/pr-vouch.yml",
  ".github/workflows/release.yml",
] as const;
const linuxPlaywrightCachePath = "~/.cache/ms-playwright";
const windowsPlaywrightCachePath = "~\\AppData\\Local\\ms-playwright";
const quarantineBaselineRef = '"${{ github.event.pull_request.base.sha || github.event.before }}"';

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
  "      - env:",
  "          SYNARA_DESKTOP_FLAVOR: super",
  "        run: bun run build:desktop",
].join("\n");
const windowsPackagedCliGateStep = "      - run: node apps/server/scripts/cli.ts publish --dry-run";
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
  "        env:",
  "          TURBO_CONCURRENCY: ${{ matrix.turbo_concurrency }}",
  "        run: bun run test:ci",
].join("\n");
const nonLinuxUnitTestStep = [
  "      - name: Run cross-platform unit suite",
  "        if: matrix.platform != 'linux'",
  "        timeout-minutes: 30",
  "        env:",
  "          TURBO_CONCURRENCY: ${{ matrix.turbo_concurrency }}",
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
const mergifyVerificationStep = [
  "      - name: Verify Mergify test results upload",
  `        if: ${mergifyCondition}`,
  "        env:",
  "          MERGIFY_UPLOAD_OUTCOME: ${{ steps.mergify_ci.outputs.test_results_upload }}",
  '        run: test "$MERGIFY_UPLOAD_OUTCOME" = "success"',
].join("\n");
const ciWorkflow = `name: CI
on:
  pull_request:
  push:
permissions:
  contents: read
jobs:
  quality_linux:
    if: false
    runs-on: ubuntu-24.04
    steps:
      - uses: ${pinnedCheckout}
      - name: Cache Playwright browsers
        uses: ${pinnedCache}
        with:
          path: ${linuxPlaywrightCachePath}
      - run: node scripts/quarantine-registry.ts validate
      - run: bun run --cwd apps/web test:browser:install
      - run: node scripts/quarantine-registry.ts inventory --platform linux
      - name: Browser test (stable)
        run: bun run --cwd apps/web test:browser:stable
      - name: Browser test (registered Linux quarantine)
        continue-on-error: true
        run: node scripts/quarantine-registry.ts run --platform linux
      - name: Summarize Linux quarantine
        if: always()
        run: node scripts/quarantine-registry.ts summary --platform linux --baseline-ref ${quarantineBaselineRef} --github-step-summary
      - run: bun run build:desktop
      - name: Upload Linux desktop E2E build
        uses: ${pinnedUploadArtifact}
        with:
          name: desktop-build-linux
          path: |
            apps/desktop/dist-electron/**
            apps/server/dist/**
            apps/web/dist/**
            packages/contracts/dist/**
            packages/effect-acp/dist/**
          if-no-files-found: error
          retention-days: 1
  quality_windows:
    runs-on: windows-2022
    timeout-minutes: 45
    steps:
      - uses: ${pinnedCheckout}
      - uses: ${pinnedSetupBun}
      - uses: ${pinnedSetupNode}
      - uses: ${pinnedCache}
      - run: bun install --frozen-lockfile
      - run: bun run fmt:check
      - run: bun run lint
      - run: bun run typecheck
  unit:
    runs-on: \${{ matrix.runner }}
    timeout-minutes: 40
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows
            runner: windows-2022
            turbo_concurrency: "1"
    steps:
      - uses: ${pinnedCheckout}
      - if: matrix.platform == 'windows'
        run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64
${ciRootTestStep}
${nonLinuxUnitTestStep}
${mergifyUploadStep}
${mergifyVerificationStep}
${codecovCoverageUploadStep}
${codecovTestResultsUploadStep}
  browser_windows:
    runs-on: windows-2022
    timeout-minutes: 40
    steps:
      - name: Cache Playwright browsers
        uses: ${pinnedCache}
        with:
          path: ${windowsPlaywrightCachePath}
      - run: bun install --frozen-lockfile
      - run: node scripts/quarantine-registry.ts validate
      - run: bun run --cwd apps/web playwright install chromium
      - run: node scripts/quarantine-registry.ts inventory --platform windows
      - name: Browser test (stable)
        run: bun run --cwd apps/web test:browser:stable
      - name: Browser test (registered Windows quarantine)
        continue-on-error: true
        run: node scripts/quarantine-registry.ts run --platform windows
      - name: Summarize Windows quarantine
        if: always()
        run: node scripts/quarantine-registry.ts summary --platform windows --baseline-ref ${quarantineBaselineRef} --github-step-summary
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
      - run: bun run --cwd apps/server test src/windowsProcessEffect.test.ts src/codexAppServerManager.test.ts src/provider/Layers/ProviderHealth.test.ts src/provider/acp/AcpJsonRpcConnection.test.ts src/persistence/MigrationBackup.test.ts src/restoreMigrationBackup.test.ts
      - run: bun run --cwd apps/desktop test src/desktopMigrationRecovery.test.ts src/desktopStorageMigration.test.ts src/windowState.test.ts src/updateState.test.ts
      - run: bun run --cwd scripts test check-brand-identity.test.ts verify-packaged-desktop-startup.test.ts lib/desktop-artifact-policy.test.ts lib/windows-authenticode.test.ts lib/windows-installer-qualification.test.ts lib/release-artifact-provenance.test.ts lib/super-synara-release-admission.test.ts lib/super-synara-workflow-contract.test.ts
      - run: node scripts/verify-workflow-contracts.ts
${nativeDesktopBuildStep}
${windowsPackagedCliGateStep}
${windowsPersistenceSmokeStep}
${windowsStartupSmokeStep}
      - name: Upload Windows desktop E2E build
        uses: ${pinnedUploadArtifact}
        with:
          name: desktop-build-windows
          path: |
            apps/desktop/dist-electron/**
            apps/server/dist/**
            apps/web/dist/**
            packages/contracts/dist/**
            packages/effect-acp/dist/**
          if-no-files-found: error
          retention-days: 1
  e2e_linux:
    name: e2e_linux
    if: false
    needs: quality_linux
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - run: bun install --frozen-lockfile
      - uses: ${pinnedDownloadArtifact}
        with:
          name: desktop-build-linux
          path: .
      - run: bun run --cwd apps/web playwright install-deps chromium
      - run: xvfb-run -a bun run test:e2e
      - if: failure()
        uses: ${pinnedUploadArtifact}
        with:
          name: desktop-e2e-linux-diagnostics
          path: apps/desktop/failure-diagnostics/**/failure-summary.json
          if-no-files-found: ignore
          retention-days: 7
  e2e_windows:
    name: e2e_windows
    needs: windows_x64
    runs-on: windows-2022
    timeout-minutes: 30
    steps:
      - run: bun install --frozen-lockfile
      - uses: ${pinnedDownloadArtifact}
        with:
          name: desktop-build-windows
          path: .
      - run: bun run test:e2e
      - if: failure()
        uses: ${pinnedUploadArtifact}
        with:
          name: desktop-e2e-windows-diagnostics
          path: apps/desktop/failure-diagnostics/**/failure-summary.json
          if-no-files-found: ignore
          retention-days: 7
  macos_arm64:
    if: false
    runs-on: macos-15
    steps:
      - run: test "$(uname -m)" = arm64
      - run: bun run brand:check
      - run: node scripts/node-pty-smoke.mjs
      - run: bun run --cwd apps/desktop test
${nativeDesktopBuildStep}
${macosPersistenceSmokeStep}
${macosStartupSmokeStep}
  quality:
    if: always()
    needs:
      - quality_linux
      - quality_windows
      - unit
      - browser_windows
      - e2e_linux
      - e2e_windows
      - macos_arm64
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - run: |
          test "\${{ needs.quality_linux.result }}" = skipped
          test "\${{ needs.quality_windows.result }}" = success
          test "\${{ needs.unit.result }}" = success
          test "\${{ needs.browser_windows.result }}" = success
          test "\${{ needs.e2e_linux.result }}" = skipped
          test "\${{ needs.e2e_windows.result }}" = success
          test "\${{ needs.macos_arm64.result }}" = skipped
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
    if: false
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

function ciErrors(workflow: string): string {
  const files = validFiles();
  files.set(".github/workflows/ci.yml", workflow);
  return validateWorkflowContracts(files, policy()).join("\n");
}

describe("workflow contracts", () => {
  it("accepts pinned, read-only PR CI and the narrowly scoped watcher", () => {
    expect(validateWorkflowContracts(validFiles(), policy())).toEqual([]);
    expect(validateMergifyConfiguration(mergifyConfiguration)).toEqual([]);
  });

  it("keeps only the three backlogged Linux CI lanes from executing", () => {
    expect(
      ciErrors(
        ciWorkflow.replace("  quality_linux:\n    if: false", "  quality_linux:\n    if: true"),
      ),
    ).toContain("quality_linux must remain disabled while Linux CI is backlogged");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "  e2e_linux:\n    name: e2e_linux\n    if: false",
          "  e2e_linux:\n    name: e2e_linux",
        ),
      ),
    ).toContain("e2e_linux must remain disabled while Linux CI is backlogged");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "        include:\n          - platform: windows",
          '        include:\n          - platform: linux\n            runner: ubuntu-24.04\n            turbo_concurrency: "50%"\n          - platform: windows',
        ),
      ),
    ).toContain("unit matrix must contain the exact required platforms");
  });

  it("keeps stable browser tests blocking and only registry-backed quarantine runs nonblocking", () => {
    const stableNonblocking = ciWorkflow.replace(
      "      - name: Browser test (stable)\n        run: bun run --cwd apps/web test:browser:stable",
      "      - name: Browser test (stable)\n        continue-on-error: true\n        run: bun run --cwd apps/web test:browser:stable",
    );
    expect(ciErrors(stableNonblocking)).toContain(
      "quality_linux browser gate must be unconditional and fail closed: bun run --cwd apps/web test:browser:stable",
    );
    expect(ciErrors(stableNonblocking)).toContain(
      "may use continue-on-error only for registered quarantine runs",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          "node scripts/quarantine-registry.ts run --platform linux",
          "bun run --cwd apps/web test:browser:geometry",
        ),
      ),
    ).toContain(
      "quality_linux must run the registered linux quarantine as the sole nonblocking test step",
    );

    expect(ciErrors(ciWorkflow.replace(` --baseline-ref ${quarantineBaselineRef}`, ""))).toContain(
      "quality_linux must publish the linux quarantine summary",
    );

    const chainedQuarantine = ciWorkflow.replace(
      "node scripts/quarantine-registry.ts run --platform linux",
      "node scripts/quarantine-registry.ts run --platform linux && bun run lint",
    );
    expect(ciErrors(chainedQuarantine)).toContain(
      "may use continue-on-error only for registered quarantine runs",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - run: node scripts/quarantine-registry.ts inventory --platform linux\n",
          "",
        ),
      ),
    ).toContain(
      "quality_linux must run exact browser gate command: node scripts/quarantine-registry.ts inventory --platform linux.",
    );

    const nonblockingInventory = ciWorkflow.replace(
      "      - run: node scripts/quarantine-registry.ts inventory --platform windows",
      "      - continue-on-error: true\n        run: node scripts/quarantine-registry.ts inventory --platform windows",
    );
    expect(ciErrors(nonblockingInventory)).toContain(
      "browser_windows browser gate must be unconditional and fail closed: node scripts/quarantine-registry.ts inventory --platform windows.",
    );

    const inventoryBeforeInstall = ciWorkflow.replace(
      "      - run: bun run --cwd apps/web test:browser:install\n      - run: node scripts/quarantine-registry.ts inventory --platform linux",
      "      - run: node scripts/quarantine-registry.ts inventory --platform linux\n      - run: bun run --cwd apps/web test:browser:install",
    );
    expect(ciErrors(inventoryBeforeInstall)).toContain(
      "quality_linux must install Playwright before quarantine inventory collection.",
    );
  });

  it("keeps Linux and Windows Playwright caches outside the checkout", () => {
    const checkoutCachePath = "${{ github.workspace }}/.playwright-browsers";
    expect(ciErrors(ciWorkflow.replace(linuxPlaywrightCachePath, checkoutCachePath))).toContain(
      `quality_linux must cache Playwright browsers at ${linuxPlaywrightCachePath}`,
    );
    expect(ciErrors(ciWorkflow.replace(windowsPlaywrightCachePath, checkoutCachePath))).toContain(
      `browser_windows must cache Playwright browsers at ${windowsPlaywrightCachePath}`,
    );
    expect(
      ciErrors(
        ciWorkflow.replace(
          "jobs:\n",
          `env:\n  PLAYWRIGHT_BROWSERS_PATH: ${checkoutCachePath}\njobs:\n`,
        ),
      ),
    ).toContain(
      "must use Playwright's OS-default browser paths without a workflow-level PLAYWRIGHT_BROWSERS_PATH override",
    );
  });

  it("requires an independent blocking Windows browser lane with registered quarantine reporting", () => {
    expect(
      ciErrors(
        ciWorkflow.replace(
          "  browser_windows:\n    runs-on: windows-2022",
          "  browser_windows:\n    runs-on: ubuntu-24.04",
        ),
      ),
    ).toContain("browser_windows must run on windows-2022");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - run: bun run --cwd apps/web playwright install chromium",
          "      - run: bun run --cwd apps/web playwright install firefox",
        ),
      ),
    ).toContain(
      "browser_windows must run exact browser gate command: bun run --cwd apps/web playwright install chromium",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - name: Browser test (registered Windows quarantine)\n        continue-on-error: true",
          "      - name: Browser test (registered Windows quarantine)",
        ),
      ),
    ).toContain(
      "browser_windows must run the registered windows quarantine as the sole nonblocking test step",
    );
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

    const misplacedMatrixRunner = validFiles();
    misplacedMatrixRunner.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "  release_smoke:",
        "  rogue:\n    runs-on: ${{ matrix.runner }}\n    steps:\n      - run: echo unsafe\n  release_smoke:",
      ),
    );
    expect(validateWorkflowContracts(misplacedMatrixRunner, policy()).join("\n")).toContain(
      "references unsupported runner ${{ matrix.runner }}",
    );
  });

  it("keeps the backlogged macOS lane disabled and architecture complete", () => {
    const enabled = validFiles();
    enabled.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "  macos_arm64:\n    if: false",
        "  macos_arm64:\n    if: ${{ github.event_name == 'push' }}",
      ),
    );
    expect(validateWorkflowContracts(enabled, policy()).join("\n")).toContain(
      "macos_arm64 must remain disabled while macOS CI is backlogged",
    );

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

    const missingPackagedCliGate = validFiles();
    missingPackagedCliGate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(`${windowsPackagedCliGateStep}\n`, ""),
    );
    expect(validateWorkflowContracts(missingPackagedCliGate, policy()).join("\n")).toContain(
      "windows_x64 must run exact post-build gate command: node apps/server/scripts/cli.ts publish --dry-run",
    );

    const preBuildPackagedCliGate = validFiles();
    preBuildPackagedCliGate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        `${nativeDesktopBuildStep}\n${windowsPackagedCliGateStep}`,
        `${windowsPackagedCliGateStep}\n${nativeDesktopBuildStep}`,
      ),
    );
    expect(validateWorkflowContracts(preBuildPackagedCliGate, policy()).join("\n")).toContain(
      "windows_x64 post-build gate must run after the desktop build: node apps/server/scripts/cli.ts publish --dry-run",
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
      "unit must run exactly one Linux-only bun run test:ci command",
    );

    const duplicateQualitySuite = validFiles();
    duplicateQualitySuite.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(`${ciRootTestStep}\n`, `${ciRootTestStep}\n${ciRootTestStep}\n`),
    );
    expect(validateWorkflowContracts(duplicateQualitySuite, policy()).join("\n")).toContain(
      "unit must run exactly one Linux-only bun run test:ci command",
    );

    const swappedWindowsRunner = validFiles();
    swappedWindowsRunner.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "  windows_x64:\n    runs-on: windows-2022",
        "  windows_x64:\n    runs-on: ubuntu-24.04",
      ),
    );
    expect(validateWorkflowContracts(swappedWindowsRunner, policy()).join("\n")).toContain(
      "windows_x64 must run on windows-2022",
    );

    const conditionalQuality = validFiles();
    conditionalQuality.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("  quality:\n    if: always()", "  quality:\n    if: success()"),
    );
    expect(validateWorkflowContracts(conditionalQuality, policy()).join("\n")).toContain(
      "quality aggregate must run with always() and fail closed",
    );

    const chainedReleaseSuite = validFiles();
    chainedReleaseSuite.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("          echo safe", "          bun run test && echo done"),
    );
    expect(validateWorkflowContracts(chainedReleaseSuite, policy()).join("\n")).toContain(
      "release_smoke must not own an additional, filtered, or chained monorepo-wide unit suite",
    );
  });

  it("locks the bounded Windows unit matrix and required quality aggregate", () => {
    const failFast = validFiles();
    failFast.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("      fail-fast: false", "      fail-fast: true"),
    );
    expect(validateWorkflowContracts(failFast, policy()).join("\n")).toContain(
      "unit must use a fail-fast: false static include matrix",
    );

    const concurrentWindows = validFiles();
    concurrentWindows.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        '            runner: windows-2022\n            turbo_concurrency: "1"',
        '            runner: windows-2022\n            turbo_concurrency: "50%"',
      ),
    );
    expect(validateWorkflowContracts(concurrentWindows, policy()).join("\n")).toContain(
      "unit matrix entry 1 has drifted",
    );

    const detachedConcurrency = validFiles();
    detachedConcurrency.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "          TURBO_CONCURRENCY: ${{ matrix.turbo_concurrency }}",
        '          TURBO_CONCURRENCY: "100%"',
      ),
    );
    expect(validateWorkflowContracts(detachedConcurrency, policy()).join("\n")).toContain(
      "unit bun run test:ci must set TURBO_CONCURRENCY to ${{ matrix.turbo_concurrency }}",
    );

    const filteredWindows = validFiles();
    filteredWindows.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "        run: bun turbo test",
        "        run: bun turbo test --filter=server",
      ),
    );
    expect(validateWorkflowContracts(filteredWindows, policy()).join("\n")).toContain(
      "unit must run exactly one non-Linux bun turbo test command",
    );

    const misplacedWindowsSetup = validFiles();
    misplacedWindowsSetup.set(
      ".github/workflows/ci.yml",
      ciWorkflow
        .replace(
          "      - if: matrix.platform == 'windows'\n        run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64\n",
          "",
        )
        .replace(
          `${nonLinuxUnitTestStep}\n`,
          `${nonLinuxUnitTestStep}\n      - if: matrix.platform == 'windows'\n        run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64\n`,
        ),
    );
    expect(validateWorkflowContracts(misplacedWindowsSetup, policy()).join("\n")).toContain(
      "unit Windows launcher setup must run before bun turbo test",
    );

    const permissiveWindowsQuality = validFiles();
    permissiveWindowsQuality.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: bun run lint",
        "      - continue-on-error: true\n        run: bun run lint",
      ),
    );
    expect(validateWorkflowContracts(permissiveWindowsQuality, policy()).join("\n")).toContain(
      "quality_windows required steps must be unconditional and fail closed",
    );

    const incompleteWindowsQuality = validFiles();
    incompleteWindowsQuality.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("      - run: bun run typecheck\n", ""),
    );
    expect(validateWorkflowContracts(incompleteWindowsQuality, policy()).join("\n")).toContain(
      "quality_windows must contain only the required setup, install, and quality steps",
    );

    const incompleteAggregate = validFiles();
    incompleteAggregate.set(".github/workflows/ci.yml", ciWorkflow.replace("      - unit\n", ""));
    expect(validateWorkflowContracts(incompleteAggregate, policy()).join("\n")).toContain(
      "quality aggregate must depend on the exact merge-blocking quality job set",
    );

    const missingWindowsAggregate = validFiles();
    missingWindowsAggregate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("      - quality_windows\n", ""),
    );
    expect(validateWorkflowContracts(missingWindowsAggregate, policy()).join("\n")).toContain(
      "quality aggregate must depend on the exact merge-blocking quality job set",
    );

    const permissiveAggregate = validFiles();
    permissiveAggregate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        '          test "${{ needs.unit.result }}" = success',
        '          test "${{ needs.unit.result }}" != failure',
      ),
    );
    expect(validateWorkflowContracts(permissiveAggregate, policy()).join("\n")).toContain(
      "quality must run exact aggregate gate command",
    );

    const missingE2eAggregate = validFiles();
    missingE2eAggregate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("      - e2e_linux\n", ""),
    );
    expect(validateWorkflowContracts(missingE2eAggregate, policy()).join("\n")).toContain(
      "quality aggregate must depend on the exact merge-blocking quality job set",
    );

    const missingWindowsE2eAggregate = validFiles();
    missingWindowsE2eAggregate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("      - e2e_windows\n", ""),
    );
    expect(validateWorkflowContracts(missingWindowsE2eAggregate, policy()).join("\n")).toContain(
      "quality aggregate must depend on the exact merge-blocking quality job set",
    );

    const missingMacosAggregate = validFiles();
    missingMacosAggregate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("      - macos_arm64\n", ""),
    );
    expect(validateWorkflowContracts(missingMacosAggregate, policy()).join("\n")).toContain(
      "quality aggregate must depend on the exact merge-blocking quality job set",
    );

    const permissiveE2eAggregate = validFiles();
    permissiveE2eAggregate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        '          test "${{ needs.e2e_windows.result }}" = success',
        '          test "${{ needs.e2e_windows.result }}" != failure',
      ),
    );
    expect(validateWorkflowContracts(permissiveE2eAggregate, policy()).join("\n")).toContain(
      "quality must run exact aggregate gate command",
    );
  });

  it("locks the cross-platform packaged desktop E2E artifact pipeline", () => {
    expect(
      ciErrors(
        ciWorkflow.replace(
          "            packages/effect-acp/dist/**",
          "            packages/effect-acp/build/**",
        ),
      ),
    ).toContain(
      "quality_linux must upload exact desktop-build-linux paths with one-day fail-closed retention",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          "          name: desktop-build-linux\n          path: .",
          "          name: desktop-build-linux\n          path: artifacts",
        ),
      ),
    ).toContain(
      "e2e_linux must download desktop-build-linux at the repository root and fail closed",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          "    needs: quality_linux\n    runs-on: ubuntu-24.04",
          "    needs: [quality_linux, unit]\n    runs-on: ubuntu-24.04",
        ),
      ),
    ).toContain("e2e_linux must need only its same-platform producer quality_linux");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "    needs: windows_x64\n    runs-on: windows-2022",
          "    needs: [windows_x64, unit]\n    runs-on: windows-2022",
        ),
      ),
    ).toContain("e2e_windows must need only its same-platform producer windows_x64");

    expect(
      ciErrors(ciWorkflow.replace("xvfb-run -a bun run test:e2e", "bun run test:e2e")),
    ).toContain(
      "e2e_linux must run exact packaged desktop E2E command: xvfb-run -a bun run test:e2e",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - run: bun run test:e2e\n      - if: failure()",
          "      - run: bun run --cwd apps/desktop test:e2e\n      - if: failure()",
        ),
      ),
    ).toContain("e2e_windows must run exact packaged desktop E2E command: bun run test:e2e");

    const alwaysUpload = ciWorkflow.replaceAll("      - if: failure()", "      - if: always()");
    const alwaysUploadErrors = ciErrors(alwaysUpload);
    expect(alwaysUploadErrors).toContain(
      "e2e_linux diagnostics must upload exact failure-only paths with seven-day retention",
    );
    expect(alwaysUploadErrors).toContain(
      "e2e_windows diagnostics must upload exact failure-only paths with seven-day retention",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - run: xvfb-run -a bun run test:e2e",
          "      - run: bun run build:desktop\n      - run: xvfb-run -a bun run test:e2e",
        ),
      ),
    ).toContain("e2e_linux must consume prebuilt artifacts without builds");

    for (const buildCommand of [
      "bun.exe run build",
      "BUN.EXE run build",
      "Bun run build",
      "bun run --silent build",
    ]) {
      expect(
        ciErrors(
          ciWorkflow.replace(
            "      - run: bun run test:e2e",
            `      - run: ${buildCommand}\n      - run: bun run test:e2e`,
          ),
        ),
      ).toContain("e2e_windows must consume prebuilt artifacts without builds");
    }

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - run: bun run test:e2e",
          "      - run: bun run build\n      - run: bun run test:e2e",
        ),
      ),
    ).toContain("e2e_windows must consume prebuilt artifacts without builds");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - if: failure()\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7",
          "      - uses: actions/upload-artifact@1111111111111111111111111111111111111111\n      - if: failure()\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7",
        ),
      ),
    ).toContain("e2e_linux must define exactly one pinned failure diagnostics upload");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - if: failure()\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7",
          "      - uses: Actions/upload-artifact@1111111111111111111111111111111111111111\n      - if: failure()\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7",
        ),
      ),
    ).toContain("e2e_linux must define exactly one pinned failure diagnostics upload");

    for (const unsafeDiagnosticPath of [
      "apps/desktop/test-results/**",
      "apps/desktop/playwright-report/**",
      "apps/desktop/test-results/**/runtime/protocol.jsonl",
      "apps/desktop/test-results/**/runtime/backend-logs/**",
      "apps/desktop/test-results/**/runtime/state.sqlite",
    ]) {
      const unsafeDiagnosticErrors = ciErrors(
        ciWorkflow.replaceAll(
          "          path: apps/desktop/failure-diagnostics/**/failure-summary.json",
          `          path: ${unsafeDiagnosticPath}`,
        ),
      );
      expect(unsafeDiagnosticErrors).toContain(
        "e2e_linux diagnostics must upload exact failure-only paths with seven-day retention",
      );
      expect(unsafeDiagnosticErrors).toContain(
        "e2e_windows diagnostics must upload exact failure-only paths with seven-day retention",
      );
      expect(unsafeDiagnosticErrors).toContain(
        "e2e_linux diagnostics must not expose raw Playwright, protocol, backend, or SQLite artifacts",
      );
      expect(unsafeDiagnosticErrors).toContain(
        "e2e_windows diagnostics must not expose raw Playwright, protocol, backend, or SQLite artifacts",
      );
    }

    expect(
      ciErrors(
        ciWorkflow.replaceAll(
          "          path: apps/desktop/failure-diagnostics/**/failure-summary.json",
          "          path: |\n            apps/desktop/failure-diagnostics/**/failure-summary.json\n            apps/desktop/test-results/**",
        ),
      ),
    ).toContain(
      "e2e_linux diagnostics must upload exact failure-only paths with seven-day retention",
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

    const missingVerification = validFiles();
    missingVerification.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(`${mergifyVerificationStep}\n`, ""),
    );
    expect(validateWorkflowContracts(missingVerification, policy()).join("\n")).toContain(
      "must define exactly one Verify Mergify test results upload step",
    );

    const permissiveVerification = validFiles();
    permissiveVerification.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        'run: test "$MERGIFY_UPLOAD_OUTCOME" = "success"',
        'run: test "$MERGIFY_UPLOAD_OUTCOME" != "rejected"',
      ),
    );
    expect(validateWorkflowContracts(permissiveVerification, policy()).join("\n")).toContain(
      "Mergify upload verification must fail closed unless upload succeeds",
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
    const enabledSwift = validFiles();
    enabledSwift.set(
      ".github/workflows/codeql.yml",
      codeqlWorkflow.replace("    if: false", "    if: ${{ github.event_name == 'push' }}"),
    );
    expect(validateWorkflowContracts(enabledSwift, policy()).join("\n")).toContain(
      "codeql-swift must remain disabled while macOS CI is backlogged",
    );

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
        `${nativeDesktopBuildStep}\n${windowsPackagedCliGateStep}\n${windowsPersistenceSmokeStep}`,
        `${windowsPersistenceSmokeStep}\n${nativeDesktopBuildStep}\n${windowsPackagedCliGateStep}`,
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
        "  quality:\n    if: always()",
        "  quality:\n    if: always()\n    permissions: write-all",
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
