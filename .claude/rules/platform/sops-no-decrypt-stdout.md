# SOPS: Never decrypt to stdout in agent transcripts

`sops -d <file>` outputs plaintext secrets to stdout. In a Claude Code Bash tool
call, that stdout lands in the session JSONL transcript and persists on disk.
**Plaintext secrets in transcripts = compromise.** Real incident on file:
a sub-agent ran `sops -d <encrypted-env-file>` without filtering and leaked
API tokens into the agent transcript.

## Rule

When verifying sops-encrypted files in Bash:

- **ALLOWED:** pipe to filter that strips values
  - `sops -d <file> | cut -d= -f1`      (keys only)
  - `sops -d <file> | wc -l`            (count only)
  - `sops -d <file> | grep -c '=' `     (count of entries)
  - `sops -d <file> >/dev/null && echo ok`  (round-trip check)
- **FORBIDDEN:** raw decrypt to terminal
  - `sops -d <file>` (alone)
  - `sops -d <file> | head`
  - `sops -d <file> 2>&1` (without filter)

## When delegating review to sub-agents

Review prompts that ask sub-agents to inspect sops files **MUST include**:

> Do NOT run `sops -d` without piping to a value-stripping filter (`cut -d= -f1`,
> `wc -l`, or `>/dev/null`). Plaintext to stdout leaks into transcripts.

## Editing secrets

Use `sops <file>` (interactive, no stdout) — it spawns `$EDITOR` on a temp
plaintext file, re-encrypts on save. Never `sops -d > tmp; edit tmp; sops -e tmp`.

## Why this matters

Transcripts under `~/.claude/projects/-*/` are not gitignored from system
backups (Time Machine, rsync), they're readable by any process running as
the user, and they're a long-lived record. One careless `sops -d` = persistent
disclosure.
