# Plan: Issue #148 continuation — control/agent workspace split, global Tavily, retire schema guard

Public repo location:
`docs/plans/2026-06-06-issue-148-control-agent-contract-cleanup.md`

GitHub issue: #148 / PR #151 follow-up continuation
Target repo after move: `fitz123/claude-code-bot` / future `fitz123/minime-bot`

## Goal

Finish the #148 package/workspace-contract direction with the corrected final architecture:

- `--workspace` points to the **control/app workspace**: config, crons, global secrets, bindings, deploy/runtime state.
- Individual sessions run in **agent workspaces** selected by `agents.*.workspaceCwd`.
- Absolute `agents.*.workspaceCwd` values may be outside the control workspace; the final target topology is sibling roots such as `<control-workspace>` and `<agent-workspace-main>`.
- Relative `agents.*.workspaceCwd` values remain backwards-compatible and resolve relative to the control workspace.
- Telegram, Discord, and Tavily secrets are **global control-workspace secrets**, not per-agent secrets.
- `schema.md`, `MINIME_SCHEMA_PATH`, Pi `guardian-protect-files`, write-allowlist parsing, and schema validation are **retired from the bot package contract** instead of becoming per-agent infrastructure.
- Bot runtime and Pi/harness extensions remain compatible across source checkout, built `dist`, and package-installed modes.

## Prerequisites and preflight gates

Do not move or launch this plan until all are true:

1. PR #151 is no longer moving unexpectedly: Ralphex completed, branch status is clean, and the PR has been reviewed/settled enough that the continuation can be based on its final diff.
2. Reconcile this draft against the final PR #151 file names and symbols. Use the actual merged/current branch diff, not the earlier draft assumptions.
3. Public repo preflight from `<public-repo-checkout>`:
   ```bash
   git status --short
   git rev-parse --short HEAD
   rg -n 'file:/tmp|/tmp/.*\.tgz|/tmp/.*minime|/tmp/.*claude-code-bot' bot/package.json bot/package-lock.json || true
   ```
   Required result: clean tree; no machine-local package dependency paths. `/tmp` in test scripts is okay, but no package dependency may point to `/tmp`.
4. Governance is aligned: ADR-081 is recorded and supersedes ADR-073 plus ADR-080 schema/write-guard clauses.

Task 0 reconciliation against final PR #151 branch:

- Base branch verified: `issue-148-package-cli-workspace-contract` / `origin/issue-148-package-cli-workspace-contract` at `5894383`.
- Continuation branch merged the final PR #151 tip at `d1a9582`; package branch later cherry-picked the same post-merge fix, so the continuation branch differs only by this plan before Task 0 edits.
- Preflight result at `d1a9582`: clean tree, no machine-local `/tmp` package dependency paths in `bot/package.json` or `bot/package-lock.json`.
- Final #151 fixture names still use `bot/test-fixtures/minimal-workspace`; this continuation may add/rename control-workspace-specific fixtures in later implementation tasks.
- Final #151 active symbols still include `MINIME_SCHEMA_PATH_ENV`, `PI_GUARD_WORKSPACE_ROOT_ENV`, `PI_SUBAGENT_CHILD_WRAPPER_RELPATHS`, `PI_CRON_WRAPPER_RELPATHS`, `guardian-protect-files`, and `realPathIsInsideOrEqual`; Tasks 1-7 own removal or replacement of those code/test references.
- Public Claude-path guard artifacts remain physically present at launch. Ownership decision: Task 2 removes or rewrites active public hook/settings/guidance for the package-contract retirement, and Task 8 records private-production cleanup before deployment; until then current guidance must mark these artifacts legacy/deferred rather than package-runtime contract.

## Governance impact

ADR-081 is the active decision for this continuation:

- schema/write-guard is retired from the final bot package contract;
- `--workspace` is the control/app workspace;
- `agents.*.workspaceCwd` may be outside the control workspace when absolute;
- Telegram, Discord, and Tavily are global control-workspace secrets;
- private production deploy of guard retirement requires explicit operator sign-off and cleanup of obsolete schema/guard hooks/imports.

Implementation must update any current operator guidance that still contradicts ADR-081, including public `CLAUDE.md` lines saying agent workspaces must stay inside the workspace root.

