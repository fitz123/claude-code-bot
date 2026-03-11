import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCronTask, getAgentWorkspace, shellEscape } from "../cron-runner.js";

// We test the pure functions. runClaude and deliver require real claude/Telegram.

const TEST_DIR = join("/tmp", "cron-runner-test-" + Date.now());

describe("cron-runner", () => {
  describe("shellEscape", () => {
    it("escapes simple strings", () => {
      assert.strictEqual(shellEscape("hello"), "'hello'");
    });

    it("escapes strings with single quotes", () => {
      assert.strictEqual(shellEscape("it's"), "'it'\\''s'");
    });

    it("escapes strings with spaces", () => {
      assert.strictEqual(shellEscape("hello world"), "'hello world'");
    });

    it("escapes empty string", () => {
      assert.strictEqual(shellEscape(""), "''");
    });

    it("escapes strings with special chars", () => {
      assert.strictEqual(shellEscape("$VAR"), "'$VAR'");
      assert.strictEqual(shellEscape("a;b"), "'a;b'");
    });
  });
});
