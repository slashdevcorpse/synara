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
});
