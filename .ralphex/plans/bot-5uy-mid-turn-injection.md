# Mid-Turn Message Injection — bot-5uy

## Goal

Allow user messages sent during an active Claude turn to reach the agent between tool calls, enabling mid-turn course correction instead of waiting for the entire turn to complete.

## Validation Commands

```bash
cd /Users/user/.openclaw/bot && npx tsc --noEmit && npm test
```

## Reference: Current collect buffer behavior

When `state.busy === true`, new messages go into `state.collectBuffer`. After the turn completes, `drainCollectBuffer()` sends them as the next turn with `[Queued messages while agent was busy]` header. The user cannot steer mid-turn.

`src/message-queue.ts` lines 156-180 — collect buffer drain:
```typescript
private async drainCollectBuffer(): Promise<void> {
  while (this.state.collectBuffer.length > 0) {
    const collected = this.state.collectBuffer.splice(0, this.state.collectBuffer.length);
    const prompt = this.buildCollectPrompt(collected);
    this.state.busy = true;
    try {
      await this.processFn(prompt);
    } finally {
      this.state.busy = false;
    }
  }
}
```

## Reference: buildSpawnEnv() in cli-protocol.ts

Currently sets no custom env vars beyond deleting `CLAUDECODE` and ensuring `/opt/homebrew/bin` in PATH:

```typescript
export function buildSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const brew = "/opt/homebrew/bin";
  if (env.PATH && !env.PATH.includes(brew)) {
    env.PATH = `${brew}:${env.PATH}`;
  }
  return env;
}
```

The bot knows the `chatId` for each session — it's available in `SessionManager` and passed through the spawn chain.

## Reference: Claude Code PreToolUse hook API

Hook input (stdin JSON):
```json
{
  "session_id": "abc123",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "cwd": "/Users/user/.minime/workspace"
}
```

Hook output (stdout JSON, exit code 0):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "String injected into Claude's context before tool executes"
  }
}
```

Key fields:
- `additionalContext` — injected into Claude's conversation context (Claude sees it)
- `systemMessage` — shown to user only (Claude does NOT see it)
- Exit code 0 = success, stdout JSON parsed. Exit code 2 = block tool call.

## Reference: Current hooks in workspace settings

`.claude/settings.json` has PreToolUse hooks with matcher `"Edit|Write"` for `protect-files.sh` and `guardian.sh`. A new wildcard (`"*"`) matcher would fire on every tool call. The fast path (no pending message) must be sub-millisecond to avoid slowing down all tool calls.

## Reference: Stream-json user message format

```json
{
  "type": "user",
  "message": { "role": "user", "content": "<text>" },
  "parent_tool_use_id": null,
  "session_id": "<uuid>"
}
```

Writing a user message to stdin during an active turn does NOT inject it into the current turn — CLI queues it for the next turn. This is a known limitation: https://github.com/anthropics/claude-code/issues/30492

## Tasks

### Task 1: Bot-side inject file writing (bot-5uy, P1)

When the user sends a message during an active turn, the bot currently only buffers it in memory (collect buffer) for delivery after the turn. We want the bot to also write these messages to a file on disk so that a Claude Code hook can pick them up mid-turn.

The bot needs to:
- Set an environment variable at Claude subprocess spawn time so the hook knows which file to read
- Write queued messages to that file atomically (no partial reads)
- Handle multiple messages arriving between tool calls (append, preserve order)
- The chatId is the natural session identifier (one Claude process per chat)

What we want: messages sent while busy are persisted to a known file path, atomically, in addition to the existing collect buffer.

- [ ] An environment variable identifying the inject file path is set when spawning the Claude subprocess
- [ ] Messages sent while `state.busy === true` are written to the inject file atomically (no partial reads possible)
- [ ] Multiple messages between tool calls are preserved in order
- [ ] Existing collect buffer behavior is unchanged (inject file is additive, not a replacement)
- [ ] Add tests for inject file writing (single message, multiple messages, atomic write)
- [ ] Verify existing tests pass

### Task 2: PreToolUse hook + integration (bot-5uy, P1)

There is no mechanism for Claude to see user messages mid-turn. We want a PreToolUse hook that checks for the inject file before every tool call and, if present, injects the message contents into Claude's context via `additionalContext`.

The hook must be:
- Fast on the common path (no message waiting) — a single file existence check + exit
- Written as a shell script for minimal startup overhead
- Registered in workspace `.claude/settings.json` as a wildcard (`"*"`) PreToolUse hook
- Framed so Claude understands these are real-time user messages requiring acknowledgment

After the turn completes, the bot needs to avoid delivering the same messages twice (via both inject file and collect buffer).

- [ ] A PreToolUse wildcard hook exists and fires before every tool call
- [ ] When no inject file exists, the hook exits quickly with no output (fast path)
- [ ] When inject file exists, contents are returned as `additionalContext` and file is consumed (deleted)
- [ ] The injected context is framed so Claude recognizes it as a live user message (not informational noise)
- [ ] After turn completes, messages already consumed by the hook are not re-delivered via collect buffer
- [ ] Hook is registered in workspace `.claude/settings.json` with wildcard matcher
- [ ] Add tests for the hook (no-op path, single message injection, multi-message, dedup with collect buffer)
- [ ] Verify existing tests pass
