# Local pre-commit hooks

Mirrors the GitHub Actions checks (`pii-scan.yml` + `author-identity.yml`)
on every `git commit`, so PII or secrets never reach a public push.

## Install (one-time per clone)

```bash
./.githooks/install.sh
```

This sets `git config core.hooksPath .githooks` and fetches the canonical
gitleaks ruleset into `~/.config/gitleaks/.gitleaks.toml`.

Prerequisites:

- `gitleaks` 8.30.x (`brew install gitleaks`). The hook works around a
  known v8.30 bug where the `git` subcommand ignores `--exit-code` —
  revisit the workaround in `.githooks/pre-commit` when upgrading.
- `jq` (`brew install jq`) — required, not optional. Missing `jq` aborts
  the commit.
- `gh` authenticated against the GitHub account that owns the bot
  (`brew install gh && gh auth login`) — needed only for `sync-config.sh`
  to pull the full ruleset from the private `fitz123/gitleaks-config` repo.

If you can't reach the private config (external contributor): install still
succeeds, the hook runs against gitleaks' built-in default rules. You won't
get the corporate-specific patterns locally, but CI will catch them on the PR.

## What the hooks do

`pre-commit`:

1. Runs `gitleaks git --staged` against the staged diff using
   `$GITLEAKS_CONFIG` (default `~/.config/gitleaks/.gitleaks.toml`).
   Writes a JSON report; any finding aborts the commit and prints the
   rule + file + line. A gitleaks crash, missing report, or unparseable
   output is treated as a hard failure (fail-closed).
2. Verifies the effective commit-author email (`git var GIT_AUTHOR_IDENT`,
   which honors `--author` and `GIT_AUTHOR_EMAIL` overrides) ends with
   `@users.noreply.github.com`.

### Scope gap vs CI

The CI workflow `.github/workflows/author-identity.yml` re-scans every
commit in the PR with `git log --pretty='%h %ae' base..head`. The hook
only validates the commit being created right now. If you cherry-pick
or amend a commit whose original author lacks the noreply suffix, the
hook passes, CI catches it. That gap is acceptable — CI is the
safety net.

## Two-tier ruleset

- **Private full ruleset** (`fitz123/gitleaks-config`) — used by this
  hook locally and by trusted CI runs (push, owner PRs). Includes
  corporate-specific patterns that aren't safe to publish.
- **Public baseline** (`.gitleaks.toml` in this repo) — generic rules
  for personal email providers, phone formats, SSH keys, messaging-ID
  formats, /Users paths, and env-var secret assignments. Used by fork
  PR CI runs that don't have access to the `CONFIG_PAT` secret, so
  external contributions are still scanned.

The reusable workflow `.github/workflows/gitleaks-reusable.yml` prefers
the private ruleset when `CONFIG_PAT` is available and overwrites the
checked-in baseline; otherwise it falls back to the baseline.

Keep the public baseline as a subset of the private — when you add a
generic, non-corporate rule, mirror it into both. Corporate patterns
stay private-only.

## Refreshing the ruleset

Whenever the private config gets new rules:

```bash
./.githooks/sync-config.sh
```

## Bypass

`git commit --no-verify` skips the hook. Don't use it on this repo — CI
will still catch the leak, but you'll have written a public reflog entry
naming the secret. If you have a legitimate reason to bypass (e.g. fixing
the hook itself), do so explicitly in your PR description.

## Troubleshooting

- "gitleaks not installed" — `brew install gitleaks`
- "gh not authenticated" — `gh auth login`
- "fetched file does not look like a gitleaks TOML config" — token expired
  or the source repo moved; check `gh repo view fitz123/gitleaks-config`
- Hook not firing — confirm `git config --get core.hooksPath` returns
  `.githooks`. Re-run `./.githooks/install.sh` if not.
