#!/bin/bash
# test-scripts.sh — Tests for workspace-health scripts
# Usage: bash test-scripts.sh [workspace-path]
# Runs each script against the workspace and verifies expected behavior.
set -euo pipefail

WORKSPACE="${1:-.}"
WORKSPACE="$(cd "$WORKSPACE" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"

PASS=0
FAIL=0
TESTS=0

# Helper: run a test case
run_test() {
  local name="$1"
  local expected_exit="$2"
  shift 2
  local cmd=("$@")

  TESTS=$((TESTS + 1))
  local output
  local actual_exit=0
  output=$("${cmd[@]}" 2>&1) || actual_exit=$?

  if [ "$actual_exit" -eq "$expected_exit" ]; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name (expected exit $expected_exit, got $actual_exit)"
    echo "    Output: $(echo "$output" | head -5)"
    FAIL=$((FAIL + 1))
  fi
}

# Helper: check output contains a string
assert_contains() {
  local name="$1"
  local pattern="$2"
  shift 2
  local cmd=("$@")

  TESTS=$((TESTS + 1))
  local output
  output=$("${cmd[@]}" 2>&1) || true

  if echo "$output" | grep -q "$pattern"; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name (output missing: '$pattern')"
    echo "    Output: $(echo "$output" | head -5)"
    FAIL=$((FAIL + 1))
  fi
}

# Helper: check output does NOT contain a string
assert_not_contains() {
  local name="$1"
  local pattern="$2"
  shift 2
  local cmd=("$@")

  TESTS=$((TESTS + 1))
  local output
  output=$("${cmd[@]}" 2>&1) || true

  if echo "$output" | grep -q "$pattern"; then
    echo "  FAIL: $name (output should not contain: '$pattern')"
    echo "    Output: $(echo "$output" | head -5)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  fi
}

echo "=== Workspace Health Script Tests ==="
echo "Workspace: $WORKSPACE"
echo "Scripts: $SCRIPT_DIR"
echo ""

# ============================================================
# Test: size-audit.sh
# ============================================================
echo "--- size-audit.sh ---"
run_test "exits 0 on valid workspace" 0 bash "$SCRIPT_DIR/size-audit.sh" "$WORKSPACE"
assert_contains "reports total size" "Total size:" bash "$SCRIPT_DIR/size-audit.sh" "$WORKSPACE"
assert_contains "reports largest files" "Largest files" bash "$SCRIPT_DIR/size-audit.sh" "$WORKSPACE"
assert_contains "includes bloat check" "Bloat check:" bash "$SCRIPT_DIR/size-audit.sh" "$WORKSPACE"

# Test with explicit workspace path argument
assert_contains "accepts workspace path argument" "Size Audit:" bash "$SCRIPT_DIR/size-audit.sh" "$WORKSPACE"
echo ""

# ============================================================
# Test: config-check.sh
# ============================================================
echo "--- config-check.sh ---"
run_test "exits 0 on valid workspace" 0 bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE"
assert_contains "checks required files" "Required files:" bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE"
assert_contains "checks MEMORY.md at root" "MEMORY.md" bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE"
assert_contains "checks settings" "Settings:" bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE"
assert_contains "checks hooks config" "Hooks configuration:" bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE"
assert_contains "checks root markdown" "Root markdown files:" bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE"
assert_contains "reports summary" "Summary:" bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE"

# MEMORY.md should be found at workspace root (not memory/auto/)
assert_not_contains "no memory/auto path" "memory/auto" bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE"

