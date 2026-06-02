import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyToolCall,
  extractBashWriteTargets,
  isAllowedPath,
  isAllowedRootComponent,
  isProtectedPath,
  PROTECTED_PREFIXES,
  type ClassifyOptions,
  type ToolCallLike,
} from "../pi-extensions/guard.js";

const WS = "/ws";
const inWs: ClassifyOptions = { workspaceRoot: WS };

function block(call: ToolCallLike, opts: ClassifyOptions = inWs): boolean {
  return classifyToolCall(call, opts).block;
}

describe("guard: PROTECTED_PREFIXES (pinned canonical set)", () => {
  it("is exactly the 10 upstream-owned immutable-core paths (6 dirs + 4 root files)", () => {
    assert.deepStrictEqual(
      [...PROTECTED_PREFIXES],
      [
        "bot/",
        ".claude/hooks/",
        ".claude/rules/platform/",
        ".claude/skills/workspace-health/scripts/",
        ".github/workflows/",
        ".githooks/",
        ".gitleaks.toml",
        ".gitleaksignore",
        "README.md",
        "config.local.yaml.example",
      ],
    );
  });
});

describe("guard: isProtectedPath", () => {
  it("matches files inside each protected prefix", () => {
    assert.equal(isProtectedPath("bot/src/index.ts"), true);
    assert.equal(isProtectedPath(".claude/rules/platform/safety.md"), true);
    assert.equal(isProtectedPath(".github/workflows/ci.yml"), true);
    assert.equal(isProtectedPath(".githooks/pre-commit"), true);
  });

  it("matches the bare protected directory name itself", () => {
    assert.equal(isProtectedPath("bot"), true);
    assert.equal(isProtectedPath(".githooks"), true);
  });

  it("is case-insensitive (APFS bug fix)", () => {
    assert.equal(isProtectedPath("BOT/src/index.ts"), true);
    assert.equal(isProtectedPath(".GitHub/Workflows/ci.yml"), true);
  });

  it("does NOT match workspace-local / sibling paths", () => {
    assert.equal(isProtectedPath("memory/notes.md"), false);
    assert.equal(isProtectedPath(".claude/rules/custom/my-rule.md"), false);
    assert.equal(isProtectedPath(".claude/skills/foo/SKILL.md"), false);
    assert.equal(isProtectedPath("reference/x.md"), false);
  });

  it("does NOT match prefixes as mere substrings of a longer segment", () => {
    assert.equal(isProtectedPath("botanical/x.ts"), false);
    assert.equal(isProtectedPath("robot/x.ts"), false);
  });
});

describe("guard: isProtectedPath — immutable core (file-vs-dir matching, 10-set)", () => {
  it("matches the new directory-prefix entries", () => {
    assert.equal(isProtectedPath(".claude/hooks/guardian.sh"), true);
    assert.equal(isProtectedPath(".claude/hooks"), true); // bare dir name
    assert.equal(isProtectedPath(".claude/skills/workspace-health/scripts/check.sh"), true);
  });

  it("matches root-only FILE entries EXACTLY (no prefix match)", () => {
    assert.equal(isProtectedPath("README.md"), true);
    assert.equal(isProtectedPath(".gitleaks.toml"), true);
    assert.equal(isProtectedPath(".gitleaksignore"), true);
    assert.equal(isProtectedPath("config.local.yaml.example"), true);
  });

  it("does NOT match a same-named file in a subdirectory (root-only-exact)", () => {
    assert.equal(isProtectedPath("docs/README.md"), false);
    assert.equal(isProtectedPath("sub/config.local.yaml.example"), false);
    // a file entry never prefix-matches a longer path
    assert.equal(isProtectedPath("README.md/evil"), false);
  });

  it("folds case for both dir and file entries (APFS)", () => {
    assert.equal(isProtectedPath("readme.md"), true);
    assert.equal(isProtectedPath(".GitLeaks.TOML"), true);
    assert.equal(isProtectedPath(".CLAUDE/HOOKS/x.sh"), true);
  });

  it("does NOT match .claude/skills/ siblings outside the protected scripts dir", () => {
    assert.equal(isProtectedPath(".claude/skills/custom/index.ts"), false);
    assert.equal(isProtectedPath(".claude/skills/workspace-health/SKILL.md"), false);
  });
});

