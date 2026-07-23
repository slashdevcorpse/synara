import { parse as parseYaml } from "yaml";

type UnknownRecord = Record<string, unknown>;

export interface DisabledWorkflowPolicy {
  readonly path: string;
  readonly requiredState: "disabled_manually";
  readonly reason: string;
}

export interface AllowedWorkflowPolicy {
  readonly path: string;
  readonly requiredOnDefaultBranch: boolean;
  readonly triggers: readonly string[];
}

export interface WorkflowPolicy {
  readonly schemaVersion: 1;
  readonly repository: "slashdevcorpse/synara";
  readonly disabledWorkflows: readonly DisabledWorkflowPolicy[];
  readonly allowedWorkflows: readonly AllowedWorkflowPolicy[];
}

export interface RepositoryWorkflowState {
  readonly path: string;
  readonly state: string;
}

const FULL_ACTION_SHA = /^[0-9a-f]{40}$/;
const APPROVED_RUNNERS = new Set(["ubuntu-24.04", "windows-2022", "macos-15"]);
const EXPECTED_DISABLED_PATHS = new Set([
  ".github/workflows/issue-labels.yml",
  ".github/workflows/pr-size.yml",
  ".github/workflows/pr-vouch.yml",
  ".github/workflows/release.yml",
]);
const CACHE_ACTION = "actions/cache@caa296126883cff596d87d8935842f9db880ef25";
const UPLOAD_ARTIFACT_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const DESKTOP_E2E_BUILD_ARTIFACT_PATHS = [
  "apps/desktop/dist-electron/**",
  "apps/server/dist/**",
  "apps/web/dist/**",
  "packages/contracts/dist/**",
  "packages/effect-acp/dist/**",
] as const;
const DESKTOP_E2E_DIAGNOSTIC_PATHS = [
  "apps/desktop/failure-diagnostics/**/failure-summary.json",
] as const;
const UNSAFE_DESKTOP_E2E_DIAGNOSTIC_PATH_PATTERN =
  /(?:^|\/)(?:playwright-report|test-results)(?:\/|$)|(?:^|\/)(?:backend-logs|protocol\.jsonl|[^/]*\.sqlite(?:-(?:shm|wal))?)(?:\/|$)/u;
const DESKTOP_E2E_JOB_TIMEOUT_MINUTES = 30;
const DESKTOP_E2E_INSTALL_COMMAND = "bun install --frozen-lockfile";
const DESKTOP_E2E_CONFIG = {
  linux: {
    artifactName: "desktop-build-linux",
    diagnosticName: "desktop-e2e-linux-diagnostics",
    jobName: "e2e_linux",
    producerJobName: "quality_linux",
    runner: "ubuntu-24.04",
    systemDependenciesCommand: "bun run --cwd apps/web playwright install-deps chromium",
    testCommand: "xvfb-run -a bun run test:e2e",
  },
  windows: {
    artifactName: "desktop-build-windows",
    diagnosticName: "desktop-e2e-windows-diagnostics",
    jobName: "e2e_windows",
    producerJobName: "windows_x64",
    runner: "windows-2022",
    systemDependenciesCommand: null,
    testCommand: "bun run test:e2e",
  },
} as const;
const PLAYWRIGHT_BROWSER_CACHE_PATHS = {
  quality_linux: "~/.cache/ms-playwright",
  browser_windows: "~\\AppData\\Local\\ms-playwright",
} as const;
type PlaywrightCacheJobName = keyof typeof PLAYWRIGHT_BROWSER_CACHE_PATHS;
const QUARANTINE_BASELINE_REF =
  '"${{ github.event.pull_request.base.sha || github.event.before }}"';
const QUARANTINE_VALIDATE_COMMAND = "node scripts/quarantine-registry.ts validate";
const BROWSER_INSTALL_COMMANDS = {
  quality_linux: "bun run --cwd apps/web test:browser:install",
  browser_windows: "bun run --cwd apps/web playwright install chromium",
} as const;
const BROWSER_STABLE_COMMAND = "bun run --cwd apps/web test:browser:stable";
const MATRIX_RUNNER_EXPRESSION = "${{ matrix.runner }}";
const QUARANTINE_RUN_COMMANDS = {
  linux: "node scripts/quarantine-registry.ts run --platform linux",
  windows: "node scripts/quarantine-registry.ts run --platform windows",
} as const;
const QUARANTINE_INVENTORY_COMMANDS = {
  linux: "node scripts/quarantine-registry.ts inventory --platform linux",
  windows: "node scripts/quarantine-registry.ts inventory --platform windows",
} as const;
const ALLOWED_NONBLOCKING_CI_COMMANDS: ReadonlySet<string> = new Set(
  Object.values(QUARANTINE_RUN_COMMANDS),
);
const FULL_UNIT_COMMAND = "bun turbo test";
const UNIT_WINDOWS_SETUP_COMMAND =
  "node apps/server/scripts/build-windows-job-launcher.mjs --arch x64";
const UNIT_WINDOWS_SETUP_CONDITION = "matrix.platform == 'windows'";
const UNIT_TURBO_CONCURRENCY_EXPRESSION = "${{ matrix.turbo_concurrency }}";
const CI_WINDOWS_REQUIRED_COMMANDS = [
  "bun run brand:check",
  UNIT_WINDOWS_SETUP_COMMAND,
  "node apps/server/scripts/build-windows-job-launcher.mjs --arch arm64",
  "bun run --cwd apps/server test src/provider/windowsProviderProcess.test.ts src/provider/windowsProviderProcess.windows.test.ts",
  "bun run --cwd packages/shared test src/desktopIdentity.test.ts src/desktopIdentityProof.test.ts src/windowsCertificate.test.ts",
  "bun run --cwd apps/desktop test src/backendShutdown.test.ts src/backendShutdown.windows.integration.test.ts",
  "bun run --cwd packages/shared test src/windowsProcess.test.ts",
  "bun run --cwd apps/server test src/windowsProcessEffect.test.ts src/codexAppServerManager.test.ts src/provider/Layers/ProviderHealth.test.ts src/provider/acp/AcpJsonRpcConnection.test.ts src/persistence/MigrationBackup.test.ts src/restoreMigrationBackup.test.ts",
  "bun run --cwd apps/desktop test src/desktopMigrationRecovery.test.ts src/desktopStorageMigration.test.ts src/windowState.test.ts src/updateState.test.ts",
  "bun run --cwd scripts test check-brand-identity.test.ts verify-packaged-desktop-startup.test.ts lib/desktop-artifact-policy.test.ts lib/windows-authenticode.test.ts lib/windows-installer-qualification.test.ts lib/release-artifact-provenance.test.ts lib/super-synara-release-admission.test.ts lib/super-synara-workflow-contract.test.ts",
  "node scripts/verify-workflow-contracts.ts",
] as const;
const CI_WINDOWS_POST_BUILD_COMMAND = "bun run --cwd apps/desktop smoke-test";
const CI_WINDOWS_PACKAGED_CLI_COMMAND = "node apps/server/scripts/cli.ts publish --dry-run";
const CI_ROOT_TEST_COMMAND = "bun run test:ci";
const CI_ROOT_TEST_CONDITION = "matrix.platform == 'linux'";
const FULL_UNIT_CONDITION = "matrix.platform != 'linux'";
const CI_CODECOV_ACTION = "codecov/codecov-action@0fb7174895f61a3b6b78fc075e0cd60383518dac";
const CI_CODECOV_UPLOAD_CONDITION =
  "${{ matrix.platform == 'linux' && !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') }}";
const CI_CODECOV_TOKEN = "${{ secrets.CODECOV_TOKEN }}";
const CI_CODECOV_COVERAGE_FILES =
  "./apps/desktop/coverage/lcov.info,./apps/server/coverage/lcov.info,./apps/web/coverage/lcov.info,./packages/contracts/coverage/lcov.info,./packages/shared/coverage/lcov.info,./scripts/coverage/lcov.info";
const CI_CODECOV_TEST_RESULT_FILES =
  "./apps/desktop/test-report.junit.xml,./apps/server/test-report.junit.xml,./apps/web/test-report.junit.xml,./packages/contracts/test-report.junit.xml,./packages/shared/test-report.junit.xml,./scripts/test-report.junit.xml";
const CI_MERGIFY_ACTION = "Mergifyio/gha-mergify-ci@8173bc3c1d337d3367454672d50cfdf6f0273396";
const CI_MERGIFY_UPLOAD_CONDITION =
  "${{ matrix.platform == 'linux' && !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') && (github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository) }}";
const CI_MERGIFY_REPORT_FILES =
  "./apps/desktop/test-report.junit.xml ./apps/server/test-report.junit.xml ./apps/web/test-report.junit.xml ./packages/contracts/test-report.junit.xml ./packages/shared/test-report.junit.xml ./scripts/test-report.junit.xml";
const CI_MERGIFY_VERIFY_COMMAND = 'test "$MERGIFY_UPLOAD_OUTCOME" = "success"';
const DEPENDENCY_REVIEW_ACTION =
  "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294";
