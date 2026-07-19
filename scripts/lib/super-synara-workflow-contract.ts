// FILE: super-synara-workflow-contract.ts
// Purpose: Guards the manual unsigned prerelease and read-only macOS inventory workflows.
// Layer: Release workflow contract

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function requireText(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) throw new Error(message);
}

function prohibitText(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) throw new Error(message);
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
  requireText(main, "runs-on: windows-2022", "Windows publication must use windows-2022.");
  requireText(main, "runs-on: macos-15", "macOS publication must use macos-15.");
  requireText(
    main,
    'test "$(uname -m)" = arm64',
    "macOS publication must prove arm64 host architecture.",
  );
  requireText(
    main,
    "environment: super-synara-prerelease",
    "Publication must use the protected Super Synara environment.",
  );
  requireText(
    main,
    "confirm_unsigned_publication:",
    "Unsigned public publication must require an explicit confirmation input.",
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
    "collect-super-synara-macos-signatures.ts",
    "macOS publication must collect signature evidence.",
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
  requireText(main, '[[ "${#assets[@]}" -eq 8 ]]', "Publication must upload exactly eight files.");
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

  requireText(audit, "permissions:\n  contents: read", "Audit must be read-only.");
  requireText(audit, 'test "$(uname -m)" = arm64', "Audit must prove arm64 host architecture.");
  prohibitText(audit, "contents: write", "Audit must not receive write permission.");
  requireText(audit, "--mode audit", "Audit must emit unclassified inventory evidence.");
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
