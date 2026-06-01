# Pi Phase-2 — Extensions A1-A3 (ralphex) + A4 usage-exporter (workspace) — DRAFT v3

> Scope AGREED (Notion 2026-06-01) + refined by research 2026-06-01. Covers all 4, split by venue:
> - **ralphex (public repo, branch `feature/pi-extensions`, `-b main`, injected `second` Max token):** A1 guardian+protect-files, A2 web-tools/Tavily, A3 subagent. claude opus-4.8 executor + codex gpt-5.5 external review.
> - **workspace (I build directly, NOT ralphex):** A4 codex-usage exporter (mirrors the old `monitoring/scripts/budget-exporter.sh` pattern).
> **Philosophy (the maintainer):** simple Pi solutions, reuse vendor where possible, add complexity only as/if needed. **Out of concern (the maintainer):** schedule/deadline + Codex-token-expiry (the maintainer handles).
> **Research applied:** A4 via `after_provider_response` headers is DEAD — verified live: that event does NOT fire for the openai-codex provider (only session_start/agent_start/before_provider_request/turn_end/agent_end fire). Codex usage IS available via the CLI `/status` ("Rate Limits Remaining: 5h X%, Weekly Y%") + dashboard `chatgpt.com/codex/settings/usage`; the exact API endpoint/field is undocumented → A4 determines its source empirically at build (live codex API response / `~/.codex/logs_2.sqlite` / `codex` output). Vendor reuse: A1 ← `protected-paths.ts`+`permission-gate.ts`; A3 ← `subagent/` (official); A2 no vendor → build (Tavily, ~80-120 LOC).
> **planning:make canonical structure. PII-clean.**

## Overview
Bring Pi sessions to capability parity with the claude path: file-write guard (A1), web tools (A2), sub-agent spawn (A3) as Pi extensions loaded into every Pi spawn; plus proactive Codex-usage telemetry (A4) as a workspace exporter. claude path untouched.
- **Problem:** coder-on-Pi runs UNGUARDED (can edit upstream `bot/`/rules), no web tools, no sub-agent spawn, no Codex-limit telemetry. Plan A+B = core pipeline only.
- **Benefit:** A1 gates safe family cutovers; A2/A3 unblock research + multi-agent skills; A4 gives the proactive ChatGPT-Plus-limit signal.

**Success criteria (testable):**
1. **Loading:** every `pi --mode rpc` spawn includes A1-A3 via repeatable `--extension` (unless `PI_EXTENSIONS_DISABLED=1`); claude path byte-identical.
2. **A1:** edit/write/bash-redirect into an upstream-owned path (`bot/`, `.claude/rules/platform/`, `.github/workflows/`, `.githooks/`) BLOCKED with reason; workspace-structure violation blocked; allowed pass; fail-CLOSED on unknown root; the 4 bash-hook bugs fixed (traversal, APFS case, bash-redirect coverage, fail-open).
3. **A2:** `web_search`+`web_fetch` registered + model-callable, Tavily-backed (key from keychain `tavily-api-key`/`minime`); graceful error result (no throw) + warn-log on failure/missing-key.
4. **A3:** vendor `subagent/` DIRECTORY adopted; sub-agent tool callable, spawns an isolated `pi -p` child (openai-codex) returning a result; child-error warn-logged; tool name/contract matches what our Agent/Task skills invoke.
5. Full suite green; lint clean; claude path byte-identical; `cli-protocol.ts`/`cron-runner.ts` untouched.
6. **(A4 — workspace, separate):** a `codex-usage-exporter` emits `codex_usage_5h_percent`/`codex_usage_weekly_percent` to the node_exporter textfile dir (atomic temp+rename); a launchd cron runs it; a Prometheus `CodexUsageHigh` rule (5h>85% OR weekly>90%) → AlertManager → Ops 591. Source of the % determined empirically at build.

**Non-goals:** browser-tools, notion-REST (fast-follow); persona/AGENTS.md/memory/skills config (I do per binding); Plan C cron-runner; stealth browser; code-mode; dropped bash hooks (auto-stage/session-end-commit/session-start-recovery → backup-git; inject → steer); **A4 as a Pi extension (the after_provider_response path is dead → A4 is a workspace exporter, not in the ralphex run).**

