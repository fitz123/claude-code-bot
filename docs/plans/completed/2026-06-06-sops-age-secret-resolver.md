# Plan: SOPS/age Secret Resolver for Runtime Tokens

Issue: https://github.com/fitz123/claude-code-bot/issues/143

## Goal

Add SOPS/age-backed secret resolution for bot runtime tokens without exposing plaintext secrets, and remove macOS Keychain from active runtime secret resolution. This is a direct cutover plan: no Keychain compatibility fallback is implemented for migrated runtime secrets.

## Context and Evidence

Current code paths:

- `bot/src/config.ts` has `resolveSecret({ service, envVar, fieldName })` for Telegram/Discord tokens. It supports env vars and macOS Keychain only.
- `bot/.claude/extensions/web-tools.ts` reads Tavily API key once at extension load from macOS Keychain service `tavily-api-key`, account `minime`.
- `bot/src/pi-extensions/tavily.ts` hardcodes missing-key text that only names Keychain.
- Pi sessions are spawned with `cwd: agent.workspaceCwd`, so extension-side relative SOPS file lookup can anchor on `process.cwd()`.

Operational problem:

- In Pi/launchd runtime context, Keychain reads can fail with `security` rc=36 (`errSecInteractionNotAllowed`). Tool registration still works, but web tools cannot fetch their key.

Cutover decision:

- Do not build Keychain fallback for migrated runtime secrets. The deployment switches to SOPS once implementation and smoke tests pass; rollback is a git/config revert, not a runtime fallback path.
- Existing env-var support may remain as a non-Keychain deployment override for Linux/NixOS/systemd, but SOPS is the canonical private-workspace backend.

Security constraints:

- Never print or log decrypted secret values.
- Tests must not require real SOPS files, real Keychain entries, or private absolute paths.
- Public repo must contain resolver code and examples only; no encrypted private secrets.

## Desired config shape

Add optional SOPS fields and update examples to SOPS-first:

```yaml
secrets:
  sopsFile: config/secrets.sops.yaml
telegramTokenSopsKey: telegram.bot_token
telegramTokenEnv: TELEGRAM_BOT_TOKEN  # optional non-Keychain deployment override

discord:
  tokenSopsKey: discord.bot_token
  tokenEnv: DISCORD_BOT_TOKEN         # optional non-Keychain deployment override
```

Resolution priority for configured sources:

1. SOPS key (`*SopsKey` + `secrets.sopsFile`)
2. Env var (`*Env`) when intentionally configured

No Keychain source is used for active migrated runtime secrets. Remove or deprecate `telegramTokenService` and `discord.tokenService` validation examples in this plan; do not keep a hidden Keychain fallback.

If all configured sources fail or are empty, throw/report a sanitized error naming only source types, key paths, env var names, and failure kind — never values.

## Implementation Tasks

### Task 1: Shared SOPS/env secret resolver module

- [x] Create `bot/src/secrets.ts` or equivalent.
- [x] Implement dot-path to SOPS extract expression conversion: `tavily.api_key` -> `["tavily"]["api_key"]`.
- [x] Reject unsafe path segments; allow only `[A-Za-z0-9_-]+` per segment.
- [x] Implement `readSopsSecret({ file, key, execFileSync? })` using `sops -d --extract <expr> <file>`.
- [x] Capture stdout in memory; suppress/capture stderr; never log values.
- [x] Treat missing binary/file/key, decrypt errors, and blank values as source failures.
- [x] Implement `resolveSecret({ sopsFile, sopsKey, envVar, fieldName })` with priority SOPS -> env.
- [x] Return sanitized aggregate errors when all configured sources fail.
- [x] Remove direct `security find-generic-password` calls from `bot/src` and Pi extension wrappers touched by this plan.

### Task 2: Config integration for Telegram/Discord

- [x] Extend raw config typing with `secrets.sopsFile`, `telegramTokenSopsKey`, and `discord.tokenSopsKey`.
- [x] Resolve relative `secrets.sopsFile` against the directory containing the loaded config file.
- [x] Update `loadConfig(..., { resolveSecrets: false })` so any configured SOPS/env source yields `[configured]`.
- [x] Update validation errors to mention SOPS/env as supported sources.
- [x] Update `config.local.yaml.example` with commented SOPS fields and remove active Keychain guidance.
- [x] Remove or explicitly reject `telegramTokenService` / `discord.tokenService` in config validation with a migration error, unless a narrower deprecation strategy is needed for tests. Do not leave it as a working fallback.

### Task 3: Tavily web-tools integration

- [x] Update `bot/.claude/extensions/web-tools.ts` to use SOPS key `tavily.api_key` from `config/secrets.sops.yaml` relative to the Pi session cwd (`process.cwd()`).
- [x] Do not use Keychain fallback in the extension.
- [x] Keep graceful registration: missing secrets must not prevent `web_search` / `web_fetch` registration.
- [x] Prefer lazy read/cache on first execute if that keeps extension startup simpler; otherwise load once from `process.cwd()` and cache for the Pi process lifetime.
- [x] Update missing-key user-facing text in `bot/src/pi-extensions/tavily.ts` to name SOPS configuration, not Keychain.
- [x] Ensure warnings are sanitized and never include secret values or command stderr containing plaintext.

### Task 4: Tests

- [x] Add unit tests for SOPS extract expression conversion and invalid path rejection.
- [x] Add resolver tests using mocked `execFileSync` for:
  - SOPS success;
  - SOPS blank -> env fallback;
  - SOPS failure -> env fallback;
  - env blank -> missing-source error;
  - all sources missing/failing -> sanitized error.
- [x] Extend `config-secrets.test.ts` for Telegram/Discord `*SopsKey`, source priority, `resolveSecrets: false`, and validation errors.
- [x] Update/remove existing Keychain behavior tests so they match the no-Keychain runtime decision.
- [x] Extend Tavily/web tool tests so missing-key text mentions SOPS configuration and still returns graceful unavailable results.
- [x] Do not add tests that call real `sops`, real Keychain, or use private paths.

### Task 5: Documentation and examples

- [x] Update `config.local.yaml.example` only with non-secret SOPS/env examples.
- [x] Add a short note that runtime SOPS files are private deployment artifacts and not part of the public repo.
- [x] Keep docs free of real service values, tokens, user IDs, chat IDs, or private host paths.

## Validation Commands

Run from `bot/` unless noted:

```bash
npm test
npm run lint
npm run build
```

Additional checks from repo root:

```bash
git diff --check
gitleaks protect --staged --no-banner
rg -n "security find-generic-password|find-generic-password|tokenService" bot/src bot/.claude/extensions config.local.yaml.example
```

The final `rg` check should return no active runtime Keychain usage in the touched areas. If it returns intentional historical docs/tests, explain why they are not active runtime paths.

## Acceptance Criteria

- Telegram/Discord runtime tokens can resolve from SOPS, with env as optional non-Keychain override.
- Pi web tools resolve Tavily from SOPS in a workspace cwd and do not use Keychain.
- Missing secrets produce graceful, sanitized errors.
- Active runtime code touched by this plan contains no `security find-generic-password` Keychain fallback.
- No plaintext secrets, private identifiers, or private absolute paths are added to the public repo.
- All validation commands pass.
