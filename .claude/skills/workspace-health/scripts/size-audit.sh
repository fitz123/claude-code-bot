#!/bin/bash
# size-audit.sh — Workspace size audit
# Usage: bash size-audit.sh [workspace-path]
# Accepts a workspace path argument; defaults to current directory.
# Reports total workspace size, largest files, and potential bloat.
set -euo pipefail

WORKSPACE="${1:-.}"
WORKSPACE="$(cd "$WORKSPACE" && pwd)"

if [ ! -d "$WORKSPACE" ]; then
  echo "ERROR: workspace not found: $WORKSPACE"
  exit 1
fi

echo "=== Size Audit: $WORKSPACE ==="
echo ""

# Total workspace size (excluding .git)
TOTAL_SIZE=$(du -sh "$WORKSPACE" --exclude='.git' 2>/dev/null || du -sh "$WORKSPACE" 2>/dev/null | head -1)
echo "Total size: $TOTAL_SIZE" | head -1
echo ""

# Top 20 largest files (excluding .git)
echo "Largest files (top 20):"
find "$WORKSPACE" -not -path '*/.git/*' -not -path '*/.git' -type f -exec du -h {} + 2>/dev/null \
  | sort -rh \
  | head -20 \
  | while read -r size path; do
    # Show path relative to workspace
    rel="${path#"$WORKSPACE"/}"
    echo "  $size  $rel"
  done
echo ""

# Check for common bloat patterns
echo "Bloat check:"
ISSUES=0

# node_modules at workspace root (not inside bot/)
if [ -d "$WORKSPACE/node_modules" ]; then
  NM_SIZE=$(du -sh "$WORKSPACE/node_modules" 2>/dev/null | cut -f1)
  echo "  WARN: root node_modules/ found ($NM_SIZE)"
  ISSUES=$((ISSUES + 1))
fi

# Large log files (>1MB)
LARGE_LOGS=$(find "$WORKSPACE" -not -path '*/.git/*' -name '*.log' -size +1M 2>/dev/null)
if [ -n "$LARGE_LOGS" ]; then
  echo "  WARN: large log files (>1MB):"
  echo "$LARGE_LOGS" | while read -r f; do
    size=$(du -h "$f" | cut -f1)
    rel="${f#"$WORKSPACE"/}"
    echo "    $size  $rel"
  done
  ISSUES=$((ISSUES + 1))
fi

# .bak files
BAK_COUNT=$(find "$WORKSPACE" -not -path '*/.git/*' -name '*.bak' 2>/dev/null | wc -l | tr -d ' ')
if [ "$BAK_COUNT" -gt 0 ]; then
  echo "  WARN: $BAK_COUNT .bak file(s) found"
  ISSUES=$((ISSUES + 1))
fi

# Temporary files
TMP_COUNT=$(find "$WORKSPACE" -not -path '*/.git/*' \( -name '*.tmp' -o -name '*.swp' -o -name '*~' \) 2>/dev/null | wc -l | tr -d ' ')
if [ "$TMP_COUNT" -gt 0 ]; then
  echo "  WARN: $TMP_COUNT temporary file(s) found"
  ISSUES=$((ISSUES + 1))
fi

# .DS_Store files
DS_COUNT=$(find "$WORKSPACE" -not -path '*/.git/*' -name '.DS_Store' 2>/dev/null | wc -l | tr -d ' ')
if [ "$DS_COUNT" -gt 0 ]; then
  echo "  INFO: $DS_COUNT .DS_Store file(s)"
fi

if [ "$ISSUES" -eq 0 ]; then
  echo "  OK: no bloat detected"
fi

echo ""
echo "Size audit complete."
