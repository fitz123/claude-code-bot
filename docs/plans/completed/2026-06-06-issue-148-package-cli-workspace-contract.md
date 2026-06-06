# Plan: Issue #148 — Package CLI + workspace contract groundwork

GitHub issue: #148
Target repo: `fitz123/claude-code-bot`

## Goal

Prepare the current bot runtime for a future clean `minime-bot` package repo without moving repositories yet.

This run is the first implementation slice only:

- add a central workspace/path resolver;
- add a package CLI entrypoint usable from `node_modules/.bin/minime-bot` after build/install;
- add package artifact scripts (`build`, `prepare`, `prepack`) without committing `dist/`;
- add a workspace contract validator skeleton with useful effective-path diagnostics;
- update tests for package-installed/path-independent behavior.

## Non-goals

- Do not create or rename any GitHub repository.
- Do not migrate any production workspace.
- Do not remove the existing `bot/` directory layout.
- Do not change launchd labels.
- Do not edit private workspace files.
- Do not implement the final write-guard v2 cutover in private hooks; only add package-side resolver/validator groundwork needed for later runs.
- Do not print or decrypt secret values.

## Context

The future architecture is a bot-only package consumed by a separate private workspace through `package.json` / `package-lock.json`.

The public package must eventually expose commands like:

```bash
minime-bot workspace validate --workspace /path/to/workspace
minime-bot config validate --workspace /path/to/workspace
minime-bot start --workspace /path/to/workspace
minime-bot cron run --task <name> --workspace /path/to/workspace
```

This first slice should make those boundaries real enough for tests and later phases, but it should preserve current runtime behavior.

## Architectural invariants

The important outcome is correct separation of concepts while preserving both development workflows:

1. **Bot runtime package** — transport/session/config/cron/launchd/application logic. It must be developable from the source checkout and runnable from a package install.
2. **Harness extensions** — Pi extension wrappers plus pure helper modules. They may live in the same repo/package, but their boundary must stay explicit: thin wrappers call tested helpers, package artifacts include valid wrapper/helper imports, and extension loading must not depend on private workspace cwd or source-only paths.
3. **Workspace contract** — config/crons/schema/secrets/agent cwd resolution. The contract is consumed by the bot and extensions through resolver/config, not by ad-hoc `process.cwd()` assumptions.

Compatibility matrix required for this slice:

| Mode | Must keep working |
|---|---|
| Current source checkout (`bot/`, `npx tsx`, existing scripts) | normal development and current production behavior |
| Built checkout (`dist/cli.js`) | CLI help/config validate/workspace validate |
| Packed + installed package (`node_modules/.bin/minime-bot`) | CLI help/config validate/workspace validate + Pi extension wrapper resolution/loading |

Do not trade one mode for another. If a change makes package mode work but breaks source development, or keeps source mode while leaving extension artifacts broken, the implementation is incomplete.

Current important paths/code areas to inspect:

- `bot/package.json`
- `bot/tsconfig.json`
- `bot/src/config.ts`
- `bot/src/cron-runner.ts`
- `bot/src/pi-rpc-protocol.ts`
- `bot/src/pi-extensions/*`
- `bot/scripts/start-bot.sh`
- `bot/scripts/run-cron.sh`
- `bot/scripts/generate-plists.ts`
- existing tests under `bot/src/__tests__/`

## Required design decisions for this slice

### Workspace resolution

Add a central resolver module, for example `bot/src/workspace-contract.ts` or `bot/src/workspace-root.ts`.

It should resolve and expose at least:

- package/bot root directory;
- workspace root;
- config path;
- crons path;
- schema path;
- Pi extension directory;
- data/log/runtime dirs where already known.

Resolution order:

1. CLI `--workspace <path>` when available.
2. `MINIME_WORKSPACE_ROOT` when set.
3. Existing behavior-compatible fallback for the current repo layout.

Do not silently guess a parent workspace in package-installed mode unless the fallback is explicitly documented and tested.

### Config/crons/schema overrides

Support these env overrides in the resolver layer:

