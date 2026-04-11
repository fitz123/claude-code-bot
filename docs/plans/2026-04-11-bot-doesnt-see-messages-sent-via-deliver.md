# Bot Self-Message Visibility via Echo Directory

## Goal

**What:** Make bot's own outgoing messages sent via `deliver.sh` (and by extension, cron jobs that use it) visible to active agent sessions in chats where `requireMention: false`.

**Why:** When a cron job or cross-agent `deliver.sh` call sends a message to a chat, the agent session managing that chat has no awareness of what was said. This creates context gaps — the agent doesn't know what other parts of the system communicated to the user.

**Success criteria:**
1. When `deliver.sh` sends a message to a chat with a busy agent session, the agent sees the message mid-turn via the existing inject/hook mechanism
2. When `deliver.sh` sends a message to a chat with an idle agent session, the echo message is written to the session's inject directory and picked up by the PreToolUse hook on the next user-initiated turn (no new turn is triggered)
3. Echo loops are impossible by design: only `deliver.sh` writes echo files; the agent's response path (stream-relay -> telegram-adapter -> ctx.reply) never writes echo files
4. The echo watcher module has no Telegram-specific imports; platform-specific routing is done via a callback registered by the platform bot
5. Split messages (>4096 chars) each produce their own echo file; the agent sees them as separate context entries (each chunk is a complete delivered message)
6. Echo writes and user-message inject writes never interfere: the echo watcher writes to a separate `pending-echo` file, not the same `pending` file used by `MessageQueue`

**Non-goals:**
- Echoing the agent's own interactive responses (sent via `relayStream` -> `telegram-adapter`) — the agent already knows what it said
- Echoing messages sent through `bot.api` / grammY transformer — only external deliveries via `deliver.sh`
- Echoing failed delivery attempts — only successfully sent messages are echoed
- Triggering new agent turns for echo messages — echo is context-only, delivered passively via inject files

## Context

- **Files involved:**
  - `bot/scripts/deliver.sh` — standalone bash script, sends via direct `curl` to Telegram Bot API
  - `bot/src/inject-file.ts` — file-based IPC for mid-turn message injection (write `pending`, hook reads it)
  - `bot/src/message-queue.ts` — `MessageQueue` class with debounce and mid-turn collect
  - `bot/src/session-manager.ts` — `SessionManager`, manages active sessions, `injectDir` paths
  - `bot/src/telegram-bot.ts` — `createTelegramBot()`, `sessionKey()`, `resolveBinding()`
  - `bot/src/main.ts` — bot entry point, startup orchestration
  - `bot/src/types.ts` — `PlatformContext`, `TelegramBinding`, `BotConfig`
  - `.claude/hooks/inject-message.sh` — PreToolUse hook that reads inject files

- **Related patterns:**
  - Outbox directory (`/tmp/bot-outbox/<chatId>/`) — agent writes files, bot sends them after turn; same file-based IPC pattern
  - Inject directory (`/tmp/bot-inject/<sessionKey>/`) — bot writes `pending`, hook reads and acks; reused for echo delivery
  - `writeInjectFile()` atomic write protocol (tmp file + rename)

- **Dependencies + pinned versions:** No new dependencies required. Uses existing `node:fs`, `node:path`, `node:timers` (`setInterval`).

- **Key terminology:**
  - `injectDirForChat(key)` — despite the parameter being named `chatId`, it actually accepts a **session key** string (output of `sessionKey()`). For a chat with topic, the session key is `"chatId:topicId"`, which gets sanitized to `"chatId_topicId"` for the directory name. Always pass `sessionKey()` output, not a raw numeric chatId.

## Validation Commands

```bash
# Run all tests
npm test

# Run specific test files for changed modules
node --import tsx --test bot/src/__tests__/echo-watcher.test.ts

# Lint
npx eslint bot/src/

# Type-check
npx tsc --noEmit

# Manual integration test: send a deliver.sh message and verify echo file appears
bot/scripts/deliver.sh <chat-id> "test echo"
ls -la /tmp/bot-echo/<chat-id>/
```

## Decisions

1. **Architecture:** deliver.sh writes echo JSON files to `/tmp/bot-echo/<chatId>/` after each successful send. The bot polls the echo directory and routes messages to the correct session's inject directory.

