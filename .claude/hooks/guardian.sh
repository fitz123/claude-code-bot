#!/bin/bash
# guardian.sh — PreToolUse hook (schema-enforced write guard — ALLOW-CHECK half)
#
# Deny-by-default, path-granular write guard for the CLAUDE path. A NEW file may
# be created only if its workspace-relative path matches an entry in schema.md's
# fenced ```write-allowlist``` block; otherwise it is BLOCKED with an actionable
# message. This is the ALLOW half of the two-hook claude-path guard:
#
#   protect-files.sh  (runs FIRST, per .claude/settings.json)  = immutable-core
#       deny-overlay — the 10 upstream-owned paths ALWAYS block.
#   guardian.sh       (this hook, runs SECOND)                 = schema allow-check
#       — everything not in schema.md's allow-list is denied.
#
# Precedence (deny-overlay > allow > default-deny) comes from hook ORDER:
# protect-files.sh blocks an immutable path before this hook can allow it.
#
# Match semantics (D17 — identical to the Pi-path classifier `isAllowedPath` in
# bot/src/pi-extensions/guard.ts; against the workspace-relative POSIX path,
# case-insensitively for APFS). Three allow-line kinds:
#   - Directory prefix (trailing slash, e.g. `memory/`): matches the bare dir
#     name itself OR anything under it (`memory` and `memory/x.md`).
#   - Root-only glob  (a bare glob with `*`/`?`, e.g. `*.md`): matches a
#     ROOT-LEVEL file only — the relative path has no `/` AND the glob matches.
#   - Exact path      (no slash, no glob, e.g. `MEMORY.md`): matches that exact
#     relative path only (never a prefix match).
#
# Bash-redirect gap (D16 — tracked v1 known-gap): this hook inspects ONLY
# `tool_input.file_path` (the Write/Edit target). A bash redirect such as
# `echo x > unregistered/y` is NOT seen here, so bash writes are UNGUARDED on
# the claude path. The Pi path DOES cover them (guard.ts `extractBashWriteTargets`);
# closing this gap in the bash hook is deliberately deferred (see the design plan
# docs/plans/2026-06-02-pi-claude-write-guard-enforcers.md).
#
# Symlink limitation: paths are matched LEXICALLY (only `..`/`//`/`/./` are
# collapsed — no realpath). A symlink at an allow-listed path that points into a
# protected/unregistered dir is matched on its own name, not its target. This is
# OUT of the threat model on purpose — the guard is anti-drift / footgun-prevention
# for a trusted operator, NOT a defense against a malicious agent deliberately
# planting symlinks. The Pi classifier (guard.ts) shares this lexical-match design.
#
# Rules:
# - Edit tool: always allowed (edits existing content)
# - Write tool: allowed if file exists (overwrite) or path matches schema.md
# - Only checks files within the workspace

# Fail-closed: if jq is missing, block rather than bypass
if ! command -v jq &>/dev/null; then
    echo "BLOCKED by write-guard: jq not found — cannot parse hook input" >&2
    exit 2
fi

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Fail-closed: if tool_name is empty, input parsing failed — block rather than bypass.
# The hook matcher guarantees tool_name is always present for valid invocations.
if [[ -z "$TOOL_NAME" ]]; then
    echo "BLOCKED by write-guard: could not parse tool_name from input" >&2
    exit 2
fi

# Edit tool always targets existing content — never block
if [[ "$TOOL_NAME" == "Edit" ]]; then
  exit 0
fi

# Write requires file_path — fail-closed if missing (defense-in-depth)
if [[ -z "$FILE_PATH" ]]; then
  echo "BLOCKED by write-guard: Write tool called without file_path" >&2
  exit 2
fi

# Determine workspace root (no hardcoded fallback — must have CLAUDE_PROJECT_DIR)
WORKSPACE="${CLAUDE_PROJECT_DIR%/}"
if [[ -z "$WORKSPACE" ]]; then
  echo "BLOCKED by write-guard: CLAUDE_PROJECT_DIR not set" >&2
  exit 2
fi

# Only check files within this workspace. An absolute path elsewhere (e.g.
# /tmp/log) is out of scope — matching the Pi classifier's outside-workspace allow.
if [[ "$FILE_PATH" != "$WORKSPACE/"* ]]; then
  exit 0
fi

# Extract path relative to workspace root
REL_PATH="${FILE_PATH#"$WORKSPACE/"}"

# PRESERVE: block path traversal BEFORE the existing-file check (defense-in-depth:
# -e resolves ".." so an attacker could escape the workspace via existing targets).
# Only match ".." as a path component, not inside filenames like "file..bak".
if [[ "$REL_PATH" == ../* ]] || [[ "$REL_PATH" == */../* ]] || [[ "$REL_PATH" == */.. ]] || [[ "$REL_PATH" == ".." ]]; then
  echo "BLOCKED by write-guard: path contains '..' traversal: ${REL_PATH}" >&2
  exit 2
fi

