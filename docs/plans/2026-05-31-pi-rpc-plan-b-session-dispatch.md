# Pi RPC Integration — Plan B (session-manager dispatch)

> **STATUS: ready to run (plan-readiness GO_WITH_FIXES applied 2026-05-31, run wrl7hok7v).** Plan A is MERGED (PR #130) on `main`. This file moves to `~/src/claude-code-bot/docs/plans/2026-05-31-pi-rpc-plan-b-session-dispatch.md` and runs via ralphex (claude opus-4.8 executor + codex gpt-5.5 external review) on branch `feature/pi-rpc-plan-b`. Built to the `planning:make` canonical structure.
>
> **Aligned against the MERGED tree (read 2026-05-31).** Real `pi-rpc-protocol.ts` exports: `NewlineOnlyJsonlSplitter`, `buildPiSpawnArgs(agent)`, `buildPiSpawnEnv(agent)`, `spawnPiRpcSession(agent)`, `buildPiPromptCommand`/`buildPiSteerCommand`, `sendPiPrompt(child,text)`, `sendPiSteer(child,text)`, `parsePiEvent(rawEvent)`, `readPiStream(child)`, `extractPiTextDelta`. NOTE: `extractFinalAssistantText`/`extractAssistantText` are PRIVATE module helpers (no export) used inside `parsePiEvent`'s `agent_end` case — verify them via `parsePiEvent`'s public output, never import directly.
>
> **Decisions folded in (Notion review + live verification + readiness punch-list, 2026-05-31):**
> 1. dropped the migration-only "MF4" provider-mismatch detector → replaced by a permanent, signal-matched graceful resume-recovery (Task 4).
> 2. persona task DROPPED — already shipped in Plan A (`buildPiSpawnArgs` pushes `--append-system-prompt`).
> 3. translator multi-turn fix is Task 1 (moved first: pure single-file, independent, highest-confidence — de-risks the gated chain). Live capture proved `turn_end` fires PER-TURN and `agent_end` ONCE; merged `parsePiEvent` wrongly maps BOTH to the terminal `ResultMessage` → any tool-using response truncates.
> 4. steer (Task 5) re-scoped to `message-queue.ts` + the `MessageQueue` construction site — the mid-turn mechanism lives there, NOT in session-manager (verified). As originally scoped it would silently no-op for Pi.
> 5. test-mocking guidance corrected (the suite injects mock children into the private active map; only `hot-reload.test.ts` uses `mock.module`).

## Overview

Wire the merged Pi RPC protocol module into the bot's live session lifecycle so a per-chat session with `provider: "pi"` runs end-to-end on Pi+Codex — correct multi-turn results, spawned, streamed to Telegram, resumed across restarts, steerable mid-turn — with the existing `claude` path untouched.

- **Problem it solves:** Plan A built the protocol module but wired NO dispatch, and its `turn_end` handling truncates multi-turn responses. Plan B makes `provider: "pi"` functional and correct. It also hardens a pre-existing fragility: today a stored session that can't be resumed crash-loops the chat until BLOCKED, needing a manual `/reconnect`.
- **Key benefit:** after Plan B merges, the coder PoC (flip `coder` → `provider: pi` + restart) is unblocked.
- **Integration:** branches `session-manager.ts` (and the busy-turn branch of `message-queue.ts`) on `agent.provider`; reuses the merged Pi fns; `parsePiEvent` already emits the `StreamLine` shape `stream-relay.ts` consumes, so the relay is untouched.

**Success criteria (testable):**
1. `parsePiEvent` maps ONLY `agent_end` → terminal `ResultMessage`; `turn_end` → null. A multi-turn (tool-using) Pi response delivers the FINAL answer; single-turn still terminates once.
2. With `agent.provider === "pi"`, `session-manager` spawns via `spawnPiRpcSession`, streams via `readPiStream`, sends via `sendPiPrompt`; with `provider` absent/`"claude"`, behavior is byte-identical to today.
3. The bot captures the Pi-GENERATED sessionId (issue `get_state` after spawn → the `SystemInit.session_id` that `parsePiEvent` emits from the `response` case), persists it, and resumes via `--session <uuid>` after restart. (A restart MID-turn legitimately yields "No session found" because Pi flushes a session to disk only after `agent_end`/SIGTERM → that is a graceful fresh start via Task 4, NOT a defect.)
4. A Pi resume failing specifically with exit 1 + stderr `No session found matching` → discard stored id, ONE fresh start, log `could not resume Pi session <id> — starting fresh`, increment a `pi_session_resume_discarded_total` metric. Any OTHER startup failure keeps the existing crash-backoff and preserves BOTH the stored id AND the chat media dir.
5. A mid-turn message to a live Pi session is delivered via `sendPiSteer`; the claude path keeps the `inject-message.sh` file path.
6. Full suite green; lint clean; no behavior change on the claude path.

**Non-goals (Plan B):** `cron-runner.ts` (= Plan C); the Pi extensions (guardian / web-tools / subagent / codex-usage = Phase 2); flipping any agent to `pi` or restarting the bot (= coder PoC / cutover, gated on explicit the maintainer confirmation); extending graceful-recovery to the claude path (claude is being deprecated).

## Context (verified against the merged tree 2026-05-31)

- `bot/src/session-manager.ts` (~725 LOC): per-chat `ActiveSession { child, sessionId, agentId, queue, idleTimer, ... }`. Imports `spawnClaudeSession`/`sendMessage`/`readStream` from `cli-protocol.ts`; **3 call sites (~224 spawn, ~350 send, ~385 read)** branch on `agent.provider`. Exposes `getActive(chatId) → ActiveSession` (gives the live `.child`, needed by the steer callback).
- Spawn path: `spawnClaudeSession(...)` (~224) → `await waitForSpawn(child, STARTUP_TIMEOUT_MS)` (~235); catch (~236-253) increments `restartCounts`, logs `Startup failure (crash #N)`, re-throws. Crash-count reset (266-268) runs ONLY after a successful `waitForSpawn` (unreachable on the catch path). `MAX_CRASH_RESTARTS` → BLOCKED, `throw "... use /reconnect"` (~197-199); else backoff 5s→60s (~201-205).
- `resolveStoredSession()` (~625-650): discards (deleteSession + fresh `randomUUID()`) only on `agentMismatch || agentDeleted`, else `{ resume:true, sessionId: stored.sessionId }`.
- `destroySession()` (~577-583): `store.deleteSession` + `closeSession(persist:false)` + **`cleanupSessionMediaDir` (WIPES the chat media dir, :582)**. Reuse for the recovery discard — but note it is data-destructive.
- `SessionStore` (`bot/src/session-store.ts`): `Record<chatId, SessionState>` → `<workspace>/data/sessions.json` (atomic tmp+rename). `SessionState = { sessionId, chatId, agentId, lastActivity }`. **No `provider` field added.**
- `bot/src/message-queue.ts`: `class MessageQueue`, constructor takes `processFn` (~98-102). The busy-turn branch `if (state.busy)` (~155-180) calls `this.writeInject(chatId, state)` → `writeInjectFile` (from `inject-file.js`) → PreToolUse hook delivers mid-turn. **MessageQueue has NO handle to SessionManager or the live child.** Constructed at `bot/src/telegram-bot.ts:~642` (`new MessageQueue(processFn, ...)`), which DOES have the config + sessionManager in scope. Pi has no PreToolUse hook → the inject-file path is a no-op for Pi.
- **Merged `pi-rpc-protocol.ts` realities:**
  - `buildPiSpawnArgs(agent)` → `--mode rpc --provider openai-codex --model <norm> [--append-system-prompt <systemPrompt>]`. **Takes ONLY `agent`, NO resume support.** Persona already handled.
  - `spawnPiRpcSession(agent)` spawns with those args; **stderr is piped to `log.warn("pi-rpc", ...)` and NOT captured/returned.**
  - sessionId exposed ONLY via a successful `get_state`/`get_session_stats` `response` → `parsePiEvent` (~328-350) emits `SystemInit { session_id }`. No `buildGetStateCommand` exists yet.
  - `parsePiEvent` `turn_end`/`agent_end` share ONE terminal `ResultMessage` block (~315-326) — the bug.
- **Verified Pi event sequence (live, 2026-05-31):** multi-turn = 2× `turn_end` + 1× `agent_end`; single-turn = 1× each; `agent_end` ALWAYS fires once at the end. Session persists to disk only after `agent_end` + on SIGTERM.
- `stream-relay.ts`: UNCHANGED.

## Development Approach

- **Testing approach: Regular** (code-first, tests per task); tests in `bot/src/__tests__/*.test.ts` (the `npm test` glob).
- **Test-mocking patterns (use the right one per task — verified against the real suite):**
  - **Reuse / lifecycle path** (existing `session-manager.test.ts` pattern): build a mock `ChildProcess` (EventEmitter `createMockChild`-style) and inject it directly into SessionManager's private `active` map; drive events on it. Does NOT mock any module.
  - **Spawn path** (Task 3/4 capture + recovery — needs the REAL spawn path): use `node:test` `mock.module` (run with `--experimental-test-module-mocks`, exactly as `hot-reload.test.ts` does) to stub `pi-rpc-protocol.js` exports (`spawnPiRpcSession`, `readPiStream`, `sendPiGetState`). There is NO existing `cli-protocol.js` module-mock to "mirror" — do not look for one.
- Every task includes new/updated tests (success + error); all pass before the next.
- **Backward-compat is sacred:** every change gated on `agent.provider === "pi"`; claude/absent path byte-identical; add explicit regression assertions.
- DRY/YAGNI: no `provider` field in the store, no provider-mismatch detector.

## Testing Strategy

- **Unit:** translator turn_end→null / agent_end→terminal (via `parsePiEvent` public output, verified sequences); dispatch routing; get_state id capture + persist + resume (mock.module spawn path); graceful recovery (signal match → discard + ONE fresh retry + warn + metric; non-matching → backoff, NO discard, media preserved; at-most-once even when fresh re-spawn also fails); steer routing in message-queue.
- **Regression:** claude-provider path unchanged (dispatch, store record, mid-turn inject-file).
- **No e2e** (real end-to-end is the coder PoC, a later cutover task).

## Progress Tracking
- `[x]` on completion; ➕ new tasks; ⚠️ blockers; keep in sync.

## Solution Overview

First fix the independent translator bug (only `agent_end` terminates). Then `session-manager` gains a thin provider switch at its 3 `cli-protocol` call sites. For Pi, the bot issues `get_state` right after spawn and reads EXACTLY ONE record from a single `readPiStream(child)` consumer to capture the `SystemInit.session_id`, then stops that generator (a fresh `readPiStream` per later message is safe because the prior generator is fully drained); resume extends `buildPiSpawnArgs` to pass `--session <id>`. A narrow signal-matched recovery does an INLINE single re-spawn (not recursive) on a "session not found" failure. Mid-turn sends route to `sendPiSteer` via a steer callback wired into `MessageQueue` at construction. Everything else is provider-agnostic and reused unchanged.

## Technical Details

- **Translator fix (Task 1):** in `parsePiEvent`, split the shared `turn_end`/`agent_end` case — `turn_end` → `null` (per-turn boundary), `agent_end` → `ResultMessage` (via the private `extractFinalAssistantText(rawEvent.messages)`). Verify the result text against the real `agent_end.messages` shape through `parsePiEvent`'s output.
- **Dispatch (Task 2):** at each call site select by `agent.provider === "pi"`. `ActiveSession` shape unchanged.
- **Session-id capture + resume (Task 3):** add `buildGetStateCommand()` + `sendPiGetState(child)`. After `spawnPiRpcSession`, open ONE `readPiStream(child)`, `sendPiGetState`, read until the `SystemInit` record, capture `session_id` into `ActiveSession.sessionId` + `store.setSession`, then STOP that generator. Extend `buildPiSpawnArgs(agent, resumeSessionId?)` and `spawnPiRpcSession(agent, resumeSessionId?)` to push `--session <id>` when present; resume passes `stored.sessionId`. Document the single-consumer contract: per-message `readPiStream` is created fresh and the spawn-path generator is fully drained before any message read.
- **Graceful resume-recovery (Task 4):** extend `spawnPiRpcSession` to buffer startup stderr (keep `log.warn`) and expose it + exit. In the spawn catch (Pi branch, resuming only) with a LOCAL `alreadyRetried` boolean: if `!alreadyRetried && exitCode === 1 && /No session found matching/.test(stderr)` → `destroySession(chatId)` + INLINE single `spawnPiRpcSession`+`waitForSpawn` fresh (no `--session`) + `log.warn(...)` + `pi_session_resume_discarded_total.inc()`. A second failure throws into the normal catch (increments `restartCounts`) — NO recursion into `getOrCreateSession`, NO loop. Non-matching failures: unchanged (preserve stored id AND media dir).
- **Steer (Task 5):** add a provider-aware mid-turn delivery to `MessageQueue`. Inject a `steerFn(chatId, text)` at construction (telegram-bot.ts:~642), defined as `(chatId, text) => { const s = sessionManager.getActive(chatId); if (s && !hasExited(s.child)) sendPiSteer(s.child, text); }`. In the busy-turn branch, branch on the chat's provider: `pi` → `steerFn`; else → existing `writeInject`. (Provider available via the agent config the construction site holds, or threaded into queue state alongside `agentId`.)

## What Goes Where
- **Implementation Steps (`[ ]`):** in-repo — `pi-rpc-protocol.ts`, `session-manager.ts`, `message-queue.ts`, `telegram-bot.ts`, tests, docs.
- **Post-Completion (no checkboxes):** merge to public main + upstream-sync to workspace (release-flow). Rollback: if the squash-merge surfaces a claude-path regression, `git revert <merge>` + re-run upstream-sync — no session data is at risk because no agent is flipped to pi until the gated cutover. Then the coder PoC (flip `coder` → `provider:pi` + restart + 24h soak; explicit the maintainer confirmation).

## Implementation Steps

### Task 1: Translator multi-turn fix — only agent_end is terminal

**Files:**
- Modify: `bot/src/pi-rpc-protocol.ts` (`parsePiEvent`, ~315-326)
- Modify: `bot/src/__tests__/pi-rpc-protocol.test.ts`

- [x] split the shared case: `turn_end` → `null`; keep `agent_end` → `ResultMessage` via `extractFinalAssistantText(rawEvent.messages)`
- [x] confirm `extractFinalAssistantText` returns the correct final text for the real `agent_end.messages` shape (adjust if labels differ); verify THROUGH `parsePiEvent` output, do not import the private helper
- [x] write tests (verified sequences): multi-turn (2× turn_end + 1× agent_end) → exactly ONE terminal `ResultMessage` (from agent_end) with the FINAL text; single-turn → one terminal; `turn_end` alone → null
- [x] run tests — must pass before next task

### Task 2: Provider dispatch branch in session-manager

**Files:**
- Modify: `bot/src/session-manager.ts`
- Modify: `bot/src/__tests__/session-manager.test.ts`

- [x] import the Pi protocol fns; at the 3 `cli-protocol` call sites (~224/350/385), branch on `agent.provider === "pi"` → Pi fns, else claude fns
- [x] keep `ActiveSession` shape + lifecycle provider-agnostic
- [x] write tests (reuse-path pattern: mock child injected into private `active` map): pi routes to Pi fns; claude/absent routes to claude fns (regression)
- [x] run tests — must pass before next task

### Task 3: Pi session-id capture (get_state, single-consumer) + resume

**Files:**
- Modify: `bot/src/pi-rpc-protocol.ts` (add `buildGetStateCommand`/`sendPiGetState`; extend `buildPiSpawnArgs`/`spawnPiRpcSession` with optional `resumeSessionId`)
- Modify: `bot/src/session-manager.ts`
- Modify: `bot/src/__tests__/pi-rpc-protocol.test.ts`
- Modify: `bot/src/__tests__/session-manager.test.ts`

- [x] add `buildGetStateCommand()` + `sendPiGetState(child)` (writes `{type:"get_state"}`)
- [x] extend `buildPiSpawnArgs(agent, resumeSessionId?)` → push `--session <id>` iff present; thread through `spawnPiRpcSession(agent, resumeSessionId?)`
- [x] session-manager Pi spawn: open ONE `readPiStream(child)`, `sendPiGetState`, read until the `SystemInit` record, capture `session_id` → `ActiveSession.sessionId` + `store.setSession`, then STOP that generator (single-consumer contract: per-message `readPiStream` created fresh, prior generator fully drained)
- [x] resume path: stored Pi session → spawn with `resumeSessionId = stored.sessionId`
- [x] write tests (spawn path via `mock.module` stub of pi-rpc-protocol exports): `buildPiSpawnArgs` adds `--session` iff resume id; get_state SystemInit captured + persisted; single-consumer read terminates cleanly; claude path still bot-generates `--session-id` (regression)
- [x] run tests — must pass before next task

### Task 4: Graceful resume-recovery (Pi-path, signal-matched, inline, at-most-once)

**Files:**
- Modify: `bot/src/pi-rpc-protocol.ts` (buffer + expose startup stderr/exit)
- Modify: `bot/src/session-manager.ts`
- Modify: `bot/src/metrics.ts` (add `pi_session_resume_discarded_total`)
- Modify: `bot/src/__tests__/session-manager.test.ts`
- Modify: `bot/src/__tests__/metrics.test.ts`

- [x] `spawnPiRpcSession`: buffer startup stderr (keep `log.warn`) and expose stderr+exit for the caller to inspect
- [x] add metric `pi_session_resume_discarded_total` (prom-client, already wired)
- [x] spawn catch (Pi branch, resuming only, LOCAL `alreadyRetried` flag): if `!alreadyRetried && exitCode===1 && /No session found matching/.test(stderr)` → `destroySession(chatId)` + INLINE single `spawnPiRpcSession`+`waitForSpawn` fresh (no `--session`) + `log.warn("could not resume Pi session <id> — starting fresh")` + metric inc. NO recursive `getOrCreateSession`.
- [x] second failure throws into the normal catch (increments `restartCounts`); non-matching failures preserve BOTH stored id AND media dir
- [x] write tests: missing-session signal → exactly ONE `destroySession` + ONE warn + metric inc, then success; both spawns fail identically → exactly ONE destroySession + ONE warn then a THROWN error, NO loop; non-matching failure → NO discard, stored id + media dir preserved, existing backoff
- [x] run tests — must pass before next task

### Task 5: Mid-turn steer wiring for Pi (message-queue)

**Files:**
- Modify: `bot/src/message-queue.ts` (provider-aware busy-turn branch)
- Modify: `bot/src/telegram-bot.ts` (~642 — inject `steerFn` at `MessageQueue` construction)
- Modify: `bot/src/__tests__/message-queue.test.ts`

- [x] inject a `steerFn(chatId, text)` at `MessageQueue` construction: `const s = sessionManager.getActive(chatId); if (s && !hasExited(s.child)) sendPiSteer(s.child, text)`
- [x] make the busy-turn branch (~155-180) provider-aware: `pi` → `steerFn(chatId, text)`; else → existing `writeInject` path (claude unchanged)
- [x] thread the chat's provider into the queue (resolved in the steer callback via `config.agents[agentId].provider`; queue passes `state.agentId` to `steerFn`)
- [x] write tests: pi busy-turn message → `steerFn`/`sendPiSteer`; claude busy-turn message → `writeInject` (regression)
- [x] run tests — must pass before next task

### Task 6: Verify acceptance criteria

- [ ] verify the 6 success criteria from Overview
- [ ] regression gate: a claude-provider session byte-identical to pre-Plan-B behavior (dispatch, store record, mid-turn inject-file)
- [ ] grep-confirm `cli-protocol.ts` and `cron-runner.ts` are NOT modified (cron = Plan C)
- [ ] run full suite: `cd bot && npm test` ; lint: `cd bot && npm run lint`

### Task 7: [Final] Update documentation

**Files:**
- Modify: `README.md` (repo ROOT — NOT bot/README.md)

- [ ] short note: translator multi-turn fix + provider dispatch + get_state session-id capture + graceful resume-recovery + Pi steer; claude path unchanged
- [ ] PR description: "Plan B — dispatch wiring; turn_end multi-turn truncation fix; get_state session-id capture + resume; graceful resume-recovery (replaces migration-only MF4); Pi mid-turn steer; claude path unchanged; coder PoC unblocked after merge"
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention — no checkboxes, informational only*

**Release:** merge to public main → `git fetch upstream && git merge upstream/main` in workspace (release-flow). **Rollback:** claude-path regression after merge → `git revert <merge>` + re-run upstream-sync; no session data at risk (no agent on pi until the gated cutover).

**Next (separate cutover task — explicit the maintainer confirmation):** coder PoC — `agents.coder.provider: pi`, restart bot, 24h soak.
- ⚠️ **Codex OAuth token (`~/.pi/agent/auth.json`) expires 2026-06-09** (before the June 15 deadline). Does NOT affect Plan B (tests mocked, no live Pi). At the coder-PoC cutover, verify the token AUTO-REFRESHES from inside the bot's launchd subprocess (write-permission to `~/.pi/agent/auth.json` under the bot's `$HOME`) — refresh was only verified from an interactive shell.

**Still-unverified deferred item (low risk, verify during soak):** the exact Pi hard-error event shape (top-level `error` vs failed `response` vs `auto_retry_end` finalError) — `parsePiEvent` handles all three defensively; confirm against a real error if one surfaces.
