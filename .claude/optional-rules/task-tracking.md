<!-- Optional rule: copy to .claude/rules/custom/ to activate -->
# Task Tracking

## Principles

- Every task must have a clear definition and acceptance criteria before work begins.
- Track tasks in whatever tool the project uses (issues, task files, project boards).
- Update task status as work progresses — don't batch status updates.

## Evidence Gate

No task is complete without evidence:
- Code changes committed and passing tests
- Acceptance criteria verified (manually or via automation)
- Artifacts (logs, screenshots, output) attached where applicable

## Task Lifecycle

1. **Define** — write down what "done" looks like before starting
2. **Implement** — do the work, commit incrementally
3. **Verify** — run tests, check acceptance criteria
4. **Close** — update status, link evidence, note anything learned

## Scope Control

- If a task grows beyond its original scope, split it. Don't let scope creep turn a small fix into a large refactor.
- Document decisions that narrowed or expanded scope and why.