describe("guard: write/edit into immutable-core file entries", () => {
  it("blocks write into the root README.md but allows docs/README.md", () => {
    assert.equal(block({ toolName: "write", input: { path: "README.md", content: "" } }), true);
    assert.equal(block({ toolName: "write", input: { path: "docs/README.md", content: "" } }), false);
  });

  it("blocks write/edit into .claude/hooks/ and the workspace-health scripts dir", () => {
    assert.equal(block({ toolName: "write", input: { path: ".claude/hooks/x.sh", content: "" } }), true);
    assert.equal(
      block(
        { toolName: "edit", input: { path: ".claude/skills/workspace-health/scripts/x.sh", oldText: "a", newText: "b" } },
      ),
      true,
    );
  });

  it("blocks write into the root gitleaks config + example files", () => {
    assert.equal(block({ toolName: "write", input: { path: ".gitleaks.toml", content: "" } }), true);
    assert.equal(block({ toolName: "write", input: { path: "config.local.yaml.example", content: "" } }), true);
  });
});

describe("guard: write/edit into protected paths", () => {
  it("blocks write into bot/ (relative)", () => {
    assert.equal(block({ toolName: "write", input: { path: "bot/src/x.ts", content: "" } }), true);
  });

  it("blocks edit into .claude/rules/platform/", () => {
    assert.equal(
      block({ toolName: "edit", input: { path: ".claude/rules/platform/safety.md", oldText: "a", newText: "b" } }),
      true,
    );
  });

  it("blocks write via an absolute path that lands inside the workspace's bot/", () => {
    assert.equal(block({ toolName: "write", input: { path: `${WS}/bot/src/x.ts`, content: "" } }), true);
  });

  it("blocks write via APFS-cased path (BOT/)", () => {
    assert.equal(block({ toolName: "write", input: { path: "BOT/src/x.ts", content: "" } }), true);
  });

  it("blocks an absolute path whose workspace-root prefix case-varies (APFS containment fix)", () => {
    // On APFS `/WS/bot/x` IS the same file as `/ws/bot/x`. A case-sensitive
    // `relative()` would classify it as an escaping outside-the-workspace path
    // and (being absolute) allow it — bypassing the protected `bot/` check.
    assert.equal(block({ toolName: "write", input: { path: `${WS.toUpperCase()}/bot/src/x.ts`, content: "" } }), true);
    assert.equal(block({ toolName: "bash", input: { command: `echo x > ${WS.toUpperCase()}/bot/y.ts` } }), true);
  });

  it("blocks write that normalizes back into bot/ via `..` (traversal bug fix)", () => {
    assert.equal(block({ toolName: "write", input: { path: "bot/../bot/src/x.ts", content: "" } }), true);
  });

  it("allows write into a workspace-local, non-protected path", () => {
    assert.equal(block({ toolName: "write", input: { path: "memory/notes.md", content: "" } }), false);
    assert.equal(block({ toolName: "edit", input: { path: ".claude/rules/custom/r.md", oldText: "a", newText: "b" } }), false);
  });

  it("includes a helpful reason pointing at the upstream rule", () => {
    const d = classifyToolCall({ toolName: "write", input: { path: "bot/x.ts", content: "" } }, inWs);
    assert.equal(d.block, true);
    assert.match(d.reason ?? "", /bot-code-readonly\.md/);
  });
});

describe("guard: workspace-structure (traversal escape)", () => {
  it("blocks a relative write that escapes the workspace via `..`", () => {
    assert.equal(block({ toolName: "write", input: { path: "../outside/x", content: "" } }), true);
    assert.equal(block({ toolName: "write", input: { path: "bot/../../etc/x", content: "" } }), true);
  });

  it("the escape reason names a workspace-structure violation", () => {
    const d = classifyToolCall({ toolName: "write", input: { path: "../escape", content: "" } }, inWs);
    assert.match(d.reason ?? "", /workspace-structure/);
  });

  it("allows an absolute write that simply lives outside the workspace (legacy parity)", () => {
    assert.equal(block({ toolName: "write", input: { path: "/tmp/scratch.txt", content: "" } }), false);
  });
});

