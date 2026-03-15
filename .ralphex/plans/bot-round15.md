# Unified HTML Formatting + Polling Resilience — Round 15

## Goal

Four improvements: (1) markdown tables render as `<pre>` blocks in Telegram; (2) deliver.sh uses the same HTML converter as the bot's interactive path; (3) polling liveness watchdog detects silent polling death; (4) message-thread cache persists across restarts.

## Validation Commands

```bash
cd /Users/ninja/.openclaw/bot && npx tsc --noEmit && npm test
```

## Reference: markdown-html.ts (current converter)

```typescript
// src/markdown-html.ts — 113 lines, handles: bold, italic, strikethrough, inline code, fenced code blocks, links
// Does NOT handle markdown tables.

// Main entry point (line 90):
export function markdownToHtml(md: string): string {
  const codeBlockRe = /```([^\n]*)\n([\s\S]*?)```/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(md)) !== null) {
    // Convert text before the code block
    result += convertInline(md.slice(lastIndex, match.index));
    // Convert the code block itself
    const lang = escapeHtml(match[1].trim());
    const code = escapeHtml(match[2].replace(/\n$/, ""));
    result += lang
      ? `<pre><code class="language-${lang}">${code}</code></pre>`
      : `<pre>${code}</pre>`;
    lastIndex = match.index + match[0].length;
  }
  result += convertInline(md.slice(lastIndex));
  return result;
}
```

## Reference: deliver.sh (current delivery script)

```bash
# scripts/deliver.sh — 121 lines
# Uses parse_mode "Markdown" (Telegram v1), retries without parse_mode on failure
# Called by: cron-runner.ts, notify-openclaw.sh, cron agents via bash

send_message() {
  local text="$1"
  local text_json
  text_json=$(echo "$text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
  local response
  response=$(curl -s -X POST "${API}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(build_payload "$text_json" "Markdown")")     # <--- Markdown v1 here

  local ok
  ok=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
  if [ "$ok" != "True" ]; then
    # Retry without parse_mode in case of markdown errors
    response=$(curl -s -X POST "${API}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "$(build_payload "$text_json")")               # <--- plain text fallback
    # ...
  fi
}
```

## Reference: telegram-adapter.ts (interactive path)

```typescript
// src/telegram-adapter.ts — already uses markdownToHtml + parse_mode: "HTML"
// Lines 32-46:
async sendMessage(text: string): Promise<string> {
  const html = markdownToHtml(text);
  try {
    const sent = await ctx.reply(html, { ...threadOpts, parse_mode: "HTML" });
    // ...
  } catch (err) {
    // Falls back to plain text for HTML parse errors
    if (err instanceof Error && /can't parse entities|message is too long/.test(err.message)) {
      const sent = await ctx.reply(text, { ...threadOpts });
      // ...
    }
    throw err;
  }
},
```

## Reference: existing test suite

```
src/__tests__/markdown-html.test.ts — 208 lines
Covers: escapeHtml, bold, bold+italic, italic, strikethrough, inline code, fenced code blocks,
links (including nested parens), HTML special chars, mixed formatting, plain text.
No table tests exist.
```

## Reference: bot polling setup (main.ts + bot-startup.ts)

```typescript
// main.ts lines 76-99 — polling start
startBotWithRetry(
  () =>
    bot.start({
      allowed_updates: ["message", "message_reaction"],
      onStart: async (botInfo) => {
        startedSuccessfully = true;
        clearTimeout(startupTimeout);
        log.info("main", `Telegram bot @${botInfo.username} is running`);
      },
    }),
).catch((err) => {
  log.error("main", "Telegram bot polling failed — exiting for restart:", err);
  process.exit(1);
});

// bot-startup.ts — handles 409 Conflict only
// startBotWithRetry retries up to 5 times with exponential backoff
// BUT: only catches errors from startFn(). Once bot.start() resolves (onStart fires),
// startBotWithRetry is done. If polling silently dies AFTER startup, nothing catches it.

// bot.catch() in telegram-bot.ts (line 790):
bot.catch((err) => {
  log.error("telegram-bot", "Unhandled error:", err.error);
});
// This logs but does NOT restart polling or exit the process.
```

## Reference: message-thread-cache.ts (current in-memory cache)

```typescript
// src/message-thread-cache.ts — 47 lines, plain Map<string, number>
const MAX_CACHE_SIZE = 10_000;
const cache = new Map<string, number>();

function cacheKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function setThread(chatId: number, messageId: number, topicId: number | undefined): void {
  if (topicId === undefined) return;
  if (cache.size >= MAX_CACHE_SIZE) cache.clear();
  cache.set(cacheKey(chatId, messageId), topicId);
}

export function getThread(chatId: number, messageId: number): number | undefined {
  return cache.get(cacheKey(chatId, messageId));
}

export function clearThreadCache(): void { cache.clear(); }
export function threadCacheSize(): number { return cache.size; }

// Shutdown hook location — main.ts lines 36-44:
const shutdown = async (signal: string) => {
  log.info("main", `Received ${signal}, shutting down...`);
  if (telegramBot) telegramBot.stop();
  // ... close sessions, stop metrics
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Cache save should happen inside this shutdown handler, before process.exit(0)
```

## Reference: bot-ac3 diagnosis status

```
Bug: After a getUpdates network failure, grammY long-polling silently stops.
Bot process stays alive (HTTP metrics server responds) but receives no updates.
Only manual restart (launchctl kickstart -k) fixes it.

grammY source review: should auto-recover from network errors (internal retry loop
with 3s sleep). DEBUG=grammy:error,grammy:bot has been enabled since 2026-03-14.
No recurrence captured yet — root cause unconfirmed.

Defensive approach: a liveness watchdog that detects "no updates received in N minutes"
and exits for launchd to restart. This fixes the symptom regardless of root cause.
```

