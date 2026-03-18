#!/bin/bash
# config-check.sh — Workspace configuration validation
# Usage: bash config-check.sh [workspace-path]
# Accepts a workspace path argument; defaults to current directory.
# Validates CLAUDE.md, MEMORY.md, settings, hooks config, and root markdown files.
set -euo pipefail

WORKSPACE="${1:-.}"
if [ ! -d "$WORKSPACE" ]; then
  echo "ERROR: workspace not found: $WORKSPACE"
  exit 1
fi
WORKSPACE="$(cd "$WORKSPACE" && pwd)"

echo "=== Config Check: $WORKSPACE ==="
echo ""

ERRORS=0
WARNINGS=0

# --- Required workspace files ---
echo "Required files:"

REQUIRED_FILES=("CLAUDE.md" "USER.md" "IDENTITY.md" ".gitignore" "setup.sh")
for f in "${REQUIRED_FILES[@]}"; do
  if [ -f "$WORKSPACE/$f" ]; then
    echo "  OK: $f"
  else
    echo "  FAIL: $f missing"
    ERRORS=$((ERRORS + 1))
  fi
done
echo ""

# --- MEMORY.md validation ---
echo "Memory index:"
MEMORY_MD="$WORKSPACE/MEMORY.md"
if [ -f "$MEMORY_MD" ]; then
  LINE_COUNT=$(wc -l < "$MEMORY_MD" | tr -d ' ')
  if [ "$LINE_COUNT" -gt 200 ]; then
    echo "  WARN: MEMORY.md has $LINE_COUNT lines (>200 — will be truncated)"
    WARNINGS=$((WARNINGS + 1))
  else
    echo "  OK: MEMORY.md has $LINE_COUNT lines"
  fi
else
  echo "  WARN: MEMORY.md not found — memory index not initialized"
  WARNINGS=$((WARNINGS + 1))
fi
echo ""

# --- Settings validation ---
echo "Settings:"
SETTINGS="$WORKSPACE/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  if command -v jq >/dev/null 2>&1; then
    if jq empty "$SETTINGS" 2>/dev/null; then
      echo "  OK: settings.json is valid JSON"
    else
      echo "  FAIL: settings.json is not valid JSON"
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "  SKIP: jq not available — cannot validate JSON"
  fi
else
  echo "  FAIL: .claude/settings.json missing"
  ERRORS=$((ERRORS + 1))
fi

# settings.local.json — optional, warn if missing but don't fail
SETTINGS_LOCAL="$WORKSPACE/.claude/settings.local.json"
SETTINGS_LOCAL_EXAMPLE="$WORKSPACE/.claude/settings.local.json.example"
if [ -f "$SETTINGS_LOCAL" ]; then
  if command -v jq >/dev/null 2>&1; then
    if jq empty "$SETTINGS_LOCAL" 2>/dev/null; then
      echo "  OK: settings.local.json is valid JSON"
    else
      echo "  FAIL: settings.local.json is not valid JSON"
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "  SKIP: jq not available — cannot validate settings.local.json"
  fi
elif [ -f "$SETTINGS_LOCAL_EXAMPLE" ]; then
  echo "  INFO: settings.local.json not created yet (example available)"
else
  echo "  INFO: no settings.local.json or example found"
fi
echo ""

# --- Hooks configuration ---
echo "Hooks configuration:"
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  # Extract hook commands from settings.json
  HOOK_CMDS=$(jq -r '.hooks | .. | .command? // empty' "$SETTINGS" 2>/dev/null || true)
  if [ -n "$HOOK_CMDS" ]; then
    while IFS= read -r cmd; do
      [ -n "$cmd" ] || continue
      # Resolve $CLAUDE_PROJECT_DIR (with or without surrounding quotes) to workspace path
      resolved="$cmd"
      resolved="${resolved//\"\$CLAUDE_PROJECT_DIR\"/$WORKSPACE}"
      resolved="${resolved//\$CLAUDE_PROJECT_DIR/$WORKSPACE}"
      # Extract the .sh path from the resolved command
      script_path=$(echo "$resolved" | grep -oE '[^ ]*\.sh' | head -1 || true)
      [ -n "$script_path" ] || continue

      script_name=$(basename "$script_path")
      if [ -f "$script_path" ]; then
        if [ -x "$script_path" ]; then
          echo "  OK: $script_name — exists and executable"
        else
          echo "  WARN: $script_name — exists but not executable"
          WARNINGS=$((WARNINGS + 1))
        fi
      else
        echo "  FAIL: $script_name — referenced in settings.json but not found"
        ERRORS=$((ERRORS + 1))
      fi
    done <<< "$HOOK_CMDS"
  else
    echo "  INFO: no hook scripts referenced in settings.json"
  fi
else
  echo "  SKIP: cannot validate hooks (settings.json missing or jq unavailable)"
fi
echo ""

# --- Root markdown check ---
echo "Root markdown files:"
ALLOWED_ROOT_MD=("CLAUDE.md" "USER.md" "IDENTITY.md" "MEMORY.md" "README.md" "CHANGELOG.md")
STRAY_MD=()
for f in "$WORKSPACE"/*.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  FOUND=false
  for allowed in "${ALLOWED_ROOT_MD[@]}"; do
    if [ "$name" = "$allowed" ]; then
      FOUND=true
      break
    fi
  done
  if [ "$FOUND" = false ]; then
    STRAY_MD+=("$name")
  fi
done

if [ ${#STRAY_MD[@]} -eq 0 ]; then
  echo "  OK: no stray markdown files at root"
else
  echo "  WARN: unexpected root markdown files:"
  for s in "${STRAY_MD[@]}"; do
    echo "    - $s"
  done
  WARNINGS=$((WARNINGS + ${#STRAY_MD[@]}))
fi
echo ""

# --- Platform rules directory ---
echo "Platform rules:"
PLATFORM_RULES="$WORKSPACE/.claude/rules/platform"
if [ -d "$PLATFORM_RULES" ]; then
  RULE_COUNT=$(find "$PLATFORM_RULES" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  echo "  OK: $RULE_COUNT platform rule(s) found"
else
  echo "  WARN: .claude/rules/platform/ directory missing"
  WARNINGS=$((WARNINGS + 1))
fi

CUSTOM_RULES="$WORKSPACE/.claude/rules/custom"
if [ -d "$CUSTOM_RULES" ]; then
  CUSTOM_COUNT=$(find "$CUSTOM_RULES" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  echo "  INFO: $CUSTOM_COUNT custom rule(s) active"
else
  echo "  INFO: .claude/rules/custom/ directory not found"
fi
echo ""

# --- Summary ---
echo "Summary: $ERRORS error(s), $WARNINGS warning(s)"
if [ "$ERRORS" -gt 0 ]; then
  exit 1
fi
