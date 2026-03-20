# Transparent Installation — No Magic

## Goal

A user cloning the repo should get a running bot by following clear, numbered steps in README. No setup.sh, no interactive wizard, no magic. Every step is visible and understood: clone → npm install → copy examples → fill in config → store tokens in Keychain → create plist → start. Currently: example files are in the wrong place (bot/ instead of root), config.ts resolves config.yaml inconsistently with crons.yaml, README lacks installation guide, directory structure is incomplete (.gitkeep missing for memory subdirs), and no bot plist template exists.

## Validation Commands

```bash
cd /Users/ninja/src/claude-code-bot && cd bot && npx tsc --noEmit && npm test
```

## Reference: config.ts validation — required fields

config.ts `loadConfig` function (line 240-335) loads config.yaml and validates:

```typescript
// bot/src/config.ts:10
const DEFAULT_CONFIG_PATH = resolve(__dirname, "..", "config.yaml");
// __dirname = bot/src/, so config path = bot/config.yaml

// bot/src/config.ts:249-251 — agents required
if (!raw.agents || typeof raw.agents !== "object") {
  throw new Error("Missing agents in config");
}

// bot/src/config.ts:259-261 — Telegram token from Keychain
if (typeof raw.telegramTokenService === "string") {
  telegramToken = resolveKeychainSecret(raw.telegramTokenService);
}

// bot/src/config.ts:265-268 — bindings require token
if (Array.isArray(raw.bindings) && raw.bindings.length > 0) {
  if (!telegramToken) {
    throw new Error("Telegram bindings require telegramTokenService");
  }
}

// bot/src/config.ts:289-291 — at least one platform
if (bindings.length === 0 && !discord) {
  throw new Error("At least one platform must be configured (Telegram bindings or discord section)");
}
```

Agent validation (line 40-50):
```typescript
// workspaceCwd and model are required per agent
if (typeof obj.workspaceCwd !== "string") {
  throw new Error(`Agent "${id}" missing workspaceCwd`);
}
if (typeof obj.model !== "string") {
  throw new Error(`Agent "${id}" missing model`);
}
```

Keychain secret resolution (line 28-38):
```typescript
function resolveKeychainSecret(service: string): string {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch {
    throw new Error(`Failed to read Keychain service: ${service}`);
  }
}
```

Config validation CLI (line 338): `npx tsx src/config.ts --validate`

## Reference: start-bot.sh — startup chain

```bash
# bot/scripts/start-bot.sh:14-15
# Reads Claude Code OAuth token from Keychain (for Claude CLI subprocess auth)
export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s claude-code-oauth-token -w)

# bot/scripts/start-bot.sh:25-29
# Derives BOT_DIR from script location, runs main.ts from bot/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BOT_DIR"
exec npx tsx src/main.ts
```

Two Keychain secrets needed for startup:
1. `telegram-bot-token` — read by config.ts at runtime via `telegramTokenService` field
2. `claude-code-oauth-token` — read by start-bot.sh before spawning Claude Code (created by `claude auth login`, not manually)

## Reference: config.yaml.example — minimum viable config

```yaml
# bot/config.yaml.example (lines 1-31)
telegramTokenService: telegram-bot-token

agents:
  main:
    id: main
    workspaceCwd: /Users/YOU/.minime/workspace   # absolute path required
    model: claude-opus-4-6
    fallbackModel: claude-sonnet-4-6
    maxTurns: 250
    effort: high

bindings:
  - chatId: YOUR_CHAT_ID
    agentId: main
    kind: dm
    label: My DM
```

Config file currently expected at: `bot/config.yaml` (resolve from `bot/src/../config.yaml`). Task 1 moves this to workspace root.

## Reference: bot launchd plist structure

No plist template exists in the repo. Current production plist structure:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.minime.telegram-bot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>WORKSPACE/bot/scripts/start-bot.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>WORKSPACE</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>35</integer>
    <key>StandardOutPath</key>
    <string>LOG_DIR/telegram-bot.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>LOG_DIR/telegram-bot.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>USER_HOME</string>
    </dict>
