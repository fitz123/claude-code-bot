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

**Gated by `LINT_PHASE_B5_ENABLED`.** During the 2026-05-17 → 2026-06-17 trial window the flag defaults to **enabled**: an unset env var is treated as `true`, and only an explicit `LINT_PHASE_B5_ENABLED=false` skips this entire phase. After 2026-06-17 the default flips back to disabled (unset = skip). This is the rollback path — flip to false (no data migration) to abort the trial early. Skipped runs MUST NOT write to `memory/lint-stats.jsonl` or touch the workspace `MEMORY.md` "Pending Review" section.

Cross-file scan of existing `memory/auto/*.md` files for contradictions that the per-fact Phase B check cannot catch (Phase B only compares new vs existing, not existing vs existing).

Initialize accumulators: `candidates_found = 0`, `contradictions_detected = 0`, `auto_resolved = 0`, `pending_added = 0`, `pending_review = []`, `pending_resolved = []`. Also initialize `mutations_applied = 0` here — this counter is **shared with Phase C** (do not re-zero on entry to Phase C). `pending_resolved` accumulates `{files:[A,B], reason: canonical_reason}` records for pairs that this run auto-resolved (used by Phase D step 2 to clear any pre-existing MEMORY.md "Pending Review" bullet for the same contradiction so stale flags do not accumulate across runs).

