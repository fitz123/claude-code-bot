# Hot-Reload Config Without Bot Restart (Issue #96)

**Date:** 2026-04-17
**Repo:** `fitz123/claude-code-bot` (public) → merge to `~/.minime/workspace/`
**Issue:** https://github.com/fitz123/claude-code-bot/issues/96
**Mode:** quick / standard preset
**Owner:** main → ralphex for implementation

## Goal

Changes to `config.yaml` / `config.local.yaml` (e.g. swapping `claude-opus-4-6` → `claude-opus-4-7`) take effect for newly spawned Claude subprocesses **without restarting the bot process**. Already-running sessions keep their baked-in argv.

## Scope (approved)

**In scope (Option 1 minimal):**
- Per-agent fields consumed in `buildSpawnArgs`: `model`, `fallbackModel`, `maxTurns`, `systemPrompt`, `effort`, `workspaceCwd`, `allowedTools`
- `sessionDefaults` used at spawn-time (idle timeout, max concurrent) — refreshed for new sessions

**Out of scope (boot-level, restart still required):**
- `telegramToken`, `discord.token` — grammY / discord.js bot object created once
- `bindings` (chat → agent routing) — captured in `telegram-bot.ts`/`discord-bot.ts` closures
- `metricsPort` — HTTP server bound once
- `config.sessionDefaults.maxMessageAgeMs` — snapshotted as local `const` in handler (`telegram-bot.ts:538`)
- `config.sessionDefaults.requireMention` — read per-message but from captured `config` ref

## Design Decisions (approved)

| Axis | Choice | Rationale |
|---|---|---|
| scope | agents + sessionDefaults only | Issue narrowly targets model swap; don't multiply surface area |
| failure-mode | throw error → new session spawn fails → user sees error in chat | Explicit > implicit. Typo surfaces immediately, no silent drift. Existing sessions unaffected. |
| implementation | `() => BotConfig` loader injected into `SessionManager` | Explicit dependency, mockable in tests, no shared mutable state |
| observability | log one line per reload attempt (success or failure) | Debuggability: "did my model change take effect?" |
| validation | full `loadConfig()` on every spawn | Proven — cron-runner already does this, tiny file |
| testing | unit test in `session-manager.test.ts` | Lock behavior: mutated loader → new model in argv |
| ADR | not required | Backwards-compatible internal refactor |

## Evidence (verified against source)

- `bot/src/config.ts:295` — `loadConfig()` is stateless, no memoization. Safe to call per-spawn.
- `bot/src/session-manager.ts:116` — `this.agents = config.agents` cached at construction. **This is the single point to replace.**
- `bot/src/session-manager.ts:117-118` — `idleTimeoutMs`, `maxConcurrentSessions` cached as numbers.
- `bot/src/cli-protocol.ts:25-76` — `buildSpawnArgs` reads per-spawn fields from `opts.agent.*`. Per-spawn → already hot-reloadable once `agents` is fresh.
- `bot/src/cron-runner.ts:152,163,177` — already calls `loadRawMergedConfig()` per invocation. Pattern is production-proven.
- `bot/src/session-manager.ts:565-584` (`resolveStoredSession`) — already handles agent-deleted and agentId-changed cases. Safe for schema evolution during reload.

## Implementation Plan

### Phase 1 — SessionManager refactor

**File:** `bot/src/session-manager.ts`

1. Replace `private agents: Record<string, AgentConfig>` field with:
   - `private loadConfig: () => BotConfig`

