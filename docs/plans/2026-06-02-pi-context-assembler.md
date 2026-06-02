# Pi Context Assembler — full Claude→Pi context parity at spawn time

Implement a spawn-time context assembler so a Pi (`pi --mode rpc`, OpenAI Codex) session receives the SAME context a Claude Code session loads. Pi reads context files as FLAT text (no `@`-import expansion, no `.claude/rules/` auto-load, no memory recall — verified in `@earendil-works/pi-coding-agent` v0.78 `dist/core/resource-loader.js` + `system-prompt.js`). Without this, an agent's CLAUDE.md `@`-imports and its rule files silently vanish under Pi.

This is the code half of an approved design. The per-agent cutover + live verification happen separately (operational). Scope here = the bot assembler + its wiring + tests.

## Goal

For a `provider: "pi"` spawn, the bot assembles context from the agent's LIVE workspace files and delivers it to Pi via CLI args:
- `--system-prompt <personaFile>` — the agent's persona (output-style content), REPLACING Pi's base "coding assistant" prompt. Agents with no resolvable output-style get NO `--system-prompt` (ride Pi base).
- `--append-system-prompt <bundleFile>` — the context bundle (see Bundle spec).
- `--no-context-files` — so Pi does NOT ALSO load CLAUDE.md/AGENTS.md from cwd (avoid double context). Flag verified present (`dist/cli/args.js`: `--no-context-files`/`-nc`).
- Skills are already surfaced natively via `~/.pi/agent/settings.json` (`skills: ["~/.claude/skills"]`) — no work here.

Assemble from live files (zero drift, always-fresh = parity), cache by an mtime/size manifest, FAIL-SAFE (a missing/unreadable source → skip + log, NEVER throw — the assembler must never break a spawn).

## Non-goals
- NO pre-rendered AGENTS.md / generator (assemble at spawn from live files).
- NO memory RAG / auto-recall (interim = MEMORY.md index inline + on-demand reads; the `memory_search` RAG is a separate fast-follow).
- NO change to the Claude (`claude -p`) spawn path — assembler runs ONLY for `provider: "pi"`.
- NO deep (>1-level) `@`-import recursion (1 level covers all current agents; WARN if a deeper import appears).
- The per-agent cutover + HARD-GATE verification are operational, not in this PR.

## Context — files (this repo)
- `bot/src/pi-rpc-protocol.ts` — `buildPiSpawnArgs(agent, resumeSessionId?)` (~215-244) maps `agent.systemPrompt` → `--append-system-prompt` (~226-228) and resolves `--extension` args; `workspaceCwd` used at ~293. This is where the assembler wires in. The OLD `agent.systemPrompt → --append-system-prompt` branch is REPLACED (persona now goes to `--system-prompt`; the bundle goes to `--append-system-prompt`).
- `bot/src/config.ts` — `AgentConfig`: `workspaceCwd`, `systemPrompt`, the pi provider/model gate. The assembler needs `workspaceCwd` + `id` + optional `systemPrompt`.
- Pi package (read-only, for behavior confirmation): `dist/core/resource-loader.js` (flat read, candidates `[AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD]`), `dist/core/system-prompt.js` (`--system-prompt` REPLACE, `--append-system-prompt` APPEND, `<project_context>` only when context files load, skills appended independently), `dist/cli/args.js` (`--no-context-files`/`-nc`).
- Test convention: `node:test` — `node --import tsx --test src/__tests__/*.test.ts` (per `bot/package.json`); tests live in `bot/src/__tests__/*.test.ts`, import `{describe,it,after} from "node:test"` + `assert from "node:assert/strict"`, fixtures via `fs.mkdtempSync`, relative imports use the `.js` extension. NOT vitest.

## Bundle spec (deterministic — D7)
A markdown string assembled in this exact order:
1. CLAUDE.md body with every `@<path>` line REMOVED.
2. Each removed `@`-import expanded as a `## <relpath>` section, in the ORDER the `@`-lines appeared (read each path relative to the CLAUDE.md dir; 1 level; if a read file itself contains `@`-lines, do NOT recurse — emit a `log.warn` naming it).
3. Every `.claude/rules/platform/*.md` as a `## <relpath>` section, sorted by relpath.
4. Every `.claude/rules/custom/*.md` as a `## <relpath>` section, sorted by relpath.
5. A FIXED `## Memory access` directive (verbatim): "MEMORY.md above is the index of long-term memory. When a topic matches an entry, use the read tool to load the specific `memory/auto/<name>.md` on demand. (Auto-recall like the Claude harness is not yet available under Pi — read deliberately by index; a memory_search tool is a tracked fast-follow.)"

