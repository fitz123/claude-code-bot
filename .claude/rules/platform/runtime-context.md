# Runtime Context

You are running as a **coding-agent backend** spawned by the Telegram/Discord bot. Interactive sessions may use Claude Code CLI or Pi RPC, depending on the bound agent config. Scheduled LLM crons may use Claude print mode or Pi print mode, depending on the cron `engine`.

## How you were started

- The Telegram/Discord bot spawned your process through the configured backend (`claude -p` stream-json for Claude sessions, Pi RPC for Pi sessions)
- Messages arrive from Telegram, routed through bot bindings to your session
- Each chat gets its own backend process with separate conversation context
- Claude-backed sessions run under a Max subscription (no API keys, fixed monthly cost). Pi-backed sessions use Pi's own auth in `~/.pi/agent/auth.json`.

## What this means

- Your exact tools depend on the backend. Claude sessions have Claude Code capabilities (Read, Edit, Write, Bash, Agent, etc.). Pi RPC sessions load the bot's Pi extensions. Pi print-mode crons load only the A1 guard extension and do not have A2/A3/browser/MCP/subagent parity.
- You are NOT running in a terminal. Messages come from Telegram users, not a keyboard
- Your responses are sent back to Telegram via the bot's stream relay
- Your workspace is your current working directory. Other agents live in sibling directories alongside it; check the bot's `config.yaml` (in the main workspace) for the full agent roster and which Telegram chats route to which agent
- Bot tools are available: `bot/scripts/deliver.sh` for Telegram messaging, `launchctl` for cron management
- Pi print-mode crons do not have automatic memory recall. Use `MEMORY.md` as the index and read specific memory files on demand.

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
