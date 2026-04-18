# Safe scripted bot restart + rule update — Round 1

## Goal

Give operators one supported, scripted entry point to restart the bot safely — covering both code/config restarts and on-disk-plist changes — and update the operational rule to point at it. Resolves fitz123/claude-code-bot#100.

## Validation Commands

```bash
cd bot && npm test
cd bot && npx tsc --noEmit
shellcheck bot/scripts/*.sh || true
```

## Reference: incident log

Actual timestamps from an operator machine's `/Users/ninja/.minime/logs/telegram-bot.stdout.log`:

```
15:27:42Z  Received SIGTERM                  (first restart: launchctl kill SIGTERM)
15:28:43Z  All sessions closed. Exiting.
15:28:44Z  Bot version: 2d5fd7b              (launchd KeepAlive auto-restart, CACHED plist — new env var NOT applied)
15:30:08Z  Received SIGTERM                  (second restart: launchctl bootout + bootstrap)
15:30:14Z  All sessions closed. Exiting.
[ 17m16s of bot downtime ]
15:47:30Z  Bot version: 2d5fd7b              (manual recovery from a separate session)
```

Failing command sequence that caused the 17-minute outage:

```bash
launchctl bootout gui/$uid/ai.minime.telegram-bot
sleep 2
launchctl bootstrap gui/$uid ~/Library/LaunchAgents/ai.minime.telegram-bot.plist
# → Bootstrap failed: 5: Input/output error
```

Root cause: `launchctl bootout` in the `gui` domain is asynchronous. The bootstrap call fired before teardown finished, got EIO, and service registration was gone so KeepAlive could not respawn.

## Reference: launchctl list output

Column format verified on macOS 14 (Darwin 23.6.0):

```
$ launchctl list | head -1
PID     Status  Label
$ launchctl list | awk '$3=="ai.minime.telegram-bot"'
84395   0       ai.minime.telegram-bot
```

PID column shows `-` when the service is registered but the process is not currently running.

## Reference: existing scripts in bot/scripts/

```
bot/scripts/deliver.sh
bot/scripts/generate-plists.ts
bot/scripts/run-cron.sh
bot/scripts/start-bot.sh        # referenced from plist ProgramArguments
```

`deliver.sh` and `run-cron.sh` are the closest style references for a new shell script.

## Reference: current rule (.claude/rules/platform/bot-operations.md)

Full current content of `.claude/rules/platform/bot-operations.md` — the file Task 2 updates:

```markdown
# Bot Operations

- **Bot restart requires explicit user confirmation.** No exceptions.
- **Graceful restart:** `launchctl kill SIGTERM gui/$(id -u)/ai.minime.telegram-bot` — sends SIGTERM. Bot injects shutdown message into active sessions asking agents to wrap up, then waits up to 60s for turns to complete. Idle sessions close immediately. Launchd auto-restarts (KeepAlive=true).
- **Wait for shutdown to complete.** After SIGTERM, the bot may take up to 60s to drain active sessions. Check logs for `All sessions closed. Exiting.` before concluding the restart failed. Running `launchctl list` during this window may show a stale exit code — that does NOT mean the restart failed.
- **Never use `launchctl bootout` after SIGTERM.** If you `bootout` while the bot is still draining sessions, you remove the service definition from launchd — KeepAlive can no longer restart it. The bot dies with no way back except manual `launchctl load`.
- **Never use `launchctl kickstart -k`** — it sends SIGKILL, bypasses graceful shutdown, kills active sessions mid-turn.
- **If auto-restart doesn't happen** after clean exit (>90s, no new PID): `launchctl load ~/Library/LaunchAgents/ai.minime.telegram-bot.plist`. If that doesn't work — ask Ninja.
- **Config changes (hot-reloaded, no restart needed):** `agents` fields (`model`, `fallbackModel`, `maxTurns`, `systemPrompt`, `effort`, `workspaceCwd`) and `sessionDefaults` (`idleTimeoutMs`, `maxConcurrentSessions`) are re-read from `config.yaml` / `config.local.yaml` on every new session spawn. Edit the file and the next new session picks it up. Already-running sessions keep their original config.
- **Config changes (boot-level, restart required):** `telegramToken`, `discord.token`, `bindings`, `metricsPort`, `sessionDefaults.maxMessageAgeMs`, `sessionDefaults.requireMention`. Validate before restart: `npx tsx bot/src/config.ts --validate`
- **Cron changes:** edit crons.yaml → regenerate plists → load → test → verify logs
```

The rule does not specify a procedure for applying plist-on-disk changes and warns against `bootout` without pairing that with a safe alternative.

## Tasks

### Task 1: Add a bot-restart script under `bot/scripts/` (#100, P1)

