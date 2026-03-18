# Add memory-consolidation skill to platform — Round 1

## Goal

Add a memory-consolidation skill that runs as a nightly cron and crystallizes session transcripts into organized persistent memory. Without automated consolidation, workspaces silently lose institutional knowledge: facts from conversations vanish between sessions, MEMORY.md goes stale, and the agent forgets what happened yesterday. GitHub issue #19.

## Validation Commands

```bash
cd ~/src/claude-code-bot

# SKILL.md exists and is well-formed
test -f .claude/skills/memory-consolidation/SKILL.md && echo "PASS" || echo "FAIL: no SKILL.md"

# Helper scripts exist and are executable
find .claude/skills/memory-consolidation/scripts/ -name "*.sh" -executable | head -5
test -d .claude/skills/memory-consolidation/scripts/ && echo "PASS: scripts dir exists" || echo "FAIL: no scripts dir"

# Scripts accept workspace path and run without error
for script in .claude/skills/memory-consolidation/scripts/*.sh; do
  echo "--- $(basename "$script") ---"
  bash "$script" "$(pwd)" 2>&1 | head -3
done

# No hardcoded user-specific paths
grep -r '/Users/' .claude/skills/memory-consolidation/ && echo "FAIL" || echo "PASS: no hardcoded paths"

# SKILL.md uses portable script paths
grep 'CLAUDE_SKILL_DIR' .claude/skills/memory-consolidation/SKILL.md | head -3

# memory-protocol updated
grep 'diary' .claude/optional-rules/memory-protocol.md | head -3

# setup.sh handles skill scripts and diary directory
grep -q 'skills' setup.sh && echo "PASS" || echo "FAIL: setup.sh missing skills"
grep -q 'diary' setup.sh && echo "PASS" || echo "FAIL: setup.sh missing diary"

# crons.yaml.example has consolidation cron
grep -A3 'memory-consolidation' bot/crons.yaml.example

# .gitignore covers consolidation state
grep 'consolidation' .gitignore

# Run tests
cd bot && npm test
```

## Reference: Claude Code session JSONL format

Session transcripts are stored at `~/.claude/projects/<workspace-path-dashed>/*.jsonl`. The workspace path is converted by replacing `/` with `-` and prefixing with `-` (e.g., `/Users/ninja/.minime/workspace` → `-Users-ninja--minime-workspace`).

Each JSONL file = one session. First line is always `type: "queue-operation"` with the initial prompt in `content`:

```json
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-03-14T14:09:41.509Z","sessionId":"1e3c5432...","content":"[Chat: Minime HQ | From: No†Buddy (@notbuddy)]\nhey"}
```

Human messages have `type: "user"` with `message.role: "user"`:
```json
{"type":"user","message":{"role":"user","content":"[Chat: Minime HQ | From: No†Buddy (@notbuddy)]\nhey"},"timestamp":"2026-03-14T14:09:41.528Z","userType":"external","sessionId":"1e3c5432..."}
```

Assistant messages have `type: "assistant"` at top level and contain `message.role: "assistant"`:
```json
{"type":"assistant","message":{"model":"claude-opus-4-6","role":"assistant","content":[{"type":"text","text":"🏄‍♂️"}]},"timestamp":"..."}
```

**Human session identification:** First line's `content` field starts with `[Chat:` for bot-originated human conversations. Cron/automated sessions start with other patterns (e.g., `IMPORTANT:`, `External code review`, `Second code review pass`, `Code review of:`).

**Key fields for extraction:** `type`, `message.role`, `message.content`, `timestamp`, `sessionId`.

## Reference: Public repo current structure

```
.claude/
├── hooks/          (4 scripts: auto-stage, inject-message, session-end-commit, session-start-recovery)
├── rules/
│   ├── platform/   (2 rules: safety, no-nested-cli)
│   ├── custom/     (.gitkeep — user rules go here, gitignored)
├── optional-rules/ (4 opt-in rules: async-long-tasks, communication, memory-protocol, task-tracking)
├── settings.json   (hooks config, uses $CLAUDE_PROJECT_DIR)
└── settings.local.json.example
setup.sh            (chmod hooks, create dirs, offer optional rules)
bot/crons.yaml.example (has backup-git and weekly-health stubs)
memory/             (.gitkeep only — gitignored contents)
MEMORY.md           (empty template: "Curated index of memory files in memory/")
.gitignore          (gitignores: memory/*, reference/, .claude/rules/custom/*, etc.)
```

No `.claude/skills/` directory exists on main yet. The workspace-health skill (PR pending) will be the first; memory-consolidation will be the second.

## Reference: Claude Code skill discovery