2. **Scope:** Only external deliveries (deliver.sh/cron). The agent's own interactive responses (sent via stream-relay -> telegram-adapter -> ctx.reply) are NOT echoed back.

3. **Idle sessions:** Write the echo-framed message directly to the session's inject directory (`/tmp/bot-inject/<sessionKey>/pending-echo`). The message sits there until the next user-initiated turn, when the PreToolUse hook fires and picks it up. No new turn is triggered, no NullPlatform needed, no token cost.

4. **Busy sessions:** Same as idle — write to the inject directory's `pending-echo` file. Since the session is mid-turn, the PreToolUse hook fires on the next tool call and picks it up immediately. This reuses the existing inject mechanism identically.

5. **Loop prevention:** Structural, not tag-based. Only `deliver.sh` writes echo files. The agent's response flows through stream-relay -> telegram-adapter -> ctx.reply, which does NOT write echo files. Therefore, no echo loop can form by design. No origin-check code is needed.

6. **Watcher mechanism:** Polling-only via `setInterval` scanning echo dirs every 2 seconds. No `fs.watch`. Latency tolerance is high for context-only messages, and polling eliminates macOS `fs.watch` edge cases with nested directories (duplicate events, missed events under load).

7. **IPC from echo watcher to session — separate `pending-echo` file:** The echo watcher writes to a **separate** `pending-echo` file in the session's inject directory, NOT the same `pending` file used by `MessageQueue.writeInject()`. This eliminates the race condition where an echo write and a user-message inject write could overwrite each other. `MessageQueue` owns `pending`; the echo watcher owns `pending-echo`. They never interfere.

8. **Hook reads both files:** The `inject-message.sh` hook is updated to check **both** `pending` and `pending-echo`. It processes `pending` first (user messages, framed as "LIVE MESSAGE"), then `pending-echo` (echo messages, framed as "CONTEXT UPDATE"). Both use the same atomic claim mechanism (`mv` to `.claimed`). If both exist, their content is concatenated into a single `additionalContext` response.

9. **Echo accumulation:** When the echo watcher processes multiple echo files for the same session key in a single poll cycle, it accumulates all their texts and writes them all in a single `pending-echo` file. This prevents serial overwrites when processing split messages or rapid-fire deliveries.

10. **Hook framing (required):** The inject-message.sh hook detects `[Bot echo` prefix in the `pending-echo` content and uses "CONTEXT UPDATE" framing instead of "LIVE MESSAGE from the user". Since echo content always comes from `pending-echo` (never from `pending`), the detection is structural: `pending-echo` content always gets "CONTEXT UPDATE" framing, `pending` content always gets "LIVE MESSAGE" framing. A comment in both `echo-watcher.ts` and `inject-message.sh` cross-references the shared `[Bot echo` prefix constant.

11. **[ASSUMED] Echo directory base path:** `/tmp/bot-echo` — mirrors existing `/tmp/bot-inject` and `/tmp/bot-outbox` naming convention. Risk-if-wrong: trivial to change (single constant).

12. **[ASSUMED] Echo file format:** One JSON file per delivery containing `{chatId, threadId?, text, origin, timestamp}`. File naming uses `$(date +%s)-$$-$RANDOM.json` (macOS-compatible, no `%N` nanoseconds). Risk-if-wrong: if delivery rate is extremely high, directory could accumulate files — mitigated by immediate cleanup after processing.

13. **[ASSUMED] Context-only framing text:** `[Bot echo — context only, no reply needed]` (~40 chars). Short to minimize overhead. The agent does not need to know it was deliver.sh or cron — just that it's an echo.

## Assumptions

1. `deliver.sh` is the only external delivery path — cron-runner.ts uses it internally, so covering deliver.sh covers all external deliveries. Evidence: `cron-runner.ts:227-242` calls `deliver()` which calls deliver.sh via `execSync`.

2. The inject mechanism (writeInjectFile + inject-message.sh hook) is reliable for mid-turn delivery. Evidence: it has been in production for user message injection with full ack/dedup protocol.

3. Writing to an echo directory when no bot is running is harmless — files accumulate until the bot starts and processes them, or until `/tmp` is cleaned. Evidence: same pattern as inject files which persist when no session exists.

4. deliver.sh split messages (>4096 chars) each write their own echo file. The echo watcher processes them individually. Each chunk is a complete delivered message fragment.

