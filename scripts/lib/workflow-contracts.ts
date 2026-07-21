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
const CI_WINDOWS_REQUIRED_COMMANDS = [
  "bun run brand:check",
  "node apps/server/scripts/build-windows-job-launcher.mjs --arch x64",
  "node apps/server/scripts/build-windows-job-launcher.mjs --arch arm64",
  "bun run --cwd apps/server test src/provider/windowsProviderProcess.test.ts src/provider/windowsProviderProcess.windows.test.ts",
  "bun run --cwd packages/shared test src/desktopIdentity.test.ts src/desktopIdentityProof.test.ts src/windowsCertificate.test.ts",
  "bun run --cwd apps/desktop test src/backendShutdown.test.ts src/backendShutdown.windows.integration.test.ts",
  "bun run --cwd packages/shared test src/windowsProcess.test.ts",
  "bun run --cwd apps/server test src/windowsProcessEffect.test.ts src/codexAppServerManager.test.ts src/provider/Layers/ProviderHealth.test.ts src/persistence/MigrationBackup.test.ts src/restoreMigrationBackup.test.ts",
  "bun run --cwd apps/desktop test src/desktopMigrationRecovery.test.ts src/desktopStorageMigration.test.ts src/windowState.test.ts src/updateState.test.ts",
  "bun run --cwd scripts test check-brand-identity.test.ts verify-packaged-desktop-startup.test.ts lib/desktop-artifact-policy.test.ts lib/windows-authenticode.test.ts lib/windows-installer-qualification.test.ts lib/release-artifact-provenance.test.ts lib/super-synara-release-admission.test.ts lib/super-synara-workflow-contract.test.ts",
  "node scripts/verify-workflow-contracts.ts",
] as const;
const CI_WINDOWS_POST_BUILD_COMMAND = "bun run --cwd apps/desktop smoke-test";
const CI_ROOT_TEST_COMMAND = "bun run test:ci";
const CI_CODECOV_ACTION = "codecov/codecov-action@0fb7174895f61a3b6b78fc075e0cd60383518dac";
const CI_CODECOV_UPLOAD_CONDITION =
  "${{ !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') }}";
const CI_CODECOV_TOKEN = "${{ secrets.CODECOV_TOKEN }}";
const CI_CODECOV_COVERAGE_FILES =
  "./apps/desktop/coverage/lcov.info,./apps/server/coverage/lcov.info,./apps/web/coverage/lcov.info,./packages/contracts/coverage/lcov.info,./packages/shared/coverage/lcov.info,./scripts/coverage/lcov.info";
const CI_CODECOV_TEST_RESULT_FILES =
  "./apps/desktop/test-report.junit.xml,./apps/server/test-report.junit.xml,./apps/web/test-report.junit.xml,./packages/contracts/test-report.junit.xml,./packages/shared/test-report.junit.xml,./scripts/test-report.junit.xml";
const CI_MERGIFY_ACTION = "Mergifyio/gha-mergify-ci@8173bc3c1d337d3367454672d50cfdf6f0273396";
const CI_MERGIFY_UPLOAD_CONDITION =
  "${{ !cancelled() && (steps.unit_tests.outcome == 'success' || steps.unit_tests.outcome == 'failure') && (github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository) }}";
const CI_MERGIFY_REPORT_FILES =
  "./apps/desktop/test-report.junit.xml ./apps/server/test-report.junit.xml ./apps/web/test-report.junit.xml ./packages/contracts/test-report.junit.xml ./packages/shared/test-report.junit.xml ./scripts/test-report.junit.xml";
const CI_MERGIFY_VERIFY_COMMAND = 'test "$MERGIFY_UPLOAD_OUTCOME" = "success"';
const DEPENDENCY_REVIEW_ACTION =
  "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294";
const CODEQL_ACTION = "github/codeql-action";
const CODEQL_ACTION_SHA = "e0647621c2984b5ed2f768cb892365bf2a616ad1";
const CODEQL_SWIFT_TIMEOUT_MINUTES = 60;
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

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
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

