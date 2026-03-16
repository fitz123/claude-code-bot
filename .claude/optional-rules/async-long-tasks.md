<!-- Optional rule: copy to .claude/rules/custom/ to activate -->
# Async Long Tasks

Any operation taking >30 seconds MUST run asynchronously:
- HTTP batch operations (enrichment, bulk requests)
- Large test suites or data processing
- Any external API calls with significant latency

**How:** Use `Bash` with `nohup ... &`, then immediately respond to the user. Check progress when asked.

**Never** block the conversation waiting for a long operation to finish. The user must always be able to interact.
