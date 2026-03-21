# Unified Config Override Pattern (ADR-064) — Round 1

## Goal

Standardize all configuration override mechanisms in the project to one pattern: upstream ships `X` (tracked, works out of box), user adds `X.local` (gitignored, never conflicts). Currently 6 different patterns coexist, causing confusion and inconsistency.

## Validation Commands

```bash
cd ~/src/claude-code-bot && cd bot && npm test && npx tsc --noEmit && cd .. && bash .claude/hooks/guardian.sh 2>/dev/null; echo "exit: $?"
```

## Reference: Current Override Patterns

Six different patterns exist today:

| # | Pattern | Where Used | How It Works |
|---|---------|-----------|-------------|
| 1 | `.example` copy | config.yaml, crons.yaml, plist, decisions.md | User copies `.example` → removes suffix. Gitignored actual file. |
| 2 | `merge=ours` | CLAUDE.md, USER.md, IDENTITY.md, MEMORY.md, settings.json, .gitignore, .gitattributes | Git merge always keeps workspace version |
| 3 | `X` + `X.local` | settings.json, orphan-allowlist | Deep merge or concatenation |
| 4 | `platform/` + `custom/` | rules | Both auto-loaded, custom = user space |
| 5 | `optional-rules/` → copy to `custom/` | rules | Manual activation |
| 6 | workspace-root > skill-dir fallback | orphan-allowlist (PR#54) | Root files override skill-level entirely |

## Reference: File Locations and Content

### config.yaml.example (public repo)
`~/src/claude-code-bot/config.yaml.example:1-4`:
```
# Minime Bot Configuration
#
# Copy this file to config.yaml and fill in your values:
#   cp config.yaml.example config.yaml
```
Lines 1-100: Full bot config template with placeholder values (`/Users/YOU/`, `YOUR_CHAT_ID`).

### crons.yaml.example (public repo)
`~/src/claude-code-bot/crons.yaml.example:1-4`:
```
# Cron job definitions — loaded by cron-runner.ts
# All times use the machine's local timezone
# Copy this file to crons.yaml and customize:
#   cp crons.yaml.example crons.yaml
```
Lines 1-60: Cron template with 3 active examples + 1 commented script-mode example. Uses `YOUR_CHAT_ID` placeholders.

### .gitattributes (public repo)
`~/src/claude-code-bot/.gitattributes:1-9`:
```
# Divergent files — keep workspace version on merge
# These files are customized per-workspace and should not be overwritten by upstream
CLAUDE.md merge=ours
USER.md merge=ours
IDENTITY.md merge=ours
MEMORY.md merge=ours
.claude/settings.json merge=ours
.gitignore merge=ours
.gitattributes merge=ours
```

### .gitignore (public repo)
`~/src/claude-code-bot/.gitignore:22`:
```
.claude/settings.local.json
```
`~/src/claude-code-bot/.gitignore:29`:
```
orphan-allowlist.local.txt
```
`~/src/claude-code-bot/.gitignore:39-41`:
```
# Instance config (user creates from .example)
config.yaml
crons.yaml
```

### orphan-allowlist files (current state after PR#54)

Skill dir (upstream, tracked):
- `~/src/claude-code-bot/.claude/skills/workspace-health/scripts/orphan-allowlist.txt` — 39 lines, platform defaults

Note: `orphan-allowlist.local.txt` does NOT exist in the public repo skill dir. It exists only in the private workspace's copy at `/Users/ninja/.minime/workspace/.claude/skills/workspace-health/scripts/orphan-allowlist.local.txt` (contains `.playwright-mcp`). This is a workspace-side cleanup item, not a public repo change.

Workspace root (private workspace):
- `/Users/ninja/.minime/workspace/.orphan-allowlist.local.txt` — hidden file (dot-prefix), inconsistent naming with skill-level `orphan-allowlist.txt`

### guardian.sh allowlist loading (PR#54)
`~/src/claude-code-bot/.claude/hooks/guardian.sh:79-90`:
```bash
ALLOWLIST_FILES=()
if [[ -f "$WORKSPACE/.orphan-allowlist.txt" ]] || [[ -f "$WORKSPACE/.orphan-allowlist.local.txt" ]]; then
  [[ -f "$WORKSPACE/.orphan-allowlist.txt" ]] && ALLOWLIST_FILES+=("$WORKSPACE/.orphan-allowlist.txt")
  [[ -f "$WORKSPACE/.orphan-allowlist.local.txt" ]] && ALLOWLIST_FILES+=("$WORKSPACE/.orphan-allowlist.local.txt")
else
  SKILL_ALLOWLIST="$WORKSPACE/.claude/skills/workspace-health/scripts/orphan-allowlist.txt"
  SKILL_ALLOWLIST_LOCAL="$WORKSPACE/.claude/skills/workspace-health/scripts/orphan-allowlist.local.txt"
  [[ -f "$SKILL_ALLOWLIST" ]] && ALLOWLIST_FILES+=("$SKILL_ALLOWLIST")
  [[ -f "$SKILL_ALLOWLIST_LOCAL" ]] && ALLOWLIST_FILES+=("$SKILL_ALLOWLIST_LOCAL")
fi
```

### orphan-scan.sh allowlist loading (PR#54)
`~/src/claude-code-bot/.claude/skills/workspace-health/scripts/orphan-scan.sh:20-28`:
```bash
if [ -f "$WORKSPACE/.orphan-allowlist.txt" ] || [ -f "$WORKSPACE/.orphan-allowlist.local.txt" ]; then
  ALLOWLIST="$WORKSPACE/.orphan-allowlist.txt"
  ALLOWLIST_LOCAL="$WORKSPACE/.orphan-allowlist.local.txt"
else
  ALLOWLIST="$SCRIPT_DIR/orphan-allowlist.txt"
  ALLOWLIST_LOCAL="$SCRIPT_DIR/orphan-allowlist.local.txt"
fi
```

### settings.json (public repo)
`~/src/claude-code-bot/.claude/settings.json` — 61 lines. Contains hooks config, outputStyle, autoMemoryEnabled. Protected by `merge=ours`.

### settings.local.json.example (public repo)
`~/src/claude-code-bot/.claude/settings.local.json.example:1-5`:
```json
{
  "outputStyle": "verbose",
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "/absolute/path/to/your/workspace/memory/auto"
}
```

### Bot config loading
`~/src/claude-code-bot/bot/src/config.ts` — loads `config.yaml` at runtime. No `.local` merge logic currently exists in bot code.

`~/src/claude-code-bot/bot/src/cron-runner.ts:17` also reads `config.yaml` directly:
```typescript
const CONFIG_PATH = resolve(REPO_ROOT, "config.yaml");
```
Functions `getAgentWorkspace` (lines 117-124) and `loadAdminChatId`/`loadDefaultDelivery` (lines 127-162) parse config.yaml independently — they do not use `loadConfig()` from config.ts.

### Cron loading
`~/src/claude-code-bot/bot/src/cron-runner.ts` — loads `crons.yaml` at runtime. No `.local` merge logic currently exists.

`~/src/claude-code-bot/bot/scripts/generate-plists.ts:15` also reads `crons.yaml` directly:
```typescript
const CRONS_PATH = resolve(REPO_ROOT, "crons.yaml");
```
This script generates launchd plists from cron definitions. If it doesn't read `crons.local.yaml`, user crons won't get plists and won't run.

## Tasks

### Task 1: Fix orphan-allowlist naming and location (workspace-voy5, P1)

**Problem:** After PR#54, three inconsistencies exist:
1. Workspace root file uses dot-prefix (`.orphan-allowlist.local.txt`) while skill-level uses no dot (`orphan-allowlist.txt`). Hidden files are for system internals, not user-editable config.
2. `orphan-allowlist.local.txt` exists in skill dir (`scripts/`) — it should only exist at workspace root. Skill dir = upstream platform defaults only.
3. When workspace root file exists, skill-level is completely ignored — so `.playwright-mcp` entry from skill-level `.local.txt` is silently lost.

**Evidence:** File listing shows dot-prefix at root: `/Users/ninja/.minime/workspace/.orphan-allowlist.local.txt`. In the private workspace, skill-dir has `orphan-allowlist.local.txt` with `.playwright-mcp` entry that's now unreachable because root file exists. The public repo skill dir does not have a `.local.txt` file.

**What we want:**
- `orphan-allowlist.txt` at workspace root (no dot, not hidden) = upstream platform defaults. Shipped by upstream, tracked in git.
- `orphan-allowlist.local.txt` at workspace root (no dot, not hidden) = user overrides. Gitignored.
- guardian.sh and orphan-scan.sh use `orphan-allowlist.txt` and `orphan-allowlist.local.txt` from workspace root.
- Both files are read and combined (platform defaults + user additions).

- [x] `orphan-allowlist.txt` exists at workspace root (not hidden, tracked in git)
- [x] `orphan-allowlist.local.txt` is gitignored (not hidden, in workspace root)
- [x] `orphan-allowlist.txt` no longer exists in `.claude/skills/workspace-health/scripts/`
- [x] guardian.sh reads allowlists from workspace root only (no fallback to skill dir)
- [x] orphan-scan.sh reads allowlists from workspace root only (no fallback to skill dir)
- [x] Both files are concatenated (user additions extend platform defaults, not replace)
- [x] Add tests for allowlist loading and concatenation (both files combined, local extends platform)
- [x] Verify existing tests pass

### Task 2: Implement config.yaml + config.local.yaml layering (workspace-voy5, P1)

**Problem:** Currently `config.yaml.example` must be manually copied and fully filled in by the user. The example contains working defaults (tokenService, sessionDefaults, metricsPort) mixed with placeholder values (agent paths, chat IDs). User must edit the entire file even though most of it is boilerplate.

**Evidence:** `config.yaml.example:3-4` says "Copy this file to config.yaml and fill in your values". `.gitignore:40` ignores `config.yaml`. New users must copy and edit 100 lines when they only need to specify ~5 values (agent paths, chat IDs).

**What we want:**
- `config.yaml` = upstream defaults (tracked in git, works out of box for basic setup minus user-specific values)
- `config.local.yaml` = user overrides (gitignored, only user-specific values: agent workspaceCwd, bindings with real chat IDs, discord config)
- User overrides in `config.local.yaml` take precedence over defaults in `config.yaml`
- `config.yaml.example` removed — `config.yaml` itself IS the documented default
- `config.local.yaml.example` added — shows what users typically override
- `.gitignore` updated: remove `config.yaml`, add `config.local.yaml`

- [x] `config.yaml` is tracked in git with working defaults (no placeholder values)
- [x] `config.local.yaml` is gitignored
- [x] `config.local.yaml.example` exists with clear examples of user overrides
- [x] `config.yaml.example` is removed
- [x] Nested config values in `config.local.yaml` override corresponding values in `config.yaml` without losing unrelated keys
- [x] Bot starts successfully with only `config.yaml` (no local override) — using defaults
- [x] Bot starts successfully with `config.yaml` + `config.local.yaml` — local values override defaults
- [x] Merge precedence: `config.local.yaml` values always win over `config.yaml`
- [x] All config consumers (config.ts, cron-runner.ts) use merged config — no direct reads of `config.yaml` alone
- [x] `.gitignore` lists `config.local.yaml` instead of `config.yaml`
- [x] Add tests for config merging logic
- [x] Verify existing tests pass

### Task 3: Implement crons.yaml + crons.local.yaml layering (workspace-voy5, P1)

**Problem:** Same issue as config.yaml — `crons.yaml.example` must be fully copied. The example has useful documentation and structure but placeholder values. User crons are completely separate from upstream example crons.

**Evidence:** `crons.yaml.example:3-4` says "Copy this file to crons.yaml and customize". `.gitignore:41` ignores `crons.yaml`. Workspace has 650+ line `crons.yaml` with 35+ crons — all user-specific.

**What we want:**
- `crons.yaml` = upstream examples/documentation (tracked, a few example crons that work with defaults)
- `crons.local.yaml` = user crons (gitignored, all user-specific cron definitions)
- Crons defined in both files are all available at runtime
- If same cron `name` appears in both files, local wins (override mechanism)
- `crons.yaml.example` removed — `crons.yaml` itself IS the documented default
- `crons.local.yaml.example` added — shows format for user crons
- `.gitignore` updated: remove `crons.yaml`, add `crons.local.yaml`

- [x] `crons.yaml` is tracked in git with documented example crons
- [x] `crons.local.yaml` is gitignored
- [x] `crons.local.yaml.example` exists with clear user cron examples
- [x] `crons.yaml.example` is removed
- [x] Cron loader concatenates cron arrays from both files
- [x] Duplicate cron names: local wins over upstream
- [x] Bot starts with only `crons.yaml` (no local) — example crons loaded (or disabled by default)
- [x] Bot starts with both files — all crons from both are available
- [x] generate-plists.ts reads and merges both crons.yaml and crons.local.yaml when generating plists
- [x] `.gitignore` lists `crons.local.yaml` instead of `crons.yaml`
- [x] Add tests for cron merging logic
- [x] Verify existing tests pass

### Task 4: Clean up .gitattributes and .example files (workspace-voy5, P2)

**Problem:** After tasks 1-3, some `.gitattributes` entries and `.example` files are no longer needed. Multiple test files and scripts reference `.example` files that will be removed — these will break. `merge=ours` for `.claude/settings.json` is still needed (ADR-045 — contains hooks that are workspace-customized). Identity files (CLAUDE.md, USER.md, IDENTITY.md, MEMORY.md) still need `merge=ours` — they are workspace-owned, not layered.

**Evidence:** `.gitattributes:7` lists `.claude/settings.json merge=ours`. ADR-045 explains why: settings.json contains hooks which are workspace-specific. `.gitattributes:8-9` list `.gitignore` and `.gitattributes` themselves — needed to protect the protection mechanism.

Files referencing `.example` that will break:
- `bot/src/__tests__/project-naming.test.ts:16,112-119,123-130` — reads `config.yaml.example`, asserts it exists at repo root
- `bot/src/__tests__/cron-fields.test.ts:41,49` — reads `crons.yaml.example`
- `.claude/skills/workspace-health/tests/test-scripts.sh:508` — checks `crons.yaml.example`
- `.claude/skills/memory-consolidation/tests/test-platform-integration.sh:43-46` — checks `crons.yaml.example` exists
- `.claude/skills/workspace-health/scripts/config-check.sh:73` — references `settings.local.json.example`
- `CLAUDE.md:56` — references `.claude/settings.local.json.example`

**What we want:**
- Remove `config.yaml.example` (replaced by tracked `config.yaml`)
- Remove `crons.yaml.example` (replaced by tracked `crons.yaml`)
- Remove `.claude/settings.local.json.example` (pattern is now documented, example adds noise)
- Keep `bot/telegram-bot.plist.example` (plist has machine-specific paths, not layerable)
- Keep `reference/governance/decisions.md.example` (ADR template, not a config)
- Keep all identity-file `merge=ours` entries (CLAUDE.md, USER.md, IDENTITY.md, MEMORY.md)
- Keep `.claude/settings.json merge=ours` (ADR-045)
- Keep `.gitignore merge=ours` and `.gitattributes merge=ours` (self-protection)
- Update CLAUDE.md setup instructions to reference new pattern
- Update README if it references `.example` copy workflow

- [ ] `config.yaml.example` no longer exists in repo
- [ ] `crons.yaml.example` no longer exists in repo
- [ ] `.claude/settings.local.json.example` no longer exists in repo
- [ ] `bot/telegram-bot.plist.example` still exists (not part of this migration)
- [ ] `reference/governance/decisions.md.example` still exists (not part of this migration)
- [ ] `.gitattributes` retains identity files + settings.json + .gitignore + .gitattributes
- [ ] Setup documentation updated to describe `X` + `X.local` pattern
- [ ] All test files updated to reference `config.yaml`/`crons.yaml` instead of `.example` variants
- [ ] No broken references to removed `.example` files anywhere in codebase (verified by grep)
- [ ] Verify existing tests pass
