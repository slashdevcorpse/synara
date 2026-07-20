# Plan — Super Synara local downstream and unsigned downloads

> Status: **IMPLEMENTED — Windows-first release path active; combined macOS admission deferred**
> Downstream repository: `slashdevcorpse/synara` (public fork)
> Canonical upstream: `Emanuele-web04/synara`
> Primary use: a personal Windows build with durable public downloads
> Current download: Windows x64; macOS Apple Silicon (arm64) is an optional combined scope
> Release trigger: manual GitHub Actions dispatch only

## 1. Outcome

Maintain **Super Synara** as an isolated downstream application that can:

1. carry Windows fixes, performance work, and other custom enhancements;
2. repeatedly absorb upstream Synara changes without rewriting released history;
3. run PR/push validation on standard GitHub-hosted runners;
4. produce manually triggered, persistent GitHub prerelease downloads for Windows x64, with an
   optional combined macOS arm64 lane after its separate admission is ready; and
5. coexist with upstream Synara without overwriting its install, state, protocol, or updater.

This is locally and operationally feasible. A public GitHub repository can use standard hosted
runners without Actions-minute charges. No larger runners, Azure Trusted Signing, Apple signing,
or notarization are required for this personal-use channel.

The resulting files are still a **public software distribution**, even if they are intended only
as convenient downloads. They must therefore be represented honestly as unsigned public
prereleases, not as unpublished or verified-signed artifacts.

## 2. Locked decisions

| Area               | Decision                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Product name       | `Super Synara`                                                                                                                   |
| Repository         | Public fork at `slashdevcorpse/synara`                                                                                           |
| Primary platform   | Windows x64                                                                                                                      |
| Optional platform  | macOS Apple Silicon / arm64 through the explicitly selected combined scope                                                       |
| Excluded downloads | Linux, macOS Intel/x64, universal macOS                                                                                          |
| CI hosts           | Standard `ubuntu-24.04`, `windows-2022`, and ARM64 `macos-15` runners only                                                       |
| Linux meaning      | Ubuntu may run portable CI; no Linux application is packaged or published                                                        |
| Publication        | Persistent GitHub prerelease assets                                                                                              |
| Trigger            | `workflow_dispatch` only; never automatic on tag or push                                                                         |
| Signing            | No Azure/Authenticode, Apple Developer ID, or notarization; macOS ad-hoc signatures are recorded, not treated as trusted signing |
| Updates            | Manual download only; automatic updater disabled and no updater feed published                                                   |
| Upstream intake    | Reviewed merge commits from upstream through sync PRs                                                                            |
| Downstream history | Protected, never rebased or force-pushed after publication                                                                       |
| License            | Retain upstream MIT license and attribution                                                                                      |

## 3. Current-state evidence (2026-07-18)

- The fork is public and the authenticated user has administrator access.
- GitHub Actions is allowed, but the inherited workflows have not yet been activated on the fork;
  the fork currently reports no registered workflows or runs.
- The fork has no Actions secrets, variables, environments, or releases.
- The default workflow token permission is read-only.
- Artifact/log retention is 90 days, but Actions artifacts are not the durable download channel.
- The checkout's remote names are reversed from the normal fork convention:
  - `origin` points to `Emanuele-web04/synara`;
  - `fork` points to `slashdevcorpse/synara`.
- At inspection, fork `main` was 13 commits behind upstream and 0 commits ahead. The initial sync
  can therefore be a fast-forward if that remains true when implementation starts.
- Upstream is extremely active: more than 400 commits landed in the preceding 30 days. A
  repeatable intake process is a product requirement, not optional maintenance.
- The current CI already covers format, lint, typecheck, full Vitest, browser tests, a desktop
  build, Windows process regressions, and release smoke.
- The current formal release workflow packages Linux, macOS arm64, macOS x64, and Windows, and
  assumes Azure and Apple signing, updater metadata, formal release provenance, and post-release
  work. It must not be weakened or reused for this unsigned channel.
- The current workflow uses `macos-14` for arm64, but GitHub began deprecating that image on
  2026-07-06 and ends support on 2026-11-02. New Super Synara workflows use the free standard ARM64
  `macos-15` label instead.
- The current provenance code correctly rejects unsigned publication. Claiming
  `publication: false` for public prerelease assets would be inaccurate.
- Desktop packaging currently derives an update repository from `GITHUB_REPOSITORY`, so a fork
  build would accidentally discover a fork updater feed unless updates are explicitly disabled.
- Production package identity and the Windows installer GUID are currently shared constants. A
  renamed artifact alone would still collide with upstream Synara.
- Existing local modifications in `bun.lock` and
  `apps/web/public/mockServiceWorker.js` predate this plan and must remain untouched.

## 4. Scope

### In scope

- A distinct `super` desktop flavor and collision-free installed identity.
- PR and push CI on standard public-repository runners.
- Full Windows-specific regression coverage and packaged Windows verification.
- Apple Silicon macOS build and packaged smoke coverage.
- A separate manual unsigned-prerelease workflow.
- Checksums, provenance, license, and explicit unsigned-install documentation.
- A merge-based upstream synchronization procedure.
- A machine-readable downstream patch inventory and sync assessments.
- A read-only upstream drift watcher.
- Safe state-copy and migration validation before absorbing persistence changes.

### Out of scope

