# Fix: Pi RPC "already processing" turn-state corruption

## Goal

Fix two coupled defects in the Pi RPC path that, together, (1) truncate a Pi-backed
agent's in-flight streamed answer and (2) permanently wedge the session so every
subsequent user message gets the reply
`Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`
until the bot is restarted.

## Context

**Severity:** high — wedges any `provider: pi` agent session; blocks the Pi rollout.
**Area:** `bot/src/pi-rpc-protocol.ts`, `bot/src/message-queue.ts`, `bot/src/telegram-bot.ts`.

### How Pi behaves (confirmed in vendor source)

Pi's RPC rejects a message sent to an agent **mid-turn** when no `streamingBehavior`
is supplied — `@earendil-works/pi-coding-agent` `dist/core/agent-session.js:737-738`:

```js
if (!options?.streamingBehavior) {
    throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
}
```

That rejection arrives on the RPC stream as
`{ type: "response", success: false, command: "prompt", error: "Agent is already processing. …" }`.
`streamingBehavior` is `"steer"` (interrupt) or `"followUp"` (queue until the turn finishes).

### Defect A — `parsePiEvent` maps the concurrency rejection to a TERMINAL result

`bot/src/pi-rpc-protocol.ts:563-572` (`parsePiEvent`, `case "response"`): a failed
`prompt` response is mapped to a terminal `error_during_execution` `ResultMessage`
carrying `rawEvent.error` as the result text. The comment at `:553-555` assumes "a
failed `prompt` is terminal — no `agent_end` will arrive". That is **false for the
"already processing" rejection**: this is a *second, concurrent* prompt colliding with
a turn that is **still alive** and will still emit its own `agent_end`. Mapping it to a
terminal result therefore (a) ends the stream relay → truncates the live answer,
(b) relays Pi's internal error to the user as the "answer", (c) clears
`MessageQueue.busy` / `session.processingStartedAt` early. Failed **side-commands**
(`steer`, `get_state`, …) are already protected (return `null`, `:574-578`); the
`prompt` concurrency-rejection is not.

Deterministic reproduction (current buggy behavior):
```
parsePiEvent({type:"response", success:false, command:"prompt",
  error:"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."})
→ {type:"result", subtype:"error_during_execution", result:"Agent is already processing. …", is_error:true}
```

### Defect B — the bot sends a bare `prompt` to a busy child (the desync trigger)

`MessageQueue` (`bot/src/message-queue.ts`): while `busy`, mid-turn messages go through
`steerFn`; when **not** `busy`, debounce → `flush()` → `processFn` → `sendSessionMessage`
as a fresh **prompt** (no `streamingBehavior`). `makeSteerFn`
(`bot/src/telegram-bot.ts:609-628`) only steers when `session.processingStartedAt !== null`;
when `null` the message is buffered → sent as a bare prompt. `busy` is cleared
(`message-queue.ts:347`,`:443`) the moment `processFn` returns on a terminal `ResultMessage`.
**Defect A's spurious terminal result is itself what clears `busy`/`processingStartedAt`
while the child is still processing** → the next message is a fresh bare prompt → another
"already processing" → terminal → loop. A and B form the wedge together.

## Constraints

- Keep the change minimal and provider-scoped. The **claude** path (inject-file mechanism)
  must be untouched: `steerFn` returns `false` for claude and that must not change.
- Detect Pi's "already processing" rejection defensively (stable substring / normalized
  match — not exact-string-only).
- A genuinely failed `prompt` with a **different** error (real rejection, no live turn)
  must STILL be terminal so the turn does not hang.

## Validation Commands

```bash
npm test
```

## Tasks

### Task 1: Defect A — `parsePiEvent` must not terminate the turn on an "already processing" rejection
- [x] In `bot/src/pi-rpc-protocol.ts` `parsePiEvent` `case "response"`, when a failed
      `prompt` response carries Pi's "already processing" concurrency rejection, do NOT
      return a terminal `ResultMessage`. Return `null` (or a non-terminal recoverable
      signal) and log it — so the in-flight turn is neither truncated nor has Pi's
      internal error relayed to the user.
- [x] Preserve all other mappings: a failed `prompt` with a *different* error stays
      terminal (`error_during_execution`); failed side-commands (`steer`/`get_state`/…)
      stay `null`; `agent_end` stays terminal; `turn_end` stays `null`.
- [x] Add unit tests in `bot/src/__tests__/pi-rpc-protocol.test.ts`:
      (a) "already processing" `prompt`-failure → NOT terminal;
      (b) a different `prompt`-failure error → still terminal `error_during_execution`;
      (c) `steer`/`get_state` failure → `null`;
      (d) regression: `agent_end` → terminal, `turn_end` → `null`.

