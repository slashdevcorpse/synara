import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  verifySuperSynaraGithubStateScriptText,
  verifySuperSynaraReleasePlannerScriptText,
  verifySuperSynaraReleaseDrafterText,
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
const releaseDrafter = readFileSync(
  resolve(repoRoot, ".github/workflows/release-drafter.yml"),
  "utf8",
).replaceAll("\r\n", "\n");
const releaseDrafterConfig = readFileSync(
  resolve(repoRoot, ".github/release-drafter.yml"),
  "utf8",
).replaceAll("\r\n", "\n");
const githubStateScript = readFileSync(
  resolve(repoRoot, "scripts/verify-super-synara-github-state.ts"),
  "utf8",
).replaceAll("\r\n", "\n");
const releasePlannerScript = readFileSync(
  resolve(repoRoot, "scripts/plan-super-synara-release-drafter.ts"),
  "utf8",
).replaceAll("\r\n", "\n");

describe("Super Synara workflow contracts", () => {
  it("admits the controller-called publication and manual audit workflows", () => {
    expect(() => verifySuperSynaraWorkflowContracts(repoRoot)).not.toThrow();
  });

  it("requires bounded fail-closed GitHub release visibility polling", () => {
    expect(() => verifySuperSynaraGithubStateScriptText(githubStateScript)).not.toThrow();
    expect(() =>
      verifySuperSynaraGithubStateScriptText(
        githubStateScript.replace(
          "const visibilityAttempts = 30;",
          "const visibilityAttempts = 1;",
        ),
      ),
    ).toThrow(/retry visibility boundedly|bounded polling delays/);
    expect(() =>
      verifySuperSynaraGithubStateScriptText(
        githubStateScript.replace(
          "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);",
          "return;",
        ),
      ),
    ).toThrow(/retry visibility boundedly|bounded polling delays/);
    expect(() =>
      verifySuperSynaraGithubStateScriptText(
        githubStateScript.replace("  try {\n    const refJson", "  const refJson"),
      ),
    ).toThrow("retry visibility boundedly");
  });

  it("validates release versions before any GitHub API request", () => {
    expect(() => verifySuperSynaraReleasePlannerScriptText(releasePlannerScript)).not.toThrow();
    expect(() =>
      verifySuperSynaraReleasePlannerScriptText(
        releasePlannerScript.replace("assertSuperSynaraCoreVersion(coreVersion);", ""),
      ),
    ).toThrow("before constructing a GitHub API request");
    expect(() =>
      verifySuperSynaraReleasePlannerScriptText(
        releasePlannerScript.replace("parseSuperSynaraReleasePages(", "trustReleasePages("),
      ),
    ).toThrow("decode release pages");
  });

  it("rejects direct publication triggers and mutable action tags", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(main.replace("workflow_call:", "workflow_dispatch:"), audit),
    ).toThrow("callable only by its protected-main controller");
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

  it("adopts only the exact planned Release Drafter draft", () => {
    for (const [binding, replacement] of [
      [
        'gh api "repos/$GITHUB_REPOSITORY/releases/$DRAFT_ID"',
        'gh api "repos/$GITHUB_REPOSITORY/releases/latest"',
      ],
      [
        '[[ "$(jq -r .tag_name <<< "$release")" == "$TAG" ]]',
        '[[ "$(jq -r .tag_name <<< "$release")" == "$FORGED_TAG" ]]',
      ],
      [
        '[[ "$(jq -r .target_commitish <<< "$release")" == "$SOURCE_COMMIT" ]]',
        '[[ "$(jq -r .target_commitish <<< "$release")" == "$FORGED_COMMIT" ]]',
      ],
      ['echo "id=$DRAFT_ID"', 'echo "id=$FORGED_DRAFT_ID"'],
    ] as const) {
      expect(() =>
        verifySuperSynaraWorkflowText(main.replace(binding, replacement), audit),
      ).toThrow("adopt only the exact planned Release Drafter draft ID, tag, and source SHA");
    }
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "      - id: draft\n        name: Adopt exact owned Release Drafter draft",
          "      - id: draft\n        name: Create owned draft prerelease",
        ),
        audit,
      ),
    ).toThrow("exact Release Drafter adoption step");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '          release="$(gh api "repos/$GITHUB_REPOSITORY/releases/$DRAFT_ID")"',
          '          gh release create "$TAG"\n          release="$(gh api "repos/$GITHUB_REPOSITORY/releases/$DRAFT_ID")"',
        ),
        audit,
      ),
    ).toThrow("must never create an arbitrary release draft");
  });

  it("makes no-change schedules unable to reach Release Drafter or dispatch", () => {
    expect(() =>
      verifySuperSynaraReleaseDrafterText(releaseDrafter, releaseDrafterConfig),
    ).not.toThrow();
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter.replace(
          "        if: steps.changes.outputs.should_release == 'true'\n        uses: release-drafter/",
          "        if: always()\n        uses: release-drafter/",
        ),
        releaseDrafterConfig,
      ),
    ).toThrow("gated on changes");
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter.replace(
          'echo "should_release=false" >> "$GITHUB_OUTPUT"',
          'echo "should_release=true" >> "$GITHUB_OUTPUT"',
        ),
        releaseDrafterConfig,
      ),
    ).toThrow("no-change gate must fail closed");
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter.replace(
          '          commit_count="$(git rev-list --count "$LATEST_TAG_COMMIT..$SOURCE_SHA")"',
          '          if [[ "$EVENT_NAME" == "push" ]]; then echo "should_release=true" >> "$GITHUB_OUTPUT"; exit 0; fi\n          commit_count="$(git rev-list --count "$LATEST_TAG_COMMIT..$SOURCE_SHA")"',
        ),
        releaseDrafterConfig,
      ),
    ).toThrow("must not bypass commit counting for push reruns");
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter.replace('[[ "$ACTOR" == "$OWNER" ]]', "true"),
        releaseDrafterConfig,
      ),
    ).toThrow("authorize the real owner before any draft mutation");
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter.replace('[[ "$TRIGGERING_ACTOR" == "$OWNER" ]]', "true"),
        releaseDrafterConfig,
      ),
    ).toThrow(/authorize the real owner|authorize and preserve the real triggering owner/);
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter.replace(
          "uses: ./.github/workflows/super-synara-prerelease.yml",
          "uses: attacker/release-workflow/.github/workflows/publish.yml@main",
        ),
        releaseDrafterConfig,
      ),
    ).toThrow(/not pinned|local publisher/);
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter.replace(
          "if: ${{ github.event_name != 'push' && needs.draft.outputs.should_release == 'true' }}",
          "if: ${{ github.event_name != 'push' }}",
        ),
        releaseDrafterConfig,
      ),
    ).toThrow("dispatch must be unreachable for pushes and no-change schedules");
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter.replace(
          "release_scope: ${{ github.event_name == 'workflow_dispatch' && inputs.release_scope || 'windows-only' }}",
          "release_scope: windows-and-macos",
        ),
        releaseDrafterConfig,
      ),
    ).toThrow("exact draft identity and least privilege");
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter.replace("    needs: draft", "    needs: unrelated"),
        releaseDrafterConfig,
      ),
    ).toThrow("exact draft identity and least privilege");
    expect(() =>
      verifySuperSynaraReleaseDrafterText(
        releaseDrafter,
        releaseDrafterConfig.replace(
          "$PREVIOUS_TAG...super-v$RESOLVED_VERSION",
          "$PREVIOUS_TAG...$RESOLVED_VERSION",
        ),
      ),
    ).toThrow("super-v$RESOLVED_VERSION");
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
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "\n      - name: Verify preflight preserved source\n        run: node scripts/verify-release-worktree-clean.ts",
          "",
        ),
        audit,
      ),
    ).toThrow(
      "preflight must verify source cleanliness after install and after all preflight execution",
    );
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "\n  windows_x64:",
          "\n      - name: Mutate source after final check\n        run: echo dirty >> package.json\n\n  windows_x64:",
        ),
        audit,
      ),
    ).toThrow("source-cleanliness checks must be ordered and fail closed");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "      - name: Install dependencies\n        run: bun install --frozen-lockfile",
          "      - name: Install dependencies\n        continue-on-error: true\n        run: bun install --frozen-lockfile",
        ),
        audit,
      ),
    ).toThrow(
      "install, release smoke, and source-cleanliness checks must be ordered and fail closed",
    );
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "      - name: Run release contract smoke tests\n        run: bun run release:smoke",
          "      - name: Run release contract smoke tests\n        if: false\n        run: bun run release:smoke",
        ),
        audit,
      ),
    ).toThrow(
      "install, release smoke, and source-cleanliness checks must be ordered and fail closed",
    );
  });

  it("requires preflight route generation outside tracked source", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '\n      - name: Isolate generated route tree\n        shell: bash\n        run: |\n          set -euo pipefail\n          printf \'SYNARA_GENERATED_ROUTE_TREE=%s\\n\' "$RUNNER_TEMP/super-synara-preflight-route-tree/routeTree.gen.ts" >> "$GITHUB_ENV"\n',
          "",
        ),
        audit,
      ),
    ).toThrow("preflight must redirect route generation outside tracked source");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "$RUNNER_TEMP/super-synara-preflight-route-tree/routeTree.gen.ts",
          "apps/web/src/routeTree.gen.ts",
        ),
        audit,
      ),
    ).toThrow("preflight must redirect route generation outside tracked source");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          "      - name: Run stable browser tests\n        run: bun run --cwd apps/web test:browser:stable",
          "      - name: Run stable browser tests\n        env:\n          SYNARA_GENERATED_ROUTE_TREE: apps/web/src/routeTree.gen.ts\n        run: bun run --cwd apps/web test:browser:stable",
        ),
        audit,
      ),
    ).toThrow("preflight steps must not override the isolated route-tree path");
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
        main.replace(
          "permissions:\n  contents: read",
          "permissions:\n  contents: read\n\nconcurrency:\n  group: alternate-release",
        ),
        audit,
      ),
    ).toThrow("inherit controller serialization");
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

    const exactScopeArms = `            windows-only)
              include_macos=false
              asset_count=6
              ;;
            windows-and-macos)
              include_macos=true
              asset_count=8
              ;;
            *)
              echo "Unsupported release scope: $RELEASE_SCOPE" >&2
              exit 1
              ;;`;
    const wildcardFirstScopeArms = `            *)
              echo "Unsupported release scope: $RELEASE_SCOPE" >&2
              exit 1
              ;;
            windows-only)
              include_macos=false
              asset_count=6
              ;;
            windows-and-macos)
              include_macos=true
              asset_count=8
              ;;`;
    expect(() =>
      verifySuperSynaraWorkflowText(main.replace(exactScopeArms, wildcardFirstScopeArms), audit),
    ).toThrow("exact ordered windows-only, windows-and-macos, and rejecting wildcard arms");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '              echo "Unsupported release scope: $RELEASE_SCOPE" >&2\n              exit 1',
          "              include_macos=false\n              asset_count=6",
        ),
        audit,
      ),
    ).toThrow("must map *");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '          case "$RELEASE_SCOPE" in',
          '          RELEASE_SCOPE=windows-and-macos\n          case "$RELEASE_SCOPE" in',
        ),
        audit,
      ),
    ).toThrow("complete scope metadata data flow");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '          esac\n          echo "version=$VERSION"',
          '          esac\n          include_macos=true\n          asset_count=8\n          echo "version=$VERSION"',
        ),
        audit,
      ),
    ).toThrow("complete scope metadata data flow");
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

  it("rejects unprotected dispatches and weakened exact-source ownership", () => {
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
        main.replace('[[ "$WORKFLOW_SOURCE_SHA" == "$EXPECTED_SOURCE_SHA" ]]', "true"),
        audit,
      ),
    ).toThrow("complete scope metadata data flow");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace('[[ "$RELEASE_DRAFT_ID" =~ ^[1-9][0-9]*$ ]]', "true"),
        audit,
      ),
    ).toThrow("complete scope metadata data flow");
  });

  it("rejects a publication path that cannot safely retry partial asset uploads", () => {
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(
          '[[ -n "${expected_names[$existing_name]+present}" ]]',
          '[[ -n "$existing_name" ]]',
        ),
        audit,
      ),
    ).toThrow("reject unexpected existing draft assets");
    expect(() =>
      verifySuperSynaraWorkflowText(
        main.replace(' --repo "$GITHUB_REPOSITORY" --clobber', ' --repo "$GITHUB_REPOSITORY"'),
        audit,
      ),
    ).toThrow("replace only the exact expected assets");
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