- Linux application downloads.
- Intel or universal macOS application downloads.
- Azure Trusted Signing, Authenticode certificates, Apple Developer ID, or notarization.
- Automatic updates for unsigned builds.
- Publishing to npm or another package registry.
- A stable/Latest GitHub release.
- Automatic upstream merging.
- Automatic public releases on push or tag creation.
- Renaming internal `@synara/*` packages or all `SYNARA_*` environment variables; keeping these
  reduces permanent merge conflicts and does not create installed-app collisions.
- Consumer-grade installation without operating-system warnings.

## 5. Installed identity and state isolation

Add `super` as a fourth desktop flavor beside production, development, and canary. Freeze these
values for implementation:

| Identity surface              | Super Synara value                     |
| ----------------------------- | -------------------------------------- |
| Flavor key                    | `super`                                |
| Display/product name          | `Super Synara`                         |
| Artifact prefix               | `Super-Synara`                         |
| Bundle ID / App User Model ID | `io.github.slashdevcorpse.supersynara` |
| Renderer scheme               | `super-synara`                         |
| Renderer origin               | `super-synara://app`                   |
| Renderer entry URL            | `super-synara://app/index.html`        |
| Electron user-data directory  | `super-synara`                         |
| Default backend home          | `.super-synara`                        |
| Windows NSIS GUID             | `ab3ea852-4edf-4caa-977e-9d00ccab2b1e` |
| Update strategy               | `manual` / disabled                    |

Implementation requirements:

1. Extend `packages/shared/src/desktopIdentity.ts` with the flavor and identity values. Preserve
   every existing production/development/canary value unchanged.
2. Bake the selected packaged flavor into the desktop main bundle in
   `apps/desktop/tsdown.config.ts`; packaged identity must not depend on a user's runtime
   environment variable.
3. Add the flavor build input to `turbo.json` cache inputs so a cached Synara bundle can never be
   placed into a Super Synara package.
4. Make `apps/desktop/src/main.ts` resolve the baked flavor for packaged builds. Environment-based
   selection remains appropriate for development only.
5. Add `super-synara://app` to the server's packaged trusted origins.
6. Parameterize `scripts/build-desktop-artifact.ts` and
   `scripts/lib/desktop-platform-build-config.ts` by desktop identity, including product name,
   app/bundle ID, artifact name, executable lookup, and NSIS GUID.
7. Make packaged-startup verification derive executable/application paths from identity instead
   of assuming `Synara.exe`.
8. Add tests for every identity surface and explicitly assert that stable Synara values did not
   change.
9. Include the root `LICENSE` in the packaged distribution and public prerelease assets. Keep the
   upstream copyright notice intact and identify Super Synara as an unofficial downstream.
10. Update only downstream-facing download, support, About, and installation copy. Do not perform
    a broad internal symbol/package rename.

### State rule

Super Synara must never open, migrate, or write upstream Synara's live `.synara` home or Electron
profile. Any future migration/import from Synara must be an explicit, one-way operation against a
backup or copied home. Side-by-side installation and side-by-side running are acceptance gates.

## 6. Repository and branch model

### Remote normalization

During a coordinated maintenance window, normalize the shared repository remotes:

```text
origin   -> https://github.com/slashdevcorpse/synara.git
upstream -> https://github.com/Emanuele-web04/synara.git
```

Give `upstream` a deliberately unusable push URL or otherwise enforce fetch-only use. This checkout
has many linked worktrees, so remote renaming must be performed once, after checking every branch's
tracking configuration. It must not be done opportunistically from one worktree.

### Branch roles

- `main`: protected Super Synara product trunk and only releasable branch.
- `sync/upstream-YYYYMMDD-<sha7>`: one upstream intake batch.
- `windows/<slug>`, `perf/<slug>`, `fix/<slug>`, `feat/<slug>`: focused downstream work.
- `upstream/<issue>-<slug>`: clean contribution based directly on `upstream/main`.
- `revert/upstream-<sha7>`: rollback of an accepted upstream sync.

Rules:

- Sync PRs use merge commits. Never squash or rebase them; the upstream parent relationship is
  evidence that a range was absorbed.
- Focused downstream PRs may be squash-merged into one logical patch.
- Never force-push or rebase a published downstream `main`.
- Never commit directly to upstream.
- The first sync may fast-forward only if the fork is still zero commits ahead. After downstream
  work begins, all syncs go through merge-commit PRs.

### `main` ruleset

- Require the selected CI checks before merge.
- Block force pushes and deletion.
- Require PRs for code/workflow changes, without requiring an unavailable second maintainer.
- Require conversations to be resolved.
- Limit workflow changes and manual prerelease dispatch to the repository owner.
- Allow no broad bypass except a documented emergency path.

## 7. Downstream patch inventory

Add `docs/downstream/patches.yml` as the machine-readable source of truth. Each logical patch—not
each PR—records:

- stable patch ID;
- purpose and user-visible consequence;
- owner;
- status: `downstream-only`, `upstream-pending`, `upstreamed`, `superseded`, `deferred`, or
  `retired`;
- introducing downstream commit;
- touched files and subsystems;
- permanent regression tests;
- upstream issue/PR links;
- overlap-resolution policy;
- last upstream SHA assessed;
- verification date; and
- retirement condition.