## Tasks

### Task 1: Markdown tables render as `<pre>` blocks (bot-a3q, P2)

Markdown tables (`| col | col |` rows with `|---|---|` separator) are not converted by markdownToHtml. They pass through as raw pipe-delimited text, which Telegram renders poorly — pipes and dashes don't align, columns are unreadable.

The converter already splits on fenced code blocks first. Tables need similar extraction before inline conversion runs, otherwise `|`, `*`, etc. inside table cells get mangled by inline patterns.

What we want: markdown tables are detected and wrapped in `<pre>` tags with content HTML-escaped. Alignment preserved. Non-table text containing `|` (e.g. shell pipes) should not be false-positived.

- [x] Markdown tables with header separator (`|---|`) are converted to `<pre>` blocks
- [x] Table content is HTML-escaped inside `<pre>` (no XSS)
- [x] Non-table text containing `|` is not affected (e.g. `a | b` without table structure)
- [x] Tables inside fenced code blocks are not double-processed
- [x] Add tests for table conversion (basic table, table with formatting in cells, non-table pipes, table inside code block)
- [x] Existing tests pass

### Task 2: deliver.sh uses same HTML converter as bot (bot-a3q, P2)

Two delivery paths exist: the bot's interactive path (telegram-adapter.ts → markdownToHtml → `parse_mode: "HTML"`) and the cron path (deliver.sh → `parse_mode: "Markdown"` v1). They produce different formatting for the same input. Tables would render as `<pre>` in interactive but as raw text in crons.

deliver.sh is a bash script, markdownToHtml is TypeScript. A small CLI wrapper is needed so deliver.sh can pipe text through the converter.

deliver.sh is used by: cron-runner.ts, notify-openclaw.sh, and cron agents calling it directly from bash. All callers pass plain text or markdown. Switching to HTML must not break existing callers.

What we want: deliver.sh pipes text through the markdownToHtml converter, sends with `parse_mode: "HTML"`, falls back to plain text on failure (same pattern as telegram-adapter.ts). A CLI entry point exposes markdownToHtml for shell scripts.

- [x] CLI wrapper exists that reads stdin markdown and outputs HTML (e.g. `npx tsx src/markdown-html-cli.ts`)
- [x] deliver.sh pipes text through the converter before sending
- [x] deliver.sh sends with `parse_mode: "HTML"` instead of `"Markdown"`
- [x] Fallback to plain text (no parse_mode) on HTML parse error still works
- [x] Existing callers (cron-runner.ts, notify-openclaw.sh) produce correct output
- [x] Add test for CLI wrapper (echo markdown | cli → HTML output)
- [x] Existing tests pass

### Task 3: Polling liveness watchdog (bot-ac3, P1)

grammY long-polling silently stops after network failures — the bot process stays alive (metrics server responds, HTTP health checks pass) but receives zero updates. Root cause is unconfirmed (DEBUG logging enabled, awaiting recurrence). Manual `launchctl kickstart -k` is the only recovery.

The bot has no mechanism to detect this state. `bot.catch()` logs errors but doesn't track whether updates are actually flowing. Once `bot.start()` resolves (onStart fires), no code monitors polling health.

What we want: a lightweight liveness check that tracks "last update received" timestamp. If no updates arrive within a configurable threshold (default: 10 minutes), the process exits with a clear log message so launchd restarts it. The watchdog should account for quiet periods (late night, no messages) by using getMe or getUpdates(limit=0) as a heartbeat probe rather than relying solely on incoming messages.

- [ ] A liveness module tracks the timestamp of the last received update
- [ ] Every incoming update (message, reaction, etc.) refreshes the timestamp
- [ ] A periodic check (e.g. every 60s) compares current time vs last update
- [ ] If threshold exceeded, a lightweight Telegram API call (getMe) verifies connectivity
- [ ] If the API call also fails or polling is truly dead, process exits with descriptive log
- [ ] If the API call succeeds (just a quiet period), the watchdog resets without exiting
- [ ] Threshold is configurable (default 10 minutes)
- [ ] Add tests for the liveness module (threshold logic, reset behavior)
- [ ] Existing tests pass

### Task 4: Persist message-thread cache across restarts (bot-rbo, P2)

The message-thread cache (messageId→topicId) is an in-memory Map that's lost on every bot restart. After restart, reactions on pre-restart messages fall back to chat-level routing instead of the correct topic session. This was confirmed on 2026-03-14 — reactions in Minime HQ topics arrived in General session after restart.

The cache is small (max 10K entries, key="chatId:msgId", value=topicId number). It's populated by every message handler and read by the reaction handler.

What we want: on graceful shutdown (SIGTERM/SIGINT), the cache is written to disk. On startup, it's restored. The file should be in a persistent location (not /tmp). If the file is missing or corrupt, the bot starts with an empty cache (no crash). This is a simple serialize/deserialize — no external dependencies.

- [ ] Cache is written to disk on SIGTERM/SIGINT (graceful shutdown)
- [ ] Cache is restored from disk on startup
- [ ] File location is persistent (e.g. `~/.openclaw/bot/data/thread-cache.json`)
- [ ] Missing or corrupt file results in empty cache, not a crash
- [ ] The 10K cap still applies after restore (don't load unbounded data)
- [ ] Add tests for save/restore (round-trip, corrupt file handling, missing file)
- [ ] Existing tests pass
