import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, type ExecSyncOptions } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Paths to hook scripts (relative to repo root)
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PROTECT_FILES = join(REPO_ROOT, ".claude/hooks/protect-files.sh");
const GUARDIAN = join(REPO_ROOT, ".claude/hooks/guardian.sh");

// Temp workspace for guardian tests
const TMP_WORKSPACE = join(tmpdir(), "guardian-test-workspace");

function runHook(
  hookPath: string,
  input: object,
  env: Record<string, string> = {},
): { exitCode: number; stderr: string } {
  const opts: ExecSyncOptions = {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: "utf-8" as const,
    stdio: ["pipe", "pipe", "pipe"],
  };
  try {
    execSync(`bash "${hookPath}"`, opts);
    return { exitCode: 0, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status: number; stderr: string };
    return { exitCode: err.status, stderr: err.stderr || "" };
  }
}

// -------------------------------------------------------------------
// protect-files.sh
// -------------------------------------------------------------------

describe("protect-files.sh", () => {
  it("allows when CRON_NAME is not set", () => {
    const result = runHook(PROTECT_FILES, {
      tool_name: "Edit",
      tool_input: { file_path: "/workspace/.claude/skills/foo/SKILL.md" },
    });
    assert.equal(result.exitCode, 0);
  });

  it("allows non-skill files even with CRON_NAME set", () => {
    const result = runHook(
      PROTECT_FILES,
      {
        tool_name: "Write",
        tool_input: { file_path: "/workspace/memory/notes.md" },
      },
      { CRON_NAME: "nightly-consolidation" },
    );
    assert.equal(result.exitCode, 0);
  });

  it("blocks cron from writing to .claude/skills/", () => {
    const result = runHook(
      PROTECT_FILES,
      {
        tool_name: "Write",
        tool_input: {
          file_path: "/workspace/.claude/skills/workspace-health/SKILL.md",
        },
      },
      { CRON_NAME: "nightly-consolidation" },
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("Blocked"));
    assert.ok(result.stderr.includes("nightly-consolidation"));
  });

  it("blocks cron from editing .claude/skills/", () => {
    const result = runHook(
      PROTECT_FILES,
      {
        tool_name: "Edit",
        tool_input: {
          file_path: "/workspace/.claude/skills/workspace-health/SKILL.md",
        },
      },
      { CRON_NAME: "nightly-consolidation" },
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("Blocked"));
    assert.ok(result.stderr.includes("nightly-consolidation"));
  });

  it("allows when file_path is empty", () => {
    const result = runHook(PROTECT_FILES, {
      tool_name: "Write",
      tool_input: {},
    });
    assert.equal(result.exitCode, 0);
  });
});

// -------------------------------------------------------------------
// guardian.sh
// -------------------------------------------------------------------

describe("guardian.sh", () => {
  beforeEach(() => {
    rmSync(TMP_WORKSPACE, { recursive: true, force: true });
    mkdirSync(TMP_WORKSPACE, { recursive: true });

    // Create allowlist
    const allowlistDir = join(
      TMP_WORKSPACE,
      ".claude/skills/workspace-health/scripts",
    );
    mkdirSync(allowlistDir, { recursive: true });
    writeFileSync(
      join(allowlistDir, "orphan-allowlist.txt"),
      [
        "# Test allowlist",
        "memory",
        "reference",
        "bot",
        "*.md",
        ".claude",
      ].join("\n"),
    );

    // Create an existing file for overwrite tests
    mkdirSync(join(TMP_WORKSPACE, "bot/src"), { recursive: true });
    writeFileSync(join(TMP_WORKSPACE, "bot/src/existing.ts"), "export {};");
  });

  afterEach(() => {
    rmSync(TMP_WORKSPACE, { recursive: true, force: true });
  });

  it("allows Edit tool unconditionally", () => {
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Edit",
        tool_input: { file_path: join(TMP_WORKSPACE, "anything/file.ts") },
      },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 0);
  });

  it("allows overwrite of existing file", () => {
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(TMP_WORKSPACE, "bot/src/existing.ts"),
        },
      },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 0);
  });

  it("allows new file in listed root location", () => {
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Write",
        tool_input: { file_path: join(TMP_WORKSPACE, "memory/notes.md") },
      },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 0);
  });

  it("allows new file matching glob pattern", () => {
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Write",
        tool_input: { file_path: join(TMP_WORKSPACE, "CHANGELOG.md") },
      },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 0);
  });

  it("blocks new file in unlisted root location", () => {
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(TMP_WORKSPACE, "rogue-dir/evil.sh"),
        },
      },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("BLOCKED"));
    assert.ok(result.stderr.includes("rogue-dir"));
  });

  it("blocks path traversal attempts", () => {
    // Use string concatenation to preserve ".." (join() would resolve it)
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Write",
        tool_input: {
          file_path: TMP_WORKSPACE + "/memory/../evil/file.txt",
        },
      },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("traversal"));
  });

  it("allows files outside workspace", () => {
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Write",
        tool_input: { file_path: "/tmp/some-other-place/file.txt" },
      },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 0);
  });

  it("blocks Write without file_path", () => {
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Write",
        tool_input: {},
      },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("Write tool called without file_path"));
  });

  it("blocks when CLAUDE_PROJECT_DIR is not set", () => {
    // Explicitly set CLAUDE_PROJECT_DIR to empty to ensure it's unset,
    // regardless of what the test runner's process.env contains.
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Write",
        tool_input: { file_path: "/workspace/some/file.txt" },
      },
      { CLAUDE_PROJECT_DIR: "" },
    );
    // Should block because CLAUDE_PROJECT_DIR is empty
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("CLAUDE_PROJECT_DIR not set"));
  });

  it("blocks when allowlist is missing", () => {
    // Remove the allowlist file
    rmSync(
      join(
        TMP_WORKSPACE,
        ".claude/skills/workspace-health/scripts/orphan-allowlist.txt",
      ),
    );
    const result = runHook(
      GUARDIAN,
      {
        tool_name: "Write",
        tool_input: { file_path: join(TMP_WORKSPACE, "memory/test.md") },
      },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("allowlist not found"));
  });

  it("blocks when tool_name cannot be parsed", () => {
    const result = runHook(
      GUARDIAN,
      { tool_input: { file_path: "/some/path" } },
      { CLAUDE_PROJECT_DIR: TMP_WORKSPACE },
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("could not parse tool_name"));
  });
});
