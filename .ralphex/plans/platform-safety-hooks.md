# Platform Safety Hooks — Round 1

## Goal

Add two safety hooks (protect-files, directory guardian) to the platform template so all workspaces get active prevention against cron skill corruption and rogue file creation. These hooks have been running in production since mid-March 2026 and are ready for platformization.

## Validation Commands

```bash
npx tsc --noEmit
npm test
# Verify hooks are executable
find .claude/hooks -name '*.sh' ! -perm -u+x -print | grep -c . | grep -q '^0$'
# Verify all hooks referenced in settings.json exist
for hook in $(grep -oP '(?<=hooks/)[^"]+' .claude/settings.json); do test -f ".claude/hooks/$hook" || echo "MISSING: $hook"; done
# Verify allowlist is not empty (has non-comment lines)
grep -v '^#' .claude/skills/workspace-health/scripts/orphan-allowlist.txt | grep -v '^[[:space:]]*$' | grep -c . | grep -qv '^0$'
```

## Reference: Current hook configuration (public repo)

File: `.claude/settings.json` (public repo, 48 lines)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/inject-message.sh" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/auto-stage.sh" }]
      }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/session-end-commit.sh" }] }
    ],
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/session-start-recovery.sh" }] }
    ]
  }
}
```

Missing: no `protect-files.sh` or `guardian.sh` in PreToolUse.

## Reference: Production hook configuration (workspace)

File: `/Users/ninja/.minime/workspace/.claude/settings.json` (lines 4-27)

The workspace has an additional PreToolUse matcher for Edit|Write:

```json
{
  "matcher": "Edit|Write",
  "hooks": [
    { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-files.sh" },
    { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guardian.sh" }
  ]
}
```

Both hooks run on Edit|Write tools, before auto-stage.sh (which runs PostToolUse).

## Reference: protect-files.sh (production, 30 lines)

File: `/Users/ninja/.minime/workspace/.claude/hooks/protect-files.sh`

```bash
#!/bin/bash
# protect-files.sh — PreToolUse hook
# Blocks writes to protected skill files (for crons/autonomous agents only)
# and prevents deletion of task artifacts.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Protected: skill files (read-only for crons/autonomous agents)
if [[ "$FILE_PATH" == */.claude/skills/* ]]; then
  if [ -n "$CRON_NAME" ]; then
    echo "Blocked: cron '$CRON_NAME' cannot modify skill files: $FILE_PATH" >&2
    exit 2
  fi
fi

# Protected: task artifacts — never delete
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
if [[ "$FILE_PATH" == */reference/tasks/* ]] && [[ "$TOOL_NAME" == "Write" ]]; then
  :
fi

exit 0
```

Detection of cron context: `$CRON_NAME` env var, set by `bot/scripts/run-cron.sh:27` (`export CRON_NAME="$TASK_NAME"`). This is NOT set in plists directly — it's set in the shell wrapper that plists invoke.

## Reference: guardian.sh (production, 101 lines)

File: `/Users/ninja/.minime/workspace/.claude/hooks/guardian.sh`

Key design:
- **Edit tool:** always allowed (line 30-32)
- **Write tool:** allowed if file already exists as overwrite (line 48-51)
- **New files:** ROOT_COMPONENT of relative path checked against allowlist
- **Fail-closed:** blocks if jq missing (line 12-14), if tool_name unparseable (line 24-27), if allowlist missing (line 67-71)
- **Path traversal protection:** blocks `..` in paths (line 57-59)
- **Allowlist path:** `$WORKSPACE/.claude/skills/workspace-health/scripts/orphan-allowlist.txt` (line 65)
- **Workspace detection:** `${CLAUDE_PROJECT_DIR:-/Users/ninja/.minime/workspace}` (line 41) — hardcoded fallback must be removed for platform

## Reference: orphan-allowlist.txt (EMPTY — bug)

File: `.claude/skills/workspace-health/scripts/orphan-allowlist.txt` (both repos)

```
# Platform-generic orphan allowlist
# Root-level items that are expected in a normal workspace but not tracked by git.
# One entry per line. Lines starting with # are comments.
# Users can add workspace-specific entries to orphan-allowlist.local.txt (gitignored).
```

**Contains only comments — zero actual entries.** This means:
- guardian.sh blocks ALL new file creation (even in expected dirs like `memory/`, `reference/`)
- orphan-scan.sh flags everything that's not git-tracked or gitignored as orphan

Both scripts need actual entries in this file to function correctly. Standard workspace structure items: `memory`, `reference`, `data`, `bot`, `scripts`, plus dotfiles and markdown files at root.

## Reference: CLAUDE.md hooks section (public repo)

File: `CLAUDE.md` (line 20-26)

```markdown
## Hooks

Four hooks are wired in `.claude/settings.json`:
- `auto-stage.sh` — stages files after Edit/Write
- `session-end-commit.sh` — commits staged changes on session exit
- `session-start-recovery.sh` — recovers orphaned staged changes
- `inject-message.sh` — delivers mid-turn user messages
```

Needs updating to six hooks with protect-files.sh and guardian.sh listed.

## Reference: setup.sh hook permissions

File: `setup.sh` (line 16-19)

```bash
echo "Making hook scripts executable..."
chmod +x .claude/hooks/*.sh
```

Already handles `*.sh` glob — new hooks will be covered automatically.

## Tasks

### Task 1: Add safety hooks to platform template (#22, P2)

Two safety hooks exist in production but are missing from the platform template. Without them, workspaces have no active prevention — only passive detection (orphan-scan reports orphans after the fact, nothing prevents cron skill corruption).

**Evidence:**
- Public repo `.claude/hooks/` has 4 files, workspace has 6 — diff is protect-files.sh and guardian.sh
- Public repo `.claude/settings.json` has no Edit|Write PreToolUse matcher
- CLAUDE.md says "Four hooks" but workspace has six
- orphan-allowlist.txt is empty (only comments) — guardian.sh and orphan-scan.sh both rely on it for allowed root entries

**What we want:**
- Both hooks added to `.claude/hooks/` in the public repo, genericized (no hardcoded paths)
- `settings.json` updated with the Edit|Write PreToolUse matcher containing both hooks
- CLAUDE.md hooks section updated from four to six, listing all hooks with descriptions
- orphan-allowlist.txt populated with standard workspace root entries that both guardian.sh and orphan-scan.sh recognize
- guardian.sh fallback workspace path removed (must use only `$CLAUDE_PROJECT_DIR`)

- [ ] protect-files.sh exists in `.claude/hooks/`, blocks `$CRON_NAME` sessions from writing to `.claude/skills/*`
- [ ] guardian.sh exists in `.claude/hooks/`, blocks new files outside allowed workspace structure
- [ ] guardian.sh has no hardcoded workspace paths (uses only `$CLAUDE_PROJECT_DIR`)
- [ ] settings.json PreToolUse has Edit|Write matcher with both hooks
- [ ] CLAUDE.md documents all six hooks
- [ ] orphan-allowlist.txt contains entries for standard workspace structure (memory, reference, data, bot, scripts, etc.)
- [ ] guardian.sh blocks new file in unlisted root location (manual test: `echo test | .claude/hooks/guardian.sh` with crafted JSON)
- [ ] guardian.sh allows new file in listed root location
- [ ] guardian.sh allows overwrite of existing file
- [ ] protect-files.sh blocks when CRON_NAME is set and path is in .claude/skills/
- [ ] protect-files.sh allows when CRON_NAME is not set
- [ ] Add tests for both hooks
- [ ] Verify existing tests pass
