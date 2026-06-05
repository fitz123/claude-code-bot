# Plan: Post-Pi Claude Code Runtime Cleanup

GitHub issue: #140

## Goal

After the Pi/Codex migration is fully functional, remove the obsolete Claude Code CLI runtime path from the bot codebase and make Pi the single supported execution backend for interactive sessions and LLM crons.

This is the final cleanup phase after:

1. all production agents are switched to `provider: pi`,
2. Plan C (`cron-runner` → Pi print mode) is merged and deployed,
3. Codex quota/status monitoring is merged and deployed.

The outcome should be a smaller, less ambiguous codebase with no live dependency on `claude -p`, Anthropic OAuth env vars, Claude fallback models, or Claude-specific runtime branching.

## Context / Evidence

Current Claude-runtime remnants verified in `fitz123/claude-code-bot`:

- `bot/src/cli-protocol.ts` is a dedicated Claude CLI protocol module:
  - spawns binary `claude`,
  - builds `claude -p --input-format stream-json --output-format stream-json`,
  - sends Claude stream-json user messages,
  - parses Claude stream-json events.
- `bot/src/session-manager.ts` still imports both `spawnClaudeSession/sendMessage/readStream` and Pi RPC, then dispatches on `agent.provider === "pi"`.
- `bot/src/types.ts` still models `provider?: "claude" | "pi"`, `fallbackModel`, and Claude-only `effort?: "low" | "medium" | "high"`.
- `bot/src/config.ts` still defaults absent provider to `"claude"`, validates Claude fallback behavior, and has error text that treats `defaultModel` as Claude-oriented.
- `bot/src/cron-runner.ts` still has `runClaude()` with hard-coded `claude-opus-4-6` / `claude-sonnet-4-6`; Plan C will replace this, so this cleanup must run after Plan C.
- `bot/scripts/start-bot.sh` and `bot/scripts/run-cron.sh` still export Claude Code env vars and read `claude-code-oauth-token` from Keychain.
- `bot/src/cli-capabilities.ts` probes `claude --version`, `claude --help`, and `claude auth status`.
- Tests contain substantial Claude-path coverage (`provider-config`, `cli-protocol`, Claude branches in `session-manager`, config defaults, cron-runner).
- Public defaults still present Claude-oriented examples (`config.yaml` `defaultModel: opus`, fallback model, `provider: claude` comments; `crons.yaml` says LLM crons run `claude -p`).

Important non-goal: do **not** delete or rename workspace context files just because they contain `CLAUDE` in the name. `CLAUDE.md`, `.claude/rules`, and `.claude/skills` are still the current workspace/context convention and are consumed by the Pi context assembler. Removing runtime Claude CLI support is not the same as renaming the context substrate.

## Decisions

- Pi/Codex is the only runtime backend after this cleanup.
- Remove the `provider` switch from runtime code. If a config still declares `provider: claude`, fail config validation with a clear migration error.
- Keep a compatibility grace only where cheap and safe:
  - Accept `provider: pi` as optional/no-op for existing configs.
  - Reject `provider: claude` explicitly.
  - Do not preserve a hidden Claude fallback path.
- Keep `model` explicit for Pi agents until a later config-default cleanup; do not redesign fleet model defaults in this phase.
- Rename metrics only if it can be done without losing dashboard continuity; otherwise keep metric names but update help text/comments to say legacy names include Pi data. Prefer low-risk cleanup over Prometheus time-series churn.
- Do not touch browser/Notion/memory-RAG parity here; those are separate fast-follows.

## Risk Register

| Risk | Mitigation |
|---|---|
| Accidentally removing `CLAUDE.md`/rules/skills context support | Explicit non-goal; add tests that Pi context assembler still loads `CLAUDE.md` + `.claude/rules`. |
| Breaking public users who still configure `provider: claude` | Make config error explicit: Claude runtime removed, set/remove provider for Pi. Mention in README/CHANGELOG if applicable. |
| Removing Claude code before Plan C lands | Task 0 gate: fail if `cron-runner` lacks the Pi cron path from Plan C. Remaining `runClaude` is removed by this cleanup. |
| Metrics/dashboard break from renaming `bot_claude_*` | Either keep metric names with updated help, or add new names in a separate monitoring migration. No silent rename in this plan. |
| Tests only assert deletion, not behavior | Keep end-to-end Pi session-manager tests and cron Pi print-mode tests as acceptance gates. |

## Validation Commands

Run from the public repo root (`claude-code-bot`):

```bash
npm test
npm run typecheck
npx tsx bot/src/config.ts --validate
rg -n "spawnClaudeSession|cli-protocol|runClaude\(|claude -p|CLAUDE_CODE_OAUTH_TOKEN|CLAUDECODE|ANTHROPIC_API_KEY|fallbackModel|defaultFallbackModel|provider: claude|provider \"claude\"|claude-opus|claude-sonnet" bot/src bot/scripts config.yaml crons.yaml README.md docs --glob '!docs/plans/**'
```

