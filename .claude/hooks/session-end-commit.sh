#!/bin/bash
# session-end-commit.sh — SessionEnd hook
# Safety net: commits any staged changes left uncommitted when session ends.
# Must complete within 1.5s (SessionEnd default timeout).

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

# --no-verify: SessionEnd has a 1.5s timeout; pre-commit hooks could exceed it and lose work
git -C "$CWD" commit -m "session end: uncommitted changes" --no-verify

exit 0
