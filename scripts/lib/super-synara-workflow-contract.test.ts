import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  verifySuperSynaraWorkflowContracts,
  verifySuperSynaraWorkflowText,
} from "./super-synara-workflow-contract.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const main = readFileSync(
  resolve(repoRoot, ".github/workflows/super-synara-prerelease.yml"),
  "utf8",
);
const audit = readFileSync(
  resolve(repoRoot, ".github/workflows/super-synara-macos-signature-audit.yml"),
  "utf8",
);

describe("Super Synara workflow contracts", () => {
  it("admits the manual fail-closed workflow pair", () => {
    expect(() => verifySuperSynaraWorkflowContracts(repoRoot)).not.toThrow();
  });

  it("rejects automatic triggers and mutable action tags", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(main.replace("workflow_dispatch:", "push:"), audit),
    ).toThrow("manual-only");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
          "actions/checkout@v6",
        ),
        audit,
      ),
    ).toThrow("not pinned to a full commit");
  });

  it("rejects removal of the reviewed allowlist gate", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("verify-super-synara-macos-allowlist.ts", "allowlist-check-removed.ts"),
        audit,
      ),
    ).toThrow("missing or placeholder macOS signature policy");
  });

  it("rejects root Playwright lookup and missing source-cleanliness checks", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "cd apps/web && ./node_modules/.bin/playwright install --with-deps chromium",
          "./node_modules/.bin/playwright install --with-deps chromium",
        ),
        audit,
      ),
    ).toThrow("workspace-local Playwright binary");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replaceAll(
          "node scripts/verify-release-worktree-clean.ts",
          "node scripts/source-check-removed.ts",
        ),
        audit,
      ),
    ).toThrow("source cleanliness");
  });

  it("rejects drift from the plan-locked dispatch interface", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(main.replace("confirm_unsigned:", "confirm_release:"), audit),
    ).toThrow("confirmation input");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace('[[ "$TAG" == "super-v$VERSION" ]]', "true"),
        audit,
      ),
    ).toThrow("explicit tag matches the version");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("group: super-synara-prerelease", "group: alternate-release"),
        audit,
      ),
    ).toThrow("plan-locked concurrency group");
  });

  it("rejects removal of native Windows installer lifecycle qualification", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "qualify-super-synara-windows-installer.ts",
          "qualification-script-removed.ts",
        ),
        audit,
      ),
    ).toThrow("Windows installer qualification contract");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("--repo Emanuele-web04/synara", "--repo untrusted/fork"),
        audit,
      ),
    ).toThrow("Windows installer qualification contract");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("--current-version $env:VERSION", "--current-version 0.0.0-super.1"),
        audit,
      ),
    ).toThrow("bind both upstream-core and previous-release selection");
  });
});