const CODEQL_ACTION = "github/codeql-action";
const CODEQL_ACTION_SHA = "e0647621c2984b5ed2f768cb892365bf2a616ad1";
const CODEQL_SWIFT_TIMEOUT_MINUTES = 60;
const MACOS_BACKLOG_CONDITION = false;
const CI_MACOS_REQUIRED_COMMANDS = [
  'test "$(uname -m)" = arm64',
  "bun run brand:check",
  "node scripts/node-pty-smoke.mjs",
  "bun run --cwd apps/desktop test",
] as const;
const CI_DESKTOP_BUILD_COMMAND = "bun run build:desktop";
const CI_DESKTOP_STARTUP_SMOKE_COMMANDS = {
  windows_x64: CI_WINDOWS_POST_BUILD_COMMAND,
  macos_arm64: "bun run test:desktop-smoke",
} as const;
const CI_DESKTOP_PERSISTENCE_SMOKE_COMMAND = "bun run test:desktop-persistence-smoke";
const CI_DESKTOP_PERSISTENCE_SMOKE_STEP_NAME = "Verify two-launch desktop persistence";
const CI_DESKTOP_PERSISTENCE_SMOKE_TIMEOUT_MINUTES = 5;
const CI_DESKTOP_PERSISTENCE_SMOKE_HOMES = {
  windows_x64: "${{ runner.temp }}\\super-synara-persistence-windows-home",
  macos_arm64: "${{ runner.temp }}/super-synara-persistence-macos-home",
} as const;
type CiNativeJobName = keyof typeof CI_DESKTOP_PERSISTENCE_SMOKE_HOMES;
const UNIT_MATRIX = [
  { platform: "linux", runner: "ubuntu-24.04", turbo_concurrency: "50%" },
  { platform: "windows", runner: "windows-2022", turbo_concurrency: "1" },
] as const;
const UNIT_JOB_TIMEOUT_MINUTES = 40;
const UNIT_STEP_TIMEOUT_MINUTES = 30;
const QUALITY_WINDOWS_JOB_TIMEOUT_MINUTES = 45;
const QUALITY_WINDOWS_STEP_SEQUENCE = [
  { kind: "uses", value: "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10" },
  { kind: "uses", value: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6" },
  { kind: "uses", value: "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38" },
  { kind: "uses", value: "actions/cache@caa296126883cff596d87d8935842f9db880ef25" },
  { kind: "run", value: "bun install --frozen-lockfile" },
  { kind: "run", value: "bun run fmt:check" },
  { kind: "run", value: "bun run lint" },
  { kind: "run", value: "bun run typecheck" },
] as const;
const QUALITY_AGGREGATE_NEEDS = [
  "quality_linux",
  "quality_windows",
  "unit",
  "browser_windows",
  "e2e_linux",
  "e2e_windows",
  "macos_arm64",
] as const;
const QUALITY_AGGREGATE_COMMAND = `
test "\${{ needs.quality_linux.result }}" = success
test "\${{ needs.quality_windows.result }}" = success
test "\${{ needs.unit.result }}" = success
test "\${{ needs.browser_windows.result }}" = success
test "\${{ needs.e2e_linux.result }}" = success
test "\${{ needs.e2e_windows.result }}" = success
test "\${{ needs.macos_arm64.result }}" = skipped
`;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

function multilineStringEntries(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  return value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeShellCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

interface WorkflowRunStep {
  readonly command: string;
  readonly continueOnError: unknown;
  readonly condition: unknown;
  readonly environment: unknown;
  readonly id: unknown;
  readonly index: number;
  readonly name: unknown;
  readonly rawCommand: string;
  readonly timeoutMinutes: unknown;
}

function executableShellLines(command: string): readonly string[] {
  return command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function invokesWorkspaceBuild(line: string): boolean {
  const tokenBoundary = String.raw`(?=$|[\s"'&|;()<>])`;
  const tokenPrefix = String.raw`(?:^|[\s"'&|;()<>])`;
  const invokesBun = new RegExp(`${tokenPrefix}bun(?:\\.exe)?${tokenBoundary}`, "iu").test(line);
  const namesBuildScript = new RegExp(
    `${tokenPrefix}build(?::desktop)?${tokenBoundary}`,
    "iu",
  ).test(line);
  const invokesTurboBuild = new RegExp(
    `${tokenPrefix}turbo\\s+(?:run\\s+)?build${tokenBoundary}`,
    "iu",
  ).test(line);
  return (invokesBun && namesBuildScript) || invokesTurboBuild;
}

function invokesRootTest(command: string): boolean {
  return executableShellLines(command).some((line) =>
    /(?:^|(?:&&|\|\||;)\s*)bun (?:turbo (?:run )?test|run test(?::ci)?)(?=$|\s|&&|\|\||;)/.test(
      line,
    ),
  );
}

function invokesDesktopSmokeTurboWrapper(command: string): boolean {
  return executableShellLines(command).some((line) =>
    /(?:^|[\s"'&|;()<>])test:desktop-smoke(?=$|[\s"'&|;()<>])/.test(line),
  );
}

function jobRunSteps(
  jobs: UnknownRecord,
  jobName: string,
  workflowPath: string,
  errors: string[],
): readonly WorkflowRunStep[] | null {
  const job = jobs[jobName];
  if (!isRecord(job) || !Array.isArray(job.steps)) {
    errors.push(`${workflowPath} must define the ${jobName} job with steps.`);
    return null;
  }
  return job.steps
    .map((step, index): WorkflowRunStep | null => {
      if (!isRecord(step) || typeof step.run !== "string") return null;
      return {
        command: normalizeShellCommand(step.run),
        continueOnError: step["continue-on-error"],
        condition: step.if,
        environment: step.env,
        id: step.id,
        index,
        name: step.name,
        rawCommand: step.run,
        timeoutMinutes: step["timeout-minutes"],
      };
    })
    .filter((step): step is WorkflowRunStep => step !== null);
}

function exactBlockingCommand(
  workflowPath: string,
  jobName: string,
  steps: readonly WorkflowRunStep[],
  command: string,
  errors: string[],
): WorkflowRunStep | null {
  const matches = steps.filter((step) => step.command === command);
  if (matches.length !== 1) {
    errors.push(`${workflowPath} ${jobName} must run exact browser gate command: ${command}.`);
    return null;
  }
  const step = matches[0]!;
  if (
    step.condition !== undefined ||
    (step.continueOnError !== undefined && step.continueOnError !== false)
  ) {
    errors.push(
      `${workflowPath} ${jobName} browser gate must be unconditional and fail closed: ${command}.`,
    );
  }
  return step;
}

function validateNativeJobCommands(
  workflowPath: string,
  jobName: string,
  steps: readonly WorkflowRunStep[],
  requiredCommands: readonly string[],
  errors: string[],
  postBuildCommand?: string,
): void {
  const buildSteps = steps.filter((step) => step.command === CI_DESKTOP_BUILD_COMMAND);
  if (buildSteps.length !== 1) {
    errors.push(`${workflowPath} ${jobName} must retain the native desktop build step.`);
  }
  const [buildStep] = buildSteps;
  if (
    buildStep &&
    (buildStep.condition !== undefined ||
      (buildStep.continueOnError !== undefined && buildStep.continueOnError !== false))
  ) {
    errors.push(
      `${workflowPath} ${jobName} native desktop build must be unconditional and fail closed.`,
    );
  }
  for (const command of requiredCommands) {
    const matches = steps.filter((step) => step.command === command);
    if (matches.length !== 1) {
      errors.push(`${workflowPath} ${jobName} must run exact native gate command: ${command}.`);
      continue;
    }
    const [step] = matches;
    if (
      step!.condition !== undefined ||
      (step!.continueOnError !== undefined && step!.continueOnError !== false)
    ) {
      errors.push(
        `${workflowPath} ${jobName} native gate must be unconditional and fail closed: ${command}.`,
      );
    }
    if (buildStep && step!.index >= buildStep.index) {
      errors.push(
        `${workflowPath} ${jobName} native gate must run before the desktop build: ${command}.`,
      );
    }
  }
  if (postBuildCommand) {
    const matches = steps.filter((step) => step.command === postBuildCommand);
    if (matches.length !== 1) {
      errors.push(
        `${workflowPath} ${jobName} must run exact post-build smoke command: ${postBuildCommand}.`,
      );
    } else {
      const [step] = matches;
      if (
        step!.condition !== undefined ||
        (step!.continueOnError !== undefined && step!.continueOnError !== false)
      ) {
        errors.push(
          `${workflowPath} ${jobName} post-build smoke must be unconditional and fail closed: ${postBuildCommand}.`,
        );
      }
      if (buildStep && step!.index <= buildStep.index) {
        errors.push(
          `${workflowPath} ${jobName} post-build smoke must run after the desktop build: ${postBuildCommand}.`,
        );
      }
    }
    if (steps.some((step) => invokesDesktopSmokeTurboWrapper(step.rawCommand))) {
      errors.push(
        `${workflowPath} ${jobName} must invoke the built desktop smoke directly without the Turbo rebuild wrapper.`,
      );
    }
  }
  if (steps.some((step) => invokesRootTest(step.rawCommand))) {
    errors.push(`${workflowPath} ${jobName} must not run the monorepo-wide bun run test suite.`);
  }
}

function validatePostBuildGate(
  workflowPath: string,
  jobName: string,
  steps: readonly WorkflowRunStep[],
  command: string,
  errors: string[],
): void {
  const matches = steps.filter((step) => step.command === command);
  if (matches.length !== 1) {
    errors.push(`${workflowPath} ${jobName} must run exact post-build gate command: ${command}.`);
    return;
  }

  const [step] = matches;
  if (
    step!.condition !== undefined ||
    (step!.continueOnError !== undefined && step!.continueOnError !== false)
  ) {
    errors.push(
      `${workflowPath} ${jobName} post-build gate must be unconditional and fail closed: ${command}.`,
    );
  }

  const buildStep = steps.find((candidate) => candidate.command === CI_DESKTOP_BUILD_COMMAND);
  if (buildStep && step!.index <= buildStep.index) {
    errors.push(
      `${workflowPath} ${jobName} post-build gate must run after the desktop build: ${command}.`,
    );
  }
}

function workflowStepEnvironmentValue(step: WorkflowRunStep, key: string): unknown {
  return isRecord(step.environment) ? step.environment[key] : undefined;
}

function validateNativePersistenceSmoke(
  workflowPath: string,
  jobName: CiNativeJobName,
  steps: readonly WorkflowRunStep[],
  errors: string[],
): void {
  const smokeSteps = steps.filter((step) => step.command === CI_DESKTOP_PERSISTENCE_SMOKE_COMMAND);
  if (smokeSteps.length !== 1) {
    errors.push(
      `${workflowPath} ${jobName} must run exactly one post-build desktop persistence smoke command: ${CI_DESKTOP_PERSISTENCE_SMOKE_COMMAND}.`,
    );
    return;
  }

  const smokeStep = smokeSteps[0]!;
  const buildStep = steps.find((step) => step.command === CI_DESKTOP_BUILD_COMMAND);
  if (buildStep && smokeStep.index <= buildStep.index) {
    errors.push(`${workflowPath} ${jobName} desktop persistence smoke must run after the build.`);
  }
  if (buildStep && workflowStepEnvironmentValue(buildStep, "SYNARA_DESKTOP_FLAVOR") !== "super") {
    errors.push(
      `${workflowPath} ${jobName} desktop build must set SYNARA_DESKTOP_FLAVOR to super.`,
    );
  }
  if (
    smokeStep.condition !== undefined ||
    (smokeStep.continueOnError !== undefined && smokeStep.continueOnError !== false)
  ) {
    errors.push(
      `${workflowPath} ${jobName} desktop persistence smoke must be unconditional and fail closed.`,
    );
  }
  if (smokeStep.name !== CI_DESKTOP_PERSISTENCE_SMOKE_STEP_NAME) {
    errors.push(
      `${workflowPath} ${jobName} desktop persistence smoke step must be named ${CI_DESKTOP_PERSISTENCE_SMOKE_STEP_NAME}.`,
    );
  }
  if (smokeStep.timeoutMinutes !== CI_DESKTOP_PERSISTENCE_SMOKE_TIMEOUT_MINUTES) {
    errors.push(
      `${workflowPath} ${jobName} desktop persistence smoke timeout-minutes must equal ${CI_DESKTOP_PERSISTENCE_SMOKE_TIMEOUT_MINUTES}.`,
    );
  }
  if (workflowStepEnvironmentValue(smokeStep, "SYNARA_DESKTOP_FLAVOR") !== "super") {
    errors.push(
      `${workflowPath} ${jobName} desktop persistence smoke must set SYNARA_DESKTOP_FLAVOR to super.`,
    );
  }
  if (workflowStepEnvironmentValue(smokeStep, "SYNARA_DESKTOP_DISABLE_UPDATES") !== "1") {
    errors.push(
      `${workflowPath} ${jobName} desktop persistence smoke must set SYNARA_DESKTOP_DISABLE_UPDATES to "1".`,
    );
  }

  const smokeHome = workflowStepEnvironmentValue(smokeStep, "SYNARA_HOME");
  const expectedHome = CI_DESKTOP_PERSISTENCE_SMOKE_HOMES[jobName];
  if (smokeHome !== expectedHome) {
    errors.push(
      `${workflowPath} ${jobName} desktop persistence smoke must use isolated SYNARA_HOME ${expectedHome}.`,
    );
  }
  const sharesStartupHome = steps
    .filter((step) => step.command === CI_DESKTOP_STARTUP_SMOKE_COMMANDS[jobName])
    .some((step) => workflowStepEnvironmentValue(step, "SYNARA_HOME") === smokeHome);
  if (typeof smokeHome === "string" && sharesStartupHome) {
    errors.push(
      `${workflowPath} ${jobName} desktop persistence smoke must not share SYNARA_HOME with startup smoke.`,
    );
  }
}

function validateExactMatrix(
  workflowPath: string,
  jobName: string,
  job: UnknownRecord,
  expected: readonly Readonly<Record<string, string>>[],
  errors: string[],
): void {
  if (job["runs-on"] !== MATRIX_RUNNER_EXPRESSION) {
    errors.push(`${workflowPath} ${jobName} must run on the static matrix runner expression.`);
  }
  const strategy = job.strategy;
  if (!isRecord(strategy) || strategy["fail-fast"] !== false || !isRecord(strategy.matrix)) {
    errors.push(`${workflowPath} ${jobName} must use a fail-fast: false static include matrix.`);
    return;
  }
  if (Object.keys(strategy.matrix).some((key) => key !== "include")) {
    errors.push(`${workflowPath} ${jobName} matrix must not add filters or dynamic axes.`);
  }
  const include = strategy.matrix.include;
  if (!Array.isArray(include) || include.length !== expected.length) {
    errors.push(`${workflowPath} ${jobName} matrix must contain the exact required platforms.`);
    return;
  }
  for (const [index, expectedEntry] of expected.entries()) {
    const actualEntry = include[index];
    if (
      !isRecord(actualEntry) ||
      Object.keys(actualEntry).sort().join(",") !== Object.keys(expectedEntry).sort().join(",") ||
      Object.entries(expectedEntry).some(([key, value]) => actualEntry[key] !== value)
    ) {
      errors.push(`${workflowPath} ${jobName} matrix entry ${index + 1} has drifted.`);
    }
  }
}

function validateUnitTestConcurrency(
  workflowPath: string,
  step: WorkflowRunStep,
  errors: string[],
): void {
  if (
    workflowStepEnvironmentValue(step, "TURBO_CONCURRENCY") !== UNIT_TURBO_CONCURRENCY_EXPRESSION
  ) {
    errors.push(
      `${workflowPath} unit ${step.command} must set TURBO_CONCURRENCY to ${UNIT_TURBO_CONCURRENCY_EXPRESSION}.`,
    );
  }
}

function validateUnitMatrix(jobs: UnknownRecord, workflowPath: string, errors: string[]): void {
  const unitJob = jobs.unit;
  if (!isRecord(unitJob)) {
    errors.push(`${workflowPath} must define the unit matrix job.`);
    return;
  }
  validateExactMatrix(workflowPath, "unit", unitJob, UNIT_MATRIX, errors);
  if (
    unitJob.if !== undefined ||
    (unitJob["continue-on-error"] !== undefined && unitJob["continue-on-error"] !== false)
  ) {
    errors.push(`${workflowPath} unit matrix job must be unconditional and fail closed.`);
  }
  if (unitJob["timeout-minutes"] !== UNIT_JOB_TIMEOUT_MINUTES) {
    errors.push(`${workflowPath} unit job timeout must be ${UNIT_JOB_TIMEOUT_MINUTES} minutes.`);
  }

  const unitSteps = jobRunSteps(jobs, "unit", workflowPath, errors) ?? [];
  const linuxTestSteps = unitSteps.filter((step) => step.command === CI_ROOT_TEST_COMMAND);
  if (linuxTestSteps.length !== 1) {
    errors.push(
      `${workflowPath} unit must run exactly one Linux-only ${CI_ROOT_TEST_COMMAND} command.`,
    );
  } else {
    const linuxTestStep = linuxTestSteps[0]!;
    if (
      linuxTestStep.condition !== CI_ROOT_TEST_CONDITION ||
      (linuxTestStep.continueOnError !== undefined && linuxTestStep.continueOnError !== false)
    ) {
      errors.push(
        `${workflowPath} unit ${CI_ROOT_TEST_COMMAND} command must run only for matrix.platform == 'linux' and fail closed.`,
      );
    }
    if (linuxTestStep.timeoutMinutes !== UNIT_STEP_TIMEOUT_MINUTES) {
      errors.push(
        `${workflowPath} unit ${CI_ROOT_TEST_COMMAND} timeout must be ${UNIT_STEP_TIMEOUT_MINUTES} minutes.`,
      );
    }
    if (linuxTestStep.id !== "unit_tests") {
      errors.push(
        `${workflowPath} unit ${CI_ROOT_TEST_COMMAND} must use id unit_tests for report upload conditions.`,
      );
    }
    validateUnitTestConcurrency(workflowPath, linuxTestStep, errors);
  }

  const nonLinuxTestSteps = unitSteps.filter((step) => step.command === FULL_UNIT_COMMAND);
  if (nonLinuxTestSteps.length !== 1) {
    errors.push(
      `${workflowPath} unit must run exactly one non-Linux ${FULL_UNIT_COMMAND} command.`,
    );
  } else {
    const nonLinuxTestStep = nonLinuxTestSteps[0]!;
    if (
      nonLinuxTestStep.condition !== FULL_UNIT_CONDITION ||
      (nonLinuxTestStep.continueOnError !== undefined && nonLinuxTestStep.continueOnError !== false)
    ) {
      errors.push(
        `${workflowPath} unit ${FULL_UNIT_COMMAND} command must run only when matrix.platform != 'linux' and fail closed.`,
      );
    }
    if (nonLinuxTestStep.timeoutMinutes !== UNIT_STEP_TIMEOUT_MINUTES) {
      errors.push(
        `${workflowPath} unit ${FULL_UNIT_COMMAND} timeout must be ${UNIT_STEP_TIMEOUT_MINUTES} minutes.`,
      );
    }
    validateUnitTestConcurrency(workflowPath, nonLinuxTestStep, errors);
  }

  const windowsSetupSteps = unitSteps.filter((step) => step.command === UNIT_WINDOWS_SETUP_COMMAND);
  if (windowsSetupSteps.length !== 1) {
    errors.push(
      `${workflowPath} unit must run exactly one Windows launcher setup command: ${UNIT_WINDOWS_SETUP_COMMAND}.`,
    );
  } else {
    const setupStep = windowsSetupSteps[0]!;
    if (
      setupStep.condition !== UNIT_WINDOWS_SETUP_CONDITION ||
      (setupStep.continueOnError !== undefined && setupStep.continueOnError !== false)
    ) {
      errors.push(
        `${workflowPath} unit Windows launcher setup must run only for matrix.platform == 'windows' and fail closed.`,
      );
    }
    if (nonLinuxTestSteps.length === 1 && setupStep.index >= nonLinuxTestSteps[0]!.index) {
      errors.push(
        `${workflowPath} unit Windows launcher setup must run before ${FULL_UNIT_COMMAND}.`,
      );
    }
  }

  const occurrences: Array<{
    readonly jobName: string;
    readonly step: WorkflowRunStep;
  }> = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const [index, step] of job.steps.entries()) {
      if (!isRecord(step) || typeof step.run !== "string") continue;
      if (!invokesRootTest(step.run)) continue;
      occurrences.push({
        jobName,
        step: {
          command: normalizeShellCommand(step.run),
          continueOnError: step["continue-on-error"],
          condition: step.if,
          environment: step.env,
          id: step.id,
          index,
          name: step.name,
          rawCommand: step.run,
          timeoutMinutes: step["timeout-minutes"],
        },
      });
    }
  }
  for (const occurrence of occurrences) {
    const isOwnedSplit =
      occurrence.jobName === "unit" &&
      (occurrence.step.command === CI_ROOT_TEST_COMMAND ||
        occurrence.step.command === FULL_UNIT_COMMAND);
    if (!isOwnedSplit) {
      errors.push(
        `${workflowPath} ${occurrence.jobName} must not own an additional, filtered, or chained monorepo-wide unit suite.`,
      );
    }
  }
}

function booleanActionInput(value: unknown): boolean {
  return value === true || value === "true";
}

function validateCodecovUploads(
  unitJob: UnknownRecord,
  workflowPath: string,
  errors: string[],
): void {
  if (!Array.isArray(unitJob.steps)) {
    errors.push(`${workflowPath} unit must define steps.`);
    return;
  }

  const expectedUploads = [
    {
      files: CI_CODECOV_COVERAGE_FILES,
      name: "Upload coverage reports to Codecov",
      reportType: undefined,
    },
    {
      files: CI_CODECOV_TEST_RESULT_FILES,
      name: "Upload test results to Codecov",
      reportType: "test_results",
    },
  ] as const;
  const unitTestStepIndex = unitJob.steps.findIndex(
    (step) =>
      isRecord(step) &&
      typeof step.run === "string" &&
      normalizeShellCommand(step.run) === CI_ROOT_TEST_COMMAND,
  );

  for (const expected of expectedUploads) {
    const matches = unitJob.steps.filter((step) => isRecord(step) && step.name === expected.name);
    if (matches.length !== 1) {
      errors.push(`${workflowPath} unit must define exactly one ${expected.name} step.`);
      continue;
    }

    const step = matches[0]!;
    if (!isRecord(step)) continue;
    const uploadIndex = unitJob.steps.indexOf(step);
    if (unitTestStepIndex < 0 || uploadIndex <= unitTestStepIndex) {
      errors.push(`${workflowPath} ${expected.name} must run after ${CI_ROOT_TEST_COMMAND}.`);
    }
    if (step.uses !== CI_CODECOV_ACTION) {
      errors.push(`${workflowPath} ${expected.name} must use the pinned Codecov Action v5.5.5.`);
    }
    if (step.if !== CI_CODECOV_UPLOAD_CONDITION) {
      errors.push(
        `${workflowPath} ${expected.name} must run for completed successful or failed unit tests.`,
      );
    }
    if (!isRecord(step.with)) {
      errors.push(`${workflowPath} ${expected.name} must define Codecov inputs.`);
      continue;
    }
    if (step.with.token !== CI_CODECOV_TOKEN) {
      errors.push(`${workflowPath} ${expected.name} must use secrets.CODECOV_TOKEN.`);
    }
    if (step.with.files !== expected.files || !booleanActionInput(step.with.disable_search)) {
      errors.push(`${workflowPath} ${expected.name} must upload only the expected report files.`);
    }
    if (!booleanActionInput(step.with.fail_ci_if_error)) {
      errors.push(`${workflowPath} ${expected.name} must fail closed on Codecov upload errors.`);
    }
    if (step.with.report_type !== expected.reportType) {
      errors.push(
        `${workflowPath} ${expected.name} must set report_type to ${expected.reportType ?? "coverage (default)"}.`,
      );
    }
  }
}

function validateMergifyUpload(
  unitJob: UnknownRecord,
  workflowPath: string,
  errors: string[],
): void {
  if (!Array.isArray(unitJob.steps)) return;
  const matches = unitJob.steps.filter(
    (step) => isRecord(step) && step.name === "Upload test results to Mergify CI Insights",
  );
  if (matches.length !== 1) {
    errors.push(
      `${workflowPath} unit must define exactly one Upload test results to Mergify CI Insights step.`,
    );
    return;
  }
  const step = matches[0]!;
  if (!isRecord(step)) return;
  const unitTestIndex = unitJob.steps.findIndex(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.run === "string" &&
      normalizeShellCommand(candidate.run) === CI_ROOT_TEST_COMMAND,
  );
  if (unitTestIndex < 0 || unitJob.steps.indexOf(step) <= unitTestIndex) {
    errors.push(`${workflowPath} Mergify upload must run after ${CI_ROOT_TEST_COMMAND}.`);
  }
  if (step.id !== "mergify_ci" || step.uses !== CI_MERGIFY_ACTION) {
    errors.push(`${workflowPath} Mergify upload must use the pinned Mergify CI v23 action.`);
  }
  if (step.if !== CI_MERGIFY_UPLOAD_CONDITION) {
    errors.push(`${workflowPath} Mergify upload must be completed-test and fork safe.`);
  }
  if (!isRecord(step.with)) {
    errors.push(`${workflowPath} Mergify upload must define inputs.`);
    return;
  }
  if (
    step.with.action !== "junit-process" ||
    step.with.token !== "${{ secrets.MERGIFY_TOKEN }}" ||
    step.with.job_name !== "quality" ||
    step.with.report_path !== CI_MERGIFY_REPORT_FILES ||
    step.with.test_step_outcome !== "${{ steps.unit_tests.outcome }}"
  ) {
    errors.push(
      `${workflowPath} Mergify upload must ingest only the six expected JUnit reports with the unit-test outcome.`,
    );
  }

  const verificationMatches = unitJob.steps.filter(
    (candidate) => isRecord(candidate) && candidate.name === "Verify Mergify test results upload",
  );
  if (verificationMatches.length !== 1) {
    errors.push(
      `${workflowPath} unit must define exactly one Verify Mergify test results upload step.`,
    );
    return;
  }
  const verification = verificationMatches[0]!;
  if (!isRecord(verification)) return;
  if (unitJob.steps.indexOf(verification) !== unitJob.steps.indexOf(step) + 1) {
    errors.push(`${workflowPath} Mergify upload verification must run immediately after upload.`);
  }
  if (
    verification.if !== CI_MERGIFY_UPLOAD_CONDITION ||
    !isRecord(verification.env) ||
    verification.env.MERGIFY_UPLOAD_OUTCOME !==
      "${{ steps.mergify_ci.outputs.test_results_upload }}" ||
    typeof verification.run !== "string" ||
    normalizeShellCommand(verification.run) !== CI_MERGIFY_VERIFY_COMMAND
  ) {
    errors.push(
      `${workflowPath} Mergify upload verification must fail closed unless upload succeeds.`,
    );
  }
}

function workflowJob(workflow: UnknownRecord, jobName: string): UnknownRecord | null {
  return isRecord(workflow.jobs) && isRecord(workflow.jobs[jobName])
    ? workflow.jobs[jobName]
    : null;
}

function actionSteps(job: UnknownRecord, action: string): readonly UnknownRecord[] {
  if (!Array.isArray(job.steps)) return [];
  return job.steps.filter(
    (step): step is UnknownRecord =>
      isRecord(step) && typeof step.uses === "string" && step.uses === action,
  );
}

function actionStepsWithPrefix(job: UnknownRecord, actionPrefix: string): readonly UnknownRecord[] {
  if (!Array.isArray(job.steps)) return [];
  const normalizedPrefix = actionPrefix.toLowerCase();
  return job.steps.filter(
    (step): step is UnknownRecord =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.toLowerCase().startsWith(normalizedPrefix),
  );
}

function validateDependencyReviewWorkflow(workflow: UnknownRecord, errors: string[]): void {
  const path = ".github/workflows/dependency-review.yml";
  const job = workflowJob(workflow, "dependency-review");
  if (!job || job.name !== "dependency-review" || job["runs-on"] !== "ubuntu-24.04") {
    errors.push(`${path} must define the fixed dependency-review Ubuntu job.`);
    return;
  }
  const steps = actionSteps(job, DEPENDENCY_REVIEW_ACTION);
  if (steps.length !== 1) {
    errors.push(`${path} must run exactly one pinned Dependency Review v5 action.`);
  } else if (
    steps[0]!.if !== undefined ||
    (steps[0]!["continue-on-error"] !== undefined && steps[0]!["continue-on-error"] !== false)
  ) {
    errors.push(`${path} dependency review must be unconditional and fail closed.`);
  }
}

function validateCodeqlWorkflow(workflow: UnknownRecord, errors: string[]): void {
  const path = ".github/workflows/codeql.yml";
  const expected = [
    {
      jobName: "analyze_actions",
      displayName: "codeql-actions",
      runner: "ubuntu-24.04",
      language: "actions",
      buildMode: "none",
      category: "/language:actions",
      condition: undefined,
    },
    {
      jobName: "analyze_javascript_typescript",
      displayName: "codeql-javascript-typescript",
      runner: "ubuntu-24.04",
      language: "javascript-typescript",
      buildMode: "none",
      category: "/language:javascript-typescript",
      condition: undefined,
    },
    {
      jobName: "analyze_swift",
      displayName: "codeql-swift",
      runner: "macos-15",
      language: "swift",
      buildMode: "manual",
      category: "/language:swift",
      condition: MACOS_BACKLOG_CONDITION,
    },
  ] as const;
  for (const lane of expected) {
    const job = workflowJob(workflow, lane.jobName);
    if (!job || job.name !== lane.displayName || job["runs-on"] !== lane.runner) {
      errors.push(`${path} must define fixed ${lane.displayName} on ${lane.runner}.`);
      continue;
    }
    if (job.if !== lane.condition) {
      errors.push(
        lane.condition === undefined
          ? `${path} ${lane.displayName} must remain unconditional.`
          : `${path} ${lane.displayName} must remain disabled while macOS CI is backlogged.`,
      );
    }
    if (
      !isRecord(job.permissions) ||
      job.permissions.contents !== "read" ||
      job.permissions["security-events"] !== "write"
    ) {
      errors.push(`${path} ${lane.displayName} must grant only required CodeQL permissions.`);
    }
    const init = actionSteps(job, `${CODEQL_ACTION}/init@${CODEQL_ACTION_SHA}`);
    const analyze = actionSteps(job, `${CODEQL_ACTION}/analyze@${CODEQL_ACTION_SHA}`);
    if (
      init.length !== 1 ||
      !isRecord(init[0]!.with) ||
      init[0]!.with.languages !== lane.language ||
      init[0]!.with["build-mode"] !== lane.buildMode
    ) {
      errors.push(
        `${path} ${lane.displayName} must initialize the expected language and build mode.`,
      );
    }
    if (
      analyze.length !== 1 ||
      !isRecord(analyze[0]!.with) ||
      analyze[0]!.with.category !== lane.category
    ) {
      errors.push(`${path} ${lane.displayName} must publish the fixed analysis category.`);
    }
  }
  const swift = workflowJob(workflow, "analyze_swift");
  if (swift?.["timeout-minutes"] !== CODEQL_SWIFT_TIMEOUT_MINUTES) {
    errors.push(`${path} codeql-swift timeout-minutes must equal ${CODEQL_SWIFT_TIMEOUT_MINUTES}.`);
  }
  const swiftBuilds = swift
    ? jobRunSteps({ analyze_swift: swift }, "analyze_swift", path, errors)
    : null;
  if (
    !swiftBuilds?.some(
      (step) =>
        step.command ===
        'node apps/desktop/scripts/build-appsnap-helper.mjs --arch arm64 --output "${{ runner.temp }}/synara-appsnap-helper"',
    )
  ) {
    errors.push(`${path} codeql-swift must build the tracked AppSnap Swift helper.`);
  }
}

export function parseWorkflowPolicy(contents: string): WorkflowPolicy {
  const raw = JSON.parse(contents) as unknown;
  if (!isRecord(raw)) throw new Error("Workflow policy must be an object.");
  if (raw.schemaVersion !== 1) throw new Error("Workflow policy schemaVersion must equal 1.");
  if (raw.repository !== "slashdevcorpse/synara") {
    throw new Error("Workflow policy repository must equal slashdevcorpse/synara.");
  }
  if (!Array.isArray(raw.disabledWorkflows) || !Array.isArray(raw.allowedWorkflows)) {
    throw new Error("Workflow policy must define disabledWorkflows and allowedWorkflows arrays.");
  }
  return raw as unknown as WorkflowPolicy;
}

function validatePolicy(policy: WorkflowPolicy, errors: string[]): void {
  const disabledPaths = new Set<string>();
  for (const [index, workflow] of policy.disabledWorkflows.entries()) {
    const path = `policy.disabledWorkflows[${index}]`;
    if (!isRecord(workflow)) {
      errors.push(`${path} must be an object.`);
      continue;
    }
    if (typeof workflow.path !== "string" || !EXPECTED_DISABLED_PATHS.has(workflow.path)) {
      errors.push(`${path}.path is not one of the four inherited disabled workflows.`);
    }
    if (workflow.requiredState !== "disabled_manually") {
      errors.push(`${path}.requiredState must equal disabled_manually.`);
    }
    if (typeof workflow.reason !== "string" || workflow.reason.trim().length === 0) {
      errors.push(`${path}.reason must explain why the workflow is disabled.`);
    }
    if (disabledPaths.has(workflow.path)) errors.push(`${path}.path is duplicated.`);
    disabledPaths.add(workflow.path);
  }
  for (const expectedPath of EXPECTED_DISABLED_PATHS) {
    if (!disabledPaths.has(expectedPath)) errors.push(`Policy must disable ${expectedPath}.`);
  }

  const allowedPaths = new Set<string>();
  for (const [index, workflow] of policy.allowedWorkflows.entries()) {
    const path = `policy.allowedWorkflows[${index}]`;
    if (!isRecord(workflow) || typeof workflow.path !== "string") {
      errors.push(`${path}.path must be a string.`);
      continue;
    }
    if (disabledPaths.has(workflow.path)) errors.push(`${path}.path is also disabled.`);
    if (allowedPaths.has(workflow.path)) errors.push(`${path}.path is duplicated.`);
    allowedPaths.add(workflow.path);
    if (typeof workflow.requiredOnDefaultBranch !== "boolean") {
      errors.push(`${path}.requiredOnDefaultBranch must be boolean.`);
    }
    const triggers = stringArray(workflow.triggers);
    if (!triggers || triggers.length === 0)
      errors.push(`${path}.triggers must be non-empty strings.`);
  }
}

function workflowTriggers(workflow: UnknownRecord, path: string, errors: string[]): string[] {
  const trigger = workflow.on;
  if (typeof trigger === "string") return [trigger];
  if (Array.isArray(trigger) && trigger.every((entry) => typeof entry === "string")) {
    return trigger as string[];
  }
  if (isRecord(trigger)) return Object.keys(trigger);
  errors.push(`${path} must define valid workflow triggers under on:.`);
  return [];
}

function collectValuesForKey(
  value: unknown,
  key: string,
  results: Array<{ readonly location: string; readonly value: unknown }>,
  location: string,
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectValuesForKey(entry, key, results, `${location}[${index}]`);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const entryLocation = location.length > 0 ? `${location}.${entryKey}` : entryKey;
    if (entryKey === key) results.push({ location: entryLocation, value: entryValue });
    collectValuesForKey(entryValue, key, results, entryLocation);
  }
}

function permissionEntries(workflow: UnknownRecord): Array<{
  readonly location: string;
  readonly scope: string;
  readonly access: string;
}> {
  const entries: Array<{ location: string; scope: string; access: string }> = [];
  const addPermissions = (value: unknown, location: string): void => {
    if (typeof value === "string") {
      entries.push({ location, scope: "*", access: value });
      return;
    }
    if (!isRecord(value)) return;
    for (const [scope, access] of Object.entries(value)) {
      if (typeof access === "string") entries.push({ location, scope, access });
    }
  };
  addPermissions(workflow.permissions, "permissions");
  if (isRecord(workflow.jobs)) {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (isRecord(job)) addPermissions(job.permissions, `jobs.${jobName}.permissions`);
    }
  }
  return entries;
}

function validateActionPins(path: string, contents: string, errors: string[]): void {
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#\s*(.+))?\s*$/);
    if (!match) continue;
    const action = match[1]!;
    if (
      path === ".github/workflows/release-drafter.yml" &&
      action === "./.github/workflows/super-synara-prerelease.yml"
    ) {
      continue;
    }
    const separator = action.lastIndexOf("@");
    const ref = separator >= 0 ? action.slice(separator + 1) : "";
    if (!FULL_ACTION_SHA.test(ref)) {
      errors.push(`${path}:${index + 1} action ${action} must use a full commit SHA.`);
    }
    if (!match[2]?.trim()) {
      errors.push(`${path}:${index + 1} pinned action must retain a human version comment.`);
    }
  }
}

