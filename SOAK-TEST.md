# Soak Test Report

Started: 2026-03-12 02:30 MSK
Environment: macOS Darwin 23.6.0, MacBook Pro M3 16GB

## Setup

- New grammY bot: ai.openclaw.telegram-bot (launchd, KeepAlive)
- Old OpenClaw gateway: ai.openclaw.gateway (launchd, Telegram disabled)
- 33 cron plists loaded via launchd
- Bot token: Keychain service `telegram-bot-token`

## Issues Found

### ISSUE-1: 409 Conflict (getUpdates)
- Severity: BLOCKING
- When: Immediately on startup
- Cause: Both old gateway and new bot polling Telegram with same bot token
- Fix: Disabled `channels.telegram.enabled` in openclaw.json, restarted gateway
- Status: RESOLVED
- Impact: Bot was in crash loop until gateway Telegram bindings disabled

### ISSUE-2: Bot crash loop before Telegram fix
- Severity: HIGH (caused by ISSUE-1)
- When: From bot start until gateway Telegram disabled
- Evidence: telegram-bot.stdout.log shows repeated startup messages (10+ restarts)
- Fix: Same as ISSUE-1
- Status: RESOLVED

## Test Results

### Parallel Run
- PASS: Both gateway and new bot running simultaneously
- Gateway continues running for non-Telegram purposes
- Bot handles all Telegram polling exclusively after fix

### Cron Execution (3+ natural runs)
- PASS: 4 executions across 3 different crons observed
  1. acp-canary-check (23:10 UTC) - completed, 728 chars, delivered to chat 306600687
  2. video-encode-supervisor (23:21 UTC) - completed, NO_REPLY (valid, no new encodes)
  3. video-encode-supervisor (23:31 UTC) - completed, NO_REPLY (valid)
  4. memory-consolidation-anna (23:30-23:32 UTC) - completed, delivered to chat 306600687
- Delivery log confirms 2 successful Telegram deliveries

### Idle Timeout
- PASS (by design): CLAUDE_CODE_EXIT_AFTER_STOP_DELAY=900000 configured in spawn env
- Verified in cli-protocol.ts:81 and tested in cli-protocol.test.ts:99
- CLI self-terminates after 15 min idle; session-manager.ts handles child exit cleanup
- No bot-managed interactive sessions observed yet (bot was in crash loop during test window)
- Note: Will be verified empirically once interactive sessions are used

### Crash Recovery
- PASS: Killed bot PID 36291 with SIGKILL
- launchd restarted bot within 12 seconds (new PID 36532)
- Bot started cleanly, no 409 errors post-restart
- ThrottleInterval=10 in plist prevents restart storms

### Session Management
- Session store: ~/.openclaw/bot/data/sessions.json (atomic writes)
- LRU eviction at maxConcurrentSessions=3
- Crash recovery: child exit handler cleans up, next message respawns with --resume
- p-queue concurrency=1 per session prevents message interleaving

### Memory Usage
- Bot process (Node.js): ~30-50MB
- Each claude subprocess: ~115-207MB observed
- At 3 max concurrent sessions: ~450-650MB for claude + ~50MB for bot = ~700MB total
- Within M3 16GB budget

## Ongoing Monitoring Items

- Bot uptime tracking (launchd auto-restarts on crash)
- Cron execution success rates over 24h
- Interactive session creation/cleanup cycle
- Memory pressure under concurrent sessions

## Conclusion

Core infrastructure is working. The 409 conflict was the only blocking issue, resolved by disabling gateway Telegram bindings. Crons execute and deliver to Telegram. Crash recovery works via launchd KeepAlive. Idle timeout is configured in spawn env (15 min auto-exit).
