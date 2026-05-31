# Pi RPC Integration — Plan A (core data layer)

> Generated via the `planning:make` methodology (canonical structure). Scope is LOCKED/approved by Ninja (2026-05-30). Implemented by ralphex. Plan A = protocol/types/metrics/tests layer ONLY; it leaves the existing `claude -p` path fully intact (`provider` defaults to `"claude"`).

## Overview

Add a typed, tested Pi RPC protocol module to the bot so a later plan can dispatch a per-chat session to the Pi coding agent (`pi --mode rpc`, OpenAI Codex provider) ALONGSIDE the existing `claude -p` path, selected per-agent by a new `provider` config field.

- **Problem it solves:** Anthropic moves `claude -p`/Agent SDK off the subscription pool to per-token billing on June 15 2026; the bot must run agents via Pi+Codex instead. This is step 1 (the data layer) of that migration.
- **Key benefit:** a self-contained, fully-tested protocol module with ZERO behavior change to existing agents — the foundation the dispatch layer (Plan B) builds on.
- **Integration:** mirrors the shape of `cli-protocol.ts` and translates Pi RPC events into the bot's existing `StreamLine` union, so the stream-relay/Telegram delivery path needs no changes.

## Context (from discovery)

- **Files/components involved:** `bot/src/types.ts` (`AgentConfig`, `StreamLine` 8-variant union), `bot/src/config.ts` (`validateAgent`), NEW `bot/src/pi-rpc-protocol.ts`, `bot/src/metrics.ts` (prom-client registry), `bot/package.json`, `config.yaml` (public example). Reference-only (do NOT modify): `bot/src/cli-protocol.ts` (the claude analog to mirror), `bot/src/stream-relay.ts` (the `StreamLine` consumer).
- **Related patterns found:** `cli-protocol.ts` is the single module that knows the `claude` binary (8 exported fns; `readStream` uses `node:readline`). `metrics.ts` exports `bot_claude_turn_duration_seconds` (Histogram, label `agent_id`, buckets `[1,5,10,30,60,120,300,600]`) + `bot_session_crashes_total`. `stream-relay.ts` sets `sawNonTextBlock` on a `content_block_start` tool_use and pulls text via `extractTextDelta`.
- **Dependencies identified:** Pi RPC speaks JSON-Lines over stdio. **CRITICAL gotcha:** `node:readline` is NON-COMPLIANT for Pi RPC because it also splits on `U+2028`/`U+2029` (valid inside JSON strings) → corrupts records. The splitter MUST split ONLY on `\n` (a `StringDecoder` accumulator). Pi events: `message_update` (with `assistantMessageEvent.type === "text_delta"`), `tool_execution_start/update/end`, `turn_end`, `agent_end`, `auto_retry_start/end`, `error`, and a session header / `get_state` carrying the Pi-generated `sessionId`.

## Development Approach

- **Testing approach: Regular (code first, then tests per task)** — matches ralphex's build-then-verify flow and the existing bot test layout (`bot/src/__tests__/*.test.ts`).
- Complete each task fully (incl. its tests passing) before the next.
- Small, focused changes; maintain **backward compatibility** — `provider` defaults to `"claude"`, existing agents/tests unchanged.
- **Every task MUST include new/updated tests** (not optional): unit tests for new/modified functions, both success and error paths.
- **All tests must pass before starting the next task** — no exceptions.
- Update this plan file if scope changes during implementation.

## Testing Strategy

- **Unit tests:** required for every task (above). Live under `bot/src/__tests__/*.test.ts` (the `npm test` glob is exactly that path — a test placed elsewhere is NOT run).
- **No e2e:** the bot has no UI-based e2e suite; this is a backend protocol module. No e2e tests apply to Plan A.
- Key coverage: the newline-only splitter edge cases (`U+2028`/`U+2029`/`\r`), the `parsePiEvent` translation into each `StreamLine` variant, and the retry-classifier metric buckets.

## Progress Tracking