function allowedWritePermission(path: string, location: string, scope: string): boolean {
  if (path === ".github/workflows/release-drafter.yml") {
    return (
      (location === "jobs.draft.permissions" && scope === "contents") ||
      (location === "jobs.dispatch.permissions" && scope === "contents")
    );
  }
  if (
    path === ".github/workflows/codeql.yml" &&
    location.startsWith("jobs.analyze_") &&
    scope === "security-events"
  ) {
    return true;
  }
  if (
    path === ".github/workflows/upstream-watch.yml" &&
    location === "jobs.report.permissions" &&
    scope === "issues"
  ) {
    return true;
  }
  return (
    path === ".github/workflows/super-synara-prerelease.yml" &&
    (location === "jobs.draft_admission.permissions" || location === "jobs.publish.permissions") &&
    scope === "contents"
  );
}

function validatePlaywrightBrowserCache(
  workflowPath: string,
  jobName: PlaywrightCacheJobName,
  job: UnknownRecord,
  errors: string[],
): void {
  const expectedPath = PLAYWRIGHT_BROWSER_CACHE_PATHS[jobName];
  const namedCacheSteps = Array.isArray(job.steps)
    ? job.steps.filter(
        (step): step is UnknownRecord =>
          isRecord(step) && step.name === "Cache Playwright browsers",
      )
    : [];
  if (namedCacheSteps.length !== 1) {
    errors.push(`${workflowPath} ${jobName} must define exactly one Playwright browser cache.`);
  } else {
    const cache = namedCacheSteps[0]!;
    if (
      cache.uses !== CACHE_ACTION ||
      !isRecord(cache.with) ||
      cache.with.path !== expectedPath ||
      cache.if !== undefined ||
      (cache["continue-on-error"] !== undefined && cache["continue-on-error"] !== false)
    ) {
      errors.push(
        `${workflowPath} ${jobName} must cache Playwright browsers at ${expectedPath} with the pinned cache action.`,
      );
    }
  }

  const hasPathOverride =
    (isRecord(job.env) && job.env.PLAYWRIGHT_BROWSERS_PATH !== undefined) ||
    (Array.isArray(job.steps) &&
      job.steps.some(
        (step) =>
          isRecord(step) && isRecord(step.env) && step.env.PLAYWRIGHT_BROWSERS_PATH !== undefined,
      ));
  if (hasPathOverride) {
    errors.push(
      `${workflowPath} ${jobName} must use Playwright's OS-default browser path without PLAYWRIGHT_BROWSERS_PATH overrides.`,
    );
  }
}

