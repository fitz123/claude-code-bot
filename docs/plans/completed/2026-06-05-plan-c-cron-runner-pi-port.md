# Plan C — Port `cron-runner.ts` from `claude -p` to vanilla Pi print mode

## Revision Notes (round 2)

- Fixed the round-1 critical blocker: Pi crons must use a literal `openai-codex/gpt-5.5`, never `agent.model` and never `normalizePiModel()`.
- Removed the `normalizePiModel` import requirement; it is module-private in `pi-rpc-protocol.ts`.
- Cut the `run-cron.sh`/`cron-engine.ts` OAuth provider-guard scope. `buildPiSpawnEnv()` already deletes Claude/Anthropic credentials before spawning Pi.
- Simplified agent resolution: build a minimal Pi `AgentConfig` for context assembly instead of adding a heavyweight config re-validation path.
- Simplified cron-health metrics: write last success only on success, write last exit code on every run, no read-modify-write.
- Split public-repo implementation tasks from private workspace operator rollout steps.

## Goal

Add a per-cron `engine: claude | pi` field, defaulting to `claude`, plus a global `CRON_PI_DISABLED=1` kill-switch. Generalize the LLM cron execution path from `runClaude()` into `runOneShot(cron, workspaceCwd)` and add `runPi()` that spawns vanilla Pi (`earendil-works/pi-coding-agent`) in blocking one-shot print mode.

The ralphex deliverable is the **public-repo mechanism**: engine dispatch, Pi spawn, context parity, safety nets, tests, and docs. It must **not** flip production crons. Production flips are private workspace operator steps after merge/soak.

## Status

Public implementation is complete. Private post-merge rollout remains pending and is not part of this PR.

## Cron Engine Contract

- LLM crons default to `engine: claude`; `engine: pi` is opt-in and valid only for LLM crons. Script crons ignore `engine`.
- `CRON_PI_DISABLED=1` forces all LLM crons to the Claude engine. `PI_EXTENSIONS_DISABLED=1` is not a cron rollback path because Pi crons require A1 and fail closed if A1 would be disabled.
- Pi crons spawn `pi -p` with `--no-session --no-extensions`, literal model `openai-codex/gpt-5.5`, validated `--thinking` from agent `effort` or `medium`, context files from `assemblePiContext()`, and only the explicit A1 guard extension.
- Pi crons build env with `buildPiSpawnEnv()`, set `HOME` when absent, and rely on Pi auth in `~/.pi/agent/auth.json`, not Claude OAuth.
- Result classification preserves existing delivery behavior: non-empty stdout is deliverable output, empty stdout/stderr is successful no-delivery, `NO_REPLY` is successful no-delivery for LLM crons, and stderr-only success/non-zero/signal/spawn failures enter the existing `⚠️ Cron FAIL` path.
- Cron health textfiles are best-effort node_exporter files: last success timestamp is updated only on success, last exit code is updated on every run, and metric failures must not mask the cron result.

`main()` must remain behavior-preserving. The only sanctioned diffs are:
1. `runClaude()` call site becomes `runOneShot()` engine dispatch.
2. A cron-health metric hook records success/failure state.

Everything else stays the same: delivery behavior, `NO_REPLY` suppression, intentional empty-output skip, `⚠️ Cron FAIL` delivery/admin fallback, exit codes, script cron behavior, and 15-minute timeout default.

## Context

Implementation target: public repo `fitz123/claude-code-bot`, under `bot/`.

Source evidence checked in the public repo:

