#!/bin/bash
# hook-integrity.sh — Hook script integrity check
# Usage: bash hook-integrity.sh [workspace-path]
# Accepts a workspace path argument; defaults to current directory.
# Verifies that hook scripts exist, are executable, and match settings.json references.
set -euo pipefail

WORKSPACE="${1:-.}"
if [ ! -d "$WORKSPACE" ]; then
  echo "ERROR: workspace not found: $WORKSPACE"
  exit 1
fi
WORKSPACE="$(cd "$WORKSPACE" && pwd)"

echo "=== Hook Integrity: $WORKSPACE ==="
echo ""

ERRORS=0
WARNINGS=0

HOOKS_DIR="$WORKSPACE/.claude/hooks"
SETTINGS="$WORKSPACE/.claude/settings.json"

# --- Check hooks directory exists ---
if [ ! -d "$HOOKS_DIR" ]; then
  echo "WARN: .claude/hooks/ directory not found"
  echo ""
  echo "Summary: 0 error(s), 1 warning(s)"
  exit 0
fi

# --- Check each hook script ---
echo "Hook scripts:"
for script in "$HOOKS_DIR"/*.sh; do
  [ -f "$script" ] || continue
  name=$(basename "$script")
  if [ -x "$script" ]; then
    echo "  OK: $name — executable"
  else
    echo "  FAIL: $name — not executable (run: chmod +x .claude/hooks/$name)"
    ERRORS=$((ERRORS + 1))
  fi

  # Basic syntax check
  if bash -n "$script" 2>/dev/null; then
    : # syntax OK
  else
    echo "  FAIL: $name — syntax error"
    ERRORS=$((ERRORS + 1))
  fi
done
echo ""

# --- Cross-reference with settings.json ---
echo "Settings cross-reference:"
if [ ! -f "$SETTINGS" ]; then
  echo "  SKIP: .claude/settings.json not found"
else
  if ! command -v jq >/dev/null 2>&1; then
    echo "  SKIP: jq not available"
  else
    # Extract all hook commands from settings.json
    HOOK_CMDS=$(jq -r '.hooks | .. | .command? // empty' "$SETTINGS" 2>/dev/null || true)
    if [ -z "$HOOK_CMDS" ]; then
      echo "  INFO: no hook commands found in settings.json"
    else
      while IFS= read -r cmd; do
        [ -n "$cmd" ] || continue
        # Extract script path — resolve CLAUDE_PROJECT_DIR without splitting on spaces
        if echo "$cmd" | grep -qF 'CLAUDE_PROJECT_DIR'; then
          rel_path=$(echo "$cmd" | sed 's/.*CLAUDE_PROJECT_DIR[}"/ ]*//; s/\.sh.*/\.sh/')
          script_path="$WORKSPACE/$rel_path"
        else
          # Try quoted path first (handles spaces), then fall back to unquoted
          script_path=$(echo "$cmd" | sed -n 's|.*"\([^"]*\.sh\)".*|\1|p')
          if [ -z "$script_path" ]; then
            script_path=$(echo "$cmd" | grep -oE '[^ ]*\.sh' | head -1 || true)
          fi
        fi
        [ -n "$script_path" ] || continue
        script_name=$(basename "$script_path")
        if [ -f "$script_path" ]; then
          echo "  OK: $script_name — referenced and exists"
        else
          echo "  FAIL: $script_name — referenced in settings.json but file missing"
          ERRORS=$((ERRORS + 1))
        fi
      done <<< "$HOOK_CMDS"
    fi

    # Check for hook scripts NOT referenced in settings.json
    for script in "$HOOKS_DIR"/*.sh; do
      [ -f "$script" ] || continue
      name=$(basename "$script")
      if ! echo "$HOOK_CMDS" | grep -qF "$name"; then
        echo "  WARN: $name — exists but not referenced in settings.json"
        WARNINGS=$((WARNINGS + 1))
      fi
    done
  fi
fi
echo ""

# --- Summary ---
echo "Summary: $ERRORS error(s), $WARNINGS warning(s)"
if [ "$ERRORS" -gt 0 ]; then
  exit 1
fi
