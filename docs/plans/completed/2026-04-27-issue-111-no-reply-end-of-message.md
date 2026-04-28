# Issue #111 — NO_REPLY end-of-message suppression — Round 1

## Goal

Fix a delivery bug where pipeline-style cron prompts produce `<summary>\n\nNO_REPLY` and the agent's intended suppression token is ignored, leaking the summary as a real Telegram message. The current regex (`/^NO_REPLY\b/`) only matches `NO_REPLY` at the **start** of the trimmed output; agents reliably put it at the **end** after a recap.

## Validation Commands

```bash
cd bot
npx tsc --noEmit
npm test
```

## Reference: current suppression code

`bot/src/stream-relay.ts:271-276` (final delivery decision after streaming completes):

```ts
// NO_REPLY: agent explicitly signals "no response needed" — suppress delivery.
// Drafts auto-disappear when no sendMessage follows.
const trimmed = accumulated.trim();
if (accumulated && /^NO_REPLY\b/.test(trimmed)) {
  return;
}
```

`bot/src/cron-runner.ts:388-397` (one-shot cron output gate):

```ts
if (!output) {
  log(taskName, "WARN: empty output — skipping delivery");
  log(taskName, "DONE");
  return;
}
if (cron.type === "llm" && /^NO_REPLY\b/.test(output.trim())) {
  log(taskName, "NO_REPLY — skipping delivery");
  log(taskName, "DONE");
  return;
}
```

Both gates use the identical regex `/^NO_REPLY\b/` and operate on `trimmed`/`output.trim()`.

## Reference: leaked agent outputs (delivered when they should have been suppressed)

Source: operator's Telegram chat history, 2026-04-27 morning batch (5 workspace-health crons, 2 memory-consolidation crons, 2 backup-git crons — all 9 leaked with the same shape).

```
All checks complete. Everything is clean — no real issues found.

NO_REPLY
```

```
All checks complete. Let me compile the results:
• Size audit: OK (335M, no bloat)
• Hook integrity: OK
• Config check: 1 warning (settings.local.json missing outputStyle — minor, file doesn't exist)
[... more bullets ...]
The only finding is the settings.local.json warning, which is informational.

NO_REPLY
```

```
Memory Consolidation — 2026-04-25

• Sessions reviewed: 4 (Council CLI design, workspace ops, peptides research, car identification)
• Mutations applied: 2/2 (0 failed)

NO_REPLY
```

```
Stash pop had a conflict but backup itself found no changes to push. Stash is preserved safely — these are local working changes that existed before backup ran.

NO_REPLY
```

Common shape: arbitrary content, then a blank line (or single newline), then `NO_REPLY` alone on the final non-empty line.

## Reference: existing test coverage for stream-relay NO_REPLY

`bot/src/__tests__/stream-relay.test.ts:789-848` (the `relayStream NO_REPLY with drafts` describe block). Currently covers:

- `NO_REPLY` exact (line 790)
- `NO_REPLY\n\nSome explanation text...` — start-of-message + trailing text (line 799)
- `  NO_REPLY  ` — whitespace padding (line 808)
- `NO_REPLY` does not call `deleteMessage` — drafts auto-disappear (line 817)
- `NO_REPLY_EXTRA some content` — substring prefix is delivered (line 830)
- `NO_REPLY: The user didn't ask a question.` — start with punctuation (line 840)
- regular output is delivered normally (line 849)

There is **no** existing coverage for `<content>\n\nNO_REPLY` (the leak pattern in this issue). There is also no existing NO_REPLY suppression test in `bot/src/__tests__/cron-runner.test.ts`.

## Reference: prior fix (issue #80)

PR #80 changed the cron-runner check from exact-match (`output === "NO_REPLY"`) to startsWith (`/^NO_REPLY\b/`) so that `NO_REPLY\n\n<explanation>` (start + trailing text) was suppressed. That behavior must remain working after this fix — backward compatibility is required. See `docs/plans/080-no-reply-trim.md` for context.

## Reference: documentation that mentions the suppression rule

