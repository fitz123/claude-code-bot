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

- `gitleaks` ≥ 8.30 (`brew install gitleaks`)
- `jq` (`brew install jq` — already present on most dev machines)
- `gh` authenticated against the GitHub account that owns the bot
  (`brew install gh && gh auth login`) — needed only for `sync-config.sh`
  to pull the full ruleset from the private `fitz123/gitleaks-config` repo

If you can't reach the private config (external contributor): install still
succeeds, the hook runs against gitleaks' built-in default rules. You won't
get the corporate-specific patterns locally, but CI will catch them on the PR.

## What the hooks do

`pre-commit`:

1. Runs `gitleaks git --staged` against the staged diff using
   `$GITLEAKS_CONFIG` (default `~/.config/gitleaks/.gitleaks.toml`).
   Writes a JSON report; any finding aborts the commit and prints the
   rule + file + line.
2. Verifies `git config user.email` ends with `@users.noreply.github.com`.

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
