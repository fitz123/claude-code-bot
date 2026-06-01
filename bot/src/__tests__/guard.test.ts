import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyToolCall,
  extractBashWriteTargets,
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

  it("extracts tee file args", () => {
    assert.deepStrictEqual(extractBashWriteTargets("cat a | tee out.txt"), ["out.txt"]);
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