- `bot/src/cron-runner.ts:269-312` — current `runClaude()` uses `execSync`, text output, timeout, `cwd: workspaceCwd`, and returns `output.trim()`.
- `bot/src/cron-runner.ts:318-410` — current `main()` contract: load cron, resolve workspace for LLM crons, run script/LLM, deliver fail/success, skip empty/NO_REPLY.
- `bot/src/types.ts:64-75` — `CronJob` currently has no `engine` field.
- `bot/src/config.ts:173-175` — validated agent `effort` allows only `low | medium | high`; no `xhigh`/`minimal` from config today.
- `bot/src/pi-context-assembler.ts:40-46` — `PiContextArtifacts` has optional `systemPromptPath` and always-present `appendSystemPromptPath` on success.
- `bot/src/pi-context-assembler.ts:466-507` — `assemblePiContext()` returns `PiContextArtifacts | null`; on non-null it writes bundle and optional persona artifact paths.
- `bot/src/pi-rpc-protocol.ts:103-126` — `resolvePiExtensionArgs()` returns repeatable `--extension <abs>` args and fails closed if wrappers are missing.
- `bot/src/pi-rpc-protocol.ts:223-229` — `normalizePiModel()` is not exported; do not import it.
- `bot/src/pi-rpc-protocol.ts:290-318` — `buildPiSpawnEnv()` clones env, deletes `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDECODE`, and stale guard root, then ensures `/opt/homebrew/bin` in PATH.
- `bot/src/pi-extensions/subagent-args.ts:77-109` — pure spawn-arg builder pattern and DI-testable shape for Pi child commands.

## Validation Commands

Run from the bot package directory in the public repo checkout.

```bash
cd ~/src/claude-code-bot/bot
npm test
npm run lint
npm run build

# Required Pi print-mode shape is present.
grep -nE 'PI_CRON_MODEL|openai-codex/gpt-5\.5|"-p"|"--no-session"|"--no-context-files"|"--thinking"' src/cron-runner.ts

# Required reuse points are imported/used.
grep -nE 'buildPiSpawnEnv|resolvePiExtensionArgs|PI_SUBAGENT_CHILD_WRAPPER_RELPATHS|assemblePiContext' src/cron-runner.ts

# Model is literal and not derived from config.
grep -n 'const PI_CRON_MODEL = "openai-codex/gpt-5.5"' src/cron-runner.ts
grep -n 'normalizePiModel' src/cron-runner.ts && exit 1 || true
grep -n 'agent.model' src/cron-runner.ts && exit 1 || true

# Forbidden Pi one-shot flags must not appear in runPi(). Review manually if grep finds matches from runClaude().
grep -nE 'runPi|--mode|--output-format|--fallback-model|--max-turns|--session ' src/cron-runner.ts

# Engine dispatch, kill-switch, and metrics are present.
grep -nE 'engine|CRON_PI_DISABLED|runOneShot|runPi' src/cron-runner.ts
grep -nE 'minime_cron_last_success_timestamp|minime_cron_last_exit_code|node_exporter/textfile' src/cron-runner.ts

# New tests exist and run directly with the same TS loader/Node flags as package tests.
ls src/__tests__/cron-runner-pi.test.ts
node --experimental-test-module-mocks --import tsx --test src/__tests__/cron-runner-pi.test.ts
```

## Decisions

| ID | Decision | Resolution |
|---|---|---|
| Q1 | Scope/deadline | Ship mechanism + safety nets + tests + documented safe-subset rollout. Do not flip production crons in this PR. Dangerous/browser crons stay on Claude until later soak. |
| Q2 | Browser/MCP crons | Browser/MCP crons stay on Claude. Vanilla Pi has no MCP/`--allowedTools` parity in this plan. |
| Q3 | Dispatch/rollback | Add per-cron `engine: claude | pi`; default absent value to `claude`. `CRON_PI_DISABLED=1` forces Claude for all LLM crons. |
| Q4 | Silent-failure safety net | Pi real errors must enter the existing `⚠️ Cron FAIL` path, never the empty-output skip. Emit cron-health textfile metrics. |
| Q5 | Model | Hardcode `const PI_CRON_MODEL = "openai-codex/gpt-5.5"`; do not derive from `agent.model`; do not import `normalizePiModel`. |
| D-CTX | Context parity | Reuse `assemblePiContext()` for persona + context bundle; when non-null, pass bundle + `--no-context-files`. |
| D-EXT | Extensions | Use only A1 guard wrapper via `resolvePiExtensionArgs({ relpaths: PI_SUBAGENT_CHILD_WRAPPER_RELPATHS })`; no A2/A3 in cron one-shot. |
| D-ENV | Auth/env | Reuse `buildPiSpawnEnv()`; set `env.HOME ||= homedir()` inside `runPi()`; Pi auth comes from `~/.pi/agent/auth.json`, not Claude OAuth token. |
| D-SPAWN | Process API | Use `spawnSync` with an argv array for the Pi path; no shell string and no `execFileSync`, because result classification needs status/signal/stdout/stderr. |

