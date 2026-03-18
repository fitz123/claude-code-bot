#!/bin/bash
# Tests for platform integration: setup.sh, crons.yaml.example, .gitignore, memory-protocol.
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

echo "=== setup.sh creates memory subdirectories ==="

# Test: setup.sh in a temp directory creates memory/auto and memory/diary
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Set up minimal structure that setup.sh expects
mkdir -p "$TEST_DIR/.claude/hooks"
touch "$TEST_DIR/.claude/hooks/dummy.sh"
mkdir -p "$TEST_DIR/.claude/optional-rules"
touch "$TEST_DIR/.claude/optional-rules/test.md"
mkdir -p "$TEST_DIR/.claude/skills/memory-consolidation/scripts"
touch "$TEST_DIR/.claude/skills/memory-consolidation/scripts/test-skill.sh"

# Copy setup.sh to temp dir and run it
cp "$REPO_DIR/setup.sh" "$TEST_DIR/setup.sh"

# Run setup.sh non-interactively
(cd "$TEST_DIR" && bash setup.sh < /dev/null 2>&1) > /dev/null

assert_eq "setup.sh creates memory/auto/" "true" "$([ -d "$TEST_DIR/memory/auto" ] && echo true || echo false)"
assert_eq "setup.sh creates memory/diary/" "true" "$([ -d "$TEST_DIR/memory/diary" ] && echo true || echo false)"
assert_eq "setup.sh creates memory/.gitkeep" "true" "$([ -f "$TEST_DIR/memory/.gitkeep" ] && echo true || echo false)"

# Test: skill scripts are made executable
assert_eq "skill script is executable" "true" "$([ -x "$TEST_DIR/.claude/skills/memory-consolidation/scripts/test-skill.sh" ] && echo true || echo false)"

echo "=== crons.yaml.example ==="

CRONS_FILE="$REPO_DIR/bot/crons.yaml.example"

# Test: crons.yaml.example exists
assert_eq "crons.yaml.example exists" "true" "$([ -f "$CRONS_FILE" ] && echo true || echo false)"

# Test: contains memory-consolidation entry
crons_content=$(cat "$CRONS_FILE")
assert_contains "crons.yaml has memory-consolidation entry" "$crons_content" "memory-consolidation"
assert_contains "crons.yaml has nightly schedule" "$crons_content" '"0 2 \* \* \*"'
assert_contains "crons.yaml has adequate timeout" "$crons_content" "600000"

# Test: crons.yaml.example is valid YAML (requires yq or python, fallback to basic check)
if command -v python3 >/dev/null 2>&1; then
  python3 -c "
import sys, json
try:
    # Use PyYAML if available
    import yaml
    data = yaml.safe_load(open('$CRONS_FILE'))
    assert 'crons' in data, 'missing crons key'
    names = [c['name'] for c in data['crons']]
    assert 'memory-consolidation' in names, 'memory-consolidation not in crons'
    print('VALID')
except ImportError:
    print('SKIP_YAML')
except Exception as e:
    print(f'INVALID: {e}')
  " > "$TEST_DIR/yaml-check.txt" 2>&1
  yaml_result=$(cat "$TEST_DIR/yaml-check.txt")
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

echo "=== setup.sh has no hardcoded user paths ==="

setup_content=$(cat "$REPO_DIR/setup.sh")
if echo "$setup_content" | grep -q '/Users/'; then
  FAIL=$((FAIL + 1))
  TESTS+=("FAIL: setup.sh contains hardcoded /Users/ paths")
else
  PASS=$((PASS + 1))
  TESTS+=("PASS: setup.sh has no hardcoded /Users/ paths")
fi

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
