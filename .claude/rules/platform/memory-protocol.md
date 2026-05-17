# Memory Protocol

## Storage locations

- **Diary digests:** `memory/diary/YYYY-MM-DD.md` — consolidation digests
- **Long-term:** `MEMORY.md` — curated index of memory files
- **Auto files:** `memory/auto/` — structured memory files with frontmatter

## Auto-load mechanism

Workspace root `MEMORY.md` is auto-loaded into the agent's initial context via the `@MEMORY.md` line in `CLAUDE.md`. This is a workaround for [anthropics/claude-code#34146](https://github.com/anthropics/claude-code/issues/34146): the `autoMemoryDirectory` setting is documented to redirect auto-memory location, but in practice does NOT affect system-prompt injection — it only affects **writes**. System-prompt injection of MEMORY.md always reads from the default `~/.claude/projects/<encoded>/memory/MEMORY.md` path regardless of the setting.

The workaround comes from the issue thread (see also [#36636](https://github.com/anthropics/claude-code/issues/36636)): a line containing exactly `@MEMORY.md` in `CLAUDE.md` causes Claude Code to inline workspace MEMORY.md content via the @-import mechanism. CLAUDE.md instructions take priority over the system prompt's hardcoded path.

**Do not remove the `@MEMORY.md` line from `CLAUDE.md`.** Without it, workspace `MEMORY.md` exists on disk but never enters the agent's initial context — your memory index becomes invisible to the agent.

## Surfacing pending lint items

When workspace `MEMORY.md` contains a `## Pending Review (Lint findings)` section, the agent **MUST** proactively surface those items in the current conversation. Ninja has stated explicitly that he will not proactively ask — without this rule, the items rot indefinitely. Context: ADR-069 (memory-lint Phase B.5 trial 2026-05-17 → 2026-06-17, beads `workspace-txyu`).

### Surfacing strategy

- **Preferred trigger (topic-related):** when the current conversation's topic naturally relates to a pending item, bring it up inline as part of the relevant answer (e.g., "Кстати, есть unresolved contradiction про X — какой из вариантов актуален?"). Topic-relatedness is the agent's own judgment, not a strict keyword match — err on the side of mentioning when there is a plausible connection.
- **Aged escalation (>14 days):** if a pending item is older than 14 days AND no topic-relevant opportunity has arisen during the session, surface it at a natural pause or at task end. Do not let aged items sit silent indefinitely.
- **One per session max:** never dump multiple pending items in a single message or session. Pick the most topic-relevant item, or if none is relevant, the oldest one.
- **Never interrupt urgency:** if Ninja is mid-urgent-task (incident, time-pressured debugging, mid-deploy), do not derail the flow with a pending item — wait for a natural break or for the urgent work to finish.
- **After resolution:** once Ninja resolves a contradiction, update the affected memory file(s) under `memory/auto/` with the resolved value AND remove the corresponding bullet from the `## Pending Review (Lint findings)` section in workspace `MEMORY.md` — in the same operation. Add `resolved_at`, `resolution_basis`, `do_not_reopen_before`, and `do_not_reopen_partners` to the frontmatter of the affected file(s). `do_not_reopen_partners` is a YAML list — APPEND the other file's name (filename only, no path) to any existing list; do NOT overwrite prior entries, or the earlier pair's anti-loop guarantee is lost. The other three fields are scalars and reflect the most recent resolution. Match the `memory-consolidation` skill's anti-loop pattern (see `.claude/skills/memory-consolidation/SKILL.md` Phase B.5 step 5 for the canonical YAML and sanitization rules). Preserve the bullet format `- detected_at=YYYY-MM-DD — file-A vs file-B — <reason>` when editing — do not restyle existing bullets or rename the heading, since the consolidation skill parses both. If removing the last bullet empties the section, remove the section heading itself (do not leave an empty `## Pending Review (Lint findings)` heading behind).

## What goes WHERE: rules vs memory

### Rule (`.claude/rules/custom/`)
**Behavioral instructions.** What to DO or NOT DO. Loaded every session.

Create a rule when:
- Ninja corrects behavior and it should never happen again
- A process/protocol is established (bugfix flow, verification steps)
- A lesson learned becomes a permanent instruction

### Memory (`memory/auto/`)
**Context and facts.** What IS, not what to do. Loaded via MEMORY.md index.

Create a memory when:
- Learning about Ninja (preferences, role, family) → `type: user`
- Project state that's not in code/git (deadlines, decisions, stakeholders) → `type: project`
- External resource locations (Linear boards, Grafana dashboards) → `type: reference`

### Decision flowchart

1. Is it an instruction? (do X, don't do Y, always Z) → **RULE**
2. Is it a fact about a person, project, or resource? → **MEMORY**
3. Is it both? → **RULE** (put the instruction in the rule, drop the context if the rule is self-explanatory)
4. Does a rule already cover it? → **Don't create memory. Update the rule if needed.**

### Never duplicate
Before creating anything — check if a rule or memory already covers it. Same content in two places = guaranteed drift.
