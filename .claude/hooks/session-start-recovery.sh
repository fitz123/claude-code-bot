#!/bin/bash
# session-start-recovery.sh — SessionStart hook
# Detects and commits orphaned staged changes from prior crashed sessions.
# Outputs a message so the agent knows recovery happened.

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$CWD" ]; then
  exit 0
fi

if ! git -C "$CWD" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

if git -C "$CWD" diff --cached --quiet 2>/dev/null; then
  exit 0
fi

# Don't commit during rebase/merge/cherry-pick — could corrupt git state
_git_dir=$(git -C "$CWD" rev-parse --git-dir 2>/dev/null)
if [ -d "$_git_dir/rebase-merge" ] || [ -d "$_git_dir/rebase-apply" ] || \
   [ -f "$_git_dir/MERGE_HEAD" ] || [ -f "$_git_dir/CHERRY_PICK_HEAD" ]; then
  exit 0
fi

# --no-verify: recovery must succeed even if pre-commit hooks would fail
if git -C "$CWD" commit -m "recovered: uncommitted changes from crashed session" --no-verify; then
  echo "Recovered uncommitted staged changes from a prior crashed session."
fi

exit 0
