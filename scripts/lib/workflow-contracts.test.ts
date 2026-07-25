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
const windowsPackagedCliGateStep = [
  "      - env:",
  "          npm_config_cache: ${{ runner.temp }}\\npm-cache",
  "        run: node apps/server/scripts/cli.ts publish --dry-run",
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
    name: quality_windows
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
    name: unit_windows_\${{ matrix.lane }}
    runs-on: \${{ matrix.runner }}
    timeout-minutes: 40
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows
            lane: cli_1
            runner: windows-2022
            turbo_concurrency: "1"
            test_command: bun run --cwd apps/server test --shard=1/2
          - platform: windows
            lane: cli_2
            runner: windows-2022
            turbo_concurrency: "1"
            test_command: bun run --cwd apps/server test --shard=2/2
          - platform: windows
            lane: workspace
            runner: windows-2022
            turbo_concurrency: "1"
            test_command: bun turbo test --filter=@synara/desktop --filter=@synara/web --filter=@synara/contracts --filter=@synara/shared --filter=@synara/scripts --filter=@synara/marketing --filter=effect-acp
    steps:
      - uses: ${pinnedCheckout}
      - if: matrix.lane == 'cli_1' || matrix.lane == 'cli_2'
        run: bun turbo build --filter=@synara/cli^...
      - if: matrix.lane == 'cli_1' || matrix.lane == 'cli_2'
        run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64
      - timeout-minutes: 30
        env:
          TURBO_CONCURRENCY: \${{ matrix.turbo_concurrency }}
        run: \${{ matrix.test_command }}
  unit_windows:
    name: unit_windows
    if: always()
    needs: unit
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - shell: bash
        run: test "\${{ needs.unit.result }}" = success
  browser_windows_workers:
    name: browser_windows_\${{ matrix.lane }}
    runs-on: \${{ matrix.runner }}
    timeout-minutes: 40
    strategy:
      fail-fast: false
      matrix:
        include:
          - lane: stable
            runner: windows-2022
          - lane: quarantine
            runner: windows-2022
    steps:
      - name: Cache Playwright browsers
        uses: ${pinnedCache}
        with:
          path: ${windowsPlaywrightCachePath}
      - run: bun install --frozen-lockfile
      - run: node scripts/quarantine-registry.ts validate
      - run: bun run --cwd apps/web playwright install chromium
      - if: matrix.lane == 'quarantine'
        run: node scripts/quarantine-registry.ts inventory --platform windows
      - name: Browser test (stable)
        if: matrix.lane == 'stable'
        run: bun run --cwd apps/web test:browser:stable
      - name: Browser test (registered Windows quarantine)
        if: matrix.lane == 'quarantine'
        continue-on-error: true
        run: node scripts/quarantine-registry.ts run --platform windows
      - name: Summarize Windows quarantine
        if: \${{ always() && matrix.lane == 'quarantine' }}
        run: node scripts/quarantine-registry.ts summary --platform windows --baseline-ref ${quarantineBaselineRef} --github-step-summary
  browser_windows:
    name: browser_windows
    if: always()
    needs: browser_windows_workers
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - shell: bash
        run: test "\${{ needs.browser_windows_workers.result }}" = success
  windows_e2e_build:
    name: windows_e2e_build
    runs-on: windows-2022
    timeout-minutes: 30
    steps:
      - run: bun install --frozen-lockfile
      - run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64
      - run: node apps/server/scripts/build-windows-job-launcher.mjs --arch arm64
      - env:
          SYNARA_DESKTOP_DISABLE_UPDATES: "1"
          SYNARA_DESKTOP_FLAVOR: super
        run: bun run build:desktop
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
  windows_x64:
    name: windows_x64
    runs-on: windows-2022
    steps:
      - name: Cache Bun, Turbo, and npm
        uses: ${pinnedCache}
        with:
          path: |
            ~/.bun/install/cache
            .turbo
            \${{ runner.temp }}\\npm-cache
          key: \${{ runner.os }}-windows-release-\${{ hashFiles('bun.lock') }}-\${{ hashFiles('package.json') }}-\${{ hashFiles('turbo.json') }}
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
    if: always()
    needs: windows_e2e_build
    runs-on: windows-2022
    timeout-minutes: 30
    steps:
      - shell: bash
        run: test "\${{ needs.windows_e2e_build.result }}" = success
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
    name: quality
    if: always()
    needs:
      - quality_linux
      - quality_windows
      - unit_windows
      - browser_windows
      - windows_x64
      - e2e_linux
      - e2e_windows
      - macos_arm64
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - shell: bash
        run: |
          test "\${{ needs.quality_linux.result }}" = skipped
          test "\${{ needs.quality_windows.result }}" = success
          test "\${{ needs.unit_windows.result }}" = success
          test "\${{ needs.browser_windows.result }}" = success
          test "\${{ needs.windows_x64.result }}" = success
          test "\${{ needs.e2e_linux.result }}" = skipped
          test "\${{ needs.e2e_windows.result }}" = success
          test "\${{ needs.macos_arm64.result }}" = skipped
  release_smoke:
    name: release_smoke
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    permissions:
      actions: read
      contents: read
    steps:
      - uses: ${pinnedCheckout}
      - uses: ${pinnedSetupBun}
      - uses: ${pinnedSetupNode}
      - run: bun install --frozen-lockfile --ignore-scripts
      - run: node scripts/validate-downstream-state.ts
      - run: node scripts/verify-workflow-contracts.ts
      - if: github.repository == 'slashdevcorpse/synara' && github.event_name == 'push' && github.ref == 'refs/heads/main'
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: node scripts/verify-workflow-contracts.ts --check-github-state
      - run: bun run brand:check
      - run: node scripts/release-smoke.ts
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
    ).toContain(
      "quality_linux backlog policy requires if: false and continue-on-error to be unset or false",
    );

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
      "      - if: matrix.lane == 'quarantine'\n        run: node scripts/quarantine-registry.ts inventory --platform windows",
      "      - if: matrix.lane == 'quarantine'\n        continue-on-error: true\n        run: node scripts/quarantine-registry.ts inventory --platform windows",
    );
    expect(ciErrors(nonblockingInventory)).toContain(
      "browser_windows_workers quarantine inventory must use its exact lane condition and blocking policy",
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
      `browser_windows_workers must cache Playwright browsers at ${windowsPlaywrightCachePath}`,
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
          "  browser_windows_workers:\n    name: browser_windows_${{ matrix.lane }}",
          "  browser_windows_workers:\n    name: browser_windows",
        ),
      ),
    ).toContain("browser_windows_workers must be an independent, bounded, fail-closed Windows lane matrix");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - run: bun run --cwd apps/web playwright install chromium",
          "      - run: bun run --cwd apps/web playwright install firefox",
        ),
      ),
    ).toContain(
      "browser_windows_workers must run exact browser gate command: bun run --cwd apps/web playwright install chromium",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - name: Browser test (registered Windows quarantine)\n        if: matrix.lane == 'quarantine'\n        continue-on-error: true",
          "      - name: Browser test (registered Windows quarantine)\n        if: matrix.lane == 'quarantine'",
        ),
      ),
    ).toContain(
      "browser_windows_workers registered quarantine must use its exact lane condition and blocking policy",
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
        "      - run: bun run brand:check\n      - run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64\n      - run: node apps/server/scripts/build-windows-job-launcher.mjs --arch arm64",
        "      - run: bun run brand:check\n      - run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64\n      - run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64",
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
    const swappedWindowsRunner = validFiles();
    swappedWindowsRunner.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "  windows_x64:\n    name: windows_x64\n    runs-on: windows-2022",
        "  windows_x64:\n    name: windows_x64\n    runs-on: ubuntu-24.04",
      ),
    );
    expect(validateWorkflowContracts(swappedWindowsRunner, policy()).join("\n")).toContain(
      "windows_x64 must run on windows-2022",
    );

    const conditionalQuality = validFiles();
    conditionalQuality.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "  quality:\n    name: quality\n    if: always()",
        "  quality:\n    name: quality\n    if: success()",
      ),
    );
    expect(validateWorkflowContracts(conditionalQuality, policy()).join("\n")).toContain(
      "quality aggregate must run with always() and fail closed",
    );

    const chainedReleaseSuite = validFiles();
    chainedReleaseSuite.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "      - run: node scripts/release-smoke.ts",
        "      - run: node scripts/release-smoke.ts\n      - run: bun run test && echo done",
      ),
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
      "unit ${{ matrix.test_command }} must set TURBO_CONCURRENCY to ${{ matrix.turbo_concurrency }}",
    );

    const filteredWindows = validFiles();
    filteredWindows.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace(
        "--filter=effect-acp",
        "--filter=@synara/unknown",
      ),
    );
    expect(validateWorkflowContracts(filteredWindows, policy()).join("\n")).toContain(
      "unit matrix entry 3 has drifted",
    );

    const misplacedWindowsSetup = validFiles();
    misplacedWindowsSetup.set(
      ".github/workflows/ci.yml",
      ciWorkflow
        .replace(
          "      - if: matrix.lane == 'cli_1' || matrix.lane == 'cli_2'\n        run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64\n",
          "",
        )
        .replace(
          "        run: ${{ matrix.test_command }}\n",
          "        run: ${{ matrix.test_command }}\n      - if: matrix.lane == 'cli_1' || matrix.lane == 'cli_2'\n        run: node apps/server/scripts/build-windows-job-launcher.mjs --arch x64\n",
        ),
    );
    expect(validateWorkflowContracts(misplacedWindowsSetup, policy()).join("\n")).toContain(
      "unit Windows launcher setup must run before the matrix-owned unit command",
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
    incompleteAggregate.set(
      ".github/workflows/ci.yml",
      ciWorkflow.replace("      - unit_windows\n", ""),
    );
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
        '          test "${{ needs.unit_windows.result }}" = success',
        '          test "${{ needs.unit_windows.result }}" != failure',
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

  it("keeps accelerated Windows lanes complete and fail closed", () => {
    expect(
      ciErrors(
        ciWorkflow.replace(
          "test_command: bun run --cwd apps/server test --shard=2/2",
          "test_command: bun run --cwd apps/server test --shard=1/2",
        ),
      ),
    ).toContain("unit matrix entry 2 has drifted");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "run: bun turbo build --filter=@synara/cli^...",
          "run: bun turbo build --filter=@synara/cli^... -- --shard=1/2",
        ),
      ),
    ).toContain("unit must run exactly one CLI dependency build without shard arguments");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "  unit_windows:\n    name: unit_windows\n    if: always()",
          "  unit_windows:\n    name: unit_windows\n    if: success()",
        ),
      ),
    ).toContain(
      "unit_windows must be a named, bounded, always-running, fail-closed aggregate",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          '      - shell: bash\n        run: test "${{ needs.browser_windows_workers.result }}" = success',
          '      - shell: bash\n        run: test "${{ needs.browser_windows_workers.result }}" != failure',
        ),
      ),
    ).toContain("browser_windows must run its exact fail-closed result gate");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "          - lane: quarantine\n            runner: windows-2022",
          "",
        ),
      ),
    ).toContain("browser_windows_workers matrix must contain the exact required platforms");

    expect(
      ciErrors(
        ciWorkflow.replace(
          '      - shell: bash\n        run: test "${{ needs.windows_e2e_build.result }}" = success',
          '      - shell: bash\n        run: test "${{ needs.windows_e2e_build.result }}" != failure',
        ),
      ),
    ).toContain(
      "e2e_windows must run exact producer result gate command",
    );

    expect(
      ciErrors(
        ciWorkflow.replace(
          "-${{ hashFiles('package.json') }}-${{ hashFiles('turbo.json') }}",
          "-${{ hashFiles('turbo.json') }}",
        ),
      ),
    ).toContain(
      "windows_x64 must use the pinned cache with exact Bun, Turbo, and npm paths and invalidation key",
    );

    expect(ciErrors(ciWorkflow.replace("      - windows_x64\n", ""))).toContain(
      "quality aggregate must depend on the exact merge-blocking quality job set",
    );
  });

  it("locks required-check names and fail-fast shell behavior", () => {
    expect(
      ciErrors(ciWorkflow.replace("    name: quality_windows", "    name: quality_windows_renamed")),
    ).toContain("quality_windows must retain its exact required display name");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "  quality:\n    name: quality",
          "  quality:\n    name: quality_renamed",
        ),
      ),
    ).toContain("quality aggregate must retain the exact quality display name");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "  windows_x64:\n    name: windows_x64",
          "  windows_x64:\n    name: windows_x64_renamed",
        ),
      ),
    ).toContain("windows_x64 must retain its exact required display name");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "  release_smoke:\n    name: release_smoke",
          "  release_smoke_missing:\n    name: release_smoke",
        ),
      ),
    ).toContain("must define the required release_smoke job with steps");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "  release_smoke:\n    name: release_smoke",
          "  release_smoke:\n    name: release_smoke_renamed",
        ),
      ),
    ).toContain("release_smoke must retain its exact required name");

    for (const weakening of ["    if: false\n", "    continue-on-error: true\n"]) {
      expect(
        ciErrors(
          ciWorkflow.replace(
            "  release_smoke:\n    name: release_smoke\n",
            `  release_smoke:\n    name: release_smoke\n${weakening}`,
          ),
        ),
      ).toContain("release_smoke must retain its exact required name");
    }

    for (const requiredCommand of [
      "node scripts/verify-workflow-contracts.ts --check-github-state",
      "node scripts/release-smoke.ts",
    ]) {
      expect(
        ciErrors(ciWorkflow.replace(requiredCommand, "echo pass")),
      ).toContain("release_smoke step");
    }

    expect(
      ciErrors(
        ciWorkflow.replace(
          '      - shell: bash\n        run: test "${{ needs.windows_e2e_build.result }}" = success',
          '      - run: test "${{ needs.windows_e2e_build.result }}" = success',
        ),
      ),
    ).toContain("e2e_windows producer result gate must use the fail-closed bash shell");

    expect(
      ciErrors(
        ciWorkflow.replace(
          "      - shell: bash\n        run: |\n          test \"${{ needs.quality_linux.result }}\" = skipped",
          "      - shell: bash {0}\n        run: |\n          test \"${{ needs.quality_linux.result }}\" = skipped",
        ),
      ),
    ).toContain("quality aggregate result gate must use the fail-closed bash shell");
  });

  it("locks the Windows desktop artifact to this workflow run and producer", () => {
    for (const redirectedInput of [
      "          run-id: 123",
      "          repository: attacker/fork",
      "          github-token: ${{ secrets.GITHUB_TOKEN }}",
    ]) {
      expect(
        ciErrors(
          ciWorkflow.replace(
            "          name: desktop-build-windows\n          path: .",
            `          name: desktop-build-windows\n          path: .\n${redirectedInput}`,
          ),
        ),
      ).toContain(
        "e2e_windows must download desktop-build-windows at the repository root and fail closed",
      );
    }

    const secondOwnerStep = [
      "      - uses: actions/upload-artifact@1111111111111111111111111111111111111111",
      "        with:",
      "          name: desktop-build-windows",
      "          path: duplicate",
    ].join("\n");
    expect(
      ciErrors(
        ciWorkflow.replace(
          "  windows_x64:\n    name: windows_x64\n    runs-on: windows-2022\n    steps:",
          `  windows_x64:\n    name: windows_x64\n    runs-on: windows-2022\n    steps:\n${secondOwnerStep}`,
        ),
      ),
    ).toContain("windows_e2e_build must be the sole desktop-build-windows artifact owner");

    const expectedDownload = [
      `      - uses: ${pinnedDownloadArtifact}`,
      "        with:",
      "          name: desktop-build-windows",
      "          path: .",
    ].join("\n");
    const untrustedDownload = [
      "      - uses: Actions/download-artifact@1111111111111111111111111111111111111111",
      "        with:",
      "          name: desktop-build-windows",
      "          path: .",
    ].join("\n");
    expect(
      ciErrors(
        ciWorkflow.replace(expectedDownload, `${expectedDownload}\n${untrustedDownload}`),
      ),
    ).toContain("e2e_windows must download exactly one pinned desktop-build-windows artifact");

    for (const rebuildCommand of ["npm run build", "pnpm run build", "yarn run build"]) {
      expect(
        ciErrors(
          ciWorkflow.replace(
            "      - run: bun run test:e2e\n      - if: failure()",
            `      - run: ${rebuildCommand}\n      - run: bun run test:e2e\n      - if: failure()`,
          ),
        ),
      ).toContain("e2e_windows must consume prebuilt artifacts without builds");
    }
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
          "    needs: windows_e2e_build\n    runs-on: windows-2022",
          "    needs: [windows_e2e_build, windows_x64]\n    runs-on: windows-2022",
        ),
      ),
    ).toContain("e2e_windows must need only its same-platform producer windows_e2e_build");

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
        "  quality:\n    name: quality\n    if: always()",
        "  quality:\n    name: quality\n    if: always()\n    permissions: write-all",
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
