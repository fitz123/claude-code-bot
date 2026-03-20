# Minime

Multi-platform bot (Telegram + Discord) that routes messages to Claude Code CLI subprocesses. Each chat/channel gets its own persistent Claude Code session. Runs on Max subscription (no API keys).

<p align="center">
  <img src="assets/screenshot-voice-youtube.jpg" width="300" alt="Voice message with YouTube recommendations and sidebar showing multiple topic sessions">
  <img src="assets/screenshot-security-audit.jpg" width="300" alt="Security audit with 7 parallel review agents launched from voice command">
</p>

## Architecture

```
Telegram Cloud          Discord Gateway
    │                        │
    ▼ (long polling)         ▼ (websocket)
┌────────────────┐    ┌────────────────┐
│  grammY Bot    │    │  Discord.js    │
│  telegram-bot  │    │  discord-bot   │
└───────┬────────┘    └───────┬────────┘
        │                     │
        ▼                     ▼
   ┌─────────────────────────────────┐
   │  Platform Context (interface)   │
   │  - sendMessage, editMessage     │
   │  - sendTyping, sendFile         │
   │  - per-binding streaming flags  │
   └───────────────┬─────────────────┘
                   │
                   ▼
         ┌──────────────────┐
         │  Message Queue   │
         │  - 3s debounce   │
         │  - mid-turn      │
         │    collect (20)  │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │  Session Manager │
         │  - 1 per chat    │
         │  - LRU eviction  │
         │  - idle timeout  │
         │  - resume on     │
         │    respawn       │
         └────────┬─────────┘
                  │ spawns claude -p (stream-json)
                  ▼
         ┌──────────────────┐
         │  Claude Code CLI │
         │  - per-agent     │
         │    workspace     │
         │  - model from    │
         │    config        │
         └────────┬─────────┘
                  │
                  ▼
            Anthropic API
```

Both platforms share one Session Manager and use the same stream-relay logic via the `PlatformContext` interface. Each platform provides an adapter that handles platform-specific message I/O (Telegram: grammY Context, Discord: discord.js Channel).

**Message queue** sits between platform bots and Session Manager. Rapid messages are debounced (3s window) into a single prompt. Messages arriving while Claude is processing are collected (up to 20) and delivered as a combined followup after the current turn completes.

**Cron jobs** run separately via launchd plists. Each plist calls `run-cron.sh <task-name>`, which invokes `cron-runner.ts` to spawn a one-shot `claude -p` session with the cron's prompt.

**Config:** `config.yaml` (at workspace root, alongside `bot/`) defines agents (workspace + model) and bindings (chatId/channelId -> agentId). At least one platform (Telegram or Discord) must be configured. Tokens are read from macOS Keychain at runtime.

## Installation

### Prerequisites

