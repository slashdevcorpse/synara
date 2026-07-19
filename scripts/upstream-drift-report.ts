import { writeFileSync, readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import {
  analyzeUpstreamDrift,
  renderUpstreamDriftMarkdown,
  type DriftCommit,
  type DriftPatch,
  type DriftPullRequest,
  type DriftRelease,
} from "./lib/upstream-drift.ts";

const UPSTREAM_REPOSITORY = "Emanuele-web04/synara";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class GitHubApi {
  private readonly token: string | null;

  constructor(token: string | null) {
    this.token = token;
  }

  async get(path: string): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "super-synara-upstream-watch",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token !== null) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(`https://api.github.com/${path}`, { headers });
    if (!response.ok) {
      throw new Error(`GitHub API ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<unknown>;
  }
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function loadAuthority(): { lastAbsorbedSha: string; lastAcceptedOn: string } {
  const state = requireRecord(
    JSON.parse(readFileSync("docs/downstream/upstream-state.json", "utf8")) as unknown,
    "upstream state",
  );
  const syncs = state.acceptedSyncs;
  if (!Array.isArray(syncs) || syncs.length === 0)
    throw new Error("Accepted sync history is empty.");
  const lastSync = requireRecord(syncs.at(-1), "last accepted sync");
  return {
    lastAbsorbedSha: requireString(state.lastEffectiveUpstreamSha, "last effective upstream SHA"),
    lastAcceptedOn: requireString(lastSync.acceptedOn, "last accepted sync date"),
  };
}

function loadPatches(): DriftPatch[] {
  const inventory = requireRecord(
    parseYaml(readFileSync("docs/downstream/patches.yml", "utf8"), {
      strict: true,
      uniqueKeys: true,
    }),
    "patch inventory",
  );
  if (!Array.isArray(inventory.patches))
    throw new Error("Patch inventory patches must be an array.");
  return inventory.patches.map((rawPatch, index) => {
    const patch = requireRecord(rawPatch, `patch ${index}`);
    if (
      !Array.isArray(patch.touchedFiles) ||
      patch.touchedFiles.some((file) => typeof file !== "string")
    ) {
      throw new Error(`patch ${index} touchedFiles must contain strings.`);
    }
    return {
      id: requireString(patch.id, `patch ${index} id`),
      status: requireString(patch.status, `patch ${index} status`),
      touchedFiles: patch.touchedFiles as string[],
    };
  });
}

async function releasesAfterAuthority(
  api: GitHubApi,
  lastAbsorbedSha: string,
  currentUpstreamSha: string,
  lastAcceptedOn: string,
): Promise<DriftRelease[]> {
  const rawReleases = await api.get(`repos/${UPSTREAM_REPOSITORY}/releases?per_page=20`);
  if (!Array.isArray(rawReleases)) throw new Error("Upstream releases response must be an array.");
  const releases: DriftRelease[] = [];
  const acceptedAt = Date.parse(`${lastAcceptedOn}T00:00:00Z`);
  for (const rawRelease of rawReleases) {
    const release = requireRecord(rawRelease, "release");
    if (release.draft === true) continue;
    const publishedAt = requireString(release.published_at, "release publication date");
    if (Date.parse(publishedAt) < acceptedAt) continue;
    const tag = requireString(release.tag_name, "release tag");
    const commit = requireRecord(
      await api.get(`repos/${UPSTREAM_REPOSITORY}/commits/${encodeURIComponent(tag)}`),
      `release ${tag} commit`,
    );
    const sha = requireString(commit.sha, `release ${tag} SHA`);
    const fromAuthority = requireRecord(
      await api.get(`repos/${UPSTREAM_REPOSITORY}/compare/${lastAbsorbedSha}...${sha}`),
      `release ${tag} authority comparison`,
    );
    const throughCurrent = requireRecord(
      await api.get(`repos/${UPSTREAM_REPOSITORY}/compare/${sha}...${currentUpstreamSha}`),
      `release ${tag} current comparison`,
    );
    if (
      fromAuthority.status === "ahead" &&
      (throughCurrent.status === "ahead" || throughCurrent.status === "identical")
    ) {
      releases.push({
        tag,
        sha,
        url: requireString(release.html_url, `release ${tag} URL`),
      });
    }
  }
  return releases;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--json-output" || args[2] !== "--markdown-output") {
    throw new Error(
      "Usage: node scripts/upstream-drift-report.ts --json-output <path> --markdown-output <path>",
    );
  }
  const jsonOutput = args[1]!;
  const markdownOutput = args[3]!;
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || null;
  const api = new GitHubApi(token);
  const { lastAbsorbedSha, lastAcceptedOn } = loadAuthority();
  const upstreamCommit = requireRecord(
    await api.get(`repos/${UPSTREAM_REPOSITORY}/commits/main`),
    "upstream main commit",
  );
  const currentUpstreamSha = requireString(upstreamCommit.sha, "upstream main SHA");
  const comparison = requireRecord(
    await api.get(
      `repos/${UPSTREAM_REPOSITORY}/compare/${lastAbsorbedSha}...${currentUpstreamSha}`,
    ),
    "upstream comparison",
  );
  const mergeBase = requireRecord(comparison.merge_base_commit, "comparison merge base");
  const rawCommits = Array.isArray(comparison.commits) ? comparison.commits : [];
  const commits: DriftCommit[] = rawCommits.map((rawCommit, index) => {
    const commit = requireRecord(rawCommit, `comparison commit ${index}`);
    const commitDetails = requireRecord(commit.commit, `comparison commit ${index} details`);
    return {
      sha: requireString(commit.sha, `comparison commit ${index} SHA`),
      message: requireString(commitDetails.message, `comparison commit ${index} message`),
      url: requireString(commit.html_url, `comparison commit ${index} URL`),
    };
  });
  const rawFiles = Array.isArray(comparison.files) ? comparison.files : [];
  const changedFiles = rawFiles.map((rawFile, index) =>
    requireString(
      requireRecord(rawFile, `comparison file ${index}`).filename,
      `file ${index} name`,
    ),
  );
  const rawPullRequests = await api.get(
    "repos/slashdevcorpse/synara/pulls?state=open&per_page=100&base=main",
  );
  if (!Array.isArray(rawPullRequests))
    throw new Error("Downstream pull request response must be an array.");
  const activeSyncPullRequests: DriftPullRequest[] = rawPullRequests
    .map((rawPullRequest, index) => {
      const pullRequest = requireRecord(rawPullRequest, `pull request ${index}`);
      const head = requireRecord(pullRequest.head, `pull request ${index} head`);
      return {
        number: requireNumber(pullRequest.number, `pull request ${index} number`),
        branch: requireString(head.ref, `pull request ${index} branch`),
        url: requireString(pullRequest.html_url, `pull request ${index} URL`),
      };
    })
    .filter((pullRequest) => pullRequest.branch.startsWith("sync/upstream-"));

  const analysis = analyzeUpstreamDrift({
    lastAbsorbedSha,
    currentUpstreamSha,
    lastAcceptedOn,
    compareStatus: requireString(comparison.status, "comparison status"),
    mergeBaseSha: requireString(mergeBase.sha, "comparison merge-base SHA"),
    pendingCommitCount: requireNumber(comparison.ahead_by, "pending commit count"),
    commits,
    changedFiles,
    changedFilesTruncated: changedFiles.length >= 300,
    releases: await releasesAfterAuthority(
      api,
      lastAbsorbedSha,
      currentUpstreamSha,
      lastAcceptedOn,
    ),
    patches: loadPatches(),
    activeSyncPullRequests,
    now: new Date(),
  });
  writeFileSync(jsonOutput, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  writeFileSync(markdownOutput, renderUpstreamDriftMarkdown(analysis), "utf8");
  console.log(
    `Upstream drift report written: ${analysis.pendingCommitCount} pending commits, threshold=${analysis.syncThresholdReached}, failClosed=${analysis.failClosed}.`,
  );
}

if (import.meta.main) await main();
