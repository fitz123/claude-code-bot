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
  - README.md
  - config.local.yaml.example
---

# Bot & Platform Files — Read-Only in Workspace

These files come from upstream (`fitz123/claude-code-bot`). Never edit them here.

To change: PR in public repo (`~/src/claude-code-bot/`) → merge → `git fetch upstream && git merge upstream/main` in workspace.

The `paths:` list above is the canonical set of upstream-owned paths. Any local edit to these breaks the next `git merge upstream/main` (divergence/conflicts) and risks losing your change. The current `protect-files.sh` hook may still enforce this list for Claude-path source-checkout sessions, but ADR-081 treats that hook as legacy/deferred and not as bot package-runtime contract.

Legacy/deferred guard-era behavior: these same 10 paths formed the immutable core deny-overlay of the schema-enforced write guard. The Pi `guardian-protect-files` path and the Claude `protect-files.sh` / `guardian.sh` chain checked them before the `schema.md` allow-list. ADR-081 retires `guardian-protect-files`, `schema.md`, write-allowlist parsing, and immutable-core package claims from runtime/package correctness; Task 2 owns public artifact removal or rewrite, and Task 8 owns private-production cleanup notes.

Legacy/deferred Claude-path asymmetry: `guardian.sh` only gates creation of new files, while the old Pi guard had no overwrite exemption. Do not add new behavior that depends on this asymmetry; it is part of the retired guard contract.

Files that **look upstream but are workspace-local** (excluded from the list above) and ARE safe to edit:

- `CLAUDE.md` — `.gitattributes merge=ours` keeps your local version on merge.
- `config.yaml`, `config.local.yaml` — each workspace has its own bindings/agents.
- `USER.md`, `IDENTITY.md`, `MEMORY.md`, `memory/`, `.claude/rules/custom/`, `.claude/skills/` (outside upstream-tracked names), `reference/`, `docs/`, `scripts/`.