Store one human-readable assessment per sync under `docs/downstream/syncs/`. It records the old
and new upstream SHAs, upstream releases/PRs/commits reviewed, patch intersections, persistence or
protocol risks, conflict decisions, verification links, and rollback SHA.

Add `docs/downstream/upstream-state.json` as the machine-readable release authority. It contains a
schema version, the last effective upstream SHA, accepted sync PR/assessment records, and active
reverted/excluded upstream ranges. A sync PR stages its target value; it becomes authoritative only
when that file reaches protected `main`. Add a CI validator for both state files. It must enforce unique
patch IDs, valid statuses/transitions, required owner/test/retirement fields, real referenced
commits, assessed-SHA consistency, and valid full upstream SHAs.

“Fully absorbed through `<sha>`” has a strict meaning:

1. `<sha>` is an ancestor of downstream `main`;
2. every upstream commit/PR in the range was classified;
3. every semantic overlap with a downstream patch has an explicit decision; and
4. no conflict resolution silently discarded upstream behavior; and
5. `upstream-state.json` has no active revert or exclusion within the asserted range.

Seed the first inventory from the verified current state:

- PRs #394, #395, and #398 are already merged upstream and should arrive through the baseline,
  never as reapplied downstream patches.
- Open upstream PRs #396, #397, #419, #420, and #421 require assessment.
- Split #396 into logical patches for migration backup, SQLite overlay ownership, and initialization
  timeout behavior. Record that #419 substantially overlaps/supersedes #396's migration-backup
  portion rather than treating either PR as one indivisible patch.

## 8. Upstream drift and synchronization

### Non-merging drift watcher

Add `.github/workflows/upstream-watch.yml` with `schedule` (every six hours) and
`workflow_dispatch`. It may fetch metadata and open/update one tracking issue, but it must not
merge, modify Git refs/content, or publish builds. Give only the reporting job `issues: write`;
every other permission remains read-only.

Report:

- last absorbed upstream SHA and current upstream SHA;
- descendant/non-fast-forward status;
- pending commit count and releases;
- changed subsystems;
- intersections with active patch paths; and
- whether a sync threshold has been reached.

Use these initial operational defaults, then tune them from measured upstream activity. Open a sync
batch when any condition is met:

- upstream publishes a release;
- three calendar days pass;
- 50 upstream commits are pending; or
- a security, data-integrity, Windows, provider-startup, or critical performance fix lands.

Critical fixes are assessed within 24 hours. The watcher fails closed and reports if upstream
history is rewritten.

Allow at most one active sync PR. Freeze its target upstream SHA when classification begins; later
upstream commits queue for the next batch. Retargeting invalidates the range assessment and all
derived verification, which must then be regenerated.

### Sync procedure

1. Start from a clean, dedicated worktree; record downstream base and target upstream SHAs.
2. Verify the previously absorbed upstream SHA is still an ancestor of current upstream.
3. Create `sync/upstream-YYYYMMDD-<sha7>` from downstream `main`.
4. Merge the exact target upstream SHA with a merge commit.
5. Generate a range report grouped by upstream PR/commit and subsystem.
6. Classify changes:
   - **Green:** non-overlapping; absorb unchanged.
   - **Amber:** adjacent behavior; review patch assumptions and focused tests.
   - **Red:** semantic overlap; adopt upstream, retain/rewrite local behavior, or explicitly defer.
   - **Critical:** persistence, state schema, provider spawn, auth, release/update, native/runtime,
     or destructive cleanup; require additional compatibility and rollback evidence.
7. Resolve every textual and semantic conflict deliberately. Regenerate lockfiles/generated files
   with the repository toolchain; never hand-combine generated output.
8. Update the patch inventory and write the sync assessment. Stage the target in
   `upstream-state.json`; it becomes effective only when the sync PR merges to protected `main`.
9. Run all required CI, migration, platform, and packaged-startup gates.
10. Open a draft sync PR; make it ready only after every change is classified.
11. Merge the PR with a merge commit and record the new absorbed SHA.

Do not let the default `GITHUB_TOKEN` create a PR and assume its own event will recursively trigger
normal CI. The first implementation only reports drift; the owner creates the sync PR. Later PR
automation needs an explicitly scoped GitHub App token or an explicit verification dispatch.

### Contributing generic fixes upstream

For a change useful to canonical Synara:

1. create a clean branch from `upstream/main`;
2. include only the generic fix and regression tests;
3. push that branch to the fork and open a focused upstream PR;
4. if needed immediately, create a second branch from downstream `origin/main`, cherry-pick or
   reapply only the logical fix, land it as `upstream-pending`, and record both commit identities;
   never open the upstream-based branch directly against downstream `main`; and
5. when upstream accepts an equivalent fix, absorb it in the next sync and retire the local patch.

Branding, unsigned-release policy, and personal workflow changes remain downstream-only.

## 9. Persistence and migration policy

Upstream currently owns a sequential Effect SQL migration lineage. Adding downstream entries to
the same numerical ledger risks future ID/name collisions or falsely skipping newer upstream
migrations.

Phase-one rule: **no downstream persistence migration is allowed**.

Before any custom feature needs a schema change, approve and implement a separate downstream
migration namespace/ledger that runs after upstream migrations and cannot advance or impersonate
upstream's `effect_sql_migrations` lineage. The design must include downgrade/retirement behavior
for a patch later accepted upstream. Until that design passes tests, keep custom data in existing
schemas or outside the main database only when that is technically sound.

