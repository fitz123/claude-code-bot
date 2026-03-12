# OpenClaw Telegram Bot

grammY-based Telegram bot that routes messages to Claude Code CLI subprocesses. Each Telegram chat gets its own persistent Claude Code session. Runs on Max subscription (no API keys).

## Architecture

```
Telegram Cloud
    │
    ▼ (long polling)
┌──────────────────────────┐
│  grammY Bot (main.ts)    │
│  - loads config.yaml     │
│  - routes by chatId      │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Session Manager         │
│  - 1 session per chatId  │
│  - LRU eviction (max 3)  │
│  - 15 min idle timeout   │
│  - resume on respawn     │
└──────────┬───────────────┘
           │ spawns claude -p (stream-json)
           ▼
┌──────────────────────────┐
│  Claude Code CLI         │
│  - per-agent workspace   │
│  - model from config     │
│  - Max subscription auth │
└──────────┬───────────────┘
           │
           ▼
      Anthropic API
```

**Cron jobs** run separately via launchd plists. Each plist calls `run-cron.sh <task-name>`, which invokes `cron-runner.ts` to spawn a one-shot `claude -p` session with the cron's prompt.

**Config:** `config.yaml` defines agents (workspace + model) and bindings (chatId -> agentId). Telegram token is read from macOS Keychain at runtime.

## Start / Stop

The bot runs as a launchd service: `ai.openclaw.telegram-bot`.

```bash
# Check status
launchctl print gui/$(id -u)/ai.openclaw.telegram-bot 2>&1 | head -5

# Restart (kills all active Claude sessions!)
launchctl kickstart -k gui/$(id -u)/ai.openclaw.telegram-bot

# Stop
launchctl bootout gui/$(id -u)/ai.openclaw.telegram-bot

# Start (if stopped)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.telegram-bot.plist
```

**Warning:** Restarting kills all active Claude Code sessions, drops in-flight messages, and interrupts running sub-agents. Always confirm with Ninja first.

## Add a Cron

1. Edit `crons.yaml` — add a new entry:
   ```yaml
   - name: my-task
     schedule: "30 9 * * *"       # cron syntax, Europe/Moscow
     prompt: >
       Do the thing.
     agentId: main                # must match an agent in config.yaml
     deliveryChatId: <redacted-user-id>    # where to send results
     timeout: 300000              # ms, optional
     maxBudget: 0.50              # USD, optional
   ```

2. Generate launchd plists:
   ```bash
   cd ~/.openclaw/bot && npx tsx scripts/generate-plists.ts
   ```

3. Load the new plist:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.cron.my-task.plist
   ```

4. Test it:
   ```bash
   launchctl start ai.openclaw.cron.my-task
   tail -f ~/.openclaw/logs/cron-my-task.log
   ```

To remove a cron: `launchctl bootout gui/$(id -u)/ai.openclaw.cron.<name>`, delete the entry from `crons.yaml`, regenerate.

## Add a Binding

1. If needed, add a new agent to `config.yaml`:
   ```yaml
   agents:
     new-agent:
       id: new-agent
       workspaceCwd: /Users/user/.openclaw/workspace-new
       model: claude-opus-4-6
       fallbackModel: claude-sonnet-4-6
       maxTurns: 250  # max agentic loops per message (omit for unlimited)
   ```

2. Add the binding:
   ```yaml
   bindings:
     - chatId: 123456789
       agentId: new-agent
       kind: dm          # or "group"
       label: New Agent DM
   ```

3. Validate and restart:
   ```bash
   cd ~/.openclaw/bot && npx tsx src/config.ts --validate
   # Then ask Ninja to confirm restart
   launchctl kickstart -k gui/$(id -u)/ai.openclaw.telegram-bot
   ```

## Troubleshooting

### Log locations

| Log | Path |
|-----|------|
| Bot stdout | `~/.openclaw/logs/telegram-bot-stdout.log` |
| Bot stderr | `~/.openclaw/logs/telegram-bot-stderr.log` |
| Session stderr (per-chat) | `~/.openclaw/logs/session-<chatId>.log` |
| Cron (per-task) | `~/.openclaw/logs/cron-<name>.log` |
| Message delivery | `~/.openclaw/logs/cron-delivery.log` |

### Common issues

**CLAUDECODE env var prevents nested sessions**
Claude Code sets `CLAUDECODE` in its environment. If a subprocess inherits it, spawning another `claude` CLI fails silently. Both `start-bot.sh` and `run-cron.sh` explicitly `unset CLAUDECODE`. If you see sessions failing to spawn, check that this env var is not leaking through.

**Keychain access denied**
The bot reads the Telegram token via `security find-generic-password -s 'telegram-bot-token' -w`. If this fails, macOS may be prompting for Keychain access in a non-interactive context. Fix: unlock Keychain before starting, or grant "Always Allow" to `security` for this item.

**Session stuck / not responding**
Sessions have a 15-min idle timeout and max 3 concurrent (LRU eviction). If a session is stuck:
- Check per-session stderr logs for subprocess crash details: `~/.openclaw/logs/session-<chatId>.log`
- Check bot stderr log for bot-level errors
- The session store persists across restarts: `~/.openclaw/bot/data/sessions.json`
- Restarting the bot cleanly closes all sessions (graceful SIGTERM)

**Cron not firing**
- Verify plist is loaded: `launchctl list | grep ai.openclaw.cron.my-task`
- Check schedule: plists use `StartCalendarInterval`, not cron syntax directly. Regenerate if in doubt.
- Check cron log for errors: `tail ~/.openclaw/logs/cron-my-task.log`

**maxTurns limit**
Limits how many agentic loops (tool call chains) Claude can do per single user message. Safety net against runaway agents burning rate limit quota. Set to 250 by default. Remove from config for unlimited. If hit mid-work, Claude stops and the subprocess exits — next message spawns a fresh session via --resume.
**Max concurrent sessions reached**
Only 3 warm sessions at a time (`sessionDefaults.maxConcurrentSessions`). LRU session gets evicted. If an important session keeps getting killed, consider increasing the limit in `config.yaml` or reducing idle timeout.

## Scripts

All in `scripts/`.

| Script | Purpose |
|--------|---------|
| `start-bot.sh` | Entry point for launchd. Sets up env (PATH, HOME, unset CLAUDECODE, Claude Code flags), runs `main.ts`. |
| `run-cron.sh` | Entry point for cron plists. Same env setup, runs `cron-runner.ts --task <name>`. |
| `deliver.sh` | Send a Telegram message. Reads token from Keychain, handles >4096 char splitting at paragraph boundaries, retries without Markdown on parse failure. Usage: `deliver.sh <chat_id> "text"` or pipe. |
| `generate-plists.ts` | Reads `crons.yaml`, generates launchd plist XML files in `~/Library/LaunchAgents/`. Supports `--dry-run`. Converts cron schedule syntax to `StartCalendarInterval`. |
| `decommission.sh` | One-time script to stop and disable the old OpenClaw gateway service. Moves its plist to `.disabled`. Reversible. |
