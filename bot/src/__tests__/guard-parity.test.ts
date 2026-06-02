import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyToolCall, type ClassifyOptions } from "../pi-extensions/guard.js";

// ---------------------------------------------------------------------------
// PARITY: the Pi-path classifier (`classifyToolCall` with an injected
// `writeAllowlist`) and the CLAUDE-path hook chain (`protect-files.sh` then
// `guardian.sh`) must reach the SAME allow/deny verdict for every path, driven
// by the SAME schema.md allow-list. This is the single-source-of-truth proof:
// the immutable-core deny-overlay, the three D17 line kinds, the `.claude/`
// split, and deny-by-default all match across both enforcers.
//
// The CLAUDE chain is run in the SAME order .claude/settings.json runs it
// (protect-files.sh = immutable deny, THEN guardian.sh = schema allow-check):
// a target is ALLOWED only if BOTH hooks exit 0; BLOCKED if EITHER exits
// non-zero — exactly the deny-overlay > allow > default-deny precedence the
// real session sees. The classifier collapses both halves into one call.
//
// Only write/edit targets are compared — NOT bash redirects: the claude path
// deliberately does not parse bash (the D16 tracked v1 known-gap), so a bash
// write would diverge by design. The bash coverage asymmetry is asserted in
// guard.test.ts (Pi side) instead.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PROTECT = join(REPO_ROOT, ".claude/hooks/protect-files.sh");
const GUARDIAN = join(REPO_ROOT, ".claude/hooks/guardian.sh");

// A CLEAN env (no inherited process.env) so no ambient WRITE_GUARD_BYPASS /
// PROTECT_FILES_BYPASS / CRON_NAME leaks in — only PATH (to find jq/git/bash)
// and the workspace root. Mirrors the bash harness's `env -i PATH=... ...`.
const CLEAN_ENV = { PATH: process.env.PATH ?? "" };

// The schema.md ```write-allowlist``` block (with #-comments to exercise the
// strip) and its post-strip equivalent fed to the classifier — the SAME list,
// proving both enforcers parse identically.
const WRITE_ALLOWLIST = [
  "memory/",
  "docs/",
  ".claude/rules/custom/",
  ".claude/skills/",
  "*.md",
  "schema.md",
] as const;

const SCHEMA_MD = [
  "# Workspace schema (parity fixture)",
  "",
  "Prose before the block is ignored.",
  "",
  "```write-allowlist",
  "memory/                  # narrative + auto memory",
  "docs/",
  ".claude/rules/custom/",
  ".claude/skills/",
  "*.md                     # root-level markdown only",
  "schema.md",
  "```",
  "",
].join("\n");

// Fixed path set: every D17 line kind + the .claude/ split + the full
// immutable core, each with its agreed verdict.
const CASES: ReadonlyArray<readonly [path: string, expected: "ALLOW" | "BLOCK"]> = [
  // D17 directory-prefix
  ["memory/notes.md", "ALLOW"],
  ["memory", "ALLOW"], // bare dir name matches its prefix line
  ["docs/guide.md", "ALLOW"],
  // D17 root-only glob
  ["top.md", "ALLOW"],
  ["sub/top.md", "BLOCK"], // *.md is root-only; nested + sub/ unregistered
  // D17 exact root-file
  ["schema.md", "ALLOW"],
  // .claude/ split — custom allowed, platform/hooks/health-scripts immutable
  [".claude/rules/custom/x.md", "ALLOW"],
  [".claude/rules/platform/x.md", "BLOCK"],
  [".claude/skills/custom/index.ts", "ALLOW"],
  [".claude/skills/workspace-health/scripts/x.ts", "BLOCK"],
  [".claude/hooks/x.sh", "BLOCK"],
  // immutable core — directory prefixes
  ["bot/src/x.ts", "BLOCK"],
  [".github/workflows/ci.yml", "BLOCK"],
  [".githooks/pre-commit", "BLOCK"],
  // immutable core — root-only-exact files (blocked even though *.md would allow)
  ["README.md", "BLOCK"],
  // Case-variant of an immutable file (APFS: README.MD == README.md). DISCRIMINATING:
  // `*.md` is allow-listed, so without case-folding in protect-files.sh the claude
  // chain would ALLOW this while the Pi path BLOCKs it — the exact divergence the
  // case-insensitive deny-overlay fix closes. Locks the "never unlockable" invariant.
  ["README.MD", "BLOCK"],
  [".gitleaks.toml", "BLOCK"],
  [".gitleaksignore", "BLOCK"],
  ["config.local.yaml.example", "BLOCK"],
  // immutable FILE entry is root-only-exact → docs/README.md is NOT immutable
  ["docs/README.md", "ALLOW"],
  // deny-by-default
  ["unregistered/x.txt", "BLOCK"],
];

/** Pi-path verdict via the pure classifier (write tool, injected allow-list). */
function piVerdict(rel: string, ws: string): "ALLOW" | "BLOCK" {
  const opts: ClassifyOptions = { workspaceRoot: ws, writeAllowlist: [...WRITE_ALLOWLIST] };
  return classifyToolCall({ toolName: "write", input: { path: rel } }, opts).block ? "BLOCK" : "ALLOW";
}

/** CLAUDE-path verdict via the full hook chain (protect-files.sh → guardian.sh). */
function chainVerdict(rel: string, ws: string): "ALLOW" | "BLOCK" {
  const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(ws, rel) } });
  const env = { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: ws };
  for (const hook of [PROTECT, GUARDIAN]) {
    const r = spawnSync("bash", [hook], { input, env, encoding: "utf8" });
    if (r.status !== 0) {
      return "BLOCK";
    }
  }
  return "ALLOW";
}

// Skip gracefully if the shell tooling the chain needs is unavailable.
const haveTools =
  spawnSync("bash", ["-c", "command -v jq >/dev/null 2>&1 && command -v git >/dev/null 2>&1"], {
    env: CLEAN_ENV,
  }).status === 0;

describe("guard PARITY: classifyToolCall vs protect-files.sh + guardian.sh", { skip: !haveTools }, () => {
  // Single throwaway workspace: a schema.md fixture, no git origin, not under
  // /.ralphex/worktrees/ → neither hook's bypass fires, the real checks run.
  const WS = mkdtempSync(join(tmpdir(), "guard-parity-"));
  writeFileSync(join(WS, "schema.md"), SCHEMA_MD);
  // No target files are created → guardian.sh never hits its overwrite
  // exemption and the classifier's default (nothing exists) matches.

  try {
    for (const [rel, expected] of CASES) {
      it(`${rel} → ${expected} (both enforcers agree)`, () => {
        const pi = piVerdict(rel, WS);
        const chain = chainVerdict(rel, WS);
        assert.equal(pi, chain, `parity mismatch for "${rel}": Pi=${pi}, claude-chain=${chain}`);
        assert.equal(pi, expected, `unexpected verdict for "${rel}"`);
      });
    }
  } finally {
    process.on("exit", () => rmSync(WS, { recursive: true, force: true }));
  }
});