1. **Build lightweight representation.** Iterate `memory/auto/*.md` and for each file extract: `{file, type, name, tags, title_tokens, body_predicates, negation_markers, do_not_reopen}`. Source the fields from frontmatter (`type`, `name`, optional `tags`, the anti-loop list). `do_not_reopen` is read as a YAML list of records, each with `partner` (filename) and `before` (YYYY-MM-DD date) — if the field is absent treat as empty list. Normalize each `partner` to its bare filename (apply `basename`, strip any directory prefix) and dedupe by `partner` (if duplicate entries exist for the same partner, keep the one with the latest `before` — never shorten an existing pair's cooldown). Tokenize the `name` slug and the first body heading (or the `description` frontmatter field if no heading exists, else just the `name` slug tokens) into `title_tokens`. Skip stop words (`a, an, the, of, for, with, and, or, to, in, on`) and tokens of length < 3. Also scan the file body (everything after the closing `---` of the frontmatter) for two sets used by step 2's signals: `body_predicates` = the subset of `{prefers, uses, hates, requires}` that appear as case-insensitive whole-word matches (single-token only — negation-style phrases like "do not"/"don't" are covered by `negation_markers`); `negation_markers` = the subset of `{not, never, avoid, instead}` that appear as case-insensitive whole-word matches. The two sets are disjoint by construction so a single shared word cannot satisfy both signals in step 2. Both sets are empty if no match is found.

2. **Cheap candidate generation FIRST** — do not blindly LLM-judge all `O(n^2)` pairs. For each unordered pair `(A, B)`, count matches across these signals:
   - same `type` field
   - overlapping `title_tokens` (≥ 1 shared token, ignoring stop words)
   - overlapping `tags` (≥ 1 shared tag, if present)
   - non-empty intersection of `body_predicates` between the two files (from the set extracted in step 1)
   - non-empty intersection of `negation_markers` between the two files (from the set extracted in step 1)
   
   A pair is a **candidate** only if at least two of the above signals match. Each signal contributes at most 1 to the match count regardless of how many tokens/tags overlap. Increment `candidates_found` for each candidate pair. With ~40 files, false positives are the primary concern; this filter keeps LLM calls bounded.

   **Per-pair exclusion (anti-loop).** Skip the pair entirely if EITHER file's `do_not_reopen` list contains an entry whose `partner` matches the other file's bare name AND that entry's `before` date is later than today. Exclusion is genuinely per-pair: each partner has its own `before` date stored in its own record, so resolving A↔C cannot extend A↔B's cooldown. If the matching entry's `before` is absent or fails the `^\d{4}-\d{2}-\d{2}$` regex (malformed or legacy prior write), treat the exclusion as inactive for that specific pair and let the pair proceed to judgment — anti-loop requires a well-formed date. Only YYYY-MM-DD dates are recognized; the spec does not support semantic-condition values like `"Ninja revisits topic X"`, since the skill has no mechanism to auto-detect such events (use a far-future date if indefinite suppression is genuinely needed).

3. **LLM judgment per candidate.** For each candidate pair, first establish canonical ordering: sort the two files by basename so that A's basename is lexicographically less than B's basename, and present them to the LLM in that order. This ensures `claim_a` / `claim_b` map deterministically to the lex-smaller / lex-larger file regardless of pair iteration order — without this, dedup keys produced by step 4c can differ between runs when filesystem enumeration flips the order. Then ask one in-skill question: "Do these two claims contradict each other, or is one a time-scoped evolution of the other?" The LLM must return a structured response: `{verdict, claim_a, claim_b}` where `verdict` is `contradiction` | `evolution` | `unrelated`, and `claim_a` / `claim_b` are the single full body lines (verbatim, including leading bullet/heading markers if any) from each file that carry the contradicting claim — with `claim_a` belonging to canonical-A (lex-smaller basename) and `claim_b` belonging to canonical-B. The `claim_a` / `claim_b` strings are used as exact match anchors in step 5; if either is empty or does not appear verbatim in the corresponding file body, downgrade the verdict to `unrelated` and log the mismatch in the Phase D diary Issues section. Only `contradiction` proceeds to step 4. **Time-scoped changes are NOT contradictions** — a fact like "used X then, uses Y now" is evolution, not contradiction. On malformed LLM output or transient error, treat as `unrelated` and log the failure in the Phase D diary Issues section. Increment `contradictions_detected` for each `contradiction` verdict.

4. **Auto-resolve hierarchy** (apply in order, stop at first match): the rule is `evidence > confidence`. A "recency" tie-breaker was considered but dropped: `resolved_at` reflects a file's unrelated prior resolution history, not the freshness of the currently contradicting claim, so it is not a valid freshness proxy. Direct freshness evidence is already handled by (a).

   **Compute `canonical_reason` FIRST (applies to every contradiction, regardless of resolution path).** Before evaluating a–c below, derive the deterministic `reason` string from the LLM's `claim_a` and `claim_b` strings returned in step 3 — NOT from any free-form LLM summary, which would be reworded between runs and break dedup. Step 3's canonical-ordering rule (lex-smaller basename = canonical-A) guarantees `claim_a` / `claim_b` map to the same files across runs, so the composed string is order-invariant. Composition: for each claim, strip any leading bullet/heading markers (`-`, `*`, `#`, plus a single following space) and surrounding whitespace, collapse internal runs of whitespace to a single space, then truncate to 80 characters at a UTF-8 codepoint boundary (count codepoints, never split a multi-byte sequence mid-character — invalid UTF-8 written to MEMORY.md will break downstream `json.loads`-per-line stats parsing), with no trailing whitespace. Compose as the literal string `<sanitized_claim_a> | <sanitized_claim_b>` (single ASCII pipe with spaces). Then apply the standard `reason` sanitization documented in Phase D step 2 (single line, strip leading `#`, collapse newlines to `; `, replace em-dashes `—` with hyphen-space `- `, truncate to 200 chars — again at a UTF-8 codepoint boundary). The resulting string is `canonical_reason`. It is the dedup key shared by ALL routes that flag this contradiction (4c plus the deferral routes in steps 5 and 6) AND by the resolution-removal path (step 5 successful auto-resolves append `{files, reason: canonical_reason}` to `pending_resolved` so Phase D can clear any pre-existing MEMORY.md bullet for this same contradiction). Because identity is the file pair plus the underlying claim lines, all routes use the SAME `canonical_reason` — deferral causes (verify failure, anchor invalidation, mutation-limit) are forensic metadata logged in the Phase D diary Issues section, NOT embedded in the bullet's `reason` field. Embedding cause text would split one contradiction's bullets across multiple variants and defeat dedup; it would also prevent a later run from removing the same contradiction's stale bullet when it succeeds in auto-resolving.

   a. **Direct evidence wins over inferred.** If exactly one side of the pair has a direct diary or session reference (file:line or session timestamp citation in the last 48 hours' diary entries), that side wins.
   b. **Higher confidence wins** if both sides have a `confidence` field and `|confidence_A − confidence_B| >= 0.2`. If either side lacks `confidence` (legacy files predating the schema), treat it as `0.7` for this comparison only.
   c. **Otherwise flag for review** — do NOT edit either file. Append an entry to `pending_review` using the canonical shape `{files:[A,B], reason: canonical_reason, detected_at:<today YYYY-MM-DD>}`. This is the ONLY in-phase append for the unresolved path; do NOT increment a separate `pending_added` counter here — Phase D step 2 computes the final post-dedup value from the actual bullets written. The same `{files, reason: canonical_reason, detected_at:<today>}` shape is reused by the deferral routes in steps 5 and 6 below, so Phase D's parser regex matches every entry uniformly and dedup correctly merges a future 4c finding with an earlier deferral for the same contradiction.

5. **Apply auto-resolved edits.** For each auto-resolved pair:
   - **Edits MUST use `safe-edit.sh` with paired two-phase commit semantics.** Each resolved pair touches two `memory/auto/*.md` files (A and B); they must succeed or fail together. The flow is: (i) `backup` BOTH files first; (ii) apply the annotation + frontmatter edits to BOTH files; (iii) run `verify` on BOTH files; (iv) ONLY if both verifies succeed, `clean` both backups. If `verify` fails on either file, `rollback` BOTH files from their backups and route the pair to `pending_review` using `{files:[A,B], reason: canonical_reason, detected_at:<today>}` — the SAME `canonical_reason` computed in step 4, so a future run's 4c finding for this contradiction dedup-merges into the existing bullet. Log the deferral cause `"edit verify failed (file=<which>, error=<short>)"` in the Phase D diary Issues section; do NOT embed the cause in the bullet's `reason` field. Never `clean` one backup before the other has verified — otherwise a partial mutation can leave file A annotated while file B is untouched, breaking the symmetric anti-loop guarantee.
   - **Re-verify anchor before each file's edit.** A prior pair within the same run may have already annotated the same line. Immediately before applying the annotation (after `backup` but before mutating the file), re-read the target file's current body and confirm the relevant `claim_a` / `claim_b` string still appears verbatim. If the exact match no longer holds, abort this pair, rollback both files from their backups, and route the pair to `pending_review` using `{files:[A,B], reason: canonical_reason, detected_at:<today>}`. Log the deferral cause `"anchor invalidated by prior edit (file=<which>)"` in the Phase D diary Issues section; do NOT embed the cause in the bullet's `reason` field.
   - **Never silent-delete.** Locate the losing claim line by exact-match against the `claim_a` / `claim_b` string returned in step 3 (whichever side lost the auto-resolve in step 4). Append ` (superseded YYYY-MM-DD: <one-line reason citing the winner>)` to that line — do NOT delete the original text. If the line appears more than once verbatim in the body, annotate only the first occurrence and log the duplicate in the Phase D diary Issues section. The annotation lives as a trailing parenthetical on the same line so audit history is preserved.
   - Add anti-loop fields to BOTH files' frontmatter. `do_not_reopen` is a **list of records** keyed by `partner` — locate the existing entry for this pair's partner (if any) and apply `MAX(existing.before, new_value)` to its `before` field; NEVER shorten this pair's cooldown. If no entry exists for this partner, APPEND a new `{partner, before}` record. Other files' entries (for unrelated partners) are untouched — resolving A↔C must not extend A↔B's cooldown. `resolved_at` and `resolution_basis` are scalars and reflect the most recent resolution across all of this file's pairs. **Default `new_value` for `before`: `today + 90 days`** (same default as the interactive resolution path in `.claude/rules/platform/memory-protocol.md`, so nightly and manual cooldowns match). Use a far-future date (e.g., year 2099) if indefinite suppression is genuinely required; the field is always a YYYY-MM-DD date.
     ```yaml
     resolved_at: YYYY-MM-DD
     resolution_basis: "<single-line reason, max 200 chars, no embedded newlines or unescaped quotes>"
     do_not_reopen:                    # accumulating list — one record per resolved pair
       - partner: <other-file-name>    # filename only, no path
         before: YYYY-MM-DD            # always a date; other partners' dates are untouched
     ```
     `resolution_basis` MUST be sanitized: single line, max 200 chars, replace embedded newlines with `; `, strip leading `#`, double-quote and escape `"` as `\"` and `\` as `\\`. `before` values are always date-form (matching `^\d{4}-\d{2}-\d{2}$`) and written unquoted as YAML dates — semantic-condition values are not supported (the skill has no auto-trigger for them; use a far-future date if indefinite suppression is required).
   - Increment `auto_resolved` by 1 per resolved pair. Increment `mutations_applied` by 2 per resolved pair — one per file edit, matching Phase C's "each file modification counts as one mutation" rule so the shared 5-per-run budget is counted consistently across phases. Append `{files:[A,B], reason: canonical_reason}` to `pending_resolved` so Phase D step 2 can remove any pre-existing MEMORY.md "Pending Review" bullet for this same contradiction (idempotent — a no-op if no matching bullet exists). **Timing:** all three (increments + `pending_resolved` append) fire ONLY after both files' `verify` calls succeed and both backups have been cleaned. A pair that fails verify and is rolled back does NOT consume the budget and is NOT appended to `pending_resolved` (the increments are not applied) — the remaining budget is preserved for subsequent pairs in the same run, and the failed pair instead lands in `pending_review` per the verify-failure bullet above.

6. **Mutation limit is shared with Phase C.** The shared per-run budget is 5 mutations counted on `mutations_applied`. Before starting an auto-resolve pair, verify `mutations_applied + 2 <= 5` (a pair consumes 2). If the remaining budget cannot fit a full pair, stop applying further auto-resolves; remaining detections go to `pending_review` using `{files:[A,B], reason: canonical_reason, detected_at:<today>}` — the SAME `canonical_reason` so dedup correctly merges with any earlier or later finding for this contradiction. Log the deferral cause `"mutation limit reached"` in the Phase D diary Issues section; do NOT embed the cause in the bullet's `reason` field.

7. **Carry accumulators into Phase D.** Pass `candidates_found`, `contradictions_detected`, `auto_resolved`, `pending_added`, `pending_review`, and `pending_resolved` to Phase D for stats, Pending Review adds, and stale-bullet removals.

**Lock refresh:** Before continuing, refresh the lock:
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/lock.sh" refresh "${CLAUDE_PROJECT_DIR}/.consolidation.lock" "<token>"
```
If refresh returns `STOLEN`, another run has reclaimed the lock — abort the pipeline immediately and output NO_REPLY.

### Phase C: Apply Changes

**Mutation limit: 5 per run, shared with Phase B.5.** Each file creation or modification counts as one mutation. Phase B.5 may have already consumed part of this budget — do NOT re-initialize `mutations_applied` here. If `mutations_applied >= 5` on entry to Phase C, skip Phase C mutations entirely and proceed to Phase D.
If any mutation fails, stop further mutations immediately (stop-on-failure).

Track: `mutations_failed = 0` (continue using `mutations_applied` from Phase B.5; if Phase B.5 was skipped via the feature flag, initialize `mutations_applied = 0` here).

For each approved change (confidence >= 0.9), in priority order (updates before creates):

1. **Before any MEMORY.md edit:**
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/safe-edit.sh" backup "${CLAUDE_PROJECT_DIR}/MEMORY.md"
   ```

2. **Apply the edit** — update existing `memory/auto/` file, create new one, or update `MEMORY.md` index.

   For `memory/auto/` files, use this base frontmatter format on every create or update. Persist `confidence` and `revisit_if` on every write. Do NOT include the optional Phase B.5 fields unless they actually apply (do not copy commented-out lines from the template into new files).
   ```yaml
   ---
   name: topic-slug
   description: One-line description used for relevance matching in future sessions
   type: user|project|reference|feedback
   confidence: 0.9
   revisit_if: "Ninja decides to move"
   ---

   Body content here. For feedback/project types, include **Why:** and **How to apply:** sections.
   ```

   When Phase B.5 resolves a contradiction touching this file, additionally write `resolved_at`, `resolution_basis`, and the `do_not_reopen` list (one `{partner, before}` record per resolved pair) — see Phase B.5 step 5 for the exact YAML and sanitization rules. These fields are absent from files that have never participated in a resolved contradiction.

   `revisit_if` is free-text and must be a single line. Useful phrasings: a concrete user-action trigger ("Ninja switches editors"), a date ("after 2026-09-01"), or `"Never"` for facts that are stable by nature (e.g. timezone). Apply the same sanitization as `resolution_basis` (max 200 chars, no embedded newlines, no leading `#`, double-quote and escape `"` as `\"` and `\` as `\\`). If Phase B's scoring did not yield a semantic trigger, default to `"Never"`. `confidence` mirrors the Phase B scoring rubric (1.0 / 0.9 / 0.7 / 0.5 / discarded below 0.5). The `revisit_if` field is written for human/agent inspection during interactive sessions; this skill does not read it back.

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

Phase D substeps do NOT execute in literal numerical order. The diary (step 1) is written LAST among steps 1–3 so it can summarize the actual outcomes of steps 2 and 3 — including their issues — in a single write (the spec does NOT support amending an already-written diary section). Step 3 is also split: its compute-and-validate work runs early (to surface any issues), and the actual JSONL append runs after the diary. Execution order:

  1. **Step 2** (MEMORY.md "Pending Review" edit) — applies `pending_resolved` removals first, then dedup-appends `pending_review` adds in a single MEMORY.md mutation, finalizes `pending_added`; may surface a `SUSPICIOUS_SHRINK` rollback issue.
  2. **Step 3 compute-and-validate** — compute `pending_total` and `avg_age_days` from the post-step-2 MEMORY.md, compose the JSONL line, validate it via `jq -e`. This sub-step MAY surface issues to the Issues collector: malformed bullets whose `detected_at` fails to parse (counted with age 0; logged), or a candidate JSON line that fails `jq` validation (NOT appended; logged). Do NOT perform the actual `>>` append yet — defer it to after the diary.
  3. **Step 1** (diary) — write diary using the finalized `pending_added` AND the full Issues set collected in (1) and (2).
  4. **Step 3 append** — perform the actual `printf '%s\n' "$LINE" >> memory/lint-stats.jsonl`, only if (2)'s `jq` validation passed.
  5. **Step 4** (release lock).
  6. **Step 5** (NO_REPLY).

Two adjustments can lower `pending_added` relative to the count carried out of Phase B.5: (i) the dedup pass MAY remove items already present in MEMORY.md, and (ii) if step 2's edit fails `verify` and rolls back (excluding the documented `SUSPICIOUS_SHRINK` bypass), NO bullets were persisted and `pending_added` MUST be reset to 0. If a rollback occurs, the diary's "Lint" line MUST report `pending added: 0` and the Issues section MUST note the rollback; step 3's stats line MUST also use the rolled-back value. Never write a diary line claiming new bullets when MEMORY.md was not actually modified.

1. **Write diary entry** to `memory/diary/YYYY-MM-DD.md` (using today's date).

   The diary is a narrative digest — write it as if reflecting on the day's conversations.
   Include:
   - What conversations happened (brief topic summary, no raw transcripts)
   - What was learned or confirmed
   - What memory changes were made (and why)
   - Items noted for manual curation (confidence 0.5–0.9)
   - Lint findings from Phase B.5: candidates considered, contradictions detected, auto-resolves applied, items deferred to Pending Review (omit this bullet when `LINT_PHASE_B5_ENABLED=false`, since the accumulators were never populated)
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

   ### Lint (Phase B.5)              # omit this entire block when LINT_PHASE_B5_ENABLED=false
   - Candidates: N, contradictions: N, auto-resolved: N, pending added: N, pending removed: N    # `pending removed` = count of stale MEMORY.md bullets cleared this run by `pending_resolved` (Phase D step 2). Forensic deferral causes (verify failure, anchor invalidation, mutation-limit) are logged in the Issues section below.

   ### Noted for Review
   - [confidence 0.7] Possible insight — context

   ### Issues
   - Any errors encountered during processing
   ```

2. **Update workspace `MEMORY.md` "Pending Review" section.** Gated by `LINT_PHASE_B5_ENABLED`; skip if false. This step applies BOTH the nightly-auto-resolve removals (`pending_resolved` from Phase B.5 step 5) AND the new-flag adds (`pending_review`) in a single MEMORY.md mutation — removals first, then adds, so dedup decisions in the add pass see the post-removal state.
   - **Process `pending_resolved` removals FIRST (nightly auto-resolve cleanup).** For each `{files, reason}` record in `pending_resolved`, find and remove the bullet whose triple `(file-A, file-B, reason)` matches per the removal rule below. This prevents stale flags from accumulating: a contradiction previously surfaced in `MEMORY.md` and auto-resolved in a later nightly run no longer inflates `pending_total` / `avg_age_days`. Removal is idempotent — a no-op if no matching bullet exists (e.g., the auto-resolve happened on the same run the contradiction was first detected).
   - **Then process `pending_review` adds.** If the accumulator is non-empty, ensure `MEMORY.md` contains a section titled exactly `## Pending Review (Lint findings)`. Each unresolved item is one bullet in this strict, machine-parseable format (parser regex `^- detected_at=\d{4}-\d{2}-\d{2} `): `- detected_at=YYYY-MM-DD — file-A vs file-B — <single-line reason, max 200 chars>`. Sanitize `<reason>` the same way as `resolution_basis` (strip leading `#`, collapse newlines to `; `, truncate to 200 chars) AND additionally replace any em-dash characters (`—`, U+2014) in the reason with a hyphen-space (`- `) so the bullet's three-field structure can be split unambiguously on the literal ` — ` separator. New bullets MUST use `canonical_reason` from Phase B.5 step 4 as the `reason` field — deferral causes (verify failure, anchor invalidation, mutation-limit) are forensic and belong in the diary Issues section, NOT in the bullet.
   - Before appending a new bullet, deduplicate on the triple `(file-A, file-B, reason)` (unordered file pair, exact reason after sanitization): if an existing bullet matches all three fields, do NOT append again. Two genuinely distinct contradictions between the same pair (different reasons) produce two separate bullets — do not collapse them. Update `pending_added` to count only newly written bullets.
   - If `pending_review` is empty AND no prior unresolved bullets remain in the section (after removals), the section MUST be absent from `MEMORY.md` — do NOT leave an empty heading.
   - **Removal rule (used by both the nightly `pending_resolved` path above AND interactive resolutions).** Remove ONLY the bullet whose triple `(file-A, file-B, reason)` matches the specific contradiction being resolved — the same triple used as the dedup key when the bullet was written. The match key is the bullet's literal `reason` field (the third dash-separated segment, sanitized as on write), NOT the frontmatter `resolution_basis` field which is a separate human-readable summary. The unordered file pair `(file-A, file-B)` must match (order-insensitive) and the sanitized `reason` text must match exactly. If the same pair has multiple unresolved bullets with different reasons, leave the non-matching bullets in place — they represent distinct unresolved contradictions. When the last bullet in the section is removed, the section heading itself is removed in the same edit. Match the section by its exact title `## Pending Review (Lint findings)` and remove only between that heading and the next `## ` heading or EOF — do not touch unrelated occurrences of the string.
   - This edit uses the standard `safe-edit.sh backup / verify / rollback / clean` flow, with one allowance: when the edit's only effect is removing Pending Review bullets and/or the section heading, `safe-edit.sh verify` may legitimately return `SUSPICIOUS_SHRINK` (the section can be a large fraction of a small `MEMORY.md`). In that specific case, accept the result if (a) the post-edit file still contains the `# Memory Index` heading AND (b) the byte-size of the Pending Review section measured against `MEMORY.md` **before** the edit is applied (from the `## Pending Review (Lint findings)` heading line through the byte immediately preceding the next `## ` heading or EOF) equals `pre_edit_size - post_edit_size` ± 5 bytes. The runner MUST capture both the section bytes and the pre-edit total byte size BEFORE issuing the edit (the pre-edit state is identical to what `safe-edit.sh backup` copies to `${FILEPATH}.consolidation-backup`); do not measure live during/after the write. Otherwise rollback as usual. Document the bypass in the diary Issues section so the audit trail is preserved.

3. **Append a line to `memory/lint-stats.jsonl`.** Gated by `LINT_PHASE_B5_ENABLED`; skip if false. The file is created on first run if absent. Format is one strict JSON object per line, parseable by Python `json.loads` per line. Each angle-bracketed placeholder below is substituted with the actual value (`<integer>` becomes a literal integer like `7`, `<number>` becomes a float like `4.5`):
   ```json
   {"date":"<YYYY-MM-DD>","candidates_found":<integer>,"contradictions_detected":<integer>,"auto_resolved":<integer>,"pending_added":<integer>,"pending_total":<integer>,"avg_age_days":<number>}
   ```
   - Before appending, validate the candidate line with `printf '%s' "$LINE" | jq -e . > /dev/null` — if validation fails, do NOT append; log the malformed line in the diary Issues section instead.
   - Append the validated line with a trailing newline so the file remains parseable as one JSON object per line — e.g., `printf '%s\n' "$LINE" >> memory/lint-stats.jsonl`. Never use `printf '%s'` (no newline) when writing; that produces a single concatenated line and breaks `json.loads`-per-line.
   - `pending_total` counts bullets in `MEMORY.md`'s "Pending Review (Lint findings)" section matching the regex `^- detected_at=\d{4}-\d{2}-\d{2} ` between the section heading and the next `## ` heading (or EOF), measured after this run's writes.
   - `avg_age_days` is the mean age in days of all current pending bullets, computed as `mean(today − detected_at)` where `today` is the same YYYY-MM-DD used in this run's `date` field, and `detected_at` is parsed from each bullet via the regex above. Round to one decimal place. If `pending_total == 0`, write `0`. If any bullet's `detected_at` fails to parse, count it with age `0` and log the malformed bullet in the diary Issues section.
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
