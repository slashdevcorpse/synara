export interface DriftCommit {
  readonly sha: string;
  readonly message: string;
  readonly url: string;
}

export interface DriftRelease {
  readonly tag: string;
  readonly sha: string;
  readonly url: string;
}

export interface DriftPatch {
  readonly id: string;
  readonly status: string;
  readonly touchedFiles: readonly string[];
}

export interface DriftPullRequest {
  readonly number: number;
  readonly branch: string;
  readonly url: string;
}

export interface DriftInput {
  readonly lastAbsorbedSha: string;
  readonly currentUpstreamSha: string;
  readonly lastAcceptedOn: string;
  readonly compareStatus: string;
  readonly mergeBaseSha: string;
  readonly pendingCommitCount: number;
  readonly commits: readonly DriftCommit[];
  readonly changedFiles: readonly string[];
  readonly changedFilesTruncated: boolean;
  readonly releases: readonly DriftRelease[];
  readonly patches: readonly DriftPatch[];
  readonly activeSyncPullRequests: readonly DriftPullRequest[];
  readonly now: Date;
}

export interface PatchIntersection {
  readonly patchId: string;
  readonly files: readonly string[];
}

export interface DriftAnalysis {
  readonly lastAbsorbedSha: string;
  readonly currentUpstreamSha: string;
  readonly historyRewritten: boolean;
  readonly pendingCommitCount: number;
  readonly releases: readonly DriftRelease[];
  readonly daysSinceAcceptedSync: number;
  readonly changedSubsystems: readonly string[];
  readonly changedFiles: readonly string[];
  readonly changedFilesTruncated: boolean;
  readonly patchIntersections: readonly PatchIntersection[];
  readonly criticalSignals: readonly string[];
  readonly activeSyncPullRequests: readonly DriftPullRequest[];
  readonly syncThresholdReached: boolean;
  readonly thresholdReasons: readonly string[];
  readonly failClosed: boolean;
}

const ACTIVE_PATCH_STATUSES = new Set([
  "downstream-only",
  "upstream-pending",
  "upstreamed",
  "deferred",
]);
const CRITICAL_PATTERN =
  /security|auth|credential|migration|database|sqlite|data[- ]integrity|windows|provider|spawn|startup|process|performance|\bperf\b/i;