## Non-goals

- Do not edit private production workspace files in this public-repo run.
- Do not create the new `fitz123/minime-bot` repo in this run.
- Do not migrate launchd production services in this run.
- Do not remove unrelated CLI/package groundwork from #151/#148.
- Do not redesign broad tool permissions or sandboxing beyond removing schema/write-guard from the package contract.
- Do not print, decrypt, or log secret values.

## Architecture decisions

### Control workspace vs agent workspace

Use exact terminology in code/docs:

| Term | Meaning | Examples |
|---|---|---|
| control workspace | app/control root passed to `minime-bot --workspace`; owns config/crons/secrets/bindings/runtime state | `<control-workspace>` eventually; current compatibility may still be `<current-control-workspace>` |
| agent workspace | per-agent cwd/context root from `agents.*.workspaceCwd`; owns CLAUDE/MEMORY/rules/context/project files; absolute values may be outside the control workspace | `<agent-workspace-main>`, `.../coder`, `.../yulia` |
| package root | installed/source bot package root; owns runtime code and first-party Pi extensions | `node_modules/minime-bot`, source checkout `bot/` |

One bot daemon can serve many agent workspaces. Binding flow remains:

```text
incoming Telegram/Discord event
→ binding selects agentId
→ config resolves agents[agentId].workspaceCwd
→ Pi child cwd = resolved agent.workspaceCwd
→ context/rules/memory are read from the agent workspace
→ app config/secrets/runtime state stay in the control workspace
```

Path rules:

- `--workspace` / `MINIME_WORKSPACE_ROOT` resolves the control workspace.
- `MINIME_CONFIG_PATH` / `MINIME_CRONS_PATH` remain control-workspace config overrides.
- Relative `agents.*.workspaceCwd` values resolve against the control workspace.
- Absolute `agents.*.workspaceCwd` values are allowed outside the control workspace after existence/directory validation.
- Remove the current containment hard-fail that requires agent workspace realpaths to be inside the control workspace; that check existed only for Pi guard anchoring and becomes invalid once the guard is retired.

### Pi child non-secret control contract

Pi children run with `cwd = resolved agent workspace`, but package-installed extensions may need control config/secrets. The bot must pass a non-secret control contract to Pi children:

- include `MINIME_WORKSPACE_ROOT=<control workspace root>` in the allowlisted Pi child env;
- include `MINIME_CONFIG_PATH` / `MINIME_CRONS_PATH` only when explicitly configured, preserving their existing semantics;
- apply the same non-secret control contract to parent Pi RPC children, Pi cron children, and Pi **subagent child** spawns (the subagent child has caller-controlled `cwd` and also loads web tools);
- remove `MINIME_SCHEMA_PATH` and `PI_GUARD_WORKSPACE_ROOT` from child env after guard retirement;
- never pass plaintext Telegram/Discord/Tavily secret values in env, argv, stdout, stderr, or logs.

### Secrets

Global/control-workspace secrets:

- Telegram bot token;
- Discord bot token;
- Tavily API key.

Tavily must not resolve from `process.cwd()` / agent workspace. The web-tools extension must use the Pi child control contract above. Preserve the current Tavily secret shape by default: dedicated `config/secrets.sops.yaml` under the control workspace plus key `tavily.api_key`; change only the resolution root from agent `process.cwd()` to `MINIME_WORKSPACE_ROOT`. If the implementation intentionally unifies Tavily onto config `secrets.sopsFile`, that is a separate migration and must add a no-decrypt key-presence gate proving the configured production SOPS file contains `tavily.api_key` before cutover.

### Schema/guard retirement

Do not create a replacement per-agent schema system.

Remove from active package contract:

- `MINIME_SCHEMA_PATH`;
- `PI_GUARD_WORKSPACE_ROOT` if it is only used by the retired guard;
- workspace validator schema checks;
- Pi `guardian-protect-files` default extension loading;
- Pi cron hard-requirement that refuses to run without guard extension;
- subagent child wrapper lists that load only `guardian-protect-files`;
- write-allowlist parser requirements/parity tests;
- public-repo Claude-path guard hooks/settings/guidance if still active (`guardian.sh`, `protect-files.sh`, `.claude/settings.json` PreToolUse wiring, `bot-code-readonly.md`, CLAUDE/README/operator prose that claims schema/write-guard/immutable-core enforcement);
- docs implying `schema.md` is required for package/runtime correctness.

