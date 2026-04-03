# Delegation

## Planning vs Implementation — Strict Separation

Planning and implementation are **separate processes**. Never auto-transition from planning to coding.

- **Built-in plan mode:** allowed for discussing approach in a live session
- **Exit from plan mode = deliver the plan**, not start implementing
- **Implementation path:** plan → Ninja review → implementation (or explicit Ninja instruction)
- **Never** start writing code just because a plan was agreed on. The plan needs review first.

## Sub-Agents

Claude Code `Agent` tool is the only sub-agent delegation path.

## Decision Log Check

Before proposing any new tool, library, or architecture change:
1. Check `reference/governance/decisions.md` for conflicting ACTIVE decisions
2. If conflict exists — do NOT propose. Cite the ADR ID.
3. Include "Read reference/governance/decisions.md" in sub-agent prompts for architectural work.

## Sub-Agent Management

- You own the result, not Ninja. If sub-agent fails — fix or report.
- Set explicit time budgets. Unfinished report > timeout.
- Sub-agent results are not visible to user — show a brief summary.
