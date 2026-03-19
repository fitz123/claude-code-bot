# Memory Consolidation

<description>Nightly skill that crystallizes recent human conversation sessions into organized persistent memory. Reads session transcripts from the last 48 hours, extracts noteworthy facts, updates MEMORY.md and memory/auto/ files, and writes a narrative diary digest to memory/diary/.</description>

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

   For `memory/auto/` files, use this frontmatter format:
   ```markdown
   ---
   name: topic-slug
   description: One-line description used for relevance matching in future sessions
   type: user|project|reference|feedback
   ---

   Body content here. For feedback/project types, include **Why:** and **How to apply:** sections.
   ```

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
   - Any errors or partial failures encountered

   If a diary file for today already exists, append a new section with a timestamp header.

   Format:
   ```markdown
   # Diary — YYYY-MM-DD

   ## Consolidation at HH:MM

   ### Sessions Reviewed
   - [topic]: brief description of what was discussed

   ### Memory Changes
   - Created/Updated memory/auto/filename.md — reason

   ### Noted for Review
   - [confidence 0.7] Possible insight — context

   ### Issues
   - Any errors encountered during processing
   ```

2. **Release consolidation lock:**
   ```bash
   bash "${CLAUDE_SKILL_DIR}/scripts/lock.sh" release "${CLAUDE_PROJECT_DIR}/.consolidation.lock" "<token>"
   ```

3. **Output NO_REPLY** — this skill runs silently, never sends messages to chat.

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
