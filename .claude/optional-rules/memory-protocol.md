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

Workspace root `MEMORY.md` is auto-loaded into the agent's initial context via the `@MEMORY.md` line in `CLAUDE.md`. This is a workaround for [anthropics/claude-code#34146](https://github.com/anthropics/claude-code/issues/34146): the `autoMemoryDirectory` setting is documented to redirect auto-memory location, but in practice does NOT affect system-prompt injection — it only affects **writes**. System-prompt injection of MEMORY.md always reads from the default `~/.claude/projects/<encoded>/memory/MEMORY.md` path regardless of the setting.

The workaround comes from the issue thread (see also [#36636](https://github.com/anthropics/claude-code/issues/36636)): a line containing exactly `@MEMORY.md` in `CLAUDE.md` causes Claude Code to inline workspace MEMORY.md content via the @-import mechanism. CLAUDE.md instructions take priority over the system prompt's hardcoded path.

**Do not remove the `@MEMORY.md` line from `CLAUDE.md`.** Without it, workspace `MEMORY.md` exists on disk but never enters the agent's initial context — your memory index becomes invisible to the agent.

## Guidelines

- Write memories for anything that should survive across sessions: user preferences, project decisions, recurring patterns, feedback.
- Keep `MEMORY.md` concise — it's an index, not a journal.
- Review and prune stale memories periodically. Outdated memories are worse than no memories.
- Don't duplicate what's already in code, git history, or documentation.
