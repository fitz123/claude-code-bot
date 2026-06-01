# pi-extensions

Pure, testable helpers for the Pi extensions (A1 guard, A2 web-tools, A3 subagent)
loaded into every `pi --mode rpc` spawn. See `docs/plans/2026-06-01-pi-phase2-extensions.md`.

## Location lock (Task 0)

There are TWO kinds of files in this feature, deliberately split:

1. **Pure helpers — `bot/src/pi-extensions/*.ts`** (this directory).
   All real logic lives here: path classification (A1), Tavily request/parse
   (A2), subagent spawn-arg/result helpers (A3). These files are:
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
