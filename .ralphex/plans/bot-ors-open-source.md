# Open Source Prep — Bot v1 Public Release

## Goal

Prepare the bot for public GitHub release by removing all personal data (hardcoded paths, Telegram IDs, names) and making configuration portable. The bot should be cloneable and runnable by anyone with a Claude Max subscription.

## Validation Commands

```bash
cd /Users/ninja/.openclaw/bot && npx tsc --noEmit && npm test
# Verify no personal data leaked:
grep -rn "306600687\|7418988410\|1320328600\|/Users/ninja\|Ninja DM\|Yulia DM\|Anna DM" src/ scripts/ --include='*.ts' --include='*.sh' | grep -v node_modules | grep -v '.ralphex/' | grep -v 'config.yaml' | grep -v 'crons.yaml'
```

## Reference: Hardcoded paths in source files

Current state — all these files contain `/Users/ninja/` hardcoded:

```typescript
// src/session-manager.ts:12
const LOG_DIR = "/Users/ninja/.openclaw/logs";

// src/session-store.ts:5
const DEFAULT_STORE_PATH = "/Users/ninja/.openclaw/bot/data/sessions.json";

// src/cron-runner.ts:16
const LOG_DIR = "/Users/ninja/.openclaw/logs";

// src/cron-runner.ts:132 (inside runClaude function)
env.HOME = "/Users/ninja";

// src/cli-capabilities.ts:16 (detectCapabilities) and :73 (verifyAuth)
env.HOME = "/Users/ninja";
```

Shell scripts:
```bash
# scripts/run-cron.sh:9
export HOME="/Users/ninja"
# scripts/run-cron.sh:28
BOT_DIR="/Users/ninja/.openclaw/bot"

# scripts/start-bot.sh:8
export HOME="/Users/ninja"
# scripts/start-bot.sh:25
BOT_DIR="/Users/ninja/.openclaw/bot"

# scripts/deliver.sh:59
LOG_DIR="/Users/ninja/.openclaw/logs"

# scripts/generate-plists.ts:14-15
const LAUNCH_AGENTS_DIR = "/Users/ninja/Library/LaunchAgents";
const LOG_DIR = "/Users/ninja/.openclaw/logs";
// scripts/generate-plists.ts:216 (plist template, HOME env var in generated XML)
// <string>/Users/ninja</string>
```

## Reference: Personal IDs in source and tests

```typescript
// src/cron-runner.ts:18
const NINJA_CHAT_ID = 306600687;

// src/__tests__/bindings.test.ts — uses real IDs and personal labels:
// 306600687, 7418988410, 1320328600
// Labels: "Ninja DM", "Yulia DM", "Anna DM"
// Also hardcoded paths: /Users/ninja/.openclaw/workspace*

// src/__tests__/telegram-bot.test.ts — same real IDs and labels
// src/__tests__/cron-runner.test.ts — 306600687
// src/__tests__/cli-protocol.test.ts — /Users/ninja/.openclaw/workspace
```

## Reference: Voice binary paths

```typescript
// src/voice.ts:9-11
export const FFMPEG_BIN = "/opt/homebrew/bin/ffmpeg";
export const WHISPER_BIN = "/opt/homebrew/bin/whisper-cli";
export const WHISPER_MODEL = "/opt/homebrew/share/whisper-cpp/ggml-medium.bin";
```

These are Homebrew Apple Silicon defaults — fine as defaults but should fall back to PATH lookup.

## Reference: Config files with personal data

`config.yaml` is tracked in git and contains:
- Real Telegram chat IDs (306600687, 7418988410, 1320328600)
- Group ID (-1003894624477)
- Discord guild ID (1470077196537168007)
- Personal workspace paths (/Users/ninja/.minime/workspace*)
- Personal labels (Ninja DM, Anna DM, Yulia DM, ЦИАН)

`crons.yaml` is tracked in git and contains:
- deliveryChatId: 306600687 throughout
- Personal skill paths and Russian prompt text

## Reference: package.json

```json
{
  "name": "bot",
  "description": "",
  "author": "",
  "license": "ISC",
  "keywords": []
}
```

## Reference: README.md

Exists and is comprehensive (architecture, setup, config, troubleshooting). Line 122 has an example path `/Users/ninja/.openclaw/workspace-new` that needs sanitizing.

## Tasks

### Task 1: Replace hardcoded paths with dynamic resolution (bot-ors, P2)

All TypeScript source files and shell scripts use `/Users/ninja/` as a hardcoded base path. This makes the bot unrunnable for anyone else.

**What we want:** All paths derived dynamically — `os.homedir()` in TypeScript, `$HOME` or script-relative paths in shell. No `/Users/ninja/` anywhere in source code.