function validateQuarantineCommands(
  workflowPath: string,
  jobName: string,
  steps: readonly WorkflowRunStep[],
  platform: "linux" | "windows",
  errors: string[],
): void {
  const runCommand = QUARANTINE_RUN_COMMANDS[platform];
  const runs = steps.filter((step) => step.command === runCommand);
  if (runs.length !== 1 || runs[0]!.condition !== undefined || runs[0]!.continueOnError !== true) {
    errors.push(
      `${workflowPath} ${jobName} must run the registered ${platform} quarantine as the sole nonblocking test step.`,
    );
  }

  const summaryCommand = `node scripts/quarantine-registry.ts summary --platform ${platform} --baseline-ref ${QUARANTINE_BASELINE_REF} --github-step-summary`;
  const summaries = steps.filter((step) => step.command === summaryCommand);
  if (
    summaries.length !== 1 ||
    summaries[0]!.condition !== "always()" ||
    (summaries[0]!.continueOnError !== undefined && summaries[0]!.continueOnError !== false)
  ) {
    errors.push(`${workflowPath} ${jobName} must publish the ${platform} quarantine summary.`);
  }
}

function hasExactMultilineEntries(value: unknown, expected: readonly string[]): boolean {
  const entries = multilineStringEntries(value);
  return (
    entries !== null &&
    entries.length === expected.length &&
    entries.every((entry, index) => entry === expected[index])
  );
}