2. Constructor signature change:
   ```
   constructor(loadConfig: () => BotConfig, storePath?: string, logDir?: string)
   ```
   - Call `loadConfig()` once at construction to validate at boot (fail-fast — bot won't start with broken config). Discard the result.
   - Drop the `idleTimeoutMs` / `maxConcurrentSessions` / `agents` instance fields — derive from fresh config at each call site.

3. Add `private getFreshConfig(): BotConfig`:
   - Call `this.loadConfig()` directly.
   - On success: log `config: reload ok` (one line, could include hash of serialized agents for debuggability).
   - On throw: **propagate the error**. No cache fallback. Log `config: reload failed: <err.message>` at error level.

4. Call `getFreshConfig()` at spawn path:
   - `getOrCreateSession` (`session-manager.ts:166`) — before `spawnClaudeSession`, look up `agent` from fresh config. If `getFreshConfig()` throws → error bubbles up to the caller (`sendSessionMessage` in telegram-bot / discord-bot) → already-existing error-reply path in handlers surfaces it to the user.
   - `resolveStoredSession` (`session-manager.ts:565`) — use fresh agents for mismatch detection. If throws → treat as "config broken, session cannot resume" — same user-visible error.

5. Replace cached timeout reads at all sites:
   - `resetIdleTimer` (`session-manager.ts:407`) — reads `this.idleTimeoutMs`. Replace with fresh read. **Note:** already-armed `setTimeout` is NOT re-scheduled; new value takes effect on next `resetIdleTimer` call.
   - `evictIfNeeded` (`session-manager.ts:587-588`) — reads `this.maxConcurrentSessions`. Replace with fresh read.
   - `/status` display paths in handlers still use boot-time `config` ref (out of scope — bindings/closure territory). Acceptable.
   - Call `getFreshConfig()` once per decision point (spawn, eviction check, idle reset) — don't reload twice per message.

### Phase 2 — Wire loader from main.ts

**File:** `bot/src/main.ts`

1. Line 20: keep `const config = loadConfig()` as the boot validation (fail-fast).
2. Line 35: replace `new SessionManager(config)` with:
   ```
   new SessionManager(() => loadConfig(), ...)
   ```
3. Telegram/Discord handlers still receive the boot-time `config` object (bindings remain closed over).

### Phase 3 — Tests

**File:** `bot/src/__tests__/session-manager.test.ts`

**Required first — migrate existing tests to new constructor signature:**
- ~45 existing call sites use `new SessionManager(testConfig, TEST_STORE_PATH)` (lines 105, 111, 118, 124, 131, 149, 181, ... through 1639).
- Global sed/replace: `new SessionManager(testConfig,` → `new SessionManager(() => testConfig,`
- Run `npm test` after migration — all 915 existing tests must still pass before adding new ones.

**Then add the new hot-reload test:**
1. Create two `BotConfig` fixtures — one with `claude-opus-4-6`, one with `claude-opus-4-7`.
2. Mutable loader closure: `let configRef = configV1; const loader = () => configRef;`
3. Construct `SessionManager(loader, ...)`.
4. First `getOrCreateSession(chatA)` — assert spawned argv contains `--model claude-opus-4-6`.
5. Swap: `configRef = configV2`.
6. Call `getOrCreateSession(chatB)` (different chat to avoid session reuse) — assert new argv contains `--model claude-opus-4-7`.
7. Alternative: explicitly close chatA's session, then call `getOrCreateSession(chatA)` again — also asserts v2 model.
8. Swap loader to throw → assert `getOrCreateSession` throws (propagates the error, does not fall back silently).

Requires minor mocking of `spawnClaudeSession` to capture argv. If the existing test file already stubs it, reuse.

### Phase 4 — Documentation

- Update `bot/README.md` (if it documents restart-for-config) — call out that agents + sessionDefaults hot-reload, bindings/tokens still need restart.
- Update `.claude/rules/platform/bot-operations.md` (confirmed platform path, not custom): add line — "Config changes to agents/sessionDefaults: no restart needed. Bindings/tokens/metricsPort: restart still required."

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Typo in `config.local.yaml` blocks new sessions | By design — explicit failure. User sees error in chat, fixes yaml, next message works. Existing sessions unaffected. |
| Disk read per spawn | Negligible — tiny file, cron-runner already does this on every cron tick |
| Stored sessions reference deleted agentId | Already handled by `resolveStoredSession` (`session-manager.ts:565`) |
| Renamed agent (bindings reference new id) | Not covered — bindings are boot-level. Renames require restart. Document. |
| `idleTimeoutMs` changed at runtime affects stale session eviction | Desired behavior — next eviction pass picks up new value |
| Already-armed `setTimeout` in `resetIdleTimer` uses old timeout | Accepted — new value applies on next timer reset (next message in session). Not worth clearing/re-arming live timers. |
| Multiple reloads per message (race) | Single `getFreshConfig()` call per decision point, no retry loops |

## Acceptance Criteria

1. Edit `config.yaml` → change `agents.main.model` → `launchctl` status of bot unchanged
2. Existing active session continues with old model
3. Next new session spawned picks up new model (verify via `grep "claude-opus" <bot-log>` showing new model in argv)
4. Introduce deliberate yaml syntax error → new sessions fail to spawn, user sees error message in chat, log shows `config: reload failed` line; existing active session continues working; fix yaml → next new message spawns successfully
5. Unit test passes (`npm test`)

## Out-of-Scope Follow-ups (future issues, not in this PR)

- Hot-reload of `bindings` (would let us add a new chat without restart)
- SIGHUP handler (explicit trigger vs lazy per-spawn)
- File watcher with debounce (eager vs lazy)
- Reload of `logLevel` (has `setLogLevel` already — one-liner if ever needed)

## Workflow

1. Open branch on `fitz123/claude-code-bot`
2. Invoke ralphex with this plan file
3. Review PR on GitHub (gitleaks, copilot, tests)
4. Merge, then `git merge upstream/main` in `~/.minime/workspace/`
5. Restart bot once to pick up the refactor code (SIGTERM, wait for drain)
6. Validate: change model in `config.local.yaml`, confirm next new session uses it without restart

## References

- Issue: https://github.com/fitz123/claude-code-bot/issues/96
- Research: `/tmp/plan-ENQYRc/research-quick.md` (will be lost on tmp cleanup; key findings copied above)
- Related: `bot/src/cron-runner.ts` — existing stateless reload pattern
