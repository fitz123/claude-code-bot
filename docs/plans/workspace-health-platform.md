# Add workspace-health skill to platform — Round 1

## Goal

Add a workspace-health skill that keeps Claude Code workspaces clean and consistent through automated checks. The user interacts via messaging app — they never see the workspace directly. Without automated monitoring, workspaces silently degrade: junk files accumulate, content duplicates across files, settings drift from conventions, platform files diverge from upstream. GitHub issue #17.

## Validation Commands

```bash
cd ~/src/claude-code-bot

# All scripts accept workspace path and run without error
bash .claude/skills/workspace-health/scripts/size-audit.sh "$(pwd)" 2>&1 | head -5
bash .claude/skills/workspace-health/scripts/config-check.sh "$(pwd)" 2>&1 | head -5
bash .claude/skills/workspace-health/scripts/hook-integrity.sh "$(pwd)" 2>&1 | head -5
bash .claude/skills/workspace-health/scripts/orphan-scan.sh "$(pwd)" 2>&1 | head -5
bash .claude/skills/workspace-health/scripts/cleanup.sh --workspace "$(pwd)" 2>&1 | head -5
bash .claude/skills/workspace-health/scripts/platform-check.sh "$(pwd)" 2>&1 | head -5

# No hardcoded user-specific paths
grep -r '/Users/' .claude/skills/workspace-health/ && echo "FAIL" || echo "PASS: no hardcoded paths"

# No ADR-NNN references (workspace-specific)
grep -rn 'ADR-[0-9]' .claude/skills/workspace-health/ && echo "FAIL" || echo "PASS: no ADR numbers"

# Orphan allowlist has only platform-generic entries
grep -E '^(bot|config\.yaml|crons\.yaml|monitoring|data|archive|assets|\.beads|\.minime|\.playwright-mcp|\.consolidation-state|\.maintenance\.lock|templates|reference|scripts|skills)' .claude/skills/workspace-health/scripts/orphan-allowlist.txt && echo "FAIL: workspace-specific entries" || echo "PASS"

# Platform-check.sh exists and is executable
test -x .claude/skills/workspace-health/scripts/platform-check.sh && echo "PASS" || echo "FAIL"

# ADR governance files exist
test -f reference/governance/decisions.md.example && echo "PASS" || echo "FAIL: no ADR template"
test -f .claude/rules/platform/adr-governance.md && echo "PASS" || echo "FAIL: no ADR rule"

# SKILL.md uses portable script paths
grep 'CLAUDE_SKILL_DIR' .claude/skills/workspace-health/SKILL.md | head -3

# setup.sh handles skill scripts
grep -q 'skills' setup.sh && echo "PASS" || echo "FAIL: setup.sh missing skills"

# crons.yaml.example has health cron
grep -A3 'workspace-health' bot/crons.yaml.example
```

## Reference: Current private workspace skill (source material)

The skill currently exists only in a private workspace. The public repo has no `.claude/skills/` directory at all. The skill needs to be created from scratch in the public repo, based on the private implementation but genericized.

### Current scripts and their issues

**size-audit.sh** — hardcodes a multi-workspace array:
```bash
# Lines 11-14: only works for one specific machine
WORKSPACES=(
    "/Users/user/.minime/workspace"
    "/Users/user/.minime/workspace-coder"
)
```
Currently requires the multi-workspace array to function. The python3 logic iterates over WORKSPACES via colon-delimited env var.

**cleanup.sh** — hardcodes two workspace paths:
```bash
# Lines 37-39: only works for one specific machine
MAIN_WORKSPACE="/Users/user/.minime/workspace"
CODER_WORKSPACE="/Users/user/.minime/workspace-coder"
# Lines 44-47: auto-adds coder workspace if it exists
```
Already supports `--workspace` flag but falls back to hardcoded paths when no flag given.

**hook-integrity.sh, config-check.sh, orphan-scan.sh** — each has a hardcoded default:
```bash
WORKSPACE="${1:-/Users/user/.minime/workspace}"
```
Each defaults to a hardcoded path when no argument given.

