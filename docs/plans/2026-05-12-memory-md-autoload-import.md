# MEMORY.md auto-load via @-import (CC autoMemoryDirectory bug workaround)

## Goal

Apply the upstream-recommended workaround for [anthropics/claude-code#34146](https://github.com/anthropics/claude-code/issues/34146) (where `autoMemoryDirectory` setting does NOT control system-prompt MEMORY.md injection) to the public template + document the workaround in memory-protocol rules + health-check script + README.

Without this, workspace `MEMORY.md` exists on disk but never enters the agent's initial context. Adding `@MEMORY.md` to `CLAUDE.md` causes CC to inline MEMORY.md content via the @-import mechanism — CLAUDE.md instructions take priority over the system prompt's hardcoded default path.

Verified working with sub-agent probe 2026-05-12: fresh agent context contained workspace MEMORY.md content (4/4 correct verbatim quotes from MEMORY.md, 0 tool calls).

## Validation Commands

```bash
grep -q '^@MEMORY\.md$' CLAUDE.md && \
grep -q '## Auto-load mechanism' .claude/rules/platform/memory-protocol.md && \
grep -q '## Auto-load mechanism' .claude/optional-rules/memory-protocol.md && \
grep -q '@MEMORY' .claude/skills/workspace-health/scripts/config-check.sh && \
grep -qi 'memory architecture' README.md && \
bash .claude/skills/workspace-health/tests/test-scripts.sh && \
echo "All checks passed"
```

## Reference: Why this is needed

[anthropics/claude-code#34146](https://github.com/anthropics/claude-code/issues/34146) reports that `autoMemoryDirectory` setting is documented to redirect auto-memory location, but in practice only affects *writes*. System-prompt injection of MEMORY.md content always uses the default project-encoded path `~/.claude/projects/<encoded>/memory/MEMORY.md`, regardless of the setting.

Issue [#36636](https://github.com/anthropics/claude-code/issues/36636) (closed as duplicate) explicitly documents the workaround:

> "Add an explicit override in project CLAUDE.md to force the model to use the correct path, since CLAUDE.md instructions take priority over the system prompt."

The implementation: a line containing exactly `@MEMORY.md` in `CLAUDE.md` causes CC to inline workspace MEMORY.md content into the agent's initial context.

## Reference: Current template state

- `CLAUDE.md` has @-imports for `USER.md` and `IDENTITY.md`, but not `MEMORY.md`.
- `.gitattributes` already declares `MEMORY.md merge=ours` (line 6) — preserved on upstream merges to keep workspace MEMORY.md customized.
- `.claude/rules/platform/memory-protocol.md` and `.claude/optional-rules/memory-protocol.md` describe memory structure but not the auto-load mechanism.
- `.claude/skills/workspace-health/scripts/config-check.sh` already validates MEMORY.md file existence (around lines 35–49) but does not check for the `@MEMORY.md` import in CLAUDE.md.
- `.claude/skills/workspace-health/tests/test-scripts.sh` already covers MEMORY.md presence (around lines 103–171) but not the import check.
- `README.md` does not mention memory architecture.

## Tasks

### Task 1: Add @MEMORY.md import to CLAUDE.md template

`CLAUDE.md` is the template installed in every workspace using this bot. Adding `@MEMORY.md` here makes the workaround default behavior for all users adopting the template, so workspace `MEMORY.md` is automatically loaded into agent context.

What we want:
- A line containing exactly `@MEMORY.md` (no other text on the line) is added to `CLAUDE.md`.
- The line appears immediately after the existing `@-import` lines (typically after `@IDENTITY.md`).
- No other content in `CLAUDE.md` is modified.
- Preserved through upstream merges (already guaranteed by `merge=ours` in `.gitattributes`).

- [x] `CLAUDE.md` contains a line that matches the regex `^@MEMORY\.md$`
- [x] The new line appears after the existing `@-import` block, not at the top of the file
- [x] No other lines in `CLAUDE.md` are added, removed, or modified
- [x] `grep -c '^@' CLAUDE.md` returns one more than before (exactly one new @-import line)

### Task 2: Document the workaround in memory-protocol rules

Two variants of `memory-protocol.md` exist: platform (mandatory) and optional. Both must document the auto-load mechanism so users understand WHY `@MEMORY.md` is required and don't accidentally remove it during customization.

What we want:
- A new section titled `## Auto-load mechanism` added to both files.
- Section explains: workspace root `MEMORY.md` auto-loads via `@MEMORY.md` line in `CLAUDE.md`.
- Section explains: `autoMemoryDirectory` setting does NOT control injection (only affects writes).
- Section links to [anthropics/claude-code#34146](https://github.com/anthropics/claude-code/issues/34146) and [#36636](https://github.com/anthropics/claude-code/issues/36636) for context.
- Section warns: removing `@MEMORY.md` from `CLAUDE.md` makes workspace memory invisible to the agent.
- Identical wording across both files for consistency.

- [x] `.claude/rules/platform/memory-protocol.md` contains a section titled `## Auto-load mechanism`
- [x] `.claude/optional-rules/memory-protocol.md` contains the same section with identical wording
- [x] Both sections reference `anthropics/claude-code#34146` and `#36636` by URL or shorthand
- [x] Both sections explicitly state that `autoMemoryDirectory` does NOT affect injection
- [x] Both sections explicitly warn against removing `@MEMORY.md` from `CLAUDE.md`
- [x] The new section is placed coherently within the existing document structure (not appended awkwardly to the end)

### Task 3: Add @MEMORY.md presence check to workspace-health

The `workspace-health` skill validates that workspace structure is correct. Currently it checks `MEMORY.md` file existence but not the `@MEMORY.md` import. If a user customizes `CLAUDE.md` and accidentally removes the import, their workspace memory becomes silently invisible to the agent. Add a non-fatal warning when the import is missing.

What we want:
- `config-check.sh` greps `CLAUDE.md` for the `@MEMORY.md` line and emits a warning if absent.
- The warning mentions the consequence (MEMORY.md will not be auto-loaded) and points to the memory-protocol rule for context.
- Two new test cases in `test-scripts.sh`:
  1. CLAUDE.md without `@MEMORY.md` → `config-check.sh` warns.
  2. CLAUDE.md with `@MEMORY.md` → `config-check.sh` does not warn about the import.
- All existing test cases in `test-scripts.sh` continue to pass.

- [x] `.claude/skills/workspace-health/scripts/config-check.sh` contains a grep for `^@MEMORY\.md$` in `CLAUDE.md`
- [x] When the grep fails, the script emits a `warn` (or equivalent) message about the missing import
- [x] The warning message mentions `MEMORY.md will not be auto-loaded` or equivalent consequence text
- [x] `.claude/skills/workspace-health/tests/test-scripts.sh` includes a test case for CLAUDE.md missing `@MEMORY.md` that asserts the warning
- [x] `.claude/skills/workspace-health/tests/test-scripts.sh` includes a test case for CLAUDE.md containing `@MEMORY.md` that asserts the warning is NOT emitted
- [x] Running `bash .claude/skills/workspace-health/tests/test-scripts.sh` exits with status 0

### Task 4: Document memory architecture in README

Users adopting this bot template need to know about the memory system: where MEMORY.md lives, how it auto-loads, and why they should preserve the `@MEMORY.md` line in CLAUDE.md.

What we want:
- A new section in `README.md` with a heading that contains the phrase `Memory architecture` (case-insensitive).
- Section briefly describes: `MEMORY.md` at workspace root (index), `memory/auto/` (typed memory files), `@MEMORY.md` auto-load mechanism.
- Section warns against removing `@MEMORY.md` from `CLAUDE.md`.
- Section references issue #34146 or the platform memory-protocol rule for further detail.
- Section is placed coherently within the README (after setup/getting-started content, before deep configuration details).

- [ ] `README.md` contains a heading line matching (case-insensitive) the phrase `memory architecture`
- [ ] The section mentions: `MEMORY.md` at workspace root, `memory/auto/` directory, `@-import` or `@MEMORY.md` mechanism
- [ ] The section includes a warning against removing the `@MEMORY.md` import
- [ ] The section references either `anthropics/claude-code#34146` or `.claude/rules/platform/memory-protocol.md` for further context
- [ ] No existing README content is destroyed (only additive change)