## Assumptions

- [UNVERIFIED] Pi print mode accepts `pi -p <prompt> --no-session --model openai-codex/gpt-5.5 --thinking <level>` and emits final assistant text to stdout in default text mode. Risk if wrong: `runPi()` exits non-zero and the loud FAIL path fires.
- [UNVERIFIED] Pi supports `--system-prompt <path>` / `--append-system-prompt <path>` as currently used by the RPC path (`bot/src/pi-rpc-protocol.ts:260-264`) and subagent path (`bot/src/pi-extensions/subagent-args.ts:97-99`). Risk if wrong: FAIL path fires or context is missing; tests must pin the argv path behavior we expect.
- [UNVERIFIED] Headless OAuth refresh from `~/.pi/agent/auth.json` works under launchd. Risk if wrong: visible cron FAIL + stale success metric; recovery is manual `pi /login`.
- Production cron flips are private workspace state and must happen after merge + restart + observation, not inside ralphex.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| Wrong Pi CLI flag | Medium | High | argv tests + real errors classified as FAIL, not empty skip |
| Empty stdout with stderr gets swallowed | Medium | High | `classifyPiResult()` treats empty stdout + stderr as error |
| Missing A1 extension silently spawns unguarded Pi | Low | High | `resolvePiExtensionArgs()` fail-closed; `CRON_PI_DISABLED=1` rollback |
| Claude credentials leak to Pi | Low | Medium | `buildPiSpawnEnv()` deletes Claude/Anthropic vars |
| Context parity drift | Medium | Medium | reuse `assemblePiContext()`; no reimplementation |
| Metrics file breaks cron run | Low | Medium | metric writer must be best-effort after preserving exit status semantics |
| Scope creep into workspace rollout | Medium | High | operator rollout section is explicitly NOT ralphex |

## Tasks

### Task 1: Add cron engine typing and parsing [HIGH]

- [x] In `bot/src/types.ts`, add `engine?: "claude" | "pi"` to `CronJob`.
- [x] In `bot/src/cron-runner.ts` `loadCronTask()`, validate raw `engine`: absent means `undefined`/default Claude; present must be exactly `"claude"` or `"pi"`.
- [x] Return the parsed `engine` field in the `CronJob` object.
- [x] Keep script crons unaffected; `engine` only matters for LLM crons.
- [x] Write unit tests for absent/default, `claude`, `pi`, and invalid engine rejection.
- [x] Run the relevant cron-runner tests separately after writing them.

### Task 2: Add minimal Pi cron agent construction [HIGH]

- [x] Keep `getAgentWorkspace(agentId)` or replace it with a small helper that reads `loadRawMergedConfig()` once and returns enough data for Pi context assembly: `id`, `workspaceCwd`, optional `systemPrompt`, optional `effort`.
- [x] Do not add a heavyweight full `validateAgent()`/`loadConfig()` path just to run a cron.
- [x] For `runPi()`, construct a minimal `AgentConfig` compatible with `assemblePiContext()`:
  - `id: cron.agentId`
  - `workspaceCwd`
  - `provider: "pi"`
  - `model: PI_CRON_MODEL`
  - `systemPrompt` copied from raw config only if string
  - `effort` copied only if it is one of `low | medium | high`
- [x] If the helper sees a missing agent or missing `workspaceCwd`, preserve the current error semantics: fail before spawn and enter the existing `⚠️ Cron FAIL` path.
- [x] Write tests for agent data resolution including default `main` agent and invalid/missing workspace.
- [x] Run the relevant tests separately.

### Task 3: Introduce `runOneShot()` engine dispatch and kill-switch [HIGH]

- [x] Add `function resolveCronEngine(cron: CronJob): "claude" | "pi"`:
  - `cron.engine ?? "claude"`
  - if resolved `pi` and `process.env.CRON_PI_DISABLED === "1"`, return `"claude"`
- [x] Add `function runOneShot(cron: CronJob, workspaceCwd: string): string` that dispatches to `runClaude()` or `runPi()`.
- [x] Change `main()` only at the LLM call site from `runClaude(cron, workspaceCwd!)` to `runOneShot(cron, workspaceCwd!)` and update the log label to include resolved engine/output length without changing behavior.
- [x] Do not change script cron dispatch.
- [x] Write tests for default Claude, explicit Claude, explicit Pi, and kill-switch fallback.
- [x] Run the relevant tests separately.