**config-check.sh** — three additional problems:
1. Line 123: `MEMORY_MD="$WORKSPACE/memory/auto/MEMORY.md"` — this path doesn't exist even in the current workspace. MEMORY.md is at workspace root in both private workspace and public repo template. This is a real bug that causes the check to always fail.
2. Line 178: `ALLOWED_ROOT_MD=("CLAUDE.md" "USER.md" "IDENTITY.md")` — missing `"MEMORY.md"`. After fixing the MEMORY.md path to root, the root-markdown check would flag MEMORY.md as "stray".
3. Lines 45, 105, 121, 176: ADR-numbered section headers (ADR-045, ADR-050, ADR-052, ADR-049) — meaningless outside the private workspace.
4. Lines 56-59: Missing `settings.local.json` is treated as a FAIL. On a fresh workspace, only `.example` exists — the check would always fail on fresh clones.

**orphan-scan.sh** — allowlist mixes platform and private entries. Current `orphan-allowlist.txt` (42 lines) includes private workspace dirs like `bot`, `config.yaml`, `monitoring`, `.beads`, `.minime`, `.playwright-mcp`, `archive`, `assets`, etc. These would be false positives in any fresh workspace.

### Current SKILL.md structure

231 lines. Contains 7 occurrences of the hardcoded workspace path. Uses absolute script paths. References specific ADR numbers. Has 8 parts (A-H):
- A: Size audit (script) — universal
- B: Hook integrity (script) — universal
- C: Config check (script) — universal but has ADR references
- D: Orphan scan (script) — universal
- E: Fact verification (AI) — partially universal, references private files
- F: Content quality (AI) — partially universal, references private ADRs
- G: CC docs compliance (AI) — fully universal
- H: ADR compliance review (AI) — fully workspace-specific, must be dropped

SKILL.md uses absolute paths like `/Users/user/.minime/workspace/.claude/skills/workspace-health/scripts/size-audit.sh`. Claude Code provides `${CLAUDE_SKILL_DIR}` variable that resolves to the skill directory — scripts should use this instead.

### Public repo current structure

```
.claude/
├── hooks/          (4 scripts: auto-stage, inject-message, session-end-commit, session-start-recovery)
├── rules/
│   ├── platform/   (3 rules: safety, show-files, no-nested-cli)
│   ├── custom/     (.gitkeep — user rules go here, gitignored)
│   (no non-nested rule files)
├── optional-rules/ (4 opt-in rules)
├── settings.json   (hooks config, uses $CLAUDE_PROJECT_DIR)
└── settings.local.json.example
setup.sh            (chmod hooks, create dirs, offer optional rules)
bot/crons.yaml.example (has weekly-health stub with generic prompt)
.gitignore          (gitignores: rules/custom/*, crons.yaml, bot data)
```

No `.claude/skills/` directory exists. This is the first platform skill.

### Claude Code skill discovery

From docs: skills are discovered at `.claude/skills/<skill-name>/SKILL.md` — one level deep only. Nested `skills/platform/<name>/` would NOT auto-load. The skill must be at `.claude/skills/workspace-health/SKILL.md` flat.

`${CLAUDE_SKILL_DIR}` variable resolves to the directory containing SKILL.md at runtime.

### Orphan allowlist current state

Current `orphan-allowlist.txt` has ~41 lines mixing platform entries with ~20 workspace-specific entries. There is no mechanism for user extensions — only one flat file.

### .gitignore current state

Line 21: `reference/` gitignores the entire `reference/` directory. Any tracked template file placed under `reference/` (like `decisions.md.example`) requires a negation rule (`!reference/governance/decisions.md.example`) to be committed.

## Tasks

### Task 1: Create genericized health check scripts (#17, P1)

The public repo has no workspace-health skill. Six bash scripts need to be created based on the private implementation, but with all hardcoded paths removed, single-workspace-only operation, and descriptive check names instead of ADR numbers.