- `MINIME_WORKSPACE_ROOT`
- `MINIME_CONFIG_PATH`
- `MINIME_CRONS_PATH`
- `MINIME_SCHEMA_PATH`

Use absolute normalized paths in diagnostics. The resolved schema path is not validator-only: it must be propagated to live Pi extension processes and consumed by the guard wrapper/helper. Updating `buildPiSpawnEnv` allowlists or adding an explicit extension contract is part of this slice. A `MINIME_SCHEMA_PATH` override must affect both validator results and live guard verdicts in source, built, and package-installed modes.

### Package artifact strategy

For now:

- `dist/` is generated, not committed.
- package `bin` points to built CLI output and the built CLI has a working shebang for `node_modules/.bin/minime-bot`.
- `prepare` and `prepack` build `dist/` so GitHub dependency install and `npm pack` produce runnable artifacts.
- first-party Pi wrappers for package-installed runtime live in a built package artifact path (for example `dist/extensions/pi/`), not only in the current source-only `bot/.claude/extensions/` path.
- build must either compile/copy wrapper JS with imports rewritten to compiled helper JS under `dist/`, or otherwise prove the packed artifact contains every helper import the wrappers need. Do not rely on wrappers importing absent `src/pi-extensions/*.js` files.
- resolver/`resolvePiExtensionArgs` must choose the package artifact extension directory in built/package-installed mode while preserving the current source wrapper directory for dev/current-layout mode.
- package artifact must include non-code resources required by directory extensions, especially subagent bundled `agents/*.md` and `prompts/*.md` resources.
- tests must verify package metadata and installed-bin behavior enough to prevent a broken `node_modules/.bin/minime-bot` path.

### Secrets safety

Validator and CLI config validation are structural/no-decrypt by default.

- `minime-bot config validate` and `minime-bot workspace validate` must call config loading with `resolveSecrets: false` or equivalent unless an explicit future flag requests secret resolution.
- Do not invoke `sops -d` from validators in this slice.
- If SOPS pointers are checked, use structural checks or no-output checks only, and add a test/fake resolver that fails if secret resolution is attempted.

## Tasks

### Task 1: Add workspace/path resolver

- [x] Add a central resolver module.
- [x] Cover current repo layout with tests so existing `npm test` behavior is preserved.
- [x] Cover explicit `MINIME_WORKSPACE_ROOT`, `MINIME_CONFIG_PATH`, `MINIME_CRONS_PATH`, and `MINIME_SCHEMA_PATH` overrides.
- [x] Return structured diagnostics/effective paths without reading secrets.

### Task 2: Wire resolver into config and cron loading

- [x] Update `config.ts` to use the resolver for config path defaults and config validation.
- [x] Update SOPS file path resolution so relative paths are resolved against the documented workspace/config base, not accidental process cwd.
- [x] Update `cron-runner.ts` to use the resolver for crons path defaults.
- [x] Preserve current default behavior when no new env vars are set.

### Task 3: Add package CLI entrypoint

- [x] Add `src/cli.ts` or equivalent.
- [x] Add `bin` mapping in `bot/package.json` for `minime-bot`.
- [x] Ensure the built CLI has a shebang and works through an installed package bin shim.
- [x] Implement at minimum:
  - `minime-bot --help`
  - `minime-bot config validate --workspace <path>` (structural/no-decrypt by default)
  - `minime-bot workspace validate --workspace <path>` (structural/no-decrypt by default)
- [x] Keep existing script entrypoints working.
- [x] Add tests for help/argument parsing and installed-bin execution where practical.

### Task 4: Add workspace contract validator skeleton

- [x] Implement validator command used by `minime-bot workspace validate`.
- [x] It must print effective resolved paths:
  - workspace root;
  - config path;
  - crons path;
  - schema path;
  - Pi extension dir.
- [x] It must verify:
  - workspace root exists;
  - config exists and parses with secret resolution disabled;
  - crons file parses when present;
  - schema path defaults to `$WORKSPACE_ROOT/schema.md` unless `MINIME_SCHEMA_PATH` overrides it;
  - schema validation reuses/shares the same write-allowlist parser and match semantics as the live guard;
  - live Pi guard consumes the same resolved schema path as the validator, including `MINIME_SCHEMA_PATH` override propagation into Pi extension processes;
  - missing, empty, malformed, or unparseable schema is a hard failure when guard enforcement is enabled (no optional/schema-warning mode in this slice);
  - configured agent workspace dirs exist;
  - Pi extension dir exists;
  - SOPS pointers are structurally valid without printing or decrypting secret values.
