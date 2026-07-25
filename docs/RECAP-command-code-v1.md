# Command Code v1 runtime upgrade

## Summary

Super Synara now treats Command Code v1 as the minimum supported runtime and consumes the supported headless JSON protocol instead of projecting raw standard output. The integration remains an external-CLI integration: the repository does not depend on or bundle the `command-code` npm package.

The local development machine was upgraded with the vendor command:

```text
npm install -g command-code@latest
```

On 2026-07-25, npm resolved `latest` to Command Code 1.4.1. The [`latest` package metadata](https://registry.npmjs.org/command-code/latest) declared Node.js 22 or newer and exposed four aliases, all targeting `dist/index.mjs`: `cmd`, `cmdc`, `command-code`, and `commandcode`. Super Synara's health check intentionally requires only the stable v1 baseline (`>=1.0.0`) rather than pinning a rapidly changing current release.

Sources:

- [What's new in Command Code v1](https://commandcode.ai/docs/whats-new)
- [Headless mode and JSON contract](https://commandcode.ai/docs/core-concepts/headless)
- [CLI reference](https://commandcode.ai/docs/reference/cli)
- [Quickstart](https://commandcode.ai/docs/quickstart)
- [Windows guide](https://commandcode.ai/docs/troubleshooting/windows)
- [Published npm `latest` metadata](https://registry.npmjs.org/command-code/latest)

## Runtime contract

Each Super Synara turn starts one Command Code print process. The prompt is written to stdin and never placed on the process argument list. The v1 launch uses:

```text
-p
--output-format json
--skip-onboarding
--trust
--no-auto-update
--max-turns 10
--resume <session-id>
--model <model-id>
--plan or --yolo, as selected by the runtime mode
```

`COMMANDCODE_SKIP_UPDATES=1` remains in the child environment as a second guard against a provider process replacing itself while Super Synara owns it.

Command Code writes one JSON object per line. Event envelopes carry live activity; a final result envelope carries the authoritative outcome, optional print-session identifier, stop reason, usage, duration, final text, and any structured error. Super Synara:

1. decodes UTF-8 incrementally across arbitrary process chunks;
2. accepts LF, CRLF, blank lines, and a final line without a newline;
3. projects supported session, assistant-text, reasoning, and tool records;
4. ignores unknown event types for forward compatibility;
5. uses `finalText` only when no assistant text was streamed;
6. treats malformed envelopes, limit violations, duplicate results, records after a result, and a missing result as protocol failures;
7. maps `success`, `error`, and `max_turns` results together with the documented process exit codes;
8. preserves a prior resume cursor when an early error result has no session ID, while rejecting unsafe cursors or a session ID that changes during a turn;
9. converts per-run usage into Synara's cumulative per-thread processed-token counter without double-counting cache-read or cache-write details.

The parser does not render `message_update`, `message_end`, or `run_end` state snapshots as assistant text. Those records can repeat large conversation state and are unnecessary once the stable deltas and terminal result have been consumed. They are parsed under separate per-line, high-water-byte, and frame-count bounds so cumulative snapshots do not exhaust the normal projected-record budget, while an absolute transport-byte cap still bounds a stream made entirely of redundant snapshots.

## Health and upgrade behavior

The health path resolves the configured executable, runs `--version`, rejects versions below 1.0.0 or output whose version cannot be determined, and only then runs `status --json`. A rejected runtime is unavailable and receives an explicit `npm i -g command-code@latest` remediation.

Authenticated v1 installations remain eligible for the existing read-only npm latest-version advisory. One-click updates still require exact npm package ownership, an accepted local `latest` request, a proven global prefix, and idle Super Synara-owned runtimes. The vendor's `cmd update` command remains manual-only.

Command Code owns migration of its documented legacy keybinding settings, pasted-text collapsing setting, and per-project taste state on first save. Its v1 notes separately describe pre-v1 sessions as backward compatible. Super Synara does not perform either migration or rewrite Command Code's local state.

Command Code documents these headless exit codes:

| Code | Meaning                    |
| ---: | -------------------------- |
|    0 | Success                    |
|    1 | General error              |
|    3 | Not authenticated          |
|    4 | Permission denied          |
|    5 | Rate limited               |
|    6 | Network failure            |
|    7 | API server error           |
|    8 | Maximum turns reached      |
|    9 | Model produced no response |
|   10 | Insufficient credits       |
|  130 | Interrupted                |

The adapter uses structured result errors first, then the documented exit classification, then sanitized stderr as a final fallback.

## Platform behavior

| Platform       | Command Code status                                | Super Synara behavior                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS          | Vendor-supported                                   | Direct shell-free launch, PATH or configured alias resolution, detached process-group ownership.                                                                                                                                          |
| Linux          | Vendor-supported                                   | Direct shell-free launch, PATH or configured alias resolution, detached process-group ownership.                                                                                                                                          |
| WSL            | Vendor-supported and recommended for Windows users | Treated as a separate Linux installation; no implicit native-to-WSL executable bridge.                                                                                                                                                    |
| Native Windows | The dedicated vendor guide says alpha              | Require PowerShell 7+ for Command Code's shell-command tool; prefer `cmdc`; reject accidental `cmd.exe`; resolve npm `.cmd` shims; preserve verbatim arguments; hide child windows; supervise the process tree with a Windows Job Object. |

The v1 announcement describes full Windows support, while the dedicated Windows guide still says native support is alpha. This change follows the conservative dedicated guide. It does not claim support for architectures that the vendor has not documented.

## Validation boundary

The focused tests cover protocol framing and validation, assistant/reasoning/tool/result projection, resume behavior, error classification, Windows npm-shim preparation, Windows non-detached containment, and injected macOS/Linux detached-process behavior.

On native Windows, all non-conflicting package aliases (`commandcode`, `command-code`, and `cmdc`) reported 1.4.1. A stdin-driven `cmdc -p --output-format json` smoke run emitted v1 event envelopes, cumulative snapshots, one terminal success result, and the requested final text.

At the time of this change, the repository's live platform CI jobs exercise Windows. macOS and Linux behavior is covered structurally through injected-platform unit tests; the disabled native macOS/Linux CI jobs were not re-enabled as part of this focused provider upgrade.

## Release boundary

This is a runtime integration and documentation change only. It does not update the product version, changelog release entries, tags, release workflows, or published artifacts.