describe("guard: isAllowedRootComponent (orphan allowlist match)", () => {
  const list = ["memory", "scripts", ".claude", "*.md", "*.sh"];
  it("matches exact directory names and file globs (case-insensitively)", () => {
    assert.equal(isAllowedRootComponent("memory", list), true);
    assert.equal(isAllowedRootComponent("Memory", list), true);
    assert.equal(isAllowedRootComponent("notes.md", list), true);
    assert.equal(isAllowedRootComponent("run.sh", list), true);
    assert.equal(isAllowedRootComponent(".claude", list), true);
  });
  it("rejects names not in the allowlist", () => {
    assert.equal(isAllowedRootComponent("rogue-dir", list), false);
    assert.equal(isAllowedRootComponent("evil", list), false);
    assert.equal(isAllowedRootComponent("notes.txt", list), false);
  });
});

describe("guard: isAllowedPath (schema write-allowlist — three D17 line kinds)", () => {
  const list = ["memory/", "reference/", ".claude/rules/custom/", ".claude/skills/", "*.md", "MEMORY.md"];

  it("directory-prefix matches the bare dir name and anything under it", () => {
    assert.equal(isAllowedPath("memory", list), true);
    assert.equal(isAllowedPath("memory/notes.md", list), true);
    assert.equal(isAllowedPath("memory/sub/deep.txt", list), true);
    assert.equal(isAllowedPath(".claude/rules/custom/r.md", list), true);
    assert.equal(isAllowedPath(".claude/skills/custom/index.ts", list), true);
  });

  it("directory-prefix does NOT match a longer sibling segment", () => {
    assert.equal(isAllowedPath("memorystuff/x", list), false);
    assert.equal(isAllowedPath("reference-old/x", list), false);
  });

  it("root-only glob matches ONLY root-level files (no slash in path)", () => {
    assert.equal(isAllowedPath("notes.md", list), true);
    assert.equal(isAllowedPath("README.md", list), true); // *.md matches at root
    assert.equal(isAllowedPath("docs/guide.md", list), false); // not root level
  });

  it("exact-root-file matches that exact relative path only", () => {
    assert.equal(isAllowedPath("MEMORY.md", list), true);
    assert.equal(isAllowedPath("sub/MEMORY.md", list), false);
  });

  it("is case-insensitive (APFS)", () => {
    assert.equal(isAllowedPath("Memory/Notes.MD", list), true);
    assert.equal(isAllowedPath("memory.md", list), true); // *.md
  });

  it("an empty allow-list matches nothing (fail-closed substrate)", () => {
    assert.equal(isAllowedPath("memory/notes.md", []), false);
    assert.equal(isAllowedPath("anything.md", []), false);
  });
});

