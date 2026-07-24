# Provider CLI updates

This document is the conservative current-build contract and operator runbook for updating provider CLIs from Super Synara. It distinguishes what this build can automate from channels that a vendor supports but Super Synara does not yet identify or update safely. A vendor-documented install channel is not automatically a Super Synara one-click channel.

If the current build cannot prove the resolved command, owning source, same-channel version target, and affected-runtime state, the update is manual-only. Missing provenance in the UI is not permission to infer it: use the troubleshooting commands below, follow the linked vendor instructions, and report any action that appears outside the implemented boundaries in this document.

Super Synara integrates directly with ten providers: Codex, Command Code, Claude Code, Cursor Agent, Google Antigravity, Grok Build, Factory Droid, Kilo Code, OpenCode, and Pi.

## Safety contract

A provider update changes shared software outside a project checkout. The updater must therefore fail closed unless it can identify the exact installation it will modify and prove that doing so will not interrupt provider work.

The required behavior is:

1. Resolve the exact configured provider command, including an explicit custom binary path.
2. Identify the owning install source and install root. A manager or layout is supported only where the provider section below lists it under **Implemented in this build**.
3. To authorize or verify maintenance, compare the resolved binary only with the latest version from the same channel. An npm release does not prove that a Homebrew, WinGet, alpha, or enterprise-managed update target is current or stale.
4. Refuse one-click update when the source or target is ambiguous. When the current UI does not expose the resolved path or detected source, direct the operator to the troubleshooting commands and vendor instructions instead of guessing.
5. Do not interrupt an active turn, review, compaction, pending approval or user-input request, provider background task, or provider-launched tool task. If the implementation cannot prove that all Super Synara-owned runtimes using the target are idle, it must defer or reject the update.
6. Quiesce only idle runtimes owned by Super Synara, wait for their process trees to exit, and preserve their provider resume cursors. If ownership, idleness, resumability, or exit cannot be proven, defer the update before modifying the installation.
7. Never stop or kill an external process. This includes provider CLIs opened in another terminal and configured external OpenCode or Kilo servers, even when they run on the same computer.
8. Run the updater that owns the detected installation, then re-resolve and probe the same binary and channel.
9. Leave safely stopped sessions dormant. The next turn may start the updated runtime lazily only when a provider resume cursor was preserved; an update must not eagerly restart every idle provider process or claim resumability without a cursor.
10. Preserve provider authentication, configuration, conversations, and Super Synara history. Uninstall/reinstall and deletion of provider state directories are not update fallbacks.

An update may hold new turns behind an explicit drain barrier after existing work has settled. It must never send an interrupt merely to make the update start sooner.

### Read-only advisories do not prove update eligibility

Super Synara may show a nonblocking, read-only latest-version advisory from an explicitly trusted provider metadata source even when it cannot prove which installation channel owns the resolved binary. Current provider-wide fallbacks are limited to the official npm metadata for Codex, OpenCode, and Droid. This advisory is a prompt to review provider settings; it does not prove the selected installation can reach that version.

The advisory source never authorizes an update, supplies an update command, or participates in pre-update or post-update verification. `canUpdate` remains true only when the independent exact-target ownership checks succeed, and an unverified install remains manual-only. A verified native updater may remain actionable while displaying the read-only advisory, but its maintenance result is still classified from exact target and same-channel evidence only.

## Exact binary and source rules

