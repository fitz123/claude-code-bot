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
      const cmd = buildDeliverCommand(111111111);
      assert.ok(cmd.includes("deliver.sh"));
      assert.ok(cmd.endsWith("111111111"));
      assert.ok(!cmd.includes("--thread"));
    });

    it("builds command with thread ID", () => {
      const cmd = buildDeliverCommand(111111111, 12345);
      assert.ok(cmd.includes("deliver.sh"));
      assert.ok(cmd.includes("111111111"));
      assert.ok(cmd.includes("--thread 12345"));
    });

    it("does not include --thread when threadId is undefined", () => {
      const cmd = buildDeliverCommand(123456, undefined);
      assert.ok(!cmd.includes("--thread"));
    });
  });

  describe("loadCronTask — with temp crons.yaml", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-yaml");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("parses deliveryThreadId when present", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 111111111
    deliveryThreadId: 42
`);
      const cron = loadCronTask("test-task", CRONS_FILE);
      assert.strictEqual(cron.deliveryThreadId, 42);
      assert.strictEqual(cron.deliveryChatId, 111111111);
    });

    it("deliveryThreadId is undefined when absent", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("test-task", CRONS_FILE);
      assert.strictEqual(cron.deliveryThreadId, undefined);
    });

    it("throws when deliveryChatId is missing", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
`);
      assert.throws(() => loadCronTask("test-task", CRONS_FILE), /missing required 'deliveryChatId'/);
    });

    it("throws when task name not found", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: other-task
    schedule: "0 9 * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("nonexistent", CRONS_FILE), /not found in crons.yaml/);
    });
  });
});