Note: MEMORY.md reaches the bundle as one of the CLAUDE.md `@`-imports (it is `@MEMORY.md`) → expanded as a `## MEMORY.md` section = the index. The corpus (`memory/auto/*`) is read on demand, not inlined.

## Persona spec (D6)
- Resolve the agent's output-style: read `<workspaceCwd>/.claude/settings.local.json` `outputStyle` → `<workspaceCwd>/.claude/output-styles/<slug>.md`; the file content is the persona.
- If `agent.systemPrompt` (config) is ALSO set, append it AFTER the output-style content (blank-line separated) in the persona file.
- If neither resolves → return null → pass NO `--system-prompt` (agent rides Pi base).
- Deliver via a FILE PATH (`--system-prompt <personaFile>`), not argv (keeps non-ASCII persona text out of argv — avoids the content-filter class; keeps argv short; inspectable).

## Temp-file spec (D8)
Write bundle + persona to STABLE per-agent paths under the agent's workspace `.tmp/`: `<workspaceCwd>/.tmp/pi-context-<agentId>.bundle.md` and `.../pi-context-<agentId>.persona.md`. Atomic overwrite each spawn (write `<path>.tmp.<pid>` then `renameSync`). Stable path ⇒ no accumulation, no cleanup job. `.tmp/` is gitignored + in the workspace write-allowlist.

## Cache + fail-safe (D9/D11)
- Cache the assembled bundle/persona per agent, keyed on a manifest of every source file's `{path, mtime, size}` (OpenClaw `workspaceFileCache` pattern). Re-assemble only when the manifest changes → freshness parity, cheap repeat spawns.
- Every file read wrapped: missing/unreadable → `log.warn` + skip that piece, NEVER throw. A total failure → return no extra args (bare Pi spawn) rather than crash the spawn.

## Tasks

### Task 1: the assembler module [HIGH]
- [x] Create `bot/src/pi-context-assembler.ts` exporting `assemblePiContext(agent)` → `{ systemPromptPath?: string, appendSystemPromptPath: string }` (paths; or omit systemPromptPath when no persona). (Returns null on a totally-empty workspace / total failure → bare spawn.)
- [x] Implement `expandImports(body, baseDir)`: extract `@<path>` lines, return `{ bodyWithoutImports, sections: [{relpath, content}] }`; read each path relative to baseDir; 1-level; `log.warn` on a nested `@`-line (no recursion); missing import file → warn + skip.
- [x] Implement `collectRules(workspaceCwd)`: read `.claude/rules/platform/*.md` + `.claude/rules/custom/*.md`, sorted by relpath, as `{relpath, content}`; tolerate a missing dir.
- [x] Implement `buildBundle(workspaceCwd)`: read CLAUDE.md → expandImports → assemble per the Bundle spec order (1-5) into one string; the fixed memory directive verbatim.
- [x] Implement `resolvePersona(agent)` per the Persona spec (output-style + optional config systemPrompt; null when none).
- [x] Implement `writeTempArtifact(workspaceCwd, agentId, kind, content)` atomic (write `.tmp.<pid>` → rename) to the stable path.
- [x] Implement the manifest mtime/size cache (per agentId): skip re-read+re-assemble when no source changed.
- [x] Wrap all FS in fail-safe (missing → warn+skip, never throw).
- [x] write tests for the assembler (Task 3). (`bot/src/__tests__/context-assembler.test.ts`, 20 tests green.)

