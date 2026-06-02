# Minime

Multi-platform bot (Telegram + Discord) that routes messages to Claude Code CLI subprocesses. Each chat/channel gets its own persistent Claude Code session. Runs on Max subscription (no API keys).

<p align="center">
  <img src="assets/demo-cron.gif" width="300" alt="Autonomous cron heartbeat: system status, calendar, GitHub PRs, prioritized tasks">
  <img src="assets/screenshot-voice-youtube.jpg" width="300" alt="Voice message with YouTube recommendations and sidebar showing multiple topic sessions">
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
   │  - sendDraft (DM streaming)     │
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

**Message queue** sits between platform bots and Session Manager. Rapid messages are debounced (3s window) into a single prompt. Messages arriving while a `claude` session is processing are collected (up to 20) and delivered as a combined followup after the current turn completes; a `pi` session instead has each mid-turn message steered into it live via the Pi RPC channel (see [Provider backends](#provider-backends)).

**Context injection:** Each message includes metadata — current time, chat type (DM/group/topic), topic name, sender username, and emoji reactions. The agent knows where it is, when it is, and who it's talking to. Reactions are delivered as messages so the agent can respond to a thumbs-up or a ❤️ without the user typing anything.

**Cron jobs** run separately via launchd plists. Each plist calls `run-cron.sh <task-name>`, which invokes `cron-runner.ts` to spawn a one-shot `claude -p` session with the cron's prompt.

**Config:** `config.yaml` defines agents (workspace + model) and bindings (chatId/channelId -> agentId). User-specific overrides live in `config.local.yaml` (gitignored, deep-merged over `config.yaml`). At least one platform (Telegram or Discord) must be configured. Tokens are read from macOS Keychain at runtime.

## Installation

### Prerequisites

- macOS (launchd required for bot service management)
- Node.js 20+ and npm
- `jq` — required by hook scripts (`brew install jq`)
- [Claude Code CLI](https://claude.ai/code) with Max subscription
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (or Discord bot token)

### Steps

**1. Clone and install**

```bash
git clone https://github.com/fitz123/claude-code-bot.git ~/.minime
cd ~/.minime/bot && npm install
```

**2. Configure for your environment**

`config.yaml` ships with working defaults. Create `config.local.yaml` for your overrides:

```bash
cp config.local.yaml.example config.local.yaml
```

Edit `config.local.yaml` — set `workspaceCwd` to the absolute path of your repo and `chatId` to your Telegram user ID (send `/start` to [@userinfobot](https://t.me/userinfobot) to find it).

`crons.yaml` ships with example crons (all disabled). Create `crons.local.yaml` for your own crons:

```bash
cp crons.local.yaml.example crons.local.yaml
```

Create `.claude/settings.local.json` with required settings:

```json
{
  "outputStyle": "Your output style name",
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "/absolute/path/to/your/workspace/memory/auto"
}
```

**3. Store Telegram bot token in macOS Keychain**

```bash
security add-generic-password -s 'telegram-bot-token' -a 'minime' -w 'YOUR_TOKEN_HERE'
```

**4. Store Claude Code OAuth token in Keychain**

```bash
claude setup-token
# Copy the token, then store it:
security add-generic-password -s 'claude-code-oauth-token' -a 'minime' -w 'YOUR_OAUTH_TOKEN'
```

The bot reads this token at startup via `start-bot.sh` and `run-cron.sh` — it does not use `claude auth login`.

**5. Create launchd service**

```bash
mkdir -p ~/.minime/logs
cp bot/telegram-bot.plist.example ~/Library/LaunchAgents/ai.minime.telegram-bot.plist
```

Edit the plist — replace `WORKSPACE`, `LOG_DIR`, and `USER_HOME` with your paths.

**6. Validate and start**

```bash
cd ~/.minime && npx tsx bot/src/config.ts --validate
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.telegram-bot.plist
```

**7. Verify**

```bash
launchctl list | grep ai.minime.telegram-bot
tail -f ~/.minime/logs/telegram-bot.stdout.log
```

Send a message to your bot in Telegram to confirm it responds.

### Optional setup

**Discord:** Store token in Keychain (`security add-generic-password -s 'discord-bot-token' -a 'minime' -w 'TOKEN'`), add a `discord` section to `config.local.yaml`. See [config.yaml](config.yaml) for full reference.

**Crons:** Add your crons to `crons.local.yaml` (copy from `crons.local.yaml.example`), then generate and load plists:
```bash
cd ~/.minime/bot && npx tsx scripts/generate-plists.ts
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.cron.<name>.plist
```

**Optional rules:** `cp .claude/optional-rules/memory-protocol.md .claude/rules/custom/`

**ADR governance:** `mkdir -p reference/governance && cp reference/governance/decisions.md.example reference/governance/decisions.md`

## Start / Stop

The bot runs as a launchd service: `ai.minime.telegram-bot`.

```bash
# Check status
launchctl print gui/$(id -u)/ai.minime.telegram-bot 2>&1 | head -5

# Restart (graceful — validates config, sends SIGTERM, waits for drain, returns new PID)
bot/scripts/restart-bot.sh

# Restart after editing ~/Library/LaunchAgents/ai.minime.telegram-bot.plist
bot/scripts/restart-bot.sh --plist

# Stop
launchctl bootout gui/$(id -u)/ai.minime.telegram-bot

# Start (if stopped)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.telegram-bot.plist
```

**Warning:** Graceful restart sends SIGTERM — the bot injects a shutdown message into active sessions and waits up to 60s for turns to complete before exiting. Idle sessions close immediately. launchd auto-restarts via KeepAlive. Still, active work is interrupted — always confirm before restarting. Use `--plist` after editing the plist on disk, because launchd caches the plist at bootstrap time and a plain SIGTERM restart would pick up the stale cache.

## Add a Cron

1. Edit `crons.local.yaml` — add a new entry:
   ```yaml
   - name: my-task
     schedule: "30 9 * * *"
     prompt: >
       Do the thing.
     agentId: main
     deliveryChatId: YOUR_CHAT_ID
   ```

   Cron field reference:

   | Field | Type | Required | Description |
   |-------|------|----------|-------------|
   | `name` | string | yes | Unique identifier for the cron job |
   | `schedule` | string | yes | 5-field cron expression, local timezone |
   | `type` | `"llm"` or `"script"` | no | `"llm"` (default) runs `claude -p`; `"script"` runs a shell command |
   | `prompt` | string | for llm | Prompt sent to Claude |
   | `command` | string | for script | Shell command to execute |
   | `agentId` | string | yes | Must match an agent in `config.yaml` or `config.local.yaml` |
   | `deliveryChatId` | number | no | Telegram chat ID for delivery (falls back to config default) |
   | `deliveryThreadId` | number | no | Telegram forum topic ID for delivery |
   | `timeout` | number | no | Per-cron timeout in ms (default: 300000 = 5 min) |
   | `enabled` | boolean | no | Set `false` to disable without deleting (default: `true`) |

2. Generate launchd plists:
   ```bash
   cd ~/.minime/bot && npx tsx scripts/generate-plists.ts
   ```

3. Load and test:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.minime.cron.my-task.plist
   launchctl start ai.minime.cron.my-task
   tail -f ~/.minime/logs/cron-my-task.log
   ```

To remove: `launchctl bootout gui/$(id -u)/ai.minime.cron.<name>`, delete from `crons.local.yaml`, regenerate.

## Add a Binding

1. Add an agent and binding to `config.local.yaml`:
   ```yaml
   agents:
     new-agent:
       id: new-agent
       workspaceCwd: /Users/YOU/.minime/workspace-new
       model: claude-opus-4-6

   bindings:
     - chatId: 123456789
       agentId: new-agent
       kind: dm
       label: New Agent DM
   ```

   See [config.yaml](config.yaml) for all binding options including `requireMention`, `voiceTranscriptEcho`, `typingIndicator`, and per-topic overrides for forum supergroups.

2. Restart (the script validates config before sending SIGTERM):
   ```bash
   bot/scripts/restart-bot.sh
   ```

## Add a Discord Binding

1. Store the Discord bot token in macOS Keychain:
   ```bash
   security add-generic-password -s 'discord-bot-token' -a 'minime' -w 'YOUR_TOKEN_HERE'
   ```

2. Add the `discord` section to `config.local.yaml`:
   ```yaml
   discord:
     tokenService: discord-bot-token
     bindings:
       - guildId: "9876543210"
         agentId: main
         kind: channel
         label: My Server
         requireMention: true
   ```

   See [config.yaml](config.yaml) for per-channel overrides and guild-wide defaults.

3. Required bot permissions/intents: Guilds, GuildMessages, MessageContent (privileged), DirectMessages. Slash commands (`/start`, `/reconnect`, `/clean`, `/status`) are registered per-guild on startup.

`telegramTokenService` is optional — the bot can run Discord-only.

### Secrets: macOS Keychain vs env vars

Token resolution accepts either form (env var wins when both are set):

| Field | Source | When to use |
|---|---|---|
| `telegramTokenService` / `discord.tokenService` | macOS Keychain via `security find-generic-password` | macOS dev workflow (existing) |
| `telegramTokenEnv` / `discord.tokenEnv` | Environment variable name (read via `process.env`) | Linux / containers / systemd `EnvironmentFile` (preferred for production) |

Example (NixOS deploy):
```yaml
telegramTokenService: telegram-bot-token   # macOS fallback (ignored when tokenEnv resolves on Linux)
telegramTokenEnv: TELEGRAM_BOT_TOKEN       # Linux uses this from sops-decrypted env file
discord:
  tokenService: discord-bot-token          # macOS fallback (same pattern)
  tokenEnv: DISCORD_BOT_TOKEN
```

If neither is set when Telegram bindings are present (or for Discord config), the bot throws a clear error at startup.

## Memory architecture

The bot maintains persistent context across sessions through a memory system rooted at the workspace.

- `MEMORY.md` at the workspace root is a curated index of memory files. Keep it concise — Claude Code loads it into the agent's initial context on every session.
- `memory/auto/` holds typed memory files (`user`, `feedback`, `project`, `reference`) with frontmatter, written by the agent or the `memory-consolidation` nightly cron.
- `memory/diary/` holds narrative digests from consolidation runs.

`MEMORY.md` is auto-loaded via the `@MEMORY.md` line in `CLAUDE.md`. This is the upstream-recommended workaround for [anthropics/claude-code#34146](https://github.com/anthropics/claude-code/issues/34146): the `autoMemoryDirectory` setting only redirects memory *writes*, not the system-prompt injection that loads `MEMORY.md` into context. An explicit `@MEMORY.md` @-import in `CLAUDE.md` forces Claude Code to inline the workspace `MEMORY.md` instead of reading from its hardcoded default path.

**Do not remove the `@MEMORY.md` line from `CLAUDE.md`.** Without it, your workspace `MEMORY.md` will not be auto-loaded and the agent will start every session with no memory index. See [.claude/rules/platform/memory-protocol.md](.claude/rules/platform/memory-protocol.md) for the full protocol.

## Configuration

### Provider backends

Each agent runs through a coding-agent backend selected by the optional per-agent `provider` field in `config.yaml`:

| `provider` | Backend | Status |
|---|---|---|
| `claude` (default, omit) | `claude -p` / Agent SDK | Active — the path every agent uses today |
| `pi` | Pi RPC + OpenAI Codex (`pi --mode rpc`) | Dispatch wired — runs end-to-end; no agent flipped to `pi` yet |

```yaml
agents:
  main:
    id: main
    # ...
    # provider: claude   # or "pi"; omit to default to "claude"
```

A `pi` agent must set an explicit, Pi-appropriate `model` (e.g. `model: gpt-5.5`). Unlike a `claude` agent it does **not** inherit the top-level `defaultModel` — that value is Claude-oriented (e.g. `opus`) and the Pi spawn path would otherwise prefix it into a nonsensical `openai-codex/opus` string. The bot refuses to start if a `pi` agent omits `model`.

Pi support is rolling out incrementally. The protocol layer is the typed Pi RPC module ([bot/src/pi-rpc-protocol.ts](bot/src/pi-rpc-protocol.ts)) — a newline-only JSONL splitter, spawn/send helpers, and a `parsePiEvent` translator that maps Pi RPC events into the bot's existing `StreamLine` shapes — plus the Pi Prometheus metrics listed under [Monitoring](#monitoring). **Session dispatch is now wired**: the [Session Manager](#architecture) branches on `agent.provider`, so a chat bound to a `pi` agent spawns via Pi RPC, streams to Telegram/Discord, persists and resumes its session across restarts, and is steerable mid-turn — while the `claude` path stays byte-identical. Specifically, this stage adds:

- a multi-turn translator fix — only Pi's `agent_end` event terminates a turn (`turn_end` is a per-turn boundary), so a tool-using response delivers its final answer instead of truncating;
- `get_state` session-id capture — the bot reads the Pi-generated session id after spawn, persists it, and resumes via `--session <uuid>`;
- graceful resume-recovery — a stored id that Pi reports as `No session found matching` is discarded for exactly one fresh start (logged + counted via `bot_pi_session_resume_discarded_total`) instead of crash-looping the chat; any other startup failure keeps the existing crash-backoff and preserves the stored id and chat media;
- Pi mid-turn steer — a message arriving while Pi is mid-turn is delivered via the Pi RPC steer channel (the `claude` path keeps its `inject-message.sh` file mechanism).

No agent ships on `provider: pi` by default; flipping one is a deliberate per-deployment step. The Pi binary (`@earendil-works/pi-coding-agent`) is resolved from `PATH`; like the Claude path, the bot prepends `/opt/homebrew/bin` to the spawned process's `PATH`, so ensure `pi` is reachable there or on the inherited `PATH`. Auth is managed by Pi itself, which reads `~/.pi/agent/auth.json` (the bot does not create or manage that file).

#### Pi extensions (A1-A3)

Every `pi --mode rpc` spawn loads three first-party extensions so Pi sessions reach capability parity with the `claude` path. They are loaded as repeatable `--extension <abs-path>` args appended by `buildPiSpawnArgs` (see [resolvePiExtensionArgs](bot/src/pi-rpc-protocol.ts)) — loading is deliberately per-spawn rather than via Pi's auto-discovery dirs (those are for `/reload`). The `claude` path is unaffected: [bot/src/cli-protocol.ts](bot/src/cli-protocol.ts) is byte-identical.

| Extension | Wrapper | What it does |
|---|---|---|
| **A1 guard** | `bot/.claude/extensions/guardian-protect-files.ts` | A `tool_call` handler that blocks edit/write and bash redirects (`>`, `>>`, `tee`, `mv`, `cp`) into the 10-path immutable core of upstream-owned paths (`bot/`, `.claude/hooks/`, `.claude/rules/platform/`, `.claude/skills/workspace-health/scripts/`, `.github/workflows/`, `.githooks/`, `.gitleaks.toml`, `.gitleaksignore`, `README.md`, `config.local.yaml.example`) and `..` traversal escapes. It also drives the **schema-enforced deny-by-default** write-guard: it parses the workspace `schema.md` ```` ```write-allowlist ```` block and blocks any write/edit/bash target whose workspace-relative path is not in it (deny-overlay > allow > default-deny). Directory entries (trailing slash) match as prefixes; the four file entries match root-only-exact (`README.md` blocks the root file but not `docs/README.md`). A missing/empty block fails **closed** (immutable core still blocks; everything else is denied with an actionable "add it to `schema.md`" message). Path matching canonicalizes `.`/`..`/`//` and is case-insensitive (APFS). Bypass one session with `PI_EXTENSIONS_DISABLED=1`. |
| **A2 web-tools** | `bot/.claude/extensions/web-tools.ts` | Registers `web_search` + `web_fetch`, Tavily-backed. The API key is read once at load from macOS Keychain (`security find-generic-password -s tavily-api-key -a minime -w`). A missing key warn-logs but leaves the tools registered; failures return a graceful "unavailable" result instead of throwing. |
| **A3 subagent** | `bot/.claude/extensions/subagent/` | The vendored official `subagent` extension (directory), adapted only to spawn an isolated `pi -p` child on the `openai-codex` provider. Exposes the `subagent` tool (`single` / `parallel` / `chain`) that the Agent/Task delegation skills invoke. Each child spawn also loads the A1 guard (so a delegated task cannot bypass it), honoring the same kill-switch. Child errors warn-log. |

**A2 setup (optional):** store a [Tavily](https://tavily.com) API key in the macOS Keychain to enable `web_search` / `web_fetch` (omit to leave the tools registered-but-unavailable):

```bash
security add-generic-password -s 'tavily-api-key' -a 'minime' -w 'YOUR_TAVILY_KEY'
```

**Kill-switch:** set `PI_EXTENSIONS_DISABLED=1` in the bot's environment to spawn Pi with **no** extensions — a bare, claude-parity command. This is the fast rollback path (no code change, no merge). With extensions enabled, a configured wrapper missing on disk makes the spawn **fail loudly** rather than silently dropping the guard (A1 is the write guard — a silent skip would spawn an unguarded session).

**Rollback:**

- **Fast (no deploy):** set `PI_EXTENSIONS_DISABLED=1` in the bot's launchd environment, then `bot/scripts/restart-bot.sh --plist` (env-var changes are plist-level — see [Start / Stop](#start--stop)). Pi spawns drop all three extensions immediately.
- **Code:** `git revert <merge-commit>` in this repo → `git fetch upstream && git merge upstream/main` in the workspace → `bot/scripts/restart-bot.sh`.

### Logging

All log output uses structured format: `TIMESTAMP LEVEL [tag] message`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `logLevel` (config.yaml) | string | `"info"` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `LOG_LEVEL` (env var) | string | — | Overrides `logLevel` from config when set |

### Monitoring

When `metricsPort` is set in `config.yaml`, the bot exposes a Prometheus-compatible `/metrics` endpoint at that port. By default it binds to `127.0.0.1`. Set `metricsHost: "0.0.0.0"` when the scrape source is reachable only via a non-loopback interface (e.g. Linux when a Prometheus container scrapes via `host.docker.internal` — that resolves to the docker bridge gateway, not loopback like on macOS Docker Desktop). When exposing on `0.0.0.0`, the host firewall must restrict external access.

```yaml
metricsPort: 9090
```

See [bot/src/metrics.ts](bot/src/metrics.ts) for the full list of exported metrics.

The Pi RPC provider (see [Provider backends](#provider-backends)) registers its own metrics: `bot_pi_turn_duration_seconds` (histogram, label `agent_id`, same buckets as the Claude turn histogram for direct comparison), the retry counters `bot_pi_retry_total`, `bot_pi_429_total`, `bot_pi_overload_total`, and `bot_pi_retry_unknown_total` (every retry increments `bot_pi_retry_total` plus exactly one signal-specific counter), and `bot_pi_session_resume_discarded_total` (label `agent_id`, incremented once per graceful resume-recovery — a stored Pi session id Pi could not find, discarded for one fresh start). They read zero until an agent runs with `provider: pi`.

#### Telegram API metrics

Two complementary counters track outbound Telegram API traffic. Both increment per-attempt (the inner transformer runs once per autoRetry attempt), so `rate(errors) / rate(calls)` over the same window yields the attempt-level error ratio. Exception: `sendMessageDraft` is excluded from autoRetry (see issue #117), so its counters reflect one increment per logical call — attempt-level and call-level rates coincide for that method.

| Metric | Labels | Description |
|--------|--------|-------------|
| `bot_telegram_api_calls_total` | `method`, `binding` | Total Telegram API call attempts (success or failure). The `binding` label is the originating binding's `label` (or its `agentId` when no label is set). Calls without a `chat_id` payload (e.g. `getUpdates`, `getMe`) use the sentinel `none`; calls whose `chat_id` does not match any configured binding use `unbound`. Raw `chat_id` is never emitted as a label value. |
| `bot_telegram_api_errors_total` | `method`, `error_code` | Total Telegram API errors. `error_code` is the numeric Telegram error code (e.g. `429`) or `http_error` for transport-level failures. |

Operationally, `none` is dominated by the `getUpdates` poll loop and is expected to be the highest-volume series. A non-zero `unbound` rate indicates traffic to a chat that no longer matches any configured binding — typically a stale cron target or a removed binding, and worth investigating.

Example PromQL queries:

```promql
# 5-minute attempt-level error ratio, per method
sum by (method) (rate(bot_telegram_api_errors_total[5m]))
  /
sum by (method) (rate(bot_telegram_api_calls_total[5m]))

# Per-binding call rate — identifies the noisiest binding during a 429 burst
sum by (binding) (rate(bot_telegram_api_calls_total[5m]))
```

#### Telegram API logging

The `telegram-api` warn logs for `Rate limited` and `HTTP error` include `chat_id=` and (when present) `message_thread_id=` extracted from the API payload, so a single `grep` over the bot's stderr log identifies which binding triggered a burst. Methods without a `chat_id` (`getUpdates`, `getMe`, `setWebhook`, etc.) log without those fields — not with `chat_id=undefined`. Example:

```
2026-05-15T16:15:17.160Z WARN [telegram-api] Rate limited: method=sendMessageDraft chat_id=<numeric-chat-id> message_thread_id=7 retry_after=3
2026-05-15T16:15:17.622Z WARN [telegram-api] Rate limited: method=getUpdates retry_after=1
```

## Upgrading from config.yaml.example

Older versions shipped `config.yaml.example` which you copied to `config.yaml` (gitignored). The current version tracks `config.yaml` directly and uses `config.local.yaml` for user overrides.

If you have a local `config.yaml` from the old workflow, git will refuse to pull because the file is now tracked. Migrate before pulling:

```bash
# 1. Back up your current config
cp config.yaml config.local.yaml

# 2. Remove the untracked file so git can check out the new tracked version
rm config.yaml

# 3. Pull — git will restore config.yaml with upstream defaults
git pull

# 4. Edit config.local.yaml — keep only your overrides (workspaceCwd, chatId, tokens, bindings)
#    Remove anything that matches the upstream defaults in config.yaml
```

Your `config.local.yaml` is deep-merged over `config.yaml` at startup, so you only need to keep what differs from the defaults.

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
| [six-ddc/ccbot](https://github.com/six-ddc/ccbot) | tmux bridge (CLI in tmux) | Yes |
| [chenhg5/cc-connect](https://github.com/chenhg5/cc-connect) | Bridge/proxy | Depends on agent |

Four projects run the actual CLI binary on a Max subscription without API keys: this bot, ductor, ccbot, and the official plugin.

### vs Anthropic Official Plugin

The [official plugin](https://github.com/anthropics/claude-plugins-official) is an MCP server that adds Telegram tools to an already-running Claude Code session.

- Not a standalone bot. Requires an active Claude Code session on your computer. Close the lid and it stops
- No cron or scheduled tasks. No autonomous work while you're away
- Single session. No parallel workspaces, no multi-agent
- Supports group chats but not forum topic routing
- No workspace health management or memory consolidation

It's a remote control for your terminal session, not an autonomous bot.

### vs ccbot

[ccbot](https://github.com/six-ddc/ccbot) runs Claude Code inside tmux and bridges it to Telegram via two channels: JSONL transcript polling for content, and terminal scraping for interactive UI.

What ccbot does better: tool use visibility (which tool was called, what it returned), thinking content as expandable blockquotes, and interactive permission handling — approve or deny tool calls from Telegram via inline keyboard. These are real advantages that `claude -p` stream-json cannot provide today.

The trade-off is fragility. Hardcoded regex patterns match Claude Code's terminal UI text — prompt wordings, spinner characters, chrome separators. Any Claude Code TUI update can silently break detection. Input goes through `send_keys()` with empirical timing delays. Two polling loops (JSONL at 2s + terminal scrape at 1s per window) add overhead that scales linearly with sessions.

No cron system, no multi-agent, no workspace management, no Discord. Single-user remote control with excellent visibility into what Claude is doing.

### vs Ductor

[Ductor](https://github.com/PleasePrompto/ductor) is the closest alternative. Also spawns the CLI binary, also ToS-compliant, also supports forum topics.

| | **claude-code-bot** | **ductor** |
|---|---|---|
| Language | TypeScript (grammY) | Python (aiogram) |
| Codebase | ~3k LoC | ~150 modules |
| Forum topic sessions | Yes | Yes |
| Multi-agent with isolated workspaces | Yes | Yes |
| Cron system | launchd plists (per-cron process isolation) | In-process scheduler |
| Crash safety | Atomic JSON writes, launchd auto-restart | Atomic writes, in-flight turn tracking, process registry |
| Workspace health | Filesystem guardian hooks + structural audits | Agent health with exponential backoff |
| Memory consolidation | Nightly summarization cron | File sync |
| Platforms | Telegram + Discord | Telegram + Matrix |
| Multi-CLI support | Claude Code | Claude Code, Codex, Gemini |

Neither project is strictly better than the other — feature sets are comparable. Ductor covers more CLIs and has deeper crash recovery (in-flight turn tracking, process registry, stream coalescing). We're significantly simpler: a thin TypeScript wrapper around `claude -p` that delegates complexity to the OS (launchd for process isolation, filesystem hooks for workspace protection) rather than reimplementing it in application code.
