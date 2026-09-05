# pi-config-sync

[![npm](https://img.shields.io/npm/v/pi-config-sync)](https://www.npmjs.com/package/pi-config-sync)
[![CI](https://github.com/diogovdias/pi-config-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/diogovdias/pi-config-sync/actions/workflows/ci.yml)

Securely sync your `~/.pi/agent` configuration across machines through a git remote — automatically, with hard guards that keep secrets out.
It is a [pi package](https://pi.dev/packages) and keeps the repository **in place** (`~/.pi/agent` *is* the repo) so its history stays transparent.

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

That is the whole setup — from here on, syncing is automatic.

## How it works

```text
session start    → auto-sync (rate-limited, default every 5 min across sessions)
                   ensure ignore rules → commit allowlisted changes → fetch
                   → fast-forward or rebase → push
                   → notifies you to /reload when remote changes were pulled
session shutdown → best-effort commit + push (next start reconciles the rest)
```

### Machine-local settings

`settings.json` uses a git clean/smudge filter: portable settings are committed, while each machine retains its own selected top-level values. By default this is `lastChangelogVersion`; machine values stay in your live settings file (mirrored to `.git-sync/settings.machine.json`) and are absent only from committed blobs. On an existing repository, the first sync after upgrading creates a one-time commit that strips those keys from the committed blob and normalizes JSON formatting — the live settings file is unchanged.

The filter is fail-open: a checkout on a machine without pi-config-sync still works, but its machine-local values are not stripped until the package runs again. A newly linked machine gets its sidecar as pi writes its local settings.

The filter script runs under the Node.js that runs pi. When pi ships as a single bundled executable (for example through mise), that executable cannot run the script, so the package uses the first `node` found on `PATH` instead and falls back to a disabled filter with a warning. Set `nodePath` in `git-sync.jsonc` to pin a specific Node.js binary; the git filter configuration is corrected on the next sync.

Commits look like `pi config: auto-sync from <hostname>`. Concurrent pi sessions coordinate through a pid-liveness lock, subagent child processes never sync, and a diverged repo aborts the rebase and asks you to resolve manually — nothing is ever forced.

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

This package uses an **allowlist**, not a broad config-directory upload.

### What syncs

| Path | Contents |
| --- | --- |
| `settings.json` | Model defaults, theme, installed package list — committed with machine-local keys stripped |
| `AGENTS.md` | Your global agent instructions |
| `extensions/`, `chains/`, `prompts/`, `themes/`, `skills/` | Your custom resources |
| `.gitignore`, `git-sync.jsonc` | The sync policy itself |
| `extraPaths` entries | Anything safe you add explicitly |

Nothing outside the allowlist ever syncs — new files are ignored by default.

### What never syncs

| Path / pattern | Why |
| --- | --- |
| `auth*` (`auth.json`) | API keys and OAuth tokens |
| `*token*`, `*secret*`, `*credential*`, `*.env*`, `*.local.json` | Anything named like a secret |
| `sessions/`, `state/`, `.git-sync/` | Local history and machine state |
| `npm/`, `git/`, `bin/`, `node_modules` | Installed packages — pi reinstalls them from `settings.json` |

The policy is enforced four ways — a managed allowlist `.gitignore`, `.git/info/exclude`, a post-stage hard guard that resets and aborts any commit staging a denied path, and a tracked-file scan warning — so it holds even against `git add -f`. It never force-pushes.

Git commands operate only on the agent directory's own repository — `GIT_CEILING_DIRECTORIES` stops git from ever discovering a parent repository (such as dotfiles in `$HOME`), and sync refuses to run until `~/.pi/agent/.git` itself exists. GitHub CLI calls are account-level (`gh api user`, `gh repo view/create`) and never modify repository contents. Use a private repository. When `gh` can identify a public GitHub remote, the package warns; it does not block because no credentials are synced.

## Configuration

Create `~/.pi/agent/git-sync.jsonc`:

```jsonc
{
  "autoSyncIntervalMinutes": 5,
  "includeHostname": true,
  "extraPaths": ["my-safe-directory"],
  "warnOnPublicRemote": true,
  "machineLocalSettings": ["lastChangelogVersion"],
  "nodePath": "/usr/local/bin/node"
}
```

Unsafe extra paths (secrets, cache names, absolute paths, or `..`) are rejected. Set `includeHostname` to `false` to omit the machine hostname from automatic commit messages. `machineLocalSettings` replaces the default list when set; it accepts top-level keys only, and `[]` disables stripping (the filter still normalizes committed JSON formatting). Useful candidates include `shellPath`, `externalEditor`, `npmCommand`, `sessionDir`, and `trackingId`. `nodePath` is optional and only needed when pi runs as a bundled executable and Node.js is not on `PATH`, or to pin a specific interpreter for the `settings.json` filter.

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

## Alternatives

- [`pi-git-sync`](https://www.npmjs.com/package/pi-git-sync) — manual-first `/sync` with interactive conflict handling, including agent-assisted merges and force-push / hard-reset options.
- [`pi-sync-config`](https://www.npmjs.com/package/pi-sync-config) — background sync through a separate staging clone, with `settings.json` machine-key stripping, SSH-only remotes, and fast-forward-only pulls.

pi-config-sync differs from both: your agent directory itself is the repository (transparent history, no copy step), sync is fully automatic, onboarding can create the private repo through `gh`, and no destructive git operation exists in any code path. All three register different commands and can coexist.

## Releases

Tags matching `v*` publish automatically through the included GitHub Action using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no registry tokens exist anywhere in the pipeline. Every release carries a provenance attestation linking the tarball to its exact source commit, verifiable on the npm package page.
