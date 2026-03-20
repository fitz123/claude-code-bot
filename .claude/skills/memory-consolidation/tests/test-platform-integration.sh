#!/bin/bash
# Tests for platform integration: memory directories, crons.yaml.example, .gitignore, memory-protocol.
# Usage: bash test-platform-integration.sh
# Runs assertions against repo files — no side effects.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
PASS=0
FAIL=0
TESTS=()

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    TESTS+=("PASS: $desc")
  else
    FAIL=$((FAIL + 1))
    TESTS+=("FAIL: $desc (expected='$expected', got='$actual')")
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    PASS=$((PASS + 1))
    TESTS+=("PASS: $desc")
  else
    FAIL=$((FAIL + 1))
    TESTS+=("FAIL: $desc (expected to contain '$needle')")
  fi
}

echo "=== memory directory structure ==="

# Test: memory subdirectory .gitkeep files exist in the repo (no setup.sh needed)
assert_eq "memory/auto/.gitkeep exists in repo" "true" "$([ -f "$REPO_DIR/memory/auto/.gitkeep" ] && echo true || echo false)"
assert_eq "memory/diary/.gitkeep exists in repo" "true" "$([ -f "$REPO_DIR/memory/diary/.gitkeep" ] && echo true || echo false)"
assert_eq "memory/.gitkeep exists in repo" "true" "$([ -f "$REPO_DIR/memory/.gitkeep" ] && echo true || echo false)"

echo "=== crons.yaml.example ==="

CRONS_FILE="$REPO_DIR/crons.yaml.example"

# Test: crons.yaml.example exists
assert_eq "crons.yaml.example exists" "true" "$([ -f "$CRONS_FILE" ] && echo true || echo false)"

# Test: contains memory-consolidation entry
crons_content=$(cat "$CRONS_FILE")
assert_contains "crons.yaml has memory-consolidation entry" "$crons_content" "memory-consolidation"
assert_contains "crons.yaml has nightly schedule" "$crons_content" '"0 2 \* \* \*"'
assert_contains "crons.yaml has adequate timeout" "$crons_content" "600000"

# Test: crons.yaml.example is valid YAML (requires yq or python, fallback to basic check)
if command -v python3 >/dev/null 2>&1; then
  yaml_result=$(python3 -c "
import sys, json
try:
    import yaml
    data = yaml.safe_load(open(sys.argv[1]))
    assert 'crons' in data, 'missing crons key'
    names = [c['name'] for c in data['crons']]
    assert 'memory-consolidation' in names, 'memory-consolidation not in crons'
    print('VALID')
except ImportError:
    print('SKIP_YAML')
except Exception as e:
    print(f'INVALID: {e}')
  " "$CRONS_FILE" 2>&1)
  if [ "$yaml_result" = "VALID" ]; then
    assert_eq "crons.yaml.example is valid YAML with memory-consolidation" "VALID" "$yaml_result"
  elif [ "$yaml_result" = "SKIP_YAML" ]; then
    PASS=$((PASS + 1))
    TESTS+=("SKIP: YAML validation (PyYAML not installed)")
  else
    assert_eq "crons.yaml.example is valid YAML" "VALID" "$yaml_result"
  fi
fi

echo "=== .gitignore ==="

gitignore_content=$(cat "$REPO_DIR/.gitignore")
assert_contains ".gitignore covers consolidation lock" "$gitignore_content" ".consolidation.lock"
assert_contains ".gitignore covers consolidation state" "$gitignore_content" ".consolidation-state.json"

echo "=== memory-protocol.md ==="

protocol_content=$(cat "$REPO_DIR/.claude/optional-rules/memory-protocol.md")
assert_contains "memory-protocol references memory/diary/" "$protocol_content" "memory/diary/"

# Ensure old path is gone
if echo "$protocol_content" | grep -q "memory/daily/"; then
  FAIL=$((FAIL + 1))
  TESTS+=("FAIL: memory-protocol still references memory/daily/")
else
  PASS=$((PASS + 1))
  TESTS+=("PASS: memory-protocol no longer references memory/daily/")
fi

echo "=== plist template ==="

# Test: bot launchd plist template exists
assert_eq "bot/telegram-bot.plist.example exists" "true" "$([ -f "$REPO_DIR/bot/telegram-bot.plist.example" ] && echo true || echo false)"

# Test: README has Installation section
readme_content=$(cat "$REPO_DIR/README.md")
assert_contains "README has Installation section" "$readme_content" "## Installation"
assert_contains "README documents Keychain setup" "$readme_content" "security add-generic-password"
assert_contains "README documents claude auth login" "$readme_content" "claude auth login"

# --- Summary ---
echo ""
echo "=== Results ==="
for t in "${TESTS[@]}"; do
  echo "  $t"
done
echo ""
echo "Total: $((PASS + FAIL)) | Passed: $PASS | Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
