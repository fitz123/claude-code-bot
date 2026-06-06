# Minime

Multi-platform bot (Telegram + Discord) that routes messages to Pi/Codex coding-agent sessions. Each chat/channel gets its own persistent Pi RPC session, and scheduled LLM crons run through Pi print mode.

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
                  │ spawns pi --mode rpc
                  ▼
         ┌──────────────────┐
         │  Pi RPC Runtime  │
         │  - per-agent     │
         │    workspace     │
         │  - model from    │
         │    config        │
         └────────┬─────────┘
                  │
                  ▼
            OpenAI Codex
```

Both platforms share one Session Manager and use the same stream-relay logic via the `PlatformContext` interface. Each platform provides an adapter that handles platform-specific message I/O (Telegram: grammY Context, Discord: discord.js Channel).

**Message queue** sits between platform bots and Session Manager. Rapid messages are debounced (3s window) into a single prompt. Messages arriving while a session is processing are collected (up to 20) and delivered as reliable follow-up prompts after the current turn completes. Passive echo context and shutdown notices can still be steered best-effort into an active Pi turn.

**Context injection:** Each message includes metadata — current time, chat type (DM/group/topic), topic name, sender username, and emoji reactions. The agent knows where it is, when it is, and who it's talking to. Reactions are delivered as messages so the agent can respond to a thumbs-up or a ❤️ without the user typing anything.

**Cron jobs** run separately via launchd plists. Each plist calls `run-cron.sh <task-name>`, which invokes `cron-runner.ts` to spawn a one-shot Pi print-mode run with the cron's prompt.

**Config:** `config.yaml` defines agents (workspace + model), bindings (chatId/channelId -> agentId), and non-secret pointers to runtime token sources. User-specific overrides live in `config.local.yaml` (gitignored, deep-merged over `config.yaml`). At least one platform (Telegram or Discord) must be configured. Tokens resolve from a private SOPS/age file first, with explicitly configured environment variables as deployment overrides.

## Installation

### Prerequisites

- macOS (launchd required for bot service management)
- Node.js 20+ and npm
- `jq` — required by hook scripts (`brew install jq`)
- `sops` and `age`, with an age identity available to the launchd user unless you configure only explicit token environment variables
- The `pi` binary on launchd `PATH` and Pi auth initialized for the launchd user with `pi /login`
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

**3. Configure runtime token secrets**

Runtime SOPS files are private deployment artifacts. They are gitignored, are not part of the public repo, and should decrypt to the configured key paths without exposing plaintext in logs or commits.

Install the tooling and create the age identity as the same user that owns the launchd jobs:

```bash
brew install sops age
mkdir -p ~/.config/sops/age
age-keygen -o ~/.config/sops/age/keys.txt
age-keygen -y ~/.config/sops/age/keys.txt
```

Use the printed public recipient in a local `.sops.yaml`, or pass it directly with `sops --age <age-recipient> ...`. Example creation rule:

```yaml
creation_rules:
  - path_regex: config/.*\.sops\.yaml$
    age: age1replace_with_your_public_recipient
```

`config.yaml` already points Telegram at `config/secrets.sops.yaml` key `telegram.bot_token`. This bot runtime file is resolved relative to the bot config file, not relative to agent workspaces. Create it with SOPS/age so the decrypted document contains only bot platform token paths:

```bash
mkdir -p config
sops config/secrets.sops.yaml
```

Example decrypted shape, with encrypted values in the file:

```yaml
telegram:
  bot_token: ENC[...]
discord:
  bot_token: ENC[...]
