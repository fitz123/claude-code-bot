---
paths:
  - bot/**
  - .claude/hooks/**
  - .claude/rules/platform/**
  - .claude/skills/workspace-health/scripts/**
  - .github/workflows/**
  - .githooks/**
  - .gitleaks.toml
  - .gitleaksignore
  - CLAUDE.md
  - README.md
  - config.yaml
  - config.local.yaml.example
---

# Bot & Platform Files — Read-Only in Workspace

These files come from upstream (`fitz123/claude-code-bot`). Never edit them here.

To change: PR in public repo (`~/src/claude-code-bot/`) → merge → `git fetch upstream && git merge upstream/main` in workspace.

The `paths:` list above is the canonical set of upstream-owned paths. Any local edit to these breaks the next `git merge upstream/main` (divergence/conflicts) and risks losing your change. The `protect-files.sh` hook only blocks `.claude/skills/**` writes from crons — it does **not** enforce this rule for interactive sessions. Self-discipline carries the load here.

Workspace-only files (USER.md, IDENTITY.md, MEMORY.md, memory/, .claude/rules/custom/, .claude/skills/ outside upstream-tracked names, reference/, docs/, scripts/) are safe to edit locally.