- [x] It should distinguish hard failures from warnings.
- [x] Add validator-vs-guard parser parity tests for valid, missing, empty, malformed, and override schema cases.

### Task 5: Package build/artifact checks

- [x] Update `package.json` scripts for build/prepare/prepack as needed.
- [x] Ensure `npm run build` succeeds from `bot/`.
- [x] Build/package first-party Pi wrappers into the chosen artifact extension directory and make wrapper helper imports valid in the packed artifact.
- [x] Copy/package directory-extension non-code resources required at runtime, especially subagent bundled `agents/*.md` and `prompts/*.md` resources.
- [x] Keep extension architecture separated: wrappers stay thin, helper logic remains in tested modules, and both source-development and package-installed extension loading paths are explicitly tested.
- [x] Add/adjust `files`/ignore policy so package artifacts include runtime JS, built Pi wrappers, required helper JS, and required extension resources, not private/workspace templates.
- [x] Add an npm-pack/install fixture test that:
  - packs the bot package;
  - installs it into a clean temp project;
  - runs `node_modules/.bin/minime-bot --help`;
  - runs `node_modules/.bin/minime-bot config validate --workspace <fixture>` without invoking SOPS/secret resolution;
  - runs `node_modules/.bin/minime-bot workspace validate --workspace <fixture>`;
  - calls `resolvePiExtensionArgs` (or equivalent public/test seam) against the installed artifact and imports/loads each configured first-party wrapper;
  - verifies `MINIME_SCHEMA_PATH` override changes the installed-package guard verdict exactly like the validator;
  - verifies subagent bundled agent discovery and `resources_discover` prompt paths exist from the installed artifact, not from the source checkout.
- [x] Add a test or documented validation that `npm pack --dry-run` includes expected runtime files.

### Task 6: Tests and docs

- [x] Update tests that assume old path behavior only if this slice changes their assumptions.
- [x] Add fixture tests for explicit workspace root and package-installed-like layout.
- [x] Update README or package docs minimally for new CLI/validator commands.
- [x] Do not rewrite broad public setup docs in this slice beyond what is needed for the new commands.

## Validation commands

Run from `bot/` unless stated otherwise:

```bash
npm test
npm run build
npm run workspace:validate -- --workspace ./test-fixtures/minimal-workspace
npm pack --dry-run
node dist/cli.js --help
node dist/cli.js config validate --workspace ./test-fixtures/minimal-workspace
node dist/cli.js workspace validate --workspace ./test-fixtures/minimal-workspace
# package-installed fixture must also run:
# node_modules/.bin/minime-bot --help
# node_modules/.bin/minime-bot config validate --workspace <fixture>
# node_modules/.bin/minime-bot workspace validate --workspace <fixture>
```

If the implementation uses a different fixture path, update the commands in the final result and tests accordingly.

## Acceptance criteria

- Existing tests pass.
- Build passes.
- CLI help works from built `dist/` and from a package-installed `node_modules/.bin/minime-bot`.
- Workspace validator prints effective paths and validates a minimal fixture workspace.
- Config/workspace validation is no-decrypt by default; tests fail if validators invoke SOPS/secret resolution.
- Validator and guard schema parser semantics have parity tests.
- Package-installed Pi extension wrappers resolve and load from the packed artifact.
- Package-installed guard uses the same resolved schema path as validator, including `MINIME_SCHEMA_PATH` overrides.
- Package-installed subagent extension includes and discovers required non-code resources (`agents/*.md`, `prompts/*.md`).
- No secret values are printed by tests or validator.
- Current source-development and runtime behavior remain backward-compatible when no new env vars are set.
- Bot runtime package and harness extension boundaries stay explicit and compatible across source, built, and installed modes.
- No production workspace migration or launchd reload is performed.
