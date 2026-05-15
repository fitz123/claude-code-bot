#!/usr/bin/env bash
# Pull the canonical gitleaks ruleset from the private fitz123/gitleaks-config
# repo into a per-user cache. The pre-commit hook reads from this cache.
# Run this once on install, and again whenever the private ruleset is updated.

set -euo pipefail

TARGET="${GITLEAKS_CONFIG:-$HOME/.config/gitleaks/.gitleaks.toml}"
SOURCE_REPO="${GITLEAKS_SOURCE_REPO:-fitz123/gitleaks-config}"
SOURCE_REF="${GITLEAKS_SOURCE_REF:-main}"

if ! command -v gh >/dev/null; then
  echo "FATAL: gh CLI required. Install: brew install gh && gh auth login" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "FATAL: gh not authenticated. Run: gh auth login" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"

# Portable base64 decode: GNU coreutils uses -d; older macOS/BSD only -D.
# Modern macOS (Big Sur+) accepts both — probe and fall back.
if base64 -d </dev/null >/dev/null 2>&1; then
  BASE64_DECODE_FLAG="-d"
else
  BASE64_DECODE_FLAG="-D"
fi

tmp="$(mktemp -t gitleaks-config.XXXXXX.toml)"
trap 'rm -f "$tmp"' EXIT

if ! gh api "repos/$SOURCE_REPO/contents/.gitleaks.toml?ref=$SOURCE_REF" \
     --jq '.content' 2>/dev/null | base64 "$BASE64_DECODE_FLAG" > "$tmp"; then
  echo "FATAL: could not fetch $SOURCE_REPO/.gitleaks.toml@$SOURCE_REF" >&2
  echo "       Check 'gh repo view $SOURCE_REPO' — do you have read access?" >&2
  exit 1
fi

if ! grep -qE '^\[\[rules\]\]|^\[extend\]|^\[allowlist\]' "$tmp"; then
  echo "FATAL: fetched file does not look like a gitleaks TOML config" >&2
  echo "       First lines:" >&2
  head -5 "$tmp" >&2
  exit 1
fi

mv "$tmp" "$TARGET"
trap - EXIT

lines="$(wc -l < "$TARGET" | tr -d ' ')"
echo "Synced $TARGET ($lines lines from $SOURCE_REPO@$SOURCE_REF)"