5. `deliver.sh`'s `--thread` value matches the `topicId` used in `sessionKey()` — both represent Telegram's `message_thread_id`. Evidence: deliver.sh passes `THREAD_ID` as `message_thread_id` in the API payload (line 71); the bot extracts `topicId` from `ctx.msg?.message_thread_id`.

6. `cleanupInjectDir()` on session create (session-manager.ts:197) may clear recently-written `pending-echo` files. This is acceptable: a fresh session gets clean state, and context from before the session existed is genuinely stale. This is a known limitation, not a bug.

## Risk Register

| Risk | Severity | Mitigation | Rollback |
|------|----------|------------|----------|
| Agent ignores "context only" framing and responds to echoed message | MED | Short framing text, hook uses "CONTEXT UPDATE" not "LIVE MESSAGE". Agent response goes through grammY, which never writes echo files, so no loop | Acceptable degradation — extra responses are annoying but not harmful |
| Echo watcher writes to `pending-echo` while hook is mid-claim on `pending` | LOW | They operate on different files (`pending` vs `pending-echo`). The hook claims each file independently via atomic `mv`. No interference possible by design | N/A — files are independent |
| deliver.sh race condition: echo file written but bot crashes before processing | LOW | On startup, bot processes any existing echo files (drain on init). Files are harmless stale context at worst | Files persist in `/tmp`; cleaned on next boot or OS cleanup |
| High-frequency cron deliveries flood echo dir | LOW | Process and delete files immediately; watcher is async and non-blocking. 2s polling means at most ~30 files accumulate per minute | Rate-limit echo processing if needed |
| Stale inject files from echo writes to chats with no active session | LOW | `cleanupInjectDir()` is called when a session is created or destroyed (session-manager.ts:197,438,619). Stale files are cleaned on next session create. Between sessions, files sit harmlessly. | No action needed — harmless |
| deliver.sh `python3` fails or text breaks command-line arg passing | LOW | `write_echo` is wrapped with `|| true` — failure is non-fatal. The echo watcher skips malformed files (parse error → skip). The delivery itself is unaffected. | Echo silently lost for that delivery, no user impact |
| Multiple echo files processed serially overwrite `pending-echo` | LOW | The echo watcher accumulates all echo messages for the same session key before writing a single `pending-echo` file per poll cycle. No overwrites between files | N/A — accumulation prevents overwrites |

## Tasks

### Task 1: Add echo writing to `deliver.sh` [HIGH] `[confidence: 0.95]`

**Goal:** After each successful Telegram API send, deliver.sh writes an echo file so the bot can pick it up and route to the appropriate agent session.

**Files:**
- Modify: `bot/scripts/deliver.sh`

**Steps:**
- [x] After the `LOG_DIR` setup block (line ~64), add `ECHO_DIR_BASE="/tmp/bot-echo"` constant
- [x] Create a `write_echo()` function that takes three arguments: `chatId`, `threadId`, `text`. Implementation:
  - (a) Derives echo dir: `echo_dir="$ECHO_DIR_BASE/$chatId"` (no sanitization needed — chatId is already validated as numeric on line 21, and threadId is validated as numeric on line 31)
  - (b) Creates directory: `mkdir -p "$echo_dir"`
  - (c) Generates unique filename: `fname="$(date +%s)-$$-$RANDOM.json"` (macOS-compatible — no `%N` nanoseconds)
  - (d) Builds JSON using `printf` for the structure and `python3` only for safe text escaping: `python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$text"` to get the escaped text, then assemble the JSON with `printf '{"chatId":"%s","threadId":%s,"text":%s,"origin":"deliver.sh","timestamp":%s}' "$chatId" "${threadId_json}" "${escaped_text}" "$(date +%s)"`. For `threadId_json`: if `$threadId` is empty, use `null`; otherwise use `"$threadId"`. Note: `python3` is already a dependency of deliver.sh (used at lines 85, 89, 99, 103 for JSON operations).
  - (e) Writes atomically: write to `"$echo_dir/.$fname.tmp"`, then `mv` to `"$echo_dir/$fname"`
  - (f) The `text` field contains the original pre-conversion markdown text (not HTML)
