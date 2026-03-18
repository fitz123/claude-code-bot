# Workspace Health Check

Run a comprehensive workspace health audit. Execute each part in order, collect results, then produce a summary report.

Set `WORKSPACE` to the current working directory (or the directory the user specifies).

## Part A: Size Audit

Run the size audit script:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/size-audit.sh" "$WORKSPACE"
```

Record any warnings from the output.

## Part B: Hook Integrity

Run the hook integrity checker:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/hook-integrity.sh" "$WORKSPACE"
```

Record errors and warnings from the output.

## Part C: Config Check

Run the configuration validator:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/config-check.sh" "$WORKSPACE"
```

Record errors and warnings from the output.

## Part D: Orphan Scan

Run the orphan file scanner:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/orphan-scan.sh" "$WORKSPACE"
```

Record any orphan items found.

## Part E: Fact Verification

Verify that claims in configuration files match reality. Read the following files if they exist — skip any that are missing:

- `CLAUDE.md`
- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`
- `.claude/settings.json`
- `setup.sh`

Check for:
- References to files or directories that do not exist (e.g., `@USER.md` in CLAUDE.md — does USER.md exist?)
- Hook descriptions in CLAUDE.md that do not match hooks configured in `.claude/settings.json`
- Claims about directory structure that do not match actual structure
- Broken cross-references between files

If a referenced file does not exist in the workspace, skip checks that depend on it. Report only verified mismatches — do not speculate.

## Part F: Content Quality

Review workspace content files for quality issues. Read these files if they exist — skip any that are missing:

- `CLAUDE.md`
- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`
- `.claude/rules/platform/*.md`
- `.claude/optional-rules/*.md`

Check for:
- Contradictory instructions between files
- Duplicated content across files (same instruction in multiple places)
- Placeholder text that was never filled in (acceptable in USER.md and IDENTITY.md templates)
- Formatting inconsistencies within individual files

Report only substantive issues — do not flag stylistic preferences or minor formatting differences.

## Part G: Claude Code Docs Compliance

Verify the workspace follows Claude Code conventions:

- `CLAUDE.md` exists at workspace root
- Skills are at `.claude/skills/<name>/SKILL.md` (one level deep, not nested further)
- Hooks are configured in `.claude/settings.json` using `$CLAUDE_PROJECT_DIR` for paths
- Rules are in `.claude/rules/platform/` (platform) and `.claude/rules/custom/` (user)
- Settings overrides use `.claude/settings.local.json`

Skip any check where the relevant file or directory does not exist.

## Part H: Platform Consistency

Run the platform drift checker:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/platform-check.sh" "$WORKSPACE"
```

This compares platform files (hooks, rules, settings) against the upstream remote. If no upstream remote is configured or the workspace is not a git repository, the script skips gracefully.

Record any drifted files from the output.

## Part I: Cleanup (Optional)

If issues were found in Parts A-D, offer to run cleanup:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/cleanup.sh" --workspace "$WORKSPACE"
```

This runs in dry-run mode by default. Only pass `--apply` if the user explicitly approves. Before running with `--apply`, verify that `trash` is installed (`command -v trash`). If not, warn the user that cleanup requires `trash` to ensure recoverable deletion.

## Git Sync

If the workspace is a git repository, check for uncommitted changes and offer to commit health-related fixes. Skip this step entirely if the workspace is not a git repository.

## Summary Report

After all parts complete, produce a summary in this format (one line per check):

```
Workspace Health Report: <workspace-path>
- Size audit: <OK | N warning(s)>
- Hook integrity: <OK | N error(s)>
- Config check: <OK | N error(s), N warning(s)>
- Orphan scan: <OK | N orphan(s)>
- Fact verification: <OK | N issue(s)>
- Content quality: <OK | N issue(s)>
- CC docs compliance: <OK | N issue(s)>
- Platform check: <OK | N file(s) drifted | skipped>
```

If any part found issues, list the details below the summary.