From Claude Code documentation: skills are discovered at `.claude/skills/<skill-name>/SKILL.md` — one level deep only. The `${CLAUDE_SKILL_DIR}` variable resolves to the directory containing SKILL.md at runtime, enabling portable references to co-located scripts. This is the same mechanism used by the workspace-health skill on the `workspace-health-platform` branch (verified: `grep 'CLAUDE_SKILL_DIR' .claude/skills/workspace-health/SKILL.md` returns multiple hits on that branch).

## Reference: memory-protocol optional rule (current)

`.claude/optional-rules/memory-protocol.md` (20 lines):
```markdown
<!-- Optional rule: copy to .claude/rules/custom/ to activate -->
# Memory Protocol

## Why Memory Matters
Claude Code sessions are stateless — each conversation starts fresh...

## Structure
- **Long-term index:** `MEMORY.md` — curated index of memory files in `memory/`
- **Memory files:** `memory/*.md` — individual notes on topics worth remembering across sessions
- **Daily notes (optional):** `memory/daily/YYYY-MM-DD.md` — consolidation digests

## Guidelines
- Write memories for anything that should survive across sessions...
- Keep `MEMORY.md` concise — it's an index, not a journal.
- Review and prune stale memories periodically.
- Don't duplicate what's already in code, git history, or documentation.
```

Currently references `memory/daily/` — the platform convention is `memory/diary/`.

## Reference: Memory file format (memory/auto/)

Individual memory files use YAML frontmatter with `name`, `description`, `type` fields:

```markdown
---
name: coffee-shop-investment
description: Инвестиция в кофейню — 3М₽, 50% доля, 1-я Советская ул. 7, СПб
type: project
---

Ninja инвестировал 3 000 000 ₽ в кофейню (50% доля). Договор подписан 13.03.2026.
...
```

Types: `user`, `project`, `reference`, `feedback`. The `description` field is used to decide relevance in future conversations. Body contains the full content, often with `**Why:**` and `**How to apply:**` sections for feedback/project types.

MEMORY.md is an index pointing to these files:
```markdown
# Memory Index
Curated index of memory files in `memory/`.
<!-- Add entries as: - [topic](memory/filename.md) — brief description -->
```

## Reference: Private implementation structure (source material)

The private workspace has a 731-line SKILL.md at `~/.minime/workspace/.claude/skills/memory-consolidation/SKILL.md` with 5 profile YAML files. The skill needs to be decomposed — core pipeline becomes the platform skill, task/reminder integrations become separate private skills.

### Pipeline phases in the private implementation

- **Phase 0: Validate** — check workspace, memory file, lock, cross-skill mutex
- **Phase A: Gather** — read session JSONL files, read current MEMORY.md, read task systems, read git log
- **Phase B: Diff** — compare extracted facts against current memory state, assign confidence scores
- **Phase C: Fix** — apply safe-edits to MEMORY.md and memory files (backup/verify/rollback), create diary entry
- **Phase D: Report & Cleanup** — write diary digest, release locks, update state

### What the platform skill keeps (generic)

- Session JSONL discovery and parsing (auto-derive path from workspace)
- Human session filtering (`[Chat:` prefix detection)
- Fact extraction with confidence scoring
- MEMORY.md safe-edit with backup/verify/rollback
- memory/auto/ file creation/updates with frontmatter
- memory/diary/ creation (narrative digest)
- Atomic locking (mkdir-based with stale TTL)
- Cross-skill mutex (.maintenance.lock)
- Mutation limits (default 5 per run)
- Coverage-based permission gradation (full/truncated/error)

### What the platform skill drops (workspace-specific)

- Profile system (5 YAML files with per-agent config)
- Task systems (beads, task_index, reminders) — out of scope
- Memory markers (managed sections for specific agents)
- Preflight scripts (custom Python per-agent)
- Watermark/incremental model — replaced by 48h window
- Fast-path heuristics (task stale check, git clean check)
- Repo sync (git pull) — workspace-health handles this
- Legacy session fallback (sessions_history API)

## Reference: .gitignore current state

```
# Workspace user data
memory/*
!memory/.gitkeep
.claude/settings.local.json
.claude/rules/custom/*
!.claude/rules/custom/.gitkeep
reference/
```

The `memory/*` gitignore with `!memory/.gitkeep` exception means all memory content (auto/, diary/, state files) is already gitignored. No new gitignore entries needed for memory subdirectories — only for consolidation state files that live outside memory/.

## Reference: setup.sh current state

`setup.sh` (89 lines) handles: jq check, chmod hooks, npm install, create memory/ dir, create rules/custom/ dir, offer optional rules activation, remind to edit USER.md/IDENTITY.md. The workspace-health branch adds chmod for skill scripts. Memory-consolidation needs setup.sh to also create `memory/auto/` and `memory/diary/` subdirectories.

## Tasks

### Task 1: Create SKILL.md and helper scripts (#19, P1)

The public repo has no memory-consolidation skill. The SKILL.md orchestration document and supporting scripts need to be created from scratch, based on the private 731-line implementation but stripped of all workspace-specific features (profiles, tasks, reminders, markers, watermarks).

The private implementation uses profiles to configure per-agent behavior. The platform version uses zero-config auto-discovery instead — session path derived from workspace path, all defaults work out of the box.

The private implementation uses watermark-based incremental processing. The platform version uses a simple 48h window (today + yesterday sessions) every run — no state tracking needed for session processing.

The private implementation's Phase A reads task systems (beads, reminders, task_index). The platform version reads only sessions and memory — task management is out of scope.

Philosophy: consolidation is sleep for the agent — absorption and crystallization of information, not mechanical fact transfer. The skill should understand what new information means in context of existing memory, update stale entries, resolve contradictions, and produce diary entries as narrative digests.

What we want:
- A SKILL.md and supporting scripts that work on any fresh workspace clone without configuration
- Recent human sessions (today + yesterday, 48h window) are discovered and processed automatically — no watermarks or state tracking for session processing
- Only human conversations are processed; cron/automated sessions are excluded
- Only high-confidence facts (>= 0.9) trigger automatic memory edits; lower-confidence items noted in diary for manual curation
- Memory edits are safe: failures don't leave MEMORY.md or memory files in a broken state
- Runaway mutations are bounded (default 5 per run), and any mutation failure stops further edits
- Partial failures degrade gracefully — if session reading fails, the skill still writes a diary entry noting the failure
- Concurrent runs are prevented, with stale-lock recovery so a crashed run doesn't permanently block future runs
- workspace-health's `.maintenance.lock` is respected (cross-skill mutex)
- Diary entries are narrative digests of what was learned and what changed — not raw fact dumps
- CLAUDE.md, USER.md, and IDENTITY.md are never modified
- Silent operation — never sends messages to any chat, always NO_REPLY for cron context

- [x] SKILL.md exists at `.claude/skills/memory-consolidation/SKILL.md` with complete pipeline documentation
- [x] Recent human sessions (48h window) are discovered from any workspace path without configuration
- [x] Cron/automated sessions are correctly filtered out (only `[Chat:` prefixed sessions processed)
- [x] Concurrent runs are prevented with stale-lock recovery
- [x] workspace-health's `.maintenance.lock` is respected before acquiring consolidation lock
- [x] No hardcoded user-specific paths anywhere in skill files
- [x] Script references are portable and resolve correctly from any workspace clone
- [x] MEMORY.md edits are safe: backup before changes, verify after (file non-empty, size reasonable), rollback on failure
- [x] memory/auto/ files use correct frontmatter format (name, description, type)
- [x] memory/diary/ entries are narrative digests, not raw fact lists
- [x] Mutation limit enforced (default 5, stop-on-failure)
- [x] Partial failures degrade gracefully (diary-only on read errors, append-only on partial data)
- [x] Skill does not reference task systems (beads, reminders, task_index)
- [x] Skill does not reference profiles or memory markers
- [x] All scripts run without error on the public repo workspace (`bash script.sh "$(pwd)"`)
- [x] Add tests for helper scripts
- [x] Verify existing tests pass

### Task 2: Update platform integration (#19, P2)

The setup.sh, crons.yaml.example, .gitignore, and memory-protocol optional rule need updates to support the new skill. Without these, a fresh workspace clone won't have the right directory structure, won't know how to schedule the cron, and the memory-protocol rule still references the old `memory/daily/` path.

What we want:
- `setup.sh` creates `memory/auto/` and `memory/diary/` subdirectories during workspace setup
- `setup.sh` makes skill scripts executable (if workspace-health branch isn't merged yet, add this; if already present, verify it covers the new skill)
- `crons.yaml.example` has a `memory-consolidation` cron entry with appropriate schedule (nightly, e.g., 2:00 AM) and adequate timeout for AI processing
- `.gitignore` covers `.consolidation.lock` and `.consolidation-state.json` if they appear at workspace root (note: if they're under `memory/`, they're already covered by `memory/*`)
- `memory-protocol.md` optional rule references `memory/diary/` instead of `memory/daily/`
- `setup.sh` runs without error on a fresh clone

- [ ] `setup.sh` creates `memory/auto/` and `memory/diary/` directories
- [ ] Skill scripts in `.claude/skills/*/scripts/` are made executable by `setup.sh`
- [ ] `crons.yaml.example` has `memory-consolidation` entry with nightly schedule and adequate timeout
- [ ] `.gitignore` covers consolidation lock and state files
- [ ] `memory-protocol.md` optional rule references `memory/diary/` (not `memory/daily/`)
- [ ] `bash setup.sh` runs without error on a fresh clone
- [ ] Add tests verifying setup.sh creates memory subdirectories and crons.yaml.example parses correctly
- [ ] Verify existing tests pass