Expected grep result after cleanup: no live-runtime references. Allowed residuals must be documented in an allowlist section of the PR description, e.g. `CLAUDE.md` context naming, historical docs under `docs/plans/**`, and comments that intentionally explain legacy metric names.

## PR Description: Residual Reference Allowlist

Residual `Claude`/`CLAUDE`/`Anthropic` references after the cleanup are intentional in these categories:

- Context-convention names: `CLAUDE.md`, `.claude/rules`, `.claude/skills`, and tests/docs for the Pi context assembler remain because Pi still loads the existing workspace context convention. Hook compatibility tests also keep `CLAUDE_PROJECT_DIR` and `.CLAUDE/HOOKS` references for the current guard scripts.
- Historical docs: old planning documents under `docs/plans/**` are retained as historical records and are excluded from the live-runtime grep.
- Legacy metric names: `bot_claude_*` metric names remain for Prometheus dashboard continuity; help text describes active-runtime usage.
- Migration guards and secret scrubbing: config/cron validation rejects `provider: claude`, `engine: claude`, `fallbackModel`, and `defaultFallbackModel`; Pi spawn/cron wrappers still scrub stale `CLAUDE_CODE_*`, `CLAUDECODE`, and `ANTHROPIC_*` environment variables so obsolete credentials do not leak to child processes.
- README lineage/comparison text: Similar Projects mentions Anthropic/Claude Code only to compare external projects and project history, not as setup or runtime guidance.

No obsolete live-runtime references remain: no `spawnClaudeSession`, `cli-protocol` import, `runClaude(` path, `claude -p` invocation, launch-script OAuth read, or hard-coded Claude model remains outside historical plans.

## Tasks

### Task 0: Pre-flight gates

- [x] Confirm Plan C is merged: `bot/src/cron-runner.ts` has the Pi cron execution path (`runPi`, `resolveCronEngine`, Pi print-mode classification/tests). Remaining `runClaude` cleanup is Task 5, not a pre-flight blocker. Verified `runPi`, `resolveCronEngine`, `classifyPiResult`, and `bot/src/__tests__/cron-runner-pi.test.ts`.
- [x] Confirm Codex quota/status pipeline is merged or explicitly declared out-of-scope for this cleanup PR. Verified `bot/src/codex-quota-sampler.ts`, `bot/src/quota-status.ts`, status rendering, tests, and sampler dry-run.
- [x] Confirm production config no longer contains any active `provider: claude` agents. Parsed `config.yaml` and `crons.yaml`; no active `provider: claude` entries.
- [x] Confirm the branch starts from current `main` and does not include untracked unrelated plan files. After `git fetch origin main`, `origin/main` is the merge-base of `HEAD`; no untracked plan/progress files.

### Task 1: Make Pi the only interactive runtime

- [x] Remove the Claude branch from `bot/src/session-manager.ts`.
- [x] Remove imports of `spawnClaudeSession`, `sendMessage`, and `readStream`.
- [x] Spawn sessions only via `spawnPiRpcSession(agent, resume ? sessionId : undefined)`.
- [x] Send prompts only via `sendPiPrompt(session.child, text, "followUp")`.
- [x] Read streams only via `readPiStream(session.child)`.
- [x] Simplify `ActiveSession.provider` away, or pin it to a literal Pi-only type if needed temporarily.
- [x] Update shutdown injection to always use `sendPiSteer`; remove the Claude inject-file branch for live subprocesses.
- [x] Keep inject directory cleanup only if still needed elsewhere; otherwise remove inject-dir creation from session lifecycle.
- [x] Update error text from `Claude subprocess ...` to provider-neutral or Pi-specific wording.
- [x] Preserve Pi resume-recovery, session id capture, crash backoff, media/outbox cleanup, queue semantics, and activity timeout behavior.

### Task 2: Delete obsolete Claude protocol/capability modules

- [x] Delete `bot/src/cli-protocol.ts`.
- [x] Delete `bot/src/cli-capabilities.ts` if no remaining imports exist.
- [x] Delete or rewrite tests whose only purpose is Claude CLI protocol/capability behavior.
- [x] Ensure no import path references those modules.

### Task 3: Simplify config model and validation

- [x] Change `AgentConfig.provider` to optional compatibility field that only accepts absent/`pi`; reject `claude` with a clear migration error.
- [x] Remove runtime default of absent provider → `claude`; absent provider means Pi.
- [x] Remove `fallbackModel` from active config semantics unless still needed by a non-runtime feature. If removed, validation should reject it with a migration error.
- [x] Replace Claude-only `effort` semantics with the Pi/Codex thinking field introduced by quota/status pipeline, or leave `effort` rejected if superseded.
- [x] Update validation tests: absent provider = Pi, `provider: pi` accepted, `provider: claude` rejected, Claude fallback fields rejected/ignored per final decision.
- [x] Update config error messages to avoid saying `defaultModel` is Claude-oriented.

