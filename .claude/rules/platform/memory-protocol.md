# Memory Protocol

## Storage locations

- **Daily notes:** `memory/daily/YYYY-MM-DD.md` — consolidation digests
- **Long-term:** `MEMORY.md` — curated index of memory files
- **Auto files:** `memory/auto/` — structured memory files with frontmatter

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
