// FILE: super-synara-workflow-contract.ts
// Purpose: Guards the manual unsigned prerelease and read-only macOS inventory workflows.
// Layer: Release workflow contract

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

type UnknownRecord = Record<string, unknown>;

const PRERELEASE_WINDOWS_REQUIRED_COMMANDS = [
  "bun run brand:check",
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
  "${{ always() && needs.draft_admission.result == 'success' && needs.preflight.result == 'success' && needs.windows_x64.result == 'success' && ((needs.preflight.outputs.include_macos == 'true' && needs.macos_arm64.result == 'success') || (needs.preflight.outputs.include_macos == 'false' && needs.macos_arm64.result == 'skipped')) }}";
const CHECKOUT_ACTION = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const SETUP_NODE_ACTION = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const PLANNED_SOURCE_PROOF_COMMAND = [
  "node scripts/verify-release-source-provenance.ts \\",
  '"$VERSION" "$TAG" true "$SOURCE_COMMIT" branch main \\',
  "github-unsigned-prerelease false",
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function hasExactEntries(
  value: unknown,
  expected: Readonly<UnknownRecord>,
): value is UnknownRecord {
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function normalizeShellCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function normalizeContinuedShellCommand(command: string): string {
  return normalizeShellCommand(command.replace(/\\\r?\n/g, " "));
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

function publicationJob(
  jobs: UnknownRecord,
  jobName: string,
): UnknownRecord & { steps: unknown[] } {
  const job = jobs[jobName];
  if (!isRecord(job) || !Array.isArray(job.steps)) {
    throw new Error(`Publication workflow must define the ${jobName} job with steps.`);
  }
  return job as UnknownRecord & { steps: unknown[] };
}

const PRERELEASE_SOURCE_PROVENANCE_COMMAND =
  'node scripts/verify-release-source-provenance.ts "$VERSION" "$TAG" true "$SOURCE_COMMIT" branch main github-unsigned-prerelease false';

function verifyPrereleaseSourceProvenanceSteps(jobs: UnknownRecord): void {
  for (const [jobName, stepName, expectedEnvironment] of [
    [
      "preflight",
      "Validate source provenance",
      {
        VERSION: "${{ steps.meta.outputs.version }}",
        TAG: "${{ steps.meta.outputs.tag }}",
        SOURCE_COMMIT: "${{ inputs.expected_source_sha }}",
      },
    ],
    [
      "windows_x64",
      "Revalidate protected-main source provenance",
      {
        VERSION: "${{ needs.preflight.outputs.version }}",
        TAG: "${{ needs.preflight.outputs.tag }}",
        SOURCE_COMMIT: "${{ needs.preflight.outputs.source_commit }}",
      },
    ],
    [
      "macos_arm64",
      "Revalidate protected-main source provenance",
      {
        VERSION: "${{ needs.preflight.outputs.version }}",
        TAG: "${{ needs.preflight.outputs.tag }}",
        SOURCE_COMMIT: "${{ needs.preflight.outputs.source_commit }}",
      },
    ],
  ] as const) {
    const job = publicationJob(jobs, jobName);
    const steps = job.steps;
    const matches = steps.filter(
      (step) => isRecord(step) && step.name === stepName && typeof step.run === "string",
    );
    const step = matches[0];
    if (
      matches.length !== 1 ||
      !isRecord(step) ||
      typeof step.run !== "string" ||
      step.shell !== "bash" ||
      !hasExactEntries(step.env, expectedEnvironment) ||
      normalizeContinuedShellCommand(step.run) !== PRERELEASE_SOURCE_PROVENANCE_COMMAND ||
      step.if !== undefined ||
      (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false)
    ) {
      throw new Error(
        "Publication source checks must revalidate the exact protected-main source without requiring the immutable tag before atomic publication.",
      );
    }
  }
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
    '[[ "$CALLER_WORKFLOW_REF" == "$GITHUB_REPOSITORY/.github/workflows/release-drafter.yml@refs/heads/main" ]]',
    '[[ "$CONFIRMED" == "true" ]]',
    '[[ "$REF_PROTECTED" == "true" ]]',
    '[[ "$EXPECTED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$WORKFLOW_SOURCE_SHA" == "$EXPECTED_SOURCE_SHA" ]]',
    '[[ "$RELEASE_DRAFT_ID" =~ ^[1-9][0-9]*$ ]]',
    'validation_actor="$EVENT_ACTOR"',
    'validation_triggering_actor="$EVENT_TRIGGERING_ACTOR"',
    '[[ -n "$validation_actor" ]]',
    '[[ -n "$validation_triggering_actor" ]]',
    '[[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+-super\\.[1-9][0-9]*$ ]]',
    '[[ "$TAG" == "super-v$VERSION" ]]',
  ];
  const expectedOutputs = [
    'echo "version=$VERSION" >> "$GITHUB_OUTPUT"',
    'echo "tag=$TAG" >> "$GITHUB_OUTPUT"',
    'echo "release_scope=$RELEASE_SCOPE" >> "$GITHUB_OUTPUT"',
    'echo "include_macos=$include_macos" >> "$GITHUB_OUTPUT"',
    'echo "asset_count=$asset_count" >> "$GITHUB_OUTPUT"',
    'echo "release_draft_id=$RELEASE_DRAFT_ID" >> "$GITHUB_OUTPUT"',
    'echo "validation_actor=$validation_actor" >> "$GITHUB_OUTPUT"',
    'echo "validation_triggering_actor=$validation_triggering_actor" >> "$GITHUB_OUTPUT"',
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

function verifyDraftAdmissionJob(jobs: UnknownRecord): void {
  const job = publicationJob(jobs, "draft_admission");
  const permissions = job.permissions;
  if (
    !hasExactKeys(job, ["name", "runs-on", "timeout-minutes", "permissions", "steps"]) ||
    job.name !== "Admit exact owned release draft" ||
    job["runs-on"] !== "ubuntu-24.04" ||
    job["timeout-minutes"] !== 5 ||
    !hasExactEntries(permissions, { contents: "write" })
  ) {
    throw new Error(
      "Publication draft admission must be an unconditional, minimal, write-scoped Ubuntu job.",
    );
  }

  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length !== 4 || steps.some((step) => !isRecord(step))) {
    throw new Error("Publication draft admission must contain exactly four minimal steps.");
  }
  const [authorization, checkout, setupNode, validation] = steps as ReadonlyArray<UnknownRecord>;
  if (
    !hasExactKeys(authorization!, ["name", "shell", "env", "run"]) ||
    authorization!.name !== "Authorize exact protected-main draft admission" ||
    authorization!.shell !== "bash" ||
    typeof authorization!.run !== "string" ||
    !hasExactKeys(checkout!, ["name", "uses", "with"]) ||
    checkout!.name !== "Checkout exact admitted source" ||
    checkout!.uses !== CHECKOUT_ACTION ||
    !hasExactKeys(setupNode!, ["name", "uses", "with"]) ||
    setupNode!.name !== "Setup Node" ||
    setupNode!.uses !== SETUP_NODE_ACTION ||
    !hasExactKeys(validation!, ["name", "shell", "env", "run"]) ||
    validation!.name !== "Validate exact owned draft visibility" ||
    validation!.shell !== "bash" ||
    typeof validation!.run !== "string"
  ) {
    throw new Error("Publication draft admission must retain its four exact bounded steps.");
  }

  if (
    !hasExactEntries(authorization!.env, {
      ACTOR: "${{ github.actor }}",
      CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
      DRAFT_ID: "${{ inputs.release_draft_id }}",
      EXPECTED_SOURCE_SHA: "${{ inputs.expected_source_sha }}",
      OWNER: "${{ github.repository_owner }}",
      REF_PROTECTED: "${{ github.ref_protected }}",
      TAG: "${{ inputs.tag }}",
      TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
      VERSION: "${{ inputs.version }}",
      WORKFLOW_SOURCE_SHA: "${{ github.sha }}",
    }) ||
    JSON.stringify(executableShellLines(authorization!.run as string)) !==
      JSON.stringify([
        "set -euo pipefail",
        '[[ "$CALLER_WORKFLOW_REF" == "$GITHUB_REPOSITORY/.github/workflows/release-drafter.yml@refs/heads/main" ]]',
        '[[ "$REF_PROTECTED" == "true" ]]',
        '[[ "$EXPECTED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]',
        '[[ "$WORKFLOW_SOURCE_SHA" == "$EXPECTED_SOURCE_SHA" ]]',
        '[[ "$ACTOR" == "$OWNER" ]]',
        '[[ "$TRIGGERING_ACTOR" == "$OWNER" ]]',
        '[[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+-super\\.[1-9][0-9]*$ ]]',
        '[[ "$TAG" == "super-v$VERSION" ]]',
        '[[ "$DRAFT_ID" =~ ^[1-9][0-9]*$ ]]',
      ])
  ) {
    throw new Error(
      "Publication draft admission must authenticate the exact protected-main owner controller before checkout.",
    );
  }

  const checkoutWith = checkout!.with;
  if (
    !hasExactEntries(checkoutWith, {
      ref: "${{ inputs.expected_source_sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    })
  ) {
    throw new Error("Publication draft admission must checkout only the authenticated source SHA.");
  }
  if (!hasExactEntries(setupNode!.with, { "node-version-file": "package.json" })) {
    throw new Error("Publication draft admission must pin the repository Node runtime.");
  }
  if (
    !hasExactEntries(validation!.env, {
      DRAFT_ID: "${{ inputs.release_draft_id }}",
      GH_TOKEN: "${{ github.token }}",
      SOURCE_COMMIT: "${{ inputs.expected_source_sha }}",
      TAG: "${{ inputs.tag }}",
      VALIDATION_ACTOR: "${{ github.actor }}",
      VALIDATION_TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
    }) ||
    JSON.stringify(executableShellLines(validation!.run as string)) !==
      JSON.stringify([
        "node scripts/verify-super-synara-github-state.ts \\",
        "--phase preflight \\",
        '--repository "$GITHUB_REPOSITORY" \\',
        '--ref-name "$GITHUB_REF_NAME" \\',
        '--actor "$VALIDATION_ACTOR" \\',
        '--triggering-actor "$VALIDATION_TRIGGERING_ACTOR" \\',
        '--owner "$GITHUB_REPOSITORY_OWNER" \\',
        '--tag "$TAG" \\',
        '--source-commit "$SOURCE_COMMIT" \\',
        '--current-run-draft-id "$DRAFT_ID"',
      ])
  ) {
    throw new Error(
      "Publication draft admission must validate the exact owned draft before native builds.",
    );
  }

  const validatorInvocations: Array<{
    readonly command: string;
    readonly jobName: string;
    readonly step: UnknownRecord;
  }> = [];
  for (const [jobName, candidateJob] of Object.entries(jobs)) {
    if (!isRecord(candidateJob) || !Array.isArray(candidateJob.steps)) continue;
    for (const candidateStep of candidateJob.steps) {
      if (!isRecord(candidateStep) || typeof candidateStep.run !== "string") continue;
      const command = executableShellLines(candidateStep.run).join(" ");
      if (!command.includes("verify-super-synara-github-state.ts")) continue;
      validatorInvocations.push({ command, jobName, step: candidateStep });
    }
  }
  const preflightValidators = validatorInvocations.filter(({ command }) =>
    /(?:^|\s)--phase(?:\s+\\?\s*|=)["']?preflight["']?(?=\s|[;&|)]|$)/.test(command),
  );
  if (
    preflightValidators.length !== 1 ||
    preflightValidators[0]!.jobName !== "draft_admission" ||
    preflightValidators[0]!.step !== validation
  ) {
    throw new Error(
      "Publication preflight-phase draft validation must run exactly once in draft admission.",
    );
  }
  if (validatorInvocations.some(({ jobName }) => jobName === "preflight")) {
    throw new Error(
      "Publication read-only preflight must not invoke the GitHub release-state validator.",
    );
  }
  if (
    validatorInvocations.some(
      ({ jobName }) => jobName !== "draft_admission" && jobName !== "publish",
    )
  ) {
    throw new Error(
      "Publication release-state validation must remain in the write-scoped admission or publish job.",
    );
  }
}

function verifyPublicationJobDependencies(jobs: UnknownRecord): void {
  for (const [jobName, expected] of [
    ["windows_x64", ["draft_admission", "preflight"]],
    ["macos_arm64", ["draft_admission", "preflight"]],
    ["publish", ["draft_admission", "preflight", "windows_x64", "macos_arm64"]],
  ] as const) {
    const job = publicationJob(jobs, jobName);
    if (JSON.stringify(job.needs) !== JSON.stringify(expected)) {
      throw new Error(
        `Publication workflow ${jobName} must depend on exact draft admission and its required predecessors.`,
      );
    }
  }
}

function verifyNativePlannedSource(job: UnknownRecord, jobName: string): number {
  const steps = job.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`Publication workflow ${jobName} must define native release steps.`);
  }
  const checkoutIndexes = steps.flatMap((step, index) =>
    isRecord(step) && step.name === "Checkout exact planned source" ? [index] : [],
  );
  const proofIndexes = steps.flatMap((step, index) =>
    isRecord(step) && step.name === "Revalidate protected-main source provenance" ? [index] : [],
  );
  if (checkoutIndexes.length !== 1 || proofIndexes.length !== 1) {
    throw new Error(
      `Publication workflow ${jobName} must validate the admitted draft's exact planned source without requiring a pre-publication tag.`,
    );
  }

  const checkoutIndex = checkoutIndexes[0]!;
  const proofIndex = proofIndexes[0]!;
  const checkout = steps[checkoutIndex];
  const proof = steps[proofIndex];
  if (
    !isRecord(checkout) ||
    !hasExactKeys(checkout, ["name", "uses", "with"]) ||
    checkout.uses !== CHECKOUT_ACTION ||
    !hasExactEntries(checkout.with, {
      ref: "${{ needs.preflight.outputs.source_commit }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    }) ||
    !isRecord(proof) ||
    !hasExactKeys(proof, ["name", "shell", "env", "run"]) ||
    proof.shell !== "bash" ||
    !hasExactEntries(proof.env, {
      VERSION: "${{ needs.preflight.outputs.version }}",
      TAG: "${{ needs.preflight.outputs.tag }}",
      SOURCE_COMMIT: "${{ needs.preflight.outputs.source_commit }}",
    }) ||
    typeof proof.run !== "string" ||
    JSON.stringify(executableShellLines(proof.run)) !==
      JSON.stringify(PLANNED_SOURCE_PROOF_COMMAND) ||
    masksShellFailure(proof.run) ||
    proofIndex <= checkoutIndex
  ) {
    throw new Error(
      `Publication workflow ${jobName} must validate the admitted draft's exact planned source without requiring a pre-publication tag.`,
    );
  }
  return proofIndex;
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
  const plannedSourceProofIndex = verifyNativePlannedSource(job, jobName);
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
  if (plannedSourceProofIndex >= buildStep!.index) {
    throw new Error(
      `Publication workflow ${jobName} must validate the admitted draft's exact planned source before the native build.`,
    );
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
    if (
      label === "Release Drafter scheduler" &&
      action === "./.github/workflows/super-synara-prerelease.yml"
    ) {
      continue;
    }
    if (!/^[^@\s]+@[0-9a-f]{40}$/.test(action)) {
      throw new Error(`${label} action is not pinned to a full commit: ${action}.`);
    }
  }
}

export function verifySuperSynaraWorkflowText(main: string, audit: string): void {
  main = main.replaceAll("\r\n", "\n");
  audit = audit.replaceAll("\r\n", "\n");
  const workflow = publicationWorkflow(main);
  const triggers = workflow.on;
  if (!isRecord(triggers) || JSON.stringify(Object.keys(triggers)) !== '["workflow_call"]') {
    throw new Error("Publication workflow must be callable only by its protected-main controller.");
  }
  prohibitText(
    main,
    "\nconcurrency:",
    "Called publication workflow must inherit controller serialization.",
  );
  requirePinnedActions(main, "Publication workflow");
  prohibitText(main, "secrets.", "Publication workflow must not consume signing secrets.");
  prohibitText(
    main,
    "id-token:",
    "Publication workflow must not request identity-token permission.",
  );

  requireText(audit, "workflow_dispatch:", "Audit workflow must be manual-only.");
  prohibitText(audit, "\n  push:", "Audit workflow must not have a push trigger.");
  prohibitText(audit, "pull_request:", "Audit workflow must not have a pull-request trigger.");
  requireText(audit, "cancel-in-progress: false", "Audit workflow must serialize reruns.");
  requirePinnedActions(audit, "Audit workflow");
  prohibitText(audit, "secrets.", "Audit workflow must not consume signing secrets.");
  prohibitText(audit, "id-token:", "Audit workflow must not request identity-token permission.");

  for (const job of ["draft_admission", "preflight", "windows_x64", "macos_arm64", "publish"]) {
    requireText(main, `\n  ${job}:`, `Publication workflow is missing the ${job} job.`);
  }
  const jobs = publicationJobs(main);
  const workflowCall = triggers.workflow_call;
  const inputs = isRecord(workflowCall) ? workflowCall.inputs : undefined;
  const releaseScopeInput = isRecord(inputs) ? inputs.release_scope : undefined;
  if (
    !isRecord(releaseScopeInput) ||
    releaseScopeInput.type !== "string" ||
    releaseScopeInput.required !== true ||
    releaseScopeInput.default !== WINDOWS_RELEASE_SCOPE
  ) {
    throw new Error("Publication release-scope contract must default to exact Windows x64.");
  }
  verifyRootTestOwnership(jobs);
  verifyDraftAdmissionJob(jobs);
  verifyPublicationJobDependencies(jobs);
  verifyPrereleaseSourceProvenanceSteps(jobs);
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
    (step) => isRecord(step) && step.name === "Adopt exact owned Release Drafter draft",
  );
  if (!isRecord(draftStep) || typeof draftStep.run !== "string") {
    throw new Error("Publication workflow must define the exact Release Drafter adoption step.");
  }
  for (const adoptionNeedle of [
    '[[ "$DRAFT_ID" =~ ^[1-9][0-9]*$ ]]',
    'gh api "repos/$GITHUB_REPOSITORY/releases/$DRAFT_ID"',
    '[[ "$(jq -r .tag_name <<< "$release")" == "$TAG" ]]',
    '[[ "$(jq -r .target_commitish <<< "$release")" == "$SOURCE_COMMIT" ]]',
    '[[ "$(jq -r .draft <<< "$release")" == "true" ]]',
    '[[ "$(jq -r .prerelease <<< "$release")" == "true" ]]',
    'echo "id=$DRAFT_ID" >> "$GITHUB_OUTPUT"',
  ]) {
    requireText(
      draftStep.run,
      adoptionNeedle,
      "Publication must adopt only the exact planned Release Drafter draft ID, tag, and source SHA.",
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
    "type: string",
  ]) {
    requireText(main, scopeNeedle, `Publication release-scope contract is missing ${scopeNeedle}.`);
  }
  requireText(
    main,
    '[[ "$TAG" == "super-v$VERSION" ]]',
    "Publication must fail unless the explicit tag matches the version.",
  );
  prohibitText(
    main,
    "controller_actor",
    "Publication must not trust caller-supplied actor identity.",
  );
  requireText(
    main,
    '[[ "$CALLER_WORKFLOW_REF" == "$GITHUB_REPOSITORY/.github/workflows/release-drafter.yml@refs/heads/main" ]]',
    "Publication must authenticate the exact protected-main controller workflow.",
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
    "before-draft",
    "after-draft",
    "before-publish",
    "after-publish",
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
  requireText(
    main,
    'existing_assets_json="$(gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases/$DRAFT_ID/assets?per_page=100")"',
    "Publication retries must inspect only the admitted draft's existing assets.",
  );
  requireText(
    main,
    '[[ -n "${expected_names[$existing_name]+present}" ]]',
    "Publication retries must reject unexpected existing draft assets.",
  );
  requireText(
    main,
    "[.[][] | .name] | unique | length",
    "Publication retries must reject duplicate existing draft asset names.",
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
  prohibitText(
    main,
    "gh release create",
    "Publication must never create an arbitrary release draft.",
  );
  requireText(
    main,
    "Adopt exact owned Release Drafter draft",
    "Publication must adopt the exact owned Release Drafter draft.",
  );
  requireText(
    main,
    'gh release upload "$TAG" "${assets[@]}" --repo "$GITHUB_REPOSITORY" --clobber',
    "Publication must replace only the exact expected assets on the owned draft during recovery.",
  );
  prohibitText(
    main,
    'git push origin "refs/tags/$TAG"',
    "Publication must not reserve an immutable tag before atomic draft publication.",
  );
  requireText(
    main,
    'published="$(gh api --method PATCH',
    "Publication must create the immutable tag through the atomic GitHub draft publication transition.",
  );
  requireText(
    main,
    '-f tag_name="$TAG" \\\n            -f target_commitish="$SOURCE_COMMIT"',
    "Atomic draft publication must bind the exact immutable tag and source commit.",
  );
  requireText(main, "cmp ", "Publication must compare redownloaded bytes exactly.");
  requireText(main, "make_latest=false", "Unsigned prerelease must not become GitHub Latest.");
  prohibitText(
    main,
    "gh release delete",
    "Failure handling must never delete a draft automatically.",
  );
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

const RELEASE_DRAFTER_ACTION =
  "release-drafter/release-drafter@eada3c96a64734dd381cfbda23511034e328ddb0";
const RELEASE_DRAFTER_GATE_CONDITION = "steps.changes.outputs.should_release == 'true'";
const RELEASE_DRAFTER_DISPATCH_CONDITION =
  "${{ github.event_name != 'push' && needs.draft.outputs.should_release == 'true' }}";

export function verifySuperSynaraReleaseDrafterText(
  schedulerText: string,
  configText: string,
): void {
  const scheduler = schedulerText.replaceAll("\r\n", "\n");
  const config = configText.replaceAll("\r\n", "\n");
  const workflow = publicationWorkflow(scheduler);
  const triggers = workflow.on;
  if (!isRecord(triggers)) {
    throw new Error("Release Drafter scheduler must define explicit triggers.");
  }
  const push = triggers.push;
  const schedule = triggers.schedule;
  const dispatch = triggers.workflow_dispatch;
  if (
    !isRecord(push) ||
    JSON.stringify(push.branches) !== JSON.stringify(["main"]) ||
    !Array.isArray(schedule) ||
    schedule.length !== 1 ||
    !isRecord(schedule[0]) ||
    schedule[0].cron !== "23 14 * * 1" ||
    !isRecord(dispatch)
  ) {
    throw new Error(
      "Release Drafter scheduler must run on protected main pushes, one weekly cron, and manual dispatch only.",
    );
  }
  prohibitText(
    scheduler,
    "pull_request:",
    "Release Drafter scheduler must not run on pull requests.",
  );
  requireText(
    scheduler,
    "group: super-synara-prerelease\n  queue: max\n  cancel-in-progress: false",
    "Release Drafter scheduler must serialize draft mutation with artifact publication.",
  );
  requirePinnedActions(scheduler, "Release Drafter scheduler");
  prohibitText(
    scheduler,
    "secrets.",
    "Release Drafter scheduler must use only the scoped GitHub token.",
  );
  prohibitText(
    scheduler,
    "id-token:",
    "Release Drafter scheduler must not request identity-token permission.",
  );

  const jobs = publicationJobs(scheduler);
  const draftJob = publicationJob(jobs, "draft");
  const dispatchJob = jobs.dispatch;
  if (!isRecord(dispatchJob)) {
    throw new Error("Release Drafter scheduler must define the reusable publication call.");
  }
  const draftOutputs = draftJob.outputs;
  if (
    !isRecord(draftOutputs) ||
    draftOutputs.should_release !== "${{ steps.changes.outputs.should_release }}"
  ) {
    throw new Error("Release Drafter scheduler must expose the no-change gate to dispatch.");
  }
  const draftSteps = draftJob.steps;
  if (!Array.isArray(draftSteps)) {
    throw new Error("Release Drafter scheduler must define draft steps.");
  }
  const checkoutIndex = draftSteps.findIndex(
    (step) => isRecord(step) && step.name === "Checkout exact main source",
  );
  const setupNodeIndexes = draftSteps.flatMap((step, index) =>
    isRecord(step) && typeof step.uses === "string" && /^actions\/setup-node@/i.test(step.uses)
      ? [index]
      : [],
  );
  const setupNodeIndex = setupNodeIndexes[0] ?? -1;
  const plannerIndex = draftSteps.findIndex((step) => isRecord(step) && step.id === "plan");
  const setupNodeStep = draftSteps[setupNodeIndex];
  if (
    setupNodeIndexes.length !== 1 ||
    checkoutIndex < 0 ||
    setupNodeIndex <= checkoutIndex ||
    plannerIndex <= setupNodeIndex ||
    !isRecord(setupNodeStep) ||
    "if" in setupNodeStep ||
    setupNodeStep.name !== "Set up Node.js" ||
    setupNodeStep.uses !== SETUP_NODE_ACTION ||
    !isRecord(setupNodeStep.with) ||
    setupNodeStep.with["node-version-file"] !== "package.json"
  ) {
    throw new Error(
      "Release Drafter scheduler must pin the repository Node runtime between checkout and planning.",
    );
  }
  const gateIndex = draftSteps.findIndex((step) => isRecord(step) && step.id === "changes");
  const authorizationIndex = draftSteps.findIndex(
    (step) => isRecord(step) && step.name === "Authorize manual release controller before mutation",
  );
  const rerunAuthorizationIndex = draftSteps.findIndex(
    (step) => isRecord(step) && step.name === "Authorize workflow rerun before mutation",
  );
  const actionIndex = draftSteps.findIndex(
    (step) => isRecord(step) && step.id === "release_drafter",
  );
  if (
    gateIndex < 0 ||
    authorizationIndex < 0 ||
    rerunAuthorizationIndex < 0 ||
    actionIndex < 0 ||
    gateIndex >= authorizationIndex ||
    authorizationIndex >= rerunAuthorizationIndex ||
    rerunAuthorizationIndex >= actionIndex
  ) {
    throw new Error(
      "Release Drafter scheduler must prove new commits and authorize manual actors before Release Drafter can mutate a draft.",
    );
  }
  const gateStep = draftSteps[gateIndex];
  const actionStep = draftSteps[actionIndex];
  if (!isRecord(gateStep) || typeof gateStep.run !== "string" || !isRecord(actionStep)) {
    throw new Error("Release Drafter scheduler must define a fail-closed no-change gate.");
  }
  for (const gateNeedle of [
    '[[ "$(git rev-parse "$LATEST_TAG^{commit}")" == "$LATEST_TAG_COMMIT" ]]',
    'git merge-base --is-ancestor "$LATEST_TAG_COMMIT" "$SOURCE_SHA"',
    'commit_count="$(git rev-list --count "$LATEST_TAG_COMMIT..$SOURCE_SHA")"',
    'if [[ "$commit_count" == "0" ]]; then',
    'echo "should_release=false" >> "$GITHUB_OUTPUT"',
    'echo "should_release=true" >> "$GITHUB_OUTPUT"',
  ]) {
    requireText(
      gateStep.run,
      gateNeedle,
      "Release Drafter scheduler no-change gate must fail closed before draft mutation.",
    );
  }
  prohibitText(
    gateStep.run,
    "exit 0",
    "Release Drafter scheduler must not bypass commit counting for push reruns.",
  );
  const authorizationStep = draftSteps[authorizationIndex];
  if (
    !isRecord(authorizationStep) ||
    authorizationStep.if !== "github.event_name == 'workflow_dispatch'" ||
    typeof authorizationStep.run !== "string" ||
    JSON.stringify(executableShellLines(authorizationStep.run)) !==
      JSON.stringify([
        "set -euo pipefail",
        '[[ "$ACTOR" == "$OWNER" ]]',
        '[[ "$TRIGGERING_ACTOR" == "$OWNER" ]]',
      ])
  ) {
    throw new Error(
      "Release Drafter manual dispatch must authorize the real owner before any draft mutation.",
    );
  }
  const rerunAuthorizationStep = draftSteps[rerunAuthorizationIndex];
  if (
    !isRecord(rerunAuthorizationStep) ||
    rerunAuthorizationStep.if !== "github.run_attempt > 1" ||
    typeof rerunAuthorizationStep.run !== "string" ||
    JSON.stringify(executableShellLines(rerunAuthorizationStep.run)) !==
      JSON.stringify(["set -euo pipefail", '[[ "$TRIGGERING_ACTOR" == "$OWNER" ]]'])
  ) {
    throw new Error(
      "Release Drafter reruns must authorize and preserve the real triggering owner before mutation.",
    );
  }
  if (
    actionStep.uses !== RELEASE_DRAFTER_ACTION ||
    actionStep.if !== RELEASE_DRAFTER_GATE_CONDITION ||
    !isRecord(actionStep.with) ||
    actionStep.with.publish !== false ||
    actionStep.with.prerelease !== true ||
    actionStep.with.latest !== false ||
    actionStep.with.commitish !== "${{ steps.source.outputs.source_sha }}"
  ) {
    throw new Error(
      "Release Drafter action must be exact-source, draft-only, prerelease-only, non-Latest, pinned, and gated on changes.",
    );
  }
  for (const stepName of [
    "Admit only the planned Release Drafter draft",
    "Reject a raced main update",
  ]) {
    const step = draftSteps.find((candidate) => isRecord(candidate) && candidate.name === stepName);
    if (!isRecord(step) || step.if !== RELEASE_DRAFTER_GATE_CONDITION) {
      throw new Error(
        "Release Drafter scheduler must gate all post-action draft work on new commits.",
      );
    }
  }
  if (dispatchJob.if !== RELEASE_DRAFTER_DISPATCH_CONDITION) {
    throw new Error(
      "Release Drafter dispatch must be unreachable for pushes and no-change schedules.",
    );
  }
  const dispatchPermissions = dispatchJob.permissions;
  const dispatchInputs = dispatchJob.with;
  if (
    dispatchJob.uses !== "./.github/workflows/super-synara-prerelease.yml" ||
    dispatchJob.needs !== "draft" ||
    !isRecord(dispatchPermissions) ||
    JSON.stringify(dispatchPermissions) !== JSON.stringify({ contents: "write" }) ||
    !isRecord(dispatchInputs) ||
    dispatchInputs.version !== "${{ needs.draft.outputs.version }}" ||
    dispatchInputs.tag !== "${{ needs.draft.outputs.tag }}" ||
    dispatchInputs.release_scope !==
      "${{ github.event_name == 'workflow_dispatch' && inputs.release_scope || 'windows-only' }}" ||
    dispatchInputs.expected_source_sha !== "${{ needs.draft.outputs.source_sha }}" ||
    dispatchInputs.release_draft_id !== "${{ needs.draft.outputs.draft_id }}" ||
    dispatchInputs.confirm_unsigned !== true
  ) {
    throw new Error(
      "Release Drafter dispatch must call the local publisher with exact draft identity and least privilege.",
    );
  }

  for (const configNeedle of [
    'tag-template: "super-v$RESOLVED_VERSION"',
    'tag-prefix: "super-v"',
    "<!-- super-synara-release-drafter-owned -->",
    "unofficial, unsigned Super Synara prerelease",
    "Installation updates remain manual",
    "This prerelease is never the GitHub Latest release",
    "$PREVIOUS_TAG...super-v$RESOLVED_VERSION",
  ]) {
    requireText(config, configNeedle, `Release Drafter config is missing ${configNeedle}.`);
  }
  prohibitText(
    `${scheduler}\n${config}`,
    "semantic-release",
    "Super Synara release automation must use exactly one release system.",
  );
}

export function verifySuperSynaraGithubStateScriptText(script: string): void {
  script = script.replaceAll("\r\n", "\n");
  const orderedNeedles = [
    "const visibilityAttempts = 30;",
    "validateSuperSynaraGitHubPolicy({",
    "for (let attempt = 1; attempt <= visibilityAttempts; attempt += 1)",
    "try {",
    "const refJson = runGh(",
    "parseSuperSynaraTagObject(JSON.parse(refJson))",
    "releases = parseSuperSynaraReleasePages(releasePages);",
    "validateSuperSynaraGitHubState({",
    "if (!(error instanceof SuperSynaraGitHubStateVisibilityError)) throw error;",
    "throw lastTransientError",
  ];
  let previousIndex = -1;
  for (const needle of orderedNeedles) {
    const index = script.indexOf(needle);
    if (index <= previousIndex) {
      throw new Error(
        "GitHub release-state verification must retry visibility boundedly and fail closed.",
      );
    }
    previousIndex = index;
  }
  requireText(
    script,
    "`repos/${repository}/releases?per_page=100`",
    "GitHub release-state visibility retries must re-read the complete release list.",
  );
  requireText(
    script,
    "timeoutMs: GH_CLI_BULK_TIMEOUT_MS",
    "GitHub release-state pagination must use the bounded bulk timeout.",
  );
  requireText(
    script,
    "if (!(error instanceof GhCliRequestError) || !error.retryable) throw error;",
    "GitHub release-state verification must retry only classified transient GitHub reads.",
  );
  if (
    script.split("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);").length -
      1 !==
    2
  ) {
    throw new Error("GitHub release-state verification must use bounded polling delays.");
  }
}

export function verifySuperSynaraReleasePlannerScriptText(script: string): void {
  script = script.replaceAll("\r\n", "\n");
  const coreVersionIndex = script.indexOf("const coreVersion = packageVersions[0]!.version;");
  const validationIndex = script.indexOf("assertSuperSynaraCoreVersion(coreVersion);");
  const firstGitHubReadIndex = script.indexOf("runGh(");
  if (
    coreVersionIndex < 0 ||
    validationIndex <= coreVersionIndex ||
    firstGitHubReadIndex <= validationIndex
  ) {
    throw new Error(
      "Release planner must validate the package core version before constructing a GitHub API request.",
    );
  }
  requireText(
    script,
    "parseSuperSynaraMatchingTagRefs(",
    "Release planner must decode matching tag refs at the GitHub boundary.",
  );
  requireText(
    script,
    "parseSuperSynaraReleasePages(",
    "Release planner must decode release pages at the GitHub boundary.",
  );
  requireText(
    script,
    "timeoutMs: GH_CLI_BULK_TIMEOUT_MS",
    "Release planner pagination must use the bounded bulk timeout.",
  );
}

export function verifySuperSynaraWorkflowContracts(repoRoot: string): void {
  verifySuperSynaraWorkflowText(
    readFileSync(resolve(repoRoot, ".github/workflows/super-synara-prerelease.yml"), "utf8"),
    readFileSync(
      resolve(repoRoot, ".github/workflows/super-synara-macos-signature-audit.yml"),
      "utf8",
    ),
  );
  verifySuperSynaraReleaseDrafterText(
    readFileSync(resolve(repoRoot, ".github/workflows/release-drafter.yml"), "utf8"),
    readFileSync(resolve(repoRoot, ".github/release-drafter.yml"), "utf8"),
  );
  verifySuperSynaraGithubStateScriptText(
    readFileSync(resolve(repoRoot, "scripts/verify-super-synara-github-state.ts"), "utf8"),
  );
  verifySuperSynaraReleasePlannerScriptText(
    readFileSync(resolve(repoRoot, "scripts/plan-super-synara-release-drafter.ts"), "utf8"),
  );
}
