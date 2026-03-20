# Bot Operations

- **Bot restart requires explicit user confirmation.** No exceptions.
- **Graceful restart:** `launchctl kill SIGTERM gui/$(id -u)/ai.minime.telegram-bot` — sends SIGTERM. Bot injects shutdown message into active sessions asking agents to wrap up, then waits up to 60s for turns to complete. Idle sessions close immediately. Launchd auto-restarts (KeepAlive=true).
- **Wait for shutdown to complete.** After SIGTERM, the bot may take up to 60s to drain active sessions. Check logs for `All sessions closed. Exiting.` before concluding the restart failed. Running `launchctl list` during this window may show a stale exit code — that does NOT mean the restart failed.
- **Never use `launchctl bootout` after SIGTERM.** If you `bootout` while the bot is still draining sessions, you remove the service definition from launchd — KeepAlive can no longer restart it. The bot dies with no way back except manual `launchctl load`.
- **Never use `launchctl kickstart -k`** — it sends SIGKILL, bypasses graceful shutdown, kills active sessions mid-turn.
- **If auto-restart doesn't happen** after clean exit (>90s, no new PID): `launchctl load ~/Library/LaunchAgents/ai.minime.telegram-bot.plist`. If that doesn't work — ask Ninja.
- **Config changes:** validate before restart (`npx tsx bot/src/config.ts --validate`)
- **Cron changes:** edit crons.yaml → regenerate plists → load → test → verify logs