Every upstream sync touching migrations must pass:

- all historical migration fixtures;
- migration backup and recovery tests;
- a fresh empty Super Synara home;
- an isolated copy of a representative Super Synara database/profile; and
- explicit confirmation that the live `.synara` and `.super-synara` homes were not used.

An executable downgrade is not a safe database rollback. Preserve and identify the matching
pre-migration backup before accepting a persistence-changing sync. Because normal migration
backups rotate, qualification must copy/pin this backup outside that retention, record its path,
source version, target migration, SHA-256, and prerelease tag, perform a restore rehearsal, and
retain it until at least the next qualified prerelease and its rollback window have completed.

## 10. Public Actions hardening

Before activating workflows in the public fork:

1. Pin every `uses:` dependency to a reviewed full commit SHA. Keep a comment with its human
   release version for maintainability.
2. Set workflow-level `permissions: contents: read` unless a narrower job explicitly needs write.
3. Give `contents: write` only to the tag-reservation and final prerelease-publication jobs.
4. Do not grant `id-token: write`; no OIDC/Azure path exists in this channel.
5. Do not use repository secrets for the unsigned workflow.
6. Add concurrency groups that cancel obsolete CI for the same PR/branch but never cancel a
   publication already in its final job.
7. While fork workflows are still inactive, harden retained files and identify inherited upstream
   workflows that do not belong in this fork. After the one-time activation, immediately disable
   these workflows in repository Actions state:
   - formal `.github/workflows/release.yml` triggers;
   - `pr-vouch.yml`;
   - `issue-labels.yml`; and
   - the current `pull_request_target` PR-size path until it is removed or rewritten read-only.
8. Preserve upstream formal-release code and its smoke tests in source for easier merging, but do
   not activate its tag/manual publication path in the fork.
9. Keep GitHub's approval requirement for untrusted fork-authored workflows and never run
   untrusted PR code with a write token.
10. Add a guard/check that fails if any disabled upstream-only workflow becomes active after a
    sync.

## 11. PR and push CI

Harden `.github/workflows/ci.yml`; trigger on every PR and pushes to downstream `main`. Ubuntu is
only a CI host and does not imply a Linux application download.

### `quality` — `ubuntu-24.04`

- frozen dependency install;
- Linux `node-pty` native dependency smoke;
- `bun run brand:check`;
- `bun run fmt:check`;
- `bun run lint`;
- `bun run typecheck`;
- full Vitest through `bun run test` (never `bun test`);
- blocking stable browser tests;
- existing non-blocking Linux geometry quarantine;
- `bun run build:desktop`; and
- preload-bundle verification.

### `windows_x64` — `windows-2022`

- frozen dependency install;
- full `bun run test` initially, so Windows-only assumptions are exposed;
- existing shared Windows process-planning tests;
- server Effect Windows process-spawn tests;
- Windows provider discovery/spawn, migration backup/recovery, and desktop lifecycle regressions;
- Super Synara identity/cache tests;
- desktop build; and
- unpacked/package-adjacent startup smoke in an isolated temporary home.

Measure duration and reliability for several weeks before narrowing the full Windows suite. Any
narrowing must preserve permanent coverage for Windows-specific fixes.

### `macos_arm64` — `macos-15`

- frozen dependency install;
- native helper tests;
- Super Synara identity tests;
- arm64 desktop build; and
- non-packaged desktop smoke in an isolated temporary home.

This job verifies the supported macOS target. It does not create a DMG, sign, notarize, or publish
an artifact. Packaged-startup verification runs against the generated zip/DMG only in the manual
prerelease workflow.

### `release_smoke` — `ubuntu-24.04`

- preserve the upstream signed-release assertions;
- add separate contract tests for the downstream unsigned-prerelease lane; and
- never make the existing signed-publication assertions more permissive.

After the first green runs, require `quality`, `windows_x64`, `macos_arm64`, and `release_smoke` on
`main`. Full native NSIS/DMG packaging and install verification remain manual-prerelease gates so
ordinary PRs do not repeatedly perform distribution work.

## 12. Manual unsigned prerelease workflow

Add `.github/workflows/super-synara-prerelease.yml`. It has only `workflow_dispatch`, defaults to a
Windows-only release, can explicitly select a combined Windows and macOS release after macOS
admission is ready, and never runs from an automatic tag/push event.

### Inputs

- `version` — required; format `<upstream-core>-super.<positive integer>`, for example
  `0.5.5-super.1`.
- `tag` — required; must equal `super-v<version>`, for example
  `super-v0.5.5-super.1`. The `super-v` prefix does not match upstream's `v*.*.*` trigger.
- `release_scope` — required choice; `windows-only` by default or `windows-and-macos` when both
  native lanes and the reviewed macOS signature policy are ready.
- `confirm_unsigned` — required boolean and must be `true`.

The selected workflow ref must be protected downstream `main`. The workflow captures one immutable
source commit and checks out that exact SHA in every job. Add a tag ruleset for `super-v*` that
blocks tag update/deletion, and fail preflight unless both `github.actor` and
`github.triggering_actor` equal `slashdevcorpse` (reruns preserve the original actor but expose the
rerun initiator separately). Recheck both immediately before tag creation and publication. Bind the
publication job to a protected `super-synara-prerelease` environment with that owner as required
reviewer; allow the owner to approve their own deployment because this is a single-maintainer
personal channel. Set one workflow-wide concurrency group named `super-synara-prerelease` with
`cancel-in-progress: false`, so two publications cannot overlap.

