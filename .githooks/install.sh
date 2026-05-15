#!/usr/bin/env bash
# One-time setup: enable the versioned .githooks/ directory for this clone and
# fetch the gitleaks ruleset from the private config repo.
#
# Re-runnable. Safe to run multiple times.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ ! -d .githooks ]]; then
  echo "FATAL: .githooks/ not found in repo root" >&2
  exit 1
fi

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/sync-config.sh .githooks/install.sh

if .githooks/sync-config.sh; then
  echo "Pre-commit hooks active. Full gitleaks ruleset cached."
else
  echo
  echo "WARN: gitleaks config sync failed (see error above)." >&2
  echo "      Hooks are still active and will fall back to gitleaks default rules." >&2
  echo "      Re-run .githooks/sync-config.sh once you have access to the private config." >&2
fi
