# Named sessions and /status formatting

## Goal

Allow users to name sessions via `/rename` for easy console resume (`claude --resume <name>`), and format `/status` output properly so it renders correctly in Telegram.

## Validation Commands

```bash
cd /Users/ninja/src/claude-code-bot/bot
npx tsc --noEmit
npm test
grep -q 'rename' src/telegram-bot.ts  # /rename handler exists
grep -q 'name' src/cli-protocol.ts    # --name flag support exists
```

## Reference: Claude CLI session flags

From `claude --help`:
```
-n, --name <name>                Set a display name for this session (shown in /resume and terminal title)
--session-id <uuid>              Use a specific session ID (must be a valid UUID)
-r, --resume [value]             Resume a conversation by session ID, or open interactive picker with optional search term
```

Key facts:
- `--session-id` requires a valid UUID — arbitrary strings are rejected
- `--name` sets a human-readable display name independently of the UUID
- `--resume <search-term>` matches session names **only in interactive mode** (without `--print`). The bot spawns with `-p` (`--print`), so `--resume` in bot context must always receive a UUID.
- The user's interactive console path (`claude --resume my-name`) uses search-term matching — this is the target use case.
- `--name` can be combined with `--resume <uuid>` to set/update the display name on an existing session.

Note: GitHub issue #34 originally proposed using the name as the session ID. This is not feasible because `--session-id` requires a valid UUID. The correct approach uses `--name` (display name) alongside the existing UUID-based session ID.

## Reference: Current session spawn and storage

`cli-protocol.ts` lines 11-20: `SpawnOptions { agent, sessionId?, resume?, includePartialMessages?, outboxPath?, injectDir? }` — no `name` field.

`cli-protocol.ts` lines 25-76: `buildSpawnArgs()` builds CLI arguments. Passes `--session-id` or `--resume` (lines 66-71) but does NOT pass `--name`.

`session-manager.ts` line 561-580: `resolveStoredSession()` returns `{ resume: boolean; sessionId: string }` — no name tracking. Called at line 165 from `getOrCreateSession()`.

`session-manager.ts` lines 191-198: `spawnClaudeSession()` call builds `SpawnOptions` from `resolveStoredSession()` result — no name passed.

`types.ts` lines 75-80: `SessionState { sessionId, chatId, agentId, lastActivity }` — no name field persisted.

`session-manager.ts` lines 52-63: `SessionHealth { pid, alive, agentId, sessionId, idleMs, processingMs, lastSuccessAt, restartCount }` — no name field exposed to `/status`.

## Reference: Current /status and command registration

`telegram-bot.ts` lines 509-565: `/status` handler builds raw HTML strings with `<b>`, `<code>` tags, sends with `parse_mode: "HTML"`. Bypasses `markdownToHtml()` converter. Space-based alignment between proportional-font labels and monospace `<code>` values doesn't line up on mobile. UUID session ID wraps.

`telegram-bot.ts` lines 27-31: `BOT_COMMANDS` array registers commands with Telegram's UI menu:
```typescript
const BOT_COMMANDS = [
  { command: "start", description: "Start a conversation" },
  { command: "reset", description: "Reset this conversation" },
  { command: "status", description: "Show bot and session status" },
];
```

`markdown-html.ts`: bot's markdown-to-HTML converter handles tables, bold, italic, code, fenced blocks, links. Used by `telegram-adapter.ts` for agent responses but NOT by `/status`.

## Tasks

### Task 1: Add /rename command and --name support (#34, P1)

Sessions have no human-readable names. The only way to resume from console is with a UUID from `sessions.json`. Users need `/rename <name>` so `claude --resume <name>` works from the interactive terminal.

What we want: a `/rename <name>` command that associates a display name with the current session. The name is passed to the Claude CLI via `--name` so that `claude --resume <name>` works in interactive console. The name persists in session store across bot restarts and is automatically passed when respawning sessions.

- [ ] `/rename <name>` sets a display name for the current session
- [ ] After rename, `claude --resume <name>` works from interactive console
- [ ] Session conversation context preserved across rename
- [ ] Name persists in session store across bot restarts
- [ ] Invalid names rejected (empty, whitespace-only, too long)
- [ ] `/rename` without argument shows current session name (or "unnamed")
- [ ] Sessions with a stored name automatically pass `--name` on spawn/respawn
- [ ] `/rename` registered in Telegram command menu
- [ ] Add tests
- [ ] Verify existing tests pass

### Task 2: Format /status output (#34, P2)

`/status` uses raw HTML with space-based alignment that breaks in proportional fonts. Values don't line up on mobile. The bot has a `markdownToHtml()` converter used for all agent responses — `/status` should use it too for consistent rendering.

What we want: `/status` output renders correctly on mobile without alignment issues. Shows session name (if set via `/rename`) instead of raw UUID. If not renamed, shows truncated UUID.

- [ ] `/status` output renders correctly on mobile (no alignment issues from mixed fonts)
- [ ] Session name shown if set, truncated UUID otherwise
- [ ] Output uses the bot's markdown-to-HTML converter for consistent rendering
- [ ] All current info preserved: sessions count, memory, uptime, agent, PID, state, success, restarts
- [ ] Add tests
- [ ] Verify existing tests pass