function exactDesktopE2eCommand(
  workflowPath: string,
  jobName: string,
  steps: readonly WorkflowRunStep[],
  command: string,
  label: string,
  errors: string[],
): WorkflowRunStep | null {
  const matches = steps.filter((step) => step.command === command);
  if (matches.length !== 1) {
    errors.push(`${workflowPath} ${jobName} must run exact ${label} command: ${command}.`);
    return null;
  }
  const step = matches[0]!;
  if (
    step.condition !== undefined ||
    (step.continueOnError !== undefined && step.continueOnError !== false)
  ) {
    errors.push(`${workflowPath} ${jobName} ${label} must be unconditional and fail closed.`);
  }
  return step;
}

function validateDesktopE2eProducer(
  jobs: UnknownRecord,
  workflowPath: string,
  config: (typeof DESKTOP_E2E_CONFIG)[keyof typeof DESKTOP_E2E_CONFIG],
  errors: string[],
): void {
  const job = jobs[config.producerJobName];
  if (!isRecord(job) || !Array.isArray(job.steps)) {
    errors.push(
      `${workflowPath} must define the ${config.producerJobName} desktop E2E artifact producer.`,
    );
    return;
  }
  const uploads = actionSteps(job, UPLOAD_ARTIFACT_ACTION);
  if (uploads.length !== 1) {
    errors.push(
      `${workflowPath} ${config.producerJobName} must upload exactly one pinned ${config.artifactName} artifact.`,
    );
    return;
  }
  const upload = uploads[0]!;
  if (
    upload.if !== undefined ||
    (upload["continue-on-error"] !== undefined && upload["continue-on-error"] !== false)
  ) {
    errors.push(
      `${workflowPath} ${config.producerJobName} desktop E2E artifact upload must be unconditional and fail closed.`,
    );
  }
  if (
    !isRecord(upload.with) ||
    upload.with.name !== config.artifactName ||
    !hasExactMultilineEntries(upload.with.path, DESKTOP_E2E_BUILD_ARTIFACT_PATHS) ||
    upload.with["if-no-files-found"] !== "error" ||
    upload.with["retention-days"] !== 1
  ) {
    errors.push(
      `${workflowPath} ${config.producerJobName} must upload exact ${config.artifactName} paths with one-day fail-closed retention.`,
    );
  }

  const runSteps = jobRunSteps(jobs, config.producerJobName, workflowPath, errors) ?? [];
  const buildSteps = runSteps.filter((step) => step.command === CI_DESKTOP_BUILD_COMMAND);
  const uploadIndex = job.steps.indexOf(upload);
  if (buildSteps.length !== 1 || buildSteps[0]!.index >= uploadIndex) {
    errors.push(
      `${workflowPath} ${config.producerJobName} must upload ${config.artifactName} after its sole desktop build.`,
    );
  }
}

