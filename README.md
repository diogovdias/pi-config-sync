# pi-config-sync

Securely sync your `~/.pi/agent` configuration across machines through a git remote.
It is a [pi package](https://pi.dev/packages) and keeps the repository **in place** so its history stays transparent.

## Install

```sh
pi install npm:pi-config-sync
```

## Quickstart

On the first machine, run `/gitsync init`. With authenticated GitHub CLI (`gh auth login`), it detects your account, creates a private `pi-agent-config` repository, commits the allowed configuration, and pushes it.

Without `gh`, first create a private remote yourself, then run:

```text
/gitsync init git@github.com:you/pi-agent-config.git
```

On each additional machine, run `/gitsync link` (with `gh`) or `/gitsync link <remote-url>`. It fetches the remote configuration. A differing local allowed file is moved to `<file>.local-backup`; it is never deleted, and linking refuses to touch a directory that already has its own git history. Run `/reload` afterwards; local-only allowed files are committed and pushed by the next sync.

## Commands

| Command | Description |
| --- | --- |
| `/gitsync init [name\|owner/name\|url]` | Create and connect the first-machine repository |
| `/gitsync link [name\|owner/name\|url]` | Connect another machine |
| `/gitsync status` | Show repository and tracked-secret status |
| `/gitsync sync` | Commit, fetch/rebase, and push |
| `/gitsync push` | Commit and push without pulling |
| `/gitsync pull` | Fetch and integrate remote changes |

## Security model

This package uses an **allowlist**, not a broad config-directory upload. By default it syncs `.gitignore`, `settings.json`, `AGENTS.md`, `git-sync.jsonc`, and `extensions/`, `chains/`, `prompts/`, `themes/`, and `skills/`. You can add safe paths explicitly.

It never stages auth files, token/secret/credential-named files, `.env` files, sessions, state, package/cache directories, or `node_modules`. That policy is enforced four ways: a managed allowlist `.gitignore`, `.git/info/exclude`, a post-stage hard guard that resets and aborts any bad staging, and a tracked-file scan warning. It never force-pushes.

Git commands operate only on the agent directory's own repository — `GIT_CEILING_DIRECTORIES` stops git from ever discovering a parent repository (such as dotfiles in `$HOME`), and sync refuses to run until `~/.pi/agent/.git` itself exists. GitHub CLI calls are account-level (`gh api user`, `gh repo view/create`) and never modify repository contents. Use a private repository. When `gh` can identify a public GitHub remote, the package warns; it does not block because no credentials are synced.

## Configuration

Create `~/.pi/agent/git-sync.jsonc`:

```jsonc
{
  "autoSyncIntervalMinutes": 5,
  "includeHostname": true,
  "extraPaths": ["my-safe-directory"],
  "warnOnPublicRemote": true
}
```

Unsafe extra paths (secrets, cache names, absolute paths, or `..`) are rejected. Set `includeHostname` to `false` to omit the machine hostname from automatic commit messages.

## Conflicts and uninstall

On a sync conflict, rebase is aborted and the repository is left untouched for manual resolution:

```sh
cd ~/.pi/agent
git status
git pull --rebase
```

Remove the package with `pi remove npm:pi-config-sync`. Your local repository and remote remain until you delete them yourself.

If migrating from a hand-rolled `extensions/git-sync.ts`, delete that file first to avoid duplicate `/gitsync` registration.

Onboarding flow inspired by [opencode-synced](https://github.com/iHildy/opencode-synced).

## Releases

Tags matching `v*` publish automatically through the included GitHub Action using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no registry tokens exist anywhere in the pipeline. Every release carries a provenance attestation linking the tarball to its exact source commit, verifiable on the npm package page.
