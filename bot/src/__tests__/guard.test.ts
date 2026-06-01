import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyToolCall,
  extractBashWriteTargets,
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
  it("is exactly the 4 upstream-owned prefixes the plan/criterion 2 names", () => {
    assert.deepStrictEqual(
      [...PROTECTED_PREFIXES],
      ["bot/", ".claude/rules/platform/", ".github/workflows/", ".githooks/"],
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
    assert.equal(block({ toolName: "write", input: { path: "README.md", content: "" } }, orphan), false); // *.md
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