### Job 1 — `preflight` (`ubuntu-24.04`, read-only)

1. Verify repository `slashdevcorpse/synara`, ref `main`, and explicit unsigned confirmation.
2. Verify the version/tag grammar and that the core portion matches the desktop package version.
3. Read the absorbed upstream SHA from validated `docs/downstream/upstream-state.json`; verify it is
   an ancestor of the source commit and has no active reverted/excluded range.
4. Record the full source commit, absorbed upstream SHA, and `bun.lock` SHA-256.
5. Reject an existing published release, draft release, or a tag that points to another commit.
6. Run the complete quality/browser/release-contract gate.

### Job 2 — `reserve_tag` (`ubuntu-24.04`, `contents: write` only)

Create the unique `super-v...` tag at the verified source SHA. If a failed prior attempt left the
same tag at the same commit and no release exists, reuse it. Reject a moved/mismatched tag or an
already-published release. A tag without a release after failure is operational evidence, not a
successful release; the same exact dispatch may be rerun.

### Job 3 — `windows_x64` (`windows-2022`, read-only)

1. Check out the exact tagged commit and install frozen dependencies.
2. Run required Windows regression tests.
3. Build Super Synara x64 NSIS without `--signed`.
4. Assert the package has the Super Synara product/GUID/AppUserModelID/profile identity.
5. Assert that no updater feed/configuration is embedded.
6. Perform packaged startup in an isolated home.
7. Test a silent fresh install, launch, exit, uninstall, and side-by-side upstream Synara behavior.
   When a previous Super Synara prerelease exists, also test an upgrade from that version against a
   copied test profile.
8. Produce the installer and truthful unsigned-prerelease provenance.
9. Upload an intermediate Actions artifact with one-day retention.

### Job 4 — `macos_arm64` (`macos-15`, read-only)

This job runs only for the explicit `windows-and-macos` release scope. A Windows-only publication
does not read or require the macOS signature allowlist.

