// FILE: super-synara-workflow-contract.ts
// Purpose: Guards the manual unsigned prerelease and read-only macOS inventory workflows.
// Layer: Release workflow contract

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

type UnknownRecord = Record<string, unknown>;

const PRERELEASE_WINDOWS_REQUIRED_COMMANDS = [
  "bun run brand:check",
  "node apps/server/scripts/build-windows-job-launcher.mjs --arch x64",
  "bun run --cwd apps/server test src/provider/windowsProviderProcess.test.ts src/provider/windowsProviderProcess.windows.test.ts",
  "bun run --cwd packages/shared test src/desktopIdentity.test.ts src/desktopIdentityProof.test.ts src/windowsCertificate.test.ts",
  "bun run --cwd apps/desktop test src/backendShutdown.test.ts src/backendShutdown.windows.integration.test.ts",
  "bun run --cwd scripts test check-brand-identity.test.ts verify-packaged-desktop-startup.test.ts lib/desktop-artifact-policy.test.ts lib/windows-authenticode.test.ts lib/windows-installer-qualification.test.ts lib/release-artifact-provenance.test.ts lib/super-synara-release-admission.test.ts lib/super-synara-workflow-contract.test.ts",
  "node scripts/verify-workflow-contracts.ts",
] as const;
const PRERELEASE_MACOS_REQUIRED_COMMANDS = [
  "bun run brand:check",
  "bun run --cwd apps/desktop test",
  "bun run --cwd packages/shared test src/desktopIdentity.test.ts src/desktopIdentityProof.test.ts",
  "bun run --cwd scripts test lib/desktop-artifact-policy.test.ts verify-packaged-desktop-startup.test.ts lib/super-synara-macos-signatures.test.ts lib/release-artifact-provenance.test.ts lib/super-synara-release-admission.test.ts lib/super-synara-workflow-contract.test.ts",
] as const;
const WINDOWS_RELEASE_SCOPE = "windows-only";
const MACOS_RELEASE_SCOPE = "windows-and-macos";
const PREFLIGHT_ROUTE_TREE_SETUP_COMMAND = [
  "set -euo pipefail",
  `printf 'SYNARA_GENERATED_ROUTE_TREE=%s\\n' "$RUNNER_TEMP/super-synara-preflight-route-tree/routeTree.gen.ts" >> "$GITHUB_ENV"`,
].join("\n");
const MACOS_JOB_CONDITION = "${{ needs.preflight.outputs.include_macos == 'true' }}";
const PUBLISH_JOB_CONDITION =
  "${{ always() && needs.preflight.result == 'success' && needs.reserve_tag.result == 'success' && needs.windows_x64.result == 'success' && ((needs.preflight.outputs.include_macos == 'true' && needs.macos_arm64.result == 'success') || (needs.preflight.outputs.include_macos == 'false' && needs.macos_arm64.result == 'skipped')) }}";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeShellCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
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

