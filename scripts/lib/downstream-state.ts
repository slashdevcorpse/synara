import { isAbsolute, normalize, sep } from "node:path";

import { parse as parseYaml } from "yaml";

export const PATCH_STATUSES = [
  "downstream-only",
  "upstream-pending",
  "upstreamed",
  "superseded",
  "deferred",
  "retired",
] as const;

export type PatchStatus = (typeof PATCH_STATUSES)[number];

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PATCH_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATCH_STATUS_SET = new Set<string>(PATCH_STATUSES);
const STATUSES_REQUIRING_UPSTREAM_SOURCE = new Set<PatchStatus>([
  "upstream-pending",
  "upstreamed",
  "superseded",
]);
const ALLOWED_TRANSITIONS = new Set<string>([
  "downstream-only>upstream-pending",
  "downstream-only>deferred",
  "downstream-only>superseded",
  "downstream-only>retired",
  "upstream-pending>downstream-only",
  "upstream-pending>upstreamed",
  "upstream-pending>superseded",
  "upstream-pending>deferred",
  "upstream-pending>retired",
  "upstreamed>superseded",
  "upstreamed>retired",
  "superseded>retired",
  "deferred>downstream-only",
  "deferred>upstream-pending",
  "deferred>superseded",
  "deferred>retired",
]);

type UnknownRecord = Record<string, unknown>;

export interface CommitGraph {
  readonly headSha: string;
  commitExists(sha: string): boolean;
  isAncestor(ancestor: string, descendant: string): boolean;
}

export interface AssessmentReader {
  exists(path: string): boolean;
  read(path: string): string;
}

export interface DownstreamValidationContext {
  readonly commits: CommitGraph;
  readonly assessments: AssessmentReader;
}

export interface DownstreamValidationResult {
  readonly errors: readonly string[];
  readonly patchCount: number;
  readonly syncCount: number;
  readonly lastEffectiveUpstreamSha: string | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string, errors: string[]): UnknownRecord | null {
  if (isRecord(value)) return value;
  errors.push(`${path} must be an object.`);
  return null;
}

function requireArray(value: unknown, path: string, errors: string[]): unknown[] | null {
  if (Array.isArray(value)) return value;
  errors.push(`${path} must be an array.`);
  return null;
}

function requireNonEmptyString(value: unknown, path: string, errors: string[]): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  errors.push(`${path} must be a non-empty string.`);
  return null;
}

function requireStringArray(value: unknown, path: string, errors: string[]): string[] | null {
  const values = requireArray(value, path, errors);
  if (!values) return null;
  if (values.length === 0) {
    errors.push(`${path} must contain at least one entry.`);
    return null;
  }
  const strings: string[] = [];
  for (const [index, entry] of values.entries()) {
    const string = requireNonEmptyString(entry, `${path}[${index}]`, errors);
    if (string !== null) strings.push(string);
  }
  return strings;
}

function validateDate(value: unknown, path: string, errors: string[]): string | null {
  const date = requireNonEmptyString(value, path, errors);
  if (date === null) return null;
  if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    errors.push(`${path} must be a real YYYY-MM-DD date.`);
    return null;
  }
  return date;
}

function validateSha(
  value: unknown,
  path: string,
  errors: string[],
  commits: CommitGraph,
): string | null {
  const sha = requireNonEmptyString(value, path, errors);
  if (sha === null) return null;
  if (!SHA_PATTERN.test(sha)) {
    errors.push(`${path} must be a lowercase full 40-character commit SHA.`);
    return null;
  }
  if (!commits.commitExists(sha)) {
    errors.push(`${path} references missing commit ${sha}.`);
    return null;
  }
  return sha;
}

function validateExternalSha(value: unknown, path: string, errors: string[]): string | null {
  const sha = requireNonEmptyString(value, path, errors);
  if (sha === null) return null;
  if (!SHA_PATTERN.test(sha)) {
    errors.push(`${path} must be a lowercase full 40-character commit SHA.`);
    return null;
  }
  return sha;
}