function invokesRootTest(command: string): boolean {
  return executableShellLines(command).some((line) =>
    /(?:^|(?:&&|\|\||;)\s*)bun run test(?::ci)?(?=$|\s|&&|\|\||;)/.test(line),
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

function validateRootTestOwnership(
  jobs: UnknownRecord,
  ownerJobName: string,
  workflowPath: string,
  errors: string[],
): void {
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
  const owned = occurrences.filter(({ jobName }) => jobName === ownerJobName);
  const expectedOwned = owned.filter(({ step }) => step.command === CI_ROOT_TEST_COMMAND);
  if (expectedOwned.length !== 1) {
    errors.push(
      `${workflowPath} ${ownerJobName} must run exactly one ${CI_ROOT_TEST_COMMAND} suite.`,
    );
  } else if (
    expectedOwned[0]!.step.condition !== undefined ||
    (expectedOwned[0]!.step.continueOnError !== undefined &&
      expectedOwned[0]!.step.continueOnError !== false)
  ) {
    errors.push(
      `${workflowPath} ${ownerJobName} ${CI_ROOT_TEST_COMMAND} must be unconditional and fail closed.`,
    );
  } else if (expectedOwned[0]!.step.id !== "unit_tests") {
    errors.push(
      `${workflowPath} ${ownerJobName} ${CI_ROOT_TEST_COMMAND} must use id unit_tests for report upload conditions.`,
    );
  }
  for (const occurrence of occurrences) {
    if (occurrence.jobName !== ownerJobName || occurrence.step.command !== CI_ROOT_TEST_COMMAND) {
      errors.push(
        `${workflowPath} ${occurrence.jobName} must not own an additional or chained monorepo-wide bun run test suite.`,
      );
    }
  }
}

function booleanActionInput(value: unknown): boolean {
  return value === true || value === "true";
}

function validateCodecovUploads(
  qualityJob: UnknownRecord,
  workflowPath: string,
  errors: string[],
): void {
  if (!Array.isArray(qualityJob.steps)) {
    errors.push(`${workflowPath} quality must define steps.`);
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
  const unitTestStepIndex = qualityJob.steps.findIndex(
    (step) =>
      isRecord(step) &&
      typeof step.run === "string" &&
      normalizeShellCommand(step.run) === CI_ROOT_TEST_COMMAND,
  );

  for (const expected of expectedUploads) {
    const matches = qualityJob.steps.filter(
      (step) => isRecord(step) && step.name === expected.name,
    );
    if (matches.length !== 1) {
      errors.push(`${workflowPath} quality must define exactly one ${expected.name} step.`);
      continue;
    }

    const step = matches[0]!;
    if (!isRecord(step)) continue;
    const uploadIndex = qualityJob.steps.indexOf(step);
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
  qualityJob: UnknownRecord,
  workflowPath: string,
  errors: string[],
): void {
  if (!Array.isArray(qualityJob.steps)) return;
  const matches = qualityJob.steps.filter(
    (step) => isRecord(step) && step.name === "Upload test results to Mergify CI Insights",
  );
  if (matches.length !== 1) {
    errors.push(
      `${workflowPath} quality must define exactly one Upload test results to Mergify CI Insights step.`,
    );
    return;
  }
  const step = matches[0]!;
  if (!isRecord(step)) return;
  const unitTestIndex = qualityJob.steps.findIndex(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.run === "string" &&
      normalizeShellCommand(candidate.run) === CI_ROOT_TEST_COMMAND,
  );
  if (unitTestIndex < 0 || qualityJob.steps.indexOf(step) <= unitTestIndex) {
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

  const verificationMatches = qualityJob.steps.filter(
    (candidate) => isRecord(candidate) && candidate.name === "Verify Mergify test results upload",
  );
  if (verificationMatches.length !== 1) {
    errors.push(
      `${workflowPath} quality must define exactly one Verify Mergify test results upload step.`,
    );
    return;
  }
  const verification = verificationMatches[0]!;
  if (!isRecord(verification)) return;
  if (qualityJob.steps.indexOf(verification) !== qualityJob.steps.indexOf(step) + 1) {
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
    },
    {
      jobName: "analyze_javascript_typescript",
      displayName: "codeql-javascript-typescript",
      runner: "ubuntu-24.04",
      language: "javascript-typescript",
      buildMode: "none",
      category: "/language:javascript-typescript",
    },
    {
      jobName: "analyze_swift",
      displayName: "codeql-swift",
      runner: "macos-15",
      language: "swift",
      buildMode: "manual",
      category: "/language:swift",
    },
  ] as const;
  for (const lane of expected) {
    const job = workflowJob(workflow, lane.jobName);
    if (!job || job.name !== lane.displayName || job["runs-on"] !== lane.runner) {
      errors.push(`${path} must define fixed ${lane.displayName} on ${lane.runner}.`);
      continue;
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

function collectValuesForKey(value: unknown, key: string, results: unknown[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectValuesForKey(entry, key, results);
    return;
  }
  if (!isRecord(value)) return;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) results.push(entryValue);
    collectValuesForKey(entryValue, key, results);
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
    (location === "jobs.reserve_tag.permissions" || location === "jobs.publish.permissions") &&
    scope === "contents"
  );
}

function validateCiArchitecture(workflow: UnknownRecord, errors: string[]): void {
  const workflowPath = ".github/workflows/ci.yml";
  if (!isRecord(workflow.jobs)) {
    errors.push(`${workflowPath} must define jobs.`);
    return;
  }
  validateRootTestOwnership(workflow.jobs, "quality", workflowPath, errors);
  const windowsSteps = jobRunSteps(workflow.jobs, "windows_x64", workflowPath, errors);
  const macosSteps = jobRunSteps(workflow.jobs, "macos_arm64", workflowPath, errors);
  const windowsJob = workflow.jobs.windows_x64;
  const macosJob = workflow.jobs.macos_arm64;
  const qualityJob = workflow.jobs.quality;
  if (isRecord(qualityJob) && qualityJob["runs-on"] !== "ubuntu-24.04") {
    errors.push(`${workflowPath} quality must run on ubuntu-24.04.`);
  }
  if (
    isRecord(qualityJob) &&
    (qualityJob.if !== undefined ||
      (qualityJob["continue-on-error"] !== undefined && qualityJob["continue-on-error"] !== false))
  ) {
    errors.push(`${workflowPath} quality job must be unconditional and fail closed.`);
  }
  if (isRecord(qualityJob)) {
    validateMergifyUpload(qualityJob, workflowPath, errors);
    validateCodecovUploads(qualityJob, workflowPath, errors);
  }
  if (isRecord(windowsJob) && windowsJob["runs-on"] !== "windows-2022") {
    errors.push(`${workflowPath} windows_x64 must run on windows-2022.`);
  }
  for (const [jobName, job] of [
    ["windows_x64", windowsJob],
    ["macos_arm64", macosJob],
  ] as const) {
    if (
      isRecord(job) &&
      (job.if !== undefined ||
        (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false))
    ) {
      errors.push(`${workflowPath} ${jobName} job must be unconditional and fail closed.`);
    }
  }
  if (!isRecord(macosJob)) return;
  if (macosJob["runs-on"] !== "macos-15") {
    errors.push(`${workflowPath} macos_arm64 must run on macos-15.`);
  }
  if (!macosSteps?.some((step) => step.command === 'test "$(uname -m)" = arm64')) {
    errors.push(`${workflowPath} macos_arm64 must fail closed with test "$(uname -m)" = arm64.`);
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

  const runners: unknown[] = [];
  collectValuesForKey(workflow.jobs, "runs-on", runners);
  for (const runner of runners) {
    if (typeof runner !== "string" || !APPROVED_RUNNERS.has(runner)) {
      errors.push(`${policy.path} references unsupported runner ${String(runner)}.`);
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
    merge_queue: { mode: "serial" },
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
      },
    ],
  };
  if (JSON.stringify(raw) === JSON.stringify(expected)) return [];
  return [
    ".mergify.yml must preserve serial, label-gated squash merging and inject the strict protected-main ruleset into the queue.",
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
