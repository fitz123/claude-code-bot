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
│  - LRU eviction (max 6)  │
│  - 4 hour idle timeout   │
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

**Message queue** sits between grammY and Session Manager. Rapid messages are debounced (3s window) into a single prompt. Messages arriving while Claude is processing are collected (up to 20) and delivered as a combined followup after the current turn completes.

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
       effort: high   # Claude reasoning effort: low, medium, high (omit for default)
   ```

2. Add the binding:
   ```yaml
   bindings:
     - chatId: 123456789
       agentId: new-agent
       kind: dm          # or "group"
       label: New Agent DM

     # For forum supergroups, bind specific topics to agents:
     - chatId: -1001234567890
       agentId: general
       kind: group
       label: Forum General     # fallback for unbound topics

     - chatId: -1001234567890
       topicId: 42               # message_thread_id from Telegram
       agentId: dev-agent
       kind: group
       label: Forum Dev Topic   # this topic gets its own agent + session

     # Inline per-topic overrides (alternative to separate bindings):
     - chatId: -1001234567890
       agentId: main
       kind: group
       label: HQ Forum
       requireMention: true          # require @mention or reply-to-bot (default for groups)
       voiceTranscriptEcho: false    # suppress voice transcript echo reply
       topics:
         - topicId: 42
           agentId: dev-agent        # override agent for this topic
           requireMention: false     # respond to all messages in this topic
         - topicId: 99
           requireMention: false     # inherits agentId from parent binding
   ```

   For forum supergroups, add `topicId` to bind a specific topic thread to its own agent. Each topic with a binding gets an isolated Claude session. Messages in unbound topics fall back to the chatId-only binding if one exists. Alternatively, use inline `topics` on a single binding to override `agentId` and `requireMention` per topic.

   Additional binding options:
   - `requireMention` (boolean): Whether the bot requires an @mention or reply-to-bot to respond in groups. Defaults to `true` for groups. Can be overridden per topic.
   - `voiceTranscriptEcho` (boolean): Whether to echo the voice transcript back to the chat. Defaults to `true`. Set `false` to suppress.
   - `topics` (array): Per-topic overrides within a forum supergroup. Each entry has a required `topicId` and optional `agentId` and `requireMention` that override the parent binding's values.

3. Validate and restart:
   ```bash
   cd ~/.openclaw/bot && npx tsx src/config.ts --validate
   # Then ask Ninja to confirm restart
   launchctl kickstart -k gui/$(id -u)/ai.openclaw.telegram-bot
   ```

## Supported Message Types

| Type | Handling |
|------|----------|
| Text | Sent directly to Claude session |
| Voice | Transcribed locally via whisper-cli, transcript echoed back and sent to Claude |
| Photo | Downloaded to temp file, file path appended to caption and sent to Claude for vision analysis |
| Image document | Same as photo (supports image/jpeg, image/png, image/gif, image/webp, image/bmp) |
| File output | Files created by Claude via Write tool are sent back: images as photos, others as documents. Only files within the agent's `workspaceCwd` or `/tmp` are sent. |

In group chats, the bot only responds to messages that @mention the bot or reply to the bot (configurable via `requireMention` in bindings). Every message sent to Claude is prefixed with source context (e.g. `[Chat: HQ Forum | From: John (@johndoe)]`) using the binding's `label` and the sender's Telegram profile.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show bot info and bound agent |
| `/reset` | Close current session and clear message queue; next message starts fresh |
| `/status` | Show active sessions, memory, uptime, and subprocess health (PID, alive/dead, processing duration, last success, restart count) |

Commands are auto-registered with the Telegram Bot API via `setMyCommands` on startup. To add or change commands, update the `BOT_COMMANDS` array in `telegram-bot.ts`.

## Configuration

### Logging

All log output uses structured format: `TIMESTAMP LEVEL [tag] message`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `logLevel` (config.yaml) | string | `"info"` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `LOG_LEVEL` (env var) | string | — | Overrides `logLevel` from config when set |

### Monitoring

When `metricsPort` is set in `config.yaml`, the bot exposes a Prometheus-compatible `/metrics` endpoint on `127.0.0.1` at that port.

```yaml
metricsPort: 9090
```

Available metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `bot_claude_tokens_input_total` | counter | Input tokens consumed (by agent) |
| `bot_claude_tokens_output_total` | counter | Output tokens consumed (by agent) |
| `bot_claude_tokens_cache_read_total` | counter | Cache read tokens (by agent) |
| `bot_claude_tokens_cache_creation_total` | counter | Cache creation tokens (by agent) |
| `bot_claude_cost_usd_total` | counter | USD cost from Claude API (by agent) |
| `bot_claude_turn_duration_seconds` | histogram | Turn duration (by agent) |
| `bot_telegram_api_errors_total` | counter | Telegram API errors (by method, error_code) |
| `bot_sessions_active` | gauge | Currently active sessions |
| `bot_session_crashes_total` | counter | Session subprocess crashes |
| `bot_telegram_messages_received_total` | counter | Messages received (by type) |
| `bot_telegram_messages_sent_total` | counter | Messages sent by the bot |

## Troubleshooting

### Log locations

| Log | Path |
|-----|------|
| Bot stdout | `~/.openclaw/logs/telegram-bot-stdout.log` |
| Bot stderr | `~/.openclaw/logs/telegram-bot-stderr.log` |
| Session stderr (per-chat/topic) | `~/.openclaw/logs/session-<chatId>[_<topicId>].log` |
| Cron (per-task) | `~/.openclaw/logs/cron-<name>.log` |
| Message delivery | `~/.openclaw/logs/cron-delivery.log` |

### Voice transcription requirements

Voice transcription requires:
- `ffmpeg` installed at `/opt/homebrew/bin/ffmpeg` (converts Opus-in-OGG to WAV)
- `whisper-cli` installed at `/opt/homebrew/bin/whisper-cli`
- Whisper model at `/opt/homebrew/share/whisper-cpp/ggml-medium.bin`

### Common issues

**CLAUDECODE env var prevents nested sessions**
Claude Code sets `CLAUDECODE` in its environment. If a subprocess inherits it, spawning another `claude` CLI fails silently. Both `start-bot.sh` and `run-cron.sh` explicitly `unset CLAUDECODE`. If you see sessions failing to spawn, check that this env var is not leaking through.

**Keychain access denied**
The bot reads the Telegram token via `security find-generic-password -s 'telegram-bot-token' -w`. If this fails, macOS may be prompting for Keychain access in a non-interactive context. Fix: unlock Keychain before starting, or grant "Always Allow" to `security` for this item.

**Session stuck / not responding**
Sessions have a 4-hour idle timeout and max 6 concurrent (LRU eviction). If a session is stuck:
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
Only 6 warm sessions at a time (`sessionDefaults.maxConcurrentSessions`). LRU session gets evicted. If an important session keeps getting killed, consider increasing the limit in `config.yaml` or reducing idle timeout.

## Scripts

All in `scripts/`.

| Script | Purpose |
|--------|---------|
| `start-bot.sh` | Entry point for launchd. Sets up env (PATH, HOME, unset CLAUDECODE, Claude Code flags), runs `main.ts`. |
| `run-cron.sh` | Entry point for cron plists. Same env setup, runs `cron-runner.ts --task <name>`. |
| `deliver.sh` | Send a Telegram message. Reads token from Keychain, handles >4096 char splitting at paragraph boundaries, retries without Markdown on parse failure. Usage: `deliver.sh <chat_id> "text"` or pipe. |
| `generate-plists.ts` | Reads `crons.yaml`, generates launchd plist XML files in `~/Library/LaunchAgents/`. Supports `--dry-run`. Converts cron schedule syntax to `StartCalendarInterval`. |
| `decommission.sh` | One-time script to stop and disable the old OpenClaw gateway service. Moves its plist to `.disabled`. Reversible. |