- [x] Call `write_echo "$CHAT_ID" "$THREAD_ID" "$1"` **inside** `send_message()`. Two locations:
  - After the success log on line 91, before `return 0` on line 92 (HTML-conversion success path)
  - After the success log on line 110, before the implicit function end (fallback success path). Add an explicit `return 0` after the `write_echo` call for clarity.
  - Note: exact line numbers may shift after edits — reference the pattern: after the `echo "[deliver] ... OK ..."` log line and before `return 0` in each success branch.
- [x] For split messages: `send_message` is called per chunk, so each chunk naturally writes its own echo file (no additional logic needed)
- [x] Wrap `write_echo` calls with `|| true` so echo write failures are non-fatal and don't break message delivery
- [x] Update the `deliver.sh` header comment to mention echo file writing
- [x] Verify macOS compatibility: test that `date +%s`, `$$`, `$RANDOM` produce unique filenames

### Task 2: Create echo watcher module (`bot/src/echo-watcher.ts`) [HIGH] `[confidence: 0.90]`

**Goal:** A module that polls `/tmp/bot-echo/` for new echo files, accumulates messages per session key, frames them with context-only text, and writes them to the appropriate session's inject directory via a new `writeEchoInjectFile()` function that writes to `pending-echo` (not `pending`).

**Files:**
- Create: `bot/src/echo-watcher.ts`
- Modify: `bot/src/inject-file.ts` (add `writeEchoInjectFile()`)

**Steps:**
- [x] In `inject-file.ts`: add a new exported function `writeEchoInjectFile(dir: string, messages: string[]): void` that writes to `pending-echo` instead of `pending`. Implementation is identical to `writeInjectFile()` except:
  - Uses `join(dir, "pending-echo")` instead of `join(dir, "pending")`
  - Uses a `.pending-echo.*.tmp` pattern for the temp file
  - This ensures echo writes never collide with user-message inject writes
- [x] In `echo-watcher.ts`: define and export `ECHO_DIR_BASE = "/tmp/bot-echo"` constant
- [x] Define and export `ECHO_PREFIX = "[Bot echo"` — the shared prefix constant used for detection in both TypeScript and bash. Add a comment: `// This prefix is also checked in .claude/hooks/inject-message.sh — keep in sync`
- [x] Define and export `EchoMessage` interface: `{ chatId: string; threadId?: string | null; text: string; origin: string; timestamp: number }`
- [x] Define `EchoHandler` callback type: `(chatId: string, threadId: string | undefined, text: string) => void`
- [x] Implement `EchoWatcher` class with constructor: `{ handler: EchoHandler; pollIntervalMs?: number }` (default pollIntervalMs = 2000)
- [x] Implement `start(): void`:
  - Creates `ECHO_DIR_BASE` directory if it doesn't exist (`mkdirSync(ECHO_DIR_BASE, { recursive: true })`)
  - Starts `setInterval` polling timer that calls `pollAll()`
  - No `fs.watch` — polling only
- [x] Implement private `pollAll(): void`:
  - Lists subdirectories in `ECHO_DIR_BASE` (each is a chatId)
  - For each subdirectory, calls `processDir(subdirPath)`
- [x] Implement private `processDir(chatDir: string): void`:
  - Lists `.json` files in the directory, sorted by name (timestamp-based, oldest first)
  - Groups messages by handler-resolved session key: for each file, reads and parses JSON as `EchoMessage` (skip on parse error), calls the `handler` callback. Note: the handler is called once per echo file — accumulation into a single `pending-echo` write happens in the handler callback (Task 3), not here.
  - Deletes each file after successful handler call (`unlinkSync`, ignore errors)
  - Log and continue on individual file errors — don't crash the watcher
- [x] Implement `drain(): void` — synchronously processes all existing echo files (calls `pollAll()` once). Called on startup to handle files accumulated while bot was down
- [x] Implement `stop(): void` — clears the polling interval
- [x] No Telegram-specific imports in this module — routing is handled by the callback
- [x] Write tests: mock handler, write echo files to temp dir, verify handler is called with correct args, verify files are cleaned up after processing
- [x] Run tests — must pass before next task

### Task 3: Integrate echo watcher with inject directory routing [HIGH] `[confidence: 0.85]`

**Goal:** Wire the echo watcher into the bot so echoed messages are written to the correct session's inject directory, where the PreToolUse hook picks them up. Handle accumulation of multiple echo messages per session key to prevent `pending-echo` overwrites.