describe("guard: deny-by-default allow-check (schema writeAllowlist model)", () => {
  const ALLOW = ["memory/", "reference/", "docs/", ".claude/rules/custom/", ".claude/skills/", "*.md"];
  const schema: ClassifyOptions = { workspaceRoot: WS, writeAllowlist: ALLOW };

  it("BLOCKS a write whose path matches no allow line, naming schema.md", () => {
    assert.equal(block({ toolName: "write", input: { path: "unregistered/x.ts", content: "" } }, schema), true);
    const d = classifyToolCall({ toolName: "write", input: { path: "unregistered/x.ts", content: "" } }, schema);
    assert.match(d.reason ?? "", /schema\.md/);
    assert.match(d.reason ?? "", /unregistered/);
    assert.match(d.reason ?? "", /write-allowlist/);
  });

  it("ALLOWS a write whose path matches an allow line", () => {
    assert.equal(block({ toolName: "write", input: { path: "memory/x.md", content: "" } }, schema), false);
    assert.equal(block({ toolName: "edit", input: { path: ".claude/rules/custom/r.md", oldText: "a", newText: "b" } }, schema), false);
    // .claude/ split: custom skills dir is allowed (only the workspace-health
    // scripts subdir is immutable), and .claude/rules/custom/ is allowed.
    assert.equal(block({ toolName: "write", input: { path: ".claude/skills/custom/index.ts", content: "" } }, schema), false);
    assert.equal(block({ toolName: "write", input: { path: ".claude/rules/custom/x.md", content: "" } }, schema), false);
  });

  it("immutable core wins over a matching allow line (precedence)", () => {
    // README.md is immutable-core (root-only-exact) yet `*.md` would allow it.
    assert.equal(block({ toolName: "write", input: { path: "README.md", content: "" } }, schema), true);
    // .claude/skills/ is allowed, but the workspace-health scripts subdir is immutable.
    assert.equal(
      block({ toolName: "write", input: { path: ".claude/skills/workspace-health/scripts/x.ts", content: "" } }, schema),
      true,
    );
    // .claude/rules/platform/ is immutable even though .claude/rules/custom/ is allowed.
    assert.equal(block({ toolName: "write", input: { path: ".claude/rules/platform/x.md", content: "" } }, schema), true);
  });

  it("immutable FILE entry is root-only-exact — docs/README.md is allowed when docs/ is", () => {
    assert.equal(block({ toolName: "write", input: { path: "docs/README.md", content: "" } }, schema), false);
  });

  it("applies to bash write targets too (not just write/edit)", () => {
    assert.equal(block({ toolName: "bash", input: { command: "echo x > unregistered/y" } }, schema), true);
    assert.equal(block({ toolName: "bash", input: { command: "echo x > memory/y.md" } }, schema), false);
  });

  it("fail-safe: an EMPTY allow-list denies everything non-immutable (fail-closed)", () => {
    const empty: ClassifyOptions = { workspaceRoot: WS, writeAllowlist: [] };
    // immutable core still blocks
    assert.equal(block({ toolName: "write", input: { path: "bot/x.ts", content: "" } }, empty), true);
    // everything else fails closed
    assert.equal(block({ toolName: "write", input: { path: "memory/x.md", content: "" } }, empty), true);
    const d = classifyToolCall({ toolName: "write", input: { path: "memory/x.md", content: "" } }, empty);
    assert.match(d.reason ?? "", /fail-closed/);
    assert.match(d.reason ?? "", /schema\.md/);
    assert.match(d.reason ?? "", /PI_EXTENSIONS_DISABLED=1/);
  });

  it("undefined writeAllowlist → deny-by-default OFF (legacy behavior preserved)", () => {
    // No writeAllowlist injected → non-protected workspace paths are allowed.
    assert.equal(block({ toolName: "write", input: { path: "memory/x.md", content: "" } }, inWs), false);
    assert.equal(block({ toolName: "write", input: { path: "unregistered/x.ts", content: "" } }, inWs), false);
  });

  it("preserves traversal-escape and outside-workspace handling under the schema model", () => {
    // relative escape still blocked
    assert.equal(block({ toolName: "write", input: { path: "../escape.md", content: "" } }, schema), true);
    // absolute path outside the workspace still allowed (not governed by the allow-list)
    assert.equal(block({ toolName: "write", input: { path: "/tmp/scratch.txt", content: "" } }, schema), false);
  });

  it("subagent child: schema allow-check stays anchored at the parent workspace root", () => {
    const childSchema: ClassifyOptions = { workspaceRoot: WS, resolveRoot: "/tmp", writeAllowlist: ALLOW };
    // absolute write into an unregistered parent path → blocked
    assert.equal(block({ toolName: "write", input: { path: `${WS}/unregistered/x.ts`, content: "" } }, childSchema), true);
    // absolute write into an allowed parent path → allowed
    assert.equal(block({ toolName: "write", input: { path: `${WS}/memory/x.md`, content: "" } }, childSchema), false);
    // genuine relative write under the child's own cwd, outside parent → allowed
    assert.equal(block({ toolName: "write", input: { path: "out.txt", content: "" } }, childSchema), false);
  });
});

