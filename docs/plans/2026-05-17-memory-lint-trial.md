# Memory-Lint Phase B.5 Trial — Provenance Frontmatter + Contradiction Detection + Surfacing Rule

## Goal

30-day trial (2026-05-17 → 2026-06-17) of automated cross-file contradiction detection in memory, with proactive in-conversation surfacing. Adds to existing `memory-consolidation` skill: new Phase B.5 (lint pass), expanded Phase C (frontmatter persistence), expanded Phase D (Pending Review section in workspace MEMORY.md + stats file). Adds platform rule requiring the agent to surface pending items in conversation.

Feature-flagged for instant rollback. Anti-loop fields prevent re-triggering same contradiction nightly. Auto-resolve uses `evidence > confidence` hierarchy (codex-recommended; a "recency" leg was dropped during review because `resolved_at` reflects unrelated prior resolutions and is not a valid freshness proxy for the current claim).

References upstream: ADR-069, beads workspace-txyu, [Karpathy LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (abstract — no algorithm). Codex provided concrete algorithm.

## Validation Commands

```bash
grep -q 'LINT_PHASE_B5_ENABLED' .claude/skills/memory-consolidation/SKILL.md && \
grep -q '### Phase B.5' .claude/skills/memory-consolidation/SKILL.md && \
grep -q 'evidence > confidence' .claude/skills/memory-consolidation/SKILL.md && \
grep -q 'resolved_at\|do_not_reopen_before' .claude/skills/memory-consolidation/SKILL.md && \
grep -q '## Surfacing pending lint items' .claude/rules/platform/memory-protocol.md && \
echo "All checks passed"
```

## Reference: Current `memory-consolidation` skill

File: `.claude/skills/memory-consolidation/SKILL.md`.

Existing phases:
- Phase 0: Validate (locks, dirs)
- Phase A: Gather sessions (last 48h)
- Phase B: Diff & Score — confidence scoring (1.0/0.9/0.7/0.5), supersession check on new vs existing
- Phase C: Apply changes (mutation limit 5/run, safe-edit with rollback)
- Phase D: Diary digest + release lock

Existing contradiction handling: Phase B step 1 — when ingesting new info, LLM checks if it contradicts existing memory, newer-info supersedes. NO cross-file scan between existing files.

Existing memory file frontmatter:
```yaml
---
name: <slug>
description: <one-line>
type: user|project|reference|feedback
---
```

## Reference: Codex algorithm for contradiction detection

**Cheap candidate generation FIRST** (don't blindly LLM-judge all pairs):
- Same `type` filter
- Overlapping entities (filename tokens, title words, frontmatter tags)
- Normalized predicate phrases: `prefers`, `uses`, `hates`, `requires`, `do not`
- Negation/opposition markers: `not`, `never`, `avoid`, `instead`, changed values

Only candidate bundles → LLM judgment. With 40 files, false positives are the cost concern, not compute.

**Auto-resolve hierarchy:**
1. Direct diary/session evidence beats inferred
2. Else higher confidence wins if `Δ confidence >= 0.2`
3. Else flag — do not edit

(An earlier draft included a "newer evidence-date wins" leg; it was dropped during review — see `evidence > confidence` note above.)

**Anti-loop fields** (added per memory file when resolved):
- `resolved_at: <date>`
- `resolution_basis: "<reason with file:line evidence>"`
- `do_not_reopen_before: <date or semantic condition>`

**Time-scoped changes are NOT contradictions** ("used X then, uses Y now" is evolution).

## Tasks

### Task 1: Add feature flag, Phase B.5 lint, frontmatter persistence, and stats file to `memory-consolidation/SKILL.md`

The skill must gain a feature flag at top, a new Phase B.5 (after Phase B, before Phase C) that scans existing memory files for cross-file contradictions, an updated Phase C that persists `confidence` and `revisit_if` in frontmatter, and an updated Phase D that writes a "Pending Review" section to workspace `MEMORY.md` and appends a structured line to `memory/lint-stats.jsonl`. Diary entries gain a parseable prefix.

What we want:

- **Feature flag** at the top of SKILL.md (before "Context"):
  ```markdown
  ## Feature Flags
  
  - `LINT_PHASE_B5_ENABLED=true` — Trial: 2026-05-17 → 2026-06-17. When false, skip Phase B.5 entirely. Rollback = flip to false (no data migration). See ADR-069.
  ```
  When false, the skill executes Phases 0/A/B/C/D as before, no lint, no Pending Review writes, no stats file appends.

- **Phase B.5 inserted between Phase B and Phase C.** Steps:
  1. Iterate `memory/auto/*.md` and build a lightweight in-memory representation: `{file, type, name, tags, title_tokens, claim_phrases}` extracted from frontmatter and body. Claim extraction uses bullet/paragraph splits.
  2. Candidate generation: for each pair of files, only proceed if at least two of these match — same `type` field, overlapping `title_tokens`, overlapping `tags`, or matching normalized predicate ("prefers", "uses", "hates", "requires", "do not"). Files with `do_not_reopen_before` later than today are skipped entirely.
  3. For each candidate pair, ask the LLM (in-skill prompt) one question: "Do these two claims contradict, or is one time-scoped evolution of the other?" Return: `contradiction` | `evolution` | `unrelated`. Only `contradiction` proceeds.
  4. For each detected contradiction, attempt auto-resolve using hierarchy: (a) direct diary/session evidence in last 48h wins over inferred; (b) higher confidence wins if delta >= 0.2; (c) otherwise flag for review.
  5. Auto-resolved: edit the losing file to either remove the contradicting claim or mark it superseded. **Never silent-delete** — always replace with a `(superseded: ...)` annotation. Add `resolved_at`, `resolution_basis`, `do_not_reopen_before` to BOTH files' frontmatter (anti-loop).
  6. Flagged unresolved: add an entry to a `pending_review` accumulator (used in Phase D).
  7. Respect mutation limit from Phase C (5 per run total across B.5 and C combined).

- **Phase C** must now persist `confidence` (existing 0.0-1.0 float from Phase B scoring) and `revisit_if` (semantic trigger string, free-text — see ADR-style examples) in the frontmatter when creating or updating files. Update the frontmatter format documentation block in SKILL.md accordingly:
  ```yaml
  ---
  name: topic-slug
  description: One-line description
  type: user|project|reference|feedback
  confidence: 0.9                          # 0.0-1.0, matches Phase B scoring
  revisit_if: "Ninja decides to move"      # semantic trigger, like ADR Revisit-if; "Never" valid
  # Optional, added when resolved by Phase B.5:
  # resolved_at: 2026-05-18
  # resolution_basis: "diary 2026-05-15 §3 explicit user statement"
  # do_not_reopen_before: 2026-08-18
  ---
  ```

- **Phase D** must:
  1. Update workspace `MEMORY.md` with a `## Pending Review (Lint findings)` section listing unresolved items, one bullet per item with file references and reason. If accumulator is empty, the section must be ABSENT from MEMORY.md (do not leave an empty heading). When resolving an item, the corresponding bullet is removed; when the last bullet is removed, the section itself is removed.
  2. Append one structured JSON line to `memory/lint-stats.jsonl`:
     ```json
     {"date":"YYYY-MM-DD","candidates_found":N,"contradictions_detected":N,"auto_resolved":N,"pending_added":N,"pending_total":N,"avg_age_days":N}
     ```
  3. Diary entry format gains a parseable prefix: `## [YYYY-MM-DD HH:MM] consolidation | <topic-summary>`. This allows `grep "^## \[" memory/diary/*.md | tail -10` to retrieve a recent-activity log. Apply forward-only — do not rewrite existing diary entries.
  4. Continue to follow "Silent operation: never send messages to any chat" (unchanged — no push notifications).

- **`memory/lint-stats.jsonl` creation**: file is created on first run if absent; subsequent runs append. Format is strict JSON-per-line, parseable by Python's `json.loads` per line.

- All existing safety mechanisms preserved: lock checks, mutation limit, safe-edit with rollback, never modify CLAUDE.md/USER.md/IDENTITY.md.

- [x] `.claude/skills/memory-consolidation/SKILL.md` contains `LINT_PHASE_B5_ENABLED` feature flag at the top
- [x] SKILL.md contains a `### Phase B.5` section between Phase B and Phase C
- [x] Phase B.5 documents candidate generation, LLM judgment, auto-resolve hierarchy (`evidence > confidence`), and anti-loop fields
- [x] Phase B.5 explicitly excludes time-scoped changes from being treated as contradictions
- [x] Phase B.5 documents "never silent-delete" — losing claim is replaced with `(superseded: ...)` annotation
- [x] Phase C frontmatter format documented in SKILL.md now includes `confidence` and `revisit_if` fields (with `resolved_at`, `resolution_basis`, `do_not_reopen_before` as optional)
- [x] Phase D documents the workspace `MEMORY.md` "Pending Review" section format and its add/remove rules
- [x] Phase D documents `memory/lint-stats.jsonl` format with one JSON line per run
- [x] Phase D diary format documented to use `## [YYYY-MM-DD HH:MM] consolidation | ...` parseable prefix
- [x] Phase D notes the parseable-prefix change is forward-only (existing diary entries unchanged)
- [x] "Silent operation" line in SKILL.md is unchanged (no push notifications added)
- [x] Existing safety lines preserved: lock-check, mutation-limit, safe-edit, "Never modify CLAUDE.md, USER.md, or IDENTITY.md"

### Task 2: Add "Surfacing pending lint items" section to `.claude/rules/platform/memory-protocol.md`

The platform memory-protocol rule must gain a new section requiring the agent to proactively surface pending lint items during conversation. Without this rule, the agent has no behavioral reason to mention them — and the user has stated explicitly they will not proactively ask.

What we want:

- New section `## Surfacing pending lint items` added to `.claude/rules/platform/memory-protocol.md`, placed coherently within existing structure (after "Auto-load mechanism" if present, otherwise after the initial storage-locations section).
- Section explains: when workspace `MEMORY.md` contains a `## Pending Review (Lint findings)` section, the agent MUST proactively surface items in the current conversation.
- Section gives the surfacing strategy in concrete rules:
  - **Preferred trigger**: when the conversation's topic relates to a pending item, bring it up inline as part of the relevant answer ("Кстати, есть unresolved contradiction про X — ..."). Topic-related = the agent's natural assessment, not a strict keyword match.
  - **Aged escalation**: if a pending item is older than 14 days AND no topic-relevant opportunity has arisen, surface it at a natural pause or task end.
  - **One per session max**: never dump multiple items in one message. Pick the most relevant or oldest.
  - **Never interrupt urgency**: if the user is mid-urgent-task, do not derail — wait for natural break.
  - **After resolution**: update the contradicting memory file(s) with the resolved value, then remove the bullet from the MEMORY.md "Pending Review" section in the same operation. Add `resolved_at` / `resolution_basis` / `do_not_reopen_before` per the consolidation skill's pattern.
- Section references ADR-069 and beads `workspace-txyu` for trial context.

- [x] `.claude/rules/platform/memory-protocol.md` contains a section titled `## Surfacing pending lint items`
- [x] Section explicitly states "MUST" requirement to proactively surface
- [x] Section lists at least: preferred trigger (topic-related), aged escalation (>14 days), one-per-session max, no-interrupt-urgency, after-resolution actions
- [x] Section references ADR-069 for context
- [x] No existing content in `memory-protocol.md` is removed or contradicted (additive change)