### Task 4: Remove Claude env setup from scripts

- [x] In `bot/scripts/start-bot.sh`, remove Keychain read for `claude-code-oauth-token`.
- [x] Remove exports of Claude-only env vars: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY`, `CLAUDE_CODE_ENABLE_TELEMETRY` unless independently required by non-Claude tooling.
- [x] Keep generic `PATH`, `HOME`, and bot debug setup.
- [x] In `bot/scripts/run-cron.sh`, remove Claude OAuth/env setup after Plan C makes LLM crons Pi-based.
- [x] Keep secret-scrubbing for script-mode crons only if it is generic safety; update comments away from Claude-specific phrasing.

### Task 5: Clean cron-runner after Plan C

- [x] Ensure no `runClaude` export remains.
- [x] Ensure LLM cron execution uses the Pi print-mode runner from Plan C.
- [x] Update log strings from `Claude returned ...` to `LLM returned ...` or `Pi returned ...`.
- [x] Update tests to cover Pi cron execution and failure notification paths.
- [x] Remove hard-coded Claude models and fallback models.

### Task 6: Update metrics names/help carefully

- [x] Audit `bot/src/metrics.ts` for `bot_claude_*` names and help strings.
- [x] Prefer keeping metric names for continuity but update help text/comments to say legacy metric names record agent-token usage from the active runtime.
- [x] If the implementation chooses to rename metrics, add a compatibility note and update monitoring config in the same PR or explicitly split to a separate PR. Kept legacy names, so no rename compatibility migration is needed.
- [x] Ensure Pi-specific metrics (`bot_pi_*`, Codex quota metrics) remain intact.

### Task 7: Update public defaults and docs

- [x] Update `config.yaml` defaults from Claude-oriented examples to Pi/Codex examples.
- [x] Remove `defaultFallbackModel` from defaults if fallback models are removed from config semantics.
- [x] Update `crons.yaml` field reference: LLM crons no longer run `claude -p`.
- [x] Update README sections that describe Claude Max / Claude Code CLI subprocess as the runtime.
- [x] Update AI/operator documentation, including `.claude/skills/bot-operations/SKILL.md`, to remove Claude runtime references and document Pi-only config/cron behavior.
- [x] Keep historical `docs/plans/**` untouched unless they are current docs; do not rewrite old plans just to remove old terms.
- [x] Update any workspace template comments that tell users to store Claude OAuth tokens.

### Task 8: Test cleanup and regression coverage

- [x] Remove Claude-only tests: `cli-protocol.test.ts`, `cli-capabilities` tests if present, Claude-branch-only cases in `session-manager*.test.ts`.
- [x] Add/keep Pi-only tests for:
  - absent provider config spawns Pi,
  - explicit `provider: pi` spawns Pi,
  - explicit `provider: claude` is rejected,
  - session startup captures Pi session id,
  - resume-not-found recovery still works,
  - prompt sends `streamingBehavior: "followUp"`,
  - graceful shutdown uses Pi steer,
  - cron LLM path uses Pi print mode.
- [x] Keep context assembler tests proving `CLAUDE.md`, `MEMORY.md`, `.claude/rules`, and skills context still work.

### Task 9: Residual reference audit

- [x] Run the grep from Validation Commands.
- [x] Categorize every remaining `Claude`/`CLAUDE`/`Anthropic` hit:
  - allowed context-convention names (`CLAUDE.md`, `.claude/rules`, `.claude/skills`),
  - historical docs under `docs/plans/**`,
  - legacy metric names intentionally kept,
  - obsolete runtime references that must be removed.
- [x] Add a short PR comment/description section documenting allowed residual references so reviewers do not chase intentional leftovers.

### Task 10: Deployment / migration notes

- [x] State that this is a post-migration breaking cleanup: configs using `provider: claude`, `fallbackModel`, or Claude OAuth env setup must be updated. Breaking cleanup note: remove `provider: claude`, remove `fallbackModel` / `defaultFallbackModel`, and remove Claude OAuth token setup before deploying this change.
- [x] After merge to public repo, sync workspace via `git fetch upstream && git merge upstream/main` (skipped - not automatable before public merge).
- [x] Restart bot with the canonical script only after operator confirmation (skipped - requires operator confirmation).
- [x] After deployment, verify at least one live Pi session and one LLM cron execution (skipped - requires deployed environment).

## Acceptance Criteria

- No live code path spawns `claude`.
- No launch script reads `claude-code-oauth-token` or exports Claude Code runtime env vars.
- `provider: claude` fails fast with a clear migration error, or provider is removed entirely from schema.
- Interactive sessions and LLM crons both use Pi/Codex.
- Tests and typecheck pass.
- Public defaults and docs describe Pi/Codex as the runtime.
- `CLAUDE.md` context loading remains intact through the Pi context assembler.