```

Tavily web-tool secrets use a separate SOPS file in each agent workspace, described in [A2 setup](#pi-extensions-a1-a3). Do not copy Telegram or Discord bot tokens into agent workspaces.

**4. Initialize Pi auth**

```bash
pi /login
```

Run this as the same user that owns the launchd jobs. Pi manages its own auth in `~/.pi/agent/auth.json`; the bot does not store coding-agent credentials.

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

**Discord:** Add `discord.tokenSopsKey` for `discord.bot_token` in the private SOPS file, or configure `discord.tokenEnv` as an explicit environment override. See [config.yaml](config.yaml) for full reference.

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
   | `type` | `"llm"` or `"script"` | no | `"llm"` (default) runs a one-shot Pi print-mode backend; `"script"` runs a shell command |
   | `engine` | `"pi"` | no | Optional compatibility field for LLM crons. Omit or set `"pi"`. Ignored for script crons |
   | `prompt` | string | for llm | Prompt sent to the selected LLM cron engine |
   | `command` | string | for script | Shell command to execute |
   | `agentId` | string | yes | Must match an agent in `config.yaml` or `config.local.yaml` |
   | `deliveryChatId` | number | no | Telegram chat ID for delivery (falls back to config default) |
   | `deliveryThreadId` | number | no | Telegram forum topic ID for delivery |
   | `timeout` | number | no | Per-cron timeout in ms (default: 900000 = 15 min) |
   | `enabled` | boolean | no | Set `false` to disable without deleting (default: `true`) |

   Minimal LLM example:
   ```yaml
   crons:
     - name: read-only-example
       schedule: "0 9 * * *"
       type: llm
       engine: pi
       agentId: main
       prompt: "Summarize read-only status and include NO_REPLY if there is nothing notable."
   ```

   Pi cron behavior:

   - LLM crons always run Pi print mode with `pi -p --no-session --no-extensions`, fixed model `openai-codex/gpt-5.5`, the agent `systemPrompt`/workspace context, and only the explicit A1 guard extension.
   - Agent `thinking` maps to `--thinking`; absent values default to `medium`, and invalid configured values fail validation.
   - The `pi` binary must be on the launchd cron `PATH`, and Pi auth must exist at `~/.pi/agent/auth.json` for the launchd user. Run `pi /login` as that user before enabling LLM crons.
   - Set `enabled: false`, convert the cron to `type: script`, or unload the cron plist to stop a problematic cron. Engine values other than `pi` are rejected.

   Cron result handling:

   - Empty stdout with empty stderr is a successful no-delivery run.
   - `NO_REPLY` is a successful no-delivery LLM run.
   - Pi stderr-only success, non-zero exit, signal exit, spawn timeout, missing A1 guard, or disabled A1 guard are failures and trigger the existing `⚠️ Cron FAIL` notification plus the failure metric.

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
       workspaceCwd: /absolute/path/to/workspace-new
       model: gpt-5.5

   bindings:
     - chatId: 111111111
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

1. Add the Discord token to your private SOPS file at `discord.bot_token`, or expose it through a configured environment variable.

2. Add the `discord` section to `config.local.yaml`:
   ```yaml
   discord:
     tokenSopsKey: discord.bot_token
     # tokenEnv: DISCORD_BOT_TOKEN
     bindings:
       - guildId: "YOUR_GUILD_ID"
         agentId: main
         kind: channel
         label: My Server
         requireMention: true
   ```

   See [config.yaml](config.yaml) for per-channel overrides and guild-wide defaults.

3. Required bot permissions/intents: Guilds, GuildMessages, MessageContent (privileged), DirectMessages. Slash commands (`/start`, `/reconnect`, `/clean`, `/status`) are registered per-guild on startup.

Telegram bindings are optional; the bot can run Discord-only.

### Secrets: SOPS and env vars

Token resolution checks SOPS first, then a configured environment variable:

| Field | Source | When to use |
|---|---|---|
| `secrets.sopsFile` + `telegramTokenSopsKey` / `discord.tokenSopsKey` | SOPS/age file read with `sops -d --extract` | Canonical private-workspace deployment backend for bot platform tokens |
| `telegramTokenEnv` / `discord.tokenEnv` | Environment variable name read from `process.env` | Explicit environment override for launchd, Linux, containers, or systemd |

Example:
```yaml
secrets:
  sopsFile: config/secrets.sops.yaml
telegramTokenSopsKey: telegram.bot_token
telegramTokenEnv: TELEGRAM_BOT_TOKEN
discord:
  tokenSopsKey: discord.bot_token
  tokenEnv: DISCORD_BOT_TOKEN