function validateRepositoryPath(value: string, path: string, errors: string[]): void {
  const normalized = normalize(value);
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    errors.push(`${path} must be a normalized repository-relative path.`);
  }
}

function validateRootIdentity(document: UnknownRecord, path: string, errors: string[]): void {
  if (document.schemaVersion !== 1) errors.push(`${path}.schemaVersion must equal 1.`);
  if (document.repository !== "slashdevcorpse/synara") {
    errors.push(`${path}.repository must equal slashdevcorpse/synara.`);
  }
  if (document.canonicalUpstream !== "Emanuele-web04/synara") {
    errors.push(`${path}.canonicalUpstream must equal Emanuele-web04/synara.`);
  }
}

function validateStatusHistory(
  value: unknown,
  currentStatus: string | null,
  path: string,
  errors: string[],
): void {
  const history = requireArray(value, path, errors);
  if (!history) return;
  if (history.length === 0) {
    errors.push(`${path} must record at least the initial status.`);
    return;
  }

  let previousStatus: string | null = null;
  let previousDate: string | null = null;
  let lastStatus: string | null = null;
  for (const [index, rawEntry] of history.entries()) {
    const entryPath = `${path}[${index}]`;
    const entry = requireRecord(rawEntry, entryPath, errors);
    if (!entry) continue;
    const status = requireNonEmptyString(entry.status, `${entryPath}.status`, errors);
    if (status !== null && !PATCH_STATUS_SET.has(status)) {
      errors.push(`${entryPath}.status has unsupported value ${status}.`);
    }
    const date = validateDate(entry.date, `${entryPath}.date`, errors);
    requireNonEmptyString(entry.evidence, `${entryPath}.evidence`, errors);

    if (previousStatus !== null && status !== null) {
      const transition = `${previousStatus}>${status}`;
      if (!ALLOWED_TRANSITIONS.has(transition)) {
        errors.push(`${entryPath} contains invalid status transition ${transition}.`);
      }
    }
    if (previousDate !== null && date !== null && date < previousDate) {
      errors.push(`${entryPath}.date must not precede the previous history entry.`);
    }
    if (status !== null) {
      previousStatus = status;
      lastStatus = status;
    }
    if (date !== null) previousDate = date;
  }

  if (currentStatus !== null && lastStatus !== currentStatus) {
    errors.push(`${path} must end with current status ${currentStatus}.`);
  }
}

