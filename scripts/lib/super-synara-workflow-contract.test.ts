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
).replaceAll("\r\n", "\n");
const audit = readFileSync(
  resolve(repoRoot, ".github/workflows/super-synara-macos-signature-audit.yml"),
  "utf8",
).replaceAll("\r\n", "\n");

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
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replaceAll(
          "--mac-signature-allowlist scripts/super-synara-macos-signature-allowlist.json",
          "--mac-signature-allowlist forged.json",
        ),
        audit,
      ),
    ).toThrow("pass the reviewed macOS allowlist only for the combined scope");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "- name: Require reviewed macOS signature policy\n        if: ${{ steps.meta.outputs.include_macos == 'true' }}",
          "- name: Require reviewed macOS signature policy",
        ),
        audit,
      ),
    ).toThrow("macOS signature policy must gate only the combined release scope");
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

  it("requires exact native prerelease gates and rejects broad native suites", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "src/desktopIdentityProof.test.ts\n          src/windowsCertificate.test.ts",
          "src/forgedIdentityProof.test.ts\n          src/windowsCertificate.test.ts",
        ),
        audit,
      ),
    ).toThrow("windows_x64 must run exact native gate command");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "      - name: Validate workflow contracts\n        run: node scripts/verify-workflow-contracts.ts",
          "      - name: Validate workflow contracts\n        run: node scripts/verify-workflow-contracts.ts\n\n      - name: Unsafe broad Windows suite\n        run: bun run test",
        ),
        audit,
      ),
    ).toThrow("windows_x64 must not own an additional or chained monorepo-wide bun run test suite");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "      - name: Build unsigned macOS disk image",
          "      - name: Unsafe broad macOS suite\n        run: bun run test\n\n      - name: Build unsigned macOS disk image",
        ),
        audit,
      ),
    ).toThrow("macos_arm64 must not own an additional or chained monorepo-wide bun run test suite");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "lib/super-synara-macos-signatures.test.ts",
          "lib/forged-macos-signatures.test.ts",
        ),
        audit,
      ),
    ).toThrow("macos_arm64 must run exact native gate command");
  });

  it("binds prerelease suite ownership and native runners", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("      - name: Test\n        run: bun run test\n", ""),
        audit,
      ),
    ).toThrow("preflight must run exactly one bare bun run test suite");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "      - name: Test\n        run: bun run test",
          "      - name: Test\n        run: bun run test\n\n      - name: Duplicate full suite\n        run: bun run test",
        ),
        audit,
      ),
    ).toThrow("preflight must run exactly one bare bun run test suite");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("    runs-on: windows-2022", "    runs-on: ubuntu-24.04"),
        audit,
      ),
    ).toThrow("windows_x64 must run on windows-2022");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("    runs-on: macos-15", "    runs-on: ubuntu-24.04"),
        audit,
      ),
    ).toThrow("macos_arm64 must run on macos-15");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("  preflight:\n", "  preflight:\n    if: false\n"),
        audit,
      ),
    ).toThrow("preflight job must be unconditional and fail closed");

    const publishIndex = main.indexOf("\n  publish:");
    const chainedPublishSuite =
      main.slice(0, publishIndex) +
      main
        .slice(publishIndex)
        .replace(
          "    steps:\n",
          "    steps:\n      - name: Unsafe chained full suite\n        run: bun run test && echo done\n\n",
        );
    expect(() => verifySuperSynaraWorkflowText(chainedPublishSuite, audit)).toThrow(
      "publish must not own an additional or chained monorepo-wide bun run test suite",
    );
  });

  it("requires prerelease native gates and builds to fail closed in order", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "      - name: Validate workflow contracts\n        run: node scripts/verify-workflow-contracts.ts",
          "      - name: Validate workflow contracts\n        continue-on-error: true\n        run: node scripts/verify-workflow-contracts.ts",
        ),
        audit,
      ),
    ).toThrow("windows_x64 native gate must be unconditional and fail closed");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("  windows_x64:\n", "  windows_x64:\n    if: false\n"),
        audit,
      ),
    ).toThrow("windows_x64 job must be unconditional and fail closed");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "    if: ${{ needs.preflight.outputs.include_macos == 'true' }}",
          "    if: false",
        ),
        audit,
      ),
    ).toThrow("macos_arm64 job must use the exact release-scope condition");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("needs.macos_arm64.result == 'skipped'", "true"),
        audit,
      ),
    ).toThrow("publish job must fail closed over the exact selected native lanes");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("  publish:\n", "  publish:\n    continue-on-error: true\n"),
        audit,
      ),
    ).toThrow("publish job must fail closed");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("  publish:\n", "  publish:\n    continue-on-error: false\n"),
        audit,
      ),
    ).not.toThrow();

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "      - name: Download macOS lane\n        if: ${{ needs.preflight.outputs.include_macos == 'true' }}",
          "      - name: Download macOS lane",
        ),
        audit,
      ),
    ).toThrow("download macOS only for the combined release scope");

    const validatorStep =
      "      - name: Validate workflow contracts\n        run: node scripts/verify-workflow-contracts.ts\n\n";
    const reorderedValidator = main
      .replace(validatorStep, "")
      .replace("\n  macos_arm64:", `\n${validatorStep}  macos_arm64:`);
    expect(() => verifySuperSynaraWorkflowText(reorderedValidator, audit)).toThrow(
      "windows_x64 native gate must run before the native build",
    );

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "        shell: bash\n        env:\n          CSC_IDENTITY_AUTO_DISCOVERY",
          "        shell: bash\n        continue-on-error: true\n        env:\n          CSC_IDENTITY_AUTO_DISCOVERY",
        ),
        audit,
      ),
    ).toThrow("macos_arm64 native build must be unconditional and fail closed");
  });

  it("requires executable macOS architecture and package commands", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '          test "$(uname -m)" = arm64',
          '          # test "$(uname -m)" = arm64',
        ),
        audit,
      ),
    ).toThrow("prove arm64 host architecture in the native build step");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "          bun run dist:desktop:super:mac -- \\",
          "          echo bun run dist:desktop:super:mac -- \\",
        ),
        audit,
      ),
    ).toThrow("execute exactly one native build command");

    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '          test "$(uname -m)" = arm64',
          '          test "$(uname -m)" = arm64 || true',
        ),
        audit,
      ),
    ).toThrow("macos_arm64 native build must not mask shell failures");

    const outputDirectoryLine = "            --output-dir release-build";
    const macOutputDirectoryIndex = main.lastIndexOf(outputDirectoryLine);
    const maskedMacBuild =
      main.slice(0, macOutputDirectoryIndex) +
      `${outputDirectoryLine} || true` +
      main.slice(macOutputDirectoryIndex + outputDirectoryLine.length);
    expect(() => verifySuperSynaraWorkflowText(maskedMacBuild, audit)).toThrow(
      "macos_arm64 native build must not mask shell failures",
    );
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
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("default: windows-only", "default: windows-and-macos"),
        audit,
      ),
    ).toThrow("release-scope contract");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace('--release-scope "$RELEASE_SCOPE"', '--release-scope "windows-x64"'),
        audit,
      ),
    ).toThrow("bind the selected scope");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "            windows-only)\n              include_macos=false\n              asset_count=6",
          "            windows-only)\n              include_macos=true\n              asset_count=8",
        ),
        audit,
      ),
    ).toThrow("must map windows-only to include_macos=false and asset_count=6");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "            windows-and-macos)\n              include_macos=true\n              asset_count=8",
          "            windows-and-macos)\n              include_macos=false\n              asset_count=6",
        ),
        audit,
      ),
    ).toThrow("must map windows-and-macos to include_macos=true and asset_count=8");
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
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '"--report", (Join-Path $env:RUNNER_TEMP "windows-installer-qualification.json")',
          '"--report", "release-publish/forged.json"',
        ),
        audit,
      ),
    ).toThrow("Windows installer qualification contract");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '--windows-qualification-report "$qualification_report"',
          '--windows-qualification-report "forged.json"',
        ),
        audit,
      ),
    ).toThrow("Windows installer qualification contract");
  });

  it("rejects Windows provenance before qualification or transient report upload", () => {
    const provenanceStep = main.indexOf(
      "      - name: Write final Windows provenance from native qualification",
    );
    const qualificationStep = main.indexOf(
      "      - name: Qualify concurrent Windows side-by-side runtime, upgrade, and uninstall",
    );
    const provenanceEnd = main.indexOf("\n      - name:", provenanceStep + 1);
    const provenanceBlock = main.slice(provenanceStep, provenanceEnd);
    const reordered =
      main.slice(0, qualificationStep) +
      provenanceBlock +
      "\n" +
      main.slice(qualificationStep, provenanceStep) +
      main.slice(provenanceEnd);
    expect(() => verifySuperSynaraWorkflowText(reordered, audit)).toThrow(
      "must consume native qualification",
    );
    const uploadedProvenance = "release-publish/artifact-windows-x64.provenance.json";
    const uploadedProvenanceIndex = main.lastIndexOf(uploadedProvenance);
    const transientReportUpload =
      main.slice(0, uploadedProvenanceIndex + uploadedProvenance.length) +
      "\n            ${{ runner.temp }}/windows-installer-qualification.json" +
      main.slice(uploadedProvenanceIndex + uploadedProvenance.length);
    expect(() => verifySuperSynaraWorkflowText(transientReportUpload, audit)).toThrow(
      "must not be uploaded",
    );
  });

  it("rejects unprotected dispatches and weakened release labeling", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace('[[ "$REF_PROTECTED" == "true" ]]', "true"),
        audit,
      ),
    ).toThrow("dispatch ref is protected");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main,
        audit.replace('[[ "$REF_PROTECTED" == "true" ]]', "true"),
      ),
    ).toThrow("dispatch ref is protected");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "Unofficial downstream Super Synara $VERSION (unsigned prerelease)",
          "Super Synara $VERSION (unsigned prerelease)",
        ),
        audit,
      ),
    ).toThrow("unofficial downstream and unsigned prerelease");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "Unofficial downstream Super Synara $VERSION (unsigned prerelease)",
          "Unofficial downstream Super Synara $VERSION (prerelease)",
        ),
        audit,
      ),
    ).toThrow("unofficial downstream and unsigned prerelease");
  });

  it("rejects production-default startup smoke and ZIP-only macOS evidence", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(main.replace("--flavor super", "--flavor production"), audit),
    ).toThrow("startup verification must select Super flavor");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace("--flavor super \\", "--flavor-removed \\"),
        audit,
      ),
    ).toThrow("startup verification must select Super flavor");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace('--dmg "$disk_image"', '--zip "${zips[0]}"'),
        audit,
      ),
    ).toThrow("inspect the exact final DMG");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main,
        audit.replace('--dmg "${dmgs[0]}"', '--zip "${zips[0]}"'),
      ),
    ).toThrow("inspect the built DMG directly");
  });

  it("rejects an audit detached from protected main or mislabeled as publication", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main,
        audit.replace('[[ "$SOURCE_SHA" == "$REF_SHA" ]]', "true"),
      ),
    ).toThrow("Audit source contract");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main,
        audit.replace("build-only", "github-unsigned-prerelease"),
      ),
    ).toThrow("Audit source contract");
  });
});