function validateDesktopE2eConsumer(
  jobs: UnknownRecord,
  workflowPath: string,
  config: (typeof DESKTOP_E2E_CONFIG)[keyof typeof DESKTOP_E2E_CONFIG],
  errors: string[],
): void {
  const job = jobs[config.jobName];
  if (!isRecord(job) || !Array.isArray(job.steps)) {
    errors.push(`${workflowPath} must define the ${config.jobName} packaged desktop E2E job.`);
    return;
  }
  const needs = typeof job.needs === "string" ? [job.needs] : stringArray(job.needs);
  if (!needs || needs.length !== 1 || needs[0] !== config.producerJobName) {
    errors.push(
      `${workflowPath} ${config.jobName} must need only its same-platform producer ${config.producerJobName}.`,
    );
  }
  if (
    job.name !== config.jobName ||
    job["runs-on"] !== config.runner ||
    job["timeout-minutes"] !== DESKTOP_E2E_JOB_TIMEOUT_MINUTES ||
    job.if !== undefined ||
    (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false)
  ) {
    errors.push(
      `${workflowPath} ${config.jobName} must be a named, bounded, fail-closed ${config.runner} job.`,
    );
  }

  const runSteps = jobRunSteps(jobs, config.jobName, workflowPath, errors) ?? [];
  const install = exactDesktopE2eCommand(
    workflowPath,
    config.jobName,
    runSteps,
    DESKTOP_E2E_INSTALL_COMMAND,
    "dependency install",
    errors,
  );
  const systemDependencies = config.systemDependenciesCommand
    ? exactDesktopE2eCommand(
        workflowPath,
        config.jobName,
        runSteps,
        config.systemDependenciesCommand,
        "system dependency install",
        errors,
      )
    : null;
  const test = exactDesktopE2eCommand(
    workflowPath,
    config.jobName,
    runSteps,
    config.testCommand,
    "packaged desktop E2E",
    errors,
  );
  if (
    runSteps.some((step) =>
      executableShellLines(step.rawCommand).some((line) => invokesWorkspaceBuild(line)),
    )
  ) {
    errors.push(
      `${workflowPath} ${config.jobName} must consume prebuilt artifacts without builds.`,
    );
  }

  const downloads = actionSteps(job, DOWNLOAD_ARTIFACT_ACTION);
  if (downloads.length !== 1) {
    errors.push(
      `${workflowPath} ${config.jobName} must download exactly one pinned ${config.artifactName} artifact.`,
    );
  } else {
    const download = downloads[0]!;
    const downloadIndex = job.steps.indexOf(download);
    if (
      download.if !== undefined ||
      (download["continue-on-error"] !== undefined && download["continue-on-error"] !== false) ||
      !isRecord(download.with) ||
      download.with.name !== config.artifactName ||
      download.with.path !== "."
    ) {
      errors.push(
        `${workflowPath} ${config.jobName} must download ${config.artifactName} at the repository root and fail closed.`,
      );
    }
    if (
      (install && install.index >= downloadIndex) ||
      (test && downloadIndex >= test.index) ||
      (systemDependencies && test && systemDependencies.index >= test.index)
    ) {
      errors.push(
        `${workflowPath} ${config.jobName} must install, download, and execute its prebuilt E2E artifact in order.`,
      );
    }
  }

  const diagnostics = actionStepsWithPrefix(job, "actions/upload-artifact@");
  if (diagnostics.length !== 1 || diagnostics[0]?.uses !== UPLOAD_ARTIFACT_ACTION) {
    errors.push(
      `${workflowPath} ${config.jobName} must define exactly one pinned failure diagnostics upload.`,
    );
  } else {
    const diagnostic = diagnostics[0]!;
    const diagnosticPaths = isRecord(diagnostic.with)
      ? multilineStringEntries(diagnostic.with.path)
      : null;
    if (
      diagnosticPaths?.some((diagnosticPath) =>
        UNSAFE_DESKTOP_E2E_DIAGNOSTIC_PATH_PATTERN.test(diagnosticPath),
      )
    ) {
      errors.push(
        `${workflowPath} ${config.jobName} diagnostics must not expose raw Playwright, protocol, backend, or SQLite artifacts.`,
      );
    }
    if (
      diagnostic.if !== "failure()" ||
      (diagnostic["continue-on-error"] !== undefined &&
        diagnostic["continue-on-error"] !== false) ||
      !isRecord(diagnostic.with) ||
      diagnostic.with.name !== config.diagnosticName ||
      !hasExactMultilineEntries(diagnostic.with.path, DESKTOP_E2E_DIAGNOSTIC_PATHS) ||
      diagnostic.with["if-no-files-found"] !== "ignore" ||
      diagnostic.with["retention-days"] !== 7
    ) {
      errors.push(
        `${workflowPath} ${config.jobName} diagnostics must upload exact failure-only paths with seven-day retention.`,
      );
    }
    if (test && job.steps.indexOf(diagnostic) <= test.index) {
      errors.push(`${workflowPath} ${config.jobName} diagnostics must run after the E2E command.`);
    }
  }
}

function validateDesktopE2ePipeline(
  jobs: UnknownRecord,
  workflowPath: string,
  errors: string[],
): void {
  for (const config of Object.values(DESKTOP_E2E_CONFIG)) {
    validateDesktopE2eProducer(jobs, workflowPath, config, errors);
    validateDesktopE2eConsumer(jobs, workflowPath, config, errors);
  }
}

