<!-- Optional rule: copy to .claude/rules/custom/ to activate -->
# Memory Protocol

## Why Memory Matters

Claude Code sessions are stateless — each conversation starts fresh with no recall of prior sessions. Without deliberate memory practices, the same context must be re-explained every time, mistakes get repeated, and institutional knowledge is lost.

## Structure

- **Long-term index:** `MEMORY.md` — curated index of memory files in `memory/`
- **Memory files:** `memory/*.md` — individual notes on topics worth remembering across sessions
- **Auto-generated memories:** `memory/auto/*.md` — created by the memory-consolidation skill
- **Diary (optional):** `memory/diary/YYYY-MM-DD.md` — consolidation digests

## Auto-load mechanism

For Pi/Codex sessions, `bot/src/pi-context-assembler.ts` reads `CLAUDE.md`, expands standalone one-level `@<path>` imports such as `@MEMORY.md`, includes platform/custom rules, and passes the bundle to Pi with `--append-system-prompt` and `--no-context-files`.

**Do not remove the `@MEMORY.md` line from `CLAUDE.md`.** Without it, workspace `MEMORY.md` exists on disk but is not included in Pi session context — your memory index becomes invisible to the agent.

## Guidelines

- Write memories for anything that should survive across sessions: user preferences, project decisions, recurring patterns, feedback.
- Keep `MEMORY.md` concise — it's an index, not a journal.
- Review and prune stale memories periodically. Outdated memories are worse than no memories.
- Don't duplicate what's already in code, git history, or documentation.