### Task 2: wire into the Pi spawn path [HIGH]
- [x] In `bot/src/pi-rpc-protocol.ts buildPiSpawnArgs`: for `provider: "pi"` agents, call `assemblePiContext(agent)`; push `--system-prompt <personaPath>` IF present, `--append-system-prompt <bundlePath>`, and `--no-context-files`.
- [x] REMOVE the old `agent.systemPrompt → --append-system-prompt` branch (persona now via `--system-prompt`; bundle via `--append-system-prompt`). Exactly ONE `--system-prompt` and ONE `--append-system-prompt` arg max.
- [x] Wrap the assembler call so a thrown error (should not happen — fail-safe) degrades to a bare spawn + `log.error`, never blocks the spawn.
- [x] Confirm the existing `--extension` (write-guard etc.) args still compose correctly alongside the new args. (Test: context args precede `--extension`, which precede `--session`; all 3 wrappers still resolve.)
- [x] write tests for the spawn-args wiring (Task 3). (`bot/src/__tests__/pi-rpc-protocol.test.ts` — new "context assembly (provider: pi)" block, 5 tests; legacy-branch test replaced. Full suite 1373 green, lint clean.)

### Task 3: tests [HIGH]
- [x] `bot/src/__tests__/context-assembler.test.ts` (`node:test`, fixture via `fs.mkdtempSync(os.tmpdir()+"/pi-ctx-")`): build a fixture workspace (CLAUDE.md with one `@import.md` line + a MEMORY.md import, one `.claude/rules/platform/x.md`, one `.claude/rules/custom/y.md`, a `.claude/settings.local.json` + an output-style file). Assert: bundle contains the expanded import section + both rule sections + the fixed memory directive, in the deterministic order; `@`-lines removed from the body; persona resolved from the output-style; a missing import file → warn + skip (no throw); no output-style → no persona path. (20 tests green.)
- [x] Test `buildPiSpawnArgs` for a pi agent: asserts `--system-prompt`, `--append-system-prompt`, `--no-context-files` present (+ paths point at the temp files); a no-persona agent → no `--system-prompt`; a non-pi agent → assembler not invoked. (5 context-assembly tests + non-pi gating test, all green.)
- [x] write a test for the mtime cache (second call without source change → no re-read; touch a source → re-assemble). (`assemblePiContext` "caches by the source manifest" test.)
- [x] run tests (separate step): `cd bot && npm test` — green. (Full suite 1373 pass, 0 fail.)

### Task 4: Verify acceptance criteria [HIGH]
- [x] `cd bot && npm test && npm run lint && npx tsc --noEmit` — all green. (npm test 1373 pass / 0 fail; `npm run lint` is `tsc --noEmit`, clean; `npx tsc --noEmit` exit 0.)
- [x] Confirm the assembler runs ONLY for `provider: "pi"` (no effect on the claude path). (`if (agent.provider === "pi")` guard in `buildPiSpawnArgs`; test "does NOT invoke the context assembler for a non-pi agent" asserts no context args.)
- [x] Confirm `--no-context-files` is passed (so no double-context) and the bundle contains all 31 rule files + expanded imports for a realistic fixture. (Live-workspace `buildBundle` run: all 15 rule sections present — this workspace has 15 platform + 0 custom rules, not 31; "31" was the count at plan-writing time, the assembler collects all that exist — plus expanded `@USER.md`/`@IDENTITY.md`/`@MEMORY.md` sections, the `## Memory access` directive, and zero leftover bare `@`-lines; spawn-args tests assert `--no-context-files`.)
- [x] Confirm fail-safe: a fixture with a missing CLAUDE.md / missing rules dir does NOT throw (bare spawn args). (Live: a missing `reference/governance/decisions.md` import → warn+skip, no throw; a nonexistent workspace → null bare spawn. Unit tests "fail-safe: a missing CLAUDE.md does not throw" + "tolerates a missing rules dir" + "returns null (bare spawn) for an empty workspace".)
- NOTE: live per-agent context parity (the HARD GATE) is verified operationally post-merge, not in this PR.

### Task 5: Update documentation [HIGH]
- [ ] Add a short section to `README.md` (or `bot/src/pi-extensions/README.md` if that's the home for Pi-spawn docs) describing the context assembler: what it delivers, the layer mapping (`--system-prompt` persona / `--append-system-prompt` bundle / `--no-context-files`), fail-safe, and that memory auto-recall is a tracked fast-follow.
- [ ] Ensure code comments in `pi-context-assembler.ts` document the deterministic bundle order + the 1-level import policy.
