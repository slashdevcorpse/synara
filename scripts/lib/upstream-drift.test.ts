import { describe, expect, it } from "vitest";

import {
  analyzeUpstreamDrift,
  renderUpstreamDriftMarkdown,
  type DriftInput,
} from "./upstream-drift";

const lastSha = "a".repeat(40);
const currentSha = "b".repeat(40);

const input = (overrides: Partial<DriftInput> = {}): DriftInput => ({
  lastAbsorbedSha: lastSha,
  currentUpstreamSha: currentSha,
  lastAcceptedOn: "2026-07-19",
  compareStatus: "ahead",
  mergeBaseSha: lastSha,
  pendingCommitCount: 1,
  commits: [{ sha: currentSha, message: "docs: update guide", url: "https://example.test/commit" }],
  changedFiles: ["docs/guide.md"],
  changedFilesTruncated: false,
  releases: [],
  patches: [],
  activeSyncPullRequests: [],
  now: new Date("2026-07-19T12:00:00Z"),
  ...overrides,
});

describe("upstream drift analysis", () => {
  it("keeps ordinary recent drift below the sync threshold", () => {
    const analysis = analyzeUpstreamDrift(input());
    expect(analysis.syncThresholdReached).toBe(false);
    expect(analysis.failClosed).toBe(false);
    expect(analysis.changedSubsystems).toEqual(["documentation"]);
  });

  it("reports patch intersections and critical thresholds", () => {
    const changedFile = "apps/server/src/provider/Layers/ProviderHealth.ts";
    const analysis = analyzeUpstreamDrift(
      input({
        pendingCommitCount: 51,
        commits: [
          {
            sha: currentSha,
            message: "fix(provider): repair Windows startup",
            url: "https://example.test",
          },
        ],
        changedFiles: [changedFile],
        releases: [{ tag: "v0.5.6", sha: currentSha, url: "https://example.test/release" }],
        patches: [
          {
            id: "provider-health",
            status: "upstream-pending",
            touchedFiles: [changedFile],
          },
        ],
      }),
    );
    expect(analysis.syncThresholdReached).toBe(true);
    expect(analysis.patchIntersections).toEqual([
      { patchId: "provider-health", files: [changedFile] },
    ]);
    expect(analysis.thresholdReasons).toContain("at least 50 commits are pending");
    expect(analysis.thresholdReasons).toContain("upstream published a release");
    expect(renderUpstreamDriftMarkdown(analysis)).toContain("SYNC ASSESSMENT REQUIRED");
  });

  it("fails closed for rewritten history or multiple active sync PRs", () => {
    const analysis = analyzeUpstreamDrift(
      input({
        compareStatus: "diverged",
        mergeBaseSha: "c".repeat(40),
        activeSyncPullRequests: [
          { number: 1, branch: "sync/upstream-a", url: "https://example.test/1" },
          { number: 2, branch: "sync/upstream-b", url: "https://example.test/2" },
        ],
      }),
    );
    expect(analysis.failClosed).toBe(true);
    expect(analysis.thresholdReasons).toContain(
      "upstream history is not a descendant of authority",
    );
    expect(analysis.thresholdReasons).toContain("more than one active sync PR exists");
    expect(renderUpstreamDriftMarkdown(analysis)).toContain("FAIL CLOSED");
  });
});