- macOS (launchd required for bot service management)
- Node.js 20+ and npm
- `jq` — required by hook scripts (`brew install jq`)
- [Claude Code CLI](https://claude.ai/code) — must be authenticated via `claude auth login` before starting the bot
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (or a Discord bot token if using Discord)

### Steps

**1. Clone and install dependencies**

```bash
git clone https://github.com/your-org/minime.git ~/.minime
cd ~/.minime/bot && npm install
```

**2. Copy and fill in config.yaml**

```bash
cp config.yaml.example config.yaml
```

Edit `config.yaml`:
- Set `workspaceCwd` to the absolute path of your cloned repo (e.g. `/Users/yourname/.minime`)
- Set `chatId` in the `bindings` section to your Telegram user ID (send `/start` to @userinfobot to find it)

**3. Copy crons.yaml**

```bash
cp crons.yaml.example crons.yaml
```

Edit or leave as-is. To start with no crons: replace the contents with `crons: []`.

**4. Copy settings.local.json and set autoMemoryDirectory**

```bash
cp .claude/settings.local.json.example .claude/settings.local.json
```

Edit `.claude/settings.local.json` and set `autoMemoryDirectory` to `<absolute-path-to-repo>/memory/auto` (e.g. `/Users/yourname/.minime/memory/auto`). Without this, Claude Code's auto-memory writes to its default location instead of the workspace.

**5. Store Telegram bot token in macOS Keychain**

```bash
security add-generic-password -s 'telegram-bot-token' -a 'minime' -w 'YOUR_TOKEN_HERE'
```

The service name `telegram-bot-token` must match `telegramTokenService` in `config.yaml`.

**6. Authenticate Claude Code**

```bash
claude auth login
```

This stores your Claude Code OAuth token in Keychain automatically. The bot's startup script reads it from there.

**7. Create the log directory**

```bash
mkdir -p ~/.minime/logs
```

**8. Create the launchd plist**

```bash
cp bot/telegram-bot.plist.example ~/Library/LaunchAgents/ai.minime.telegram-bot.plist
```

Edit `~/Library/LaunchAgents/ai.minime.telegram-bot.plist` and replace:
- `WORKSPACE` — absolute path to the repo (e.g. `/Users/yourname/.minime`)
- `LOG_DIR` — log directory (e.g. `/Users/yourname/.minime/logs`)
- `USER_HOME` — your home directory (e.g. `/Users/yourname`)

**9. Validate config**

```bash
cd ~/.minime && npx tsx bot/src/config.ts --validate
```

**10. Start the bot**

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.telegram-bot.plist
```

**11. Verify**

```bash
# Check service is running
launchctl list | grep ai.minime.telegram-bot

# Tail logs
tail -f ~/.minime/logs/telegram-bot.stdout.log
```

Send a message to your bot in Telegram to confirm it responds.

### Discord (optional)

Store Discord bot token in Keychain:
```bash
security add-generic-password -s 'discord-bot-token' -a 'minime' -w 'YOUR_TOKEN_HERE'
```

Add a `discord` section to `config.yaml` — see [Add a Discord Binding](#add-a-discord-binding) below.

### Crons (optional)

Edit `crons.yaml`, then generate and load plists:
```bash
cd ~/.minime/bot && npx tsx scripts/generate-plists.ts
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.cron.<name>.plist
```

See [Add a Cron](#add-a-cron) below for details.

### Optional: activate rules

Copy optional rules into the custom rules directory to activate them:
```bash
cp .claude/optional-rules/memory-protocol.md .claude/rules/custom/
```

### Optional: initialize ADR governance

```bash
mkdir -p reference/governance
cp reference/governance/decisions.md.example reference/governance/decisions.md
```

## Start / Stop

The bot runs as a launchd service: `ai.minime.telegram-bot`.

```bash
# Check status
launchctl print gui/$(id -u)/ai.minime.telegram-bot 2>&1 | head -5

# Restart (graceful — waits for active sessions to finish)
launchctl kill SIGTERM gui/$(id -u)/ai.minime.telegram-bot

# Stop
launchctl bootout gui/$(id -u)/ai.minime.telegram-bot

# Start (if stopped)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.telegram-bot.plist
```

**Warning:** Restarting kills all active Claude Code sessions (both Telegram and Discord), drops in-flight messages, and interrupts running sub-agents. Always confirm before restarting.

## Add a Cron

1. Edit `crons.yaml` — add a new entry:
   ```yaml
   # LLM cron (default) — runs claude -p with the given prompt
   - name: my-task
     schedule: "30 9 * * *"       # cron syntax, local timezone
     prompt: >
       Do the thing.
     agentId: main                # must match an agent in config.yaml
     deliveryChatId: YOUR_CHAT_ID  # where to send results (optional if defaultDeliveryChatId set)
     timeout: 300000              # ms, optional

   # Script cron — runs a shell command directly (no LLM)
   - name: backup-db
     schedule: "0 2 * * *"
     type: script                 # "script" or "llm" (default)
     command: "/usr/bin/backup.sh --full"  # shell command to execute
     agentId: main
     deliveryChatId: YOUR_CHAT_ID
     timeout: 300000              # ms, optional
   ```

   Script-mode crons execute the command via `/bin/bash`, capture stdout, and deliver it the same way as LLM crons. They skip all Claude-specific setup (model, workspace, env vars). Empty output skips delivery.

   **Cron field reference:**

   | Field | Type | Default | Description |
   |-------|------|---------|-------------|
   | `name` | string | (required) | Unique identifier for the cron job |
   | `schedule` | string | (required) | Cron expression (5-field), local timezone |
   | `type` | `"llm"` or `"script"` | `"llm"` | LLM crons run `claude -p` with `prompt`; script crons run a shell `command` |
   | `prompt` | string | — | Prompt text sent to Claude (required for `type: llm`) |
   | `command` | string | — | Shell command to execute (required for `type: script`) |
   | `agentId` | string | (required) | Must match an agent in `config.yaml` (determines workspace) |
   | `deliveryChatId` | number | from config default | Telegram chat ID for result delivery |
   | `deliveryThreadId` | number | from config default | Telegram forum topic ID for delivery |
   | `timeout` | number | `300000` | Per-cron timeout in milliseconds (5 min default) |
   | `enabled` | boolean | `true` | Set `false` to skip plist generation for this cron |

2. Generate launchd plists:
   ```bash
   cd ~/.minime/bot && npx tsx scripts/generate-plists.ts
   ```

3. Load the new plist:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.cron.my-task.plist
   ```

4. Test it:
   ```bash
   launchctl start ai.minime.cron.my-task
   tail -f ~/.minime/logs/cron-my-task.log
   ```

To remove a cron: `launchctl bootout gui/$(id -u)/ai.minime.cron.<name>`, delete the entry from `crons.yaml`, regenerate.

**Default delivery target:** Set `defaultDeliveryChatId` and optionally `defaultDeliveryThreadId` (top-level in `config.yaml`) to provide a default delivery target for all crons. Individual crons can still override with their own `deliveryChatId` / `deliveryThreadId`. If a cron omits `deliveryChatId` and no config default is set, an error is thrown.

```yaml
defaultDeliveryChatId: -1001234567890  # optional; default delivery target for all crons
defaultDeliveryThreadId: 42            # optional; default thread for cron delivery
```

**Admin notifications:** Set `adminChatId` (top-level in `config.yaml`) to receive a fallback Telegram notification when cron delivery to `deliveryChatId` fails (e.g. bot blocked, chat deleted). Must be a non-zero integer (use a negative ID for groups/supergroups). If not set, failures are logged locally only.

```yaml
adminChatId: 123456789  # optional; receive cron delivery failure alerts here
```

## Add a Binding

1. If needed, add a new agent to `config.yaml`:
   ```yaml
   agents:
     new-agent:
       id: new-agent
       workspaceCwd: /Users/YOU/.minime/workspace-new
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
   - `streamingUpdates` (boolean): Whether to send progressive streaming edits during response generation. Defaults to `true`. Set `false` to send only the final complete message (reduces API rate limit usage).
   - `typingIndicator` (boolean): Whether to send typing indicators while processing. Defaults to `true`. Set `false` to suppress.
   - `topics` (array): Per-topic overrides within a forum supergroup. Each entry has a required `topicId` and optional `agentId` and `requireMention` that override the parent binding's values.

3. Validate and restart:
   ```bash
   cd ~/.minime/bot && npx tsx src/config.ts --validate
   # Then confirm and restart (graceful — launchd auto-restarts via KeepAlive)
   launchctl kill SIGTERM gui/$(id -u)/ai.minime.telegram-bot
   ```

## Add a Discord Binding

1. Store the Discord bot token in macOS Keychain:
   ```bash
   security add-generic-password -s 'discord-bot-token' -a 'minime' -w 'YOUR_TOKEN_HERE'
   ```

2. Add the `discord` section to `config.yaml`:
   ```yaml
   discord:
     tokenService: discord-bot-token
     bindings:
       # Guild-wide default: covers all channels in the server
       - guildId: "9876543210"
         agentId: main
         kind: channel
         label: My Server
         requireMention: true
         streamingUpdates: true
         typingIndicator: true
         channels:                         # per-channel overrides (optional)
           - channelId: "1234567890"
             label: Dev Channel
             requireMention: false         # no @mention needed here
           - channelId: "1111111111"
             agentId: coder                # different agent for this channel

       # Per-channel binding (still works — exact channelId match wins)
       - channelId: "5555555555"
         guildId: "9876543210"
         agentId: main
         kind: channel
         label: Legacy Channel
   ```

   A binding with `guildId` but no `channelId` acts as a guild-wide default — any channel in that guild uses it. Per-channel overrides via the `channels` array can override `agentId`, `label`, `requireMention`, `streamingUpdates`, and `typingIndicator`. Resolution priority: exact `channelId` binding > per-channel override from `channels` > guild-wide fallback.

3. Discord threads automatically inherit the parent channel's binding and get independent sessions (keyed as `discord:channelId:threadId`).

4. Required Discord bot permissions/intents: Guilds, GuildMessages, MessageContent (privileged — must enable in Discord Developer Portal), DirectMessages.

5. Discord slash commands (`/start`, `/reset`, `/status`) are registered per-guild on startup (instant propagation).

`telegramTokenService` is optional — the bot can run Discord-only without any Telegram configuration.

## Supported Message Types

| Type | Handling |
|------|----------|
| Text | Sent directly to Claude session |
| Voice | Transcribed locally via whisper-cli, transcript echoed back and sent to Claude |
| Photo | Downloaded to temp file, file path appended to caption and sent to Claude for vision analysis |
| Image document | Same as photo (supports image/jpeg, image/png, image/gif, image/webp, image/bmp) |
| Non-image document | Downloaded to temp file (max 20 MB). Metadata header (filename, MIME type, size) and file path sent to Claude. Supports PDF, TXT, CSV, JSON, XML, HTML, ZIP, GZ, and others. |
| Reaction | Emoji reactions on bot messages are forwarded to Claude as context (e.g. `[Reaction: 👍 on message 123]`). Reaction removals are also forwarded. In forum supergroups, reactions are routed to the correct topic session via an in-memory message-thread cache (cache miss degrades gracefully to chat-level routing). All reaction events are logged to `~/.minime/logs/reactions.jsonl`. Bot must be admin in groups to receive reaction events. |
| File output | Claude is told about a per-session outbox directory via system prompt. Files written or copied there are sent to the user after the response completes: images as photos, others as documents. The outbox is cleaned up after delivery. |

The bot subscribes to `message` and `message_reaction` update types only.

In group chats, the bot only responds to messages that @mention the bot or reply to the bot (configurable via `requireMention` in bindings). Every message sent to Claude is prefixed with source context (e.g. `[Chat: HQ Forum | Topic: 591 | From: John (@johndoe)]` for forum topics, or `[Chat: HQ Forum | From: John (@johndoe)]` without topic) using the binding's `label` and the sender's Telegram profile.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show bot info and bound agent |
| `/reset` | Close current session and clear message queue; prior context may be partially retained |
| `/status` | Show active sessions, memory, uptime, and subprocess health (PID, alive/dead, processing duration, last success, restart count) |

On Telegram, commands are auto-registered via `setMyCommands` on startup. On Discord, the same commands are available as slash commands, registered per-guild on startup (instant propagation).

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
| Bot stdout | `~/.minime/logs/telegram-bot.stdout.log` |
| Bot stderr | `~/.minime/logs/telegram-bot.stderr.log` |
| Session stderr (per-chat/topic) | `~/.minime/logs/session-<chatId>[_<topicId>].log` |
| Cron (per-task) | `~/.minime/logs/cron-<name>.log` |
| Message delivery | `~/.minime/logs/cron-delivery.log` |
| Reaction events (JSONL) | `~/.minime/logs/reactions.jsonl` |

### Voice transcription requirements

Voice transcription requires:
- `ffmpeg` (converts Opus-in-OGG to WAV)
- `whisper-cli` (whisper.cpp CLI)
- Whisper model file (e.g. `ggml-medium.bin`)

Default paths assume Homebrew on Apple Silicon. Override with env vars: `FFMPEG_BIN`, `WHISPER_BIN`, `WHISPER_MODEL`, `WHISPER_LANGUAGE` (default: `auto`).

### Common issues

**CLAUDECODE env var prevents nested sessions**
Claude Code sets `CLAUDECODE` in its environment. If a subprocess inherits it, spawning another `claude` CLI fails silently. Both `start-bot.sh` and `run-cron.sh` explicitly `unset CLAUDECODE`. If you see sessions failing to spawn, check that this env var is not leaking through.

**Keychain access denied**
The bot reads platform tokens from macOS Keychain via `security find-generic-password -s '<service>' -w` (e.g., `telegram-bot-token` or `discord-bot-token`). If this fails, macOS may be prompting for Keychain access in a non-interactive context. Fix: unlock Keychain before starting, or grant "Always Allow" to `security` for this item.

**Messages sent during downtime are discarded**
After a restart, messages older than 10 minutes (configurable via `sessionDefaults.maxMessageAgeMs` in `config.yaml`) are silently dropped. This prevents stale message floods from triggering unnecessary session spawns. If you sent a message during downtime, resend it after the bot comes back.

**Session blocked after repeated crashes**
If a session crashes 5 times in a row, it is circuit-broken — the bot refuses to spawn new sessions for that chat. Send `/reset` to clear the crash counter and unblock. Crash backoff starts at 5s and doubles on each crash (capped at 60s) before the circuit fully opens.

**Session stuck / not responding**
Sessions have a 1-hour idle timeout and max 12 concurrent (LRU eviction). If a session is stuck:
- Check per-session stderr logs for subprocess crash details: `~/.minime/logs/session-<chatId>.log`
- Check bot stderr log for bot-level errors
- The session store persists across restarts: `~/.minime/data/sessions.json`
- Restarting the bot cleanly closes all sessions (graceful SIGTERM)

**Cron not firing**
- Verify plist is loaded: `launchctl list | grep ai.minime.cron.my-task`
- Check schedule: plists use `StartCalendarInterval`, not cron syntax directly. Regenerate if in doubt.
- Check cron log for errors: `tail ~/.minime/logs/cron-my-task.log`

**maxTurns limit**
Limits how many agentic loops (tool call chains) Claude can do per single user message. Safety net against runaway agents burning rate limit quota. Set to 250 by default. Remove from config for unlimited. If hit mid-work, Claude stops and the subprocess exits — next message spawns a fresh session via --resume.
**Max concurrent sessions reached**
Only 12 warm sessions at a time (`sessionDefaults.maxConcurrentSessions`). LRU session gets evicted. If an important session keeps getting killed, consider increasing the limit in `config.yaml` or reducing idle timeout.

## Scripts

All in `bot/scripts/`.

| Script | Purpose |
|--------|---------|
| `start-bot.sh` | Entry point for launchd. Sets up env (PATH, HOME, unset CLAUDECODE, Claude Code flags), runs `main.ts`. |
| `run-cron.sh` | Entry point for cron plists. Same env setup, runs `cron-runner.ts --task <name>`. |
| `deliver.sh` | Send a Telegram message. Reads token from Keychain, handles >4096 char splitting at paragraph boundaries, retries without Markdown on parse failure. Usage: `deliver.sh <chat_id> "text"` or pipe. |
| `generate-plists.ts` | Reads `crons.yaml`, generates launchd plist XML files in `~/Library/LaunchAgents/`. Supports `--dry-run`. Converts cron schedule syntax to `StartCalendarInterval`. |

## Similar Projects

### Why this exists

Most Telegram bots for Claude use the [Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), which requires API keys and falls under Anthropic's Commercial Terms. Anthropic [explicitly prohibits](https://code.claude.com/docs/en/legal-and-compliance) using Max/Pro subscription OAuth tokens through the Agent SDK:

> OAuth authentication (used with Free, Pro, and Max plans) is intended exclusively for Claude Code and Claude.ai. Using OAuth tokens in any other product, tool, or service -- including the Agent SDK -- is not permitted.

This bot spawns the original `claude -p` binary directly. Same CLI you run in your terminal. Max subscription, no API keys, no per-token billing.

### ToS compliance on Max subscription

| Project | Engine | Max-compliant |
|---------|--------|---------------|
| **claude-code-bot** (this) | CLI binary (`claude -p`) | Yes |
| [PleasePrompto/ductor](https://github.com/PleasePrompto/ductor) | CLI binary (subprocess) | Yes |
| [Anthropic Official Plugin](https://github.com/anthropics/claude-plugins-official) | MCP extension of active CC session | Yes |
| [RichardAtCT/claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) | Agent SDK (`claude_agent_sdk`) | No |
| [earlyaidopters/claudeclaw](https://github.com/earlyaidopters/claudeclaw) | Agent SDK (`@anthropic-ai/claude-agent-sdk`) | No |
| [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) | Agent SDK (`@anthropic-ai/claude-agent-sdk`) | No |
| [NachoSEO/claudegram](https://github.com/NachoSEO/claudegram) | Agent SDK (`@anthropic-ai/claude-agent-sdk`) | No |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | Own agent runtime | No (API keys) |
| [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) | Claude Code in Docker | No (API keys) |
| [mtzanidakis/praktor](https://github.com/mtzanidakis/praktor) | Agent SDK in Docker | No (API keys) |
| [chenhg5/cc-connect](https://github.com/chenhg5/cc-connect) | Bridge/proxy | Depends on agent |

Three projects run the actual CLI binary on a Max subscription without API keys: this bot, ductor, and the official plugin.

### vs Anthropic Official Plugin

The [official plugin](https://github.com/anthropics/claude-plugins-official) is an MCP server that adds Telegram tools to an already-running Claude Code session.

- Not a standalone bot. Requires an active Claude Code session on your computer. Close the lid and it stops
- No cron or scheduled tasks. No autonomous work while you're away
- Single session. No parallel workspaces, no multi-agent
- Supports group chats but not forum topic routing
- No workspace health management or memory consolidation

It's a remote control for your terminal session, not an autonomous bot.

### vs Ductor

[Ductor](https://github.com/PleasePrompto/ductor) is the closest alternative. Also spawns the CLI binary, also ToS-compliant, also supports forum topics.

| | **claude-code-bot** | **ductor** |
|---|---|---|
| Language | TypeScript (grammy) | Python (aiogram) |
| Forum topic sessions | Yes | Yes |
| Multi-agent with isolated workspaces | Yes | Yes |
| Cron system | launchd plists (per-cron process isolation) | In-process cron |
| Workspace health | Filesystem guardian hooks + structural audits | Agent-level health (crash recovery, backoff) |
| Memory consolidation | Nightly summarization cron | File sync (no summarization) |
| Platforms | Telegram + Discord | Telegram + Matrix |
| Multi-CLI support | Claude Code | Claude Code, Codex, Gemini |

Ductor covers more CLIs (Claude, Codex, Gemini). We go deeper on one: filesystem-level workspace protection that prevents degradation rather than recovering from it, nightly memory consolidation that summarizes rather than copies, and per-cron process isolation via launchd.

