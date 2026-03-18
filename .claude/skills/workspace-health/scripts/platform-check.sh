#!/bin/bash
# platform-check.sh — Platform file drift checker
# Usage: bash platform-check.sh [workspace-path]
# Accepts a workspace path argument; defaults to current directory.
# Compares platform files against upstream remote. Report-only, always exits 0.
# Skips gracefully for non-git workspaces or when upstream remote is unavailable.
set -euo pipefail

WORKSPACE="${1:-.}"
if [ ! -d "$WORKSPACE" ]; then
  echo "ERROR: workspace not found: $WORKSPACE"
  exit 0
fi
WORKSPACE="$(cd "$WORKSPACE" && pwd)"

echo "=== Platform Check: $WORKSPACE ==="
echo ""

# Check if this is a git workspace
if ! git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "SKIP: not a git repository — cannot check platform drift"
  exit 0
fi

# Check for upstream remote
UPSTREAM=$(git -C "$WORKSPACE" remote get-url upstream 2>/dev/null || true)
if [ -z "$UPSTREAM" ]; then
  echo "SKIP: no 'upstream' remote configured — cannot check platform drift"
  echo "  To add: git remote add upstream <url>"
  exit 0
fi

# Fetch upstream (handle failures gracefully)
echo "Fetching upstream..."
if ! git -C "$WORKSPACE" fetch upstream --quiet 2>/dev/null; then
  echo "SKIP: failed to fetch upstream — network unavailable or remote unreachable"
  exit 0
fi
echo ""

# Discover platform files dynamically (hooks, platform rules, settings)
PLATFORM_FILES=()
for f in "$WORKSPACE"/.claude/hooks/*.sh; do
  [ -f "$f" ] && PLATFORM_FILES+=(".claude/hooks/$(basename "$f")")
done
for f in "$WORKSPACE"/.claude/rules/platform/*.md; do
  [ -f "$f" ] && PLATFORM_FILES+=(".claude/rules/platform/$(basename "$f")")
done
[ -f "$WORKSPACE/.claude/settings.json" ] && PLATFORM_FILES+=(".claude/settings.json")

# Determine upstream default branch
UPSTREAM_BRANCH=""
for candidate in main master; do
  if git -C "$WORKSPACE" rev-parse --verify "upstream/$candidate" >/dev/null 2>&1; then
    UPSTREAM_BRANCH="upstream/$candidate"
    break
  fi
done

if [ -z "$UPSTREAM_BRANCH" ]; then
  echo "SKIP: cannot determine upstream default branch (tried main, master)"
  exit 0
fi

# Also discover platform files from upstream (catches upstream-only files)
while IFS= read -r ufile; do
  [ -n "$ufile" ] || continue
  ALREADY=false
  for existing in "${PLATFORM_FILES[@]+"${PLATFORM_FILES[@]}"}"; do
    [ "$existing" = "$ufile" ] && { ALREADY=true; break; }
  done
  [ "$ALREADY" = false ] && PLATFORM_FILES+=("$ufile")
done < <(git -C "$WORKSPACE" ls-tree -r --name-only "$UPSTREAM_BRANCH" -- .claude/hooks/ .claude/rules/platform/ 2>/dev/null | grep -E '\.(sh|md)$' || true)
if git -C "$WORKSPACE" cat-file -e "$UPSTREAM_BRANCH:.claude/settings.json" 2>/dev/null; then
  ALREADY=false
  for existing in "${PLATFORM_FILES[@]+"${PLATFORM_FILES[@]}"}"; do
    [ "$existing" = ".claude/settings.json" ] && { ALREADY=true; break; }
  done
  [ "$ALREADY" = false ] && PLATFORM_FILES+=(".claude/settings.json")
fi

echo "Comparing against $UPSTREAM_BRANCH:"
echo ""

DRIFTED=0
MISSING_UPSTREAM=0

for file in "${PLATFORM_FILES[@]+"${PLATFORM_FILES[@]}"}"; do
  local_path="$WORKSPACE/$file"

  # Check if file exists upstream
  if ! git -C "$WORKSPACE" cat-file -e "$UPSTREAM_BRANCH:$file" 2>/dev/null; then
    echo "  LOCAL-ONLY: $file (not in upstream)"
    MISSING_UPSTREAM=$((MISSING_UPSTREAM + 1))
    continue
  fi

  if [ ! -f "$local_path" ]; then
    echo "  MISSING: $file (exists upstream but not locally)"
    DRIFTED=$((DRIFTED + 1))
    continue
  fi

  # Compare local vs upstream
  UPSTREAM_CONTENT=$(git -C "$WORKSPACE" show "$UPSTREAM_BRANCH:$file" 2>/dev/null)
  LOCAL_CONTENT=$(cat "$local_path")

  if [ "$UPSTREAM_CONTENT" = "$LOCAL_CONTENT" ]; then
    echo "  OK: $file"
  else
    echo "  DRIFT: $file — local differs from upstream"
    DRIFTED=$((DRIFTED + 1))
  fi
done
echo ""

# Summary
if [ "$DRIFTED" -eq 0 ] && [ "$MISSING_UPSTREAM" -eq 0 ]; then
  echo "Platform files are in sync with upstream."
else
  [ "$DRIFTED" -gt 0 ] && echo "$DRIFTED file(s) have drifted from upstream."
  [ "$MISSING_UPSTREAM" -gt 0 ] && echo "$MISSING_UPSTREAM file(s) exist only locally (not in upstream)."
  echo "Review changes and update as needed."
fi

exit 0
