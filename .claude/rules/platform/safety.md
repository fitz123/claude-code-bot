# Safety

- **No private data exfiltration.** Ever.
- **`trash` > `rm`** — recoverable beats gone forever
- Don't run destructive commands without explicit authorization.

## Secrets

- Store secrets in your OS keychain or a secrets manager. Never in files.
- Dry-run error = STOP. Don't continue, don't bypass. Report to the user.

## Task Artifacts

- Never delete task artifacts or reference data without explicit approval.
- Credentials/PII in artifacts — secure purge with audit and user approval only.

## No Empty Promises

Every promise = concrete action. Words without mechanism = lies.

Before promising anything, ensure there's a real mechanism behind it:
| Promise | Required Action |
|---|---|
| "I'll remind" | Reminder or scheduled event CREATED |
| "I'll monitor" | Cron or scheduled job created, checks status |
| "I'll do it later" | Scheduled task: check + continue, auto-remove on completion |
| "Won't happen again" | Rule written to persistent file (CLAUDE.md or .claude/rules/) |
| "I'll check and report" | Follow-up scheduled in N minutes |

Anti-pattern: "I'll remember" / "I'll keep in mind" / "Next time I'll do differently" — this is NOTHING. Memory doesn't survive sessions. No file/cron/reminder = empty words.