function validatePatchInventory(
  rawInventory: unknown,
  lastEffectiveUpstreamSha: string | null,
  context: DownstreamValidationContext,
  errors: string[],
): number {
  const inventory = requireRecord(rawInventory, "patchInventory", errors);
  if (!inventory) return 0;
  validateRootIdentity(inventory, "patchInventory", errors);
  validateDate(inventory.verifiedOn, "patchInventory.verifiedOn", errors);
  const patches = requireArray(inventory.patches, "patchInventory.patches", errors);
  if (!patches) return 0;

  const seenIds = new Set<string>();
  for (const [index, rawPatch] of patches.entries()) {
    const path = `patchInventory.patches[${index}]`;
    const patch = requireRecord(rawPatch, path, errors);
    if (!patch) continue;
    const id = requireNonEmptyString(patch.id, `${path}.id`, errors);
    if (id !== null) {
      if (!PATCH_ID_PATTERN.test(id)) {
        errors.push(`${path}.id must be a stable lowercase kebab-case identifier.`);
      }
      if (seenIds.has(id)) errors.push(`${path}.id duplicates ${id}.`);
      seenIds.add(id);
    }
    requireNonEmptyString(patch.purpose, `${path}.purpose`, errors);
    requireNonEmptyString(patch.userVisibleConsequence, `${path}.userVisibleConsequence`, errors);
    requireNonEmptyString(patch.owner, `${path}.owner`, errors);
    const status = requireNonEmptyString(patch.status, `${path}.status`, errors);
    if (status !== null && !PATCH_STATUS_SET.has(status)) {
      errors.push(`${path}.status has unsupported value ${status}.`);
    }
    if (
      status !== null &&
      PATCH_STATUS_SET.has(status) &&
      STATUSES_REQUIRING_UPSTREAM_SOURCE.has(status as PatchStatus)
    ) {
      validateExternalSha(patch.upstreamSourceCommit, `${path}.upstreamSourceCommit`, errors);
    } else if (patch.upstreamSourceCommit !== undefined && patch.upstreamSourceCommit !== null) {
      validateExternalSha(patch.upstreamSourceCommit, `${path}.upstreamSourceCommit`, errors);
    }

    if (status === "superseded" && patch.introducingCommit === null) {
      // A candidate that was superseded before it ever landed downstream has no introducing
      // downstream commit. Its canonical source object remains recorded separately above.
    } else {
      validateSha(patch.introducingCommit, `${path}.introducingCommit`, errors, context.commits);
    }

    for (const field of ["touchedFiles", "regressionTests"] as const) {
      const paths = requireStringArray(patch[field], `${path}.${field}`, errors);
      if (paths) {
        for (const [pathIndex, repositoryPath] of paths.entries()) {
          validateRepositoryPath(repositoryPath, `${path}.${field}[${pathIndex}]`, errors);
        }
      }
    }
    requireStringArray(patch.subsystems, `${path}.subsystems`, errors);
    const upstreamLinks = requireStringArray(patch.upstreamLinks, `${path}.upstreamLinks`, errors);
    if (upstreamLinks) {
      for (const [linkIndex, link] of upstreamLinks.entries()) {
        if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+$/.test(link)) {
          errors.push(`${path}.upstreamLinks[${linkIndex}] must be a GitHub issue or PR URL.`);
        }
      }
    }
    requireNonEmptyString(patch.overlapResolutionPolicy, `${path}.overlapResolutionPolicy`, errors);
    const assessedSha = validateSha(
      patch.lastAssessedUpstreamSha,
      `${path}.lastAssessedUpstreamSha`,
      errors,
      context.commits,
    );
    if (
      assessedSha !== null &&
      lastEffectiveUpstreamSha !== null &&
      assessedSha !== lastEffectiveUpstreamSha
    ) {
      errors.push(
        `${path}.lastAssessedUpstreamSha must equal state authority ${lastEffectiveUpstreamSha}.`,
      );
    }
    validateDate(patch.verificationDate, `${path}.verificationDate`, errors);
    requireNonEmptyString(patch.retirementCondition, `${path}.retirementCondition`, errors);
    validateStatusHistory(patch.statusHistory, status, `${path}.statusHistory`, errors);
  }
  return patches.length;
}

interface SyncValidationResult {
  readonly count: number;
  readonly finalSha: string | null;
}

