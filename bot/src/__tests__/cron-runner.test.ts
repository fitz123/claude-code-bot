import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCronTask, getAgentWorkspace, buildDeliverCommand, shellEscape, loadAdminChatId, handleDeliveryFailure, loadDefaultDelivery, runScript } from "../cron-runner.js";
import type { DeliveryDefaults } from "../cron-runner.js";
import type { CronJob } from "../types.js";

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

  describe("loadAdminChatId — with temp config.yaml", () => {
    const CONFIG_DIR = join(TEST_DIR, "admin-config");
    const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

    beforeEach(() => {
      mkdirSync(CONFIG_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CONFIG_DIR, { recursive: true, force: true });
    });

    it("returns adminChatId when present in config", () => {
      writeFileSync(CONFIG_FILE, `adminChatId: 999999999\nagents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, 999999999);
    });

    it("returns undefined when adminChatId is absent", () => {
      writeFileSync(CONFIG_FILE, `agents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, undefined);
    });

    it("returns undefined when adminChatId is a float", () => {
      writeFileSync(CONFIG_FILE, `adminChatId: 3.14\nagents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, undefined);
    });

    it("returns undefined when adminChatId is zero", () => {
      writeFileSync(CONFIG_FILE, `adminChatId: 0\nagents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, undefined);
    });

    it("returns adminChatId when it is negative (Telegram group chat)", () => {
      writeFileSync(CONFIG_FILE, `adminChatId: -1001234567890\nagents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, -1001234567890);
    });
  });

  describe("handleDeliveryFailure", () => {
    it("calls deliverFn with adminChatId when adminChatId is set", () => {
      const calls: Array<[number, string]> = [];
      const mockDeliver = (chatId: number, msg: string) => {
        calls.push([chatId, msg]);
      };
      handleDeliveryFailure("my-task", 111111111, "bot blocked", 999999999, mockDeliver);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0][0], 999999999);
      assert.ok(calls[0][1].includes("my-task"));
      assert.ok(calls[0][1].includes("111111111"));
      assert.ok(calls[0][1].includes("bot blocked"));
    });

    it("does not call deliverFn when adminChatId is undefined", () => {
      const calls: Array<[number, string]> = [];
      const mockDeliver = (chatId: number, msg: string) => {
        calls.push([chatId, msg]);
      };
      handleDeliveryFailure("my-task", 111111111, "bot blocked", undefined, mockDeliver);
      assert.strictEqual(calls.length, 0);
    });

    it("does not throw when deliverFn itself throws", () => {
      const mockDeliver = () => {
        throw new Error("admin unreachable");
      };
      // Should not throw
      assert.doesNotThrow(() =>
        handleDeliveryFailure("my-task", 111111111, "bot blocked", 999999999, mockDeliver),
      );
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
      assert.throws(() => loadCronTask("test-task", CRONS_FILE), /missing 'deliveryChatId'/);
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

  describe("loadDefaultDelivery — with temp config.yaml", () => {
    const CONFIG_DIR = join(TEST_DIR, "delivery-config");
    const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

    beforeEach(() => {
      mkdirSync(CONFIG_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CONFIG_DIR, { recursive: true, force: true });
    });

    it("returns both defaults when present", () => {
      writeFileSync(CONFIG_FILE, `defaultDeliveryChatId: -1001234567890\ndefaultDeliveryThreadId: 99\n`);
      const d = loadDefaultDelivery(CONFIG_FILE);
      assert.strictEqual(d.defaultDeliveryChatId, -1001234567890);
      assert.strictEqual(d.defaultDeliveryThreadId, 99);
    });

    it("returns empty object when neither field present", () => {
      writeFileSync(CONFIG_FILE, `agents: {}\n`);
      const d = loadDefaultDelivery(CONFIG_FILE);
      assert.strictEqual(d.defaultDeliveryChatId, undefined);
      assert.strictEqual(d.defaultDeliveryThreadId, undefined);
    });

    it("ignores zero values", () => {
      writeFileSync(CONFIG_FILE, `defaultDeliveryChatId: 0\ndefaultDeliveryThreadId: 0\n`);
      const d = loadDefaultDelivery(CONFIG_FILE);
      assert.strictEqual(d.defaultDeliveryChatId, undefined);
      assert.strictEqual(d.defaultDeliveryThreadId, undefined);
    });

    it("ignores non-integer values", () => {
      writeFileSync(CONFIG_FILE, `defaultDeliveryChatId: 3.14\ndefaultDeliveryThreadId: "abc"\n`);
      const d = loadDefaultDelivery(CONFIG_FILE);
      assert.strictEqual(d.defaultDeliveryChatId, undefined);
      assert.strictEqual(d.defaultDeliveryThreadId, undefined);
    });
  });

  describe("loadCronTask — config default delivery fallback", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-defaults");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("falls back to config default deliveryChatId when cron omits it", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, -1001234567890);
    });

    it("cron-level deliveryChatId overrides config default", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 999999999
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, 999999999);
    });

    it("falls back to config default deliveryThreadId when cron uses default chat", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890, defaultDeliveryThreadId: 42 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, -1001234567890);
      assert.strictEqual(cron.deliveryThreadId, 42);
    });

    it("cron-level deliveryThreadId overrides config default", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 111111111
    deliveryThreadId: 77
`);
      const defaults: DeliveryDefaults = { defaultDeliveryThreadId: 42 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryThreadId, 77);
    });

    it("throws when neither cron nor config has deliveryChatId", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
`);
      assert.throws(() => loadCronTask("test-task", CRONS_FILE, {}), /missing 'deliveryChatId'/);
    });

    it("throws when cron has invalid deliveryChatId (float) instead of falling back", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 3.14
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890 };
      assert.throws(() => loadCronTask("test-task", CRONS_FILE, defaults), /invalid 'deliveryChatId'/);
    });

    it("throws when cron has invalid deliveryChatId (zero) instead of falling back", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 0
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890 };
      assert.throws(() => loadCronTask("test-task", CRONS_FILE, defaults), /invalid 'deliveryChatId'/);
    });

    it("throws when cron has invalid deliveryThreadId (float)", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 111111111
    deliveryThreadId: 3.14
`);
      assert.throws(() => loadCronTask("test-task", CRONS_FILE), /invalid 'deliveryThreadId'/);
    });

    it("inherits default thread when cron explicitly sets same chat as default", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: -1001234567890
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890, defaultDeliveryThreadId: 42 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, -1001234567890);
      assert.strictEqual(cron.deliveryThreadId, 42);
    });

    it("does not inherit default thread when cron overrides chat", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 999999999
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890, defaultDeliveryThreadId: 42 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, 999999999);
      assert.strictEqual(cron.deliveryThreadId, undefined);
    });
  });

  describe("loadCronTask — script-mode crons", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-script");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("loads script-mode cron with command field", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: backup-task
    schedule: "0 2 * * *"
    type: script
    command: "/usr/bin/backup.sh --full"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("backup-task", CRONS_FILE);
      assert.strictEqual(cron.type, "script");
      assert.strictEqual(cron.command, "/usr/bin/backup.sh --full");
      assert.strictEqual(cron.prompt, undefined);
    });

    it("throws when script-mode cron is missing command field", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-script
    schedule: "0 2 * * *"
    type: script
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("bad-script", CRONS_FILE), /missing required 'command' field/);
    });

    it("defaults type to llm when not specified", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: llm-task
    schedule: "0 9 * * *"
    prompt: "do something"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("llm-task", CRONS_FILE);
      assert.strictEqual(cron.type, "llm");
      assert.strictEqual(cron.prompt, "do something");
      assert.strictEqual(cron.command, undefined);
    });

    it("throws when llm-mode cron is missing prompt field", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-llm
    schedule: "0 9 * * *"
    type: llm
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("bad-llm", CRONS_FILE), /missing required 'prompt' field/);
    });

    it("throws when script command is whitespace-only", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-script
    schedule: "0 2 * * *"
    type: script
    command: "   "
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("bad-script", CRONS_FILE), /missing required 'command' field/);
    });

    it("throws when llm prompt is whitespace-only", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-llm
    schedule: "0 9 * * *"
    prompt: "   "
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("bad-llm", CRONS_FILE), /missing required 'prompt' field/);
    });

    it("throws when type is invalid", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-type
    schedule: "0 9 * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    type: scrpt
`);
      assert.throws(() => loadCronTask("bad-type", CRONS_FILE), /invalid type "scrpt"/);
    });

    it("script-mode cron uses config default delivery", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: script-task
    schedule: "0 2 * * *"
    type: script
    command: "echo hello"
    agentId: main
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890, defaultDeliveryThreadId: 99 };
      const cron = loadCronTask("script-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, -1001234567890);
      assert.strictEqual(cron.deliveryThreadId, 99);
    });
  });

  describe("loadCronTask — enabled field", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-enabled");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("parses enabled: false from YAML", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: disabled-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    enabled: false
`);
      const cron = loadCronTask("disabled-task", CRONS_FILE);
      assert.strictEqual(cron.enabled, false);
    });

    it("returns undefined for enabled when omitted", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: default-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("default-task", CRONS_FILE);
      assert.strictEqual(cron.enabled, undefined);
    });

    it("throws when timeout is zero", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-timeout
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    timeout: 0
`);
      assert.throws(() => loadCronTask("bad-timeout", CRONS_FILE), /invalid 'timeout'/);
    });

    it("throws when timeout is negative", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-timeout
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    timeout: -1000
`);
      assert.throws(() => loadCronTask("bad-timeout", CRONS_FILE), /invalid 'timeout'/);
    });

    it("returns undefined for enabled: true (only false is preserved)", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: enabled-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    enabled: true
`);
      const cron = loadCronTask("enabled-task", CRONS_FILE);
      assert.strictEqual(cron.enabled, undefined);
    });
  });

  describe("runScript", () => {
    it("executes command and returns stdout", () => {
      const cron: CronJob = {
        name: "echo-test",
        schedule: "0 * * * *",
        type: "script",
        command: "echo 'hello from script'",
        agentId: "main",
        deliveryChatId: 111111111,
      };
      const output = runScript(cron);
      assert.strictEqual(output, "hello from script");
    });

    it("respects timeout", () => {
      const cron: CronJob = {
        name: "slow-script",
        schedule: "0 * * * *",
        type: "script",
        command: "sleep 10",
        agentId: "main",
        deliveryChatId: 111111111,
        timeout: 100, // 100ms — will timeout
      };
      assert.throws(() => runScript(cron), /TIMEOUT|ETIMEDOUT|timed out|killed/i);
    });

    it("throws when command is missing", () => {
      const cron: CronJob = {
        name: "no-cmd",
        schedule: "0 * * * *",
        type: "script",
        agentId: "main",
        deliveryChatId: 111111111,
      };
      assert.throws(() => runScript(cron), /no command/i);
    });
  });
});
