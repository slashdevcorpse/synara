import { describe, expect, it } from "vitest";

import {
  parseJsonCompatibleYaml,
  validateDownstreamState,
  type DownstreamValidationContext,
} from "./downstream-state";

const previousSha = "a".repeat(40);
const effectiveSha = "b".repeat(40);
const patchSha = "c".repeat(40);
const headSha = "d".repeat(40);
const assessmentPath = "docs/downstream/syncs/baseline.md";
const assessment = [
  `Previous upstream SHA: \`${previousSha}\``,
  `Effective upstream SHA: \`${effectiveSha}\``,
  "Classification complete: **yes**",
  `Rollback SHA: \`${previousSha}\``,
].join("\n");

const validInventory = () => ({
  schemaVersion: 1,
  repository: "slashdevcorpse/synara",
  canonicalUpstream: "Emanuele-web04/synara",
  verifiedOn: "2026-07-19",
  patches: [
    {
      id: "windows-example-fix",
      purpose: "Keep Windows startup reliable.",
      userVisibleConsequence: "The provider starts consistently.",
      owner: "slashdevcorpse",
      status: "upstream-pending",
      introducingCommit: patchSha,
      touchedFiles: ["apps/server/src/example.ts"],
      subsystems: ["provider-startup"],
      regressionTests: ["apps/server/src/example.test.ts"],
      upstreamLinks: ["https://github.com/Emanuele-web04/synara/pull/1"],
      overlapResolutionPolicy: "Reconcile provider lifecycle changes semantically.",
      lastAssessedUpstreamSha: effectiveSha,
      verificationDate: "2026-07-19",
      retirementCondition: "Retire after equivalent upstream coverage is absorbed.",
      statusHistory: [
        {
          status: "downstream-only",
          date: "2026-07-18",
          evidence: "Downstream commit",
        },
        {
          status: "upstream-pending",
          date: "2026-07-19",
          evidence: "Upstream PR opened",
        },
      ],
    },
  ],
});

const validState = () => ({
  schemaVersion: 1,
  repository: "slashdevcorpse/synara",
  canonicalUpstream: "Emanuele-web04/synara",
  lastEffectiveUpstreamSha: effectiveSha,
  lastVerifiedOn: "2026-07-19",
  acceptedSyncs: [
    {
      id: "baseline",
      previousUpstreamSha: previousSha,
      effectiveUpstreamSha: effectiveSha,
      downstreamCommit: headSha,
      integrationMethod: "fast-forward",
      pullRequest: null,
      assessmentPath,
      acceptedOn: "2026-07-19",
      rollbackSha: previousSha,
      classificationComplete: true,
    },
  ],
  activeRevertedRanges: [],
  activeExcludedRanges: [],
});

function context(
  overrides: Partial<DownstreamValidationContext> = {},
): DownstreamValidationContext {
  const knownCommits = new Set([previousSha, effectiveSha, patchSha, headSha]);
  const ancestry = new Set([`${previousSha}>${effectiveSha}`, `${effectiveSha}>${headSha}`]);
  return {
    commits: {
      headSha,
      commitExists: (sha) => knownCommits.has(sha),
      isAncestor: (ancestor, descendant) =>
        ancestor === descendant || ancestry.has(`${ancestor}>${descendant}`),
    },
    assessments: {
      exists: (path) => path === assessmentPath,
      read: () => assessment,
    },
    ...overrides,
  };
}

describe("downstream state validator", () => {
  it("accepts a complete inventory, sync chain, assessment, and commit graph", () => {
    const result = validateDownstreamState(validInventory(), validState(), context());
    expect(result.errors).toEqual([]);
    expect(result.patchCount).toBe(1);
    expect(result.syncCount).toBe(1);
    expect(result.lastEffectiveUpstreamSha).toBe(effectiveSha);
  });

  it("rejects duplicate patch IDs and missing permanent patch fields", () => {
    const inventory = validInventory();
    inventory.patches.push({
      ...inventory.patches[0]!,
      purpose: "",
      regressionTests: [],
      retirementCondition: "",
    });
    const errors = validateDownstreamState(inventory, validState(), context()).errors.join("\n");
    expect(errors).toContain("duplicates windows-example-fix");
    expect(errors).toContain("purpose must be a non-empty string");
    expect(errors).toContain("regressionTests must contain at least one entry");
    expect(errors).toContain("retirementCondition must be a non-empty string");
  });

  it("rejects invalid and inconsistent status transitions", () => {
    const inventory = validInventory();
    inventory.patches[0]!.status = "retired";
    inventory.patches[0]!.statusHistory = [
      { status: "retired", date: "2026-07-18", evidence: "Retired" },
      { status: "downstream-only", date: "2026-07-19", evidence: "Invalid revival" },
    ];
    const errors = validateDownstreamState(inventory, validState(), context()).errors.join("\n");
    expect(errors).toContain("invalid status transition retired>downstream-only");
    expect(errors).toContain("must end with current status retired");
  });

  it("rejects missing commits and an assessed SHA that differs from release authority", () => {
    const inventory = validInventory();
    inventory.patches[0]!.introducingCommit = "e".repeat(40);
    inventory.patches[0]!.lastAssessedUpstreamSha = previousSha;
    const errors = validateDownstreamState(inventory, validState(), context()).errors.join("\n");
    expect(errors).toContain(`references missing commit ${"e".repeat(40)}`);
    expect(errors).toContain(`must equal state authority ${effectiveSha}`);
  });

  it("rejects a broken sync chain and an incomplete assessment", () => {
    const state = validState();
    state.acceptedSyncs[0]!.classificationComplete = false;
    const brokenContext = context({
      assessments: { exists: () => true, read: () => "Classification complete: **no**" },
    });
    const errors = validateDownstreamState(validInventory(), state, brokenContext).errors.join(
      "\n",
    );
    expect(errors).toContain("assessmentPath is missing required marker");
    expect(errors).toContain("classificationComplete must be true");
  });

  it("validates active revert and exclusion range ancestry", () => {
    const state = validState();
    state.activeRevertedRanges = [
      {
        id: "bad-order",
        fromSha: effectiveSha,
        toSha: previousSha,
        reason: "Regression",
        evidence: "https://github.com/slashdevcorpse/synara/issues/1",
        recordedOn: "2026-07-19",
      },
    ];
    const errors = validateDownstreamState(validInventory(), state, context()).errors.join("\n");
    expect(errors).toContain("must describe an ancestry-ordered commit range");
  });

  it("parses YAML and reports invalid syntax clearly", () => {
    expect(parseJsonCompatibleYaml("schemaVersion: 1", "patches.yml")).toEqual({
      schemaVersion: 1,
    });
    expect(() => parseJsonCompatibleYaml("schemaVersion: [", "patches.yml")).toThrow(
      "must contain valid YAML",
    );
  });
});