describe("guard: guardian orphan check (workspace-structure rule, guardian.sh parity)", () => {
  const ALLOWLIST = ["memory", "scripts", ".claude", "*.md", "*.sh"];
  // Default: nothing exists → every write is a NEW entry.
  const orphan: ClassifyOptions = { workspaceRoot: WS, orphanAllowlist: ALLOWLIST, fileExists: () => false };

  it("blocks a write creating a NEW root-level entry not in the allowlist", () => {
    assert.equal(block({ toolName: "write", input: { path: "rogue-dir/evil.sh", content: "" } }, orphan), true);
    const d = classifyToolCall({ toolName: "write", input: { path: "rogue-dir/evil.sh", content: "" } }, orphan);
    assert.match(d.reason ?? "", /orphan-allowlist/);
    assert.match(d.reason ?? "", /rogue-dir/);
  });

  it("allows writes whose root component IS in the allowlist", () => {
    assert.equal(block({ toolName: "write", input: { path: "memory/notes.md", content: "" } }, orphan), false);
    assert.equal(block({ toolName: "write", input: { path: "scripts/run.sh", content: "" } }, orphan), false);
    // NOTES.md (a root *.md that is NOT in the immutable core — README.md now is).
    assert.equal(block({ toolName: "write", input: { path: "NOTES.md", content: "" } }, orphan), false); // *.md
  });

  it("allows an OVERWRITE of an existing entry even if its root is not allowlisted", () => {
    const overwrite: ClassifyOptions = { workspaceRoot: WS, orphanAllowlist: ALLOWLIST, fileExists: () => true };
    assert.equal(block({ toolName: "write", input: { path: "rogue-dir/evil.sh", content: "" } }, overwrite), false);
  });

  it("applies ONLY to the write tool — edit and bash are out of guardian.sh's scope", () => {
    assert.equal(block({ toolName: "edit", input: { path: "rogue-dir/evil.sh", oldText: "a", newText: "b" } }, orphan), false);
    assert.equal(block({ toolName: "bash", input: { command: "echo x > rogue-dir/evil.sh" } }, orphan), false);
  });

  it("is DISABLED when no allowlist is injected (security prefixes still apply)", () => {
    assert.equal(block({ toolName: "write", input: { path: "rogue-dir/evil.sh", content: "" } }, inWs), false);
  });

  it("protected-prefix and traversal checks still win over the orphan check", () => {
    assert.equal(block({ toolName: "write", input: { path: "bot/x.ts", content: "" } }, orphan), true);
    assert.equal(block({ toolName: "write", input: { path: "../escape.sh", content: "" } }, orphan), true);
  });
});

describe("guard: subagent child cwd (immutable protection root vs relative resolve root)", () => {
  // A subagent child is spawned with a caller-controlled cwd; protection MUST stay
  // anchored at the PARENT workspace (workspaceRoot) while relative targets resolve
  // against the child's real cwd (resolveRoot). Without this, `cwd:"/tmp"` + an
  // absolute write back into `<ws>/bot/x` would resolve outside `/tmp` and bypass A1.
  const childInTmp: ClassifyOptions = { workspaceRoot: WS, resolveRoot: "/tmp" };

  it("blocks an ABSOLUTE write into the parent's protected bot/ even when the child cwd is elsewhere", () => {
    assert.equal(block({ toolName: "write", input: { path: `${WS}/bot/x.ts`, content: "" } }, childInTmp), true);
    assert.equal(block({ toolName: "bash", input: { command: `echo x > ${WS}/bot/y.ts` } }, childInTmp), true);
  });

  it("blocks a RELATIVE write that climbs from the child cwd back into the protected tree", () => {
    // resolves to /ws/bot/x.ts via `..` from /tmp → caught as a traversal escape.
    assert.equal(block({ toolName: "bash", input: { command: "echo x > ../ws/bot/x.ts" } }, childInTmp), true);
  });

  it("allows a genuine relative write under the child's own cwd (no over-block)", () => {
    assert.equal(block({ toolName: "write", input: { path: "out.txt", content: "" } }, childInTmp), false);
    assert.equal(block({ toolName: "bash", input: { command: "echo x > out.txt" } }, childInTmp), false);
  });

  it("allows an absolute write under the child's own cwd, outside the parent workspace", () => {
    assert.equal(block({ toolName: "write", input: { path: "/tmp/out.txt", content: "" } }, childInTmp), false);
  });

  it("orphan check stays anchored at the parent workspace root", () => {
    const orphanChild: ClassifyOptions = {
      workspaceRoot: WS,
      resolveRoot: "/tmp",
      orphanAllowlist: ["memory", "*.md"],
      fileExists: () => false,
    };
    // Absolute write creating a NEW root-level entry in the parent workspace → blocked.
    assert.equal(block({ toolName: "write", input: { path: `${WS}/rogue/evil.sh`, content: "" } }, orphanChild), true);
    // Absolute write into an allowlisted parent root component → allowed.
    assert.equal(block({ toolName: "write", input: { path: `${WS}/memory/n.md`, content: "" } }, orphanChild), false);
  });
});

