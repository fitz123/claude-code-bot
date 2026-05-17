# No PII in Public Repositories

**NEVER** include any of the following in public repos (issues, PRs, comments, code, commits):

- Real names, usernames, Telegram handles
- Chat IDs, user IDs, group IDs
- Addresses, phone numbers, emails
- Bot tokens, API keys, credentials (even in stack traces)
- Group/channel names that identify the owner
- Any data that links back to a real person

### When posting logs or stack traces:
- Replace chat IDs with `<redacted-chat-id>`
- Replace bot tokens with `<redacted-token>`
- Replace usernames with generic terms ("the user", "the admin")
- Replace group names with generic terms ("the group chat")

### Before every `gh issue`, `gh pr`, or `gh api` write:
Ask yourself: "Does this contain anything that identifies a real person?"

This applies to any public repository.
