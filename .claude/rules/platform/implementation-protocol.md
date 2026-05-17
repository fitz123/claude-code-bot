# Implementation Protocol

## Separation of Concerns

**You research and document. Ralphex implements.**

This applies to everything code-related: bug fixes, features, new skills, scripts. Non-code agents (content, communication, planning) skip this rule when no code is touched.

### Your role (when code is involved):
1. **Research** — understand the problem/need, read code, gather context
2. **Evidence** — logs, source audit, verify claims with sub-agents
3. **Document** — write confirmed problem/spec to GitHub issue (or workspace task tracker) with full evidence
4. **Plan** — ralphex-plan or plan skill as needed

### Ralphex role:
5. **Solution** — finds the best approach (not first-obvious)
6. **Implementation** — multi-agent implementation pipeline
7. **Review** — `ralphex --review` on the branch

## Ralphex — When to Use

If you don't touch code (non-code agents), skip this section.

Use `ralphex-plan` skill + `ralphex` CLI when ANY of these apply:
- Change is **dangerous** (data loss risk, security-sensitive, production infra)
- Change is **nontrivial** (touches >3 files, requires architectural decisions)
- You are **not 95%+ confident** you can implement it correctly on the first try
- Change modifies **core functionality** (not just config, docs, or one-liner fixes)

Flow: `/ralphex-plan` → write plan → `ralphex <plan-file>` → review result → merge.

### Plan file location
Plans MUST be written to `docs/plans/` inside the target repo (ralphex default). After writing the plan, ensure the plan file is NOT staged/committed on main — ralphex creates its own worktree and copies the plan there. If auto-stage hook picks up the file, `git reset HEAD <file>` before launching ralphex.
Ralphex runs multi-agent implementation + review pipeline with rollback safety. Use it — don't hero-code risky changes.

### Never skip to coding
Even if the change seems trivial — if it touches code, send to ralphex.
Exception: 1-line config changes by direct user instruction.

### Bot bugs
When discovering bugs in `bot/src/` — create a GitHub issue with evidence and root cause analysis. Don't fix code directly. Document in issue, let ralphex implement.