- An explicit binary setting wins over `PATH`. A one-click native updater must invoke that resolved executable, not a same-named executable found later through `PATH`.
- A package-manager update must target the package and canonical install root that own the resolved command. The action records the visible command, canonical command, canonical root, exact absolute manager path and its canonical path, and channel evidence in one target fingerprint. For npm, the command pins the proven global prefix rather than assuming an ambient `npm` owns the provider. npm documents that global executables live directly under the prefix on Windows and under the prefix's `bin` directory on Unix-like systems ([npm folders](https://docs.npmjs.com/files/folders/)).
- npm, Bun, and pnpm one-click updates additionally require local metadata that explicitly preserves the requested `latest` tag. Accepted evidence is the exact installed package manifest's npm `_requested`/`_spec` metadata or the canonical global root `package.json` declaring that exact package as `latest`. A stable-looking installed version, registry `dist-tags.latest`, lockfile resolution, manager default-tag setting, or absence of a prerelease suffix does **not** prove how the package was requested. Modern global npm installs often omit historical request metadata; those installations are deliberately manual-only until accepted local evidence exists.
- Prerelease versions and custom, pinned, Git, file, workspace, alias, or otherwise unproven package specs are manual-only. Super Synara does not silently move them to `latest`.
- A `.cmd`, shell shim, symlink, junction, editor helper, or wrapper is evidence to continue resolution, not proof of ownership by itself. On Windows, Super Synara uses the same `PATH`/`PATHEXT` ordering for runtime launch and maintenance discovery, preserves the exact selected absolute candidate, verifies the exact package manifest and an allowed manifest `bin` key, and checks the selected shim's link to the package binary. A different same-named executable beside or later than that candidate is not interchangeable.
- Windows installer junctions retain both identities: the user-visible stable launcher is the executable invoked, while its real path identifies the physical release and canonical root. Resolving the official Codex junction into a versioned release must not erase the visible installer-owned path.
- A custom path is manual-only unless Super Synara can positively match it to a supported vendor-native layout or package-manager root.
- A successful command is not sufficient proof of an update. Re-resolve the configured command, run its documented version probe, and apply the result semantics below.
- Do not silently migrate between package names or channels. For example, an existing Factory `@factory/cli` installation must not be replaced with `droid` unless the user explicitly chooses that migration.

## Result semantics

The current build must not translate updater exit code zero directly into “updated.” Report one of these outcomes:

- **Updated (`succeeded`):** the post-update probe resolves to the same target installation and source/channel as preflight, and its version proves the requested same-channel change occurred.
- **Already current (`already_current`):** same-source, same-channel metadata and the pre-update probe prove no change was needed. Super Synara does not stop runtimes or execute an updater for this outcome.
- **Completed but configured binary unchanged (`unchanged`):** the updater exited successfully, the same target was re-probed, and its version did not change. This is distinct from an update that remains behind.
- **Completed but still outdated (`still_outdated`):** the updater exited successfully, but same-channel metadata still reports the configured provider behind the selected channel.
- **Completed but change unverified (`unverified`):** the updater exited successfully, but Super Synara cannot prove the post-update path, owning source/channel, or comparable version. This is not “updated.”
- **Failed:** the updater exited unsuccessfully, timed out, or left no valid configured binary.

If comparable latest-version metadata is unavailable for the detected source/channel, the maintenance-verification state is **unknown**. A separate read-only advisory may still report an explicitly trusted provider release in the UI, but it must not be reused to label the detected channel current, short-circuit its updater, or verify its result.

## Provider channel boundaries

Each provider separates vendor availability from the mechanisms implemented in this build. “Implemented” means only that the update mechanism exists; one-click remains eligible only after every exact-binary, explicit-local-channel, ownership, and runtime gate above passes. An ordinary package-manager install that does not preserve `latest` in accepted local metadata remains manual-only even when its package name and stable version are known. A manual fallback is a safe outcome, not an updater failure.

### Codex

- **Vendor-supported channels:** OpenAI's standalone installer, npm package `@openai/codex`, Bun, pnpm, Homebrew cask, and release binaries. OpenAI documents the current shell, PowerShell, npm, and Homebrew installation paths in the [Codex repository](https://github.com/openai/codex#installing-and-running-codex-cli).
- **Implemented in this build:**
  - npm: `npm install -g @openai/codex@latest`, pinned to the detected global prefix;
  - Bun: `bun i -g @openai/codex@latest`;
  - pnpm: `pnpm add -g @openai/codex@latest`;
  - Homebrew: `brew upgrade --cask codex`;
  - a recognized official Windows standalone layout: the resolved `codex update` command.