### Task 4: Add Pi result classification [HIGH]

- [x] Define a small result type for Pi spawn output, e.g. `{ status: "ok"; output: string } | { status: "error"; message: string }`.
- [x] Implement `classifyPiResult(exitCode, signal, stdout, stderr)`:
  - exit code `0` + non-empty stdout => ok with `stdout.trim()`
  - exit code `0` + empty stdout + empty stderr => ok with empty string (intentional empty-output skip remains possible)
  - exit code `0` + empty stdout + non-empty stderr => error
  - non-zero exit or signal => error including bounded stderr/stdout excerpts
- [x] Ensure errors are thrown from `runPi()` so `main()` uses the existing `⚠️ Cron FAIL` branch.
- [x] Ensure intentional `NO_REPLY` and intentional empty success still flow through the existing post-run suppression/skip logic.
- [x] Write table-driven tests for all classifier branches.
- [x] Run the relevant tests separately.

### Task 5: Implement `runPi()` print-mode spawn [HIGH]

- [x] Add imports in `bot/src/cron-runner.ts`:
  - `spawnSync` from `node:child_process` (required; do not use `execFileSync` for Pi because the classifier needs status/signal/stdout/stderr)
  - `buildPiSpawnEnv`, `resolvePiExtensionArgs`, `PI_SUBAGENT_CHILD_WRAPPER_RELPATHS` from `./pi-rpc-protocol.js`
  - `assemblePiContext` from `./pi-context-assembler.js`
- [x] Do **not** import `normalizePiModel`.
- [x] Define `const PI_CRON_MODEL = "openai-codex/gpt-5.5";` in `cron-runner.ts`.
- [x] Define `const PI_BIN = "pi";` and spawn with `spawnSync(PI_BIN, args, ...)`.
- [x] Define `const PI_THINKING_LEVELS = new Set(["low", "medium", "high"]);` for current config-allowed effort values; default to `"medium"`.
- [x] Build argv as text-mode print one-shot:
  - `-p`, `cron.prompt!`
  - `--no-session`
  - `--model`, `PI_CRON_MODEL`
  - `--thinking`, validated effort or `medium`
  - context flags, if `assemblePiContext(agent)` returns non-null:
    - if `ctx.systemPromptPath`, pass `--system-prompt`, `ctx.systemPromptPath`
    - always pass `--append-system-prompt`, `ctx.appendSystemPromptPath`
    - always pass `--no-context-files`
  - extensions: `...resolvePiExtensionArgs({ relpaths: PI_SUBAGENT_CHILD_WRAPPER_RELPATHS })`
- [x] Forbidden in `runPi()` argv: `--mode`, `--output-format`, `--fallback-model`, `--max-turns`, `--dangerously-skip-permissions`, `--add-dir`, `--session`.
- [x] Add an explicit DI seam for tests: `runPi(cron, workspaceCwd, deps = defaultPiDeps)` or equivalent, where `deps.spawnSync` defaults to Node `spawnSync` and tests inject a fake. Keep production call sites simple.
- [x] Spawn with `deps.spawnSync(PI_BIN, args, { cwd: workspaceCwd, timeout: cron.timeout ?? DEFAULT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env })`.
- [x] Build env via `buildPiSpawnEnv(agent)` and set `env.HOME ||= homedir()`; add an inline comment that Pi auth is `~/.pi/agent/auth.json`, not Claude OAuth.
- [x] Call `classifyPiResult()` and return the ok output or throw on error.
- [x] Write DI fake-spawn tests for argv shape, env scrubbing/HOME, cwd, timeout, context args, extension args, and forbidden flags.
- [x] Run the relevant tests separately.

### Task 6: Add cron-health textfile metrics [HIGH]