function validateAcceptedSyncs(
  value: unknown,
  context: DownstreamValidationContext,
  errors: string[],
): SyncValidationResult {
  const syncs = requireArray(value, "upstreamState.acceptedSyncs", errors);
  if (!syncs) return { count: 0, finalSha: null };
  if (syncs.length === 0) {
    errors.push("upstreamState.acceptedSyncs must contain the baseline sync.");
    return { count: 0, finalSha: null };
  }

  const seenIds = new Set<string>();
  let previousEffectiveSha: string | null = null;
  let finalSha: string | null = null;
  for (const [index, rawSync] of syncs.entries()) {
    const path = `upstreamState.acceptedSyncs[${index}]`;
    const sync = requireRecord(rawSync, path, errors);
    if (!sync) continue;
    const id = requireNonEmptyString(sync.id, `${path}.id`, errors);
    if (id !== null) {
      if (seenIds.has(id)) errors.push(`${path}.id duplicates ${id}.`);
      seenIds.add(id);
    }
    const previousSha = validateSha(
      sync.previousUpstreamSha,
      `${path}.previousUpstreamSha`,
      errors,
      context.commits,
    );
    const effectiveSha = validateSha(
      sync.effectiveUpstreamSha,
      `${path}.effectiveUpstreamSha`,
      errors,
      context.commits,
    );
    const downstreamCommit = validateSha(
      sync.downstreamCommit,
      `${path}.downstreamCommit`,
      errors,
      context.commits,
    );
    const rollbackSha = validateSha(
      sync.rollbackSha,
      `${path}.rollbackSha`,
      errors,
      context.commits,
    );

    if (
      previousEffectiveSha !== null &&
      previousSha !== null &&
      previousSha !== previousEffectiveSha
    ) {
      errors.push(`${path}.previousUpstreamSha must continue from ${previousEffectiveSha}.`);
    }
    if (
      previousSha !== null &&
      effectiveSha !== null &&
      !context.commits.isAncestor(previousSha, effectiveSha)
    ) {
      errors.push(`${path} effective SHA must descend from its previous upstream SHA.`);
    }
    if (
      effectiveSha !== null &&
      downstreamCommit !== null &&
      !context.commits.isAncestor(effectiveSha, downstreamCommit)
    ) {
      errors.push(`${path}.downstreamCommit must contain the effective upstream SHA.`);
    }
    if (rollbackSha !== null && previousSha !== null && rollbackSha !== previousSha) {
      errors.push(`${path}.rollbackSha must equal the previous upstream SHA.`);
    }

    const method = requireNonEmptyString(
      sync.integrationMethod,
      `${path}.integrationMethod`,
      errors,
    );
    if (method !== null && method !== "fast-forward" && method !== "merge-commit") {
      errors.push(`${path}.integrationMethod must be fast-forward or merge-commit.`);
    }
    if (method === "fast-forward" && sync.pullRequest !== null) {
      errors.push(`${path}.pullRequest must be null for a fast-forward baseline.`);
    }
    if (method === "merge-commit") {
      const pullRequest = requireNonEmptyString(sync.pullRequest, `${path}.pullRequest`, errors);
      if (
        pullRequest !== null &&
        !/^https:\/\/github\.com\/slashdevcorpse\/synara\/pull\/\d+$/.test(pullRequest)
      ) {
        errors.push(`${path}.pullRequest must identify the downstream sync PR.`);
      }
    }

    const assessmentPath = requireNonEmptyString(
      sync.assessmentPath,
      `${path}.assessmentPath`,
      errors,
    );
    if (assessmentPath !== null) {
      validateRepositoryPath(assessmentPath, `${path}.assessmentPath`, errors);
      if (!assessmentPath.startsWith("docs/downstream/syncs/") || !assessmentPath.endsWith(".md")) {
        errors.push(`${path}.assessmentPath must be a Markdown file under docs/downstream/syncs/.`);
      } else if (!context.assessments.exists(assessmentPath)) {
        errors.push(`${path}.assessmentPath does not exist: ${assessmentPath}.`);
      } else if (previousSha !== null && effectiveSha !== null && rollbackSha !== null) {
        const assessment = context.assessments.read(assessmentPath);
        const requiredMarkers = [
          `Previous upstream SHA: \`${previousSha}\``,
          `Effective upstream SHA: \`${effectiveSha}\``,
          "Classification complete: **yes**",
          `Rollback SHA: \`${rollbackSha}\``,
        ];
        for (const marker of requiredMarkers) {
          if (!assessment.includes(marker)) {
            errors.push(`${path}.assessmentPath is missing required marker: ${marker}`);
          }
        }
      }
    }
    validateDate(sync.acceptedOn, `${path}.acceptedOn`, errors);
    if (sync.classificationComplete !== true) {
      errors.push(`${path}.classificationComplete must be true.`);
    }

    if (effectiveSha !== null) {
      previousEffectiveSha = effectiveSha;
      finalSha = effectiveSha;
    }
  }
  return { count: syncs.length, finalSha };
}