Problems in the current private scripts:
- `size-audit.sh` hardcodes a `WORKSPACES` array — only works on one machine
- `cleanup.sh` hardcodes `MAIN_WORKSPACE` and `CODER_WORKSPACE` paths
- Three scripts (`hook-integrity.sh`, `config-check.sh`, `orphan-scan.sh`) default to a hardcoded path
- `config-check.sh` checks `memory/auto/MEMORY.md` which doesn't exist — MEMORY.md is at workspace root (confirmed: exists at root in both private workspace and public repo)
- `config-check.sh` doesn't include `MEMORY.md` in `ALLOWED_ROOT_MD` — would flag it as stray after fixing the path
- `config-check.sh` uses ADR-numbered section headers meaningless outside the private workspace
- `orphan-allowlist.txt` mixes platform entries with ~20 private workspace entries
- No `orphan-allowlist.local.txt` mechanism for user extensions

What we want:
- All 6 scripts created in `.claude/skills/workspace-health/scripts/`
- Each accepts a workspace path argument and defaults to current directory — works anywhere
- `size-audit.sh` audits the given workspace without requiring configuration of other workspaces
- `cleanup.sh` cleans only the given workspace — does not discover or modify other workspaces
- `config-check.sh` checks `$WORKSPACE/MEMORY.md` (root), includes `MEMORY.md` in allowed root markdown, uses descriptive section names instead of ADR numbers
- `config-check.sh` handles missing `settings.local.json` gracefully (warn/skip, not fail) — fresh workspaces only have the `.example` file
- `orphan-allowlist.txt` contains only platform-generic entries (files that exist in any fresh workspace from the template)
- Users can add workspace-specific entries to the orphan allowlist without modifying platform-tracked files
- All scripts run cleanly on a fresh clone of the public repo

- [x] All 6 scripts accept a workspace path argument and default to current directory — no hardcoded paths anywhere
- [x] `size-audit.sh` audits the given workspace without requiring configuration of other workspaces
- [x] `cleanup.sh` cleans only the given workspace — does not discover or modify other workspaces
- [x] `config-check.sh` checks `$WORKSPACE/MEMORY.md` (root), not `memory/auto/MEMORY.md`
- [x] `config-check.sh` includes `MEMORY.md` in allowed root markdown files
- [x] `config-check.sh` section headers are descriptive, no ADR numbers
- [x] `config-check.sh` handles missing `settings.local.json` gracefully (warn/skip, not fail)
- [x] `orphan-allowlist.txt` contains only platform-generic entries (no bot, config.yaml, monitoring, .beads, etc.)
- [x] Users can add workspace-specific orphan allowlist entries without modifying platform-tracked files
- [x] `orphan-allowlist.local.txt` is gitignored
- [x] All scripts run without error on the public repo workspace (`bash script.sh "$(pwd)"`)
- [x] Script header comments reflect updated usage (workspace path argument, no hardcoded defaults)
- [x] Add tests for each script
- [x] Verify existing tests pass

### Task 2: Create platform-check.sh and SKILL.md (#17, P1)

No mechanism exists to detect when platform files (hooks, rules/platform/) have drifted from upstream. And SKILL.md — the orchestration doc that ties all scripts together — doesn't exist in the public repo.

SKILL.md in the private workspace has 7 hardcoded absolute paths, references specific ADR numbers, and includes a workspace-specific ADR compliance stage (Part H) that has no meaning outside the private workspace.

What we want:
- `platform-check.sh` compares platform files against upstream remote. If workspace is a git repo with `upstream` remote: fetch and diff. Otherwise: skip gracefully. Report-only, always exits 0.
- `SKILL.md` has no hardcoded absolute paths — script paths are portable across any workspace
- AI stages E (Fact Verification) + F (Content Quality) + G (CC Docs Compliance) included with graceful degradation — skip checks when referenced files don't exist
- Part H (ADR Compliance Review) dropped entirely — workspace-specific, no place in platform
- Platform consistency check added as a new stage
- Report format: bullet list (Telegram-compatible), no "ADR compliance" line, includes "Platform check" line
- Git operations (fetch, pull, commit) skip gracefully for non-git workspaces

