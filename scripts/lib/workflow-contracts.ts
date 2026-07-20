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
  "bun run --cwd packages/shared test src/desktopIdentity.test.ts src/desktopIdentityProof.test.ts src/windowsCertificate.test.ts",
  "bun run --cwd apps/desktop test src/backendShutdown.test.ts src/backendShutdown.windows.integration.test.ts",
  "bun run --cwd packages/shared test src/windowsProcess.test.ts",
  "bun run --cwd apps/server test src/windowsProcessEffect.test.ts src/codexAppServerManager.test.ts src/provider/Layers/ProviderHealth.test.ts src/persistence/MigrationBackup.test.ts src/restoreMigrationBackup.test.ts",
  "bun run --cwd apps/desktop test src/desktopMigrationRecovery.test.ts src/desktopStorageMigration.test.ts src/windowState.test.ts src/updateState.test.ts",
  "bun run --cwd scripts test check-brand-identity.test.ts verify-packaged-desktop-startup.test.ts lib/desktop-artifact-policy.test.ts lib/windows-authenticode.test.ts lib/windows-installer-qualification.test.ts lib/release-artifact-provenance.test.ts lib/super-synara-release-admission.test.ts lib/super-synara-workflow-contract.test.ts",
  "node scripts/verify-workflow-contracts.ts",
] as const;
const CI_WINDOWS_POST_BUILD_COMMAND = "bun run --cwd apps/desktop smoke-test";
const CI_MACOS_REQUIRED_COMMANDS = [
  'test "$(uname -m)" = arm64',
  "bun run brand:check",
  "node scripts/node-pty-smoke.mjs",
  "bun run --cwd apps/desktop test",
] as const;

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
  readonly index: number;
  readonly rawCommand: string;
}

function executableShellLines(command: string): readonly string[] {
  return command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function invokesRootTest(command: string): boolean {
  return executableShellLines(command).some((line) =>
    /(?:^|(?:&&|\|\||;)\s*)bun run test(?=$|\s|&&|\|\||;)/.test(line),
  );
}

function invokesDesktopSmokeTurboWrapper(command: string): boolean {
  return executableShellLines(command).some((line) =>
    /(?:^|[\s"'&|;()])test:desktop-smoke(?=$|[\s"'&|;()])/.test(line),
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
        index,
        rawCommand: step.run,
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
  const buildSteps = steps.filter((step) => step.command === "bun run build:desktop");
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
          index,
          rawCommand: step.run,
        },
      });
    }
  }
  const owned = occurrences.filter(({ jobName }) => jobName === ownerJobName);
  const bareOwned = owned.filter(({ step }) => step.command === "bun run test");
  if (bareOwned.length !== 1) {
    errors.push(`${workflowPath} ${ownerJobName} must run exactly one bare bun run test suite.`);
  } else if (
    bareOwned[0]!.step.condition !== undefined ||
    (bareOwned[0]!.step.continueOnError !== undefined &&
      bareOwned[0]!.step.continueOnError !== false)
  ) {
    errors.push(
      `${workflowPath} ${ownerJobName} bare bun run test must be unconditional and fail closed.`,
    );
  }
  for (const occurrence of occurrences) {
    if (occurrence.jobName !== ownerJobName || occurrence.step.command !== "bun run test") {
      errors.push(
        `${workflowPath} ${occurrence.jobName} must not own an additional or chained monorepo-wide bun run test suite.`,
      );
    }
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
  }
  if (macosSteps) {
    validateNativeJobCommands(
      workflowPath,
      "macos_arm64",
      macosSteps,
      CI_MACOS_REQUIRED_COMMANDS,
      errors,
    );
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