# MEMORY.md should not be flagged as stray
TESTS=$((TESTS + 1))
CONFIG_OUTPUT=$(bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE" 2>&1 || true)
if echo "$CONFIG_OUTPUT" | grep -i "stray\|unexpected" | grep -q "MEMORY.md"; then
  echo "  FAIL: MEMORY.md is flagged as stray in config-check output"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: MEMORY.md not flagged as stray"
  PASS=$((PASS + 1))
fi

# settings.local.json missing should not be a FAIL
assert_not_contains "missing settings.local.json is not a FAIL" "FAIL.*settings.local.json" bash "$SCRIPT_DIR/config-check.sh" "$WORKSPACE"

# --- Settings separation tests ---
# Test with synthetic workspace: user prefs in settings.json should FAIL
TESTS=$((TESTS + 1))
_TMP_CFG=$(mktemp -d)
git -C "$_TMP_CFG" init -q >/dev/null 2>&1
mkdir -p "$_TMP_CFG/.claude"
echo '{"outputStyle":"X","autoMemoryEnabled":true}' > "$_TMP_CFG/.claude/settings.json"
touch "$_TMP_CFG/CLAUDE.md" "$_TMP_CFG/USER.md" "$_TMP_CFG/IDENTITY.md" "$_TMP_CFG/.gitignore" "$_TMP_CFG/MEMORY.md"
_CFG_OUT=$(bash "$SCRIPT_DIR/config-check.sh" "$_TMP_CFG" 2>&1 || true)
if echo "$_CFG_OUT" | grep -q "FAIL.*outputStyle.*settings.local" && echo "$_CFG_OUT" | grep -q "FAIL.*autoMemoryEnabled.*settings.local"; then
  echo "  PASS: detects user prefs in settings.json"
  PASS=$((PASS + 1))
else
  echo "  FAIL: did not detect user prefs in settings.json"
  echo "    Output: $(echo "$_CFG_OUT" | grep -i 'fail\|warn' | head -5)"
  FAIL=$((FAIL + 1))
fi
rm -rf "$_TMP_CFG"

# Test: autoMemoryDirectory not ending in /memory/auto should FAIL
TESTS=$((TESTS + 1))
_TMP_CFG2=$(mktemp -d)
git -C "$_TMP_CFG2" init -q >/dev/null 2>&1
mkdir -p "$_TMP_CFG2/.claude"
echo '{}' > "$_TMP_CFG2/.claude/settings.json"
echo '{"autoMemoryEnabled":true,"autoMemoryDirectory":"/bad/path/memory"}' > "$_TMP_CFG2/.claude/settings.local.json"
touch "$_TMP_CFG2/CLAUDE.md" "$_TMP_CFG2/USER.md" "$_TMP_CFG2/IDENTITY.md" "$_TMP_CFG2/.gitignore" "$_TMP_CFG2/MEMORY.md"
_CFG_OUT2=$(bash "$SCRIPT_DIR/config-check.sh" "$_TMP_CFG2" 2>&1 || true)
if echo "$_CFG_OUT2" | grep -q "FAIL.*autoMemoryDirectory.*memory/auto"; then
  echo "  PASS: detects wrong autoMemoryDirectory path"
  PASS=$((PASS + 1))
else
  echo "  FAIL: did not detect wrong autoMemoryDirectory path"
  echo "    Output: $(echo "$_CFG_OUT2" | grep -i 'fail\|warn' | head -5)"
  FAIL=$((FAIL + 1))
fi
rm -rf "$_TMP_CFG2"

# Test: missing required keys in settings.local.json should WARN
TESTS=$((TESTS + 1))
_TMP_CFG3=$(mktemp -d)
git -C "$_TMP_CFG3" init -q >/dev/null 2>&1
mkdir -p "$_TMP_CFG3/.claude"
echo '{}' > "$_TMP_CFG3/.claude/settings.json"
echo '{}' > "$_TMP_CFG3/.claude/settings.local.json"
touch "$_TMP_CFG3/CLAUDE.md" "$_TMP_CFG3/USER.md" "$_TMP_CFG3/IDENTITY.md" "$_TMP_CFG3/.gitignore" "$_TMP_CFG3/MEMORY.md"
_CFG_OUT3=$(bash "$SCRIPT_DIR/config-check.sh" "$_TMP_CFG3" 2>&1 || true)
if echo "$_CFG_OUT3" | grep -q "WARN.*outputStyle" && echo "$_CFG_OUT3" | grep -q "WARN.*autoMemoryEnabled" && echo "$_CFG_OUT3" | grep -q "WARN.*autoMemoryDirectory"; then
  echo "  PASS: warns about missing required keys in settings.local.json"
  PASS=$((PASS + 1))
else
  echo "  FAIL: did not warn about missing required keys"
  echo "    Output: $(echo "$_CFG_OUT3" | grep -i 'fail\|warn' | head -5)"
  FAIL=$((FAIL + 1))
fi
rm -rf "$_TMP_CFG3"

# No ADR references
TESTS=$((TESTS + 1))
if grep -q 'ADR-[0-9]' "$SCRIPT_DIR/config-check.sh"; then
  echo "  FAIL: config-check.sh contains ADR number references"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: no ADR number references in config-check.sh"
  PASS=$((PASS + 1))
fi
echo ""

# ============================================================
# Test: hook-integrity.sh
# ============================================================
echo "--- hook-integrity.sh ---"
run_test "exits 0 on valid workspace" 0 bash "$SCRIPT_DIR/hook-integrity.sh" "$WORKSPACE"
assert_contains "checks hook scripts" "Hook scripts:" bash "$SCRIPT_DIR/hook-integrity.sh" "$WORKSPACE"
assert_contains "cross-references settings" "Settings cross-reference:" bash "$SCRIPT_DIR/hook-integrity.sh" "$WORKSPACE"
assert_contains "reports summary" "Summary:" bash "$SCRIPT_DIR/hook-integrity.sh" "$WORKSPACE"
echo ""

# ============================================================
# Test: orphan-scan.sh
# ============================================================
echo "--- orphan-scan.sh ---"
run_test "exits 0 on valid workspace" 0 bash "$SCRIPT_DIR/orphan-scan.sh" "$WORKSPACE"
assert_contains "reports scan" "Orphan Scan:" bash "$SCRIPT_DIR/orphan-scan.sh" "$WORKSPACE"

# Allowlist must be at workspace root, not in skill scripts dir
TESTS=$((TESTS + 1))
ALLOWLIST="$WORKSPACE/orphan-allowlist.txt"
if [ -f "$ALLOWLIST" ]; then
  echo "  PASS: orphan-allowlist.txt exists at workspace root"
  PASS=$((PASS + 1))
else
  echo "  FAIL: orphan-allowlist.txt not found at workspace root ($ALLOWLIST)"
  FAIL=$((FAIL + 1))
fi

# Allowlist should not exist in skill scripts dir (moved to workspace root)
TESTS=$((TESTS + 1))
if [ -f "$SCRIPT_DIR/orphan-allowlist.txt" ]; then
  echo "  FAIL: orphan-allowlist.txt still exists in skill scripts dir (should be at workspace root)"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: orphan-allowlist.txt not in skill scripts dir (correctly at workspace root)"
  PASS=$((PASS + 1))
fi

# Allowlist should not contain workspace-specific entries
TESTS=$((TESTS + 1))
if grep -qE '^(config\.yaml|crons\.yaml|monitoring|\.minime|\.playwright-mcp|\.maintenance\.lock)$' "$ALLOWLIST" 2>/dev/null; then
  echo "  FAIL: orphan-allowlist.txt contains workspace-specific entries"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: orphan-allowlist.txt contains only platform-generic entries"
  PASS=$((PASS + 1))
fi

# orphan-scan.sh reads from workspace root, not skill dir
TESTS=$((TESTS + 1))
if grep -q 'ALLOWLIST="$WORKSPACE/' "$SCRIPT_DIR/orphan-scan.sh"; then
  echo "  PASS: orphan-scan.sh reads allowlist from workspace root"
  PASS=$((PASS + 1))
else
  echo "  FAIL: orphan-scan.sh does not read allowlist from workspace root"
  FAIL=$((FAIL + 1))
fi

# Local allowlist mechanism exists (workspace root)
TESTS=$((TESTS + 1))
if grep -q "orphan-allowlist.local.txt" "$SCRIPT_DIR/orphan-scan.sh"; then
  echo "  PASS: orphan-scan.sh supports local allowlist"
  PASS=$((PASS + 1))
else
  echo "  FAIL: orphan-scan.sh does not reference local allowlist"
  FAIL=$((FAIL + 1))
fi

# Test: both allowlist files are concatenated (local extends platform)
TESTS=$((TESTS + 1))
_TMP_WS=$(mktemp -d)
git -C "$_TMP_WS" init -q
printf 'allowed-platform\n' > "$_TMP_WS/orphan-allowlist.txt"
printf 'allowed-local\n' > "$_TMP_WS/orphan-allowlist.local.txt"
mkdir -p "$_TMP_WS/allowed-platform" "$_TMP_WS/allowed-local" "$_TMP_WS/orphan-dir"
_SCAN_OUT=$(bash "$SCRIPT_DIR/orphan-scan.sh" "$_TMP_WS" 2>&1) || true
rm -rf "$_TMP_WS"
if echo "$_SCAN_OUT" | grep -q "orphan-dir" && ! echo "$_SCAN_OUT" | grep -q "allowed-platform" && ! echo "$_SCAN_OUT" | grep -q "allowed-local"; then
  echo "  PASS: both allowlist files concatenated (local extends platform)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: allowlist concatenation broken (expected orphan-dir flagged, allowed-* not flagged)"
  echo "    Output: $(echo "$_SCAN_OUT" | head -5)"
  FAIL=$((FAIL + 1))
fi
echo ""

# ============================================================
# Test: cleanup.sh
# ============================================================
echo "--- cleanup.sh ---"
run_test "exits 0 with --workspace flag" 0 bash "$SCRIPT_DIR/cleanup.sh" --workspace "$WORKSPACE"
assert_contains "dry run by default" "DRY RUN" bash "$SCRIPT_DIR/cleanup.sh" --workspace "$WORKSPACE"
assert_contains "reports workspace" "Cleanup" bash "$SCRIPT_DIR/cleanup.sh" --workspace "$WORKSPACE"

# Should require --workspace flag
run_test "exits 1 without --workspace flag" 1 bash "$SCRIPT_DIR/cleanup.sh"

# Should not contain hardcoded workspace paths
TESTS=$((TESTS + 1))
HARDCODED_PATH_PATTERN='/''Users/'
if grep -q "$HARDCODED_PATH_PATTERN" "$SCRIPT_DIR/cleanup.sh"; then
  echo "  FAIL: cleanup.sh contains hardcoded user paths"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: no hardcoded user paths in cleanup.sh"
  PASS=$((PASS + 1))
fi
echo ""

# ============================================================
# Test: platform-check.sh
# ============================================================
echo "--- platform-check.sh ---"
run_test "exits 0 on workspace" 0 bash "$SCRIPT_DIR/platform-check.sh" "$WORKSPACE"
assert_contains "reports platform check" "Platform Check:" bash "$SCRIPT_DIR/platform-check.sh" "$WORKSPACE"

# Checks platform files (hooks, rules, settings)
TESTS=$((TESTS + 1))
CHECKS_HOOKS=0
CHECKS_RULES=0
CHECKS_SETTINGS=0
grep -q 'hooks/' "$SCRIPT_DIR/platform-check.sh" && CHECKS_HOOKS=1
grep -q 'rules/platform/' "$SCRIPT_DIR/platform-check.sh" && CHECKS_RULES=1
grep -q 'settings.json' "$SCRIPT_DIR/platform-check.sh" && CHECKS_SETTINGS=1
if [ "$CHECKS_HOOKS" -eq 1 ] && [ "$CHECKS_RULES" -eq 1 ] && [ "$CHECKS_SETTINGS" -eq 1 ]; then
  echo "  PASS: platform-check.sh checks hooks, rules, and settings"
  PASS=$((PASS + 1))
else
  echo "  FAIL: platform-check.sh missing checks for hooks/rules/settings"
  FAIL=$((FAIL + 1))
fi

# Handles non-git workspaces gracefully
TESTS=$((TESTS + 1))
TMPDIR_NONGIT=$(mktemp -d)
NONGIT_EXIT=0
NONGIT_OUTPUT=$(bash "$SCRIPT_DIR/platform-check.sh" "$TMPDIR_NONGIT" 2>&1) || NONGIT_EXIT=$?
[ -n "$TMPDIR_NONGIT" ] && { command -v trash >/dev/null 2>&1 && trash "$TMPDIR_NONGIT" || rm -rf "$TMPDIR_NONGIT"; }
if [ "$NONGIT_EXIT" -eq 0 ] && echo "$NONGIT_OUTPUT" | grep -qi "skip"; then
  echo "  PASS: platform-check.sh handles non-git workspace gracefully"
  PASS=$((PASS + 1))
else
  echo "  FAIL: platform-check.sh does not handle non-git workspace (exit=$NONGIT_EXIT)"
  FAIL=$((FAIL + 1))
fi

# Script is executable
TESTS=$((TESTS + 1))
if [ -x "$SCRIPT_DIR/platform-check.sh" ] || head -1 "$SCRIPT_DIR/platform-check.sh" | grep -q 'bash'; then
  echo "  PASS: platform-check.sh is a valid bash script"
  PASS=$((PASS + 1))
else
  echo "  FAIL: platform-check.sh is not executable or not a bash script"
  FAIL=$((FAIL + 1))
fi
echo ""

# ============================================================
# Test: SKILL.md
# ============================================================
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$SKILL_DIR/SKILL.md"
echo "--- SKILL.md ---"

# SKILL.md exists
TESTS=$((TESTS + 1))
if [ -f "$SKILL_MD" ]; then
  echo "  PASS: SKILL.md exists"
  PASS=$((PASS + 1))
else
  echo "  FAIL: SKILL.md does not exist"
  FAIL=$((FAIL + 1))
fi

# No hardcoded absolute paths
TESTS=$((TESTS + 1))
HARDCODED_PATH_PATTERN='/''Users/'
if grep -q "$HARDCODED_PATH_PATTERN" "$SKILL_MD" 2>/dev/null; then
  echo "  FAIL: SKILL.md contains hardcoded absolute paths"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: SKILL.md has no hardcoded absolute paths"
  PASS=$((PASS + 1))
fi

# Uses CLAUDE_SKILL_DIR for script paths
TESTS=$((TESTS + 1))
if grep -q 'CLAUDE_SKILL_DIR' "$SKILL_MD" 2>/dev/null; then
  echo "  PASS: SKILL.md uses CLAUDE_SKILL_DIR for portable paths"
  PASS=$((PASS + 1))
else
  echo "  FAIL: SKILL.md does not use CLAUDE_SKILL_DIR"
  FAIL=$((FAIL + 1))
fi

# No ADR number references
TESTS=$((TESTS + 1))
if grep -q 'ADR-[0-9]' "$SKILL_MD" 2>/dev/null; then
  echo "  FAIL: SKILL.md contains ADR number references"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: SKILL.md has no ADR number references"
  PASS=$((PASS + 1))
fi

# Does not contain Part H (ADR Compliance Review)
TESTS=$((TESTS + 1))
if grep -qi 'ADR [Cc]ompliance [Rr]eview' "$SKILL_MD" 2>/dev/null; then
  echo "  FAIL: SKILL.md contains ADR Compliance Review stage"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: SKILL.md does not contain ADR Compliance Review"
  PASS=$((PASS + 1))
fi

# Includes platform consistency check stage
TESTS=$((TESTS + 1))
if grep -qi 'platform' "$SKILL_MD" 2>/dev/null && grep -q 'platform-check.sh' "$SKILL_MD" 2>/dev/null; then
  echo "  PASS: SKILL.md includes platform consistency check stage"
  PASS=$((PASS + 1))
else
  echo "  FAIL: SKILL.md missing platform consistency check stage"
  FAIL=$((FAIL + 1))
fi

# Report format includes "Platform check" line
TESTS=$((TESTS + 1))
if grep -q 'Platform check' "$SKILL_MD" 2>/dev/null; then
  echo "  PASS: SKILL.md report format includes Platform check line"
  PASS=$((PASS + 1))
else
  echo "  FAIL: SKILL.md report format missing Platform check line"
  FAIL=$((FAIL + 1))
fi

# Report format does not include "ADR compliance" line
TESTS=$((TESTS + 1))
if grep -qi 'ADR compliance' "$SKILL_MD" 2>/dev/null; then
  echo "  FAIL: SKILL.md report format contains ADR compliance line"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: SKILL.md report format has no ADR compliance line"
  PASS=$((PASS + 1))
fi

# AI stages reference graceful skip for missing files
TESTS=$((TESTS + 1))
if grep -qi 'skip.*missing\|missing.*skip\|skip any that are missing' "$SKILL_MD" 2>/dev/null; then
  echo "  PASS: SKILL.md AI stages skip gracefully when files missing"
  PASS=$((PASS + 1))
else
  echo "  FAIL: SKILL.md AI stages do not mention skipping for missing files"
  FAIL=$((FAIL + 1))
fi

# Part E references only public-repo files (no private workspace paths)
TESTS=$((TESTS + 1))
if grep -q '\.minime\|workspace-coder\|/username/' "$SKILL_MD" 2>/dev/null; then
  echo "  FAIL: SKILL.md Part E references private workspace paths"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: SKILL.md Part E has no private workspace references"
  PASS=$((PASS + 1))
fi

# Git sync mentions non-git workspace handling
TESTS=$((TESTS + 1))
if grep -qi 'not a git\|non-git\|not.*git.*repo' "$SKILL_MD" 2>/dev/null; then
  echo "  PASS: SKILL.md git sync handles non-git workspaces"
  PASS=$((PASS + 1))
else
  echo "  FAIL: SKILL.md git sync does not handle non-git workspaces"
  FAIL=$((FAIL + 1))
fi

# Documents all stages and output format
TESTS=$((TESTS + 1))
HAS_REPORT=0
grep -q 'Summary Report\|summary.*report\|Report' "$SKILL_MD" 2>/dev/null && HAS_REPORT=1
if [ "$HAS_REPORT" -eq 1 ]; then
  echo "  PASS: SKILL.md documents expected output format"
  PASS=$((PASS + 1))
else
  echo "  FAIL: SKILL.md does not document expected output format"
  FAIL=$((FAIL + 1))
fi
echo ""

# ============================================================
# Test: ADR governance
# ============================================================
echo "--- ADR governance ---"

# ADR template exists
TESTS=$((TESTS + 1))
ADR_TEMPLATE="$WORKSPACE/reference/governance/decisions.md.example"
if [ -f "$ADR_TEMPLATE" ]; then
  echo "  PASS: decisions.md.example exists"
  PASS=$((PASS + 1))
else
  echo "  FAIL: decisions.md.example does not exist at $ADR_TEMPLATE"
  FAIL=$((FAIL + 1))
fi

# ADR template has required fields
for field in "Status:" "Date:" "Context:" "Decision:" "Consequences:"; do
  TESTS=$((TESTS + 1))
  if grep -q "$field" "$ADR_TEMPLATE" 2>/dev/null; then
    echo "  PASS: ADR template contains $field"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ADR template missing $field"
    FAIL=$((FAIL + 1))
  fi
done

# ADR template is tracked in git (not ignored)
TESTS=$((TESTS + 1))
if git -C "$WORKSPACE" add --dry-run reference/governance/decisions.md.example >/dev/null 2>&1; then
  echo "  PASS: decisions.md.example is trackable by git"
  PASS=$((PASS + 1))
else
  echo "  FAIL: decisions.md.example is gitignored"
  FAIL=$((FAIL + 1))
fi

# User decisions.md would be gitignored (covered by reference/* pattern)
TESTS=$((TESTS + 1))
# check-ignore exits 0 if file IS ignored, 1 if not
if git -C "$WORKSPACE" check-ignore -q reference/governance/decisions.md 2>/dev/null; then
  echo "  PASS: reference/governance/decisions.md is gitignored (user content protected)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: reference/governance/decisions.md is NOT gitignored"
  FAIL=$((FAIL + 1))
fi

# ADR governance rule exists as platform rule
TESTS=$((TESTS + 1))
ADR_RULE="$WORKSPACE/.claude/rules/platform/adr-governance.md"
if [ -f "$ADR_RULE" ]; then
  echo "  PASS: adr-governance.md platform rule exists"
  PASS=$((PASS + 1))
else
  echo "  FAIL: adr-governance.md platform rule does not exist"
  FAIL=$((FAIL + 1))
fi

# ADR rule mentions checking decision log before changes
TESTS=$((TESTS + 1))
if grep -qi 'check.*decisions\|prior decisions\|decision.*log' "$ADR_RULE" 2>/dev/null; then
  echo "  PASS: ADR rule enforces checking decision log"
  PASS=$((PASS + 1))
else
  echo "  FAIL: ADR rule does not enforce checking decision log"
  FAIL=$((FAIL + 1))
fi

# ADR rule mentions recording new decisions
TESTS=$((TESTS + 1))
if grep -qi 'record.*adr\|recording\|propose.*adding\|suggest.*adding' "$ADR_RULE" 2>/dev/null; then
  echo "  PASS: ADR rule enforces recording new decisions"
  PASS=$((PASS + 1))
else
  echo "  FAIL: ADR rule does not mention recording new decisions"
  FAIL=$((FAIL + 1))
fi

# ADR rule requires user confirmation
TESTS=$((TESTS + 1))
if grep -qi 'user confirmation\|without.*confirm\|never.*create.*without' "$ADR_RULE" 2>/dev/null; then
  echo "  PASS: ADR rule requires user confirmation"
  PASS=$((PASS + 1))
else
  echo "  FAIL: ADR rule does not require user confirmation"
  FAIL=$((FAIL + 1))
fi

# README documents ADR initialization
TESTS=$((TESTS + 1))
README="$WORKSPACE/README.md"
if grep -q 'decisions.md' "$README" 2>/dev/null; then
  echo "  PASS: README documents ADR initialization"
  PASS=$((PASS + 1))
else
  echo "  FAIL: README does not document ADR initialization"
  FAIL=$((FAIL + 1))
fi

echo ""

# ============================================================
# Test: skill scripts are executable (git preserves executable bits)
# ============================================================
echo "--- skill scripts executable ---"

# Skill scripts should be executable (git preserves 100755 bits — no setup.sh needed)
TESTS=$((TESTS + 1))
ALL_EXECUTABLE=1
for s in "$SCRIPT_DIR"/*.sh; do
  if [ ! -x "$s" ]; then
    ALL_EXECUTABLE=0
    break
  fi
done
if [ "$ALL_EXECUTABLE" -eq 1 ]; then
  echo "  PASS: skill scripts are executable (git-preserved bits)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: some skill scripts are not executable"
  FAIL=$((FAIL + 1))
fi
echo ""

# ============================================================
# Test: crons.yaml
# ============================================================
echo "--- crons.yaml ---"
CRONS_EXAMPLE="$WORKSPACE/crons.yaml"

# Has workspace-health entry
TESTS=$((TESTS + 1))
if grep -q 'workspace-health' "$CRONS_EXAMPLE" 2>/dev/null; then
  echo "  PASS: crons.yaml has workspace-health entry"
  PASS=$((PASS + 1))
else
  echo "  FAIL: crons.yaml missing workspace-health entry"
  FAIL=$((FAIL + 1))
fi

# References the skill
TESTS=$((TESTS + 1))
if grep -q '/workspace-health' "$CRONS_EXAMPLE" 2>/dev/null; then
  echo "  PASS: crons.yaml references workspace-health skill"
  PASS=$((PASS + 1))
else
  echo "  FAIL: crons.yaml does not reference workspace-health skill"
  FAIL=$((FAIL + 1))
fi

# Has adequate timeout (>= 600000 for AI stages)
TESTS=$((TESTS + 1))
TIMEOUT_VALUE=$(grep -A10 'workspace-health' "$CRONS_EXAMPLE" 2>/dev/null | grep 'timeout:' | head -1 | sed 's/.*timeout:[[:space:]]*//' | grep -oE '^[0-9]+')
if [ -n "$TIMEOUT_VALUE" ] && [ "$TIMEOUT_VALUE" -ge 600000 ] 2>/dev/null; then
  echo "  PASS: workspace-health cron has adequate timeout (${TIMEOUT_VALUE}ms)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: workspace-health cron timeout too low or missing (${TIMEOUT_VALUE:-none})"
  FAIL=$((FAIL + 1))
fi
echo ""

# ============================================================
# Test: .gitignore coverage
# ============================================================
echo "--- .gitignore coverage ---"
GITIGNORE="$WORKSPACE/.gitignore"

# orphan-allowlist.local.txt is gitignored
TESTS=$((TESTS + 1))
if grep -q 'orphan-allowlist.local.txt' "$GITIGNORE" 2>/dev/null; then
  echo "  PASS: .gitignore includes orphan-allowlist.local.txt"
  PASS=$((PASS + 1))
else
  echo "  FAIL: .gitignore missing orphan-allowlist.local.txt"
  FAIL=$((FAIL + 1))
fi

# reference/governance/decisions.md.example is trackable (not ignored)
TESTS=$((TESTS + 1))
if git -C "$WORKSPACE" check-ignore -q reference/governance/decisions.md.example 2>/dev/null; then
  echo "  FAIL: decisions.md.example is gitignored (should be tracked)"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: decisions.md.example is not gitignored (tracked in git)"
  PASS=$((PASS + 1))
fi
echo ""

# ============================================================
# Test: No hardcoded paths in any script
# ============================================================
echo "--- Global checks ---"
TESTS=$((TESTS + 1))
HARDCODED_PATH_PATTERN='/''Users/'
if grep -r "$HARDCODED_PATH_PATTERN" "$SCRIPT_DIR"/*.sh 2>/dev/null; then
  echo "  FAIL: hardcoded user paths found in scripts"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: no hardcoded user paths in any script"
  PASS=$((PASS + 1))
fi

# No ADR references in any script or SKILL.md
TESTS=$((TESTS + 1))
SKILL_PARENT="$(cd "$(dirname "$0")/.." && pwd)"
if grep -rn 'ADR-[0-9]' "$SCRIPT_DIR"/ "$SKILL_PARENT/SKILL.md" 2>/dev/null; then
  echo "  FAIL: ADR number references found in skill files"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: no ADR number references in any skill file"
  PASS=$((PASS + 1))
fi

# All scripts accept workspace path argument
for script in "$SCRIPT_DIR"/*.sh; do
  name=$(basename "$script")
  TESTS=$((TESTS + 1))
  if head -10 "$script" | grep -qi 'workspace\|path'; then
    echo "  PASS: $name documents workspace path usage"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name does not document workspace path usage"
    FAIL=$((FAIL + 1))
  fi
done
echo ""

# ============================================================
# Summary
# ============================================================
echo "=== Results: $PASS passed, $FAIL failed, $TESTS total ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
