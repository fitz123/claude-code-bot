# Bot Operations

Reference for Telegram bot and cron system management.

## Bot Restart

1. Report intent and reason to Ninja
2. Wait for explicit confirmation
3. Restart via the canonical script (it validates config, sends SIGTERM, polls launchd teardown, returns the new PID):
   - Code or `config.yaml` / `config.local.yaml` changes: `bot/scripts/restart-bot.sh`
   - Plist-on-disk changes (`~/Library/LaunchAgents/ai.minime.telegram-bot.plist`): `bot/scripts/restart-bot.sh --plist`
   - Usage: `bot/scripts/restart-bot.sh -h`

Bot injects shutdown message into active sessions, waits up to 60s for turns to complete, then launchd auto-restarts (KeepAlive=true). The script polls until the old PID is gone and a new PID is running — do not conclude failure from `launchctl list` output mid-drain.

**Never use:**
- `launchctl kickstart -k` — sends SIGKILL, kills sessions mid-turn
- Raw `launchctl bootout` paired with immediate `bootstrap` — async teardown races bootstrap and can leave the service unregistered (2026-04-18 incident, 17 min outage). Use `--plist` mode instead.

**If the script fails** or auto-restart doesn't happen (>90s, no new PID), rerun `bot/scripts/restart-bot.sh --plist`. If that still fails, fall back to `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.telegram-bot.plist`. If that doesn't work — ask Ninja.

## Config Changes

- **Hot-reloaded (no restart):** Agent fields (`model`, `systemPrompt`, `thinking`, `workspaceCwd`) and session defaults (`idleTimeoutMs`, `maxConcurrentSessions`). Edit `config.yaml` or `config.local.yaml` — next new session picks it up.
- **Rejected migration fields:** `provider: claude`, `fallbackModel`, `defaultFallbackModel`, `effort`, `maxTurns`, and `allowedTools` fail validation. Use `thinking: off|minimal|low|medium|high|xhigh`; omit `provider` or set `provider: pi`.
- **Boot-level (restart required):** `telegramToken`, `discord.token`, `bindings`, `metricsPort`, `sessionDefaults.maxMessageAgeMs`, `sessionDefaults.requireMention`. Validate before restart: `npx tsx bot/src/config.ts --validate`
- `crons.yaml` (workspace root) — edit, then regenerate plists (see Cron System below)

## Cron System

Crons are defined in YAML, rendered to launchd plists, and executed as one-shot Pi print-mode runs or shell scripts.

### Execution chain

```
crons.yaml → generate-plists.ts → launchd plist → run-cron.sh → cron-runner.ts → pi -p --no-session --no-extensions → deliver.sh → Telegram
```

### Key files

| File | Purpose |
|---|---|
| `crons.yaml` | Cron definitions (schedule, prompt, agentId, deliveryChatId, timeout) |
| `bot/scripts/generate-plists.ts` | Renders crons.yaml → `~/Library/LaunchAgents/ai.minime.cron.*.plist` |
| `bot/scripts/run-cron.sh` | launchd entry point. Sets HOME/PATH, scrubs legacy runtime env, calls cron-runner.ts |
| `bot/src/cron-runner.ts` | Loads cron def, spawns Pi print mode for LLM crons or `/bin/bash` for script crons |
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
  prompt: >                       # Pi print-mode prompt
    Do the thing...
  agentId: main                   # Agent from config.yaml (workspace binding)
  deliveryChatId: 123456789       # Telegram chat ID for delivery
  timeout: 300000                 # Execution timeout ms (optional)
```

For LLM crons, `engine` must be omitted or `pi`; `engine: claude` fails validation. `CRON_PI_DISABLED=1` is unsupported. `PI_EXTENSIONS_DISABLED=1` fails LLM crons because the A1 guard extension is required.

### Environment handling

`run-cron.sh` and `cron-runner.ts` scrub inherited `CLAUDE_CODE_*`, `ANTHROPIC_*`, and `CLAUDECODE` values before cron execution. Pi auth comes from `~/.pi/agent/auth.json`.

### Logs

- Stdout/stderr: `~/.minime/logs/cron-<name>.{stdout,stderr}.log`
- Delivery: `~/.minime/logs/cron-delivery.log`
- Run history: `~/.minime/cron/runs/*.jsonl`
