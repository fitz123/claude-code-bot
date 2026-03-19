# Platform Safety Hooks

**Issue:** https://github.com/fitz123/claude-code-bot/issues/22
**Branch:** `platform-safety-hooks`
**Base:** `main`

## Context

The workspace template has 4 hooks but lacks two safety hooks that prevent workspace degradation:
1. **protect-files.sh** — blocks cron/autonomous sessions from modifying skill files
2. **guardian.sh** — blocks creation of new files in workspace root outside the allowed structure

Both have been running in production since mid-March 2026. This task upstreams them to the platform template.

## Tasks

### Task 1: Add protect-files.sh and guardian.sh hooks

**Priority:** P1
**Files to create:**
- `.claude/hooks/protect-files.sh`
- `.claude/hooks/guardian.sh`

**Requirements:**
- protect-files.sh: Block writes to `.claude/skills/*` when `$CRON_NAME` env var is set. Exit 0 if no file_path or not a skill path. Exit 2 to block.
- guardian.sh: Fail-closed design. Block Write tool creating new files in workspace root if the root-level path component is not in the orphan-allowlist.txt. Edit tool always allowed. Overwriting existing files always allowed. Uses `$CLAUDE_PROJECT_DIR` for workspace root (not hardcoded path). Depends on `jq`. Loads allowlist from `.claude/skills/workspace-health/scripts/orphan-allowlist.txt`. Supports exact and glob matching. Blocks path traversal (`..`).
- Both scripts must be POSIX-compatible bash, use `jq` for JSON parsing of hook input
- Hook input format: JSON on stdin with `tool_name` and `tool_input.file_path` fields

**Acceptance criteria:**
- [ ] protect-files.sh blocks skill file writes when CRON_NAME is set
- [ ] protect-files.sh allows skill file writes when CRON_NAME is unset
- [ ] guardian.sh blocks new files outside allowlist
- [ ] guardian.sh allows overwrites of existing files
- [ ] guardian.sh allows Edit tool unconditionally
- [ ] guardian.sh fails closed when jq is missing
- [ ] guardian.sh fails closed when allowlist is missing
- [ ] guardian.sh blocks path traversal attempts
- [ ] No hardcoded workspace paths (uses $CLAUDE_PROJECT_DIR)
- [ ] Both scripts are executable

### Task 2: Update settings.json to register new hooks

**Priority:** P1
**Files to modify:**
- `.claude/settings.json`

**Requirements:**
- Add a second PreToolUse entry with matcher `Edit|Write` containing both `protect-files.sh` and `guardian.sh`
- Keep existing PreToolUse entry for `inject-message.sh` (matcher `*`) unchanged
- Hook command format: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/<script>.sh`

**Current state (to modify):**
```json
"PreToolUse": [
  {
    "matcher": "*",
    "hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/inject-message.sh"}]
  }
]
```

**Target state:**
```json
"PreToolUse": [
  {
    "matcher": "*",
    "hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/inject-message.sh"}]
  },
  {
    "matcher": "Edit|Write",
    "hooks": [
      {"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-files.sh"},
      {"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guardian.sh"}
    ]
  }
]
```

**Acceptance criteria:**
- [ ] settings.json is valid JSON after modification
- [ ] Both new hooks are registered under PreToolUse with Edit|Write matcher
- [ ] Existing hooks are unchanged

### Task 3: Update CLAUDE.md documentation

**Priority:** P2
**Files to modify:**
- `CLAUDE.md`

**Requirements:**
- Update hook count from "Four" to "Six"
- Add entries for `protect-files.sh` and `guardian.sh` with brief descriptions
- Preserve existing hook entries and their descriptions

**Current text to replace (CLAUDE.md lines 22-26):**
```
Four hooks are wired in `.claude/settings.json`:
- `auto-stage.sh` — stages files after Edit/Write
- `session-end-commit.sh` — commits staged changes on session exit
- `session-start-recovery.sh` — recovers orphaned staged changes
- `inject-message.sh` — delivers mid-turn user messages
```

**Target text:**
```
Six hooks are wired in `.claude/settings.json`:
- `inject-message.sh` — delivers mid-turn user messages
- `protect-files.sh` — blocks cron/agent writes to skill files
- `guardian.sh` — enforces workspace directory structure
- `auto-stage.sh` — stages files after Edit/Write
- `session-end-commit.sh` — commits staged changes on session exit
- `session-start-recovery.sh` — recovers orphaned staged changes
```

**Acceptance criteria:**
- [ ] Hook count is "Six"
- [ ] Both new hooks are listed with accurate descriptions
- [ ] Existing hooks are preserved

## Reference

### Hook input format (PreToolUse)
```json
{
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file",
    "content": "..."
  }
}
```

### Exit codes
- `0` — allow
- `2` — block (Claude Code shows stderr to user)

### Orphan allowlist location
`.claude/skills/workspace-health/scripts/orphan-allowlist.txt` — one pattern per line, `#` comments, blank lines ignored. Used by both `orphan-scan.sh` and `guardian.sh`.

### $CRON_NAME convention
Environment variable set by `generate-plists.ts` in cron plist EnvironmentVariables dict. Present = autonomous/cron session. Absent = interactive session with user.

### settings.json is protected by .gitattributes
`.claude/settings.json` has `merge=ours` in `.gitattributes` — workspace versions are preserved during upstream merge. The platform version in the public repo is the template default.
