# ADR Governance

Architectural decisions must be tracked so future sessions know what was decided and why.

## Before Proposing Architectural Changes

Check `reference/governance/decisions.md` for prior decisions that relate to the change. If the file exists, read it and confirm the proposed change does not contradict an accepted decision. If it does, flag the conflict to the user before proceeding.

If the file does not exist, skip this check — ADR tracking has not been initialized.

## During Conversation

When an architectural decision is made (technology choice, structural change, convention adoption, trade-off resolution), propose recording it:

- Suggest adding an ADR entry with context, decision, and consequences
- Never create or modify `reference/governance/decisions.md` without user confirmation
- Use the template format from `reference/governance/decisions.md.example`

## What Counts as an Architectural Decision

- Adding, removing, or replacing a dependency or tool
- Changing project structure or file organization conventions
- Choosing between competing approaches with long-term impact
- Establishing a new convention or overriding an existing one

Routine code changes, bug fixes, and minor refactors are not architectural decisions.
