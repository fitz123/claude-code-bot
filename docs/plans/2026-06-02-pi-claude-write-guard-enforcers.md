# Write-Guard Enforcers — Schema-Enforced Deny-by-Default (Pi + Claude paths)

Implement a deny-by-default, path-granular write-guard in BOTH enforcers, driven by a single workspace-local `schema.md` that each enforcer parses directly. An immutable core of upstream-owned paths stays hardcoded in the enforcers (never unlockable via the schema). This is the code half of an approved design; the workspace-local `schema.md` already exists in the deploying workspace.

## Goal

- Both enforcers ALLOW a write/edit/bash-write only if the target's workspace-relative path matches an entry in `schema.md`'s fenced ```` ```write-allowlist ```` block; otherwise BLOCK (deny-by-default), with an actionable message telling the agent to add the path to `schema.md` and retry.
- The IMMUTABLE CORE of 10 upstream-owned paths is checked FIRST and ALWAYS blocks, even if the allow-list would match it (deny-overlay > allow > default-deny). It is hardcoded in the enforcers, not read from `schema.md`.
- Single source of truth: both enforcers parse the SAME `schema.md` fenced block with the SAME match semantics → no drift. A parity test proves it.
- Threat model: NOT defense against a malicious agent (trusted operator) — this is anti-drift + footgun-prevention (stop accidental writes into upstream-owned or unregistered paths).

## Non-goals
- No generated sidecar / lint-and-regenerate pipeline — the fenced block in `schema.md` is parsed directly.
- No recursive `**` globs — path-prefix + root-only `*`/`?` globs only.
- No audit/warn-only mode — hard-enforce from activation.
- Do NOT close the claude-path bash-redirect gap in v1 (see "Bash coverage" below) — document it.
- Do NOT remove the existing root-component allowlist logic / orphan-allowlist files — they coexist (a separate later effort removes them).

## Context — files (all in this repo)

- `bot/src/pi-extensions/guard.ts` — Pi-path pure classifier. `PROTECTED_PREFIXES` (lines ~44-49, currently **4** paths); `isProtectedPath` (~128-134); `globToRegExp` (~136-143); `isAllowedRootComponent` (~150-162, root-component only — do NOT reuse for the new check); `classifyTargetPath` (~206-296, protected-prefix check ~262, orphan check ~280-293); `classifyToolCall` (~306-342, unknown-root fail-closed ~320-328); `extractBashWriteTargets` (~631).
- `bot/.claude/extensions/guardian-protect-files.ts` — thin Pi wrapper; `readOrphanAllowlist(workspaceRoot)` (~31-50) reads `orphan-allowlist.txt`+`.local.txt`; injects into `classifyToolCall` lazily for `write` only (~62-66).
- `bot/src/__tests__/guard.test.ts` — pins `PROTECTED_PREFIXES` to the 4-set (~20-27); bash-redirect tests (~240-348).
- `.claude/hooks/guardian.sh` — claude-path PreToolUse hook; root-component (`ROOT_COMPONENT="${REL_PATH%%/*}"`, ~line 77) `case`-glob allowlist (~90-106); Edit always allowed; Write existing-file overwrite exempt (~72-75); missing-allowlist fail-closed (~83-87); block message (~108-115).
- `.claude/hooks/protect-files.sh` — claude-path PreToolUse hook; the 10-path immutable `case` block (~105-117); `PROTECT_FILES_BYPASS=1` (~85); inspects only `tool_input.file_path` (~14, no bash parsing).
- `.claude/rules/platform/bot-code-readonly.md` — canonical doc for the 10 upstream-owned paths.
- `.gitleaks.toml` — the `telegram-handles` rule (~44-51) with an allowlist that lists the existing workspace imports (`@IDENTITY` / `@USER` / `@MEMORY`) but NOT the new `schema` import → a workspace CLAUDE.md line that imports `schema.md` via the at-sign prefix is a false-positive block. Fix below.

## The schema.md contract (what both enforcers parse)

`schema.md` lives at the workspace root. It contains exactly one fenced block tagged ```` ```write-allowlist ````. Extract its lines (between the opening ```` ```write-allowlist ```` fence and the next ```` ``` ````), strip `#` comments and blank lines, trim. Example block:

```
memory/                  # comment
reference/
.claude/rules/custom/
.claude/skills/
*.md
MEMORY.md
schema.md
```

### Match semantics (D17 — both enforcers identical, against the workspace-relative POSIX path, case-insensitive for APFS)
- **Directory prefix** line (trailing slash, e.g. `memory/`): matches when `path == prefix-without-slash` OR `path` startsWith `prefix`.
- **Root-only glob** line (a bare glob, e.g. `*.md`): matches a ROOT-LEVEL file only — `path` has no `/` AND the glob matches it.
- **Exact root-file** line (no slash, no glob, e.g. `MEMORY.md`): matches that exact relative path only.