**Files:**
- Modify: `bot/src/telegram-bot.ts`
- Modify: `bot/src/main.ts`

**Steps:**
- [x] In `telegram-bot.ts`: import `EchoWatcher` from `./echo-watcher.js` and import `injectDirForChat`, `writeEchoInjectFile` from `./inject-file.js`
- [x] In `createTelegramBot()`: after creating the `messageQueue`, create an `EchoWatcher` instance. The handler callback is a closure inside `createTelegramBot()` and has access to `config`, `resolveBinding`, `sessionKey`, and other imports in scope. The handler does the following:
  - (a) Converts `chatId` to number: `const numericChatId = parseInt(chatId, 10)` — echo files have string chatId, but `resolveBinding()` expects numeric chatId
  - (b) Converts `threadId` to number if present: `const numericThreadId = threadId ? parseInt(threadId, 10) : undefined` — `threadId` in deliver.sh maps 1:1 to `topicId` (both are Telegram's `message_thread_id`). Note: JSON `null` becomes JS `null`, which is falsy, so `null ? parseInt(...) : undefined` correctly yields `undefined`.
  - (c) Looks up binding: `const binding = resolveBinding(numericChatId, config.bindings, numericThreadId)`
  - (d) Skips if no binding found
  - (e) Skips if `binding.requireMention !== false` — only echo to sessions that process all messages
  - (f) Derives session key: `const key = sessionKey(numericChatId, numericThreadId)` — this is the session key, used as input to `injectDirForChat()`
  - (g) Derives inject directory: `const injectDir = injectDirForChat(key)` — note: `injectDirForChat()` accepts the session key string (output of `sessionKey()`), not a raw numeric chatId. The parameter name `chatId` in the function signature is misleading.
  - (h) Creates inject dir if needed: `mkdirSync(injectDir, { recursive: true })`
  - (i) Frames the text: `const framedText = "[Bot echo — context only, no reply needed]\n\n" + text`
  - (j) Writes to echo inject file: `writeEchoInjectFile(injectDir, [framedText])` — writes to `pending-echo`, not `pending`
- [x] **Accumulation for multiple echoes per session key:** To prevent serial `writeEchoInjectFile()` calls from overwriting each other within a single poll cycle, the handler should accumulate messages per session key. Implementation approach: instead of calling `writeEchoInjectFile()` immediately per handler call, the EchoWatcher's `processDir()` should be refactored: after processing all files in a chatDir, group the resolved `(injectDir, framedText)` pairs by injectDir. Then call `writeEchoInjectFile(injectDir, allFramedTexts)` once per unique injectDir. This ensures split messages and rapid-fire deliveries are written as a single `pending-echo` file.
  - Alternative simpler approach: since the handler callback is called once per file, the handler can maintain a `Map<string, string[]>` accumulator that the watcher flushes after processing each chatDir. The watcher calls a `flushAccumulated()` method after `processDir()` returns, which calls `writeEchoInjectFile()` once per accumulated session key.
- [x] Add `echoWatcher` to the return value of `createTelegramBot()` so `main.ts` can manage its lifecycle
- [x] Update the `TelegramBotResult` type to include `echoWatcher: EchoWatcher`
- [x] In `main.ts`: after creating the Telegram bot, call `echoWatcher.drain()` to process any accumulated echo files, then call `echoWatcher.start()` to begin polling
- [x] In `main.ts` shutdown handler: call `echoWatcher.stop()` before closing sessions (add to the `shutdown()` function)
- [x] Write tests: write an echo file, verify the handler resolves the correct binding, converts types, derives the correct inject dir, and calls `writeEchoInjectFile` with proper framing to `pending-echo`
- [x] Run tests — must pass before next task

### Task 4: Update inject-message.sh hook for `pending-echo` support [HIGH] `[confidence: 0.90]`

**Goal:** The hook reads both `pending` (user messages) and `pending-echo` (echo messages), using appropriate framing for each. Both files are claimed and processed independently.

**Files:**
- Modify: `.claude/hooks/inject-message.sh`

**Steps:**
- [x] Restructure the hook to handle two files independently. After the existing `pending` handling (claim, read, ack), add a similar block for `pending-echo`:
  ```bash
  # --- Echo messages (from deliver.sh/cron via echo watcher) ---
  # Prefix must match ECHO_PREFIX in bot/src/echo-watcher.ts — keep in sync
  pending_echo="$dir/pending-echo"
  echo_content=""
  if [[ -f "$pending_echo" ]]; then
    if mv "$pending_echo" "$pending_echo.claimed" 2>/dev/null; then
      echo_count=$(head -1 "$pending_echo.claimed")
      echo_content=$(tail -n +2 "$pending_echo.claimed")
      rm -f "$pending_echo.claimed"
      # Echo messages do NOT update the ack counter — they are not tracked
      # by MessageQueue's collectBuffer and don't need dedup
    fi
  fi
  ```
- [x] Build the `framed` output by combining both sources:
  - If only `pending` has content: use existing "LIVE MESSAGE" framing (unchanged)
  - If only `pending-echo` has content: use "CONTEXT UPDATE" framing:
    ```
    CONTEXT UPDATE (a message was sent in this chat while you were working):

    $echo_content
    ```
  - If both have content: concatenate with separator — `pending` framed as "LIVE MESSAGE" first, then `pending-echo` framed as "CONTEXT UPDATE"
  - If neither has content: `exit 0` (no output)
- [x] The `pending` file handling (claim, read, ack) remains unchanged from current behavior — only echo handling is new
- [x] Ensure the ack counter only counts `pending` messages (user messages), not `pending-echo` messages. Echo messages bypass `MessageQueue` entirely and don't participate in the ack/dedup protocol.
- [x] Add a comment at the top of the echo block: `# Prefix must match ECHO_PREFIX in bot/src/echo-watcher.ts — keep in sync`
- [x] Test the hook in isolation:
  - Write a `pending` file with normal content → verify "LIVE MESSAGE" framing
  - Write a `pending-echo` file with echo content → verify "CONTEXT UPDATE" framing
  - Write both files → verify both are included in output
  - Write neither → verify clean exit
- [x] Run tests — must pass before next task

### Task 5: Verify acceptance criteria [HIGH]

- [ ] **Verify criterion 1 (busy session):** deliver.sh sends a message -> echo file created in `/tmp/bot-echo/<chatId>/` -> echo watcher polls and processes it -> calls handler -> handler writes to inject dir `/tmp/bot-inject/<sessionKey>/pending-echo` with `[Bot echo]` framing -> PreToolUse hook fires on next tool call -> reads `pending-echo` -> agent sees "CONTEXT UPDATE" with the message
- [ ] **Verify criterion 2 (idle session):** Same as criterion 1 — the echo-framed message is written to the inject dir's `pending-echo`. It sits there until the next user message triggers a turn and the hook fires. No new turn is spawned for the echo.
- [ ] **Verify criterion 3 (no echo loops):** Trace the agent response path: agent responds -> stream-relay -> telegram-adapter -> ctx.reply (grammY) -> Telegram API. None of these steps write to `/tmp/bot-echo/`. Only `deliver.sh` writes echo files. Therefore, no loop can form.
- [ ] **Verify criterion 4 (platform-agnostic):** `echo-watcher.ts` has no Telegram-specific imports. It exports a callback-based handler. The Telegram-specific routing (resolveBinding, sessionKey, parseInt) is in the callback registered in `telegram-bot.ts`.
- [ ] **Verify criterion 5 (split messages):** In deliver.sh, split messages call `send_message` per chunk. Each `send_message` call writes its own echo file via `write_echo`. The watcher processes them individually, accumulates them per session key, and writes a single `pending-echo` file. Each chunk appears as a separate entry in the inject content.
- [ ] **Verify criterion 6 (no file collision):** Echo watcher writes to `pending-echo`. MessageQueue writes to `pending`. The hook reads both independently. Verify by: writing to both files simultaneously, confirming both are consumed without data loss.
- [ ] Run full test suite: `npm test`
- [ ] Run linter: `npx eslint bot/src/`
- [ ] Run type-check: `npx tsc --noEmit`

### Task 6: Update documentation [MED]

- [ ] Add JSDoc comments to all public functions and types in `echo-watcher.ts`
- [ ] Add JSDoc to `writeEchoInjectFile()` in `inject-file.ts` explaining its relationship to `writeInjectFile()` and why they use separate files
- [ ] Update `bot/scripts/deliver.sh` header comment to mention echo file writing
- [ ] Add a brief architecture note in the plan's completion section explaining the echo flow:
  `deliver.sh -> /tmp/bot-echo/<chatId>/ -> EchoWatcher (polling) -> writeEchoInjectFile() to /tmp/bot-inject/<sessionKey>/pending-echo -> PreToolUse hook (inject-message.sh) -> agent sees "CONTEXT UPDATE"`

## Revision Diff

Summary of changes from round 2 to round 3:

### Fixed: Inject file overwrite race (CRITICAL — both validators flagged)

- **Round 2:** The echo watcher and MessageQueue both used `writeInjectFile()` which writes to the same `pending` file. One overwrites the other. This is a data loss bug under normal operating conditions (echo arrives while user message is mid-turn injected, or vice versa).
- **Round 3:** Echo watcher writes to a **separate** `pending-echo` file via a new `writeEchoInjectFile()` function in `inject-file.ts`. MessageQueue continues to own `pending`. They never interfere. The `inject-message.sh` hook is updated to read **both** files independently: `pending` gets "LIVE MESSAGE" framing, `pending-echo` gets "CONTEXT UPDATE" framing. Both use the same atomic claim mechanism (`mv` to `.claimed`). If both exist, their content is concatenated into a single `additionalContext` response. Echo messages do NOT update the ack counter (they bypass MessageQueue's collectBuffer entirely).

### Fixed: `injectDirForChat` parameter naming (MAJOR — completeness validator)

- **Round 2:** Task 3 correctly passed `sessionKey()` output to `injectDirForChat()` but did not call out the misleading parameter name.
- **Round 3:** Added explicit documentation in the Context section: `injectDirForChat(key)` accepts a **session key** string (output of `sessionKey()`), not a raw numeric chatId. The parameter name `chatId` in the function signature is misleading. Task 3 step (g) includes a clarifying comment.

### Fixed: Echo accumulation for split messages (MAJOR — scope validator)

- **Round 2:** The echo watcher called `writeInjectFile()` (now `writeEchoInjectFile()`) once per echo file. For split messages (3 chunks), the second write would overwrite the first before the hook fires, and the third overwrites the second. Agent only sees the last chunk.
- **Round 3:** The echo watcher accumulates all echo messages for the same session key within a single poll cycle and writes them all in a single `writeEchoInjectFile()` call. Task 3 documents the accumulation approach: the handler maintains a `Map<string, string[]>` accumulator flushed after each chatDir is processed.

### Fixed: deliver.sh python3 dependency for JSON (MINOR — both validators noted)

- **Round 2:** Used `python3` for full JSON construction including structure.
- **Round 3:** Uses `printf` for the JSON structure and `python3` only for safe text escaping (necessary for arbitrary user content with quotes, newlines, special characters). Documented that `python3` is already a hard dependency of deliver.sh (used at lines 85, 89, 99, 103).

### Fixed: deliver.sh `return 0` location documentation (MINOR — completeness validator)

- **Round 2:** Referenced specific line numbers (92 and 110) which may shift after edits.
- **Round 3:** References the pattern ("after the success log `echo "[deliver] ... OK ..."` and before `return 0`") rather than specific line numbers. Notes that the fallback path (line 110) has no explicit `return 0` — the plan adds one for clarity.

### Added: `cleanupInjectDir()` race note (MINOR — completeness validator)

- **Round 2:** Mentioned stale file cleanup in the risk register but didn't call out that recently-written `pending-echo` files could be lost on session create.
- **Round 3:** Added Assumption #6 explicitly documenting this as a known, acceptable limitation: a fresh session gets clean state, and context from before the session existed is genuinely stale.

### Added: Hook framing cross-reference comments (MINOR — scope validator)

- **Round 2:** The `[Bot echo` prefix detection had no cross-reference between the TypeScript constant and the bash detection.
- **Round 3:** Task 2 exports `ECHO_PREFIX = "[Bot echo"` constant with a comment referencing `inject-message.sh`. Task 4 adds a comment in the hook referencing `echo-watcher.ts`. Both locations explicitly state "keep in sync".

### Added: Success criterion #6 (file collision prevention)

- **Round 3:** New success criterion explicitly stating that echo writes and user-message inject writes never interfere, backed by the separate `pending-echo` file design.
