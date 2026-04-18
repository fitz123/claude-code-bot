# Bot Operations

- **Bot restart requires explicit user confirmation.** No exceptions.
- **Canonical restart path:** use `bot/scripts/restart-bot.sh`. Do not type raw `launchctl` commands. The script validates config, sends SIGTERM, polls launchd teardown so bootout never races bootstrap, and returns the new PID on success.
  - `bot/scripts/restart-bot.sh` — graceful SIGTERM restart. Use after code changes or edits to `config.yaml` / `config.local.yaml`. KeepAlive relaunches from the cached plist.
  - `bot/scripts/restart-bot.sh --plist` — full unregister + re-bootstrap. Use after edits to `~/Library/LaunchAgents/ai.minime.telegram-bot.plist` (env vars, ProgramArguments, etc). Required because launchd caches the plist at bootstrap time; a plain SIGTERM restart picks up the stale cache and silently drops the edit.
  - `bot/scripts/restart-bot.sh -h` — usage.
- **Shutdown takes up to 60s.** The bot injects a shutdown message into active sessions, waits for turns to complete, then exits. Idle sessions close immediately. The script polls until the old PID is gone and a new PID is running — do not conclude failure from `launchctl list` output mid-drain.
- **Never bypass the script with raw `launchctl bootout`.** Manual `bootout` in the `gui` domain is asynchronous; pairing it with an immediate `bootstrap` races launchd's teardown and can leave the service unregistered with no way for KeepAlive to respawn (see incident 2026-04-18, 17 min outage). The `--plist` mode handles this safely by polling teardown to completion before bootstrap.
- **Never use `launchctl kickstart -k`** — it sends SIGKILL, bypasses graceful shutdown, kills active sessions mid-turn. The script never does this and neither should operators.
- **If the script fails** or auto-restart doesn't happen (>90s, no new PID), rerun `bot/scripts/restart-bot.sh --plist`. If that still fails, fall back to `launchctl load ~/Library/LaunchAgents/ai.minime.telegram-bot.plist`. If that doesn't work — ask Ninja.
- **Config changes (hot-reloaded, no restart needed):** `agents` fields (`model`, `fallbackModel`, `maxTurns`, `systemPrompt`, `effort`, `workspaceCwd`) and `sessionDefaults` (`idleTimeoutMs`, `maxConcurrentSessions`) are re-read from `config.yaml` / `config.local.yaml` on every new session spawn. Edit the file and the next new session picks it up. Already-running sessions keep their original config.
- **Config changes (boot-level, restart required):** `telegramToken`, `discord.token`, `bindings`, `metricsPort`, `sessionDefaults.maxMessageAgeMs`, `sessionDefaults.requireMention`. Validate before restart: `npx tsx bot/src/config.ts --validate` (the script runs this automatically and aborts on failure).
- **Cron changes:** edit crons.yaml → regenerate plists → load → test → verify logs