`.claude/rules/platform/communication.md` — section `## Silent Response`. Currently documents `NO_REPLY` at the start of the response, with regex `/^NO_REPLY\b/` and "wrong/right" examples. The "wrong" examples include `All checks clean. NO_REPLY` (summary first → delivered). After this fix, that example moves from "wrong" to "right" because the bot will accept end-of-message `NO_REPLY` on its own line.

## Tasks

### Task 1: Suppress delivery when NO_REPLY appears alone on the last non-empty line (issue-111, P0)

**Problem:** Pipeline-style cron prompts (workspace-health, memory-consolidation, backup-git) consistently emit `<summary>\n\nNO_REPLY`. The current regex only matches `NO_REPLY` at the start of the trimmed output, so the entire summary is delivered as a Telegram message instead of being suppressed. Operator confirmed 9 leaked messages across 4 different crons in a 2-day window; historical match rate for workspace-health is ~3% out of 38+ runs each. Two prompt-side mitigations (per-cron prompt strengthening + platform rule strengthening in PR #110) failed to change the behavior — the model's RLHF instinct to recap overrides explicit instructions.

**What we want:** The bot suppresses delivery whenever `NO_REPLY` appears either at the start of the trimmed output (current behavior, must be preserved for backward compatibility with issue #80) **OR** alone on the last non-empty line of the trimmed output (new behavior). The same logic applies to both delivery paths: streaming delivery in `stream-relay.ts` (interactive sessions) and one-shot delivery in `cron-runner.ts` (LLM crons). Documentation must reflect the new accepted form so operators and agents understand both suppression patterns.

**Out of scope:** Suppressing same-line patterns like `Done. NO_REPLY` (where `NO_REPLY` is not alone on its line). These are intentionally NOT matched to avoid false-positive suppression of prose that mentions the token in passing.

- [x] When `NO_REPLY` is alone on the last non-empty line of the agent's output (with optional surrounding whitespace), `relayStream` returns without calling `platform.sendMessage`
- [x] When `NO_REPLY` is alone on the last non-empty line of an LLM cron's output (with optional surrounding whitespace), `cron-runner` logs `NO_REPLY — skipping delivery` and returns without calling `deliver`
- [x] Existing start-of-message suppression (`NO_REPLY`, `NO_REPLY\n\n<text>`, `NO_REPLY: reason`, `  NO_REPLY  ` whitespace-padded) continues to suppress (issue #80 backward compatibility)
- [x] Same-line patterns like `All clean. NO_REPLY` (where `NO_REPLY` shares a line with other content) are NOT suppressed and ARE delivered
- [x] Substring prefixes like `NO_REPLY_EXTRA some content` are NOT suppressed and ARE delivered
- [x] `.claude/rules/platform/communication.md` `## Silent Response` section accurately documents both accepted suppression forms (start-of-message and alone-on-last-line), and any examples that contradict the new behavior are corrected — skipped (file edit blocked by Claude Code "sensitive file" permission gate; user must apply this doc change manually — see proposed text in commit body)
- [x] Add tests in `bot/src/__tests__/stream-relay.test.ts` covering: `<content>\n\nNO_REPLY` end-of-message; `<content>\nNO_REPLY` (single newline); `<content>\nNO_REPLY\n` (trailing newline); `<multi-line content>\n\nNO_REPLY` reproducing one of the operator's leaked samples verbatim; `Some text NO_REPLY` (same line) is delivered; `Done. NO_REPLY_EXTRA more` is delivered
- [x] Cron-path end-of-message suppression has unit-level test coverage matching the same pattern set as the stream-relay tests above (`<content>\n\nNO_REPLY`, single-newline, trailing-newline, multi-line operator sample, same-line not suppressed, substring-prefix not suppressed)
- [x] Verify existing tests pass — `npx tsc --noEmit` is clean and `npm test` is green. (`tsc --noEmit` clean; `npm test` shows 1015/1016 — only failure is pre-existing unrelated `voice.test.ts` whisper model path mismatch from PR #92, not introduced by this change. NO_REPLY suite: 137/137 green.)
