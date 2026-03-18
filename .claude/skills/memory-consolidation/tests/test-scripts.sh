#!/bin/bash
# Tests for memory-consolidation helper scripts.
# Usage: bash test-scripts.sh
# Runs in a temporary directory — no side effects on real data.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
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

assert_exit_code() {
  local desc="$1" expected_exit="$2"
  shift 2
  set +e
  "$@" >/dev/null 2>&1
  local actual_exit=$?
  set -e
  if [ "$expected_exit" -eq "$actual_exit" ]; then
    PASS=$((PASS + 1))
    TESTS+=("PASS: $desc")
  else
    FAIL=$((FAIL + 1))
    TESTS+=("FAIL: $desc (expected exit=$expected_exit, got=$actual_exit)")
  fi
}

# --- Setup test environment ---
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

echo "=== lock.sh ==="

# Test: acquire lock
result=$(bash "$SCRIPT_DIR/lock.sh" acquire "$TEST_DIR/test.lock" 60)
assert_eq "lock acquire succeeds" "ACQUIRED" "$result"

# Test: pid file created
assert_eq "lock creates pid file" "true" "$([ -f "$TEST_DIR/test.lock/pid" ] && echo true || echo false)"

# Test: timestamp file created
assert_eq "lock creates timestamp file" "true" "$([ -f "$TEST_DIR/test.lock/timestamp" ] && echo true || echo false)"

# Test: lock blocks second acquire
assert_exit_code "lock blocks second acquire" 1 bash "$SCRIPT_DIR/lock.sh" acquire "$TEST_DIR/test.lock" 60

# Test: second acquire outputs LOCKED
set +e
result=$(bash "$SCRIPT_DIR/lock.sh" acquire "$TEST_DIR/test.lock" 60 2>/dev/null)
set -e
assert_eq "blocked acquire says LOCKED" "LOCKED" "$result"

# Test: release lock
result=$(bash "$SCRIPT_DIR/lock.sh" release "$TEST_DIR/test.lock")
assert_eq "lock release succeeds" "RELEASED" "$result"

# Test: lock directory removed after release
assert_eq "lock dir removed after release" "false" "$([ -d "$TEST_DIR/test.lock" ] && echo true || echo false)"

# Test: release non-existent lock
result=$(bash "$SCRIPT_DIR/lock.sh" release "$TEST_DIR/nonexistent.lock")
assert_eq "release non-existent lock" "NO_LOCK" "$result"

# Test: check-maintenance when no lock
result=$(bash "$SCRIPT_DIR/lock.sh" check-maintenance "$TEST_DIR")
assert_eq "check-maintenance clear" "CLEAR" "$result"

# Test: check-maintenance when locked
mkdir -p "$TEST_DIR/.maintenance.lock"
assert_exit_code "check-maintenance detects lock" 1 bash "$SCRIPT_DIR/lock.sh" check-maintenance "$TEST_DIR"
set +e
result=$(bash "$SCRIPT_DIR/lock.sh" check-maintenance "$TEST_DIR" 2>/dev/null)
set -e
assert_eq "check-maintenance says MAINTENANCE" "MAINTENANCE" "$result"
rmdir "$TEST_DIR/.maintenance.lock"

# Test: stale lock recovery (dead PID)
mkdir -p "$TEST_DIR/stale.lock"
echo "99999" > "$TEST_DIR/stale.lock/pid"
# Touch pid file to be old (use TTL=0 so any lock with dead PID is stale)
result=$(bash "$SCRIPT_DIR/lock.sh" acquire "$TEST_DIR/stale.lock" 0 2>/dev/null)
assert_eq "stale lock reclaimed (dead pid, ttl=0)" "ACQUIRED" "$result"
bash "$SCRIPT_DIR/lock.sh" release "$TEST_DIR/stale.lock" >/dev/null

# Test: alive PID prevents reclaim even if TTL exceeded
mkdir -p "$TEST_DIR/alive.lock"
echo "$$" > "$TEST_DIR/alive.lock/pid"
# Current process PID is alive, so lock should NOT be reclaimed even with TTL=0
assert_exit_code "alive PID prevents reclaim" 1 bash "$SCRIPT_DIR/lock.sh" acquire "$TEST_DIR/alive.lock" 0
rm -rf "$TEST_DIR/alive.lock"

