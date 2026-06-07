#!/bin/bash
# protect-files.sh — PreToolUse hook
# Blocks writes to:
#   1) Skill files — cron/autonomous sessions only (interactive can still edit)
#   2) Upstream-owned platform files — ALL sessions (bot-code-readonly enforcement)

# Fail-closed: if jq is missing, block rather than bypass
if ! command -v jq &>/dev/null; then
    echo "BLOCKED by protect-files: jq not found — cannot parse hook input" >&2
    exit 2
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty') || true

# Fail-closed: if jq failed to parse, FILE_PATH may be empty due to malformed input
# Distinguish "no file_path field" from "parse error" by re-checking jq exit code
if ! echo "$INPUT" | jq -e '.tool_input' &>/dev/null; then
  echo "BLOCKED by protect-files: failed to parse hook input JSON" >&2
  exit 2
fi

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Normalize path: prevent bypass via non-canonical paths.
# Use sed rather than Bash replacement syntax so the replacement stays literal
# and cannot accidentally introduce backslashes while collapsing `//` or `/./`.
FILE_PATH=$(printf '%s' "$FILE_PATH" | sed -E 's#/+#/#g')
while [[ "$FILE_PATH" == *"/./"* ]]; do
  FILE_PATH=$(printf '%s' "$FILE_PATH" | sed 's#/\./#/#g')
done
# Resolve /component/.. sequences
while [[ "$FILE_PATH" == *"/.."* ]]; do
  _prev="$FILE_PATH"
  FILE_PATH=$(printf '%s' "$FILE_PATH" | sed 's|/[^/][^/]*/\.\./|/|;s|/[^/][^/]*/\.\.$||')
  [[ "$FILE_PATH" == "$_prev" ]] && break
done

# Compute repo-rooted relative path so subsequent globs anchor to the
# repository root, not to an arbitrary path segment. Without this, a glob
# like `*/bot/*` would also match `reference/bot/notes.md` (the literal
# `bot` segment can occur anywhere in the tree). The frontmatter in
# bot-code-readonly.md is rooted (`bot/**` etc), so the hook must match
# the same way.
#
# Fail-closed on $CLAUDE_PROJECT_DIR — if unset, no bypass and no rooted
# matching (no $PWD fallback, since $PWD can be agent-controlled whereas
# CLAUDE_PROJECT_DIR is set by the Claude Code harness from the session's
# project root). When unset, we strip a leading `/` so absolute paths still
# enter the relative-pattern case, and rely on the literal pattern strings.
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-}"
PROJECT_ROOT="${PROJECT_ROOT%/}"
# Containment is decided CASE-INSENSITIVELY (APFS). macOS APFS is case-insensitive,
# so an absolute FILE_PATH whose workspace-root prefix case-varies (e.g. `/users/...`
# for the real `/Users/...`) names the SAME file as $CLAUDE_PROJECT_DIR. A
# case-sensitive prefix test would miss it, fall through to the leading-`/` strip
# branch, and the resulting full-path REL_PATH would match NEITHER the immutable
# case-block below NOR a schema line — bypassing both guards. `nocasematch` folds
# case for the prefix test; we then strip by LENGTH (case-folding preserves length)
# so REL_PATH keeps the original-case tail for the (case-insensitive) match + the
# error message. Mirrors guard.ts's classifyTargetPath, which lowercases both sides
# before relative().
shopt -s nocasematch
if [ -n "$PROJECT_ROOT" ] && [[ "$FILE_PATH" == "$PROJECT_ROOT"/* ]]; then
  REL_PATH="${FILE_PATH:$(( ${#PROJECT_ROOT} + 1 ))}"
else
  REL_PATH="${FILE_PATH#/}"
fi
shopt -u nocasematch

# --- 1. Skills — cron-only block (interactive sessions can still edit) ---
case "$REL_PATH" in
  .claude/skills/*)
    if [ -n "$CRON_NAME" ]; then
      echo "Blocked: cron '$CRON_NAME' cannot modify skill files: $FILE_PATH" >&2
      exit 2
    fi
    ;;
esac

# --- 2. Upstream-owned platform files — block ALL sessions ---
# Mirror of `bot-code-readonly.md` paths frontmatter. Keep these two lists
# in lockstep — the rule is the doc, the hook is the enforcement. If you
# legitimately need to change one of these files: do it in upstream
# (fitz123/claude-code-bot) → PR → merge → `git fetch upstream && git merge`.

# Bypass paths where editing these files IS the intended workflow.
# Three triggers — all log to stderr so bypass is visible in transcripts:
#   1. PROTECT_FILES_BYPASS=1  — explicit opt-out for one-off cases
#   2. $CLAUDE_PROJECT_DIR contains `/.ralphex/worktrees/`  — ralphex pipeline
#   3. git remote.origin.url at $CLAUDE_PROJECT_DIR is the upstream repo
bypass=""

if [ "${PROTECT_FILES_BYPASS:-0}" = "1" ]; then
  bypass="env PROTECT_FILES_BYPASS=1"
elif [ -n "$PROJECT_ROOT" ]; then
  if [[ "$PROJECT_ROOT" == */.ralphex/worktrees/* ]]; then
    bypass="ralphex worktree ($PROJECT_ROOT)"
  else
    origin_url="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
    case "$origin_url" in
      *fitz123/claude-code-bot.git|*fitz123/claude-code-bot|*fitz123/claude-code-bot/)
        bypass="upstream dev repo (origin=$origin_url)"
        ;;
    esac
  fi
fi

if [ -n "$bypass" ]; then
  echo "protect-files: bypass active — $bypass" >&2
  exit 0
fi

# Case-insensitive (APFS): README.MD and README.md are the SAME file, so this
# deny-overlay MUST fold case the way guard.ts (isProtectedPath) and guardian.sh's
# allow-check already do. Without it, a case-variant slips past this deny and a
# schema.md glob (e.g. `*.md`) re-allows the immutable file — breaking the
# "immutable core can never be unlocked via schema.md" invariant.
# Directory entries also match their bare name (a root file literally named
# `bot`), mirroring isProtectedPath's `lc === base` — full parity with the Pi path.
shopt -s nocasematch
case "$REL_PATH" in
  bot|bot/*) match=1 ;;
  .claude/hooks|.claude/hooks/*) match=1 ;;
  .claude/rules/platform|.claude/rules/platform/*) match=1 ;;
  .claude/skills/workspace-health/scripts|.claude/skills/workspace-health/scripts/*) match=1 ;;
  .github/workflows|.github/workflows/*) match=1 ;;
  .githooks|.githooks/*) match=1 ;;
  .gitleaks.toml) match=1 ;;
  .gitleaksignore) match=1 ;;
  README.md) match=1 ;;
  config.local.yaml.example) match=1 ;;
  *) match=0 ;;
esac
shopt -u nocasematch

if [ "$match" = "1" ]; then
  echo "BLOCKED by protect-files: '$FILE_PATH' is upstream-owned (see .claude/rules/platform/bot-code-readonly.md)." >&2
  echo "Change it in fitz123/claude-code-bot via PR, then 'git fetch upstream && git merge upstream/main'." >&2
  exit 2
fi

exit 0
