import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCronTask, getAgentWorkspace, buildDeliverCommand, shellEscape } from "../cron-runner.js";

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

  describe("buildDeliverCommand", () => {
    it("builds command without thread", () => {
      const cmd = buildDeliverCommand(306600687);
      assert.ok(cmd.includes("deliver.sh"));
      assert.ok(cmd.endsWith("306600687"));
      assert.ok(!cmd.includes("--thread"));
    });

    it("builds command with thread ID", () => {
      const cmd = buildDeliverCommand(306600687, 12345);
      assert.ok(cmd.includes("deliver.sh"));
      assert.ok(cmd.includes("306600687"));
      assert.ok(cmd.includes("--thread 12345"));
    });

    it("does not include --thread when threadId is undefined", () => {
      const cmd = buildDeliverCommand(123456, undefined);
      assert.ok(!cmd.includes("--thread"));
    });
  });

  describe("loadCronTask — deliveryThreadId", () => {
    it("parses deliveryThreadId from crons.yaml when present", () => {
      // This tests the real crons.yaml. Since no current cron has deliveryThreadId,
      // we verify that the field is correctly absent (undefined).
      const cron = loadCronTask("memory-consolidation-main");
      assert.strictEqual(cron.deliveryThreadId, undefined);
    });
  });
});