function validateRequiredQualityAggregate(
  jobs: UnknownRecord,
  workflowPath: string,
  errors: string[],
): void {
  const job = jobs.quality;
  if (!isRecord(job) || !Array.isArray(job.steps)) {
    errors.push(`${workflowPath} must define the required quality aggregate job.`);
    return;
  }
  if (job["runs-on"] !== "ubuntu-24.04") {
    errors.push(`${workflowPath} quality aggregate must run on ubuntu-24.04.`);
  }
  if (
    job.if !== "always()" ||
    (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false)
  ) {
    errors.push(`${workflowPath} quality aggregate must run with always() and fail closed.`);
  }
  const needs = stringArray(job.needs);
  if (!needs || needs.join(",") !== QUALITY_AGGREGATE_NEEDS.join(",")) {
    errors.push(
      `${workflowPath} quality aggregate must depend on the exact merge-blocking quality job set.`,
    );
  }
  if (job["timeout-minutes"] !== 5) {
    errors.push(`${workflowPath} quality aggregate timeout must be 5 minutes.`);
  }
  if (job.steps.length !== 1) {
    errors.push(`${workflowPath} quality aggregate must contain only its result gate.`);
  }
  const steps = jobRunSteps(jobs, "quality", workflowPath, errors) ?? [];
  const expectedCommand = normalizeShellCommand(QUALITY_AGGREGATE_COMMAND);
  const matches = steps.filter((step) => step.command === expectedCommand);
  if (matches.length !== 1) {
    errors.push(`${workflowPath} quality must run exact aggregate gate command.`);
  } else if (
    matches[0]!.condition !== undefined ||
    (matches[0]!.continueOnError !== undefined && matches[0]!.continueOnError !== false)
  ) {
    errors.push(`${workflowPath} quality aggregate result gate must fail closed.`);
  }
}

function validateQualityWindows(jobs: UnknownRecord, workflowPath: string, errors: string[]): void {
  const job = jobs.quality_windows;
  if (!isRecord(job) || !Array.isArray(job.steps)) {
    errors.push(`${workflowPath} must define the required quality_windows job with steps.`);
    return;
  }
  if (job["runs-on"] !== "windows-2022") {
    errors.push(`${workflowPath} quality_windows must run on windows-2022.`);
  }
  if (job["timeout-minutes"] !== QUALITY_WINDOWS_JOB_TIMEOUT_MINUTES) {
    errors.push(
      `${workflowPath} quality_windows timeout must be ${QUALITY_WINDOWS_JOB_TIMEOUT_MINUTES} minutes.`,
    );
  }
  if (
    job.if !== undefined ||
    (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false)
  ) {
    errors.push(`${workflowPath} quality_windows job must be unconditional and fail closed.`);
  }
  if (job.steps.length !== QUALITY_WINDOWS_STEP_SEQUENCE.length) {
    errors.push(
      `${workflowPath} quality_windows must contain only the required setup, install, and quality steps.`,
    );
  }
  for (const [index, expected] of QUALITY_WINDOWS_STEP_SEQUENCE.entries()) {
    const step = job.steps[index];
    if (!isRecord(step)) {
      errors.push(`${workflowPath} quality_windows step ${index + 1} is missing or malformed.`);
      continue;
    }
    const actual =
      expected.kind === "run" && typeof step.run === "string"
        ? normalizeShellCommand(step.run)
        : step[expected.kind];
    if (actual !== expected.value) {
      errors.push(
        `${workflowPath} quality_windows step ${index + 1} must be exact ${expected.kind}: ${expected.value}.`,
      );
    }
    if (
      step.if !== undefined ||
      (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false)
    ) {
      errors.push(
        `${workflowPath} quality_windows required steps must be unconditional and fail closed.`,
      );
    }
  }
}

function validateCiArchitecture(workflow: UnknownRecord, errors: string[]): void {
  const workflowPath = ".github/workflows/ci.yml";
  if (isRecord(workflow.env) && workflow.env.PLAYWRIGHT_BROWSERS_PATH !== undefined) {
    errors.push(
      `${workflowPath} must use Playwright's OS-default browser paths without a workflow-level PLAYWRIGHT_BROWSERS_PATH override.`,
    );
  }
  if (!isRecord(workflow.jobs)) {
    errors.push(`${workflowPath} must define jobs.`);
    return;
  }
  validateUnitMatrix(workflow.jobs, workflowPath, errors);
  validateQualityWindows(workflow.jobs, workflowPath, errors);
  validateDesktopE2ePipeline(workflow.jobs, workflowPath, errors);
  validateRequiredQualityAggregate(workflow.jobs, workflowPath, errors);
  const qualityLinuxSteps = jobRunSteps(workflow.jobs, "quality_linux", workflowPath, errors);
  const windowsSteps = jobRunSteps(workflow.jobs, "windows_x64", workflowPath, errors);
  const macosSteps = jobRunSteps(workflow.jobs, "macos_arm64", workflowPath, errors);
  const windowsJob = workflow.jobs.windows_x64;
  const macosJob = workflow.jobs.macos_arm64;
  const qualityLinuxJob = workflow.jobs.quality_linux;
  const unitJob = workflow.jobs.unit;
  if (isRecord(qualityLinuxJob) && qualityLinuxJob["runs-on"] !== "ubuntu-24.04") {
    errors.push(`${workflowPath} quality_linux must run on ubuntu-24.04.`);
  }
  if (
    isRecord(qualityLinuxJob) &&
    (qualityLinuxJob.if !== undefined ||
      (qualityLinuxJob["continue-on-error"] !== undefined &&
        qualityLinuxJob["continue-on-error"] !== false))
  ) {
    errors.push(`${workflowPath} quality_linux job must be unconditional and fail closed.`);
  }
  if (isRecord(qualityLinuxJob)) {
    if (qualityLinuxSteps) {
      const quarantineValidation = exactBlockingCommand(
        workflowPath,
        "quality_linux",
        qualityLinuxSteps,
        QUARANTINE_VALIDATE_COMMAND,
        errors,
      );
      const browserInstall = exactBlockingCommand(
        workflowPath,
        "quality_linux",
        qualityLinuxSteps,
        BROWSER_INSTALL_COMMANDS.quality_linux,
        errors,
      );
      const quarantineInventory = exactBlockingCommand(
        workflowPath,
        "quality_linux",
        qualityLinuxSteps,
        QUARANTINE_INVENTORY_COMMANDS.linux,
        errors,
      );
      const stableBrowser = exactBlockingCommand(
        workflowPath,
        "quality_linux",
        qualityLinuxSteps,
        BROWSER_STABLE_COMMAND,
        errors,
      );
      if (
        quarantineValidation &&
        browserInstall &&
        quarantineValidation.index >= browserInstall.index
      ) {
        errors.push(`${workflowPath} quality_linux must validate quarantine before browser setup.`);
      }
      if (browserInstall && stableBrowser && browserInstall.index >= stableBrowser.index) {
        errors.push(
          `${workflowPath} quality_linux must install Playwright before stable browser tests.`,
        );
      }
      if (
        browserInstall &&
        quarantineInventory &&
        browserInstall.index >= quarantineInventory.index
      ) {
        errors.push(
          `${workflowPath} quality_linux must install Playwright before quarantine inventory collection.`,
        );
      }
      if (
        quarantineInventory &&
        stableBrowser &&
        quarantineInventory.index >= stableBrowser.index
      ) {
        errors.push(
          `${workflowPath} quality_linux must verify quarantine inventory before stable browser tests.`,
        );
      }
      validateQuarantineCommands(workflowPath, "quality_linux", qualityLinuxSteps, "linux", errors);
    }
    validatePlaywrightBrowserCache(workflowPath, "quality_linux", qualityLinuxJob, errors);
  }

  const browserWindowsJob = workflow.jobs.browser_windows;
  const browserWindowsSteps = jobRunSteps(workflow.jobs, "browser_windows", workflowPath, errors);
  if (!isRecord(browserWindowsJob)) {
    errors.push(`${workflowPath} must define the browser_windows job.`);
  } else {
    if (browserWindowsJob["runs-on"] !== "windows-2022") {
      errors.push(`${workflowPath} browser_windows must run on windows-2022.`);
    }
    if (
      browserWindowsJob.if !== undefined ||
      browserWindowsJob.needs !== undefined ||
      browserWindowsJob["timeout-minutes"] !== 40 ||
      (browserWindowsJob["continue-on-error"] !== undefined &&
        browserWindowsJob["continue-on-error"] !== false)
    ) {
      errors.push(
        `${workflowPath} browser_windows must be an independent, bounded, fail-closed job.`,
      );
    }
    validatePlaywrightBrowserCache(workflowPath, "browser_windows", browserWindowsJob, errors);
    if (browserWindowsSteps) {
      const installDependencies = exactBlockingCommand(
        workflowPath,
        "browser_windows",
        browserWindowsSteps,
        "bun install --frozen-lockfile",
        errors,
      );
      const quarantineValidation = exactBlockingCommand(
        workflowPath,
        "browser_windows",
        browserWindowsSteps,
        QUARANTINE_VALIDATE_COMMAND,
        errors,
      );
      const browserInstall = exactBlockingCommand(
        workflowPath,
        "browser_windows",
        browserWindowsSteps,
        BROWSER_INSTALL_COMMANDS.browser_windows,
        errors,
      );
      const quarantineInventory = exactBlockingCommand(
        workflowPath,
        "browser_windows",
        browserWindowsSteps,
        QUARANTINE_INVENTORY_COMMANDS.windows,
        errors,
      );
      const stableBrowser = exactBlockingCommand(
        workflowPath,
        "browser_windows",
        browserWindowsSteps,
        BROWSER_STABLE_COMMAND,
        errors,
      );
      if (
        installDependencies &&
        quarantineValidation &&
        installDependencies.index >= quarantineValidation.index
      ) {
        errors.push(`${workflowPath} browser_windows must install dependencies before validation.`);
      }
      if (
        quarantineValidation &&
        browserInstall &&
        quarantineValidation.index >= browserInstall.index
      ) {
        errors.push(
          `${workflowPath} browser_windows must validate quarantine before browser setup.`,
        );
      }
      if (browserInstall && stableBrowser && browserInstall.index >= stableBrowser.index) {
        errors.push(
          `${workflowPath} browser_windows must install Playwright before stable browser tests.`,
        );
      }
      if (
        browserInstall &&
        quarantineInventory &&
        browserInstall.index >= quarantineInventory.index
      ) {
        errors.push(
          `${workflowPath} browser_windows must install Playwright before quarantine inventory collection.`,
        );
      }
      if (
        quarantineInventory &&
        stableBrowser &&
        quarantineInventory.index >= stableBrowser.index
      ) {
        errors.push(
          `${workflowPath} browser_windows must verify quarantine inventory before stable browser tests.`,
        );
      }
      validateQuarantineCommands(
        workflowPath,
        "browser_windows",
        browserWindowsSteps,
        "windows",
        errors,
      );
    }
  }
  if (isRecord(unitJob)) {
    validateMergifyUpload(unitJob, workflowPath, errors);
    validateCodecovUploads(unitJob, workflowPath, errors);
  }
  if (isRecord(windowsJob) && windowsJob["runs-on"] !== "windows-2022") {
    errors.push(`${workflowPath} windows_x64 must run on windows-2022.`);
  }
  if (
    isRecord(windowsJob) &&
    (windowsJob.if !== undefined ||
      (windowsJob["continue-on-error"] !== undefined && windowsJob["continue-on-error"] !== false))
  ) {
    errors.push(`${workflowPath} windows_x64 job must be unconditional and fail closed.`);
  }
  if (isRecord(macosJob)) {
    if (
      macosJob.if !== MACOS_BACKLOG_CONDITION ||
      (macosJob["continue-on-error"] !== undefined && macosJob["continue-on-error"] !== false)
    ) {
      errors.push(`${workflowPath} macos_arm64 must remain disabled while macOS CI is backlogged.`);
    }
    if (macosJob["runs-on"] !== "macos-15") {
      errors.push(`${workflowPath} macos_arm64 must run on macos-15.`);
    }
    if (!macosSteps?.some((step) => step.command === 'test "$(uname -m)" = arm64')) {
      errors.push(`${workflowPath} macos_arm64 must fail closed with test "$(uname -m)" = arm64.`);
    }
  }
  if (windowsSteps) {
    validateNativeJobCommands(
      workflowPath,
      "windows_x64",
      windowsSteps,
      CI_WINDOWS_REQUIRED_COMMANDS,
      errors,
      CI_WINDOWS_POST_BUILD_COMMAND,
    );
    validatePostBuildGate(
      workflowPath,
      "windows_x64",
      windowsSteps,
      CI_WINDOWS_PACKAGED_CLI_COMMAND,
      errors,
    );
    validateNativePersistenceSmoke(workflowPath, "windows_x64", windowsSteps, errors);
  }
  if (macosSteps) {
    validateNativeJobCommands(
      workflowPath,
      "macos_arm64",
      macosSteps,
      CI_MACOS_REQUIRED_COMMANDS,
      errors,
    );
    validateNativePersistenceSmoke(workflowPath, "macos_arm64", macosSteps, errors);
  }

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!isRecord(step) || step["continue-on-error"] === undefined) continue;
      const allowed =
        step["continue-on-error"] === true &&
        typeof step.run === "string" &&
        ALLOWED_NONBLOCKING_CI_COMMANDS.has(normalizeShellCommand(step.run));
      if (!allowed && step["continue-on-error"] !== false) {
        errors.push(
          `${workflowPath} ${jobName} may use continue-on-error only for registered quarantine runs.`,
        );
      }
    }
  }
}