**Problem.** Operators currently restart the bot by typing raw `launchctl` commands. Two distinct triggers exist:

1. Code or `config.yaml`/`config.local.yaml` changes — launchd's cached plist is still correct, so a graceful SIGTERM restart is enough (KeepAlive relaunches).
2. Changes to `ai.minime.telegram-bot.plist` itself (env vars, ProgramArguments, etc) — launchd caches the plist in memory at bootstrap time, so a plain SIGTERM restart relaunches from the stale cache and silently drops the edit. To pick up the new plist, the service must be fully unregistered and re-bootstrapped from disk.

Case 2 is where operators get hurt: the naive `bootout` + `bootstrap` sequence has a race (bootout is asynchronous, bootstrap returns EIO if called too early). On 2026-04-18 this produced 17 minutes of bot downtime — see incident reference above.

**What we want.** A single supported, scripted entry point that an operator (or automation) can invoke to restart the bot safely, covering both cases. After the restart, the bot is running and — in case 2 — actually reflects the on-disk plist.

- [x] There is an executable script in `bot/scripts/` that operators invoke to restart the bot. Exact name and CLI are the implementer's choice, but the name and usage MUST be referenced verbatim from the updated rule in Task 2 (one contract, one source of truth).
- [x] Default / zero-argument invocation performs a graceful restart suitable for case 1 (code/config changes only); it sends SIGTERM, waits for the old process to exit, and returns successfully once a new PID is running.
- [x] There is a clearly named mode (flag, subcommand, or separate script — implementer's choice) that performs case 2: after the script finishes successfully, the running bot process reflects the current on-disk plist (verifiable via `sudo launchctl procinfo <pid>` showing any new `EnvironmentVariables` from the plist).
- [x] The script tolerates variable session-drain time — including the full 60-second shutdown window — without racing launchd's teardown and without relying on a fixed `sleep`. Simulating a slow shutdown (e.g. a stub that delays exit) must not cause false-positive or false-negative exits.
- [x] The script never sends SIGKILL and never invokes `launchctl kickstart -k` or equivalent; graceful shutdown is not bypassable.
- [x] On success the script prints the new PID and exits 0; on any failure to shut down or to bring the service back up, it prints a clear diagnostic and exits non-zero.
- [x] Invoking with `-h` / `--help` or an unknown argument prints usage and exits with an appropriate status.
- [x] Style is consistent with other shell scripts in `bot/scripts/` (see `deliver.sh`, `run-cron.sh`).
- [x] `shellcheck` produces no errors on the new script (warnings acceptable if justified inline).
- [x] Before any restart action the script runs config validation (`npx tsx bot/src/config.ts --validate` or equivalent for the case being applied) and aborts with a non-zero exit and a clear diagnostic if validation fails — the bot is never restarted with a broken config
- [x] Automated test harness covers: (a) graceful path returns the new PID and exits 0; (b) plist-change mode results in the on-disk plist being reflected after success; (c) a slow-shutdown stub that delays exit up to the full 60-second drain window does not cause the script to race launchd's teardown or exit early; (d) a deliberately broken config aborts the restart before any SIGTERM is sent
- [x] Verify existing tests pass

### Task 2: Recommend the script in `.claude/rules/platform/bot-operations.md` (#100, P1)

**Problem.** The current rule tells operators to type raw `launchctl` commands, and its "Never use `launchctl bootout` after SIGTERM" warning — taken literally — leaves an operator with no correct way to apply a plist edit at all. That gap is what the Task 1 script closes.

**What we want.** After Task 1 lands, the rule points operators to the script as the canonical restart path. Operators who edit `config.yaml` / `config.local.yaml` or the plist should be able to follow the rule without ever running raw `launchctl` commands.

- [x] The rule recommends the Task 1 script (by its actual name and CLI) as the default way to restart the bot, and explicitly covers the plist-change case.
- [x] Any previous guidance that contradicts or misleads about the plist-change flow — specifically the blanket "Never use `launchctl bootout` after SIGTERM" line — is updated or removed so operators following the rule end up with a working bot after a plist edit.
- [x] The "Never use `launchctl kickstart -k`" warning is preserved.
- [x] The auto-restart fallback ("If auto-restart doesn't happen…") still works: it points at the script first, and only falls back to manual `launchctl` commands if the script itself fails.
- [x] All existing sections on hot-reload fields, boot-level fields, and cron changes are preserved unchanged.
- [x] manual test (skipped - not automatable): Following the updated rule end-to-end (edit plist → run script → check `sudo launchctl procinfo <pid>`) successfully picks up the new on-disk plist without any raw `launchctl` commands typed by the operator
- [x] Verify existing tests pass