# Test: orphaned lock (no pid file) recovery
mkdir -p "$TEST_DIR/orphan.lock"
result=$(bash "$SCRIPT_DIR/lock.sh" acquire "$TEST_DIR/orphan.lock" 60 2>/dev/null)
assert_eq "orphaned lock reclaimed" "ACQUIRED" "$result"
bash "$SCRIPT_DIR/lock.sh" release "$TEST_DIR/orphan.lock" >/dev/null

# Test: unknown action
assert_exit_code "unknown action exits 2" 2 bash "$SCRIPT_DIR/lock.sh" badaction "$TEST_DIR/x"

echo "=== safe-edit.sh ==="

# Setup: create a test file with known content
printf 'line one\nline two\nline three\n' > "$TEST_DIR/test-file.md"

# Test: backup
result=$(bash "$SCRIPT_DIR/safe-edit.sh" backup "$TEST_DIR/test-file.md")
assert_eq "backup succeeds" "BACKED_UP" "$result"

# Test: backup file exists
assert_eq "backup file created" "true" "$([ -f "$TEST_DIR/test-file.md.consolidation-backup" ] && echo true || echo false)"

# Test: backup content matches original
assert_eq "backup content matches" \
  "$(cat "$TEST_DIR/test-file.md")" \
  "$(cat "$TEST_DIR/test-file.md.consolidation-backup")"

# Test: verify healthy file
result=$(bash "$SCRIPT_DIR/safe-edit.sh" verify "$TEST_DIR/test-file.md")
assert_eq "verify healthy file" "VERIFIED" "$result"

# Test: verify non-existent file
assert_exit_code "verify missing file fails" 1 bash "$SCRIPT_DIR/safe-edit.sh" verify "$TEST_DIR/nonexistent.md"

# Test: verify empty file
printf '' > "$TEST_DIR/empty-file.md"
assert_exit_code "verify empty file fails" 1 bash "$SCRIPT_DIR/safe-edit.sh" verify "$TEST_DIR/empty-file.md"

# Test: verify suspicious shrink
printf 'x' > "$TEST_DIR/test-file.md"  # Shrink from ~30 bytes to 1 byte
set +e
result=$(bash "$SCRIPT_DIR/safe-edit.sh" verify "$TEST_DIR/test-file.md" 2>/dev/null)
exit_code=$?
set -e
assert_eq "verify detects suspicious shrink" "SUSPICIOUS_SHRINK" "$result"
assert_eq "suspicious shrink exits 1" "1" "$exit_code"

# Test: rollback restores content
result=$(bash "$SCRIPT_DIR/safe-edit.sh" rollback "$TEST_DIR/test-file.md")
assert_eq "rollback succeeds" "ROLLED_BACK" "$result"
content=$(cat "$TEST_DIR/test-file.md")
expected=$(printf 'line one\nline two\nline three\n')
assert_eq "rollback restores content" "$expected" "$content"

# Test: backup file removed after rollback
assert_eq "backup removed after rollback" "false" "$([ -f "$TEST_DIR/test-file.md.consolidation-backup" ] && echo true || echo false)"

# Test: rollback with no backup
assert_exit_code "rollback without backup fails" 1 bash "$SCRIPT_DIR/safe-edit.sh" rollback "$TEST_DIR/test-file.md"

# Test: clean
printf 'original\n' > "$TEST_DIR/clean-test.md"
bash "$SCRIPT_DIR/safe-edit.sh" backup "$TEST_DIR/clean-test.md" >/dev/null
result=$(bash "$SCRIPT_DIR/safe-edit.sh" clean "$TEST_DIR/clean-test.md")
assert_eq "clean succeeds" "CLEANED" "$result"
assert_eq "backup removed after clean" "false" "$([ -f "$TEST_DIR/clean-test.md.consolidation-backup" ] && echo true || echo false)"