const SUBSYSTEM_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\.github\//, "automation"],
  [/^apps\/desktop\//, "desktop"],
  [/^apps\/server\/src\/persistence\//, "persistence"],
  [/^apps\/server\/src\/(?:provider|codex)/, "provider-startup"],
  [/^apps\/server\//, "server"],
  [/^apps\/web\//, "web"],
  [/^packages\/contracts\//, "contracts"],
  [/^packages\/shared\//, "shared-runtime"],
  [/^scripts\//, "build-release"],
  [/^(?:package\.json|bun\.lock|turbo\.json)$/, "toolchain"],
  [/^(?:docs|audit)\//, "documentation"],
];

function subsystemForFile(path: string): string {
  for (const [pattern, subsystem] of SUBSYSTEM_RULES) {
    if (pattern.test(path)) return subsystem;
  }
  return "other";
}

function daysBetween(date: string, now: Date): number {
  const accepted = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(accepted)) throw new Error(`Invalid accepted sync date: ${date}`);
  return Math.max(0, Math.floor((now.getTime() - accepted) / 86_400_000));
}

export function analyzeUpstreamDrift(input: DriftInput): DriftAnalysis {
  const historyRewritten =
    !["ahead", "identical"].includes(input.compareStatus) ||
    input.mergeBaseSha !== input.lastAbsorbedSha;
  const changedFiles = [...new Set(input.changedFiles)].sort();
  const changedSubsystems = [...new Set(changedFiles.map(subsystemForFile))].sort();
  const patchIntersections = input.patches
    .filter((patch) => ACTIVE_PATCH_STATUSES.has(patch.status))
    .map((patch) => ({
      patchId: patch.id,
      files: patch.touchedFiles.filter((file) => changedFiles.includes(file)).sort(),
    }))
    .filter((intersection) => intersection.files.length > 0)
    .sort((left, right) => left.patchId.localeCompare(right.patchId));

  const criticalSignals = [
    ...input.commits
      .filter((commit) => CRITICAL_PATTERN.test(commit.message))
      .map((commit) => `${commit.sha.slice(0, 12)}: ${commit.message.split("\n")[0]}`),
    ...changedFiles.filter((file) => CRITICAL_PATTERN.test(file)).map((file) => `path: ${file}`),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const daysSinceAcceptedSync = daysBetween(input.lastAcceptedOn, input.now);
  const thresholdReasons: string[] = [];
  if (input.releases.length > 0) thresholdReasons.push("upstream published a release");
  if (daysSinceAcceptedSync >= 3) thresholdReasons.push("three calendar days elapsed");
  if (input.pendingCommitCount >= 50) thresholdReasons.push("at least 50 commits are pending");
  if (criticalSignals.length > 0) thresholdReasons.push("critical-change signal detected");
  if (historyRewritten) thresholdReasons.push("upstream history is not a descendant of authority");
  if (input.activeSyncPullRequests.length > 1) {
    thresholdReasons.push("more than one active sync PR exists");
  }

  return {
    lastAbsorbedSha: input.lastAbsorbedSha,
    currentUpstreamSha: input.currentUpstreamSha,
    historyRewritten,
    pendingCommitCount: input.pendingCommitCount,
    releases: input.releases,
    daysSinceAcceptedSync,
    changedSubsystems,
    changedFiles,
    changedFilesTruncated: input.changedFilesTruncated,
    patchIntersections,
    criticalSignals,
    activeSyncPullRequests: input.activeSyncPullRequests,
    syncThresholdReached: thresholdReasons.length > 0,
    thresholdReasons,
    failClosed: historyRewritten || input.activeSyncPullRequests.length > 1,
  };
}

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- None";
}

export function renderUpstreamDriftMarkdown(analysis: DriftAnalysis): string {
  const releaseLines = analysis.releases.map(
    (release) => `[${release.tag}](${release.url}) at \`${release.sha}\``,
  );
  const intersectionLines = analysis.patchIntersections.map(
    (intersection) =>
      `\`${intersection.patchId}\`: ${intersection.files.map((file) => `\`${file}\``).join(", ")}`,
  );
  const syncPrLines = analysis.activeSyncPullRequests.map(
    (pullRequest) => `[#${pullRequest.number}](${pullRequest.url}) from \`${pullRequest.branch}\``,
  );
  const status = analysis.failClosed
    ? "FAIL CLOSED"
    : analysis.syncThresholdReached
      ? "SYNC ASSESSMENT REQUIRED"
      : "WITHIN THRESHOLD";

  return `<!-- super-synara-upstream-drift -->
# Super Synara upstream drift

**Status:** ${status}

- Last absorbed upstream SHA: \`${analysis.lastAbsorbedSha}\`
- Current upstream SHA: \`${analysis.currentUpstreamSha}\`
- Pending commits: ${analysis.pendingCommitCount}
- Days since accepted sync: ${analysis.daysSinceAcceptedSync}
- History descendant check: ${analysis.historyRewritten ? "failed" : "passed"}
- Changed-file list complete: ${analysis.changedFilesTruncated ? "no (GitHub comparison limit reached)" : "yes"}

## Threshold reasons

${listOrNone(analysis.thresholdReasons)}

## Releases after absorbed authority

${listOrNone(releaseLines)}

## Changed subsystems

${listOrNone(analysis.changedSubsystems)}

## Active patch intersections

${listOrNone(intersectionLines)}

## Critical signals

${listOrNone(analysis.criticalSignals)}

## Active sync pull requests

${listOrNone(syncPrLines)}

This watcher reports only. It does not create branches, modify refs, merge upstream changes, or publish builds.
`;
}
