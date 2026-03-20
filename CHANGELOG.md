# Changelog

## v0.1.1

### Improvements

- Session ID shown in `/status` output — enables resuming sessions from console via `claude --resume <id>`

### Bug Fixes

- Removed `maxBudget` feature entirely (never used)

## v0.1.0

Initial public release of Minime — a multi-platform bot that routes messages to Claude Code CLI subprocesses, designed for Claude Max subscription users.

### Multi-Platform Support

- Telegram bot via grammY with long polling, auto-retry, and command registration
- Discord bot via discord.js with gateway websocket, slash commands, and guild-wide bindings
- Platform abstraction layer (`PlatformContext` interface) shared by both adapters
- Per-platform streaming updates, typing indicators, and message editing
- Configurable per-binding options: `requireMention`, `voiceTranscriptEcho`, `streamingUpdates`, `typingIndicator`

### Session Management

- One Claude Code subprocess per chat/channel with automatic spawning
- Configurable max concurrent sessions (default: 12) with LRU eviction
- Idle timeout (default: 1 hour) with automatic cleanup
- Crash detection with exponential backoff (5s to 60s) and circuit breaker after 5 consecutive failures
- Session resume via `--resume` on subprocess respawn
- Persistent session store (`sessions.json`) survives bot restarts
- Per-agent workspace, model, fallback model, max turns, and effort level configuration

### Message Processing

- Debounce-based message queue (3s window) batches rapid messages into a single prompt
- Mid-turn message collection (up to 20) delivered as combined followup after current turn
- Source context prefixing for group chats (chat label, topic, sender info)
- Reply context extraction with quoted text
- Stale message filtering (configurable `maxMessageAgeMs`, default: 10 minutes)

### Streaming & Output

- Real-time streaming message edits from Claude's `stream-json` protocol
- Paragraph-aware message splitting for platform character limits
- NO_REPLY suppression — agent can signal "no response needed"
- Markdown-to-HTML conversion for Telegram (`parse_mode: HTML`)
- Graceful fallback to plaintext on HTML rendering errors
- Per-session outbox directories for file delivery (images as photos, others as documents)

### Telegram Features

- Forum supergroup support with per-topic agent routing and inline topic overrides
- Voice message transcription via whisper-cli (ffmpeg + whisper.cpp)
- Photo and document handling with vision analysis support
- Emoji reaction forwarding to Claude sessions (with thread-aware routing)
- Reaction event logging to JSONL
- In-memory message-thread cache with disk persistence for reaction routing
- Message content index for reaction context lookups
- Bot commands: `/start`, `/reset`, `/status`

### Discord Features

- Guild-wide bindings with per-channel overrides
- Thread support with automatic parent channel binding inheritance
- Slash commands (`/start`, `/reset`, `/status`) registered per-guild on startup
- File attachment handling and voice transcription
- Mention detection with configurable `requireMention`

### Cron System

- Scheduled jobs via launchd plists generated from `crons.yaml`
- Two task types: `llm` (Claude prompt) and `script` (shell command)
- Per-cron configuration: timeout, deliveryThreadId, enabled
- Result delivery to Telegram with configurable default delivery target
- Admin notifications on delivery failure
- NO_REPLY suppression for cron output

### Monitoring & Observability

- Prometheus-compatible `/metrics` endpoint (configurable port)
- Token usage counters (input, output, cache read, cache creation) by agent
- Cost tracking in USD by agent
- Turn duration histograms by agent
- Telegram API error counters by method and error code
- Active session gauge and crash counter
- Message flow counters (received and sent)
- Structured logging with configurable levels (`debug`, `info`, `warn`, `error`)
- Polling watchdog with heartbeat-based liveness detection and auto-restart

### Configuration

- YAML-based config with comprehensive validation and helpful error messages
- macOS Keychain integration for platform tokens
- Multi-agent support with per-agent workspace, model, and limits
- Session defaults: `idleTimeoutMs`, `maxConcurrentSessions`, `maxMessageAgeMs`
- CLI capability detection from `claude --version` and `--help`
- 409 conflict detection with retry logic on bot startup

### Workspace Template

- Directory structure with `.claude/hooks/`, `.claude/rules/`, `.claude/optional-rules/`, `memory/`
- 6 hooks: auto-stage, session-end-commit, session-start-recovery, inject-message, protect-files, guardian
- Platform rules: safety, no-nested-cli, output-formatting, show-files, bot-operations, adr-governance
- Optional rules: task-tracking, memory-protocol, communication, async-long-tasks
- Skills: workspace-health, memory-consolidation
- CLAUDE.md entry point with @imports
- USER.md and IDENTITY.md placeholders
- setup.sh interactive onboarding script
- ADR governance with decision tracking
- MIT license

### Scripts

- `start-bot.sh` — launchd entry point with env setup and CLAUDECODE filtering
- `run-cron.sh` — cron plist entry point with same env setup
- `deliver.sh` — Telegram message delivery with >4096 char splitting and retry
- `generate-plists.ts` — crons.yaml to launchd plist generator with `--dry-run` support