describe("guard: fail-closed", () => {
  it("blocks write/edit with a missing or non-string path", () => {
    assert.equal(block({ toolName: "write", input: {} }), true);
    assert.equal(block({ toolName: "edit", input: { path: 123 as unknown as string } }), true);
    assert.equal(block({ toolName: "write", input: undefined }), true);
  });

  it("blocks ANY write when the workspace root is unknown (fail-CLOSED unknown root)", () => {
    const noRoot: ClassifyOptions = { workspaceRoot: undefined };
    assert.equal(block({ toolName: "write", input: { path: "bot/x", content: "" } }, noRoot), true);
    // Even an otherwise-allowed path is blocked — we cannot verify it without a root.
    assert.equal(block({ toolName: "write", input: { path: "memory/x", content: "" } }, noRoot), true);
    assert.equal(block({ toolName: "write", input: { path: "bot/x", content: "" } }, { workspaceRoot: "   " }), true);
  });
});

describe("guard: read-only / non-writing tools pass", () => {
  it("allows read/grep/find/ls and custom tools, even on protected paths", () => {
    assert.equal(block({ toolName: "read", input: { path: "bot/secret.ts" } }), false);
    assert.equal(block({ toolName: "grep", input: { pattern: "x", path: "bot" } }), false);
    assert.equal(block({ toolName: "find", input: { pattern: "*.ts" } }), false);
    assert.equal(block({ toolName: "ls", input: { path: "bot" } }), false);
    assert.equal(block({ toolName: "web_search", input: { query: "bot/" } }), false);
  });
});

describe("guard: bash redirect/tee/mv/cp coverage (bash-hook bug fix)", () => {
  it("blocks `>` and `>>` redirects into a protected path", () => {
    assert.equal(block({ toolName: "bash", input: { command: "echo hi > bot/x.ts" } }), true);
    assert.equal(block({ toolName: "bash", input: { command: "echo hi >> .githooks/pre-commit" } }), true);
  });

  it("blocks `tee` into a protected path (incl. through a pipe)", () => {
    assert.equal(block({ toolName: "bash", input: { command: "cat a | tee bot/y.ts" } }), true);
  });

  it("blocks `mv` and `cp` into a protected path", () => {
    assert.equal(block({ toolName: "bash", input: { command: "mv evil.ts bot/z.ts" } }), true);
    assert.equal(block({ toolName: "bash", input: { command: "cp evil.ts bot/z.ts" } }), true);
  });

  it("blocks the `>|` clobber redirect into a protected path", () => {
    assert.equal(block({ toolName: "bash", input: { command: "echo hi >| bot/x.ts" } }), true);
  });

  it("blocks `cp -t DIR` (GNU target-directory) into a protected path", () => {
    assert.equal(block({ toolName: "bash", input: { command: "cp -t bot evil1.ts evil2.ts" } }), true);
    assert.equal(block({ toolName: "bash", input: { command: "cp --target-directory=bot evil.ts" } }), true);
  });

  it("blocks clustered `cp -vt DIR` short-flag forms into a protected path", () => {
    assert.equal(block({ toolName: "bash", input: { command: "cp -vt bot a b" } }), true);
    assert.equal(block({ toolName: "bash", input: { command: "cp -vtbot a b" } }), true);
  });

  it("blocks `mv` whose SOURCE is protected (mv deletes the source)", () => {
    assert.equal(block({ toolName: "bash", input: { command: "mv bot/x.ts /tmp/y.ts" } }), true);
  });

  it("neutralizes the `\\cp` alias-bypass via the lexer", () => {
    assert.equal(block({ toolName: "bash", input: { command: "\\cp evil.ts bot/z.ts" } }), true);
  });

  it("classifies the wrapped command through sudo/nohup", () => {
    assert.equal(block({ toolName: "bash", input: { command: "sudo tee bot/x.ts" } }), true);
    assert.equal(block({ toolName: "bash", input: { command: "nohup cp evil bot/z.ts" } }), true);
  });

  it("sees past wrapper OPTIONS and post-`env` VAR= assignments to the real command", () => {
    assert.equal(block({ toolName: "bash", input: { command: "sudo -n tee bot/x.ts" } }), true);
    assert.equal(block({ toolName: "bash", input: { command: "env FOO=bar tee bot/x.ts" } }), true);
    assert.equal(block({ toolName: "bash", input: { command: "env -i tee bot/x.ts" } }), true);
    assert.equal(block({ toolName: "bash", input: { command: "sudo -n nohup cp evil bot/z.ts" } }), true);
  });

  it("allows bash with no write target or writing outside the workspace", () => {
    assert.equal(block({ toolName: "bash", input: { command: "echo hello world" } }), false);
    assert.equal(block({ toolName: "bash", input: { command: "echo x > /tmp/log.txt" } }), false);
    assert.equal(block({ toolName: "bash", input: { command: "grep -r foo bot/" } }), false);
    assert.equal(block({ toolName: "bash", input: { command: "cat bot/x.ts" } }), false);
  });
});

