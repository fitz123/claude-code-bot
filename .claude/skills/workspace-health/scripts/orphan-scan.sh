#!/bin/bash
# orphan-scan.sh — Orphan file/directory scanner
# Usage: bash orphan-scan.sh [workspace-path]
# Accepts a workspace path argument; defaults to current directory.
# Flags root-level items that are neither git-tracked nor in the orphan allowlist.
# Users can add workspace-specific entries to orphan-allowlist.local.txt (gitignored).
set -euo pipefail

WORKSPACE="${1:-.}"
if [ ! -d "$WORKSPACE" ]; then
  echo "ERROR: workspace not found: $WORKSPACE"
  exit 1
fi
WORKSPACE="$(cd "$WORKSPACE" && pwd)"

echo "=== Orphan Scan: $WORKSPACE ==="
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Workspace-level allowlists (preferred — customizable per-repo)
# Falls back to skill-level allowlists if workspace ones don't exist
if [ -f "$WORKSPACE/.orphan-allowlist.txt" ] || [ -f "$WORKSPACE/.orphan-allowlist.local.txt" ]; then
  ALLOWLIST="$WORKSPACE/.orphan-allowlist.txt"
  ALLOWLIST_LOCAL="$WORKSPACE/.orphan-allowlist.local.txt"
else
  ALLOWLIST="$SCRIPT_DIR/orphan-allowlist.txt"
  ALLOWLIST_LOCAL="$SCRIPT_DIR/orphan-allowlist.local.txt"
fi

# Load allowlist entries (skip comments and blank lines)
ALLOWED=()
for f in "$ALLOWLIST" "$ALLOWLIST_LOCAL"; do
  if [ -f "$f" ]; then
    while IFS= read -r line; do
      # Skip comments and blank lines
      line="${line%%#*}"
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [ -n "$line" ] && ALLOWED+=("$line")
    done < "$f"
  fi
done

# Get git-tracked root entries
TRACKED=()
if git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r entry; do
    # Extract just the top-level name (first path component)
    top="${entry%%/*}"
    TRACKED+=("$top")
  done < <(git -C "$WORKSPACE" ls-tree --name-only HEAD 2>/dev/null || true)
fi

# Also consider gitignored patterns as "expected"
GITIGNORED=()
if [ -f "$WORKSPACE/.gitignore" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    # Strip trailing slashes for directory patterns
    line="${line%/}"
    # Skip negation rules and empty lines
    [[ -z "$line" || "$line" == !* || "$line" == *\** ]] && continue
    GITIGNORED+=("$line")
  done < "$WORKSPACE/.gitignore"
fi

# Scan root-level items
ORPHANS=()
for item in "$WORKSPACE"/*  "$WORKSPACE"/.*; do
  [ -e "$item" ] || continue
  name=$(basename "$item")

  # Skip . and ..
  [[ "$name" == "." || "$name" == ".." ]] && continue

  # Skip .git
  [ "$name" = ".git" ] && continue

  # Check if git-tracked
  IS_TRACKED=false
  for t in "${TRACKED[@]+"${TRACKED[@]}"}"; do
    if [ "$name" = "$t" ]; then
      IS_TRACKED=true
      break
    fi
  done
  [ "$IS_TRACKED" = true ] && continue

  # Check if in allowlist
  IS_ALLOWED=false
  for a in "${ALLOWED[@]+"${ALLOWED[@]}"}"; do
    if [ "$name" = "$a" ]; then
      IS_ALLOWED=true
      break
    fi
  done
  [ "$IS_ALLOWED" = true ] && continue

  # Check if matches a gitignore pattern
  IS_GITIGNORED=false
  for g in "${GITIGNORED[@]+"${GITIGNORED[@]}"}"; do
    if [ "$name" = "$g" ]; then
      IS_GITIGNORED=true
      break
    fi
  done
  [ "$IS_GITIGNORED" = true ] && continue

  # Check with git check-ignore if available
  if git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git -C "$WORKSPACE" check-ignore -q "$name" 2>/dev/null; then
      continue
    fi
  fi

  ORPHANS+=("$name")
done

# Report
if [ ${#ORPHANS[@]} -eq 0 ]; then
  echo "OK: no orphan files or directories at root"
else
  echo "Orphan items found at root (${#ORPHANS[@]}):"
  for o in "${ORPHANS[@]}"; do
    if [ -d "$WORKSPACE/$o" ]; then
      echo "  DIR:  $o/"
    else
      echo "  FILE: $o"
    fi
  done
  echo ""
  echo "To suppress: add entries to .orphan-allowlist.local.txt in workspace root"
fi

echo ""
echo "Orphan scan complete."
