#!/bin/bash
# guardian.sh — PreToolUse hook (directory guardian)
# Prevents creation of new files/dirs in workspace root outside allowed structure.
# Uses the same allowlist as orphan-scan.sh for consistency.
#
# Rules:
# - Edit tool: always allowed (edits existing content)
# - Write tool: allowed if file exists (overwrite) or path matches allowlist
# - Only checks files within the workspace

# Fail-closed: if jq is missing, block rather than bypass
if ! command -v jq &>/dev/null; then
    echo "BLOCKED by directory guardian: jq not found — cannot parse hook input" >&2
    exit 2
fi

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Fail-closed: if tool_name is empty, input parsing failed — block rather than bypass.
# The hook matcher guarantees tool_name is always present for valid invocations.
if [[ -z "$TOOL_NAME" ]]; then
    echo "BLOCKED by directory guardian: could not parse tool_name from input" >&2
    exit 2
fi

# Edit tool always targets existing content — never block
if [[ "$TOOL_NAME" == "Edit" ]]; then
  exit 0
fi

# Write requires file_path — fail-closed if missing (defense-in-depth)
if [[ -z "$FILE_PATH" ]]; then
  echo "BLOCKED by directory guardian: Write tool called without file_path" >&2
  exit 2
fi

# Determine workspace root (no hardcoded fallback — must have CLAUDE_PROJECT_DIR)
WORKSPACE="${CLAUDE_PROJECT_DIR}"
if [[ -z "$WORKSPACE" ]]; then
  echo "BLOCKED by directory guardian: CLAUDE_PROJECT_DIR not set" >&2
  exit 2
fi

# Only check files within this workspace
if [[ "$FILE_PATH" != "$WORKSPACE/"* ]]; then
  exit 0
fi

# Extract first path component relative to workspace root
REL_PATH="${FILE_PATH#"$WORKSPACE/"}"

# Block path traversal attempts BEFORE existing-file check (defense-in-depth:
# -e resolves ".." so an attacker could escape the workspace via existing targets)
if [[ "$REL_PATH" == *".."* ]]; then
  echo "BLOCKED by directory guardian: path contains '..' traversal: ${REL_PATH}" >&2
  exit 2
fi

# Normalize path: collapse // and /./ segments
while [[ "$REL_PATH" == *//* ]]; do
  REL_PATH="${REL_PATH//\/\//\/}"
done
while [[ "$REL_PATH" == *"/./"* ]]; do
  REL_PATH="${REL_PATH//\/.\//\/}"
done
REL_PATH="${REL_PATH#./}"

# If file already exists, it's an overwrite — always allowed
if [[ -e "$FILE_PATH" ]]; then
  exit 0
fi

ROOT_COMPONENT="${REL_PATH%%/*}"

# Load allowlist (same file orphan-scan.sh uses)
ALLOWLIST="$WORKSPACE/.claude/skills/workspace-health/scripts/orphan-allowlist.txt"

if [[ ! -f "$ALLOWLIST" ]]; then
  echo "BLOCKED by directory guardian: allowlist not found at $ALLOWLIST" >&2
  echo "Cannot verify whether '${REL_PATH}' is allowed. Blocking to be safe." >&2
  exit 2
fi

# Check root component against allowlist patterns
while IFS= read -r line; do
  # Strip comments and whitespace
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue

  # Exact match
  [[ "$ROOT_COMPONENT" == "$line" ]] && exit 0

  # Glob match
  # shellcheck disable=SC2254
  case "$ROOT_COMPONENT" in $line) exit 0 ;; esac
done < "$ALLOWLIST"

# Not in allowlist — block with helpful error
cat >&2 <<ERRMSG
BLOCKED by directory guardian: cannot create '${REL_PATH}' in workspace root.

The root-level name '${ROOT_COMPONENT}' is not in the allowed workspace structure.
To allow it, add a pattern to: .claude/skills/workspace-health/scripts/orphan-allowlist.txt
ERRMSG
exit 2