### Immutable core (hardcoded in the enforcers — the deny-overlay)
The 10 upstream-owned paths: `bot/`, `.claude/hooks/`, `.claude/rules/platform/`, `.claude/skills/workspace-health/scripts/`, `.github/workflows/`, `.githooks/`, `.gitleaks.toml`, `.gitleaksignore`, `README.md`, `config.local.yaml.example`. Directory entries (trailing slash) match as prefixes; the four file entries (`.gitleaks.toml`, `.gitleaksignore`, `README.md`, `config.local.yaml.example`) match ROOT-ONLY EXACT (`README.md` blocks the root file but NOT `docs/README.md`). The immutable check runs BEFORE the allow-list check and always wins.

### Coexistence (do not break the running system)
The new deny-by-default check is gated behind a NEW option/code path. The existing root-component `orphanAllowlist` (Pi) / orphan-allowlist (claude) logic STAYS for not-yet-migrated callers. The Pi wrapper injects exactly ONE model per session: the new `writeAllowlist` (deny-by-default) for the new model — it does NOT co-inject both.

### Fail-safe
If `schema.md` is missing/unreadable or its fenced block is empty/unparseable: the immutable-core deny STILL applies (security never relaxes), and the allow-list check fails CLOSED with an actionable message naming `schema.md` + the bypass env. Never silently allow-all; never silently brick-all. Bypass: `WRITE_GUARD_BYPASS=1` (claude path, logged to stderr) / `PI_EXTENSIONS_DISABLED=1` (Pi path).

### Bash coverage (asymmetry — by design for v1)
Pi path: the new allow-check MUST run for bash write targets via `extractBashWriteTargets` (so `echo x > unregistered/y` is blocked, `echo x > memory/y.md` allowed). Claude path: the bash-redirect gap is a DOCUMENTED tracked v1 known-gap (do NOT port bash parsing into the bash hook now) — add a comment in `guardian.sh`/`protect-files.sh` noting it.

## Tasks

### Task 1: guard.ts — immutable core 4→10 + file-vs-dir matching
- [x] Sync `PROTECTED_PREFIXES` from the current 4 to the full 10 (add `.claude/hooks/`, `.claude/skills/workspace-health/scripts/`, `.gitleaks.toml`, `.gitleaksignore`, `README.md`, `config.local.yaml.example`).
- [x] Extend `isProtectedPath` to distinguish trailing-slash entries (prefix match, current behaviour) from no-slash file entries (ROOT-ONLY EXACT match). Keep case-insensitive folding.
- [x] write tests for the file-vs-dir immutable matching.
- [x] run tests — must pass.

### Task 2: guard.ts — deny-by-default allow-check + bash coverage + fail-safe
- [x] Add a `writeAllowlist?: readonly string[]` option to `ClassifyOptions` (alongside `orphanAllowlist?`).
- [x] Add a new `isAllowedPath(relPath, writeAllowlist)` helper implementing the three D17 line kinds (reuse `globToRegExp` for root-only globs; do NOT reuse `isAllowedRootComponent`).
- [x] In `classifyTargetPath`, when `writeAllowlist` is present: after the immutable-core check, BLOCK any write/edit/bash target whose path matches no allow line. Applies to write/edit AND bash targets (not just `write`).
- [x] Make the block message actionable: name the blocked relative path, point to `schema.md`, suggest the exact line to add, mention the notify-the-owner step. Keep the existing immutable-core message unchanged.
- [x] Fail-safe: if `writeAllowlist` is absent/empty (missing schema.md block), immutable-core still blocks; the allow-check fails CLOSED with the actionable "schema.md missing → add it / set PI_EXTENSIONS_DISABLED=1" message. Preserve the existing unknown-root fail-closed.
- [x] Preserve `workspaceRoot`/`resolveRoot` separation + subagent-cwd behaviour.
- [x] write tests (see Task 6) — separate step.
- [x] run tests — must pass.

### Task 3: guardian-protect-files.ts wrapper — parse schema.md directly
- [ ] Add `readWriteAllowlist(workspaceRoot)`: read `<workspaceRoot>/schema.md`, extract the single ```` ```write-allowlist ```` fenced block, strip `#` comments + blank lines + trim (identical to the existing `readOrphanAllowlist` stripping), return the lines. Cache per process.
- [ ] Inject the result as `writeAllowlist` into `classifyToolCall` for write/edit AND bash (not only `write`). Inject `writeAllowlist` (new model) — do NOT also inject `orphanAllowlist`.
- [ ] If `schema.md` or the block is missing → inject empty/undefined so the fail-safe path triggers (do not throw).

