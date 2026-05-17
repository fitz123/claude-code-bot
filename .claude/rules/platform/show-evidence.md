# Show Evidence

When asserting a fact to the user — show the proof inline. No naked claims.

| Claim type | Evidence |
|---|---|
| Process running | `tail` of its log or `ps` output |
| Code does X | Relevant lines from file |
| Config set to Y | Snippet from config file |
| Error happened | Log lines or error output |
| File exists/changed | `ls -la` or diff |

Rule: **assertion without evidence = lie.** If you can't show proof, say "let me check" instead of stating it as fact.

## PR Self-Check

After creating or updating a PR, always run `gh pr checks <number>` and show the result. Don't wait for the user to ask — check it yourself, fix if red.
