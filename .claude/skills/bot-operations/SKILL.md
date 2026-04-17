# Bot Operations

Reference for Telegram bot and cron system management.

## Bot Restart

1. Validate config: `cd ~/.minime/workspace/bot && npx tsx src/config.ts --validate`
2. Report result and reason to Ninja
3. Wait for explicit confirmation
4. Graceful restart: `launchctl kill SIGTERM gui/$(id -u)/ai.minime.telegram-bot`
5. Wait for drain: check logs for `All sessions closed. Exiting.` (up to 60s)
6. Verify: `launchctl list | grep ai.minime.telegram-bot` — new PID, exit 0 (note: stale exit code during drain window is normal, wait for step 5 first)

Bot injects shutdown message into active sessions, waits up to 60s for turns to complete, then launchd auto-restarts (KeepAlive=true).

**Never use:**
- `launchctl kickstart -k` — sends SIGKILL, kills sessions mid-turn
- `launchctl bootout` after SIGTERM — removes service definition, prevents auto-restart

**If auto-restart fails** (>90s, no new PID): `launchctl load ~/Library/LaunchAgents/ai.minime.telegram-bot.plist`

## Config Changes

- **Hot-reloaded (no restart):** Agent fields (`model`, `fallbackModel`, `maxTurns`, `systemPrompt`, `effort`, `workspaceCwd`) and session defaults (`idleTimeoutMs`, `maxConcurrentSessions`). Edit `config.yaml` or `config.local.yaml` — next new session picks it up.
- **Boot-level (restart required):** `telegramToken`, `discord.token`, `bindings`, `metricsPort`, `sessionDefaults.maxMessageAgeMs`, `sessionDefaults.requireMention`. Validate before restart: `npx tsx bot/src/config.ts --validate`
- `crons.yaml` (workspace root) — edit, then regenerate plists (see Cron System below)

## Cron System

Crons are defined in YAML, rendered to launchd plists, executed as one-shot Claude CLI sessions.

### Execution chain

```
crons.yaml → generate-plists.ts → launchd plist → run-cron.sh → cron-runner.ts → claude -p → deliver.sh → Telegram
```

### Key files

| File | Purpose |
|---|---|
| `crons.yaml` | Cron definitions (schedule, prompt, agentId, deliveryChatId, timeout, maxBudget) |
| `bot/scripts/generate-plists.ts` | Renders crons.yaml → `~/Library/LaunchAgents/ai.minime.cron.*.plist` |
| `bot/scripts/run-cron.sh` | launchd entry point. Sets env, unsets CLAUDECODE, calls cron-runner.ts |
| `bot/src/cron-runner.ts` | Loads cron def, spawns `claude -p "<prompt>"` one-shot session |
| `bot/scripts/deliver.sh` | Sends result to Telegram (token from Keychain, splits >4096 chars) |

### Adding / updating a cron

1. Edit `crons.yaml` (workspace root)
2. Regenerate: `cd ~/.minime/workspace/bot && npx tsx scripts/generate-plists.ts`
3. Load new: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.cron.<name>.plist`
4. Test: `launchctl start ai.minime.cron.<name>`
5. Verify: `tail -f ~/.minime/logs/cron-<name>.log`

### crons.yaml entry format

```yaml
- name: example-cron
  schedule: "0 4 * * *"          # 5-field cron expression
  prompt: >                       # Claude Code -p prompt
    Do the thing...
  agentId: main                   # Agent from config.yaml (workspace binding)
  deliveryChatId: 123456789       # Telegram chat ID for delivery
  timeout: 300000                 # Execution timeout ms (optional)
  maxBudget: 0.50                 # Max USD per run (optional)
```

### Environment flags (set by run-cron.sh)

- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
- `CLAUDE_CODE_DISABLE_CRON=1`
- `CLAUDE_CODE_SIMPLE=1`
- `CLAUDECODE` unset (prevents nested CLI)

### Logs

- Stdout/stderr: `~/.minime/logs/cron-<name>.{stdout,stderr}.log`
- Delivery: `~/.minime/logs/cron-delivery.log`
- Run history: `~/.minime/cron/runs/*.jsonl`
