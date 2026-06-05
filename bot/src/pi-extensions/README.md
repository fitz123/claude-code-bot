# pi-extensions

Pure, testable helpers for Pi extension wrappers.

Most helpers here back the live Pi RPC extensions (A1 guard, A2 web-tools, A3
subagent) loaded into every `pi --mode rpc` spawn. `codex-usage.ts` is different:
it is used only by the out-of-band Codex quota sampler via
`bot/.claude/extensions/codex-usage.ts`, and must not be added to the normal
`PI_EXTENSION_WRAPPER_RELPATHS` list. See
`docs/plans/completed/2026-06-01-pi-phase2-extensions.md` for A1-A3.

## Location lock (Task 0)

There are TWO kinds of files in this feature, deliberately split:

1. **Pure helpers — `bot/src/pi-extensions/*.ts`** (this directory).
   All real logic lives here: path classification (A1), Tavily request/parse
   (A2), subagent spawn-arg/result helpers (A3), and the sampler-only Codex
   quota cache/export helper. These files are:
   - **Type-checked by `tsc --noEmit`** (the `npm run lint` command) because the
     bot `tsconfig.json` `include` is `["src/**/*.ts"]`, which matches this path.
   - **Exercised by `npm test`** because the test glob is `src/__tests__/*.test.ts`
     and those tests `import` the helpers from `../pi-extensions/<name>.js`.

   Proven in Task 0 by a throwaway stub helper (`_smoke.ts`) + a sibling test
   (`__tests__/pi-extensions-smoke.test.ts`); both were removed in Task 4 once
   the real A1-A3 helpers (`guard.ts`, `tavily.ts`, `subagent-args.ts`) made the
   coverage self-evident.

2. **Thin wrappers — `bot/.claude/extensions/<name>.ts`** (or `<name>/index.ts`
   for A3). Each is a minimal `export default function (pi) { ... }` that wires a
   Pi `pi.on(...)` / `pi.registerTool(...)` call to the pure helpers above. They
   are jiti-loaded by Pi at spawn via `--extension <abs-path>`.

## Lint-coverage decision for the wrappers (Task 0)

**Decision: the `bot/.claude/extensions/` wrappers are jiti-only — intentionally
EXCLUDED from `tsc --noEmit` and from the `npm test` glob. No second tsconfig or
test glob is added for them.**

Rationale:
- They live OUTSIDE `bot/src/`, so the existing tsconfig `include`
  (`src/**/*.ts`) and the test glob (`src/__tests__/*.test.ts`) do not reach
  them — and we are not extending either to cover them.
- They are intentionally thin: all branching/parsing/error-handling that is worth
  type-checking and unit-testing is factored into the `src/pi-extensions/*.ts`
  helpers, which ARE covered. A wrapper should contain no logic a test would want
  to assert on.
- Adding a second tsconfig/glob to type-check the wrappers would pull Pi's
  runtime extension API types into the bot's `tsc` graph and couple the bot
  build to the `@earendil-works/pi-coding-agent` extension surface. jiti loads
  and validates them at actual spawn time instead; a broken wrapper fails loudly
  at load (fail-closed loading is handled in Task 1's `buildPiSpawnArgs`).

If a wrapper ever grows logic worth testing, move that logic into a
`src/pi-extensions/*.ts` helper rather than adding a tsconfig for the wrapper.

## Context assembler (Claude→Pi parity at spawn)

`bot/src/pi-context-assembler.ts` gives a `provider: "pi"` spawn the SAME context a
Claude Code session loads. Pi reads context files as FLAT text — no `@`-import
expansion, no `.claude/rules/` auto-load, no memory recall — so an agent's
CLAUDE.md `@`-imports and rule files silently vanish under Pi. The assembler reads
the agent's LIVE workspace files (zero drift, always fresh) and hands the result to
Pi via CLI args. It is wired into `buildPiSpawnArgs` in
`bot/src/pi-rpc-protocol.ts`, and runs ONLY for `provider: "pi"` — the
`claude -p` path is untouched.

### Layer mapping

| Pi CLI arg | Carries | Pi semantics |
|---|---|---|
| `--system-prompt <personaFile>` | The agent's persona: the resolved output-style content (`.claude/settings.local.json` `outputStyle` → `.claude/output-styles/<slug>.md`), plus the config `systemPrompt` appended if set. | REPLACES Pi's base "coding assistant" prompt. Omitted entirely when no persona resolves → the agent rides Pi's base prompt. |
| `--append-system-prompt <bundleFile>` | The context bundle (see order below). | APPENDED to the system prompt. |
| `--no-context-files` | — | Stops Pi from ALSO loading CLAUDE.md/AGENTS.md from cwd, so context is delivered once (no double context). |

Personas and bundles are delivered as FILE PATHS, never inline argv: keeps
non-ASCII persona text out of argv (avoids the content-filter class), keeps argv
short, and stays inspectable.

### Bundle order (deterministic)

The `--append-system-prompt` bundle is assembled in this exact order:

1. The CLAUDE.md body with every standalone `@<path>` line removed.
2. Each removed `@`-import expanded as a `## <relpath>` section, in the order the
   `@`-lines appeared (read relative to the CLAUDE.md dir, **1 level only** — a
   nested `@`-line inside an imported file is NOT recursed, only `log.warn`-ed).
3. Every `.claude/rules/platform/*.md` as a `## <relpath>` section, sorted.
4. Every `.claude/rules/custom/*.md` as a `## <relpath>` section, sorted.
5. A fixed `## Memory access` directive (verbatim).

MEMORY.md reaches the bundle as one of the CLAUDE.md `@`-imports (`@MEMORY.md`) →
expanded as a `## MEMORY.md` section = the long-term-memory index. The corpus under
`memory/auto/*` is read ON DEMAND, not inlined. Auto-recall like the Claude harness
(a `memory_search` RAG tool) is **not yet available under Pi — it is a tracked
fast-follow**; the fixed directive tells the agent to read the index deliberately.

### Fail-safe & cache

- **Fail-safe:** every file read is wrapped — a missing/unreadable source is
  `log.warn`-ed and skipped, NEVER thrown. A total failure returns `null` so the
  caller degrades to a bare Pi spawn. The assembler must never break a spawn.
- **Cache:** artifacts are cached per agent, keyed on a manifest of every source
  file's `{path, mtime, size}`. On a cache HIT (unchanged source set) the assembler
  SKIPS re-reading and re-assembling the sources, but STILL re-writes the `.tmp/`
  artifact files from the cached content — it never trusts a possibly-stale or
  tampered on-disk bundle (a gitignored `.tmp/` file a prior Pi session or external
  process could overwrite), and this also transparently recreates a deleted
  artifact. A touched source re-assembles (freshness parity).
- **Artifacts:** written atomically (staging file → `renameSync`) to STABLE
  per-agent paths under `<workspaceCwd>/.tmp/pi-context-<agentId>.{bundle,persona}.md`
  — stable path ⇒ no accumulation, no cleanup job.