function masksShellFailure(command: string): boolean {
  return executableShellLines(command).some(
    (line) =>
      /(?:\|\||;)\s*(?:true|:|exit\s+0)(?=\s*(?:[;#]|$))/.test(line) ||
      /(?:^|(?:&&|\|\||;)\s*)exit\s+0(?=\s*(?:[;#]|$))/.test(line),
  );
}

interface WorkflowRunStep {
  readonly command: string;
  readonly continueOnError: unknown;
  readonly condition: unknown;
  readonly index: number;
  readonly rawCommand: string;
}

function publicationWorkflow(workflowText: string): UnknownRecord {
  const workflow = parseYaml(workflowText, {
    strict: true,
    uniqueKeys: true,
  }) as unknown;
  if (!isRecord(workflow)) throw new Error("Publication workflow must be an object.");
  return workflow;
}

function publicationJobs(workflowText: string): UnknownRecord {
  const workflow = publicationWorkflow(workflowText);
  if (!isRecord(workflow.jobs)) throw new Error("Publication workflow must define jobs.");
  return workflow.jobs;
}

function publicationJob(jobs: UnknownRecord, jobName: string): UnknownRecord {
  const job = jobs[jobName];
  if (!isRecord(job) || !Array.isArray(job.steps)) {
    throw new Error(`Publication workflow must define the ${jobName} job with steps.`);
  }
  return job;
}

function verifyReleaseScopeCase(preflightJob: UnknownRecord): void {
  const steps = preflightJob.steps;
  if (!Array.isArray(steps)) {
    throw new Error("Publication workflow must define preflight steps.");
  }
  const metadataSteps = steps.filter(
    (step) => isRecord(step) && step.id === "meta" && typeof step.run === "string",
  );
  if (metadataSteps.length !== 1) {
    throw new Error("Publication release-scope contract must define exactly one metadata step.");
  }

  const lines = executableShellLines(metadataSteps[0]!.run as string);
  const caseStarts = lines
    .map((line, index) => (line === 'case "$RELEASE_SCOPE" in' ? index : -1))
    .filter((index) => index >= 0);
  if (caseStarts.length !== 1) {
    throw new Error("Publication release-scope contract must define exactly one scope case.");
  }
  const caseStart = caseStarts[0]!;
  const caseEnd = lines.indexOf("esac", caseStart + 1);
  if (caseEnd < 0) {
    throw new Error("Publication release-scope contract must terminate its scope case.");
  }
  const expectedPrefix = [
    "set -euo pipefail",
    '[[ "$CONFIRMED" == "true" ]]',
    '[[ "$REF_PROTECTED" == "true" ]]',
    '[[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+-super\\.[1-9][0-9]*$ ]]',
    '[[ "$TAG" == "super-v$VERSION" ]]',
  ];
  const expectedOutputs = [
    'echo "version=$VERSION" >> "$GITHUB_OUTPUT"',
    'echo "tag=$TAG" >> "$GITHUB_OUTPUT"',
    'echo "release_scope=$RELEASE_SCOPE" >> "$GITHUB_OUTPUT"',
    'echo "include_macos=$include_macos" >> "$GITHUB_OUTPUT"',
    'echo "asset_count=$asset_count" >> "$GITHUB_OUTPUT"',
  ];
  if (
    JSON.stringify(lines.slice(0, caseStart)) !== JSON.stringify(expectedPrefix) ||
    JSON.stringify(lines.slice(caseEnd + 1)) !== JSON.stringify(expectedOutputs)
  ) {
    throw new Error(
      "Publication release-scope contract must preserve the complete scope metadata data flow.",
    );
  }

  const arms = new Map<string, readonly string[]>();
  let index = caseStart + 1;
  while (index < caseEnd) {
    const armMatch = /^([*a-z0-9-]+)\)$/.exec(lines[index]!);
    if (!armMatch) {
      throw new Error("Publication release-scope contract contains an invalid scope case arm.");
    }
    const arm = armMatch[1]!;
    if (arms.has(arm)) {
      throw new Error(`Publication release-scope contract duplicates the ${arm} case arm.`);
    }
    const commands: string[] = [];
    index += 1;
    while (index < caseEnd && lines[index] !== ";;") {
      commands.push(lines[index]!);
      index += 1;
    }
    if (index >= caseEnd) {
      throw new Error(`Publication release-scope contract does not terminate the ${arm} case arm.`);
    }
    arms.set(arm, commands);
    index += 1;
  }

  const expectedArms = new Map<string, readonly string[]>([
    [WINDOWS_RELEASE_SCOPE, ["include_macos=false", "asset_count=6"]],
    [MACOS_RELEASE_SCOPE, ["include_macos=true", "asset_count=8"]],
    ["*", ['echo "Unsupported release scope: $RELEASE_SCOPE" >&2', "exit 1"]],
  ]);
  if (JSON.stringify([...arms.keys()]) !== JSON.stringify([...expectedArms.keys()])) {
    throw new Error(
      "Publication release-scope case must define the exact ordered windows-only, windows-and-macos, and rejecting wildcard arms.",
    );
  }
  for (const [scope, expectedCommands] of expectedArms) {
    if (JSON.stringify(arms.get(scope)) !== JSON.stringify(expectedCommands)) {
      throw new Error(
        `Publication release-scope case must map ${scope} to ${expectedCommands.join(" and ")}.`,
      );
    }
  }
}

function nativeJobRunSteps(jobs: UnknownRecord, jobName: string): readonly WorkflowRunStep[] {
  const job = publicationJob(jobs, jobName);
  const steps = job.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`Publication workflow must define the ${jobName} job with steps.`);
  }
  return steps
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

function hasExecutableLine(command: string, expectedStart: string): boolean {
  return executableShellLines(command).some(
    (line) => line === expectedStart || line.startsWith(`${expectedStart} `),
  );
}

function verifyRootTestOwnership(jobs: UnknownRecord): void {
  const occurrences: Array<{
    readonly jobName: string;
    readonly step: WorkflowRunStep;
  }> = [];
  for (const jobName of Object.keys(jobs)) {
    const job = jobs[jobName];
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of nativeJobRunSteps(jobs, jobName)) {
      if (invokesRootTest(step.rawCommand)) occurrences.push({ jobName, step });
    }
  }
  const preflight = occurrences.filter(({ jobName }) => jobName === "preflight");
  const barePreflight = preflight.filter(({ step }) => step.command === "bun run test");
  if (barePreflight.length !== 1) {
    throw new Error("Publication workflow preflight must run exactly one bare bun run test suite.");
  }
  const [preflightSuite] = barePreflight;
  if (
    preflightSuite!.step.condition !== undefined ||
    (preflightSuite!.step.continueOnError !== undefined &&
      preflightSuite!.step.continueOnError !== false)
  ) {
    throw new Error(
      "Publication workflow preflight bare bun run test must be unconditional and fail closed.",
    );
  }
  const additionalInvocation = occurrences.find(
    ({ jobName, step }) => jobName !== "preflight" || step.command !== "bun run test",
  );
  if (additionalInvocation) {
    throw new Error(
      `Publication workflow ${additionalInvocation.jobName} must not own an additional or chained monorepo-wide bun run test suite.`,
    );
  }
}

function verifyPreflightSourceCleanliness(jobs: UnknownRecord): void {
  const preflightJob = publicationJob(jobs, "preflight");
  const preflightSteps = preflightJob.steps;
  if (!Array.isArray(preflightSteps)) {
    throw new Error("Publication workflow must define the preflight job with steps.");
  }
  const steps = nativeJobRunSteps(jobs, "preflight");
  const installSteps = steps.filter((step) => step.command === "bun install --frozen-lockfile");
  const releaseSmokeSteps = steps.filter((step) => step.command === "bun run release:smoke");
  const cleanlinessSteps = steps.filter(
    (step) => step.command === "node scripts/verify-release-worktree-clean.ts",
  );
  if (
    installSteps.length !== 1 ||
    releaseSmokeSteps.length !== 1 ||
    cleanlinessSteps.length !== 2
  ) {
    throw new Error(
      "Publication workflow preflight must verify source cleanliness after install and after all preflight execution.",
    );
  }
  const [installStep] = installSteps;
  const [releaseSmokeStep] = releaseSmokeSteps;
  const [afterInstall, afterExecution] = cleanlinessSteps;
  if (
    !installStep ||
    !releaseSmokeStep ||
    !afterInstall ||
    !afterExecution ||
    afterInstall.index <= installStep.index ||
    afterInstall.index >= releaseSmokeStep.index ||
    afterExecution.index <= releaseSmokeStep.index ||
    afterExecution.index !== preflightSteps.length - 1 ||
    [installStep, releaseSmokeStep, ...cleanlinessSteps].some(
      (step) =>
        step.condition !== undefined ||
        (step.continueOnError !== undefined && step.continueOnError !== false),
    )
  ) {
    throw new Error(
      "Publication workflow preflight install, release smoke, and source-cleanliness checks must be ordered and fail closed.",
    );
  }
}

function verifyPreflightRouteTreeIsolation(preflightJob: UnknownRecord): void {
  const environment = preflightJob.env;
  if (
    isRecord(environment) &&
    Object.keys(environment).some((key) => key.toUpperCase() === "SYNARA_GENERATED_ROUTE_TREE")
  ) {
    throw new Error(
      "Publication workflow preflight must set the isolated route-tree path at runner execution time.",
    );
  }
  const steps = preflightJob.steps as ReadonlyArray<unknown>;
  const setupSteps = steps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => isRecord(step) && step.name === "Isolate generated route tree");
  if (setupSteps.length !== 1) {
    throw new Error(
      "Publication workflow preflight must redirect route generation outside tracked source.",
    );
  }
  const [setupEntry] = setupSteps;
  const setupStep = setupEntry!.step;
  if (
    !isRecord(setupStep) ||
    setupStep.shell !== "bash" ||
    typeof setupStep.run !== "string" ||
    normalizeShellCommand(setupStep.run) !==
      normalizeShellCommand(PREFLIGHT_ROUTE_TREE_SETUP_COMMAND) ||
    setupStep.if !== undefined ||
    (setupStep["continue-on-error"] !== undefined && setupStep["continue-on-error"] !== false)
  ) {
    throw new Error(
      "Publication workflow preflight must redirect route generation outside tracked source.",
    );
  }
  const installIndex = steps.findIndex(
    (step) => isRecord(step) && step.run === "bun install --frozen-lockfile",
  );
  if (installIndex < 0 || setupEntry!.index >= installIndex) {
    throw new Error(
      "Publication workflow preflight must establish route-tree isolation before dependency install.",
    );
  }
  for (const [index, step] of steps.entries()) {
    if (!isRecord(step)) continue;
    if (
      isRecord(step.env) &&
      Object.keys(step.env).some((key) => key.toUpperCase() === "SYNARA_GENERATED_ROUTE_TREE")
    ) {
      throw new Error(
        "Publication workflow preflight steps must not override the isolated route-tree path.",
      );
    }
    if (
      index !== setupEntry!.index &&
      typeof step.run === "string" &&
      step.run.includes("SYNARA_GENERATED_ROUTE_TREE")
    ) {
      throw new Error(
        "Publication workflow preflight steps must not override the isolated route-tree path.",
      );
    }
  }
}

function verifyNativeJobCommands(
  job: UnknownRecord,
  jobName: string,
  expectedRunner: string,
  steps: readonly WorkflowRunStep[],
  requiredCommands: readonly string[],
  buildCommandStart: string,
  expectedJobCondition?: string,
): void {
  if (job["runs-on"] !== expectedRunner) {
    throw new Error(`Publication workflow ${jobName} must run on ${expectedRunner}.`);
  }
  if (job.if !== expectedJobCondition) {
    throw new Error(
      expectedJobCondition === undefined
        ? `Publication workflow ${jobName} job must be unconditional and fail closed.`
        : `Publication workflow ${jobName} job must use the exact release-scope condition.`,
    );
  }
  if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false) {
    throw new Error(`Publication workflow ${jobName} job must fail closed.`);
  }
  const buildSteps = steps.filter((step) => hasExecutableLine(step.rawCommand, buildCommandStart));
  if (buildSteps.length !== 1) {
    throw new Error(
      `Publication workflow ${jobName} must execute exactly one native build command starting with ${buildCommandStart}.`,
    );
  }
  const [buildStep] = buildSteps;
  if (
    buildStep!.condition !== undefined ||
    (buildStep!.continueOnError !== undefined && buildStep!.continueOnError !== false)
  ) {
    throw new Error(
      `Publication workflow ${jobName} native build must be unconditional and fail closed.`,
    );
  }
  if (masksShellFailure(buildStep!.rawCommand)) {
    throw new Error(`Publication workflow ${jobName} native build must not mask shell failures.`);
  }
  for (const command of requiredCommands) {
    const matches = steps.filter((step) => step.command === command);
    if (matches.length !== 1) {
      throw new Error(
        `Publication workflow ${jobName} must run exact native gate command: ${command}.`,
      );
    }
    const [step] = matches;
    if (
      step!.condition !== undefined ||
      (step!.continueOnError !== undefined && step!.continueOnError !== false)
    ) {
      throw new Error(
        `Publication workflow ${jobName} native gate must be unconditional and fail closed: ${command}.`,
      );
    }
    if (step!.index >= buildStep!.index) {
      throw new Error(
        `Publication workflow ${jobName} native gate must run before the native build: ${command}.`,
      );
    }
  }
  if (steps.some((step) => invokesRootTest(step.rawCommand))) {
    throw new Error(
      `Publication workflow ${jobName} must not run the monorepo-wide bun run test suite.`,
    );
  }
}

function requireText(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) throw new Error(message);
}