Public package guard retirement can land before private production cutover, but it must not be deployed to production as a silent safety downgrade. Private production deploy must be paired with explicit operator sign-off and a private cleanup plan for obsolete schema/guard hooks/imports.

Safety baseline after retirement:

- git history/PR review/Ralphex/Copilot;
- explicit approval for destructive operations;
- task artifacts are preserved;
- secrets are never printed/decrypted to stdout;
- package-installed tests catch runtime compatibility issues.

## Tasks

### Task 0: Reconcile with final PR #151 and governance

- [x] Confirm PR #151 branch is clean and final enough to base this continuation on.
- [x] Re-run the preflight checks from this plan.
- [x] Update this plan's file/symbol names against the final PR #151 diff.
- [x] Verify ADR-081 is present and active in `reference/governance/decisions.md` before moving the plan into the public repo.
- [x] Update public `CLAUDE.md` / current operator guidance that still says agent workspaces must stay inside the control workspace.
- [x] Decide public-repo Claude-path guard ownership before launch: remove/update active public hook wiring/guidance in this run, or explicitly mark it legacy/deferred and include it in the private cleanup artifact.

### Task 1: Encode control-vs-agent workspace semantics

- [ ] Add/update central types or resolver docs to distinguish `controlWorkspaceRoot`, `agentWorkspaceRoot` / `workspaceCwd`, and `packageRoot`.
- [ ] Ensure CLI help and validator output use these names consistently.
- [ ] Ensure `--workspace` is documented as control/app workspace, not agent workspace.
- [ ] Preserve backwards compatibility for relative agent workspace paths by resolving them against the control workspace.
- [ ] Remove/relax the `realPathIsInsideOrEqual(controlWorkspaceRoot, agentWorkspace)` hard-fail from Pi spawn validation and workspace validation.
- [ ] Keep hard failures for missing/non-directory configured agent workspaces.
- [ ] Add tests with two agents pointing at different `workspaceCwd` values proving session spawn cwd/context remains per-agent while config/secrets are read from control workspace.
- [ ] Add a regression fixture where the control workspace and two agent workspaces are sibling directories; `workspace validate` and Pi spawn env/cwd tests must pass.

### Task 2: Remove schema/write-guard from package contract

- [ ] Remove `MINIME_SCHEMA_PATH` from resolver constants, CLI docs, validator output, env allowlists, tests, README, and active docs introduced by #151/#148.
- [ ] Remove `schemaPath` from active workspace contract paths unless a final code path still needs it for explicitly legacy-only diagnostics.
- [ ] Remove schema validation from `workspace validate`.
- [ ] Remove validator-vs-guard parser parity requirements/tests from active test suites.
- [ ] Remove/default-disable the Pi `guardian-protect-files` extension from default first-party extension loading.
- [ ] Remove or rewrite Pi cron guard hard-requirements that currently throw when guard extension args are empty/disabled.
- [ ] Remove or rewrite subagent child wrapper constants/lists that currently load only `guardian-protect-files`.
- [ ] Remove `PI_GUARD_WORKSPACE_ROOT` and protected-prefix guard comments/tests unless retained only in explicitly legacy code.
- [ ] Remove/update public-repo Claude-path guard artifacts if still current: `.claude/hooks/guardian.sh`, `.claude/hooks/protect-files.sh`, `.claude/settings.json` PreToolUse wiring, and operator prose in `CLAUDE.md`, README, and `.claude/rules/**` that says schema/write-guard/immutable-core is enforced.
- [ ] If any Claude-path guard artifact is intentionally deferred to private cleanup, document that explicitly and ensure the deterministic removal gate treats it as legacy/deferred rather than current guidance.
- [ ] Ensure package-installed Pi extension tests no longer expect guard extension loading.
- [ ] Leave historical docs/plans alone unless they are current operator guidance.

### Task 3: Pass non-secret control contract to Pi children

