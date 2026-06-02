#!/bin/bash
# write-guard.test.sh — bash harness for the CLAUDE-path write guard.
#
# Exercises the two-hook chain in the SAME order .claude/settings.json runs it:
#   protect-files.sh (immutable-core deny-overlay) THEN guardian.sh (schema
#   allow-check). A target is ALLOWED only if BOTH hooks exit 0; if EITHER exits
#   non-zero it is BLOCKED — exactly the precedence the real session sees
#   (deny-overlay > allow > default-deny).
#
# Self-contained: builds a throwaway workspace with a schema.md fixture, drives
# each hook in a CLEAN env (env -i) so no ambient WRITE_GUARD_BYPASS /
# PROTECT_FILES_BYPASS / CRON_NAME leaks in, and asserts allow/deny. The temp
# workspace has no git origin and is not under /.ralphex/worktrees/, so neither
# hook's bypass fires — the real allow-check is what runs.
#
# Run:   bash .claude/hooks/__tests__/write-guard.test.sh
# Exits non-zero if any assertion fails.

set -u

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTECT="$HOOK_DIR/protect-files.sh"
GUARDIAN="$HOOK_DIR/guardian.sh"

PASS=0
FAIL=0

WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT

# --- workspace fixture -----------------------------------------------------
mkdir -p "$WS/memory" "$WS/docs" "$WS/.claude/rules/custom" "$WS/.claude/skills/custom" "$WS/legacy"

cat > "$WS/schema.md" <<'SCHEMA'
# Workspace schema

```write-allowlist
memory/                  # narrative + auto memory
docs/
.claude/rules/custom/
.claude/skills/
*.md                     # root-level markdown only
schema.md
```
SCHEMA

# An existing, non-immutable, non-schema file — to test the overwrite exemption.
echo "old" > "$WS/legacy/old.txt"

# --- chain runner ----------------------------------------------------------
# Echoes ALLOW or BLOCK for "$1"=tool, "$2"=path RELATIVE to the workspace.
# Extra args after $2 are passed as VAR=value into the hook env (e.g. a bypass).
run_chain() {
  local tool="$1" rel="$2"
  shift 2
  local fp="$WS/$rel"
  local input
  input="$(printf '{"tool_name":"%s","tool_input":{"file_path":"%s"}}' "$tool" "$fp")"

  if ! printf '%s' "$input" | env -i PATH="$PATH" CLAUDE_PROJECT_DIR="$WS" "$@" bash "$PROTECT" >/dev/null 2>&1; then
    echo BLOCK
    return
  fi
  if ! printf '%s' "$input" | env -i PATH="$PATH" CLAUDE_PROJECT_DIR="$WS" "$@" bash "$GUARDIAN" >/dev/null 2>&1; then
    echo BLOCK
    return
  fi
  echo ALLOW
}

assert() {
  local expected="$1" actual="$2" desc="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
    echo "ok   - $desc"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL - $desc (expected $expected, got $actual)"
  fi
}

# --- assertions ------------------------------------------------------------

# Deny-by-default: a path not in schema.md is blocked.
assert BLOCK "$(run_chain Write unregistered/x.txt)" "non-schema path blocked"

# Directory-prefix allow.
assert ALLOW "$(run_chain Write memory/notes.md)" "schema dir-prefix path allowed (memory/)"
assert ALLOW "$(run_chain Write memory/sub/deep.md)" "schema dir-prefix nested allowed"
assert ALLOW "$(run_chain Write memory)" "bare dir name matches its prefix line"

# Immutable core wins over the allow-list (README.md immutable though *.md allowed).
assert BLOCK "$(run_chain Write README.md)" "immutable README.md blocked despite *.md"

# Case-variant of an immutable FILE must still be blocked (APFS: README.MD == README.md).
# Without case-folding in protect-files.sh this slips past the deny-overlay and the
# *.md allow-line in schema.md re-allows the immutable file.
assert BLOCK "$(run_chain Write README.MD)" "case-variant immutable README.MD blocked despite *.md"

# Immutable file entries are ROOT-ONLY-EXACT — docs/README.md is NOT immutable.
assert ALLOW "$(run_chain Write docs/README.md)" "docs/README.md allowed (docs/ in schema; immutable file is root-only)"

# .claude/ split: custom allowed, hooks immutable.
assert ALLOW "$(run_chain Write .claude/rules/custom/x.md)" ".claude/rules/custom/ allowed"
assert BLOCK "$(run_chain Write .claude/rules/platform/x.md)" ".claude/rules/platform/ immutable blocked"
assert BLOCK "$(run_chain Write .claude/hooks/x.sh)" ".claude/hooks/ immutable blocked"
assert ALLOW "$(run_chain Write .claude/skills/custom/index.ts)" ".claude/skills/custom/ allowed"
assert BLOCK "$(run_chain Write .claude/skills/workspace-health/scripts/x.ts)" ".claude/skills/workspace-health/scripts/ immutable blocked"

