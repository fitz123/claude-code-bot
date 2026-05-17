# Memory Consolidation

<description>Nightly skill that crystallizes recent human conversation sessions into organized persistent memory. Reads session transcripts from the last 48 hours, extracts noteworthy facts, updates MEMORY.md and memory/auto/ files, and writes a narrative diary digest to memory/diary/.</description>

## Feature Flags

- `LINT_PHASE_B5_ENABLED=true` — Trial: 2026-05-17 → 2026-06-17. When false, skip Phase B.5 entirely. Rollback = flip to false (no data migration). See ADR-069.

When the flag is false, the skill executes Phases 0/A/B/C/D as before — no cross-file lint, no Pending Review writes to MEMORY.md, no appends to `memory/lint-stats.jsonl`. Phase C still applies the new frontmatter fields (`confidence`, `revisit_if`) when creating or updating files, since those are forward-compatible regardless of the lint pass.

## Context

This skill runs as a nightly cron. It is the agent's equivalent of sleep — a time for absorption and crystallization of information, not mechanical fact transfer. The goal is to understand what new information means in the context of existing memory, update stale entries, resolve contradictions, and produce diary entries as narrative digests.

Silent operation: never send messages to any chat. Always respond with NO_REPLY when invoked by cron.

## Prerequisites

- `jq` must be installed (used by helper scripts to parse JSONL)
- `memory/`, `memory/auto/`, and `memory/diary/` directories must exist
- `MEMORY.md` must exist at workspace root

## Pipeline

Execute phases in order. If any phase fails fatally, skip to Phase D (Report) to record what happened.

### Phase 0: Validate

1. Check cross-skill mutex:
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/lock.sh" check-maintenance "${CLAUDE_PROJECT_DIR}"
   ```
   If `.maintenance.lock` exists, output NO_REPLY and exit — another skill is running.

2. Acquire consolidation lock:
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/lock.sh" acquire "${CLAUDE_PROJECT_DIR}/.consolidation.lock" 60
   ```
   If lock acquisition fails (another consolidation in progress), output NO_REPLY and exit.
   The output format is `ACQUIRED <token>` — capture the token and pass it to all subsequent `refresh` and `release` calls to prove ownership.
   The `60` is the stale TTL in minutes — locks older than this are considered abandoned and reclaimed.
   Between phases, refresh the lock to prevent stale reclaim during long runs (see Phase transitions below).

3. Verify directories exist: `memory/`, `memory/auto/`, `memory/diary/`.
   Create any missing directories silently.

4. Verify `MEMORY.md` exists at workspace root. If missing, create a minimal template:
   ```markdown
   # Memory Index

   Curated index of memory files in `memory/`.

   <!-- Add entries as: - [topic](memory/filename.md) — brief description -->
   ```

### Phase A: Gather

1. Discover recent human sessions:
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/discover-sessions.sh" "${CLAUDE_PROJECT_DIR}"
   ```
   Returns a newline-separated list of JSONL file paths — only human sessions from the last 48 hours.
   An empty list is not an error — it means no human conversations happened recently.

2. Read current memory state:
   - Read `MEMORY.md`
   - Read all files in `memory/auto/` (if any exist)
   - Note the current state for comparison in Phase B.

3. For each session file, extract key information:
   - Read the JSONL file and focus on `type: "user"` and `type: "assistant"` messages
   - Extract: decisions made, preferences stated, facts learned, corrections given, project context
   - Note the session timestamp and identifiable conversation topic

4. If session reading fails for any file, note the error and continue with remaining files.
   Partial data is better than no data.

**Lock refresh:** Before continuing, refresh the lock to reset the TTL clock:
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/lock.sh" refresh "${CLAUDE_PROJECT_DIR}/.consolidation.lock" "<token>"
```
If refresh returns `STOLEN`, another run has reclaimed the lock — abort the pipeline immediately and output NO_REPLY.

### Phase B: Diff & Score

Compare extracted information against current memory state:

1. For each extracted fact or insight:
   - Check if already captured in existing memory files
   - Check if it contradicts existing memory (newer info likely supersedes)
   - Check if it updates or enriches an existing memory entry
   - Assign a confidence score (0.0 to 1.0):
     - **1.0**: User explicitly stated a fact or preference
     - **0.9**: Clear implication from conversation context
     - **0.7**: Reasonable inference, but could be situational
     - **0.5**: Weak signal, might not generalize
     - **Below 0.5**: Too uncertain to act on

