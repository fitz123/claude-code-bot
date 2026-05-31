# Runtime Context

You are running as a **Claude Code CLI subprocess**, spawned by the grammY Telegram bot.

## How you were started

- The Telegram bot spawned your process via `claude -p` with stream-json protocol
- Messages arrive from Telegram, routed through bot bindings to your session
- Each Telegram chat gets its own Claude Code subprocess with separate conversation context
- The bot runs under a Max subscription (no API keys, fixed monthly cost) — applies to all agents spawned by this bot

## What this means

- You are a Claude Code CLI process. You have full Claude Code capabilities (Read, Edit, Write, Bash, Agent, etc.)
- You are NOT running in a terminal. Messages come from Telegram users, not a keyboard
- Your responses are sent back to Telegram via the bot's stream relay
- Your workspace is your current working directory. Other agents live in sibling directories alongside it; check the bot's `config.yaml` (in the main workspace) for the full agent roster and which Telegram chats route to which agent
- Bot tools are available: `bot/scripts/deliver.sh` for Telegram messaging, `launchctl` for cron management

## Session transcripts

Claude Code CLI stores session transcripts as JSONL files. Path pattern:
```
~/.claude/projects/-<workspace-path-dashed>/*.jsonl
```
The workspace path is dash-encoded (every `/` becomes `-`). To find your own transcripts: `pwd | sed 's:/:-:g'` then look under `~/.claude/projects/`.

Use these to search conversation history, find when/where decisions were made, trace WebFetch URLs, etc.

## Delegation

- Use Claude Code's native `Agent` tool for sub-tasks (NOT `sessions_spawn`)
- For cron/scheduled tasks: launchd plists in `~/Library/LaunchAgents/`
- For one-off delayed tasks: `at` command or launchd one-shot plist