### Task 4: guardian.sh — root-component → path-prefix, parse schema.md
- [ ] Replace `ROOT_COMPONENT="${REL_PATH%%/*}"` root-component matching with full-relative-path matching against `schema.md`'s fenced block. Extract the block with `awk '/^```write-allowlist$/{f=1;next}/^```/{f=0}f' "$WORKSPACE/schema.md"`, strip `#`/blank lines (same as the existing allowlist stripping).
- [ ] Implement the three D17 line kinds in bash: directory-prefix (`[[ "$REL_PATH" == p || "$REL_PATH" == p/* ]]`), root-only-glob (match only when `REL_PATH` has no `/` and the `case` glob matches), exact-root-file (`[[ "$REL_PATH" == name ]]`). Add a comment block documenting the three kinds.
- [ ] PRESERVE: the `..`-traversal block, the `//`/`/./` normalization, and the existing-file overwrite exemption — all BEFORE the new allow-check.
- [ ] Add `WRITE_GUARD_BYPASS=1` (logged to stderr).
- [ ] Make the block message actionable (path + schema.md + the exact line + notify step).
- [ ] Fail-safe: missing/empty `schema.md` block → fail CLOSED with the actionable message (mirror the existing missing-allowlist fail-closed).
- [ ] Add a comment noting the claude-path bash-redirect gap (D16 tracked known-gap) — only `tool_input.file_path` is inspected.
- [ ] write the bash test harness (Task 6) — separate step.
- [ ] run the harness — must pass.

### Task 5: protect-files.sh + .gitleaks.toml + docs
- [ ] Confirm `protect-files.sh`'s 10-path immutable `case` block is unchanged and runs as the deny-overlay; confirm the hook order in `.claude/settings.json` runs `protect-files.sh` (deny) before `guardian.sh` (allow) so deny-overlay-wins holds for the `.claude/` split.
- [ ] `.gitleaks.toml`: the `telegram-handles` allowlist (line ~51) lists `@IDENTITY` / `@USER` / `@MEMORY` but not the `schema` import. Add an allowlist alternative for the at-sign-prefixed `schema` handle (the workspace's new `schema.md` `@`-import), matching the existing entries' bare style, so workspace CLAUDE.md files importing `schema.md` are not false-positive-blocked. (Adding the handle to its own allowlist self-suppresses, so the edit commits cleanly.)
- [ ] `bot-code-readonly.md`: note the immutable-core 10 paths are the deny-overlay of the new schema-enforce and that `guard.ts` now pins the full 10 (no longer a narrowed 4).

### Task 6: tests (guard.test.ts + bash harness + parity)
- [ ] guard.test.ts: re-pin `PROTECTED_PREFIXES` to the full 10 (replaces the 4-set assertion).
- [ ] guard.test.ts: with an injected `writeAllowlist` array — (a) non-schema path `unregistered/x` BLOCKED with an actionable reason naming `schema.md`; (b) schema path `memory/x.md` ALLOWED; (c) immutable `README.md` BLOCKED even though `*.md` is allowed (precedence); (d) `docs/README.md` ALLOWED when `docs/` allowed (immutable file = root-only-exact); (e) bash redirect `echo x > unregistered/y` BLOCKED, `echo x > memory/y.md` ALLOWED; (f) `.claude/skills/workspace-health/scripts/x.ts` BLOCKED though `.claude/skills/` allowed; (g) `.claude/skills/custom/index.ts` ALLOWED; (h) `.claude/rules/custom/x.md` ALLOWED; (i) `.claude/rules/platform/x.md` BLOCKED; (j) fail-safe: no `writeAllowlist` → immutable still blocks, allow-check fail-closed.
- [ ] bash test harness (under the repo's hook-test location or a `bot/.claude/extensions/__tests__`-style script): with a temp `schema.md` fixture — non-schema blocked; schema allowed; immutable `README.md` blocked + `docs/README.md` allowed; `.claude/rules/custom/x.md` allowed; `.claude/hooks/x.sh` blocked; existing-file overwrite allowed; `WRITE_GUARD_BYPASS=1` works.
- [ ] PARITY test: feed a fixed set of paths (all D17 line kinds + `.claude/` split + immutable core) to BOTH `classifyToolCall` (injected `writeAllowlist`) and `guardian.sh` (temp `schema.md` fixture), assert identical allow/deny.
- [ ] run the full suite: `cd bot && npm test && npm run lint && npx tsc --noEmit` — green.

### Task 7: Verify acceptance criteria
- [ ] `guard.ts` pins the full 10 immutable paths (test green).
- [ ] deny-by-default + precedence + `.claude/`-split + bash + fail-safe tests green (guard.test.ts).
- [ ] guardian.sh path-prefix + the bash harness + the parity test green.
- [ ] `.gitleaks.toml` allowlists the at-sign-prefixed `schema` import handle; `bot-code-readonly.md` aligned.
- [ ] full `npm test && npm run lint && npx tsc --noEmit` green.
- NOTE: the wrapper's `readWriteAllowlist` (schema.md parse) + guardian.sh's awk extraction are runtime/jiti paths verified LIVE post-merge by the operator (not in the node test suite) — same as other extension wrappers. The pure `classifyToolCall` + the bash harness ARE covered here.

### Task 8: Update documentation
- [ ] Ensure code comments in `guard.ts` + `guardian.sh` document the D17 match semantics + the bash-redirect asymmetry.
- [ ] Confirm `bot-code-readonly.md` reflects the unified model.
