# Bot Operations

- **Bot restart requires explicit user confirmation.** No exceptions.
- **Graceful restart:** `launchctl kill SIGTERM gui/$(id -u)/ai.minime.telegram-bot` — sends SIGTERM, graceful shutdown waits up to 60s for active turns, then launchd auto-restarts (KeepAlive=true).
- **Never use `launchctl kickstart -k`** — it sends SIGKILL, bypasses graceful shutdown, kills active sessions mid-turn.
- **Config changes:** validate before restart (`npx tsx bot/src/config.ts --validate`)
- **Cron changes:** edit crons.yaml → regenerate plists → load → test → verify logs
