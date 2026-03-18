#!/bin/bash
# cleanup.sh — Workspace cleanup
# Usage: bash cleanup.sh --workspace <path>
#        bash cleanup.sh --workspace .
# Cleans only the given workspace. Does not discover or modify other workspaces.
# Removes temporary files, stale artifacts, and common junk.
# Dry-run by default; pass --apply to actually delete.
set -euo pipefail

WORKSPACE=""
DRY_RUN=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      if [ $# -lt 2 ]; then
        echo "ERROR: --workspace requires a path argument"
        echo "Usage: cleanup.sh --workspace <path> [--apply]"
        exit 1
      fi
      WORKSPACE="$2"
      shift 2
      ;;
    --apply)
      DRY_RUN=false
      shift
      ;;
    -h|--help)
      echo "Usage: cleanup.sh --workspace <path> [--apply]"
      echo "  --workspace <path>  Workspace to clean (required)"
      echo "  --apply             Actually delete files (default: dry-run)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: cleanup.sh --workspace <path> [--apply]"
      exit 1
      ;;
  esac
done

if [ -z "$WORKSPACE" ]; then
  echo "ERROR: --workspace flag is required"
  echo "Usage: cleanup.sh --workspace <path> [--apply]"
  exit 1
fi

if [ ! -d "$WORKSPACE" ]; then
  echo "ERROR: workspace not found: $WORKSPACE"
  exit 1
fi
WORKSPACE="$(cd "$WORKSPACE" && pwd)"

if [ "$DRY_RUN" = false ] && ! command -v trash >/dev/null 2>&1; then
  echo "ERROR: 'trash' is not installed — refusing to permanently delete files."
  echo "  Install: brew install trash (macOS) or apt install trash-cli (Linux)"
  echo "  Dry-run mode (without --apply) does not require trash."
  exit 1
fi

if [ "$DRY_RUN" = true ]; then
  echo "=== Cleanup (DRY RUN): $WORKSPACE ==="
else
  echo "=== Cleanup (APPLY): $WORKSPACE ==="
fi
echo ""

TOTAL=0

# Helper: report or remove a file
process_file() {
  local file="$1"
  local reason="$2"
  local rel="${file#"$WORKSPACE"/}"

  if [ "$DRY_RUN" = true ]; then
    echo "  WOULD REMOVE: $rel ($reason)"
  else
    if command -v trash >/dev/null 2>&1; then
      trash "$file"
    else
      echo "  ERROR: 'trash' not installed — refusing to permanently delete $rel"
      echo "  Install: brew install trash (macOS) or apt install trash-cli (Linux)"
      return 1
    fi
    echo "  REMOVED: $rel ($reason)"
  fi
  TOTAL=$((TOTAL + 1))
}

# --- .DS_Store files ---
echo "macOS metadata:"
while IFS= read -r f; do
  [ -n "$f" ] && process_file "$f" ".DS_Store"
done < <(find "$WORKSPACE" -not -path '*/.git/*' -name '.DS_Store' 2>/dev/null || true)
echo ""

# --- Backup files ---
echo "Backup files:"
while IFS= read -r f; do
  [ -n "$f" ] && process_file "$f" "backup"
done < <(find "$WORKSPACE" -not -path '*/.git/*' \( -name '*.bak' -o -name '*~' \) 2>/dev/null || true)
echo ""

# --- Temporary files ---
echo "Temporary files:"
while IFS= read -r f; do
  [ -n "$f" ] && process_file "$f" "temp"
done < <(find "$WORKSPACE" -not -path '*/.git/*' \( -name '*.tmp' -o -name '*.swp' -o -name '*.swo' \) 2>/dev/null || true)
echo ""

# --- Empty log files ---
echo "Empty log files:"
while IFS= read -r f; do
  [ -n "$f" ] && process_file "$f" "empty log"
done < <(find "$WORKSPACE" -not -path '*/.git/*' -name '*.log' -empty 2>/dev/null || true)
echo ""

# --- Summary ---
if [ "$TOTAL" -eq 0 ]; then
  echo "Workspace is clean — nothing to remove."
else
  if [ "$DRY_RUN" = true ]; then
    echo "$TOTAL item(s) would be removed. Run with --apply to execute."
  else
    echo "$TOTAL item(s) removed."
  fi
fi