function validateActiveRanges(
  value: unknown,
  path: string,
  context: DownstreamValidationContext,
  errors: string[],
): void {
  const ranges = requireArray(value, path, errors);
  if (!ranges) return;
  const seenIds = new Set<string>();
  for (const [index, rawRange] of ranges.entries()) {
    const rangePath = `${path}[${index}]`;
    const range = requireRecord(rawRange, rangePath, errors);
    if (!range) continue;
    const id = requireNonEmptyString(range.id, `${rangePath}.id`, errors);
    if (id !== null) {
      if (seenIds.has(id)) errors.push(`${rangePath}.id duplicates ${id}.`);
      seenIds.add(id);
    }
    const fromSha = validateSha(range.fromSha, `${rangePath}.fromSha`, errors, context.commits);
    const toSha = validateSha(range.toSha, `${rangePath}.toSha`, errors, context.commits);
    if (fromSha !== null && toSha !== null && !context.commits.isAncestor(fromSha, toSha)) {
      errors.push(`${rangePath} must describe an ancestry-ordered commit range.`);
    }
    requireNonEmptyString(range.reason, `${rangePath}.reason`, errors);
    requireNonEmptyString(range.evidence, `${rangePath}.evidence`, errors);
    validateDate(range.recordedOn, `${rangePath}.recordedOn`, errors);
  }
}

function validateUpstreamState(
  rawState: unknown,
  context: DownstreamValidationContext,
  errors: string[],
): { count: number; lastEffectiveSha: string | null } {
  const state = requireRecord(rawState, "upstreamState", errors);
  if (!state) return { count: 0, lastEffectiveSha: null };
  validateRootIdentity(state, "upstreamState", errors);
  const lastEffectiveSha = validateSha(
    state.lastEffectiveUpstreamSha,
    "upstreamState.lastEffectiveUpstreamSha",
    errors,
    context.commits,
  );
  validateDate(state.lastVerifiedOn, "upstreamState.lastVerifiedOn", errors);
  const syncResult = validateAcceptedSyncs(state.acceptedSyncs, context, errors);
  if (
    lastEffectiveSha !== null &&
    syncResult.finalSha !== null &&
    lastEffectiveSha !== syncResult.finalSha
  ) {
    errors.push("upstreamState.lastEffectiveUpstreamSha must equal the final accepted sync SHA.");
  }
  if (
    lastEffectiveSha !== null &&
    !context.commits.isAncestor(lastEffectiveSha, context.commits.headSha)
  ) {
    errors.push(
      `upstreamState.lastEffectiveUpstreamSha must be an ancestor of HEAD ${context.commits.headSha}.`,
    );
  }
  validateActiveRanges(
    state.activeRevertedRanges,
    "upstreamState.activeRevertedRanges",
    context,
    errors,
  );
  validateActiveRanges(
    state.activeExcludedRanges,
    "upstreamState.activeExcludedRanges",
    context,
    errors,
  );
  return { count: syncResult.count, lastEffectiveSha };
}

export function parseJsonCompatibleYaml(contents: string, path: string): unknown {
  try {
    return parseYaml(contents, { strict: true, uniqueKeys: true }) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} must contain valid YAML: ${message}`);
  }
}

export function formatDownstreamGitHubOutput(lastEffectiveUpstreamSha: string): string {
  if (!SHA_PATTERN.test(lastEffectiveUpstreamSha)) {
    throw new Error("Cannot emit GitHub output without a validated full upstream SHA.");
  }
  return `absorbed_upstream_sha=${lastEffectiveUpstreamSha}\n`;
}

export function validateDownstreamState(
  rawInventory: unknown,
  rawState: unknown,
  context: DownstreamValidationContext,
): DownstreamValidationResult {
  const errors: string[] = [];
  const stateResult = validateUpstreamState(rawState, context, errors);
  const patchCount = validatePatchInventory(
    rawInventory,
    stateResult.lastEffectiveSha,
    context,
    errors,
  );
  return {
    errors,
    patchCount,
    syncCount: stateResult.count,
    lastEffectiveUpstreamSha: stateResult.lastEffectiveSha,
  };
}