- **Version probe:** `codex --version`.
- **Vendor-supported but manual-only/planned:** POSIX standalone installs, unpacked release binaries, custom wrappers, and standalone layouts that this build cannot positively match. The upstream updater supports POSIX standalone installs, but this build's standalone provenance matcher is Windows-specific.
- **Windows notes:** OpenAI's current PowerShell installer downloads a checksum-verified release into versioned directories and retargets installer-owned junctions under an install lock, avoiding in-place replacement of the running release ([official `install.ps1`](https://chatgpt.com/codex/install.ps1)). The npm-distributed executable does not gain that side-by-side guarantee, so Super Synara-owned Codex app-server processes must be idle and stopped before npm replaces their package files.

OpenAI's source-backed `codex update` dispatcher recognizes npm, Bun, pnpm, Homebrew, and standalone installs ([Codex update action source](https://github.com/openai/codex/blob/main/codex-rs/tui/src/update_action.rs)). That makes it appropriate for a recognized standalone install. For a package-managed Windows install, Super Synara should invoke the owning manager after quiescence rather than launch a second Codex executable that may itself hold the package binary open.

### Command Code

- **Vendor-supported channel:** npm package `command-code`; install with `npm i -g command-code@latest` ([Command Code quickstart](https://commandcode.ai/docs/quickstart)).
- **Implemented in this build:** an exact npm-owned `command-code` installation with accepted local `latest` evidence is updated with `npm install -g command-code@latest`, pinned to its proven global prefix. Current authoritative package metadata exposes `cmd`, `cmdc`, `command-code`, and `commandcode`; Super Synara accepts all four manifest/shim keys while still requiring the exact package identity. The public documentation advertises `cmd` and `command-code` ([Command Code CLI reference](https://commandcode.ai/docs/reference/cli)).
- **Version probe:** `cmd --version`, or the corresponding resolved alias with `--version`.
- **Vendor-supported but manual-only/planned:** the documented `cmd update` self-updater, `cmd update --check-only`, a bare `cmd`, `cmdc`, or `commandcode` found on `PATH` without proven npm ownership, editor or shell wrappers, custom launchers, and any install whose global prefix cannot be tied to the resolved executable ([Command Code CLI reference](https://commandcode.ai/docs/reference/cli)). The source-correct manual fallback is `npm install -g command-code@latest`, pinned to the owning prefix.
- **Windows notes:** the vendor describes native Windows support as alpha and recommends WSL. Because `cmd` is the Windows command processor, the vendor recommends `cmdc` on native Windows ([Command Code Windows guide](https://commandcode.ai/docs/troubleshooting/windows)).

### Claude Code

- **Vendor-supported channels:** Anthropic's recommended native installer, stable Homebrew cask `claude-code`, latest Homebrew cask `claude-code@latest`, WinGet package `Anthropic.ClaudeCode`, and the documented apt, dnf, and apk packages. The npm package `@anthropic-ai/claude-code` remains available but is deprecated in favor of the native installer ([Claude Code installation](https://code.claude.com/docs/en/installation), [official Claude Code repository](https://github.com/anthropics/claude-code#installation)).
- **Implemented in this build:**
  - recognized native install: the resolved `claude update`;
  - deprecated npm installs: `npm install -g @anthropic-ai/claude-code@latest`, pinned to the detected prefix;
  - the stable Homebrew cask: `brew upgrade --cask claude-code`.
- **Version probe:** `claude --version`; `claude doctor` is the vendor's installation diagnostic.
- **Vendor-supported but manual-only/planned:** WinGet, apt, dnf, apk, the `claude-code@latest` Homebrew cask, conflicting installations, unidentified wrappers, and custom layouts. The two Homebrew casks are distinct channels: `claude-code` tracks stable, while `claude-code@latest` tracks latest. This build positively matches and updates only the stable cask; it must not silently move either cask to the other channel. This build also does not yet detect or update `Anthropic.ClaudeCode` as a WinGet-owned target. An operator who verifies that exact package may run `winget upgrade --id Anthropic.ClaudeCode --exact` manually; Microsoft documents `--id` and `--exact` as package disambiguation options ([WinGet upgrade](https://learn.microsoft.com/en-us/windows/package-manager/winget/upgrade)). Anthropic recommends `where.exe claude` to find conflicting Windows installs ([installation troubleshooting](https://code.claude.com/docs/en/troubleshoot-install)).
- **Windows notes:** Anthropic explicitly warns that a WinGet update can fail while Claude is running because Windows locks the executable. Native background updates take effect on the next launch. For a deprecated npm installation that has not yet migrated, Anthropic's current troubleshooting guidance uses `npm install -g @anthropic-ai/claude-code@latest` rather than a generic global npm update ([plugin troubleshooting](https://code.claude.com/docs/en/discover-plugins#plugin-command-not-recognized)).

### Cursor Agent

- **Vendor-supported channel:** Cursor's Agent installer on macOS, Linux, and Windows through WSL ([Cursor CLI installation](https://docs.cursor.com/en/cli/installation)).
- **Implemented in this build:** only a resolved executable positively identified as the standalone Cursor Agent may run the resolved `cursor-agent update` command.
- **Version probe:** `cursor-agent --version`.
- **Vendor-supported but manual-only/planned:** Cursor editor launchers, `cursor`, `cursor agent`, editor helpers, generic wrappers, and any custom path that cannot be identified as Cursor Agent. Super Synara must never synthesize `cursor agent update` from an editor launcher.
- **Windows notes:** the vendor documents Windows support through WSL, not a native Windows Cursor Agent install. Accepting an editor CLI path for other integration features does not make it safe to run the Agent updater against that path.

### Google Antigravity

- **Vendor-supported channel:** Google's native shell, PowerShell, or CMD installer. The documented Windows directory is `%LOCALAPPDATA%\agy\bin` ([Antigravity installation](https://antigravity.google/docs/cli-install)).
- **Implemented in this build:** a binary positively matched to the official native layout may run the resolved `agy update`.
- **Version probe:** `agy --version`.
- **Vendor-supported but manual-only/planned:** bare `agy` commands whose official layout cannot be proven, wrappers, and custom native paths that cannot be tied to Google's updater metadata; show the vendor installer and troubleshooting links instead.
- **Windows notes:** Google's installer copies `agy.exe` into place and explicitly reports that a running executable may prevent the write ([official `install.ps1`](https://antigravity.google/cli/install.ps1)). Idle Super Synara-owned Antigravity runtimes therefore have to exit before update.

**Artifact-verified, 2026-07-20:** the Windows binary referenced by Google's checksum manifest exposed `agy update` and `agy --version`. Google's public documentation describes its background self-updater, 15-minute debounce, and advisory `update.lock`, but does not currently document the `update` command's flags ([Antigravity updater troubleshooting](https://antigravity.google/docs/cli-troubleshooting), [official Windows manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json)). Treat the command spelling as artifact-verified rather than a documented compatibility guarantee.

### Grok Build

- **Vendor-supported channels:** xAI's native shell or PowerShell installer and npm package `@xai-official/grok` ([Grok Build overview](https://docs.x.ai/build/overview), [enterprise distribution](https://docs.x.ai/build/enterprise)).
- **Implemented in this build:** health and version probing only. The current build intentionally exposes no Grok one-click update action because it cannot yet prove the selected stable or alpha channel.
- **Version probe:** xAI documents `grok version`; the current vendor-published npm artifact also accepted `grok --version` when artifact-verified on 2026-07-20 ([published npm metadata](https://registry.npmjs.org/%40xai-official%2Fgrok/latest)).
- **Vendor-supported but manual-only/planned:** all Grok updates in this build when channel provenance is unavailable, plus unrecognized custom binaries and operator-managed enterprise distributions. The current generic Grok detection does not establish stable versus alpha, so it must not present a one-click action. After the operator identifies the intended channel, use the vendor's explicit stable or alpha command manually.
- **Channel rule:** `grok update` supports stable and alpha channels. Preserve the detected/current channel and do not silently move a user from alpha to stable or vice versa. If the current channel cannot be established, leave the update manual. The command also provides `grok update --check` ([Grok CLI reference](https://docs.x.ai/build/cli/reference)).
- **Windows notes:** xAI documents a native PowerShell installer. Until the updater documents atomic or side-by-side replacement, apply the normal idle-runtime and file-lock rules.

### Factory Droid

- **Vendor-supported channels:** Factory's native shell or PowerShell installer, Homebrew cask, and npm package `droid` ([Droid quickstart](https://docs.factory.ai/cli/getting-started/quickstart), [Factory repository](https://github.com/Factory-AI/factory#installation)). Factory also currently publishes the official npm identity [`@factory/cli`](https://registry.npmjs.org/%40factory%2Fcli/latest); it is a separate install identity and is not interchangeable with `droid`.
- **Implemented in this build:** exact npm packages `droid` and `@factory/cli`, each with an allowed `droid` manifest bin and accepted local `latest` evidence. Super Synara runs `npm install -g <detected-package>@latest`, pinned to the detected prefix, so each installation remains on its existing package identity. For a recognized native Windows executable, Super Synara runs the vendor-owned `droid update`. If that process exits successfully but an immediate `droid --version` still reports the old version, Super Synara starts the same exact executable once more with the documented non-installing `droid update --check`. The second process exists so Droid's Windows bootstrap can apply a pending marker before command dispatch; `--check` itself only checks for an available update.
- **Version probe:** `droid --version`.
- **Vendor-supported but manual-only/planned:** Homebrew, unrecognized custom paths, ambiguous wrappers, and either npm identity when its exact package, root, or `latest` channel evidence cannot be proved. A Homebrew cask must be updated with its owning Homebrew installation. Never silently migrate `@factory/cli` to `droid` or `droid` to `@factory/cli`.
- **Windows artifact verification (2026-07-24):** a signed Factory Windows x64 artifact contained a bootstrap call to `applyPendingWindowsUpdate()` before subcommand dispatch. A captured 0.174.0-to-0.178.0 vendor log recorded the pending marker being applied and deleted before the later `--check` HTTP request. A separately staged signed 0.179.0 artifact had SHA-256 `04dfd8ebe239bce8528e4022108093b7b3324dbfee17cb6bd2a951ff916786bc`, matching Factory's published checksum. This is artifact-verified behavior, not a public guarantee that `--check` installs anything.
- **Windows fail-closed boundary:** keep provider runtimes quiesced and the maintenance gate closed across both vendor processes and the final version probe. Never replace Droid's executable or edit Factory's pending-update files directly. Both processes must use the exact resolved executable. Abort or report an unverified result on settings/target drift, a latched provider gate, nonzero or unproven process exit, or a version that remains unchanged after bounded verification.

Factory's [public CLI reference](https://docs.factory.ai/reference/cli-reference) documents `droid update` as the installer and explicitly defines `droid update --check` as checking without installation. Source-specific package-manager updates remain the conservative choice when package ownership is known.

### Kilo Code

- **Vendor-supported channels:** npm package `@kilocode/cli` and platform release binaries, including a Windows x64 baseline build for processors without AVX support ([Kilo CLI documentation](https://kilo.ai/docs/code-with-ai/platforms/cli)).
- **Implemented in this build:**
  - npm: `npm install -g @kilocode/cli@latest`, pinned to the detected prefix;
  - recognized native layout: the resolved `kilo upgrade`.
- **Version probe:** `kilo --version`.
- **Vendor-supported but manual-only/planned:** custom release layouts, ambiguous wrappers, and any local update attempted while this build cannot prove the ownership and idle state of every live provider session. A configured external Kilo server is separately managed and is never stopped or updated by Super Synara. `kilo uninstall` is a removal command, not an update recovery mechanism.
- **Windows notes:** quiesce only local Kilo servers owned by Super Synara. A configured server URL is external and follows the external-server contract below.

### OpenCode

- **Vendor-supported channels:** native installer, npm, Bun, pnpm, yarn, Homebrew, and on Windows Chocolatey and Scoop. The vendor recommends WSL on Windows and marks native Windows Bun support as in progress ([OpenCode introduction](https://opencode.ai/docs)).
- **Implemented in this build:**
  - recognized native installer: the resolved `opencode upgrade`;
  - npm: `npm install -g opencode-ai@latest`, pinned to the proven global prefix;
  - pnpm: `pnpm add -g opencode-ai@latest` against the proven global root;
  - Bun: `bun i -g opencode-ai@latest` against the proven global root;
  - Homebrew: `brew upgrade anomalyco/tap/opencode` for the documented tap install.
- **Version probe:** `opencode --version`.
- **Vendor-supported but manual-only/planned:** Chocolatey, Scoop, yarn, native Windows Bun, ambiguous custom binaries, and any local update attempted while this build cannot prove the ownership and idle state of every live provider session. Safe manual commands include `choco upgrade opencode` and `scoop update opencode` when those managers own the installation ([Chocolatey upgrade](https://docs.chocolatey.org/en-us/choco/commands/upgrade/), [Scoop commands](https://github.com/ScoopInstaller/Scoop/wiki/Commands)). A configured external OpenCode server is separately managed and is never stopped or updated by Super Synara.
- **Latest-version limitation:** an npm registry version is never used as the Homebrew “latest” value. Super Synara queries Homebrew's own formula metadata for a proven Homebrew install; if comparable tap metadata is unavailable, the advisory remains unknown and post-update same-target verification decides the result.
- **Uninstall:** `opencode uninstall` is documented, but it must never be used as an automatic update fallback.
- **Windows notes:** prefer WSL. The `opencode upgrade` command documents explicit installer methods and retention options for uninstall ([OpenCode CLI reference](https://opencode.ai/docs/cli/)).

### Pi

- **Vendor-supported channels:** npm, pnpm, yarn, Bun, and the vendor shell installer. Pi recommends `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` for npm installation ([Pi documentation](https://pi.dev/docs/latest)).
- **Implemented in this build for the external CLI:** exact npm, pnpm, or Bun installations may be updated in their proven owning root. npm updates preserve Pi's recommended `--ignore-scripts` flag.
- **Version probe:** `pi --version`.
- **Vendor-supported but manual-only/planned:** the vendor-shell `pi update` / `pi update --self` path, yarn, unidentified manager roots, custom paths, ambiguous wrappers, and any external CLI whose owning installation cannot be proven ([Using Pi](https://pi.dev/docs/latest/usage)).
- **Windows notes:** Pi requires Bash on Windows and documents Git Bash as the default choice ([Pi Windows setup](https://pi.dev/docs/latest/windows)).

Pi is a deliberate exception to the runtime-quiescence rules: Super Synara provider sessions load the Pi SDK bundled with the Super Synara server ([Pi adapter](../apps/server/src/provider/Layers/PiAdapter.ts), [server dependencies](../apps/server/package.json)). Updating a separately installed `pi` command updates that external command, not the already bundled provider runtime. The bundled Pi version changes only with a Super Synara release that updates its dependency. Consequently, a global Pi CLI update must not stop or claim to refresh active embedded Pi sessions; the result should explicitly distinguish “external CLI updated” from “bundled Super Synara Pi runtime unchanged.”

## Runtime drain and lazy resume

The current-build contract is a two-phase update rather than “spawn updater and hope.” Where this build lacks the necessary per-session ownership, resume-cursor, or canonical-install-root proof, it must defer to the manual path rather than approximate this sequence.

### 1. Preflight and drain

- Establish the exact target and serialize the provider update. The root-scoped lock key includes the canonical physical install root, and Super Synara holds both an in-process semaphore and an OS-visible owner-token lock so separate server processes cannot update that root concurrently. A well-formed lock is recovered only when its recorded owner PID is dead; live, malformed, symlinked, PID-reused, or otherwise unprovable ownership fails closed. If the owning root cannot be canonicalized, do not run the update. A lock conservatively retained because its PID was reused may require the unrelated process to exit or the machine to restart; never delete an owner lock without first proving it is stale.
- Keep target reservation and cleanup interruption-safe. A command interrupted while queued must release its provider reservation, and interruption during execution must release the cross-process owner token without releasing a lock owned by another process.
- Inspect every live provider session and every Super Synara-owned runtime that may use that target, including app-server, local server, git-generation, text-generation, and tool processes.
- If any such runtime has active work, do not interrupt it. The app may leave the update visibly waiting or ask the user to retry after work settles.
- If this build cannot prove on a per-session basis which target a live session owns, that it is idle, and that its provider-native resume cursor is already durable, defer the update. Session presence alone is not proof that stopping is safe.
- Once every affected runtime is proven idle and resumable, prevent a new affected turn from racing the drain.
- Stop only those proven idle, Super Synara-owned runtimes gracefully, close their tracked process trees, and wait for confirmed exit. Keep provider-native resume cursors and local thread state.
- If a runtime cannot be proven stopped, release the drain and fail before executing the updater.

### 2. Update and resume lazily

- Execute the source-correct updater with bounded output and timeout handling.
- Re-resolve the exact binary and probe its version after the command exits. Exact target fingerprints are for the repeated pre-spawn checks. Post-update comparison uses the stable destination identity instead: source, visible launcher, canonical root, owning manager, and channel provenance must match, while a versioned canonical payload path may legitimately change. Fresh resolver evidence and the version probe must still prove the resulting binary and channel.
- Apply the result semantics above. Exit zero without same-target, same-channel version proof is “completed but change unverified” or “completed but configured binary unchanged,” never “updated.”
- Do not recreate stopped runtimes merely to prove they start. The next user turn starts the new provider process and attempts native resume from the preserved cursor.
- If the update fails after an idle runtime was stopped, preserve the cursor and allow the next turn to lazily start whichever valid version remains installed. Do not erase history or silently create a new provider conversation when resume fails.

## External OpenCode and Kilo servers

When an OpenCode or Kilo configuration supplies `serverUrl`, Super Synara is a client of an external server ([OpenCode-compatible runtime](../apps/server/src/provider/opencodeRuntime.ts)). “External” is an ownership boundary, not a statement about which computer hosts the process.

- Never stop, signal, restart, or update that server.
- Do not count the external server as a Super Synara-owned lock holder.
- Updating a local `opencode` or `kilo` binary does not update the external server and must not be reported as doing so.
- **Conservative current-build rule:** defer a local OpenCode or Kilo CLI update while any live session for that provider exists unless Super Synara can prove, per session, that the session is external, does not own or use the local target, and has no Super Synara-managed local process holding it. A configured `serverUrl` by itself is not sufficient ownership proof.
- A proven external session may remain connected during a local CLI update because its server and transport are outside the local installation. If that separation cannot be proven, defer; never disconnect or kill the external session to make the update proceed.
- When the current configuration UI exposes it, identify the external server URL and direct its operator to the relevant vendor instructions when its version needs maintenance. Otherwise direct the operator to inspect the configured URL manually; do not infer server ownership from missing diagnostics.

For locally spawned OpenCode-compatible servers, Super Synara may stop only idle pooled servers it owns after it has proven a durable resume path, wait for the complete tracked process tree to exit, update the exact local binary, and let the next turn start a new local server lazily. Otherwise the current build defers the update.

## Windows file locking

Windows commonly denies deletion or replacement while an executable is open. The Windows file API specifies that a handle opened without delete sharing blocks later delete access until the handle closes, producing a sharing violation ([Microsoft `CreateFile` documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)). Microsoft provides Restart Manager so installers can identify applications using files and coordinate a user-approved shutdown and restart ([About Restart Manager](https://learn.microsoft.com/en-us/windows/win32/rstmgr/about-restart-manager), [secondary-installer workflow](https://learn.microsoft.com/en-us/windows/win32/rstmgr/using-restart-manager-with-a-secondary-installer)).

Every native-Windows provider command routed through Super Synara's contained launch path runs behind the architecture-matched `synara-windows-job-launcher.exe`. The launcher creates the provider suspended, assigns it to a kill-on-close Job Object, and resumes it only after assignment succeeds. Normal shutdown is cooperative: the server writes a unique per-launch stop request, and the launcher terminates the Job itself. The retained wrapper handle remains an emergency containment fallback, but killing that wrapper directly permanently invalidates the file-release proof and the update stays failed.

The launcher publishes completion only after it has captured exact handles for current Job members, verified their Job membership, terminated surviving processes, observed `ActiveProcesses == 0`, waited the captured handles to signal, released the retained process and Job handles, removed the stop request, and atomically written the exact `drained\n` acknowledgement. The server then requires both wrapper exit and that acknowledgement before it lets CLI maintenance proceed, and removes the acknowledgement after validation. It never substitutes CIM discovery, `taskkill`, or a numeric-PID signal for this proof. Microsoft documents that `TerminateJobObject` terminates every associated process and that `ActiveProcesses` is decremented only after a terminated process exits and its process references are released ([Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [`TerminateJobObject`](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject), [`JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)). This prevents a reused PID from being mistaken for an owned process and prevents an owned descendant that still maps a CLI executable from satisfying the updater's release gate.

The acknowledgement proves only the Super Synara-owned Job is drained. Antivirus, an installer, another terminal, an editor, or any other external process can still acquire the file afterward. A resulting sharing violation remains external lock evidence and is reported rather than bypassed or resolved by killing an unowned process.

Source checkouts must build the launcher for the host architecture with `node apps/server/scripts/build-windows-job-launcher.mjs --arch x64` or `--arch arm64`. Published CLI validation requires both architectures, while a packaged desktop carries its selected architecture. A missing, malformed, or wrong-architecture launcher is a fail-closed startup error, never permission to use uncontained PID-based cleanup.

For Super Synara this means:

- `EBUSY`, `EPERM`, `ERROR_SHARING_VIOLATION`, “file is in use,” and failed rename/unlink errors are lock evidence, not reasons to delete more aggressively.
- Stop and await only idle process trees that Super Synara owns.
- Never kill an external process automatically. If another terminal, editor, service, or external server owns the lock, identify the path and ask the user to close or update it.
- Do not retry in a tight loop and do not fall back to recursive deletion, uninstall/reinstall, or provider-state removal.
- Prefer a vendor's documented side-by-side or deferred updater when one exists, such as the current Codex standalone installer.

## Troubleshooting

### Windows containment helper is unavailable

1. In a source checkout, install the matching Visual Studio 2022 C++ build tools and run the architecture-specific build command above.
2. For an installed CLI or desktop release, repair or reinstall the same trusted release so its packaged launcher is restored. Do not copy an unrelated executable into the expected path.
3. Do not bypass containment to make a provider start. Report the checked launcher paths and architecture from the error, then resolve the packaging or installation problem before retrying.

### `EBUSY`, `EPERM`, or a sharing violation

1. Let all turns, approvals, reviews, and provider background tasks finish.
2. Retry once only after Super Synara reports that the affected runtime is owned, idle, resumable, and stopped. Otherwise use the manual path after closing the process yourself.
3. Close any provider CLI you opened separately in a terminal or editor. Super Synara will not close it for you.
4. For OpenCode or Kilo with a configured server URL, maintain that server separately; retrying a local binary update cannot replace it.
5. Verify which command is actually selected on Windows:

   ```powershell
   Get-Command codex -All
   where.exe codex
   npm prefix -g
   npm root -g
   ```

   Repeat the first two commands with the affected provider's executable name. If the configured path and package-manager prefix do not agree, use the owning manager manually or correct the configured path.

6. If the locker cannot be identified safely, restart Windows and run the owning update command before reopening provider terminals. Do not delete the provider package directory by hand.

### Completed but the configured binary is unchanged

- Confirm the post-update probe ran against the configured absolute path rather than a different `PATH` entry.
- Confirm latest-version metadata came from the same stable/alpha and package-manager channel.
- Open a new terminal if the installer changed `PATH`, shims, symlinks, or junctions.
- For Pi, confirm whether the UI is reporting the external `pi` command or Super Synara's bundled Pi runtime.
- For external OpenCode/Kilo servers, check the server version separately; a local CLI update cannot change it.

### Multiple installations are present

Keep one authoritative installation when practical. Until the conflict is resolved, use an explicit binary path and manual updates. Never let Super Synara guess which installation to remove.

### Authentication or configuration appears missing

An update must not delete provider state. Stop before removing directories such as `.codex`, `.claude`, `.factory`, `.grok`, or provider keyring entries. Verify that the updated command is running as the same operating-system user and from the intended install channel, then follow the vendor's authentication diagnostics.

## Evidence labels

- **Vendor-documented** statements come from the inline official documentation or first-party repositories.
- **Artifact-verified** statements were checked against the vendor-published artifact on the stated date but are not yet promised by its public documentation.
- The drain, ownership, exact-source, and lazy-resume rules are the **Super Synara design contract**. They are engineering requirements derived from provider process ownership and documented Windows replacement constraints, not claims made by the CLI vendors.
