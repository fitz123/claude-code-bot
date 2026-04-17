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

### Task 1: SessionManager refactor + wire loader

**Files:** `bot/src/session-manager.ts`, `bot/src/main.ts`

- [x] Replace `private agents` / `idleTimeoutMs` / `maxConcurrentSessions` fields with `private loadConfig: () => BotConfig`
- [x] Constructor signature: `constructor(loadConfig: () => BotConfig, storePath?, logDir?)` with fail-fast validation
- [x] Add `private getFreshConfig(): BotConfig` with success/error logging
- [x] `getOrCreateSession` uses fresh config for agent lookup, eviction, and resolveStoredSession
- [x] `resolveStoredSession` accepts optional config param, falls back to getFreshConfig()
- [x] `resetIdleTimer` reads fresh idleTimeoutMs (with safe fallback on config error)
- [x] `evictIfNeeded` accepts optional config param for maxConcurrentSessions
- [x] `main.ts`: `new SessionManager(() => loadConfig())`
- [x] Migrate all ~45 test call sites to new constructor signature
- [x] All 915 existing tests pass, TypeScript compiles cleanly

### Task 2: Hot-reload tests

- [x] Create two BotConfig fixtures (claude-opus-4-6 vs claude-opus-4-7)
- [x] Mutable loader closure test: swap config between sessions, assert new model in spawn args
- [x] Error propagation test: loader throws -> getOrCreateSession throws
- [x] Mock spawnClaudeSession to capture argv

### Task 3: Documentation

- [x] Update `bot/README.md` if it documents restart-for-config
- [x] Update `.claude/rules/platform/bot-operations.md`: agents/sessionDefaults hot-reload, bindings/tokens still need restart

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
