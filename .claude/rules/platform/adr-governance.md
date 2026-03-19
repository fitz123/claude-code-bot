# ADR Governance

Architectural and operational decisions must be tracked so future sessions know what was decided and why.

## Before Proposing Changes

Check `reference/governance/decisions.md` for prior decisions that relate to the change. If the file exists, read it and confirm the proposed change does not contradict an accepted decision. If it does, flag the conflict to the user before proceeding.

If the file does not exist, skip this check — ADR tracking has not been initialized.

## When to Propose an ADR

When you notice any of the following during conversation, ask the user: "Record as ADR?"

- New tool, library, or service adopted or rejected
- Architecture pattern chosen (how components interact)
- Operational procedure established (how to deploy, monitor, recover)
- Policy decision (what's allowed, what's not)
- Migration or deprecation decided
- Project structure or file organization conventions changed
- Competing approaches evaluated with long-term impact

Do NOT create or modify `reference/governance/decisions.md` without user confirmation. Use the template format from `reference/governance/decisions.md.example`.

## What Does NOT Count

Routine code changes, bug fixes, and minor refactors are not architectural decisions.