- [ ] Add `MINIME_WORKSPACE_ROOT` to the Pi child env allowlist and set it to the resolved control workspace root for every Pi RPC, Pi cron, and Pi subagent child spawn.
- [ ] Preserve configured `MINIME_CONFIG_PATH` / `MINIME_CRONS_PATH` propagation only as non-secret path references.
- [ ] Remove `MINIME_SCHEMA_PATH` and `PI_GUARD_WORKSPACE_ROOT` propagation.
- [ ] Add tests proving parent/cron/subagent child env contains control `MINIME_WORKSPACE_ROOT` while child `cwd` is the agent workspace or caller-selected subagent cwd.
- [ ] Add tests proving absolute sibling agent workspace paths do not alter control config/secrets paths.
- [ ] Add negative tests proving no plaintext Telegram/Discord/Tavily secret is present in child env or argv.

### Task 4: Make Tavily a global control-workspace secret

- [ ] Replace Tavily `process.cwd()` / agent-workspace SOPS resolution with control-workspace contract resolution through the named child env contract in Task 3.
- [ ] Preserve the current Tavily secret contract by default: `config/secrets.sops.yaml` under the control workspace plus key `tavily.api_key`. Do not silently reroute Tavily onto config `secrets.sopsFile` unless the plan also adds an explicit no-decrypt production key-presence gate for that configured file.
- [ ] Do not pass Tavily plaintext in env/argv.
- [ ] Add tests proving an agent workspace without `config/secrets.sops.yaml` can still use Tavily via the control workspace SOPS pointer.
- [ ] Add tests proving two different agent workspaces use the same control-workspace Tavily secret reference.
- [ ] Add installed-wrapper tests with `process.cwd()` set to an agent workspace lacking config/secrets; fake SOPS must be invoked with the control-workspace Tavily relpath/key.
- [ ] Add subagent-child tests proving `buildPiSubagentChildSpawnEnv` (or final equivalent) propagates control `MINIME_WORKSPACE_ROOT` while child `cwd` is caller-controlled.
- [ ] Add tests proving a subagent child's loaded `web-tools` wrapper resolves Tavily from the control workspace even when `cwd` is an arbitrary caller directory without config/secrets files.
- [ ] Add negative tests with fake secret resolver/exec proving validators do not invoke SOPS and web-tools secret resolution never prints values.

### Task 5: Keep extension/runtime package compatibility after guard removal

- [ ] Ensure source checkout, built `dist`, and package-installed modes still load the remaining first-party Pi extensions.
- [ ] Ensure subagent extension non-code resources (`agents/*.md`, `prompts/*.md`) are still packaged and discovered.
- [ ] Ensure extension helpers do not depend on private workspace cwd or source-only paths.
- [ ] Update package `files`/build scripts if removing guard changes artifact lists.
- [ ] Add/keep install-fixture tests for `node_modules/.bin/minime-bot --help`, validator, web-tools wrapper loading, and subagent resource discovery.
- [ ] Add an exact extension-list assertion for the post-retirement contract: no `guardian-protect-files` in parent, cron, or subagent child extension args; expected web/subagent wrappers still present where intended.
- [ ] Add an exact subagent-child env assertion: web-enabled delegated children get the control `MINIME_WORKSPACE_ROOT` even when their `cwd` is caller-controlled.

### Task 6: Update validator contract

- [ ] Validator hard-fails on invalid control workspace config/crons and missing/non-directory configured agent `workspaceCwd` directories.
- [ ] Validator no longer requires `schema.md` in control or agent workspaces.
- [ ] Validator accepts absolute agent workspace paths outside the control workspace.
- [ ] Validator prints effective paths for:
  - control workspace root;
  - config path;
  - crons path;
  - package root;
  - extension dir;
  - runtime data/log dirs;
  - every configured agent workspace.
- [ ] Validator treats missing agent context files (`CLAUDE.md`, `MEMORY.md`, rules dirs) as warnings unless current runtime requires them as hard failures.
- [ ] Validator remains no-decrypt by default.

### Task 7: Update docs, tests, and deterministic removal gate