- mark completed items `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document blockers with ⚠️ prefix
- keep this plan in sync with actual work

## Solution Overview

A new `pi-rpc-protocol.ts` provides the Pi-side analog of every `cli-protocol.ts` primitive (spawn, send, read-stream, extract-text), plus a `parsePiEvent` translator that reconstructs the EXISTING `StreamLine` internal shapes from Pi RPC events. The `provider` field selects the path; Plan A wires NO dispatch (that's `session-manager.ts` in Plan B). Pi Prometheus metrics are registered now (consumed by later alert/gate tasks). Design decision: translate INTO the existing 8-variant `StreamLine` union (do not widen it) so `stream-relay.ts` is untouched — minimizing blast radius and keeping the claude path identical.

## Technical Details

- **`provider` field:** `provider?: "claude" | "pi"` on `AgentConfig` (default `"claude"`); `validateAgent` accepts + defaults it.
- **Splitter:** `string_decoder.StringDecoder`-based accumulator, split ONLY on `\n`.
- **Spawn args:** `pi --mode rpc --provider openai-codex --model <agent.model || openai-codex/gpt-5.5> [--append-system-prompt <agent.systemPrompt>]`. NO `--max-turns/--add-dir/--effort/--fallback-model` (Pi has none).
- **Env:** Pi reads `~/.pi/agent/auth.json`; no `CLAUDE_CODE_OAUTH_TOKEN`.
- **`parsePiEvent` mapping:** `message_update`/text_delta → `StreamEvent` (`event.delta = {type:"text_delta", text}`); `tool_execution_start` → synthetic `StreamEvent` (`content_block_start` tool_use, drives `sawNonTextBlock`); `turn_end`/`agent_end` → `ResultMessage` (+`session_id`); session header/`get_state` → `SystemInit` (`session_id` for later capture); `auto_retry_start/end` → `RateLimitEvent`; `error` → result-error.
- **Metrics:** `bot_pi_turn_duration_seconds` (Histogram, `agent_id`, SAME buckets); Counters (`agent_id`) `pi_retry_total` (every `auto_retry_start`), `pi_429_total` (rate-limit sig), `pi_overload_total` (529/5xx sig), `pi_retry_unknown_total` (graceful fallback — wording change still counted).

## Implementation Steps

### Task 1: `provider` field in types + config [HIGH]
- [x] `types.ts`: add `provider?: "claude" | "pi"` to `AgentConfig` (optional; semantic default `"claude"`).
- [x] `config.ts` `validateAgent`: accept `provider` (`z.enum(["claude","pi"]).optional()` or the existing idiom), default absent → `"claude"`. No other field handling changes.
- [x] write tests: provider absent → `"claude"`; `"pi"` accepted; invalid value rejected.
- [x] run tests — must pass before next task.

### Task 2: `pi-rpc-protocol.ts` + compliant JSONL splitter [HIGH]
- [x] implement newline-only splitter via `string_decoder` (never `\r`/`U+2028`/`U+2029`); export it.
- [x] `buildPiSpawnArgs(agent)` (per Technical Details; persona via `--append-system-prompt`, mirroring `cli-protocol.ts:49-59`; prefixed `openai-codex/gpt-5.5` model form).
- [x] `buildPiSpawnEnv(agent)`; `spawnPiRpcSession(agent)` → ChildProcess matching `spawnClaudeSession`'s shape (stderr→log).
- [x] `buildPiPromptCommand(text)` + `sendPiPrompt(child,text)` (RPC `prompt`); `sendPiSteer(child,text)` (RPC `steer`).
- [x] write splitter tests: `U+2028`/`U+2029` inside a JSON string NOT split; `\r\n`/lone `\r` NOT split; only `\n` splits; partial-chunk reassembly across reads.
- [x] run tests — must pass before next task.

### Task 3: `parsePiEvent` translator (Pi event → StreamLine) [HIGH]
- [x] `readPiStream(child)` async generator (stdout → splitter → `JSON.parse` → translate).
- [x] `parsePiEvent(rawEvent)` per the Technical Details mapping (reconstruct existing `StreamLine` internal shapes).
- [x] `extractPiTextDelta(streamLine)` mirroring `extractTextDelta`.
- [x] write translation tests: (a) translated `tool_execution_start` flips `sawNonTextBlock` via the `stream-relay` check; (b) `extractPiTextDelta` returns text for a translated `message_update`; (c) `turn_end` → `ResultMessage` with `session_id`.
- [x] run tests — must pass before next task.

### Task 4: Pi Prometheus metrics in `metrics.ts` [HIGH] (MF3)
- [x] register `bot_pi_turn_duration_seconds` (Histogram, `agent_id`, SAME buckets) + the 4 Counters (per Technical Details).
- [x] wire `parsePiEvent`'s `auto_retry_start` handling to a classifier: always `pi_retry_total` + exactly one of `pi_429_total`/`pi_overload_total`/`pi_retry_unknown_total` via a defensive `errorMessage` match.
- [x] write tests: rate-limit / overload / unrecognized message → correct bucket (+ `pi_retry_total` always).
- [x] run tests — must pass before next task.

### Task 5: Pin Pi dependency + config example [MED]
- [x] `bot/package.json`: add `"@earendil-works/pi-coding-agent": "0.75.3"` (exact pin, version visibility; binary invoked via PATH). Update lockfile if repo convention requires.
- [x] `config.yaml` (public example): document optional per-agent `provider: claude` (or `pi`) with a short comment.
- [x] run tests (no new test needed unless config parsing changes).

### Task 6: Verify acceptance criteria [HIGH]
- [x] verify the 4 success criteria (provider field defaults claude — types.ts:19 + config.ts:154-168; `pi-rpc-protocol.ts` exports `NewlineOnlyJsonlSplitter` + `parsePiEvent` + spawn/send helpers; Pi metrics registered+scrapeable; Plan A suite green).
- [x] **grep-confirm NO edits to `cli-protocol.ts` / `session-manager.ts` / `cron-runner.ts`** — `git diff --name-only main...HEAD` on those three paths returns ZERO.
- [x] run the full test suite — all Plan A tests pass (169/169 across pi-rpc-protocol, metrics, provider-config, config-defaults, stream-relay). ⚠️ 5 pre-existing `restart-bot.sh --plist` failures remain: deterministic, on a file byte-identical to `main`, unrelated to Plan A (homebrew bash 5.3.9 mis-parses the `$BOT_PLIST…` ellipsis on restart-bot.sh:153). Not fixed here — out of Plan A scope (protocol/types/metrics only, no restart). Flagged to Ninja as a separate bot-operations bug.
- [x] run the linter (`tsc --noEmit`) — clean, no issues.
- [x] assert `bot_pi_turn_duration_seconds` + the 4 Pi counters are registered — covered by the `Pi metrics registration` block in metrics.test.ts:322-347 (registry membership + scrape-output assertions), passing.

### Task 7: Update documentation [HIGH]
- [x] add a short `bot/` doc note on the `provider` field + incremental Pi support (Plan A = protocol layer; dispatch is a follow-up). — added a "Provider backends" subsection to `README.md` (the bot's user-facing config doc) documenting the `provider: claude|pi` field (default claude), the protocol-layer-only scope (dispatch is a follow-up, `provider: pi` has no runtime effect yet), and the Pi binary/auth path; plus listed the 5 Pi Prometheus metrics under Monitoring.
- [x] PR description states: "Plan A of the Pi migration — protocol/types/metrics only, no dispatch, no restart; claude path unchanged." — canonical PR body captured in the new "## PR Description" section of this plan (opening/merging to public `main` is Ninja-gated per *What Goes Where*).

## PR Description

> Canonical body for the Plan A PR. Opening/merging to public `main` is gated on Ninja (see *What Goes Where* → release-flow); paste this when the PR is raised.

**Plan A of the Pi migration — protocol/types/metrics only, no dispatch, no restart; claude path unchanged.**

Adds a typed, fully-tested Pi RPC protocol layer alongside the existing `claude -p` path, selected per-agent by a new optional `provider: "claude" | "pi"` field (default `"claude"`).

- **Types/config:** `AgentConfig.provider` (defaults `"claude"`); `validateAgent` accepts and defaults it. No existing behavior changes.
- **Protocol module** (`bot/src/pi-rpc-protocol.ts`, new): newline-only JSONL splitter (`NewlineOnlyJsonlSplitter` — never splits on `\r`/`U+2028`/`U+2029`), spawn/send helpers, and a `parsePiEvent` translator mapping Pi RPC events into the existing 8-variant `StreamLine` union (so `stream-relay.ts` is untouched).
- **Metrics:** `bot_pi_turn_duration_seconds` + the retry counters (`bot_pi_retry_total`, `bot_pi_429_total`, `bot_pi_overload_total`, `bot_pi_retry_unknown_total`), registered and scrapeable now.
- **Dependency:** pins `@earendil-works/pi-coding-agent@0.75.3`; `config.yaml` documents the optional `provider` field.
- **Out of scope (follow-ups):** session-manager dispatch + session-id resume (Plan B), cron-runner port (Plan C), and flipping any agent to `provider: pi` (cutover). No agent is routed through Pi by this PR; no bot restart required.

Tests: Plan A suite green (splitter edge cases, `parsePiEvent` translation, retry-classifier buckets); `tsc --noEmit` clean.

## What Goes Where

- **Implementation Steps (above, `[ ]`):** all in-repo — code, tests, docs in `bot/` + the public `config.yaml`.
- **Post-Completion (no checkboxes — NOT in this plan, handled later):** `session-manager.ts` dispatch branch + session-id persistence/resume + provider-flip invalidation + live `steer` send-path wiring (**Plan B**); `cron-runner.ts` port (**Plan C**); flipping any agent to `provider: pi` + bot restart (cutover tasks); merge to public `main` + upstream sync into the workspace (release-flow, gated on Ninja).

## Success criteria

1. `AgentConfig.provider: "claude"|"pi"` (default claude); `validateAgent` accepts/defaults; no existing behavior changes.
2. `pi-rpc-protocol.ts` exports the newline-only splitter + `parsePiEvent` translator + spawn/send helpers.
3. Pi Prometheus metrics registered in `metrics.ts` and scrapeable.
4. Unit tests cover splitter edge cases + event translation + retry-classifier buckets; full suite green; lint clean.

## Validation Commands

```bash
cd bot
npm test
npm run lint
```
