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
- **After resolution:** once Ninja resolves a contradiction, update the affected memory file(s) under `memory/auto/` with the resolved value AND remove the corresponding bullet from the `## Pending Review (Lint findings)` section in workspace `MEMORY.md` — in the same operation.
  - **Concurrency: take the consolidation lock, do not just check it.** Before any edit, acquire the same lock the nightly consolidator uses — a file-existence check is TOCTOU-racy (cron can grab the lock between the check and the first write) and never reclaims a stale lock. Run `bash .claude/skills/memory-consolidation/scripts/lock.sh acquire "$PWD/.consolidation.lock" 60` and capture the `ACQUIRED <token>` value. If the script prints `LOCKED` (exit 1), tell Ninja the resolution is deferred and re-attempt at the next opportunity (cron runs are minutes, not hours). When acquired, pass the token to every later `refresh`/`release` call to prove ownership and release the lock at the end of the resolution — including on failure paths (after any rollback). The `60` arg is the stale-TTL in minutes; the script reclaims abandoned locks automatically. Also check `.maintenance.lock` first via `bash .claude/skills/memory-consolidation/scripts/lock.sh check-maintenance "$PWD"`; defer if it returns `MAINTENANCE`.
  - **Use the same safe-edit flow as the nightly path.** Wrap every affected file edit with `.claude/skills/memory-consolidation/scripts/safe-edit.sh backup → write → verify → clean` (and `rollback` on verify failure), exactly as Phase C does. When the resolution touches two memory files plus `MEMORY.md`, apply the paired two-phase commit pattern from Phase B.5 step 5: `backup` ALL affected files first, apply all edits, run `verify` on ALL of them, and only `clean` the backups once every `verify` passes. If any `verify` fails, `rollback` every file from its backup and report the failure to Ninja — never leave a partial resolution where one file is annotated but another is untouched.
    - **MEMORY.md `SUSPICIOUS_SHRINK` allowance.** When the only `MEMORY.md` change is removing Pending Review bullets and/or the section heading, `safe-edit.sh verify` may legitimately return `SUSPICIOUS_SHRINK` (the section can be a large fraction of a small `MEMORY.md`). Apply the same bypass as the nightly path (SKILL.md Phase D step 2): accept the verify failure if (a) the post-edit file still contains the `# Memory Index` heading AND (b) the byte-size of the Pending Review section measured in the pre-edit file (from the `## Pending Review (Lint findings)` heading line through the byte immediately preceding the next `## ` heading or EOF) equals `pre_edit_size - post_edit_size` ± 5 bytes. Capture both numbers BEFORE issuing the edit (the pre-edit state is identical to what `safe-edit.sh backup` copies). Otherwise rollback as usual. Note the bypass briefly when reporting the resolution to Ninja so the audit trail is preserved.
  - **Anti-loop frontmatter.** Add `resolved_at`, `resolution_basis`, and update the `do_not_reopen` list on the affected file(s). `do_not_reopen` is a YAML list of records, each with `partner` (the other file's bare name) and `before` (a YYYY-MM-DD date). For this pair's partner: find any existing entry and apply `MAX(existing.before, new_value)` to its `before` field — NEVER shorten this pair's window. If no entry exists for this partner, APPEND a new `{partner, before}` record. Do NOT touch entries for unrelated partners — that's what makes the cooldown genuinely per-pair. `resolved_at` and `resolution_basis` are scalars and reflect the most recent resolution across all of this file's pairs. Default `before` value: `today + 90 days`. The `before` field is always a date — semantic-condition values like `"Ninja revisits topic X"` are not supported (the consolidation skill has no mechanism to auto-detect such events; use a far-future date if indefinite suppression is genuinely required). Match the canonical YAML in `.claude/skills/memory-consolidation/SKILL.md` Phase B.5 step 5.
  - **Pending Review bullet format.** Preserve the bullet format `- detected_at=YYYY-MM-DD — file-A vs file-B — <reason>` when editing — do not restyle existing bullets or rename the heading, since the consolidation skill parses both. If removing the last bullet empties the section, remove the section heading itself (do not leave an empty `## Pending Review (Lint findings)` heading behind).

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