function prohibitText(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) throw new Error(message);
}

function continuedShellCommands(workflow: string, commandNeedle: string): ReadonlyArray<string> {
  const lines = workflow.split("\n");
  const commands: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.includes(commandNeedle)) continue;
    const commandLines = [lines[index]!.trim()];
    while (commandLines.at(-1)?.endsWith("\\")) {
      index += 1;
      if (index >= lines.length) break;
      commandLines.push(lines[index]!.trim());
    }
    commands.push(commandLines.join("\n"));
  }
  return commands;
}

function requirePinnedActions(workflow: string, label: string): void {
  const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]!);
  if (uses.length === 0) throw new Error(`${label} must use explicitly pinned actions.`);
  for (const action of uses) {
    if (!/^[^@\s]+@[0-9a-f]{40}$/.test(action)) {
      throw new Error(`${label} action is not pinned to a full commit: ${action}.`);
    }
  }
}

export function verifySuperSynaraWorkflowText(main: string, audit: string): void {
  main = main.replaceAll("\r\n", "\n");
  audit = audit.replaceAll("\r\n", "\n");
  for (const [label, workflow] of [
    ["Publication workflow", main],
    ["Audit workflow", audit],
  ] as const) {
    requireText(workflow, "workflow_dispatch:", `${label} must be manual-only.`);
    prohibitText(workflow, "\n  push:", `${label} must not have a push trigger.`);
    prohibitText(workflow, "pull_request:", `${label} must not have a pull-request trigger.`);
    requireText(workflow, "cancel-in-progress: false", `${label} must serialize reruns.`);
    requirePinnedActions(workflow, label);
    prohibitText(workflow, "secrets.", `${label} must not consume signing or publication secrets.`);
    prohibitText(workflow, "id-token:", `${label} must not request identity-token permission.`);
  }

  for (const job of ["preflight", "reserve_tag", "windows_x64", "macos_arm64", "publish"]) {
    requireText(main, `\n  ${job}:`, `Publication workflow is missing the ${job} job.`);
  }
  const jobs = publicationJobs(main);
  const workflow = publicationWorkflow(main);
  const triggers = workflow.on;
  const dispatch = isRecord(triggers) ? triggers.workflow_dispatch : undefined;
  const inputs = isRecord(dispatch) ? dispatch.inputs : undefined;
  const releaseScopeInput = isRecord(inputs) ? inputs.release_scope : undefined;
  if (
    !isRecord(releaseScopeInput) ||
    releaseScopeInput.type !== "choice" ||
    releaseScopeInput.required !== true ||
    releaseScopeInput.default !== WINDOWS_RELEASE_SCOPE ||
    JSON.stringify(releaseScopeInput.options) !==
      JSON.stringify([WINDOWS_RELEASE_SCOPE, MACOS_RELEASE_SCOPE])
  ) {
    throw new Error("Publication release-scope contract must default to exact Windows x64.");
  }
  verifyRootTestOwnership(jobs);
  verifyPreflightSourceCleanliness(jobs);
  const preflightJob = publicationJob(jobs, "preflight");
  verifyPreflightRouteTreeIsolation(preflightJob);
  if (preflightJob["runs-on"] !== "ubuntu-24.04") {
    throw new Error("Publication workflow preflight must run on ubuntu-24.04.");
  }
  if (
    preflightJob.if !== undefined ||
    (preflightJob["continue-on-error"] !== undefined && preflightJob["continue-on-error"] !== false)
  ) {
    throw new Error("Publication workflow preflight job must be unconditional and fail closed.");
  }
  const windowsJob = publicationJob(jobs, "windows_x64");
  const macosJob = publicationJob(jobs, "macos_arm64");
  const publishJob = publicationJob(jobs, "publish");
  verifyNativeJobCommands(
    windowsJob,
    "windows_x64",
    "windows-2022",
    nativeJobRunSteps(jobs, "windows_x64"),
    PRERELEASE_WINDOWS_REQUIRED_COMMANDS,
    "bun run dist:desktop:super:win --",
  );
  verifyNativeJobCommands(
    macosJob,
    "macos_arm64",
    "macos-15",
    nativeJobRunSteps(jobs, "macos_arm64"),
    PRERELEASE_MACOS_REQUIRED_COMMANDS,
    "bun run dist:desktop:super:mac --",
    MACOS_JOB_CONDITION,
  );
  if (
    typeof publishJob.if !== "string" ||
    normalizeShellCommand(publishJob.if) !== PUBLISH_JOB_CONDITION
  ) {
    throw new Error(
      "Publication workflow publish job must fail closed over the exact selected native lanes.",
    );
  }
  if (publishJob["continue-on-error"] !== undefined && publishJob["continue-on-error"] !== false) {
    throw new Error("Publication workflow publish job must fail closed.");
  }
  const publishSteps = publishJob.steps;
  if (!Array.isArray(publishSteps)) {
    throw new Error("Publication workflow must define publish steps.");
  }
  const draftStep = publishSteps.find(
    (step) => isRecord(step) && step.name === "Create owned draft prerelease",
  );
  if (!isRecord(draftStep) || typeof draftStep.run !== "string") {
    throw new Error("Publication workflow must define the owned draft creation step.");
  }
  const draftCommands = continuedShellCommands(draftStep.run, "gh api");
  if (draftCommands.some((command) => command.includes("--slurp") && command.includes("--jq"))) {
    throw new Error(
      "Publication draft lookup must not combine the incompatible gh api --slurp and --jq flags.",
    );
  }
  const releaseQueryCommands = draftCommands.filter((command) =>
    command.includes('"repos/$GITHUB_REPOSITORY/releases?per_page=100"'),
  );
  if (
    releaseQueryCommands.length !== 1 ||
    !releaseQueryCommands[0]!.includes("gh api --paginate --slurp")
  ) {
    throw new Error(
      "Publication draft lookup must capture the complete paginated release response.",
    );
  }
  const draftFilterCommands = continuedShellCommands(draftStep.run, "jq -er");
  if (
    draftFilterCommands.length !== 1 ||
    !draftFilterCommands[0]!.includes('--arg tag "$TAG"') ||
    !draftFilterCommands[0]!.includes('--arg source_commit "$SOURCE_COMMIT"') ||
    !draftFilterCommands[0]!.includes('<<< "$releases_json"') ||
    !draftFilterCommands[0]!.includes(
      'elif length == 0 then empty else error("multiple owned drafts") end',
    )
  ) {
    throw new Error(
      "Publication draft lookup must filter the captured response with standalone jq arguments.",
    );
  }
  const draftCreateIndex = draftStep.run.indexOf('gh release create "$TAG"');
  const draftRetryIndex = draftStep.run.indexOf("for attempt in {1..30}; do");
  const draftQueryIndex = draftStep.run.indexOf("gh api --paginate --slurp", draftRetryIndex);
  const draftFilterIndex = draftStep.run.indexOf("jq -er", draftQueryIndex);
  const draftRetryEndIndex = draftStep.run.indexOf("\ndone\n", draftFilterIndex);
  const draftRetryBody = draftStep.run.slice(draftRetryIndex, draftRetryEndIndex);
  const draftQueryStatusIndex = draftRetryBody.indexOf("query_status=$?");
  const draftQueryFailureIndex = draftRetryBody.indexOf(
    'if [[ "$query_status" -ne 4 ]]; then',
    draftQueryStatusIndex,
  );
  const draftQueryExitIndex = draftRetryBody.indexOf(
    'exit "$query_status"',
    draftQueryFailureIndex,
  );
  const draftRetrySleepIndex = draftRetryBody.indexOf("sleep 1", draftQueryExitIndex);
  const draftFailClosedRetrySequence = [
    "  else",
    "    query_status=$?",
    '    if [[ "$query_status" -ne 4 ]]; then',
    '      exit "$query_status"',
    "    fi",
    "  fi",
    '  echo "Draft not yet visible (attempt $attempt/30); retrying." >&2',
    "  sleep 1",
  ].join("\n");
  const draftIdCheckIndex = draftStep.run.indexOf(
    '[[ "$draft_id" =~ ^[1-9][0-9]*$ ]]',
    draftRetryEndIndex,
  );
  if (
    draftCreateIndex < 0 ||
    draftRetryIndex <= draftCreateIndex ||
    draftQueryIndex <= draftRetryIndex ||
    draftFilterIndex <= draftQueryIndex ||
    draftRetryEndIndex <= draftFilterIndex ||
    draftIdCheckIndex <= draftRetryEndIndex ||
    draftQueryStatusIndex < 0 ||
    draftQueryFailureIndex <= draftQueryStatusIndex ||
    draftQueryExitIndex <= draftQueryFailureIndex ||
    draftRetrySleepIndex <= draftQueryExitIndex ||
    !draftRetryBody.includes(draftFailClosedRetrySequence)
  ) {
    throw new Error(
      "Publication draft lookup must poll boundedly for GitHub release-list visibility and fail closed on query errors.",
    );
  }
  const macosDownloadStep = publishSteps.find(
    (step) => isRecord(step) && step.name === "Download macOS lane",
  );
  if (!isRecord(macosDownloadStep) || macosDownloadStep.if !== MACOS_JOB_CONDITION) {
    throw new Error(
      "Publication workflow must download macOS only for the combined release scope.",
    );
  }
  const macosBuildStep = nativeJobRunSteps(jobs, "macos_arm64").find((step) =>
    hasExecutableLine(step.rawCommand, "bun run dist:desktop:super:mac --"),
  );
  if (
    !macosBuildStep ||
    !hasExecutableLine(macosBuildStep.rawCommand, 'test "$(uname -m)" = arm64')
  ) {
    throw new Error(
      "macOS publication must prove arm64 host architecture in the native build step.",
    );
  }
  requireText(
    main,
    "environment: super-synara-prerelease",
    "Publication must use the protected Super Synara environment.",
  );
  requireText(
    main,
    "confirm_unsigned:",
    "Unsigned public publication must require an explicit confirmation input.",
  );
  prohibitText(
    main,
    "confirm_unsigned_publication:",
    "Publication must use the plan-locked confirmation input name.",
  );
  requireText(main, "\n      tag:\n", "Publication dispatch must require an explicit tag input.");
  for (const scopeNeedle of [
    "release_scope:",
    `default: ${WINDOWS_RELEASE_SCOPE}`,
    `- ${WINDOWS_RELEASE_SCOPE}`,
    `- ${MACOS_RELEASE_SCOPE}`,
  ]) {
    requireText(main, scopeNeedle, `Publication release-scope contract is missing ${scopeNeedle}.`);
  }
  requireText(
    main,
    '[[ "$TAG" == "super-v$VERSION" ]]',
    "Publication must fail unless the explicit tag matches the version.",
  );
  requireText(
    main,
    "group: super-synara-prerelease",
    "Publication must use the plan-locked concurrency group.",
  );
  requireText(
    main,
    "REF_PROTECTED: ${{ github.ref_protected }}",
    "Publication must bind GitHub protected-ref state.",
  );
  requireText(
    main,
    '[[ "$REF_PROTECTED" == "true" ]]',
    "Publication must fail closed unless the dispatch ref is protected.",
  );
  requireText(
    main,
    "cd apps/web && ./node_modules/.bin/playwright install --with-deps chromium",
    "Browser preflight must use the workspace-local Playwright binary.",
  );
  requireText(
    main,
    'node scripts/validate-downstream-state.ts --github-output "$GITHUB_OUTPUT"',
    "Publication must consume the exact Phase 0 GitHub output interface.",
  );
  requireText(
    main,
    "absorbed_upstream_sha: ${{ steps.downstream.outputs.absorbed_upstream_sha }}",
    "Publication must bind the absorbed upstream SHA from Phase 0.",
  );
  requireText(
    main,
    "verify-super-synara-macos-allowlist.ts",
    "Preflight must reject a missing or placeholder macOS signature policy.",
  );
  requireText(
    main,
    "- name: Require reviewed macOS signature policy\n        if: ${{ steps.meta.outputs.include_macos == 'true' }}",
    "macOS signature policy must gate only the combined release scope.",
  );
  for (const variable of [
    "SUPER_SYNARA_MAX_WINDOWS_BYTES",
    "SUPER_SYNARA_MAX_MACOS_BYTES",
    "SUPER_SYNARA_MAX_TOTAL_BYTES",
  ]) {
    requireText(main, variable, `Publication must bind repository byte cap ${variable}.`);
  }
  for (const phase of [
    "preflight",
    "reserve-tag",
    "before-draft",
    "after-draft",
    "before-publish",
  ]) {
    requireText(main, `--phase ${phase}`, `Publication must validate GitHub state at ${phase}.`);
  }
  requireText(main, "SYNARA_DESKTOP_FLAVOR: super", "Native builds must select Super flavor.");
  requireText(
    main,
    'SYNARA_DESKTOP_DISABLE_UPDATES: "1"',
    "Native builds must disable the updater.",
  );
  requireText(
    main,
    "bun run dist:desktop:super:win --",
    "Windows publication must use the isolated Super packaging entry point.",
  );
  for (const qualificationNeedle of [
    "select-upstream-synara-release.ts",
    "--repo Emanuele-web04/synara",
    "select-previous-super-synara-release.ts",
    "steps.previous_release.outputs.found == 'true'",
    "qualify-super-synara-windows-installer.ts",
    '"--upstream-installer", $env:UPSTREAM_INSTALLER',
    '"--previous-installer", $env:PREVIOUS_INSTALLER',
    '"--report", (Join-Path $env:RUNNER_TEMP "windows-installer-qualification.json")',
    '--windows-qualification-report "$qualification_report"',
  ]) {
    requireText(
      main,
      qualificationNeedle,
      `Windows installer qualification contract is missing ${qualificationNeedle}.`,
    );
  }
  if ((main.match(/--current-version \$env:VERSION/g)?.length ?? 0) < 2) {
    throw new Error(
      "Windows qualification must bind both upstream-core and previous-release selection to the requested Super version.",
    );
  }
  const packagedStartupCommands = continuedShellCommands(
    main,
    "node scripts/verify-packaged-desktop-startup.ts",
  );
  if (packagedStartupCommands.length !== 2) {
    throw new Error("Publication must run exactly two packaged startup verifications.");
  }
  for (const command of packagedStartupCommands) {
    requireText(
      command,
      "--flavor super",
      "Packaged startup verification must select Super flavor.",
    );
  }
  const packagedStartupIndex = main.indexOf("verify-packaged-desktop-startup.ts");
  const installerQualificationIndex = main.indexOf("qualify-super-synara-windows-installer.ts");
  if (packagedStartupIndex < 0 || installerQualificationIndex <= packagedStartupIndex) {
    throw new Error(
      "Windows installer qualification must run after packaged startup verification.",
    );
  }
  const windowsProvenanceIndex = main.indexOf(
    "Write final Windows provenance from native qualification",
  );
  const windowsUploadIndex = main.indexOf("Upload exact Windows lane");
  if (
    windowsProvenanceIndex <= installerQualificationIndex ||
    windowsUploadIndex <= windowsProvenanceIndex
  ) {
    throw new Error(
      "Windows provenance must consume native qualification before the exact lane is uploaded.",
    );
  }
  const windowsUploadBlock = main.slice(
    windowsUploadIndex,
    main.indexOf("\n  macos_arm64:", windowsUploadIndex),
  );
  prohibitText(
    windowsUploadBlock,
    "windows-installer-qualification.json",
    "The transient Windows qualification report must not be uploaded.",
  );
  requireText(
    main,
    "bun run dist:desktop:super:mac --",
    "macOS publication must use the isolated Super packaging entry point.",
  );
  prohibitText(main, "--desktop-flavor", "Publication must not use the superseded flavor flag.");
  const mainCleanlinessChecks =
    main.match(/node scripts\/verify-release-worktree-clean\.ts/g)?.length ?? 0;
  if (mainCleanlinessChecks < 8) {
    throw new Error(
      "Publication must prove source cleanliness after installs, builds, and staging.",
    );
  }
  requireText(
    main,
    "verify-release-worktree-clean.ts release-build release-publish",
    "Native lanes must admit only their declared build and publication outputs.",
  );
  requireText(
    main,
    "verify-release-worktree-clean.ts release-stage release-redownload",
    "Publication must recheck source cleanliness after release staging.",
  );
  requireText(
    main,
    "collect-super-synara-macos-signatures.ts",
    "macOS publication must collect signature evidence.",
  );
  const admissionCommands = continuedShellCommands(
    main,
    "node scripts/collect-super-synara-macos-signatures.ts",
  );
  if (admissionCommands.length !== 1 || !admissionCommands[0]!.includes('--dmg "$disk_image"')) {
    throw new Error("macOS publication signature admission must inspect the exact final DMG.");
  }
  prohibitText(
    admissionCommands[0]!,
    "--zip",
    "macOS publication signature admission must not rely on ZIP-only evidence.",
  );
  requireText(main, "--mode admit", "macOS publication must use fail-closed admission mode.");
  requireText(
    main,
    "prepare-super-synara-release.ts prepare",
    "Publication must build the exact admitted release set.",
  );
  requireText(
    main,
    "prepare-super-synara-release.ts verify",
    "Publication must revalidate admitted bytes before making the draft public.",
  );
  const releaseAdmissionCommands = continuedShellCommands(
    main,
    "node scripts/prepare-super-synara-release.ts",
  );
  if (
    releaseAdmissionCommands.length !== 2 ||
    releaseAdmissionCommands.some(
      (command) =>
        !command.includes('--release-scope "$RELEASE_SCOPE"') ||
        !command.includes('"${macos_allowlist_args[@]}"'),
    )
  ) {
    throw new Error(
      "Final release preparation and revalidation must bind the selected scope and reviewed macOS signature allowlist.",
    );
  }
  const scopedAllowlistCondition = 'if [[ "$RELEASE_SCOPE" == "windows-and-macos" ]]; then';
  const scopedAllowlistPath =
    "--mac-signature-allowlist scripts/super-synara-macos-signature-allowlist.json";
  if (
    (main.match(/macos_allowlist_args=\(\)/g)?.length ?? 0) !== 2 ||
    (main.match(/macos_allowlist_args=\(/g)?.length ?? 0) !== 4 ||
    main.split(scopedAllowlistCondition).length - 1 !== 3 ||
    main.split(scopedAllowlistPath).length - 1 !== 3
  ) {
    throw new Error(
      "Final release admission must pass the reviewed macOS allowlist only for the combined scope.",
    );
  }
  requireText(
    main,
    '[[ "${#assets[@]}" -eq "$EXPECTED_ASSET_COUNT" ]]',
    "Publication must upload the exact scoped asset count.",
  );
  requireText(
    main,
    '[[ "$(jq \'[.[][]] | length\' <<< "$assets_json")" -eq "$EXPECTED_ASSET_COUNT" ]]',
    "Publication must redownload the exact scoped asset count.",
  );
  requireText(
    main,
    'if [[ "$INCLUDE_MACOS" == "true" ]]; then',
    "Publication must add macOS assets only for the combined scope.",
  );
  for (const asset of [
    "windows-x64-unsigned.exe",
    "macos-arm64-unsigned.dmg",
    "artifact-windows-x64.provenance.json",
    "artifact-macos-arm64.provenance.json",
    "release-index.json",
    "SHA256SUMS.txt",
    "UNSIGNED-BUILD.md",
    "LICENSE",
  ]) {
    requireText(main, asset, `Publication contract is missing ${asset}.`);
  }
  requireText(main, "gh release create", "Publication must start from an owned GitHub draft.");
  requireText(
    main,
    '--title "Unofficial downstream Super Synara $VERSION (unsigned prerelease)"',
    "Release title must prominently identify the unofficial downstream and unsigned prerelease.",
  );
  requireText(main, "gh release upload", "Publication must upload to the owned draft.");
  requireText(main, "cmp ", "Publication must compare redownloaded bytes exactly.");
  requireText(main, "make_latest=false", "Unsigned prerelease must not become GitHub Latest.");
  prohibitText(
    main,
    "gh release delete",
    "Failure handling must never delete a draft automatically.",
  );
  prohibitText(main, "--clobber", "Draft assets must never be silently overwritten on rerun.");
  for (const prohibitedAsset of [".blockmap", "latest.yml", "latest-mac.yml", ".AppImage"]) {
    prohibitText(main, prohibitedAsset, `Publication must not expose ${prohibitedAsset}.`);
  }

  verifyReleaseScopeCase(preflightJob);

  requireText(audit, "permissions:\n  contents: read", "Audit must be read-only.");
  requireText(
    audit,
    "REF_PROTECTED: ${{ github.ref_protected }}",
    "Audit must bind GitHub protected-ref state.",
  );
  requireText(
    audit,
    '[[ "$REF_PROTECTED" == "true" ]]',
    "Audit must fail closed unless the dispatch ref is protected.",
  );
  requireText(audit, 'test "$(uname -m)" = arm64', "Audit must prove arm64 host architecture.");
  prohibitText(audit, "contents: write", "Audit must not receive write permission.");
  for (const auditSourceNeedle of [
    "REF_SHA: ${{ github.sha }}",
    '[[ "$SOURCE_SHA" == "$REF_SHA" ]]',
    'CORE_VERSION="${BASH_REMATCH[1]}"',
    '"v$CORE_VERSION"',
    "build-only",
  ]) {
    requireText(audit, auditSourceNeedle, `Audit source contract is missing ${auditSourceNeedle}.`);
  }
  requireText(audit, "--mode audit", "Audit must emit unclassified inventory evidence.");
  const auditCleanlinessChecks =
    audit.match(/node scripts\/verify-release-worktree-clean\.ts/g)?.length ?? 0;
  if (auditCleanlinessChecks < 2) {
    throw new Error("Audit must prove source cleanliness after install and inventory generation.");
  }
  requireText(
    audit,
    "bun run dist:desktop:super:mac --",
    "Audit must use the isolated Super packaging entry point.",
  );
  const auditCommands = continuedShellCommands(
    audit,
    "node scripts/collect-super-synara-macos-signatures.ts",
  );
  if (auditCommands.length !== 1 || !auditCommands[0]!.includes("--dmg")) {
    throw new Error("macOS signature audit must inspect the built DMG directly.");
  }
  prohibitText(auditCommands[0]!, "--zip", "macOS signature audit must not rely on ZIP evidence.");
  prohibitText(audit, "--desktop-flavor", "Audit must not use the superseded flavor flag.");
  prohibitText(audit, "--allowlist", "Audit must not classify objects with an allowlist.");
  requireText(audit, "retention-days: 1", "Audit inventory retention must be one day.");
  prohibitText(audit, "gh release", "Audit must not create or mutate releases.");
  prohibitText(audit, "git tag", "Audit must not reserve tags.");
  prohibitText(audit, "git push", "Audit must not mutate repository refs.");
}

export function verifySuperSynaraWorkflowContracts(repoRoot: string): void {
  verifySuperSynaraWorkflowText(
    readFileSync(resolve(repoRoot, ".github/workflows/super-synara-prerelease.yml"), "utf8"),
    readFileSync(
      resolve(repoRoot, ".github/workflows/super-synara-macos-signature-audit.yml"),
      "utf8",
    ),
  );
}