# Root-only glob: *.md matches a root-level file but NOT a nested one.
assert ALLOW "$(run_chain Write top.md)" "root-level *.md allowed"
assert BLOCK "$(run_chain Write sub/top.md)" "nested *.md NOT matched by root-only glob (sub/ unregistered)"

# Exact-path line.
assert ALLOW "$(run_chain Write schema.md)" "exact root-file schema.md allowed"

# Case-insensitive (APFS) directory-prefix match.
assert ALLOW "$(run_chain Write Memory/Notes.MD)" "case-insensitive dir-prefix match (APFS)"

# APFS case-variant WORKSPACE-PREFIX coverage. On case-insensitive APFS an absolute
# tool path whose workspace-root prefix case-varies (e.g. /users vs /Users) names the
# SAME file as $CLAUDE_PROJECT_DIR. The containment check that derives REL_PATH must
# fold case — otherwise the path is treated as outside-workspace and BOTH the
# immutable deny-overlay (protect-files.sh) and the schema deny-by-default check
# (guardian.sh) are bypassed. These drive the chain with a case-varied prefix while
# CLAUDE_PROJECT_DIR stays $WS, so they exercise pure string logic (no reliance on
# the underlying volume actually being case-insensitive).
WS_CASE="$(printf '%s' "$WS" | tr '[:lower:]' '[:upper:]')"
if [[ "$WS_CASE" == "$WS" ]]; then
  WS_CASE="$(printf '%s' "$WS" | tr '[:upper:]' '[:lower:]')"
fi
run_chain_prefix() {
  # $1=tool, $2=absolute file_path (workspace prefix may be case-varied).
  local tool="$1" fp="$2" input
  input="$(printf '{"tool_name":"%s","tool_input":{"file_path":"%s"}}' "$tool" "$fp")"
  if ! printf '%s' "$input" | env -i PATH="$PATH" CLAUDE_PROJECT_DIR="$WS" bash "$PROTECT" >/dev/null 2>&1; then
    echo BLOCK; return
  fi
  if ! printf '%s' "$input" | env -i PATH="$PATH" CLAUDE_PROJECT_DIR="$WS" bash "$GUARDIAN" >/dev/null 2>&1; then
    echo BLOCK; return
  fi
  echo ALLOW
}
if [[ "$WS_CASE" != "$WS" ]]; then
  assert BLOCK "$(run_chain_prefix Write "$WS_CASE/README.md")" "case-variant workspace prefix on immutable README.md blocked (APFS)"
  assert BLOCK "$(run_chain_prefix Write "$WS_CASE/unregistered/x.txt")" "case-variant workspace prefix on non-schema path blocked (APFS deny-by-default)"
  assert ALLOW "$(run_chain_prefix Write "$WS_CASE/memory/notes.md")" "case-variant workspace prefix on schema path still allowed (APFS)"
else
  echo "FAIL - could not produce a case-varied workspace prefix from \$WS"
  FAIL=$((FAIL + 1))
fi

# Existing-file overwrite exemption (legacy/old.txt is not in schema, not immutable).
assert ALLOW "$(run_chain Write legacy/old.txt)" "existing-file overwrite allowed (exemption)"

# Traversal escape is blocked even though it resolves outside the allow-check.
assert BLOCK "$(run_chain Write ../escape.txt)" "path traversal blocked"

# WRITE_GUARD_BYPASS=1 unblocks a guardian-denied (but non-immutable) path.
assert ALLOW "$(run_chain Write unregistered/y.txt WRITE_GUARD_BYPASS=1)" "WRITE_GUARD_BYPASS=1 unblocks non-immutable path"

# Bypass does NOT override the immutable-core deny (protect-files.sh runs first).
assert BLOCK "$(run_chain Write README.md WRITE_GUARD_BYPASS=1)" "WRITE_GUARD_BYPASS does NOT override immutable core"

# Fail-closed: schema.md is PRESENT but its write-allowlist block is empty (only a
# comment / blank lines). The block must yield zero allow-lines → deny everything
# non-immutable (distinct from the missing-schema.md case, which is also fail-closed).
WS2="$(mktemp -d)"
cat > "$WS2/schema.md" <<'SCHEMA'
# schema with an empty write-allowlist block
```write-allowlist
# only a comment — no real entries

```
SCHEMA
empty_block_verdict() {
  local input
  input="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$WS2/newfile.txt")"
  if printf '%s' "$input" | env -i PATH="$PATH" CLAUDE_PROJECT_DIR="$WS2" bash "$GUARDIAN" >/dev/null 2>&1; then
    echo ALLOW
  else
    echo BLOCK
  fi
}
assert BLOCK "$(empty_block_verdict)" "schema.md present but write-allowlist block empty → fail-closed"
rm -rf "$WS2"

echo "---"
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