function validateAllowedWorkflow(
  policy: AllowedWorkflowPolicy,
  contents: string,
  errors: string[],
): void {
  let workflow: unknown;
  try {
    workflow = parseYaml(contents, { strict: true, uniqueKeys: true });
  } catch (error) {
    errors.push(
      `${policy.path} is not valid YAML: ${error instanceof Error ? error.message : error}`,
    );
    return;
  }
  if (!isRecord(workflow)) {
    errors.push(`${policy.path} must contain a workflow object.`);
    return;
  }

  const actualTriggers = workflowTriggers(workflow, policy.path, errors).sort();
  const expectedTriggers = [...policy.triggers].sort();
  if (actualTriggers.join(",") !== expectedTriggers.join(",")) {
    errors.push(
      `${policy.path} triggers ${actualTriggers.join(",") || "none"}; expected ${expectedTriggers.join(",")}.`,
    );
  }
  if (actualTriggers.includes("pull_request_target")) {
    errors.push(`${policy.path} must not use pull_request_target.`);
  }

  if (!isRecord(workflow.permissions) || workflow.permissions.contents !== "read") {
    errors.push(`${policy.path} must set workflow-level permissions.contents to read.`);
  }
  for (const permission of permissionEntries(workflow)) {
    if (permission.scope === "id-token" && permission.access === "write") {
      errors.push(`${policy.path} must not grant id-token: write.`);
    }
    if (
      permission.access.includes("write") &&
      !allowedWritePermission(policy.path, permission.location, permission.scope)
    ) {
      errors.push(
        `${policy.path} grants unsupported ${permission.scope}: write at ${permission.location}.`,
      );
    }
  }

  const runners: Array<{ readonly location: string; readonly value: unknown }> = [];
  collectValuesForKey(workflow.jobs, "runs-on", runners, "jobs");
  for (const runner of runners) {
    const isCiUnitMatrixRunner =
      policy.path === ".github/workflows/ci.yml" &&
      runner.location === "jobs.unit.runs-on" &&
      runner.value === MATRIX_RUNNER_EXPRESSION;
    if (
      typeof runner.value !== "string" ||
      (!APPROVED_RUNNERS.has(runner.value) && !isCiUnitMatrixRunner)
    ) {
      errors.push(`${policy.path} references unsupported runner ${String(runner.value)}.`);
    }
  }
  if (policy.path === ".github/workflows/ci.yml") validateCiArchitecture(workflow, errors);
  if (policy.path === ".github/workflows/dependency-review.yml") {
    validateDependencyReviewWorkflow(workflow, errors);
  }
  if (policy.path === ".github/workflows/codeql.yml") validateCodeqlWorkflow(workflow, errors);
}

export function validateWorkflowContracts(
  files: ReadonlyMap<string, string>,
  policy: WorkflowPolicy,
): readonly string[] {
  const errors: string[] = [];
  validatePolicy(policy, errors);
  const disabledPaths = new Set(policy.disabledWorkflows.map((workflow) => workflow.path));
  const allowedByPath = new Map(
    policy.allowedWorkflows.map((workflow) => [workflow.path, workflow]),
  );

  for (const [path, contents] of files) {
    validateActionPins(path, contents, errors);
    if (!disabledPaths.has(path) && !allowedByPath.has(path)) {
      errors.push(`${path} is not classified by docs/downstream/workflow-policy.json.`);
    }
  }
  for (const disabledPath of disabledPaths) {
    if (!files.has(disabledPath))
      errors.push(`Disabled workflow is missing from source: ${disabledPath}.`);
  }
  for (const allowedWorkflow of policy.allowedWorkflows) {
    const contents = files.get(allowedWorkflow.path);
    if (!contents) {
      if (allowedWorkflow.requiredOnDefaultBranch) {
        errors.push(`Required allowed workflow is missing: ${allowedWorkflow.path}.`);
      }
      continue;
    }
    validateAllowedWorkflow(allowedWorkflow, contents, errors);
  }
  return errors;
}

export function validateVouchedConfiguration(contents: string): readonly string[] {
  const entries = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (entries.length === 1 && entries[0] === "github:slashdevcorpse") return [];
  return [".github/VOUCHED.td must contain exactly one trusted identity: github:slashdevcorpse."];
}

export function validateMergifyConfiguration(contents: string): readonly string[] {
  let raw: unknown;
  try {
    raw = parseYaml(contents, { strict: true, uniqueKeys: true });
  } catch (error) {
    return [`.mergify.yml is not valid YAML: ${error instanceof Error ? error.message : error}`];
  }
  const expected = {
    merge_queue: { mode: "serial", max_parallel_checks: 1 },
    merge_protections_settings: { auto_merge_conditions: ["label = ready-to-merge"] },
    merge_protections: [
      {
        name: "protected-main",
        if: ["base = main"],
        success_conditions: ["-draft", "-conflict"],
      },
    ],
    queue_rules: [
      {
        name: "default",
        batch_size: 1,
        branch_protection_injection_mode: "queue",
        merge_method: "squash",
        queue_conditions: ["base = main"],
        merge_conditions: ["base = main"],
      },
    ],
  };
  if (JSON.stringify(raw) === JSON.stringify(expected)) return [];
  return [
    ".mergify.yml must preserve serial, label-gated squash merging, use strict-ruleset-compatible in-place checks, and inject the strict protected-main ruleset into the queue.",
  ];
}

export function validateRepositoryWorkflowStates(
  states: readonly RepositoryWorkflowState[],
  policy: WorkflowPolicy,
): readonly string[] {
  const errors: string[] = [];
  const statesByPath = new Map(states.map((workflow) => [workflow.path, workflow.state]));
  for (const workflow of policy.disabledWorkflows) {
    const state = statesByPath.get(workflow.path);
    if (state === undefined) {
      errors.push(`Disabled workflow is not registered in GitHub Actions: ${workflow.path}.`);
    } else if (state !== workflow.requiredState) {
      errors.push(`${workflow.path} state is ${state}; expected ${workflow.requiredState}.`);
    }
  }
  for (const workflow of policy.allowedWorkflows) {
    const state = statesByPath.get(workflow.path);
    if (state === undefined) {
      if (workflow.requiredOnDefaultBranch) {
        errors.push(`Allowed workflow is not registered in GitHub Actions: ${workflow.path}.`);
      }
    } else if (state !== "active") {
      errors.push(`${workflow.path} state is ${state}; expected active.`);
    }
  }
  return errors;
}