```

SOPS key paths are dot paths whose segments must match `[A-Za-z0-9_-]+`, such as `telegram.bot_token`. A configured `*SopsKey` requires `secrets.sopsFile`; invalid key syntax or a missing `secrets.sopsFile` is a config error. Runtime lookup failures such as a missing file, decrypt failure, or blank decrypted value fall back to the configured env var, then fail with sanitized source/key/env/failure-kind details if no source resolves.

Legacy `telegramTokenService` and `discord.tokenService` Keychain settings are rejected with migration errors. Telegram token resolution is required only when Telegram bindings are configured; Discord-only deployments can set `bindings: []` and provide a Discord token source.

## Memory architecture

The bot maintains persistent context across sessions through a memory system rooted at the workspace.

- `MEMORY.md` at the workspace root is a curated index of memory files. Keep it concise — the Pi context assembler loads it into the agent's initial context on every session.
- `memory/auto/` holds typed memory files (`user`, `feedback`, `project`, `reference`) with frontmatter, written by the agent or the `memory-consolidation` nightly cron.
- `memory/diary/` holds narrative digests from consolidation runs.

`MEMORY.md` is auto-loaded via the `@MEMORY.md` line in `CLAUDE.md`. `CLAUDE.md` remains the workspace context entry point even though Pi/Codex is now the runtime; the Pi context assembler follows that import and includes the workspace memory index.

**Do not remove the `@MEMORY.md` line from `CLAUDE.md`.** Without it, your workspace `MEMORY.md` will not be auto-loaded and the agent will start every session with no memory index. See [.claude/rules/platform/memory-protocol.md](.claude/rules/platform/memory-protocol.md) for the full protocol.

## Configuration

### Provider backends

Interactive agents run through Pi RPC + OpenAI Codex. The optional per-agent `provider` field remains only as a compatibility field:

| `provider` | Backend | Status |
|---|---|---|
| omitted | Pi RPC + OpenAI Codex (`pi --mode rpc`) | Supported |
| `pi` | Pi RPC + OpenAI Codex (`pi --mode rpc`) | Supported |

```yaml
agents:
  main:
    id: main
    workspaceCwd: /absolute/path/to/workspace
    model: gpt-5.5
    # provider: pi
    # thinking: high
```

Each agent must set an explicit Pi-appropriate `model` (for example, `model: gpt-5.5`). The top-level `defaultModel` key is accepted for old config overlays but is no longer inherited by agents. The bot refuses to start if an agent omits `model`.

Agents may also set `thinking`, which is passed as Pi `--thinking`. Allowed values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

The typed Pi RPC module ([bot/src/pi-rpc-protocol.ts](bot/src/pi-rpc-protocol.ts)) handles JSONL splitting, spawn/send helpers, and event translation into the bot's existing stream relay shapes. The Session Manager spawns Pi RPC, streams responses to Telegram/Discord, persists and resumes session IDs across restarts, and sends user prompts with `followUp` semantics so they queue instead of being rejected if Pi is still busy.

The Pi binary (`@earendil-works/pi-coding-agent`) is resolved from `PATH`; the bot prepends `/opt/homebrew/bin` to the spawned process's `PATH`, so ensure `pi` is reachable there or on the inherited `PATH`. Auth is managed by Pi itself, which reads `~/.pi/agent/auth.json` (the bot does not create or manage that file).

#### Pi extensions (A1-A3)

Every `pi --mode rpc` spawn suppresses Pi's ambient extension discovery with `--no-extensions`, then loads three first-party extensions so Pi sessions reach parity with the workspace guard, web-tools, and subagent capabilities expected by deployed agents. They are loaded as repeatable `--extension <abs-path>` args appended by `buildPiSpawnArgs` (see [resolvePiExtensionArgs](bot/src/pi-rpc-protocol.ts)) — loading is deliberately per-spawn rather than via Pi's auto-discovery dirs.

| Extension | Wrapper | What it does |
|---|---|---|
| **A1 guard** | `bot/.claude/extensions/guardian-protect-files.ts` | A `tool_call` handler that blocks edit/write and bash redirects (`>`, `>>`, `tee`, `mv`, `cp`) into the 10-path immutable core of upstream-owned paths (`bot/`, `.claude/hooks/`, `.claude/rules/platform/`, `.claude/skills/workspace-health/scripts/`, `.github/workflows/`, `.githooks/`, `.gitleaks.toml`, `.gitleaksignore`, `README.md`, `config.local.yaml.example`) and `..` traversal escapes. It also drives the **schema-enforced deny-by-default** write-guard: it parses the workspace `schema.md` ```` ```write-allowlist ```` block and blocks any write/edit/bash target whose workspace-relative path is not in it (deny-overlay > allow > default-deny). Directory entries (trailing slash) match as prefixes; the four file entries match root-only-exact (`README.md` blocks the root file but not `docs/README.md`). A missing/empty block fails **closed** (immutable core still blocks; everything else is denied with an actionable "add it to `schema.md`" message). Path matching canonicalizes `.`/`..`/`//` and is case-insensitive (APFS). Disable first-party wrappers with `PI_EXTENSIONS_DISABLED=1`; ambient discovery remains disabled. |
| **A2 web-tools** | `bot/.claude/extensions/web-tools.ts` | Registers `web_search` + `web_fetch`, Tavily-backed. The API key is read from SOPS key `tavily.api_key` in `config/secrets.sops.yaml` relative to the Pi session cwd, which is the agent's `workspaceCwd`. A missing key warn-logs a sanitized message but leaves the tools registered; failures return a graceful "unavailable" result instead of throwing. |
| **A3 subagent** | `bot/.claude/extensions/subagent/` | The vendored official `subagent` extension (directory), adapted only to spawn an isolated `pi -p` child on the `openai-codex` provider. Exposes the `subagent` tool (`single` / `parallel` / `chain`) that the Agent/Task delegation skills invoke. Each child spawn passes `--no-extensions`, then explicitly loads A1 guard + A2 web-tools so delegated research can use `web_search` / `web_fetch` without bypassing the write guard; children never load A3 `subagent/index.ts`, so recursive spawning stays disabled. Child wrapper resolution fails closed if a required wrapper is missing. Child errors warn-log. |