1. Check out the exact tagged commit and install frozen dependencies.
2. Build the arm64 DMG without a Developer ID identity or notarization. Use the explicit ad-hoc
   identity `-` and `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder seals the bundle while
   never silently selecting a keychain certificate.
3. Use any generated zip only for local packaged-startup verification; do not publish it.
4. Inspect the finished app and every nested binary. Record expected ad-hoc signatures on
   Super Synara-owned binaries—including the AppSnap helper—as `ad-hoc-only`. Separately inventory
   and allowlist exact third-party Electron/vendor paths and their expected signatures. Fail if a
   Super Synara-owned binary has a Developer ID/Team ID, if the app has a notarization ticket, or if
   any vendor path/identity is new or differs from the reviewed allowlist.
5. Assert bundle ID/name/profile isolation and absence of updater configuration.
6. Produce the DMG and truthful unsigned-prerelease provenance.
7. Upload an intermediate Actions artifact with one-day retention.

### Job 5 — `publish` (`ubuntu-24.04`, `contents: write` only)

For `windows-only`, the final staging directory must contain exactly:

```text
Super-Synara-<version>-windows-x64-unsigned.exe
artifact-windows-x64.provenance.json
release-index.json
SHA256SUMS.txt
UNSIGNED-BUILD.md
LICENSE
```

For `windows-and-macos`, the final staging directory must contain exactly:

```text
Super-Synara-<version>-windows-x64-unsigned.exe
Super-Synara-<version>-macos-arm64-unsigned.dmg
artifact-windows-x64.provenance.json
artifact-macos-arm64.provenance.json
release-index.json
SHA256SUMS.txt
UNSIGNED-BUILD.md
LICENSE
```

Reject `.yml`, `.blockmap`, `.zip`, `.AppImage`, Linux, Intel, or any unexpected asset. Create a
draft prerelease with GitHub CLI using the verified existing tag and exact commit, validate the
draft state/assets/checksums/provenance, record its GitHub release ID as owned by the current run,
then make it public while preserving:

- `prerelease: true`;
- `latest: false`; and
- the exact immutable tag target.

Immediately before changing the draft to public, revalidate the tag target, source commit,
absorbed-upstream state, exact asset hashes, and prerelease/Latest flags. The only allowed existing
draft is the one created by the current run with the recorded release ID, tag, target commit, and
metadata; any other or mismatched draft fails closed.

Use GitHub CLI rather than a third-party release action. If either native build or final validation
fails, no public release is created. Never overwrite assets on an existing public prerelease; use a
new version for changed bytes. If a failure occurs after draft creation, the next dispatch must
fail and report that draft. The owner must inspect and delete the matching draft before retrying;
the workflow never silently resumes, replaces, or deletes draft assets.

`SHA256SUMS.txt` uses lowercase SHA-256, two spaces before each filename, UTF-8, LF line endings,
and bytewise filename ordering. It covers the selected native payloads, their platform provenance
manifests, `UNSIGNED-BUILD.md`, and `LICENSE`; it excludes itself and `release-index.json` to avoid
recursion.
`release-index.json` hashes every published file except itself, including `SHA256SUMS.txt`, and
records the exact tag, source commit, absorbed upstream SHA, and platform set.

Before enabling this workflow, inspect the account's current Actions artifact allowance/usage and
measure the NSIS and DMG sizes. Set a repository-level byte cap no higher than 80% of the remaining
allowance, split it between the two native jobs, and enforce it before each upload. If both artifacts
cannot fit, stop and redesign the transport rather than incur storage overage. Retention is one day;
GitHub release assets, not Actions artifacts, remain the durable channel.

### Release notes and warning asset

Every prerelease title and notes must prominently state:

- unofficial downstream Super Synara build;
- unsigned prerelease;
- manual updates only;
- exact downstream commit and absorbed upstream SHA;
- Windows `Unknown publisher` / SmartScreen warning;
- SHA-256 verification instructions; and
- no recommendation to disable a system-wide security protection.

A combined Windows and macOS prerelease must additionally state the macOS Gatekeeper warning and
the documented Finder/System Settings override.

## 13. Explicit updater disablement

Add a first-class build option such as `--disable-updates`, backed by a validated build input. For
the Super Synara prerelease workflow it must:

- ignore both `SYNARA_DESKTOP_UPDATE_REPOSITORY` and the automatic `GITHUB_REPOSITORY` fallback;
- omit electron-builder publish/update configuration;
- omit `app-update.yml` and equivalent updater metadata from the package;
- suppress automatic update checks and present manual-update status in the UI; and
- prevent `.yml` and `.blockmap` files from entering the public asset set.

Do not implement this by passing a malformed repository value or by relying on an accidentally
unset environment variable. Tests must prove the absence of update configuration.

## 14. Truthful release provenance

Extend the shared provenance model rather than duplicating hash/source logic. Introduce an explicit
distribution kind, with three policies:

- `build-only` — unsigned, not publicly distributed;
- `github-unsigned-prerelease` — unsigned, public prerelease; and
- `signed-release` — existing formal signed publication.

For `github-unsigned-prerelease`, record:

```text
publication: true
distribution.repository: slashdevcorpse/synara
distribution.tag: super-v<version>
distribution.prerelease: true
distribution.latest: false
distribution.updaterFeed: false
signing.status: unsigned-prerelease
signing.scheme: none (Windows) | ad-hoc-only (macOS)
signing.thirdPartyComponents: not-applicable (Windows) | reviewed-allowlist (macOS)
```

Here, “unsigned” means no trusted Windows publisher certificate and no Developer ID signature or
notarization applied to the Super Synara app/owned binaries. It does not conceal expected macOS
ad-hoc signatures. The macOS manifest lists every Super Synara-owned ad-hoc-signed binary, records
reviewed third-party vendor signatures separately, and proves no Super Synara Developer ID/Team ID
or app notarization ticket was found.

Split validation into two non-circular stages:

1. Each native job writes **platform build provenance** covering its exact artifact, platform,
   identity, commit, lock hash, reserved tag, intended `github-unsigned-prerelease` policy,
   unsigned status, and `updaterFeed: false`. In this manifest, `publication: true` means the
   artifact is explicitly authorized/intended for that public policy; it does not claim the GitHub
   release already exists.
2. The publish job assembles every final file and writes a **publication admission index**. This
   stage verifies the platform manifests, required warnings/license, canonical checksums, exact
   asset allowlist, tag/version/commit agreement, validated upstream-state pin, and prohibited-asset
   absence. Only that admitted staging set may be uploaded.

Allow unsigned publication only if every applicable invariant holds and the platform is Windows or
macOS. Continue rejecting unsigned stable/Latest releases, updater feeds, source/tag mismatches, or
an unsigned call through the existing signed-release policy.

The current source-provenance path assumes a formal version everywhere: package versions equal the
complete release version, the source tag is `v<version>`, and publication runs from the tag ref.
Parameterize `scripts/verify-release-source-provenance.ts` and the corresponding checks in
`scripts/build-desktop-artifact.ts` with a separate downstream policy that explicitly accepts:

- package/core version `0.5.5` with downstream version `0.5.5-super.N`;
- tag `super-v0.5.5-super.N`;
- manual dispatch from protected `main`; and
- independent proof that the reserved tag points to the dispatched commit.

Preserve every existing strict rule for upstream `signed-release` callers.

## 15. Implementation phases

### Phase 0 — Baseline and repository controls

- Preserve the pre-existing dirty files.
- Coordinate remote normalization across all worktrees.
- Fast-forward the fork only if it is still zero commits ahead; otherwise use a sync PR.
- Add and validate the upstream-state ledger, patch inventory, current patch seed, and first sync
  assessment before permanent downstream code changes.
- Land safe workflow permissions/pins/guards while fork workflows remain inactive.
- Activate Actions once only after the inherited workflow audit, then immediately disable
  upstream-only workflows in repository Actions state.
- Create the `main` and `super-v*` rulesets, add the non-merging drift watcher, and confirm no
  secrets are needed.

Exit: fork baseline is current, protected, reproducible, upstream state is explicit, drift is
visible, and no inherited workflow can publish.

### Phase 1 — Super Synara isolation

- Add the `super` flavor and baked identity.
- Parameterize packaging and packaged-startup verification.
- Add the unique NSIS GUID, scheme/origin, state/home, bundle/AUMID, and artifact names.
- Disable updater configuration for this flavor.
- Include MIT license and downstream attribution.
- Add identity/state/cache/update tests.

Exit: Synara and Super Synara install/run side by side and cannot touch each other's writable state.

### Phase 2 — CI and public-workflow hardening

- Expand Windows CI, add macOS arm64 CI, and preserve Ubuntu quality/release smoke.
- Add required ruleset checks after observed green runs.
- Add workflow contract/security tests.

Exit: custom PRs, sync PRs, and pushes receive the agreed platform gates using only standard runners.

### Phase 3 — Manual unsigned prerelease

- Add provenance schema/policy and release-index validation.
- Add the manual Windows-first workflow, optional combined macOS scope, and exact scoped asset
  allowlists.
- Add warning/license/checksum generation.
- Exercise the workflow state machine with contract tests and local staging fixtures, including
  failure, tag/rerun, draft-ownership, and asset-policy cases. This rehearsal creates no Git tag,
  draft, or public GitHub release.

Exit: the no-publication rehearsal admits an exact synthetic staging set and rejects every unsafe
case without trusted publisher signing, secrets, updater metadata, Linux, or Intel artifacts.

### Phase 4 — Upstream operations

- Exercise the Phase-0 patch inventory, sync-assessment format, state ledger, and watcher through a
  real intake.
- Refine owner-run sync and upstream-contribution documentation from that evidence.
- Confirm the current custom Windows/performance work remains represented as logical patches.

Exit: upstream drift is visible within six hours and every retained downstream delta has an owner,
test, overlap rule, and retirement condition.

At the end of every implementation phase, check the upstream thresholds. If one is reached, freeze
the next target SHA and complete a sync checkpoint before starting the next phase.

### Phase 5 — First qualified prerelease

- Run a full sync against a pinned upstream SHA.
- Run the complete CI and migration/state-copy gates.
- Qualify Windows fresh install, upgrade, uninstall, and side-by-side behavior.
- For an explicitly selected combined release, qualify macOS arm64 bundle/profile isolation.
  Document Gatekeeper behavior from Apple's guidance; do not claim that a same-run local DMG
  reproduces browser quarantine.
- Manually publish the first Super Synara public prerelease.
- Download every selected asset again and independently verify checksums/provenance.

Exit: the public prerelease maps to one immutable green commit and exact absorbed upstream SHA.

## 16. Expected repository changes

### New

- `.github/workflows/super-synara-prerelease.yml`
- `.github/workflows/upstream-watch.yml`
- `docs/downstream/patches.yml`
- `docs/downstream/upstream-state.json`
- `docs/downstream/syncs/` assessment files as syncs occur
- patch/upstream-state validators and their focused tests
- unsigned warning/release-index helpers and their focused tests

### Modify

- `.github/workflows/ci.yml`
- inherited workflow activation/trigger policy
- `packages/shared/src/desktopIdentity.ts` and identity tests
- `apps/server/src/trustedOrigins.ts` and origin tests
- `apps/desktop/src/main.ts`
- `apps/desktop/tsdown.config.ts`
- `turbo.json`
- `scripts/build-desktop-artifact.ts`
- `scripts/lib/desktop-platform-build-config.ts`
- `scripts/lib/release-artifact-provenance.ts`
- `scripts/verify-release-source-provenance.ts`
- `scripts/release-smoke.ts` without weakening upstream signed-release tests
- `scripts/verify-packaged-desktop-startup.ts`
- downstream-facing README/About/install documentation
- packaging resources needed to include `LICENSE`

The implementation must update the smallest shared abstractions that make identity, updater policy,
and provenance explicit. It must not fork entire release scripts into drifting copies when shared
hashing, validation, or platform configuration can be parameterized safely.

## 17. Acceptance criteria

### Repository and upstream

- [ ] `origin` is the fork, `upstream` is canonical, and upstream push is blocked.
- [ ] Downstream `main` is protected and has no force-push path in normal operation.
- [ ] Every sync records old/new upstream SHAs and a complete semantic classification.
- [ ] The absorbed upstream SHA is an ancestor of each prerelease commit and the state ledger has
      no active revert/exclusion in its asserted range.
- [ ] Every active downstream patch has a regression test and retirement condition.
- [ ] Patch and upstream-state schema validation passes.

### CI

- [ ] PR and `main` push CI runs format, lint, typecheck, full Vitest, stable browser, desktop,
      Windows, macOS arm64, and release-contract gates.
- [ ] All actions are pinned to full commit SHAs.
- [ ] Normal CI has read-only permissions.
- [ ] No public-fork PR code executes with a write token.
- [ ] Only standard runners are referenced.
- [ ] The macOS jobs use the supported standard ARM64 `macos-15` label.

### Isolation

- [ ] Super Synara and Synara install side by side on Windows.
- [ ] They have distinct installer/uninstaller registration, AppUserModelID, protocol, process
      lock, Electron profile, and backend home.
- [ ] Super Synara never reads or mutates live `.synara` state during qualification.
- [ ] When the combined scope is selected, equivalent bundle/profile isolation passes on macOS
      arm64.
- [ ] Packaged identity tests prove upstream production identity remains unchanged.

### Prerelease

- [ ] Dispatch works only from protected `main` with explicit unsigned confirmation.
- [ ] Both workflow actor fields, protected publication environment, immutable `super-v*` tags, and
      the non-cancelling release concurrency lock are enforced.
- [ ] It always builds Windows x64 and builds macOS arm64 only for the explicit combined scope.
- [ ] No Azure, Apple Developer ID/notarization, OIDC, secret, larger-runner, Linux, or Intel path
      is invoked.
- [ ] No updater config, updater metadata, `.blockmap`, or updater YAML is embedded/published.
- [ ] When the combined scope is selected, macOS provenance lists expected product-owned ad-hoc
      signatures, validates the reviewed third-party signature allowlist, and proves no Super
      Synara Developer ID/Team ID or app notarization ticket is present.
- [ ] Intermediate artifacts stay within the measured account budget and expire after one day.
- [ ] Published assets exactly match the allowlist and SHA-256 file.
- [ ] Provenance truthfully says public, unsigned, prerelease, not Latest, and no updater feed.
- [ ] Release is public, is marked prerelease, and is not Latest.
- [ ] Release notes contain exact commits, unsigned warnings, license, and manual-update status.
- [ ] Every selected platform's downloaded bytes independently match published hashes.

### Windows qualification

- [ ] Fresh install, launch, normal use, exit, and uninstall pass.
- [ ] Upgrade from the previous Super Synara prerelease preserves Super Synara state.
- [ ] Upstream Synara remains installed and unaffected.
- [ ] Provider discovery/spawn and migration backup/recovery tests pass on Windows.
- [ ] SmartScreen/Unknown Publisher behavior is documented, not misrepresented as trusted.

## 18. Stop conditions

Do not publish if any condition holds:

- the selected commit is not downstream protected `main`;
- either `github.actor` or `github.triggering_actor` is not `slashdevcorpse`;
- the tag/version already identifies different bytes or a different commit;
- before draft creation, any public or draft release uses the tag; or after draft creation, any
  draft other than the exact current-run release ID/tag/commit is present;
- any build selected by the release scope is missing;
- any identity surface collides with upstream Synara;
- any test uses the live `.synara` or `.super-synara` home;
- provenance claims signed, verified, or unpublished status incorrectly;
- a Super Synara-owned macOS binary has an unexpected Developer ID/Team ID, the app has a
  notarization ticket, or a third-party vendor signature differs from its reviewed allowlist;
- intermediate artifacts exceed the verified account storage budget;
- updater configuration or prohibited assets are present;
- a migration range is unclassified or lacks recovery evidence;
- the source tree/lockfile differs from the recorded commit/hash;
- required CI is not green; or
- the GitHub release would become stable or Latest.

## 19. Rollback

- Never reset or force-push a bad downstream sync. Revert its merge commit in a new PR, mark the
  affected range active-reverted in `upstream-state.json`, update the sync assessment, and rerun all
  gates. Ancestry alone will still show the upstream commits, so the state ledger is authoritative
  about their effective status.
- Keep the previous successful prerelease available; never replace its assets.
- For migration regressions, restore the recorded pre-migration backup. Downgrading only the
  executable may be unsafe.
- A failed prerelease before publication leaves no public release. Reuse a reserved tag only when
  it still points to the exact same commit and no release exists; otherwise allocate a new version.
- Do not reattempt a reverted range by merging the same upstream SHA; Git will treat it as already
  merged. Either revert the revert with corrective changes or explicitly replay the reverted tree
  delta in a new PR. Clear the state-ledger exclusion only after full verification, with the
  original failure linked.

## 20. Known tradeoffs

- Windows will show `Unknown publisher` and may show SmartScreen. Smart App Control or an
  organization policy may block the installer entirely. This is accepted for the personal-use
  channel; signing is the remedy if broader distribution is later required.
- macOS Gatekeeper will warn or block an unsigned/unnotarized application until the user performs
  Apple's documented per-app override. A same-run CI artifact does not reproduce browser quarantine,
  so this behavior is documented rather than claimed as automated release qualification. Do not
  advise disabling Gatekeeper globally.
- Public prerelease assets are visible to everyone. Use private storage instead if the binaries or
  changes must not be public.
- Upstream velocity makes some merge conflict work unavoidable. The patch inventory and
  merge-commit ancestry minimize repeated and silent work; they cannot remove semantic review.
- Running a macOS arm64 job on every PR increases CI latency, but it verifies a platform we promise
  to package. Reassess only from measured data.
- Automatic updates remain unavailable until the distribution is signed and a separate secure
  update policy is designed.

## 21. Verification references

- GitHub standard runners for public repositories:
  <https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories>
- GitHub runner image lifecycle and macOS 14 deprecation notice:
  <https://github.com/actions/runner-images>
- GitHub Actions storage and billing:
  <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
- Workflows in public forks:
  <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories>
- Pinning third-party actions:
  <https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions>
- Manual workflow dispatch:
  <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow>
- GitHub release assets:
  <https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>
- Syncing a fork:
  <https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork>
- Microsoft SmartScreen:
  <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation>
- Microsoft Smart App Control:
  <https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview>
- Apple Gatekeeper:
  <https://support.apple.com/en-ca/guide/security/sec5599b66df/web>
- Apple's per-app override guidance:
  <https://support.apple.com/en-ca/102445>

## 22. Completion rule for later implementation

This planning task does not authorize workflow activation, remote changes, pushes, releases, or
the project's heavyweight checks. During implementation, completion requires one final bundled
verification pass using `bun run fmt:check`, `bun run lint`, `bun run typecheck`, and
`bun run test`—never `bun test`—plus the native packaging and installed-app gates above.
