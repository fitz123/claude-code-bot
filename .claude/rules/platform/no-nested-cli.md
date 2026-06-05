# No Nested Claude CLI Execution

Do not run `claude` CLI commands from Bash inside an active coding-agent session.

- `claude -p`, `claude auth`, and `claude --version` are prohibited from session shell tools.
- Nested Claude Code sessions can hang, lose output, or crash when inherited session markers are present.
- The bot runtime no longer uses Claude Code CLI; this rule is a workspace safety guard for human/agent shell work, not a runtime dependency.

Use existing workspace documentation, source files, or external documentation instead of launching a nested Claude CLI process.
