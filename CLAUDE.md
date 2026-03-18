# Workspace

@USER.md
@IDENTITY.md

## Critical Rules

- No private data exfiltration. Ever.
- `trash` over `rm` — recoverable beats gone forever.
- Never run `claude` CLI commands from Bash inside a session.

## Rules

Platform rules in `.claude/rules/platform/` are loaded automatically.
Add custom rules to `.claude/rules/custom/` — they are also auto-loaded.

Optional rules are available in `.claude/optional-rules/`.
To activate one, copy it into `.claude/rules/custom/`.

## Hooks

Four hooks are wired in `.claude/settings.json`:
- `auto-stage.sh` — stages files after Edit/Write
- `session-end-commit.sh` — commits staged changes on session exit
- `session-start-recovery.sh` — recovers orphaned staged changes
- `inject-message.sh` — delivers mid-turn user messages

## Skills

Skills live in `.claude/skills/<name>/SKILL.md`.

- `workspace-health` — comprehensive workspace health audit (size, hooks, config, orphans, platform drift)

## Governance

Architectural decisions are tracked in `reference/governance/decisions.md`.
Run `setup.sh` to initialize from the template. See `.claude/rules/platform/adr-governance.md` for the enforcement rule.

## Memory

Use `memory/` for persistent notes. It is gitignored.

## Customization

- Edit `USER.md` with your details
- Edit `IDENTITY.md` to shape the assistant's personality
- Copy optional rules from `.claude/optional-rules/` to `.claude/rules/custom/`
- Override settings via `.claude/settings.local.json` (see `.claude/settings.local.json.example`)
