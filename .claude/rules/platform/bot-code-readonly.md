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

The `paths:` list above is the canonical set of upstream-owned paths. Any local edit to these breaks the next `git merge upstream/main` (divergence/conflicts) and risks losing your change. The `protect-files.sh` hook enforces this list for **all** sessions — `Edit`/`Write` on a matching path fails fast with a pointer back to this rule.

These same 10 paths form the **immutable core** (deny-overlay) of the schema-enforced write-guard. Both enforcers — `guard.ts` (Pi path, `PROTECTED_PREFIXES`) and the `protect-files.sh` / `guardian.sh` chain (claude path) — hardcode the full 10 and check them *before* the `schema.md` allow-list, so the deny-overlay always wins (deny-overlay > allow > default-deny) and these paths can never be unlocked via `schema.md`. `guard.ts` now pins all 10 (previously a narrowed 4). The directory entries (trailing slash) match as path-prefixes; the four file entries (`.gitleaks.toml`, `.gitleaksignore`, `README.md`, `config.local.yaml.example`) match root-only-exact — e.g. `README.md` blocks the root file but not `docs/README.md`. Matching is **case-insensitive** in all three enforcers (`guard.ts`, `protect-files.sh`, `guardian.sh`) — on case-insensitive APFS `README.MD` is the same file as `README.md`, so a case-variant cannot slip past the deny-overlay.

One deliberate claude-path vs Pi-path asymmetry: the `guardian.sh` schema allow-check only gates the creation of **new** files — an `Edit`, or a `Write` to an already-existing non-immutable file, is exempt (overwrite is allowed). The Pi classifier (`guard.ts`) has no such overwrite exemption. The immutable core is unaffected (it always blocks, whether the file exists or not), so this narrows only the *deny-by-default* half on the claude path — consistent with the anti-drift / footgun-prevention threat model (not a defense against a malicious agent).

Files that **look upstream but are workspace-local** (excluded from the list above) and ARE safe to edit:

- `CLAUDE.md` — `.gitattributes merge=ours` keeps your local version on merge.
- `config.yaml`, `config.local.yaml` — each workspace has its own bindings/agents.
- `USER.md`, `IDENTITY.md`, `MEMORY.md`, `memory/`, `.claude/rules/custom/`, `.claude/skills/` (outside upstream-tracked names), `reference/`, `docs/`, `scripts/`.