2. Classify each item:
   - **update**: Modifies an existing memory file (new info supersedes old)
   - **create**: New memory file needed (topic not yet captured)
   - **skip**: Already captured or too low confidence

3. Only items with confidence >= 0.9 are applied automatically.
   Items with 0.5 <= confidence < 0.9 are noted in the diary for manual curation.
   Items below 0.5 are discarded.

**Lock refresh:** Before continuing, refresh the lock:
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/lock.sh" refresh "${CLAUDE_PROJECT_DIR}/.consolidation.lock" "<token>"
```
If refresh returns `STOLEN`, another run has reclaimed the lock — abort the pipeline immediately and output NO_REPLY.

### Phase B.5: Cross-file Lint (contradiction detection)

**Gated by `LINT_PHASE_B5_ENABLED`.** If the feature flag is false (env var unset or `false`), skip this entire phase and proceed directly to Phase C. Skipped runs MUST NOT write to `memory/lint-stats.jsonl` or touch the workspace `MEMORY.md` "Pending Review" section.

Cross-file scan of existing `memory/auto/*.md` files for contradictions that the per-fact Phase B check cannot catch (Phase B only compares new vs existing, not existing vs existing).

Initialize accumulators: `candidates_found = 0`, `contradictions_detected = 0`, `auto_resolved = 0`, `pending_added = 0`, `pending_review = []`.

1. **Build lightweight representation.** Iterate `memory/auto/*.md` and for each file extract: `{file, type, name, tags, title_tokens, claim_phrases}`. Source the fields from frontmatter (`type`, `name`, optional `tags`) and the body. Tokenize the `name` slug and the first heading into `title_tokens`. Split the body on bullet boundaries and paragraph breaks to populate `claim_phrases`. Files whose frontmatter contains `do_not_reopen_before` later than today are excluded from the scan entirely.

2. **Cheap candidate generation FIRST** — do not blindly LLM-judge all `O(n^2)` pairs. For each unordered pair `(A, B)`, count matches across these signals:
   - same `type` field
   - overlapping `title_tokens` (≥ 1 shared token, ignoring stop words)
   - overlapping `tags` (≥ 1 shared tag, if present)
   - matching normalized predicate phrase in both files: one of `prefers`, `uses`, `hates`, `requires`, `do not`, `never`, `avoid`
   - negation/opposition markers: `not`, `never`, `avoid`, `instead`, or numerically changed value targeting the same entity
   
   A pair is a **candidate** only if at least two of the above signals match. Increment `candidates_found` for each candidate pair. With ~40 files, false positives are the primary concern; this filter keeps LLM calls bounded.

3. **LLM judgment per candidate.** For each candidate pair, ask one in-skill question: "Do these two claims contradict each other, or is one a time-scoped evolution of the other?" Allowed answers: `contradiction` | `evolution` | `unrelated`. Only `contradiction` proceeds to step 4. **Time-scoped changes are NOT contradictions** — a fact like "used X then, uses Y now" is evolution, not contradiction. Increment `contradictions_detected` for each `contradiction` verdict.

4. **Auto-resolve hierarchy** (apply in order, stop at first match): the rule is `evidence > confidence > recency`.
   a. **Direct evidence wins over inferred.** If exactly one side of the pair has a direct diary or session reference (file:line or session timestamp citation in the last 48 hours' diary entries), that side wins.
   b. **Higher confidence wins** if `|confidence_A − confidence_B| >= 0.2`.
   c. **Newer evidence-date wins** if both sides have an `evidence_date` (or frontmatter `updated_at` / `resolved_at`) and the delta is `>= 30 days`.
   d. **Otherwise flag for review** — do NOT edit either file. Append `{files:[A,B], reason, detected_at:YYYY-MM-DD}` to `pending_review` and increment `pending_added`.

5. **Apply auto-resolved edits.** For each auto-resolved pair:
   - **Never silent-delete.** Edit the losing file to replace the contradicting claim with a `(superseded: <one-line reason citing the winner>)` annotation. The losing claim text remains visible as a strikethrough or parenthetical so audit history is preserved.
   - Add anti-loop fields to BOTH files' frontmatter:
     ```yaml
     resolved_at: YYYY-MM-DD
     resolution_basis: "<reason with file:line evidence>"
     do_not_reopen_before: YYYY-MM-DD  # or semantic condition like "Ninja revisits topic X"
     ```
   - Increment `auto_resolved`.

6. **Mutation limit is shared with Phase C.** Phase B.5 edits count against the same per-run budget of 5 mutations. If `mutations_applied >= 5` mid-way through Phase B.5, stop applying further auto-resolves; remaining detections go to `pending_review` as `(deferred: mutation limit reached)`.

7. **Carry accumulators into Phase D.** Pass `candidates_found`, `contradictions_detected`, `auto_resolved`, `pending_added`, and `pending_review` to Phase D for stats and Pending Review writes.

**Lock refresh:** Before continuing, refresh the lock:
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/lock.sh" refresh "${CLAUDE_PROJECT_DIR}/.consolidation.lock" "<token>"
```
If refresh returns `STOLEN`, another run has reclaimed the lock — abort the pipeline immediately and output NO_REPLY.

### Phase C: Apply Changes

**Mutation limit: 5 per run.** Each file creation or modification counts as one mutation.
If any mutation fails, stop further mutations immediately (stop-on-failure).

Track: `mutations_applied = 0`, `mutations_failed = 0`.

For each approved change (confidence >= 0.9), in priority order (updates before creates):

1. **Before any MEMORY.md edit:**
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/safe-edit.sh" backup "${CLAUDE_PROJECT_DIR}/MEMORY.md"
   ```

2. **Apply the edit** — update existing `memory/auto/` file, create new one, or update `MEMORY.md` index.

   For `memory/auto/` files, use this frontmatter format. `confidence` and `revisit_if` are persisted on every create or update; the `resolved_at` / `resolution_basis` / `do_not_reopen_before` trio is optional and only added when Phase B.5 resolves a contradiction touching this file.
   ```yaml
   ---
   name: topic-slug
   description: One-line description used for relevance matching in future sessions
   type: user|project|reference|feedback
   confidence: 0.9                          # 0.0-1.0, matches Phase B scoring
   revisit_if: "Ninja decides to move"      # semantic trigger, like ADR Revisit-if; "Never" valid
   # Optional, added when resolved by Phase B.5:
   # resolved_at: 2026-05-18
   # resolution_basis: "diary 2026-05-15 §3 explicit user statement"
   # do_not_reopen_before: 2026-08-18
   ---

   Body content here. For feedback/project types, include **Why:** and **How to apply:** sections.
   ```

   `revisit_if` is free-text. Useful phrasings: a concrete user-action trigger ("Ninja switches editors"), a date ("after 2026-09-01"), or `"Never"` for facts that are stable by nature (e.g. timezone). `confidence` mirrors the Phase B scoring rubric (1.0 / 0.9 / 0.7 / 0.5 / discarded below 0.5).

3. **After editing MEMORY.md:**
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/safe-edit.sh" verify "${CLAUDE_PROJECT_DIR}/MEMORY.md"
   ```
   If verification fails (file empty, missing, or unreasonably small), rollback:
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/safe-edit.sh" rollback "${CLAUDE_PROJECT_DIR}/MEMORY.md"
   ```

4. After successful edit, clean up the backup:
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/safe-edit.sh" clean "${CLAUDE_PROJECT_DIR}/MEMORY.md"
   ```

5. Increment `mutations_applied`. If `mutations_applied >= 5`, stop applying changes.
   If any mutation fails, increment `mutations_failed` and stop further mutations.

**Critical: Never modify CLAUDE.md, USER.md, or IDENTITY.md.**

**Lock refresh:** Before continuing, refresh the lock:
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/lock.sh" refresh "${CLAUDE_PROJECT_DIR}/.consolidation.lock" "<token>"
```
If refresh returns `STOLEN`, another run has reclaimed the lock — abort the pipeline immediately and output NO_REPLY.

### Phase D: Report & Cleanup

1. **Write diary entry** to `memory/diary/YYYY-MM-DD.md` (using today's date).

   The diary is a narrative digest — write it as if reflecting on the day's conversations.
   Include:
   - What conversations happened (brief topic summary, no raw transcripts)
   - What was learned or confirmed
   - What memory changes were made (and why)
   - Items noted for manual curation (confidence 0.5–0.9)
   - Lint findings from Phase B.5: candidates considered, contradictions detected, auto-resolves applied, items deferred to Pending Review
   - Any errors or partial failures encountered

   If a diary file for today already exists, append a new section with a timestamp header.

   **Parseable prefix.** New diary sections written from now on use this header line so a recent-activity log can be grepped: `## [YYYY-MM-DD HH:MM] consolidation | <one-line topic summary>`. A consumer can run `grep "^## \[" memory/diary/*.md | tail -10` to see recent consolidations at a glance. **This change is forward-only** — do not rewrite existing diary headers; only newly written sections use the parseable prefix.

   Format:
   ```markdown
   # Diary — YYYY-MM-DD

   ## [YYYY-MM-DD HH:MM] consolidation | <topic-summary>

   ### Sessions Reviewed
   - [topic]: brief description of what was discussed

   ### Memory Changes
   - Created/Updated memory/auto/filename.md — reason

   ### Lint (Phase B.5)
   - Candidates: N, contradictions: N, auto-resolved: N, pending added: N

   ### Noted for Review
   - [confidence 0.7] Possible insight — context

   ### Issues
   - Any errors encountered during processing
   ```

2. **Update workspace `MEMORY.md` "Pending Review" section.** Gated by `LINT_PHASE_B5_ENABLED`; skip if false.
   - If the `pending_review` accumulator is non-empty, ensure `MEMORY.md` contains a section titled exactly `## Pending Review (Lint findings)`. Each unresolved item is one bullet: `- <date> — file-A vs file-B — <reason>`.
   - If `pending_review` is empty AND no prior unresolved bullets remain in the section, the section MUST be absent from `MEMORY.md` — do NOT leave an empty heading.
   - When the agent or a future run resolves a pending item, the corresponding bullet is removed; when the last bullet is removed, the section heading itself is removed in the same edit.
   - This edit uses the standard `safe-edit.sh backup / verify / rollback / clean` flow.

3. **Append a line to `memory/lint-stats.jsonl`.** Gated by `LINT_PHASE_B5_ENABLED`; skip if false. The file is created on first run if absent. Format is one strict JSON object per line, parseable by Python `json.loads` per line:
   ```json
   {"date":"YYYY-MM-DD","candidates_found":N,"contradictions_detected":N,"auto_resolved":N,"pending_added":N,"pending_total":N,"avg_age_days":N}
   ```
   - `pending_total` is the total bullet count remaining in `MEMORY.md`'s "Pending Review" section after this run's writes.
   - `avg_age_days` is the mean age in days of all current pending bullets (use `detected_at` for the age basis); if `pending_total == 0`, write `0`.
   - Append-only — never rewrite earlier lines.

4. **Release consolidation lock:**
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/lock.sh" release "${CLAUDE_PROJECT_DIR}/.consolidation.lock" "<token>"
   ```

5. **Output NO_REPLY** — this skill runs silently, never sends messages to chat.

## Error Handling

- **No sessions found:** Not an error. Write a brief diary noting "no recent human sessions" and exit cleanly.
- **Session read failure:** Log the error, continue with other sessions. Diary notes which sessions failed.
- **Memory edit failure:** Rollback the failed edit, stop further mutations, record in diary.
- **Lock acquisition failure:** Exit immediately with NO_REPLY (another run is in progress).
- **Maintenance lock present:** Exit immediately with NO_REPLY (another skill is running).
- **Lock stolen (STOLEN on refresh/release):** Another run reclaimed the lock because TTL was exceeded. Abort immediately with NO_REPLY — do not write diary or release lock.

## What This Skill Does NOT Do

- Modify CLAUDE.md, USER.md, or IDENTITY.md
- Process automated/cron sessions (only human conversations via `[Chat:` prefix)
- Manage tasks, reminders, or beads
- Send messages to any chat
- Pull or push git changes
- Use profiles or per-agent configuration