## Context (verified 2026-06-01)
- **Loading (DELIBERATE):** bot loads extensions per-spawn via `buildPiSpawnArgs` pushing `--extension <repo-abs-path>` (jiti-loaded TS). Auto-discovery dirs are for `/reload`, intentionally NOT used. `buildPiSpawnArgs` emits no `--extension` today (pi-rpc-protocol.ts:105-125).
- **Location (LOCKED, Task 0):** pure testable helpers in `bot/src/pi-extensions/*.ts` (inside tsconfig `rootDir:src` + the `src/__tests__/*.test.ts` glob → covered by `tsc --noEmit` + `npm test`); thin `export default function(pi)` wrappers at `bot/.claude/extensions/<name>.ts` (or `<name>/index.ts` for A3) — jiti-loaded; state whether wrappers get a second tsconfig/glob or are jiti-only (tsc-excluded).
- **API:** `pi.on("tool_call",(e,ctx)=>({block:true,reason}))` (A1); `pi.registerTool({name,label,parameters,execute})` (A2).
- **A1:** vendor `protected-paths.ts` (block protected writes) + `permission-gate.ts` patterns + guardian workspace-structure; `node:path`. Single source of truth = the prefixes `protect-files.sh`/platform rules encode; pin with a test; keep the 4 prefixes + workspace-structure rule (no policy engine).
- **A2:** Tavily (`api.tavily.com`); key `security find-generic-password -s tavily-api-key -a minime -w`; registerTool per `tools.ts`. No vendor/community web-search extension exists → build.
- **A3:** vendor `examples/extensions/subagent/` is a MULTI-FILE DIRECTORY (index.ts ~35KB + agents.ts + agents/ + prompts/). Adopt the DIRECTORY (copy to `bot/.claude/extensions/subagent/`, `--extension` the dir), adapt only provider wiring (openai-codex). Name the tool/param contract our Agent/Task skills invoke.
- **A4 (workspace):** mirror `monitoring/scripts/budget-exporter.sh`. The proactive 5h/weekly% is NOT available via Pi (after_provider_response doesn't fire for openai-codex — verified). It IS in codex's `/status` + the dashboard; exact source = build-time empirical (candidate sources: a direct ChatGPT-backend codex API call reading rate-limit like the old Anthropic exporter; `~/.codex/logs_2.sqlite`; or wrapping `codex`). Atomic `.prom` write (temp+rename). Prometheus rule + AlertManager already operational.
- **claude path:** `cli-protocol.ts` untouched.

## Development Approach
Regular testing. Pure helpers in `bot/src/pi-extensions/` unit-tested in `bot/src/__tests__/`. Thin wrappers jiti-loaded (not unit-tested). Only `buildPiSpawnArgs` changes (append `--extension`, kill-switch-gated). Each task ships tests; all pass before next.

## Testing Strategy
Unit: loading args (+ kill-switch + missing-file fail-closed); A1 guard matrix (protected blocked incl. bash-redirect/`../`/case; allowed pass; fail-closed; pinned-list); A2 Tavily request/parse/error/missing-key (mock fetch); A3 spawn-arg builder + result parse + child-error (mock spawn). Regression: claude spawn args unchanged. No e2e (live Tavily/subagent during soak).

## Implementation Steps (ralphex — A1-A3)

### Task 0: Lock extension location + prove lint/test coverage
**Files:** Create `bot/src/pi-extensions/_smoke.ts` + `bot/src/__tests__/pi-extensions-smoke.test.ts` (throwaway, removed in Task 4)
- [ ] confirm `bot/src/pi-extensions/*.ts` covered by `tsc --noEmit` AND the `npm test` glob via a stub helper+test that runs green
- [ ] document wrapper-location lint coverage decision (second tsconfig/glob vs jiti-only)
- [ ] run lint+test on the stub before proceeding

### Task 1: Extension loading wiring (buildPiSpawnArgs → --extension, kill-switch)
**Files:** Modify `bot/src/pi-rpc-protocol.ts`, `bot/src/__tests__/pi-rpc-protocol.test.ts`
- [ ] `buildPiSpawnArgs` pushes `--extension <abs-path>` for each wrapper unless `PI_EXTENSIONS_DISABLED=1`; missing-file → loud fail-closed; note per-spawn `--extension` is deliberate
- [ ] claude path + existing Pi args unchanged
- [ ] tests: args include resolved paths; kill-switch omits; missing-file fails; claude unchanged
- [ ] run tests

### Task 2: A1 — guardian+protect-files guard
**Files:** Create `bot/src/pi-extensions/guard.ts` + `bot/.claude/extensions/guardian-protect-files.ts` + `bot/src/__tests__/guard.test.ts`
- [ ] `tool_call` handler: edit/write + bash redirect/`>`/`tee`/`mv`/`cp` into protected paths → `node:path` rel-path → block 4 prefixes + workspace-structure; `{block:true,reason}`; fail-CLOSED unknown root
- [ ] fix the 4 bash-hook bugs; pure `isProtectedPath`/`classifyToolCall` + pinned protected-list test
- [ ] tests: protected blocked (edit/write/bash-redirect/traversal/case); allowed pass; fail-closed
- [ ] run tests

### Task 3: A2 — web-tools (Tavily)
**Files:** Create `bot/src/pi-extensions/tavily.ts` + `bot/.claude/extensions/web-tools.ts` + `bot/src/__tests__/tavily.test.ts`
- [ ] register `web_search`+`web_fetch` (Tavily); key from keychain at load (fail clear + warn-log if absent); graceful error result on failure (no throw)
- [ ] pure request/parse helpers; structured warn-log
- [ ] tests: request shape, parse, API-error, missing-key (mock fetch)
- [ ] run tests

### Task 4: A3 — subagent (adopt vendor DIRECTORY)
**Files:** Create `bot/.claude/extensions/subagent/` (copied from vendor) + `bot/src/pi-extensions/subagent-args.ts` + `bot/src/__tests__/subagent.test.ts`; remove the Task-0 stub
- [ ] copy the vendor subagent DIRECTORY; adapt only provider wiring (openai-codex); name the tool/param contract our Agent/Task skills invoke
- [ ] testable spawn-arg builder + result parser (in bot/src/pi-extensions/); child-error warn-log
- [ ] tests: spawn-arg builder, result parse, child-error (mock spawn)
- [ ] run tests

### Task 5: Verify acceptance
- [ ] verify criteria 1-5; regression (claude byte-identical); grep-confirm `cli-protocol.ts`/`cron-runner.ts` untouched
- [ ] end-to-end smoke: a Pi spawn loads all 3 extensions
- [ ] full suite `cd bot && npm test`; lint `npm run lint`

### Task 6: [Final] Docs + Rollback
**Files:** Modify `README.md` (repo root)
- [ ] note A1-A3 + `--extension` loading + `PI_EXTENSIONS_DISABLED` kill-switch
- [ ] **Rollback:** code = `git revert <merge>` → workspace upstream-merge → `restart-bot.sh`; fast = `PI_EXTENSIONS_DISABLED=1` + restart
- [ ] move plan to `docs/plans/completed/`

## A4 — codex-usage exporter (WORKSPACE task, I build directly — NOT ralphex)
1. **Determine the % source empirically:** capture a live codex rate-limit (direct ChatGPT-backend codex API call with the keychain codex token reading the rate-limit response, à la the old Anthropic budget-exporter; OR read `~/.codex/logs_2.sqlite`; OR wrap `codex`). Pick the most reliable.
2. **`monitoring/scripts/codex-usage-exporter.sh`** (or .py) — emit `codex_usage_5h_percent`/`codex_usage_weekly_percent` (+ scrape_success) to the node_exporter textfile dir, ATOMIC temp+rename (pattern from budget-exporter.sh).
3. **launchd cron** (every ~15min, like budget-exporter) + **Prometheus `CodexUsageHigh` rule** (5h>85% OR weekly>90%) via `promtool check rules` → reload → AlertManager → Ops 591.
4. Also confirm Plan A's backstop counters (`pi_429/overload/retry_total`) are scraped (reactive backstop to the proactive gauges).

## Pre-launch (ralphex, A1-A3):
- `-b main`; inject `second` Max token; verify DIFFSTATS == `git diff --stat main...HEAD`.

## Post-Completion
- Merge A1-A3 → upstream-sync (extensions auto-load all Pi agents). Build A4 exporter (workspace). Resume cutovers (A1 live → safe): per-binding persona/AGENTS.md/memory-recall HARD GATE (I do) before each soak. Fast-follow: browser-tools, notion-REST. Separate: Plan C.
