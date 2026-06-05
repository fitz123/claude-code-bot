# Plan: Codex quota sampler + compact /status

## Goal

Implement cached Codex quota visibility in Telegram/Discord `/status` without degrading live Pi sessions.

Success criteria:
- Live bot sessions keep Pi `transport: auto` / WebSocket; no forced SSE for user conversations.
- A separate low-frequency sampler performs a tiny Codex SSE probe and exports cached quota data.
- `/status` displays model, thinking/effort, processing/idle state, session id, active sessions, uptime, and Codex quota when available.
- `/status` never calls Codex directly; it reads cached local state only.
- If quota data is stale or sampler failed, `/status` says so honestly.
- Existing Prometheus/node_exporter path can alert on high usage.

Non-goals:
- Do not add a separate `/quota` command in MVP.
- Do not force SSE transport for normal Telegram/Discord Pi sessions.
- Do not fetch or parse ChatGPT credentials directly; use Pi as the authenticated transport.
- Do not implement quota sources for non-Codex providers yet; keep internal interfaces extensible.

## Context

Relevant files:
- `bot/src/telegram-bot.ts` — current `/status` command.
- `bot/src/discord-bot.ts` — duplicated `/status` command.
- `bot/src/session-manager.ts` — `ActiveSession`, `SessionHealth`, spawn-time session metadata.
- `bot/src/types.ts` — `AgentConfig` currently has `model`, Claude-only `effort`, no Pi `thinking` field.
- `bot/src/pi-rpc-protocol.ts` — Pi spawn args and extension wrapper list.
- `bot/.claude/extensions/` — Pi extension wrappers loaded into bot-spawned Pi sessions.
- `bot/scripts/` — operational scripts; add sampler here.
- `bot/src/__tests__/` — tests for config, Pi protocol, status commands, metrics.

Evidence:
- Pi `after_provider_response` gets HTTP response headers only on Codex SSE path.
- Pi Codex default `transport` is `auto`, which tries WebSocket first.
- WebSocket path does not call `options.onResponse`; SSE path does.
- Forcing `transport: sse` on a live session can fail before headers with `Codex SSE response headers timed out after 10000ms` (`DEFAULT_SSE_HEADER_TIMEOUT_MS = 10_000`). This is a reliability regression for user conversations.
- Observed useful headers under SSE:
  - `x-codex-primary-used-percent`
  - `x-codex-secondary-used-percent`
  - `x-codex-primary-reset-at`
  - `x-codex-secondary-reset-at`
  - `x-codex-plan-type`
  - `x-codex-active-limit`

Existing desired `/status` content from user:
- Keep `session id` — useful for terminal resume.
- Keep `processing` / `idle` — used to detect stuck sessions.
- Add model name.
- Add thinking level / effort.
- Remove normal-path noise where possible: RSS memory, PID, restart count when zero, last success when healthy.

## Validation Commands

```bash
cd bot && npm test
cd bot && npm run lint
cd bot && npm run build
cd bot && npm run validate-config

# Sampler smoke test with temp outputs; must not touch production textfile dir.
cd bot && CODEX_QUOTA_TEXTFILE_DIR=/tmp/codex-quota-test CODEX_QUOTA_STATE_FILE=/tmp/codex-quota-test/state.json npx tsx scripts/codex-quota-sampler.ts --dry-run
```

## Decisions

1. **Normal sessions stay WebSocket/auto.**
   - Value: do not set global/project `transport: "sse"` for bot workspaces.
   - Reason: forcing SSE causes real 10s header-timeout failures before response start.

2. **Quota collection is a separate sampler.**
   - Value: a script runs a small isolated Pi SSE probe and writes cached state/metrics.
   - Reason: quota observability must not affect interactive session reliability.

3. **`/status` reads local cache, not Codex.**
   - Value: command reads a JSON state file written by the sampler; Prometheus scrapes `.prom` files for alerting.
   - Reason: status must be fast and must not consume quota or trigger network failures.

4. **Prometheus metrics keep ADR-compatible names.**
   - Value: export `codex_usage_5h_percent`, `codex_usage_weekly_percent`, reset timestamps, last success/attempt timestamps, and probe success.
   - Reason: ADR-072 already names `codex_usage_5h_percent` / `codex_usage_weekly_percent` for `CodexUsageHigh`.

