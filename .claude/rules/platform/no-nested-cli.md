# No Nested Claude CLI Execution

**NEVER run `claude` CLI commands from Bash within a Claude Code session.**

- `claude -p`, `claude auth`, `claude --version` — ALL prohibited from Bash tool
- Nested Claude Code sessions don't work (CLAUDECODE env var blocks it)
- Even with `unset CLAUDECODE` — causes hangs, lost output, session crashes

**What to do instead:**
- Document CLI behavior in plan files based on research/docs
- Note items that need manual verification by the user outside the session
- Use `WebFetch` to read Claude Code documentation
- Reference `claude --help` output from prior research (stored in workspace)

**This rule applies to ALL sessions** — main, crons, sub-agents.