</dict>
</plist>
```

Key fields: Label, ProgramArguments (path to start-bot.sh), WorkingDirectory (workspace root), KeepAlive (auto-restart), log paths.

## Reference: config file path inconsistency

config.yaml and crons.yaml are resolved from different base directories:

```typescript
// bot/src/config.ts:10 — resolves from __dirname (bot/src/)
const DEFAULT_CONFIG_PATH = resolve(__dirname, "..", "config.yaml");
// Result: bot/config.yaml

// bot/scripts/generate-plists.ts:13-15 — resolves from REPO_ROOT (workspace root)
const BOT_DIR = resolve(__dirname, "..");        // = bot/
const REPO_ROOT = resolve(BOT_DIR, "..");        // = workspace root
const CRONS_PATH = resolve(REPO_ROOT, "crons.yaml");  // workspace root
```

Current state: config.yaml expected at `bot/config.yaml`, crons.yaml expected at workspace root.
Both example files live in `bot/` (`bot/config.yaml.example`, `bot/crons.yaml.example`).
Both `.gitignore` entries exist for both levels: `bot/config.yaml`, `bot/crons.yaml`, `config.yaml`, `crons.yaml`.

In the production workspace, both files live at workspace root because start-bot.sh was modified to `cd` to workspace root instead of `bot/`. The public repo's start-bot.sh `cd`s to `bot/`, creating the inconsistency.

Note: `cron-runner.ts:17` already resolves config.yaml from REPO_ROOT (`const CONFIG_PATH = resolve(REPO_ROOT, "config.yaml")`). Only `config.ts` needs to change — cron-runner.ts is already correct.

Note: `start-bot.sh` does not need changes after Task 1. `config.ts` resolves via `__dirname` (file location from `import.meta.url`), not CWD, so `cd "$BOT_DIR"` in start-bot.sh does not affect path resolution.

Note: `bot/src/__tests__/project-naming.test.ts:16` hardcodes `readRepoFile("bot/config.yaml.example")` — this test must be updated when moving the example file.

## Reference: directory structure gaps

Git preserves executable bits — all hooks and skill scripts are committed as `100755`. No chmod needed after clone.

Memory directory has only one `.gitkeep` at `memory/.gitkeep`. Subdirectories `memory/auto/` and `memory/diary/` are not tracked — they don't exist after a fresh clone. The memory-consolidation skill writes to both. (`memory/daily/` is NOT used by the skill — `test-platform-integration.sh:113-118` explicitly verifies its absence.)

`.gitignore` pattern `memory/*` with negation `!memory/.gitkeep` blocks tracking files inside subdirectories. To track `.gitkeep` in `memory/auto/` and `memory/diary/`, the `.gitignore` must explicitly un-ignore those subdirectories.

`.claude/rules/custom/` has a `.gitkeep` — exists after clone.

## Reference: settings.local.json.example

```json
{
  "outputStyle": "verbose",
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "/absolute/path/to/your/workspace/memory/auto"
}
```

Without `autoMemoryDirectory`, Claude Code's auto-memory writes to its default location instead of `memory/auto/`, breaking the memory-consolidation skill workflow.

## Tasks

### Task 1: Config files live at inconsistent locations (P0)

config.yaml and crons.yaml are resolved from different base directories. config.ts (line 10) resolves config.yaml relative to `__dirname` (`bot/src/`), resulting in `bot/config.yaml`. generate-plists.ts (line 13-15) resolves crons.yaml relative to `REPO_ROOT` (parent of `bot/`), resulting in workspace root. Both example files live in `bot/`, and `.gitignore` has entries for both levels.

In production, both files live at workspace root because start-bot.sh was modified. But the public repo's code expects them at different levels — confusing for new users.

Both config files should live at workspace root. This matches how the workspace is structured and how crons.yaml already works. Only config.ts needs code changes — cron-runner.ts and generate-plists.ts already resolve from REPO_ROOT. start-bot.sh does not need changes — config.ts resolves via `__dirname` (file location), not CWD.

- [x] config.ts resolves config.yaml from REPO_ROOT (workspace root), not from `__dirname`
- [x] config.yaml.example moved from `bot/` to workspace root
- [x] crons.yaml.example moved from `bot/` to workspace root
- [x] .gitignore cleaned up (remove `bot/config.yaml` and `bot/crons.yaml` entries, keep root entries)
- [x] README.md updated to reflect new config file locations
- [x] config.yaml.example header updated (`cp config.yaml.example config.yaml`)
- [x] crons.yaml.example header updated (`cp crons.yaml.example crons.yaml`)
- [x] `project-naming.test.ts` updated to reference `config.yaml.example` at repo root instead of `bot/config.yaml.example`
- [x] Config validation still works from any CWD (`cd bot && npx tsx src/config.ts --validate` and `npx tsx bot/src/config.ts --validate`)
- [x] Add tests
- [x] Verify existing tests pass

### Task 2: Remove setup.sh, add .gitkeep files, write installation guide (#27, P0)

Depends on Task 1 (config file locations). README instructions reference post-Task-1 state (examples at repo root).

setup.sh is unnecessary. Git preserves executable bits (all hooks are `100755`), `npm install` is one command, and everything else is better documented as explicit manual steps rather than hidden in a script.

**Directory gaps:** `memory/auto/` and `memory/diary/` have no `.gitkeep` files — they don't exist after clone. The memory-consolidation skill needs both. (`memory/daily/` is NOT used — `test-platform-integration.sh:113-118` explicitly verifies its absence.) `.gitignore` pattern `memory/*` with negation `!memory/.gitkeep` blocks tracking files inside subdirectories — `.gitignore` must be updated to un-ignore `memory/auto/` and `memory/diary/` and their `.gitkeep` files.

**No plist template:** There is no launchd plist template in the repo. `generate-plists.ts` only creates cron plists. Users have no reference for the bot service plist structure.

**No installation guide:** README has architecture docs and troubleshooting but no numbered "how to get from clone to running bot" section. Users need to know:
- Prerequisites (Node.js, npm, Claude Code CLI authenticated via `claude auth login`)
- `cd bot && npm install`
- Copy config.yaml.example → config.yaml, fill in `workspaceCwd` (absolute path to workspace) and `chatId` (Telegram user ID)
- Copy crons.yaml.example → crons.yaml (or create minimal `crons: []`)
- Copy .claude/settings.local.json.example → .claude/settings.local.json, set `autoMemoryDirectory` to `<workspace>/memory/auto`
- Store Telegram bot token in Keychain: `security add-generic-password -s 'telegram-bot-token' -a 'minime' -w 'TOKEN'`
- Optionally store Discord token: `security add-generic-password -s 'discord-bot-token' -a 'minime' -w 'TOKEN'`
- Claude Code OAuth token is handled by `claude auth login` (stored automatically)
- Create launchd plist from template, fill in paths
- `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.telegram-bot.plist`
- Verify: `launchctl list | grep telegram-bot`, check logs
- Optional: activate rules (`cp .claude/optional-rules/<rule>.md .claude/rules/custom/`)
- Optional: init ADR governance (`mkdir -p reference/governance && cp reference/governance/decisions.md.example reference/governance/decisions.md`)

- [x] setup.sh removed from the repo
- [x] .gitignore updated to un-ignore memory/auto/ and memory/diary/ subdirectories
- [x] .gitkeep added to memory/auto/ and memory/diary/ (both exist after clone)
- [x] Bot launchd plist template exists in the repo (e.g. `telegram-bot.plist.example`) with placeholder paths and comments
- [x] README has "Installation" section with numbered steps from clone to running bot
- [x] README documents all required Keychain entries with exact `security` commands
- [x] README documents Claude Code authentication (`claude auth login`)
- [x] README documents how to fill in config.yaml (which fields, what values)
- [x] README documents settings.local.json setup with autoMemoryDirectory
- [x] README documents how to create and load the launchd plist from template
- [x] README documents verification steps (launchctl list, log tail, send test message)
- [x] README documents optional steps (Discord, crons, optional rules activation, ADR governance)
- [x] Add tests
- [x] Verify existing tests pass