5. **Provider extensibility lives in code structure, not metric over-generalization.**
   - Value: implement `QuotaSnapshot` / `QuotaProvider` style internal types, but only Codex provider in MVP.
   - Reason: avoids premature metric abstraction while keeping future providers straightforward.

6. **Pi thinking uses a dedicated config field.**
   - Value: add optional `AgentConfig.thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` for Pi and pass `--thinking` on Pi spawn.
   - Reason: current `effort` is Claude-only and only allows low/medium/high; Pi supports xhigh.

## Tasks

### Task 1: Add Codex quota cache/export extension [HIGH]

**Goal:** Extract Codex quota headers on successful SSE probe and write cache + Prometheus metrics atomically.

**Files:**
- Create: `bot/.claude/extensions/codex-usage.ts`
- Create/Modify tests under: `bot/src/__tests__/`

- [x] Implement header parser for `x-codex-primary-used-percent`, `x-codex-secondary-used-percent`, reset timestamps, plan type, active limit.
- [x] Write a JSON state file atomically; default path from `CODEX_QUOTA_STATE_FILE`, with a safe local default.
- [x] Write Prometheus textfile atomically; textfile dir from `CODEX_QUOTA_TEXTFILE_DIR` or `NODE_EXPORTER_TEXTFILE_DIR`, defaulting to `/opt/homebrew/var/node_exporter/textfile` only when writable.
- [x] Export ADR-compatible gauges: `codex_usage_5h_percent`, `codex_usage_weekly_percent`, `codex_usage_5h_reset_timestamp`, `codex_usage_weekly_reset_timestamp`, `codex_usage_last_success_timestamp`.
- [x] Include info metric or labels for plan/active limit without high cardinality.
- [x] Treat missing quota headers as no-op, not error.
- [x] Treat malformed numeric headers as skipped fields, not process crash.
- [x] Add unit tests for header parsing, malformed values, absent headers, and atomic file writes.
- [x] Run `cd bot && npm test`.

### Task 2: Add isolated Codex quota sampler script [HIGH]

**Goal:** Run a tiny Pi SSE probe out-of-band and mark probe success/failure without breaking user sessions.

**Files:**
- Create: `bot/scripts/codex-quota-sampler.ts`
- Modify tests under: `bot/src/__tests__/`

- [x] Script creates or uses an isolated sampler cwd with project `.pi/settings.json` containing only `{ "transport": "sse" }`.
- [x] Script invokes Pi with `--provider openai-codex`, configured model, `--thinking off`, `--no-context-files`, `--no-skills`, `--no-extensions`, explicit `--extension <codex-usage.ts>`, `--no-session`, and a minimal prompt.
- [x] Script must never edit global `~/.pi/agent/settings.json` and must never set workspace `.pi/settings.json` for normal sessions.
- [x] Add a bounded wall-clock timeout around the Pi child; on timeout/failure, kill child and continue failure recording.
- [x] On every attempt, write `codex_usage_last_attempt_timestamp` and `codex_usage_probe_success` in a separate `.prom` file.
- [x] On failure, preserve last successful usage values; do not delete or overwrite the success metrics/state with empty data.
- [x] Add CLI flags/env for model, textfile dir, state file, sampler cwd, timeout, and dry-run.
- [x] Add tests for command construction, success path, timeout/failure path, and preservation of prior successful state.
- [x] Run `cd bot && npm test`.

### Task 3: Add quota status reader/formatter [HIGH]

**Goal:** Provide a small cached-data API used by `/status`.

**Files:**
- Create: `bot/src/quota-status.ts`
- Create/Modify tests under: `bot/src/__tests__/`

- [x] Define `QuotaSnapshot` with provider, windows (`5h`, `week`), used percent, remaining percent, reset timestamps, last success, last attempt, probe success, plan type.
- [x] Read the sampler JSON state file from `CODEX_QUOTA_STATE_FILE` or default path.
- [x] Compute freshness with default stale threshold, e.g. 30 minutes, overrideable by `CODEX_QUOTA_STALE_MS`.
- [x] Format reset ETA and sample age compactly (`4h 52m`, `6d 23h`, `2m ago`).
- [x] Return explicit states: `available`, `stale`, `unavailable`, `read_error`.
- [x] Add tests for fresh data, stale data, missing file, malformed file, and reset ETA formatting.
- [x] Run `cd bot && npm test`.

### Task 4: Enrich session health with model and thinking/effort [HIGH]