# Test: backup non-existent file
assert_exit_code "backup non-existent file fails" 1 bash "$SCRIPT_DIR/safe-edit.sh" backup "$TEST_DIR/nope.md"

# Test: unknown action
assert_exit_code "unknown action exits 2" 2 bash "$SCRIPT_DIR/safe-edit.sh" badaction "$TEST_DIR/x"

echo "=== discover-sessions.sh ==="

# Setup: create mock workspace and session directory
MOCK_WORKSPACE="$TEST_DIR/mock-workspace"
mkdir -p "$MOCK_WORKSPACE"

# Use CLAUDE_SESSIONS_BASE to avoid touching real session files
MOCK_SESSIONS_BASE="$TEST_DIR/mock-sessions"
mkdir -p "$MOCK_SESSIONS_BASE"

# Derive the expected session directory name
WORKSPACE_ABS="$(cd "$MOCK_WORKSPACE" && pwd)"
SESSION_DIR_NAME=$(printf '%s' "$WORKSPACE_ABS" | sed 's|[/.]|-|g')
MOCK_SESSION_DIR="$MOCK_SESSIONS_BASE/$SESSION_DIR_NAME"
mkdir -p "$MOCK_SESSION_DIR"

# Create a human session file
printf '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-03-19T10:00:00Z","content":"[Chat: Test | From: User]\\nhello"}\n' > "$MOCK_SESSION_DIR/human-session.jsonl"
printf '{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-03-19T10:00:01Z"}\n' >> "$MOCK_SESSION_DIR/human-session.jsonl"

# Create a cron session file
printf '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-03-19T09:00:00Z","content":"IMPORTANT: Run health check"}\n' > "$MOCK_SESSION_DIR/cron-session.jsonl"

# Create another automated session (different prefix)
printf '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-03-19T08:00:00Z","content":"External code review for PR #42"}\n' > "$MOCK_SESSION_DIR/review-session.jsonl"

# Touch all files to be recent (within 48h)
touch "$MOCK_SESSION_DIR/human-session.jsonl" "$MOCK_SESSION_DIR/cron-session.jsonl" "$MOCK_SESSION_DIR/review-session.jsonl"

# Test: discovers human session
result=$(CLAUDE_SESSIONS_BASE="$MOCK_SESSIONS_BASE" bash "$SCRIPT_DIR/discover-sessions.sh" "$MOCK_WORKSPACE" 2>/dev/null)

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    PASS=$((PASS + 1))
    TESTS+=("PASS: $desc")
  else
    FAIL=$((FAIL + 1))
    TESTS+=("FAIL: $desc (output did not contain '$needle')")
  fi
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    FAIL=$((FAIL + 1))
    TESTS+=("FAIL: $desc (output contained '$needle')")
  else
    PASS=$((PASS + 1))
    TESTS+=("PASS: $desc")
  fi
}

assert_contains "discovers human session" "$result" "human-session.jsonl"
assert_not_contains "filters out cron session" "$result" "cron-session.jsonl"
assert_not_contains "filters out review session" "$result" "review-session.jsonl"

# Test: non-existent workspace returns empty, no error
result=$(CLAUDE_SESSIONS_BASE="$MOCK_SESSIONS_BASE" bash "$SCRIPT_DIR/discover-sessions.sh" "$TEST_DIR/nonexistent-workspace" 2>/dev/null || true)
assert_eq "non-existent workspace returns empty" "" "$result"

# Test: workspace with no session directory returns empty
mkdir -p "$TEST_DIR/no-sessions-workspace"
result=$(CLAUDE_SESSIONS_BASE="$MOCK_SESSIONS_BASE" bash "$SCRIPT_DIR/discover-sessions.sh" "$TEST_DIR/no-sessions-workspace" 2>/dev/null || true)
assert_eq "no session dir returns empty" "" "$result"

# Test: only returns one session (the human one)
line_count=$(CLAUDE_SESSIONS_BASE="$MOCK_SESSIONS_BASE" bash "$SCRIPT_DIR/discover-sessions.sh" "$MOCK_WORKSPACE" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "returns exactly 1 session" "1" "$line_count"

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