**A2 setup (optional):** add a [Tavily](https://tavily.com) API key to a Tavily-only private SOPS file at `<agent.workspaceCwd>/config/secrets.sops.yaml` to enable `web_search` / `web_fetch` for that agent. The decrypted shape should contain only the web-tool secret:

```yaml
tavily:
  api_key: ENC[...]
```

Keep this file separate from the bot runtime SOPS file used for Telegram and Discord tokens. Omit it to leave the tools registered-but-unavailable.

**Kill-switch:** set `PI_EXTENSIONS_DISABLED=1` in the bot's environment to spawn Pi RPC chat sessions with no explicit first-party wrappers; the spawn still passes `--no-extensions`, so ambient discovery does not load other extensions. With extensions enabled, a configured wrapper missing on disk makes the spawn **fail loudly** rather than silently dropping the guard (A1 is the write guard — a silent skip would spawn an unguarded session). Pi crons are stricter: LLM crons require A1 and fail closed if `PI_EXTENSIONS_DISABLED=1`.

**Rollback:**

- **Disable Pi extensions (no deploy):** set `PI_EXTENSIONS_DISABLED=1` in the bot's launchd environment, then `bot/scripts/restart-bot.sh --plist` (env-var changes are plist-level — see [Start / Stop](#start--stop)). Pi RPC chat spawns drop all three first-party wrappers immediately while still blocking ambient extension discovery.
- **Cron rollback:** set `enabled: false`, unload the cron plist, or change the job to `type: script` and reload its plist. LLM crons only run through Pi.
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

For dashboard continuity, token, cost, and turn-duration metrics keep their legacy `bot_claude_*` names (`bot_claude_tokens_*`, `bot_claude_cost_usd_total`, `bot_claude_turn_duration_seconds`). In the Pi-only runtime these are metric names only: they record usage and duration reported by the active runtime, not a Claude subprocess. Pi retry/resume metrics remain under `bot_pi_*`.

Cron runs also write best-effort Prometheus textfile metrics for node_exporter. These do not appear on the bot's `metricsPort` endpoint. Configure node_exporter with `--collector.textfile.directory=/opt/homebrew/var/node_exporter/textfile`, or override the directory with `CRON_HEALTH_TEXTFILE_DIR` for tests or alternate installs. Ensure the launchd cron user can create and write the directory. Each cron gets collision-resistant textfiles with the raw cron name escaped as the `cron` label:

- `minime_cron_last_success_timestamp{cron="<name>"}` is updated only after successful runs and remains present after later failures.
- `minime_cron_last_exit_code{cron="<name>"}` is updated on every run.

The Pi RPC provider (see [Provider backends](#provider-backends)) registers its own metrics: `bot_pi_turn_duration_seconds` (histogram, label `agent_id`), the retry counters `bot_pi_retry_total`, `bot_pi_429_total`, `bot_pi_overload_total`, and `bot_pi_retry_unknown_total` (every retry increments `bot_pi_retry_total` plus exactly one signal-specific counter), and `bot_pi_session_resume_discarded_total` (label `agent_id`, incremented once per graceful resume-recovery — a stored Pi session id Pi could not find, discarded for one fresh start).

#### Codex quota sampler

Telegram and Discord `/status` use the same compact local renderer. The normal
healthy output shows session count, uptime, agent/provider, model,
thinking, processing-or-idle state, and session id. It omits noisy
diagnostics such as RSS memory, PID, restart count, and last success unless those
values are actionable: dead process, non-zero restarts, or missing/stale last
success.

Codex quota in `/status` is also local-only. The command never calls Pi, Codex,
or the network; it only reads the sampler cache from `CODEX_QUOTA_STATE_FILE` (or
the default cache path). If the cache is fresh, `/status` shows 5-hour and weekly
used/left percentages, reset ETA, plan/active-limit metadata when present, sample
age, and last probe attempt. If the cache is stale, missing, or malformed, it says
so explicitly instead of probing live.

A separate low-frequency sampler runs a tiny Pi SSE probe, loads only
`bot/.claude/extensions/codex-usage.ts`, and writes:

- JSON cache: `CODEX_QUOTA_STATE_FILE`, defaulting to
  `bot/.tmp/codex-quota-state.json` when run from `bot/`.
- Prometheus usage textfile: `codex_usage.prom` in `CODEX_QUOTA_TEXTFILE_DIR`,
  `NODE_EXPORTER_TEXTFILE_DIR`, or `/opt/homebrew/var/node_exporter/textfile`
  when that directory is writable.
- Prometheus probe textfile: `codex_usage_probe.prom` in the same textfile dir.

The sampler fails loudly if no configured or writable Prometheus textfile
directory is available, rather than writing metrics to an unsupervised fallback
directory.

A sampler attempt is considered successful only when the Pi child exits cleanly
and the JSON cache is refreshed by quota headers from that attempt. Missing
headers, write warnings, timeouts, and non-zero exits record a failed attempt,
preserve the last successful quota values, and leave `codex_usage.prom` unchanged.
The JSON cache is still updated with `lastAttempt`, `lastAttemptTimestamp`, and
`probeSuccess` when the existing cache is valid, so `/status` can report the
latest failed probe without probing live.

Normal Pi conversations must stay on `transport: auto`. Do not set global
`~/.pi/agent/settings.json` or the bot workspace `.pi/settings.json` to
`transport: "sse"` for live sessions. Codex quota headers are available on Pi's
Codex SSE path, but live Codex SSE can fail before any response body with
`Codex SSE response headers timed out after 10000ms`
(`DEFAULT_SSE_HEADER_TIMEOUT_MS = 10_000`). Forcing that path globally would make
interactive Telegram or Discord conversations less reliable. The sampler creates
its own isolated project cwd and writes `{ "transport": "sse" }` only there, so a
slow or failed SSE header probe cannot degrade live sessions.

Sampler command:

```bash
cd ~/.minime/bot
CODEX_QUOTA_TEXTFILE_DIR=/opt/homebrew/var/node_exporter/textfile \
CODEX_QUOTA_STATE_FILE=$PWD/.tmp/codex-quota-state.json \
npx tsx scripts/codex-quota-sampler.ts
```

Supported CLI flags:

| Flag | Description |
|---|---|
| `--model <model>` | Probe model; same normalization as `CODEX_QUOTA_MODEL`. |
| `--textfile-dir <dir>` | Prometheus textfile directory. |
| `--state-file <file>` | Codex quota JSON state file. |
| `--sampler-cwd <dir>` | Isolated cwd that receives `.pi/settings.json`. |
| `--timeout-ms <ms>` / `--timeout <ms>` | Wall-clock timeout for the Pi child. |
| `--pi-bin <path>` | Pi binary path/name. |
| `--prompt <text>` | Minimal prompt sent to Pi. |
| `--dry-run` | Print resolved command/settings without launching Pi or writing attempt metrics. |
| `--help` / `-h` | Print sampler help. |

Supported environment variables:

| Variable | Description |
|---|---|
| `CODEX_QUOTA_MODEL` | Probe model. Defaults to `openai-codex/gpt-5.5`; unqualified names are prefixed with `openai-codex/`. |
| `CODEX_QUOTA_TEXTFILE_DIR` | Directory for `codex_usage.prom` and `codex_usage_probe.prom`; takes precedence over `NODE_EXPORTER_TEXTFILE_DIR`. |
| `NODE_EXPORTER_TEXTFILE_DIR` | Fallback textfile directory used when `CODEX_QUOTA_TEXTFILE_DIR` is unset. |
| `CODEX_QUOTA_STATE_FILE` | JSON cache read by `/status`. The bot and sampler must agree on this path. |
| `CODEX_QUOTA_SAMPLER_CWD` | Isolated sampler project cwd. Defaults to the system temp dir. |
| `CODEX_QUOTA_TIMEOUT_MS` | Wall-clock timeout for the Pi child. Defaults to 20000. |
| `CODEX_QUOTA_DRY_RUN` | Boolean-like dry-run switch; prints the resolved command without launching Pi. |
| `CODEX_QUOTA_PI_BIN` | Pi binary path/name. Defaults to `pi`. |
| `CODEX_QUOTA_STALE_MS` | `/status` stale threshold for cached quota data. Defaults to 1800000 (30 minutes). |

JSON cache shape:

```json
{
  "provider": "codex",
  "sampledAt": "2026-06-05T12:00:01.000Z",
  "lastSuccess": "2026-06-05T12:00:01.000Z",
  "lastSuccessTimestamp": 1001,
  "lastAttempt": "2026-06-05T12:00:00.000Z",
  "lastAttemptTimestamp": 1000,
  "probeSuccess": true,
  "planType": "Pro",
  "activeLimit": "primary",
  "windows": {
    "5h": { "usedPercent": 12.5, "remainingPercent": 87.5, "resetTimestamp": 2800 },
    "week": { "usedPercent": 88, "remainingPercent": 12, "resetTimestamp": 7200 }
  }
}
```

Prometheus textfiles:

| Metric | File | Description |
|---|---|---|
| `codex_usage_5h_percent` | `codex_usage.prom` | Last successful 5-hour usage percent. |
| `codex_usage_weekly_percent` | `codex_usage.prom` | Last successful weekly usage percent. |
| `codex_usage_5h_reset_timestamp` | `codex_usage.prom` | Unix reset timestamp for the 5-hour window. |
| `codex_usage_weekly_reset_timestamp` | `codex_usage.prom` | Unix reset timestamp for the weekly window. |
| `codex_usage_last_success_timestamp` | `codex_usage.prom` | Unix timestamp of the last successful quota sample. |
| `codex_usage_info` | `codex_usage.prom` | Low-cardinality `provider`, `plan_type`, and `active_limit` labels. |
| `codex_usage_last_attempt_timestamp` | `codex_usage_probe.prom` | Unix timestamp of the last sampler attempt. |
| `codex_usage_probe_success` | `codex_usage_probe.prom` | `1` only when the attempt refreshed the quota cache. |

Run the sampler every 15-30 minutes. Keep `CODEX_QUOTA_STALE_MS` at least as
large as the scheduled interval plus normal launch jitter; the default 30-minute
threshold fits a 15-minute schedule, while a 30-minute schedule should set a
larger value such as 2700000.

Example private `crons.local.yaml` entry. Redirect stdout/stderr so the bot's
script cron runner skips success delivery and only notifies the delivery chat on
failure:

```yaml
crons:
  - name: codex-quota-sampler
    type: script
    schedule: "*/15 * * * *"
    command: >
      cd /absolute/path/to/minime/bot &&
      CODEX_QUOTA_TEXTFILE_DIR=/opt/homebrew/var/node_exporter/textfile
      CODEX_QUOTA_STATE_FILE=/absolute/path/to/minime/bot/.tmp/codex-quota-state.json
      npx tsx scripts/codex-quota-sampler.ts
      >> /absolute/path/to/minime/logs/codex-quota-sampler.log 2>&1
    agentId: main
    deliveryChatId: 111111111
    timeout: 60000
```

Equivalent cron-style invocation:

```cron
*/15 * * * * cd /absolute/path/to/minime/bot && CODEX_QUOTA_TEXTFILE_DIR=/opt/homebrew/var/node_exporter/textfile CODEX_QUOTA_STATE_FILE=/absolute/path/to/minime/bot/.tmp/codex-quota-state.json npx tsx scripts/codex-quota-sampler.ts >> /absolute/path/to/minime/logs/codex-quota-sampler.log 2>&1
```

Prometheus alert expression:

```promql
codex_usage_5h_percent > 85 OR codex_usage_weekly_percent > 90
```

Post-merge private rollout: add a script cron or launchd entry for
`scripts/codex-quota-sampler.ts`, confirm the bot and sampler use the same
`CODEX_QUOTA_STATE_FILE`, and add the optional monitoring rule above to the
private Prometheus configuration.

Rollback: disable the sampler cron/launchd job first. If the bot was configured
with custom quota env vars, unset `CODEX_QUOTA_STATE_FILE`,
`CODEX_QUOTA_TEXTFILE_DIR`, `NODE_EXPORTER_TEXTFILE_DIR`, and
`CODEX_QUOTA_STALE_MS` from the bot/sampler environment as applicable, then
restart the bot only if its launchd environment changed. Existing live sessions
remain on `transport: auto`; disabling quota visibility does not touch active Pi
conversations. Remove or silence the private Prometheus alert separately if it
was enabled.

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

# 2. Move the untracked file aside so git can check out the new tracked version
mv config.yaml config.yaml.pre-tracked-backup

# 3. Pull — git will restore config.yaml with upstream defaults
git pull

# 4. Edit config.local.yaml — keep only your overrides (workspaceCwd, chatId, secret source pointers, bindings)
#    Remove anything that matches the upstream defaults in config.yaml
```

Your `config.local.yaml` is deep-merged over `config.yaml` at startup, so you only need to keep what differs from the defaults.

## Upgrading to Pi-only Runtime

Run `pi /login` as the launchd user and ensure `pi` is on the launchd `PATH`.

For every agent, set an explicit `model` and replace `effort` with `thinking`. Remove `provider: claude`, `fallbackModel`, `defaultFallbackModel`, `maxTurns`, and `allowedTools`; those fields now fail validation instead of being treated as runtime controls.

For LLM crons, remove `engine: claude`; omit `engine` or set `engine: pi`. `CRON_PI_DISABLED=1` no longer rolls back to Claude. Disable or unload the cron, or convert it to `type: script`.

Remove Claude OAuth / Claude Code env setup. Pi auth is read from `~/.pi/agent/auth.json`, and bot wrappers scrub inherited `CLAUDE_CODE_*`, `ANTHROPIC_*`, and `CLAUDECODE` values.

## Similar Projects

### Project lineage

Minime started as a Telegram/Discord bridge for Claude Code and later moved to Pi/Codex as the single supported runtime. The current architecture keeps the same multi-chat session manager, launchd cron isolation, workspace guardrails, and memory conventions while delegating interactive sessions and LLM crons to Pi.

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

What ccbot does better: tool use visibility (which tool was called, what it returned), thinking content as expandable blockquotes, and interactive permission handling — approve or deny tool calls from Telegram via inline keyboard.

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
| Runtime support | Pi/Codex | Claude Code, Codex, Gemini |

Neither project is strictly better than the other — feature sets are comparable. Ductor covers more CLIs and has deeper crash recovery (in-flight turn tracking, process registry, stream coalescing). Minime is narrower: a TypeScript wrapper around Pi/Codex sessions that delegates process isolation to launchd and workspace protection to filesystem hooks and Pi extensions.
