# Super Synara

Super Synara is an unofficial downstream build of [Synara](https://github.com/Emanuele-web04/Synara), a local-first desktop app for coding with the AI agents and subscriptions you already use.

> [!IMPORTANT]
> Super Synara is independently maintained, unsigned, and distributed as a prerelease. It is not endorsed or supported by the upstream Synara project. Updates are manual: download each new release from the [Super Synara releases page](https://github.com/slashdevcorpse/synara/releases), verify its published SHA-256 checksum, and install it yourself.

It brings chats, terminals, browser previews, diffs, branches, provider sessions, and handoffs into one focused workspace so you can run agent work without juggling a dozen windows.

![Synara app showing parallel agent threads, terminal output, and project navigation](assets/prod/readme-screenshot.jpeg)

## What it does

- Use the AI accounts you already pay for: Claude Code, Codex, Command Code, Antigravity, OpenCode, Cursor, Grok, Droid, Kilo Code, and Pi.
- Run parallel work across projects, threads, and isolated Git worktrees without branches stepping on each other.
- Keep split chats, terminals, browser previews, and agent output visible in the same window.
- Hand off a thread to another provider when you want a second model to pick up with the same context.
- Review diffs, create branches, commit, push, and open PRs from the app.
- Keep your workspace local. Synara stores chats, projects, and history on your machine and talks directly to the providers you choose.

## How to use

> [!WARNING]
> You need to have [Codex CLI](https://github.com/openai/codex) installed and authorized for Codex sessions to work.

Install an unsigned prerelease from the [Super Synara releases page](https://github.com/slashdevcorpse/synara/releases). Read the [Super Synara installation guide](./docs/super-synara-install.md) before running a download; it covers checksum verification and the per-app Windows SmartScreen and macOS Gatekeeper prompts. Do not disable either operating-system protection globally. See the [provider CLI update runbook](./docs/provider-cli-updates.md) before using or troubleshooting provider updates.

You can also run Synara locally while the project is still early:

```sh
bun install
bun run dev
```

## Privacy

Synara runs as the workspace layer on your machine. There is no Synara cloud holding your repositories, chats, or project history.

The provider you choose still receives the prompts, file snippets, diffs, terminal output, or tool results needed for a session, but that traffic goes to the provider you picked rather than through a separate Synara-hosted workspace.

## Some notes

Synara is still very early. Expect bugs, rough edges, and fast-moving internals.

Focused issues and PRs are welcome, especially bug fixes, reliability fixes, and small maintenance improvements.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need Super Synara support? [Open an issue in the downstream repository](https://github.com/slashdevcorpse/synara/issues). Do not send Super Synara support requests to the upstream Synara maintainers.

## Identity and attribution

Super Synara installs beside upstream Synara with a separate application identity, URL scheme, desktop profile, backend home, and Windows installer registration. It does not intentionally reuse or migrate the upstream Synara profile.

Super Synara is derived from [Synara](https://github.com/Emanuele-web04/Synara), copyright © 2026 Emanuele Di Pietro, and is distributed under the [MIT License](./LICENSE). The upstream project and its maintainers do not provide support for this downstream build.