Files affected: `session-manager.ts`, `session-store.ts`, `cron-runner.ts`, `cli-capabilities.ts`, `voice.ts`, `scripts/run-cron.sh`, `scripts/start-bot.sh`, `scripts/deliver.sh`, `scripts/generate-plists.ts`.

- [ ] No `/Users/ninja/` string appears in any `.ts` or `.sh` file under `src/` or `scripts/`
- [ ] LOG_DIR derived from `os.homedir()` or a `LOG_DIR` env var with sensible default
- [ ] Session store default path derived relative to bot directory or `os.homedir()`
- [ ] Shell scripts derive BOT_DIR from script location (`dirname "$0"`), HOME from `$HOME`
- [ ] Voice binary paths use env vars (`FFMPEG_BIN`, `WHISPER_BIN`, `WHISPER_MODEL`) with current values as defaults
- [ ] generate-plists.ts uses `os.homedir()` for LaunchAgents dir and log dir
- [ ] `env.HOME = "/Users/ninja"` in cli-capabilities.ts (2 occurrences: detectCapabilities + verifyAuth) replaced with `os.homedir()`
- [ ] `env.HOME = "/Users/ninja"` in cron-runner.ts:132 (runClaude) replaced with `os.homedir()`
- [ ] generate-plists.ts:216 plist template HOME value uses `os.homedir()` at generation time
- [ ] `NINJA_CHAT_ID` constant in cron-runner.ts replaced with config-driven fallback chat ID
- [ ] All existing tests pass
- [ ] Add test verifying path resolution uses homedir (at least one)

### Task 2: Sanitize test fixtures — replace personal IDs and paths (bot-ors, P2)

Test files contain real personal Telegram IDs (306600687, 7418988410, 1320328600) and real paths. These would leak personal data in a public repo.

**What we want:** All test fixtures use obviously-fake IDs (like 111111111, 222222222, 333333333) and generic paths (`/tmp/test-workspace`). Test behavior unchanged.

Files: `src/__tests__/bindings.test.ts`, `src/__tests__/telegram-bot.test.ts`, `src/__tests__/cron-runner.test.ts`, `src/__tests__/cli-protocol.test.ts`.

- [ ] No real Telegram user ID (306600687, 7418988410, 1320328600) in any test file
- [ ] No `/Users/ninja/` path in any test file
- [ ] No personal name labels ("Ninja DM", "Yulia DM", "Anna DM") in any test file
- [ ] Test IDs are obviously fake (e.g. 111111111, 222222222)
- [ ] Test labels are generic (e.g. "User1 DM", "User2 DM")
- [ ] All tests pass with new fixture IDs

### Task 3: Config templates and gitignore (bot-ors, P2)

`config.yaml` and `crons.yaml` contain personal deployment data (chat IDs, names, workspace paths) and are tracked in git. Publishing would leak personal information.

**What we want:** Example config files with placeholder values, real configs gitignored, clear documentation on how to set up.

- [ ] `config.yaml.example` exists with placeholder IDs (e.g. `YOUR_CHAT_ID`), generic agent names, generic workspace paths
- [ ] `crons.yaml.example` exists with 1-2 example cron entries using placeholder values
- [ ] `config.yaml` added to `.gitignore` and untracked with `git rm --cached config.yaml` (file stays locally)
- [ ] `crons.yaml` added to `.gitignore` and untracked with `git rm --cached crons.yaml` (file stays locally)
- [ ] `SOAK-TEST.md` removed or redacted (contains personal deployment logs with real chat IDs)
- [ ] No personal Telegram IDs, Discord guild IDs, or real names in any tracked file
- [ ] README.md line with `/Users/ninja/` example path updated to generic

### Task 4: Package metadata and license (bot-ors, P2)

`package.json` has generic name "bot", empty description, empty author, ISC license. For a public GitHub release it needs proper metadata for discoverability.

**What we want:** Descriptive package name, clear description with keywords for search, proper author, MIT license (standard for open source bots).

- [ ] `name` field is descriptive (e.g. `openclaw-bot` or `claude-telegram-bot`)
- [ ] `description` includes key phrases: "multi-agent", "Telegram", "Claude Code", "Max subscription"
- [ ] `keywords` include: `telegram`, `discord`, `claude`, `anthropic`, `claude-code`, `multi-agent`, `bot`, `max-subscription`
- [ ] `author` field filled
- [ ] `license` field set to `MIT`
- [ ] `LICENSE` file created with MIT license text
- [ ] `repository` field points to GitHub URL (use placeholder if repo doesn't exist yet)
- [ ] Verify `npm test` still passes
