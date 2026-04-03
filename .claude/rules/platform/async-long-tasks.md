# Async Long Tasks

Any operation taking >30 seconds MUST run asynchronously:
- HTTP batch operations (enrichment, liveness, collect)
- Ralphex launches
- Large test suites on real data

**How:** Use `Bash` with `nohup ... &`, then immediately respond to the user. Check progress when asked.

**Never** block the conversation waiting for a long operation to finish. The user must always be able to interact.
