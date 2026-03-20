# Add /rename command for named sessions

## Goal

Add `/rename <name>` command so users can name sessions and resume them from console via `claude --resume <name>`.

## Validation Commands

```bash
cd ./bot
npx tsc --noEmit
npm test
```

## Reference: Claude CLI --name flag

```
-n, --name <name>    Set a display name for this session (shown in /resume and terminal title)
--session-id <uuid>  Use a specific session ID (must be a valid UUID)
-r, --resume [value] Resume by session ID, or open interactive picker with optional search term
```

`--name` sets a display name independently of the UUID. `claude --resume <name>` matches by display name in interactive mode. `--name` can be combined with `--resume <uuid>`.

## Reference: Current code

`cli-protocol.ts` lines 11-20: `SpawnOptions` — no `name` field. `buildSpawnArgs()` (lines 25-76) does not pass `--name`.

`types.ts` lines 75-80: `SessionState { sessionId, chatId, agentId, lastActivity }` — no name stored.

`telegram-bot.ts` lines 27-31: `BOT_COMMANDS` registers start, reset, status — no rename.

## Tasks

### Task 1: Add /rename command (#34, P1)

No way to name sessions. Users must use UUIDs to resume from console. `/rename <name>` should associate a display name with the session and pass it to the CLI via `--name`.

What we want: `/rename <name>` command that names the current session. The name is passed to the Claude CLI as `--name` so `claude --resume <name>` works from interactive console. Session ID stays UUID, internal routing unchanged.

- [x] `/rename <name>` command exists and responds with confirmation
- [x] `claude --resume <name>` works from interactive console after rename
- [x] Name persists across bot restarts
- [x] `/rename` without argument shows current session name
- [x] Invalid names rejected (empty, whitespace-only)
- [x] `/rename` registered in Telegram command menu
- [x] `/status` shows session name when set
- [x] Add tests
- [x] Verify existing tests pass
