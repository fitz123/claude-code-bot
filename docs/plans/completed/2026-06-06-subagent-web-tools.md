# Plan: Allow Pi Subagents to Use Web Tools

Issue: https://github.com/fitz123/claude-code-bot/issues/145

Status note (2026-06-06): implemented in this branch. The final behavior keeps Pi crons guard-only, while subagent children load A1 guard + A2 web-tools and never load recursive A3 subagent.

## Goal

Allow Pi subagent children to use `web_search` and `web_fetch` while keeping the A1 write guard enforced and keeping recursive subagent spawning disabled.

## Context

Pre-change behavior:

- Parent Pi sessions load all first-party wrappers: `guardian-protect-files.ts`, `web-tools.ts`, and `subagent/index.ts`.
- Subagent children spawn with `--no-extensions` and an explicit child wrapper subset.
- `PI_SUBAGENT_CHILD_WRAPPER_RELPATHS` currently contains only `guardian-protect-files.ts`.
- Bundled subagent agents with explicit `tools:` allowlists (`scout`, `reviewer`, `planner`) do not list `web_search` / `web_fetch`, so even if web-tools are loaded they would not be allowed.

Desired behavior:

- Child subagents load the guard and web-tools.
- Child subagents do **not** load `subagent/index.ts`; recursive spawning stays disabled.
- Explicit bundled agent allowlists include `web_search` and `web_fetch`.
- It is acceptable that web tools return unavailable until the SOPS/Tavily secret resolver lands.

## Tasks

### Task 1: Child extension relpaths

- [x] Update `PI_SUBAGENT_CHILD_WRAPPER_RELPATHS` to include `guardian-protect-files.ts` and `web-tools.ts`.
- [x] Update nearby comments to explain: guard + web allowed, recursive subagent disabled.
- [x] Ensure `resolvePiExtensionArgs` still fail-closes if either required child wrapper is missing.

### Task 2: Bundled subagent tool allowlists

- [x] Add `web_search, web_fetch` to bundled `scout` frontmatter tools.
- [x] Add `web_search, web_fetch` to bundled `reviewer` frontmatter tools.
- [x] Add `web_search, web_fetch` to bundled `planner` frontmatter tools.
- [x] Leave `worker` unchanged; it has no explicit allowlist.

### Task 3: Tests and validation

- [x] Update Pi extension loading tests to expect guard + web-tools for subagent children and no recursive subagent wrapper.
- [x] Add/adjust tests for subagent spawn args or bundled agent discovery so explicit allowlists expose web tools.
- [x] Run validation from `bot/`: `npm test`, `npm run lint`, `npm run build`.
- [x] Run repository checks: `git diff --check`, `gitleaks protect --staged --no-banner`.

## Acceptance Criteria

- Subagent child spawn includes `--extension <guardian>` and `--extension <web-tools>`.
- Subagent child spawn does not include `subagent/index.ts`.
- Scout/reviewer/planner can call `web_search` and `web_fetch` when the child process has a working Tavily secret.
- Existing write guard behavior remains covered.
- Full test/lint/build validation passes.