describe("guard: extractBashWriteTargets", () => {
  it("extracts redirect targets", () => {
    assert.deepStrictEqual(extractBashWriteTargets("echo hi > bot/x"), ["bot/x"]);
    assert.deepStrictEqual(extractBashWriteTargets("echo hi >> a/b"), ["a/b"]);
  });

  it("extracts the `>|` clobber-redirect target", () => {
    assert.deepStrictEqual(extractBashWriteTargets("echo hi >| bot/x"), ["bot/x"]);
  });

  it("extracts the `cp -t DIR` target directory in all flag forms", () => {
    assert.deepStrictEqual(extractBashWriteTargets("cp -t bot a b"), ["bot"]);
    assert.deepStrictEqual(extractBashWriteTargets("cp -tbot a b"), ["bot"]);
    assert.deepStrictEqual(extractBashWriteTargets("cp --target-directory=bot a b"), ["bot"]);
    assert.deepStrictEqual(extractBashWriteTargets("cp --target-directory bot a b"), ["bot"]);
  });

  it("extracts the target directory from clustered short flags (`-vt`)", () => {
    assert.deepStrictEqual(extractBashWriteTargets("cp -vt bot a b"), ["bot"]);
    assert.deepStrictEqual(extractBashWriteTargets("cp -vtbot a b"), ["bot"]);
  });

  it("extracts tee file args", () => {
    assert.deepStrictEqual(extractBashWriteTargets("cat a | tee out.txt"), ["out.txt"]);
  });

  it("finds the write target past wrapper options and post-`env` assignments", () => {
    assert.deepStrictEqual(extractBashWriteTargets("env FOO=bar tee out.txt"), ["out.txt"]);
    assert.deepStrictEqual(extractBashWriteTargets("sudo -n tee out.txt"), ["out.txt"]);
    assert.deepStrictEqual(extractBashWriteTargets("env -i tee out.txt"), ["out.txt"]);
    // A bare command whose own first arg is a flag still resolves correctly.
    assert.deepStrictEqual(extractBashWriteTargets("tee -a out.txt"), ["out.txt"]);
  });

  it("treats every mv arg (sources + dest) as a target, but only cp's dest", () => {
    assert.deepStrictEqual(extractBashWriteTargets("mv s1 s2 dest"), ["s1", "s2", "dest"]);
    assert.deepStrictEqual(extractBashWriteTargets("cp s1 s2 dest"), ["dest"]);
  });

  it("ignores an fd designator before a redirect (the `2` in `2>`)", () => {
    assert.deepStrictEqual(extractBashWriteTargets("echo x 2> err.log"), ["err.log"]);
  });

  it("unwraps a quoted redirect target", () => {
    assert.deepStrictEqual(extractBashWriteTargets('echo x > "bot/quoted file.ts"'), ["bot/quoted file.ts"]);
  });

  it("returns no targets for a read-only command", () => {
    assert.deepStrictEqual(extractBashWriteTargets("grep -r foo bot/"), []);
    assert.deepStrictEqual(extractBashWriteTargets("echo hello"), []);
  });
});
