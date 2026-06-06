# Runtime Context

You are running as a **coding-agent backend** spawned by the Telegram/Discord bot. Interactive sessions and scheduled LLM crons use Pi/Codex.

## How you were started

- The Telegram/Discord bot spawned your process through Pi RPC (`pi --mode rpc`) for interactive sessions, or Pi print mode for LLM crons
- Messages arrive from Telegram, routed through bot bindings to your session
- Each chat gets its own backend process with separate conversation context
- Pi uses its own auth in `~/.pi/agent/auth.json`; the bot does not manage coding-agent OAuth tokens.

## What this means

- Your exact tools depend on the Pi spawn mode. Interactive Pi RPC sessions load the bot's Pi extensions. Pi print-mode crons load only the A1 guard extension and do not have A2/A3/browser/MCP/subagent parity.
- You are NOT running in a terminal. Messages come from Telegram users, not a keyboard
- Your responses are sent back to Telegram via the bot's stream relay
- Your workspace is your current working directory. Other agents live in sibling directories alongside it; check the bot's `config.yaml` (in the main workspace) for the full agent roster and which Telegram chats route to which agent
- Bot tools are available: `bot/scripts/deliver.sh` for Telegram messaging, `launchctl` for cron management
- Pi print-mode crons do not have automatic memory recall. Use `MEMORY.md` as the index and read specific memory files on demand.

## Session transcripts

Session transcript storage depends on the active harness. Pi-backed bot sessions are not Claude Code CLI sessions, so do not assume Claude Code transcript paths exist for them.

## Delegation

- Use the available Pi subagent/delegation tools when present; do NOT use obsolete `sessions_spawn`
- For cron/scheduled tasks: launchd plists in `~/Library/LaunchAgents/`
- For one-off delayed tasks: `at` command or launchd one-shot plist