- [x] Add a small best-effort `writeCronHealthMetric(cronName, exitCode, success)` helper.
- [x] Textfile directory default: `/opt/homebrew/var/node_exporter/textfile`; make it overrideable in tests via env var, e.g. `CRON_HEALTH_TEXTFILE_DIR`.
- [x] Metric file name should be stable per cron, e.g. `minime_cron_<safe-name>.prom`; sanitize cron names for filenames and labels.
- [x] On success only, include/update `minime_cron_last_success_timestamp{cron="<name>"} <epoch>`.
- [x] On every run, include/update `minime_cron_last_exit_code{cron="<name>"} <code>`.
- [x] Do not read/parse old metric files and do not preserve old timestamp by read-modify-write.
- [x] Use atomic temp-file + rename.
- [x] Metric write failures must be logged but must not mask the original cron success/failure.
- [x] Wire the helper into `main()` so success writes exit code `0`, and every failure path writes a non-zero exit code before `process.exit(1)`.
- [x] Write tests using a temp directory.
- [x] Run the relevant tests separately.

### Task 7: Preserve `main()` behavior [HIGH]

- [x] Audit the diff around `main()` manually.
- [x] Confirm the only sanctioned behavior changes are engine dispatch and metric hook.
- [x] Confirm these remain unchanged:
  - script cron path
  - delivery command and admin fallback
  - empty-output skip
  - `NO_REPLY` suppression
  - `process.exit(1)` on failure
  - timeout default
- [x] Add/adjust tests to pin the behavior-preserving cases.
- [x] Run the relevant tests separately.

### Task 8: Document safe-subset rollout criteria [MED]

- [x] In bot docs (public repo only), document `engine: claude | pi`, default `claude`, and `CRON_PI_DISABLED=1`.
- [x] Document that browser/MCP crons and dangerous state-mutating crons should remain on Claude until Pi has the needed browser/MCP/soak coverage.
- [x] Document the recommended safe first subset as criteria, not private cron names: read-only, non-browser, non-secret, non-mutating, low blast-radius, visible output or metric-covered.
- [x] Do not edit private `crons.local.yaml`, monitoring rules, migration-state, or ADR files in this task.

### Task 9: Verify acceptance criteria [HIGH]

- [x] From `bot/`, run `npm test`.
- [x] From `bot/`, run `npm run lint`.
- [x] From `bot/`, run `npm run build`.
- [x] From `bot/`, run `node --experimental-test-module-mocks --import tsx --test src/__tests__/cron-runner-pi.test.ts`.
- [x] Verify `cron-runner.ts` contains literal `const PI_CRON_MODEL = "openai-codex/gpt-5.5"`.
- [x] Verify `cron-runner.ts` does not import or call `normalizePiModel`.
- [x] Verify `runPi()` does not contain forbidden flags (`--mode`, `--output-format`, `--fallback-model`, `--max-turns`, `--dangerously-skip-permissions`, `--add-dir`, `--session`).
- [x] Verify tests cover engine dispatch, kill-switch, Pi argv, env/HOME, context args, extension args, FAIL-vs-empty-success classification, and cron-health metrics.
- [x] Record command output in the ralphex final report.

### Task 10: Update documentation [HIGH]

- [x] Update public bot docs only. Prefer an existing cron/config doc over adding a new doc unless the repo already has a clear plans/docs convention.
- [x] Include a minimal YAML example:
  ```yaml
  crons:
    - name: read-only-example
      type: llm
      engine: pi
      agentId: main
      prompt: "..."
  ```
- [x] Document rollback:
  - per cron: remove `engine: pi` or set `engine: claude`
  - global: set `CRON_PI_DISABLED=1`
- [x] Document operational warning: production flips are post-merge operator work, not part of the PR.

## Operator steps (post-merge — NOT ralphex)

These steps are private workspace operations after the public PR is merged, upstream-synced, and the bot is restarted with explicit confirmation.

- [ ] Ask Ninja whether to record the cron Pi mechanism/rollout policy as an ADR.
- [ ] Sync public repo into the private workspace via upstream merge.
- [ ] Restart the bot with the canonical restart script only after explicit confirmation.
- [ ] Select a tiny SAFE/read-only subset of production LLM crons and set `engine: pi` in private cron overrides.
- [ ] Do not migrate browser/MCP crons or dangerous state-mutating crons in the first flip.
- [ ] Add/enable Prometheus alert for stale `minime_cron_last_success_timestamp` after the metric exists.
- [ ] Watch logs + metrics for at least one full firing cycle before expanding the subset.
- [ ] If any Pi cron fails, set `CRON_PI_DISABLED=1` or flip that cron back to `engine: claude` and investigate from logs.