- [x] `platform-check.sh` compares `.claude/hooks/*.sh`, `.claude/rules/platform/*.md`, `.claude/settings.json` against upstream
- [x] `platform-check.sh` handles non-git workspaces gracefully (skips with message)
- [x] `platform-check.sh` handles `git fetch upstream` failures gracefully (exit 0 with message)
- [x] `SKILL.md` has no hardcoded absolute paths — script paths are portable across any workspace
- [x] `SKILL.md` has no ADR number references
- [x] `SKILL.md` does not contain Part H (ADR Compliance Review)
- [x] `SKILL.md` includes platform consistency check as a stage
- [x] AI stages E, F, G skip gracefully when referenced files don't exist
- [x] Part E references only files present in a fresh clone of the public repo — no private-workspace-specific paths
- [x] Report format includes "Platform check" line, no "ADR compliance" line
- [x] Git sync and commit steps skip for non-git workspaces
- [x] SKILL.md documents all stages and their expected output format
- [x] Add tests
- [x] Verify existing tests pass

### Task 3: Add ADR governance template and platform rule (#17, P2)

Architectural decisions happen in conversation and are never recorded. The agent re-evaluates the same choices because there's no log. Without a decision record, there's no way to know what was already decided and why — leading to contradictory changes and wasted effort.

The private workspace has a full decision log (`reference/governance/decisions.md`) and an enforcement rule. The public repo has neither — no template, no structure, no discipline around decision tracking.

What we want:
- ADR template (`decisions.md.example`) that users copy to initialize their own decision log
- Platform rule that enforces discipline: agent checks the decision log before proposing architectural changes, proposes recording new decisions during conversation, never creates ADRs without user confirmation
- `setup.sh` offers ADR initialization during first-run (same UX pattern as optional rules activation)
- User owns their decisions.md after init — platform doesn't touch it. The file is gitignored so upstream updates don't overwrite user decisions.
- The `.example` template must be tracked in git despite `reference/` being gitignored (see Reference: .gitignore current state)

- [x] `reference/governance/decisions.md.example` exists with ADR template (format: ID, title, status, date, context, decision, consequences)
- [x] `reference/governance/decisions.md.example` is tracked in git despite `reference/` being gitignored (negation rule in `.gitignore`)
- [x] `.claude/rules/platform/adr-governance.md` enforces decision log checking before changes and recording new decisions
- [x] `setup.sh` offers optional ADR init (creates dir, copies template)
- [x] `reference/governance/decisions.md` is gitignored (user content — already covered by `reference/` pattern)
- [x] ADR governance rule auto-loads as platform rule
- [x] Add tests
- [x] Verify existing tests pass

### Task 4: Update setup.sh, .gitignore, and crons.yaml.example (#17, P2)

The public repo's setup.sh doesn't know about skill scripts (only handles hooks). The crons.yaml.example has a generic health cron stub that doesn't reference the actual skill. The .gitignore is missing entries for new gitignored files.

What we want:
- `setup.sh` makes skill scripts executable alongside hooks
- `crons.yaml.example` has a workspace-health cron entry that references the skill with adequate timeout for AI stages
- `.gitignore` covers `orphan-allowlist.local.txt` and `reference/governance/decisions.md`
- All new files are properly integrated with existing setup flow

- [x] Skill scripts in `.claude/skills/*/scripts/` are made executable by `setup.sh`
- [x] `crons.yaml.example` has `workspace-health` entry with skill reference and adequate timeout for AI stages
- [x] `.gitignore` includes `orphan-allowlist.local.txt` pattern
- [x] Template files under `reference/` (e.g., `decisions.md.example`) are committed and tracked in git
- [x] `bash setup.sh` runs without error on a fresh clone
- [x] Add tests
- [x] Verify existing tests pass