### Task 2: Defect B — never deliver a bare prompt to a busy Pi child; recover via followUp
- [x] Ensure the send path (`bot/src/message-queue.ts` flush/drain →
      `sendSessionMessage`, plus `bot/src/telegram-bot.ts` `makeSteerFn` / steer wiring)
      never delivers a bare `prompt` to a Pi child whose turn is active. When the child
      is (or may be) busy, deliver with `streamingBehavior: "followUp"`.
      Implemented: `sendSessionMessage` (the only `sendPiPrompt` caller) now sends
      `sendPiPrompt(child, text, "followUp")`. Pi IGNORES `streamingBehavior` when the
      agent is idle (verified in vendor `agent-session.js`: the field is only read inside
      the `if (this.isStreaming)` branch) and HONORS it when mid-turn — so a bare prompt
      can never collide with a live turn. The busy-path branch keeps steering via
      `makeSteerFn` (`sendPiSteer`).
- [x] On an "already processing" rejection, re-deliver the same message with
      `streamingBehavior: "followUp"` rather than dropping it (no silent message loss).
      Satisfied by PREVENTION: every queue-driven Pi prompt is delivered with `followUp`
      from the start, so Pi queues the colliding message behind the live turn instead of
      rejecting-and-dropping it. The rejection is thus preempted (and, per Task 1, would
      anyway be swallowed to `null` in `parsePiEvent` — unobservable at the relay layer,
      so reactive re-delivery is not possible there; proactive `followUp` is the correct fix).
- [x] Keep `busy` / `processingStartedAt` synced to the child's real
      `agent_start`/`agent_end` lifecycle; verify no non-terminal event clears them early
      (Task 1 removes the main spurious clear — confirm there is no other).
      Confirmed: `session.processingStartedAt` is cleared ONLY after a terminal `result`
      line (`session-manager.ts` post-loop) or on error; the queue clears `busy` only when
      `processFn` returns on that terminal result. The only `parsePiEvent` mappings that
      yield a `result` are `agent_end`, top-level `error`, and a REAL (non-"already
      processing") failed `prompt` — all genuinely terminal. `turn_end` → `null`,
      `response` success → `system`/`null`, "already processing" → `null` (Task 1). No
      other non-terminal event clears them.
- [x] Claude path unchanged: `steerFn` returns `false` for claude, inject-file path intact.
      Only the `isPi` branch of `sendSessionMessage` and the Pi-specific
      `buildPiPromptCommand`/`sendPiPrompt` were touched. Covered by the existing
      `makeSteerFn` "returns false for claude" test and the "routes a claude/absent-provider
      session through sendMessage + readStream (regression)" test.
- [x] Add tests: a mid-turn message to a busy Pi child is delivered via steer/followUp,
      never a bare prompt; a simulated "already processing" causes neither truncation nor
      a dropped message (re-delivered as followUp); the claude path is unchanged.
      Added: `pi-rpc-protocol.test.ts` — `buildPiPromptCommand`/`sendPiPrompt` attach
      `streamingBehavior:"followUp"` only when requested (bare shape unchanged regression);
      `session-manager.test.ts` — the Pi send path asserts the prompt carries
      `streamingBehavior:"followUp"` (never a bare prompt). Truncation is covered by the
      Task 1 `parsePiEvent` "already processing" → non-terminal test.

### Task 3: Verify acceptance
- [x] `npm test` green — all existing `pi-rpc-protocol.test.ts` cases plus the new tests pass.
      Verified: full suite `npm test` (run from `bot/`) = 1386 pass / 0 fail. The Defect A
      cases ("does NOT terminate the turn on Pi's 'already processing' prompt rejection",
      "detects the 'already processing' rejection defensively", "a DIFFERENT failed prompt
      error stays terminal", "ignores a failed side-command response") and the Defect B
      cases ("attaches streamingBehavior to a prompt command only when requested", "writes a
      prompt command carrying streamingBehavior:followUp when asked", session-manager "pi
      prompt must carry streamingBehavior:followUp") all pass.
- [x] The deterministic repro above no longer yields a terminal `is_error` result.
      Verified by `pi-rpc-protocol.test.ts` "does NOT terminate the turn on Pi's 'already
      processing' prompt rejection (Defect A)": `parsePiEvent({type:"response",
      command:"prompt", success:false, error:"Agent is already processing. …"})` now returns
      `null` (non-terminal), not the prior `error_during_execution` `is_error:true` result.
- [x] A burst of mid-turn user messages to a Pi agent produces no "Agent is already
      processing …" in the user channel, and no truncation of the in-flight response.
      Mechanisms unit-verified: (1) proactive `streamingBehavior:"followUp"` on every
      queue-driven Pi prompt means a colliding mid-turn prompt is queued behind the live turn
      instead of rejected (`session-manager.test.ts:2024`); (2) even if a rejection is
      observed, `parsePiEvent` swallows it to `null` so the in-flight answer is neither
      truncated nor is Pi's internal error relayed to the user
      (`pi-rpc-protocol.test.ts:947`). The literal live-channel end-to-end burst (running Pi
      agent + real Telegram channel) is a manual/deployment check — not automatable in the
      unit suite; both underlying mechanisms it depends on are covered above.

## Out of scope (follow-up, not this PR)

- Pi-path observability: the Pi dispatch logs almost nothing (no spawn / `agent_start` /
  `agent_end` / error lines per chat), which materially slowed diagnosis. File a separate
  task to add structured Pi turn-lifecycle logging.