**Goal:** Make `/status` show spawn-time model and reasoning settings without probing Pi mid-turn.

**Files:**
- Modify: `bot/src/types.ts`
- Modify: `bot/src/config.ts`
- Modify: `bot/src/pi-rpc-protocol.ts`
- Modify: `bot/src/session-manager.ts`
- Modify tests under: `bot/src/__tests__/`

- [x] Add `AgentConfig.thinking` with Pi levels: `off|minimal|low|medium|high|xhigh`.
- [x] Validate `thinking` in config; keep existing Claude `effort` validation unchanged.
- [x] Pass `--thinking <level>` from `buildPiSpawnArgs` when `agent.provider === "pi"` and `agent.thinking` is set.
- [x] Store spawn-time `provider`, normalized model, `thinking`, and `effort` in `ActiveSession`.
- [x] Include those fields in `SessionHealth` returned by `getSessionHealth`.
- [x] Do not send `get_state` from `/status`; avoid stdout-reader races while a turn is processing.
- [x] Add tests for config validation, Pi spawn args with `--thinking xhigh`, and health metadata.
- [x] Run `cd bot && npm test`.

### Task 5: Refactor and compact `/status` rendering [HIGH]

**Goal:** Use one shared status renderer for Telegram and Discord and include quota block.

**Files:**
- Create: `bot/src/status-report.ts`
- Modify: `bot/src/telegram-bot.ts`
- Modify: `bot/src/discord-bot.ts`
- Create/Modify tests under: `bot/src/__tests__/`

- [x] Implement shared `buildStatusReport(...)` that receives active count, max sessions, uptime, optional session health, and optional quota status.
- [x] Normal output includes agent/provider, model, thinking or effort, state (`processing` or `idle`), session id, sessions count, uptime.
- [x] Normal output excludes memory RSS, PID, last success, and restarts when healthy.
- [x] Diagnostic output includes PID when dead, restarts when `>0`, and last success when missing/stale.
- [x] Add Codex quota block when quota state exists or when current session is Pi/Codex.
- [x] Fresh quota format: used + left percent for 5h/week, reset ETA, sample age.
- [x] Stale/unavailable quota format: clearly state stale/unavailable and last attempt/success if known.
- [x] Wire Telegram `/status` to the shared renderer.
- [x] Wire Discord `/status` to the same shared renderer.
- [x] Add renderer tests for idle, processing, dead session, restarts, fresh quota, stale quota, and no quota data.
- [x] Run `cd bot && npm test`.

### Task 6: Add operational docs and private rollout notes [MED]

**Goal:** Document how to run the sampler and how to wire it into existing monitoring without committing private config.

**Files:**
- Modify public docs as appropriate (`README.md` only if this is user-facing and safe; otherwise a bot docs file if available)
- Do not modify private `crons.local.yaml` in the public PR.

- [x] Document sampler env vars and example launchd/cron invocation.
- [x] Document recommended sample interval (15-30 minutes) and stale threshold.
- [x] Document that normal sessions must stay on `transport: auto`.
- [x] Document Prometheus alert expression: `codex_usage_5h_percent > 85 OR codex_usage_weekly_percent > 90`.
- [x] Add a post-merge note: private workspace needs a script cron/launchd entry for `codex-quota-sampler.ts` and optional monitoring rule update.
- [x] Run `cd bot && npm run lint`.

### Task 7: Verify acceptance criteria [HIGH]

- [x] Verify normal Pi spawn args do not include any global/session-wide forced SSE setting.
- [x] Verify sampler uses isolated project settings for `transport: sse` only in the sampler cwd.
- [x] Verify `/status` does not call Pi/Codex/network; it only reads local cache.
- [x] Verify stale/missing quota cache renders honestly.
- [x] Verify model + thinking/effort appear in `/status`.
- [x] Verify `session id` and `processing/idle` remain visible.
- [x] Run `cd bot && npm test`.
- [x] Run `cd bot && npm run lint`.
- [x] Run `cd bot && npm run build`.
- [x] Run `cd bot && npm run validate-config`.

### Task 8: Update documentation [HIGH]

- [x] Update relevant docs with the sampler/status behavior.
- [x] Include the SSE timeout rationale so future maintainers do not force SSE on live sessions.
- [x] Include rollback: disable sampler cron and/or unset quota status env vars; live sessions are unaffected.