- [ ] Update README/package docs to describe control workspace vs agent workspaces.
- [ ] Update current docs that say `schema.md`/write-allowlist is required for runtime/package validity.
- [ ] Update tests that assert `MINIME_SCHEMA_PATH` or schema validation exists.
- [ ] Add regression tests for the one-bot-many-workspaces binding model.
- [ ] Add regression tests that package-installed mode works without any `schema.md` files in fixtures.
- [ ] Replace any non-blocking `rg ... || true` removal check with a deterministic failing check that allows only explicitly listed historical/legacy paths.
- [ ] Scope the removal check to active symbols/prose (`MINIME_SCHEMA_PATH`, `MINIME_SCHEMA_PATH_ENV`, `PI_GUARD_WORKSPACE_ROOT`, `guardian-protect-files`, `guardian.sh`, `protect-files.sh`, `readWriteAllowlistSchema`, active `write-allowlist` parser usage, `immutable core`, and current prose claiming schema/write-guard enforcement), not a broad unqualified `schema.md` substring.

### Task 8: Private-production follow-up artifact only

Public code must not edit private production files in this run, but the run must leave an operator artifact for private deployment:

- [ ] Create/update a task note listing private cleanup required before deploying the guard-retired package:
  - remove obsolete schema/guard hooks or extension references from private settings;
  - remove or explicitly retire private `guardian.sh` / `protect-files.sh` hook wiring and prose if still present;
  - remove obsolete `@schema.md` imports if any agent workspaces have them;
  - decide whether to archive or delete inert `schema.md` files;
  - confirm deploy wrapper/operator sign-off before production restart.
- [ ] The artifact must not contain secrets or decrypted SOPS values.

## Validation commands

Run from `bot/` or the post-#151 equivalent package root:

```bash
npm test
npm run typecheck
npm run build
npm run workspace:validate -- --workspace ./test-fixtures/minimal-workspace
node dist/cli.js --help
node dist/cli.js config validate --workspace ./test-fixtures/minimal-workspace
node dist/cli.js workspace validate --workspace ./test-fixtures/minimal-workspace
npm pack --dry-run
```

Package-installed fixture must also run:

```bash
node_modules/.bin/minime-bot --help
node_modules/.bin/minime-bot config validate --workspace <minimal-workspace-fixture>
node_modules/.bin/minime-bot workspace validate --workspace <minimal-workspace-fixture>
```

After Task 7 adds it, the deterministic removal gate must run and fail on active references outside an explicit legacy allowlist. Draft shape:

```bash
node scripts/check-no-active-schema-guard-contract.mjs
```

The script should scan active code/docs/tests and fail non-zero for unallowlisted references to removed active symbols/prose, including stale Claude-path guard guidance. Historical completed plans may be allowlisted; current README/CLAUDE/operator guidance must not be.

## Acceptance criteria

- ADR-081 is active and public/operator guidance no longer contradicts it.
- `MINIME_SCHEMA_PATH` is gone from active package contract.
- `workspace validate` passes without `schema.md` in control or agent workspace fixtures.
- `workspace validate` accepts absolute sibling agent workspace paths outside the control workspace.
- Pi guard extension is not loaded by default, by cron Pi runs, or by subagent child Pi runs.
- Pi child env includes non-secret `MINIME_WORKSPACE_ROOT` control root while child cwd remains `agents.*.workspaceCwd`.
- Telegram/Discord/Tavily secrets are resolved as global control-workspace secret references.
- Tavily installed-wrapper tests prove control Tavily relpath/key resolution from an agent cwd lacking secrets files.
- Subagent child env/tests prove `MINIME_WORKSPACE_ROOT` is propagated to caller-controlled child cwd and web-tools still resolves Tavily from the control workspace.
- Current public/operator guidance no longer advertises Claude-path schema/write-guard/immutable-core enforcement unless explicitly marked legacy/deferred.
- Source checkout, built `dist`, and package-installed modes all pass compatibility tests.
- Deterministic removal gate has no unallowlisted active schema/guard references.
- No secret values are printed in tests, validator output, logs, or review artifacts.
- Current #151/#148 package CLI/workspace-contract functionality remains intact except for deliberate schema/guard removal and the deliberate containment-relaxation for agent workspaces.
