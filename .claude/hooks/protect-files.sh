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

# Normalize path: prevent bypass via non-canonical paths
# Collapse multiple slashes: // → /
while [[ "$FILE_PATH" == *//* ]]; do
  FILE_PATH="${FILE_PATH//\/\//\/}"
done
# Collapse /./ → /
while [[ "$FILE_PATH" == *"/./"* ]]; do
  FILE_PATH="${FILE_PATH//\/.\//\/}"
done
# Resolve /component/.. sequences
while [[ "$FILE_PATH" == *"/.."* ]]; do
  _prev="$FILE_PATH"
  FILE_PATH=$(printf '%s' "$FILE_PATH" | sed 's|/[^/][^/]*/\.\./|/|;s|/[^/][^/]*/\.\.$||')
  [[ "$FILE_PATH" == "$_prev" ]] && break
done

# --- 1. Skills — cron-only block (interactive sessions can still edit) ---
# Match both absolute (*/…) and relative (.claude/skills/…) paths
if [[ "$FILE_PATH" == */.claude/skills/* ]] || [[ "$FILE_PATH" == .claude/skills/* ]]; then
  if [ -n "$CRON_NAME" ]; then
    echo "Blocked: cron '$CRON_NAME' cannot modify skill files: $FILE_PATH" >&2
    exit 2
  fi
fi

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
#
# Fail-closed on $CLAUDE_PROJECT_DIR — if unset, no bypass (no $PWD fallback,
# since $PWD can be an agent-controlled location whereas CLAUDE_PROJECT_DIR
# is set by the Claude Code harness from the session's project root).
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-}"
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

case "$FILE_PATH" in
  */bot/*|bot/*) match=1 ;;
  */.claude/hooks/*|.claude/hooks/*) match=1 ;;
  */.claude/rules/platform/*|.claude/rules/platform/*) match=1 ;;
  */.claude/skills/workspace-health/scripts/*|.claude/skills/workspace-health/scripts/*) match=1 ;;
  */.github/workflows/*|.github/workflows/*) match=1 ;;
  */.githooks/*|.githooks/*) match=1 ;;
  */.gitleaks.toml|.gitleaks.toml) match=1 ;;
  */.gitleaksignore|.gitleaksignore) match=1 ;;
  */README.md|README.md) match=1 ;;
  */config.local.yaml.example|config.local.yaml.example) match=1 ;;
  *) match=0 ;;
esac

if [ "$match" = "1" ]; then
  echo "BLOCKED by protect-files: '$FILE_PATH' is upstream-owned (see .claude/rules/platform/bot-code-readonly.md)." >&2
  echo "Change it in fitz123/claude-code-bot via PR, then 'git fetch upstream && git merge upstream/main'." >&2
  exit 2
fi

exit 0