# PRESERVE: normalize path — collapse // and /./ segments
while [[ "$REL_PATH" == *//* ]]; do
  REL_PATH="${REL_PATH//\/\//\/}"
done
while [[ "$REL_PATH" == *"/./"* ]]; do
  REL_PATH="${REL_PATH//\/.\//\/}"
done
REL_PATH="${REL_PATH#./}"

# PRESERVE: if file already exists, it's an overwrite — always allowed
if [[ -e "$FILE_PATH" ]]; then
  exit 0
fi

# --- Bypass (mirrors protect-files.sh; all triggers logged to stderr) ------
# Without an escape, a workspace with NO schema.md — e.g. the upstream dev repo
# itself, or a ralphex worktree — would fail CLOSED on every new file, bricking
# the very workflows that maintain these hooks. protect-files.sh already carries
# the same three triggers; guardian.sh runs AFTER it and so needs them too.
#   1. WRITE_GUARD_BYPASS=1                            — explicit one-off opt-out
#   2. CLAUDE_PROJECT_DIR under /.ralphex/worktrees/   — ralphex pipeline
#   3. git origin == upstream dev repo (fitz123/claude-code-bot)
bypass=""
if [[ "${WRITE_GUARD_BYPASS:-0}" == "1" ]]; then
  bypass="env WRITE_GUARD_BYPASS=1"
elif [[ "$WORKSPACE" == */.ralphex/worktrees/* ]]; then
  bypass="ralphex worktree ($WORKSPACE)"
else
  origin_url="$(git -C "$WORKSPACE" remote get-url origin 2>/dev/null || true)"
  case "$origin_url" in
    *fitz123/claude-code-bot.git | *fitz123/claude-code-bot | *fitz123/claude-code-bot/)
      bypass="upstream dev repo (origin=$origin_url)"
      ;;
  esac
fi
if [[ -n "$bypass" ]]; then
  echo "write-guard: bypass active — $bypass" >&2
  exit 0
fi

# --- Schema-enforced allow-check (deny-by-default) -------------------------
# Suggest the schema.md line that would unblock this path (the first dir
# component as a directory-prefix when nested, else the exact path) for the
# actionable block message below.
if [[ "$REL_PATH" == */* ]]; then
  SUGGEST="${REL_PATH%%/*}/"
else
  SUGGEST="$REL_PATH"
fi

block_denied() {
  cat >&2 <<ERRMSG
BLOCKED by write-guard (deny-by-default): cannot create '${REL_PATH}'.

It is not in the workspace write allow-list (the write-allowlist fenced block in schema.md).
To allow it: add a line to schema.md (e.g. "${SUGGEST}"), notify the workspace owner, then retry.
To bypass for one operation: set WRITE_GUARD_BYPASS=1.
ERRMSG
  exit 2
}

block_failclosed() {
  cat >&2 <<ERRMSG
BLOCKED by write-guard (deny-by-default, fail-closed): cannot create '${REL_PATH}'.

The workspace write allow-list is missing or empty: schema.md is absent, or its
write-allowlist fenced block is empty/unparseable. Security never relaxes — add
the block to schema.md and register this path (e.g. "${SUGGEST}"), notify the
workspace owner, then retry. To bypass for one operation: set WRITE_GUARD_BYPASS=1.
ERRMSG
  exit 2
}

SCHEMA="$WORKSPACE/schema.md"
if [[ ! -f "$SCHEMA" ]]; then
  block_failclosed
fi

# Extract the FIRST ```write-allowlist fenced block — the lines strictly between
# an opening fence that is EXACTLY ```write-allowlist and the next line starting
# with ``` — then strip #-comments / blank lines / surrounding whitespace. The
# `exit` at the first closing fence stops after one block, identical to the Pi
# wrapper's readWriteAllowlist parse (which `break`s on the first closing fence),
# so both enforcers read the SAME allow-list even if schema.md (against its
# contract) carries a second block (no drift).
ALLOW_RAW="$(awk '/^```write-allowlist$/{f=1;next} f&&/^```/{exit} f' "$SCHEMA")"

allow_lines=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue
  allow_lines+=("$line")
done <<< "$ALLOW_RAW"

# Fail-safe: an empty/unparseable block denies everything non-immutable (closed).
if [[ ${#allow_lines[@]} -eq 0 ]]; then
  block_failclosed
fi

# Match REL_PATH against the three D17 line kinds, case-insensitively (APFS).
shopt -s nocasematch
for line in "${allow_lines[@]}"; do
  if [[ "$line" == */ ]]; then
    # Directory prefix: the bare dir name OR anything under it.
    prefix="${line%/}"
    if [[ "$REL_PATH" == "$prefix" || "$REL_PATH" == "$prefix"/* ]]; then
      exit 0
    fi
  elif [[ "$line" == *"*"* || "$line" == *"?"* ]]; then
    # Root-only glob: a ROOT-LEVEL file only (the relative path has no '/').
    if [[ "$REL_PATH" != */* ]]; then
      # shellcheck disable=SC2254
      case "$REL_PATH" in $line) exit 0 ;; esac
    fi
  else
    # Exact path: that exact relative path only (never a prefix match).
    if [[ "$REL_PATH" == "$line" ]]; then
      exit 0
    fi
  fi
done
shopt -u nocasematch

# No allow-line matched — deny by default.
block_denied
