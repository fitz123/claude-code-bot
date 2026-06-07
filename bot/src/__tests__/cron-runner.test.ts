import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadCronTask, getAgentWorkspace, resolveCronAgentData, buildPiCronAgentConfig, buildDeliverCommand, loadAdminChatId, handleDeliveryFailure, loadDefaultDelivery, resolveCronEngine, runOneShot, classifyPiResult, writeCronHealthMetric, runScript, main } from "../cron-runner.js";
import type { CronAgentData, CronRunnerMainDeps, DeliveryDefaults } from "../cron-runner.js";
import type { CronJob } from "../types.js";

// We test the pure functions. runPi and deliver require real Pi/Telegram unless stubbed.

const TEST_DIR = join("/tmp", "cron-runner-test-" + Date.now());

function makeLlmCron(engine?: CronJob["engine"]): CronJob {
  const cron: CronJob = {
    name: engine ? `${engine}-engine-task` : "default-engine-task",
    schedule: "0 * * * *",
    type: "llm",
    prompt: "test",
    agentId: "main",
    deliveryChatId: 111111111,
  };
  if (engine !== undefined) {
    cron.engine = engine;
  }
  return cron;
}

describe("cron-runner", () => {
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

  describe("loadCronTask — engine field", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-engine");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("returns undefined engine when omitted", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: default-engine-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("default-engine-task", CRONS_FILE);
      assert.strictEqual(cron.engine, undefined);
    });

    it("rejects engine: claude with a migration error", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: claude-engine-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    engine: claude
`);
      assert.throws(
        () => loadCronTask("claude-engine-task", CRONS_FILE),
        /Claude cron runtime was removed; remove engine or set engine: pi/,
      );
    });

    it("parses engine: pi", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: pi-engine-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    engine: pi
`);
      const cron = loadCronTask("pi-engine-task", CRONS_FILE);
      assert.strictEqual(cron.engine, "pi");
    });

    it("rejects invalid engine values", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-engine-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    engine: codex
`);
      assert.throws(() => loadCronTask("bad-engine-task", CRONS_FILE), /invalid 'engine' "codex" \(must be "pi" or omitted\)/);
    });

    it("ignores engine on script crons without changing script validation", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: script-engine-task
    schedule: "0 * * * *"
    type: script
    command: "echo script"
    agentId: main
    deliveryChatId: 111111111
    engine: pi
`);
      const cron = loadCronTask("script-engine-task", CRONS_FILE);
      assert.strictEqual(cron.type, "script");
      assert.strictEqual(cron.command, "echo script");
      assert.strictEqual(cron.prompt, undefined);
      assert.strictEqual(cron.engine, undefined);
    });

    it("ignores invalid engine values on script crons", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: script-bad-engine-task
    schedule: "0 * * * *"
    type: script
    command: "echo script"
    agentId: main
    deliveryChatId: 111111111
    engine: codex
`);
      const cron = loadCronTask("script-bad-engine-task", CRONS_FILE);
      assert.strictEqual(cron.type, "script");
      assert.strictEqual(cron.command, "echo script");
      assert.strictEqual(cron.engine, undefined);
    });
  });

  describe("cron engine dispatch", () => {
    let oldCronPiDisabled: string | undefined;

    beforeEach(() => {
      oldCronPiDisabled = process.env.CRON_PI_DISABLED;
      delete process.env.CRON_PI_DISABLED;
    });

    afterEach(() => {
      if (oldCronPiDisabled === undefined) {
        delete process.env.CRON_PI_DISABLED;
      } else {
        process.env.CRON_PI_DISABLED = oldCronPiDisabled;
      }
    });

    function makeDispatchDeps(calls: string[]) {
      return {
        runPi: (cron: CronJob, workspaceCwd: string): string => {
          calls.push(`pi:${cron.name}:${workspaceCwd}`);
          return "pi-output";
        },
      };
    }

    it("defaults omitted engine to Pi", () => {
      const cron = makeLlmCron();
      const calls: string[] = [];

      assert.strictEqual(resolveCronEngine(cron), "pi");
      assert.strictEqual(runOneShot(cron, "/tmp/workspace", makeDispatchDeps(calls)), "pi-output");
      assert.deepStrictEqual(calls, ["pi:default-engine-task:/tmp/workspace"]);
    });

    it("dispatches explicit Pi engine to Pi", () => {
      const cron = makeLlmCron("pi");
      const calls: string[] = [];

      assert.strictEqual(resolveCronEngine(cron), "pi");
      assert.strictEqual(runOneShot(cron, "/tmp/workspace", makeDispatchDeps(calls)), "pi-output");
      assert.deepStrictEqual(calls, ["pi:pi-engine-task:/tmp/workspace"]);
    });

    it("rejects the old CRON_PI_DISABLED fallback", () => {
      const cron = makeLlmCron("pi");
      const calls: string[] = [];
      process.env.CRON_PI_DISABLED = "1";

      assert.throws(() => resolveCronEngine(cron), /CRON_PI_DISABLED=1 is no longer supported/);
      assert.throws(
        () => runOneShot(cron, "/tmp/workspace", makeDispatchDeps(calls)),
        /CRON_PI_DISABLED=1 is no longer supported/,
      );
      assert.deepStrictEqual(calls, []);
    });
  });

  describe("Pi result classification", () => {
    const cases = [
      {
        name: "returns trimmed stdout for a zero exit with output",
        args: [0, null, "  hello from pi\n", ""] as const,
        expected: { status: "ok" as const, output: "hello from pi" },
      },
      {
        name: "treats a zero exit with empty stdout and empty stderr as intentional empty success",
        args: [0, null, " \n\t", ""] as const,
        expected: { status: "ok" as const, output: "" },
      },
      {
        name: "preserves NO_REPLY output for the existing post-run suppression logic",
        args: [0, null, "\nNO_REPLY\n", "diagnostic warning"] as const,
        expected: { status: "ok" as const, output: "NO_REPLY" },
      },
      {
        name: "treats a zero exit with empty stdout and non-empty stderr as an error",
        args: [0, null, "", "auth expired"] as const,
        messageMatches: [/stderr without stdout/],
        diagnosticMatches: [/stderr: auth expired/],
      },
      {
        name: "treats a non-zero exit as an error with bounded stderr and stdout diagnostics",
        args: [2, null, "partial output", "failure details"] as const,
        messageMatches: [/code 2/],
        diagnosticMatches: [/stderr: failure details/, /stdout: partial output/],
      },
      {
        name: "treats a signal as an error with bounded output diagnostics",
        args: [null, "SIGTERM", "partial output", "terminated"] as const,
        messageMatches: [/signal SIGTERM/],
        diagnosticMatches: [/stderr: terminated/, /stdout: partial output/],
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        const [exitCode, signal, stdout, stderr] = testCase.args;
        const result = classifyPiResult(exitCode, signal, stdout, stderr);
        if ("expected" in testCase) {
          assert.deepStrictEqual(result, testCase.expected);
          return;
        }
        assert.strictEqual(result.status, "error");
        for (const pattern of testCase.messageMatches) {
          assert.match(result.message, pattern);
        }
        for (const pattern of testCase.diagnosticMatches) {
          assert.match(result.diagnostics ?? "", pattern);
        }
      });
    }

    it("treats a missing exit code without signal as an error", () => {
      const result = classifyPiResult(undefined, null, "", "");

      assert.strictEqual(result.status, "error");
      assert.match(result.message, /without an exit code/);
    });

    it("bounds long stderr/stdout excerpts in diagnostics", () => {
      const longStdout = `stdout-${"o".repeat(2100)}-tail`;
      const longStderr = `stderr-${"e".repeat(2100)}-tail`;
      const result = classifyPiResult(1, null, longStdout, longStderr);

      assert.strictEqual(result.status, "error");
      assert.match(result.message, /code 1/);
      assert.match(result.diagnostics ?? "", /stderr \(first 1000 chars\): stderr-eeee/);
      assert.match(result.diagnostics ?? "", /stdout \(first 1000 chars\): stdout-oooo/);
      assert.match(result.diagnostics ?? "", /truncated \d+ chars/);
      assert.doesNotMatch(result.diagnostics ?? "", /-tail/);
      assert.ok((result.diagnostics ?? "").length < 2400, `diagnostics were not bounded: ${result.diagnostics?.length}`);
    });
  });

  describe("cron agent data resolution", () => {
    const CONFIG_DIR = join(TEST_DIR, "cron-agent-config");
    const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");
    const CRONS_FILE = join(CONFIG_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CONFIG_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CONFIG_DIR, { recursive: true, force: true });
    });

    it("resolves the default main agent for cron Pi context assembly", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    id: ignored-raw-id
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    systemPrompt: "Use the main persona"
    thinking: high
bindings: []
`);
      writeFileSync(CRONS_FILE, `crons:
  - name: default-main-cron
    schedule: "0 * * * *"
    prompt: "test"
    deliveryChatId: 111111111
`);

      const cron = loadCronTask("default-main-cron", CRONS_FILE);
      const agent = buildPiCronAgentConfig(cron.agentId, CONFIG_FILE);

      assert.strictEqual(cron.agentId, "main");
      assert.deepStrictEqual(agent, {
        id: "main",
        workspaceCwd: "/tmp/main-workspace",
        provider: "pi",
        model: "openai-codex/gpt-5.5",
        systemPrompt: "Use the main persona",
        thinking: "high",
      });
    });

    it("ignores non-string systemPrompt", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    systemPrompt: 42
bindings: []
`);

      const agent = buildPiCronAgentConfig("main", CONFIG_FILE);
      assert.strictEqual(agent.systemPrompt, undefined);
      assert.strictEqual(agent.thinking, undefined);
    });

    it("rejects unsupported thinking values through shared agent validation", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    thinking: turbo
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("main", CONFIG_FILE),
        /Agent "main" has invalid thinking "turbo"/,
      );
    });

    it("rejects obsolete Claude-era fields through shared agent validation", () => {
      const cases: Array<{ yaml: string; pattern: RegExp }> = [
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    provider: claude
bindings: []
`,
          pattern: /Agent "main" uses provider "claude"/,
        },
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    fallbackModel: gpt-5-mini
bindings: []
`,
          pattern: /Agent "main" uses fallbackModel/,
        },
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    effort: high
bindings: []
`,
          pattern: /Agent "main" uses effort/,
        },
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    maxTurns: 10
bindings: []
`,
          pattern: /Agent "main" uses maxTurns/,
        },
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    allowedTools: ["Read"]
bindings: []
`,
          pattern: /Agent "main" uses allowedTools/,
        },
        {
          yaml: `defaultFallbackModel: gpt-5-mini
agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
bindings: []
`,
          pattern: /defaultFallbackModel was removed with the Claude runtime/,
        },
      ];

      for (const { yaml, pattern } of cases) {
        writeFileSync(CONFIG_FILE, yaml);
        assert.throws(() => buildPiCronAgentConfig("main", CONFIG_FILE), pattern);
      }
    });

    it("getAgentWorkspace uses the same agent config resolution", () => {
      writeFileSync(CONFIG_FILE, `agents:
  worker:
    workspaceCwd: /tmp/worker-workspace
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.strictEqual(getAgentWorkspace("worker", CONFIG_FILE), "/tmp/worker-workspace");
      assert.deepStrictEqual(resolveCronAgentData("worker", CONFIG_FILE), {
        id: "worker",
        workspaceCwd: "/tmp/worker-workspace",
      });
    });

    it("resolves relative workspaceCwd against the config workspace root", () => {
      const workspace = join(CONFIG_DIR, "workspace");
      const agentWorkspace = join(workspace, "agent-workspace");
      const configFile = join(workspace, "config.yaml");
      mkdirSync(agentWorkspace, { recursive: true });
      writeFileSync(configFile, `agents:
  main:
    workspaceCwd: ./agent-workspace
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.strictEqual(getAgentWorkspace("main", configFile), agentWorkspace);
      assert.deepStrictEqual(resolveCronAgentData("main", configFile), {
        id: "main",
        workspaceCwd: agentWorkspace,
      });
    });

    it("throws before spawn when the cron agent is missing", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("missing", CONFIG_FILE),
        /Agent "missing" not found in config.yaml \/ config.local.yaml/,
      );
    });

    it("throws before spawn when workspaceCwd is missing", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("main", CONFIG_FILE),
        /Agent "main" missing workspaceCwd/,
      );
    });

    it("throws before spawn when workspaceCwd is invalid", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: 42
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("main", CONFIG_FILE),
        /Agent "main" missing workspaceCwd/,
      );
    });
  });

  describe("cron health metrics", () => {
    const METRIC_DIR = join(TEST_DIR, "cron-health-metrics");
    let oldTextfileDir: string | undefined;

    beforeEach(() => {
      oldTextfileDir = process.env.CRON_HEALTH_TEXTFILE_DIR;
      mkdirSync(METRIC_DIR, { recursive: true });
      process.env.CRON_HEALTH_TEXTFILE_DIR = METRIC_DIR;
    });

    afterEach(() => {
      if (oldTextfileDir === undefined) {
        delete process.env.CRON_HEALTH_TEXTFILE_DIR;
      } else {
        process.env.CRON_HEALTH_TEXTFILE_DIR = oldTextfileDir;
      }
      rmSync(METRIC_DIR, { recursive: true, force: true });
    });

    it("writes success timestamp and exit code to stable hashed textfiles", () => {
      const before = Math.floor(Date.now() / 1000);

      writeCronHealthMetric("Daily Pi / Main!", 0, true);

      const files = readdirSync(METRIC_DIR).filter((name) => name.endsWith(".prom")).sort();
      assert.strictEqual(files.length, 2);
      assert.ok(files.some((name) => /^minime_cron_Daily_Pi_Main_[a-f0-9]{12}\.success\.prom$/.test(name)), files.join(","));
      assert.ok(files.some((name) => /^minime_cron_Daily_Pi_Main_[a-f0-9]{12}\.exit\.prom$/.test(name)), files.join(","));
      const content = files.map((name) => readFileSync(join(METRIC_DIR, name), "utf8")).join("\n");
      const after = Math.floor(Date.now() / 1000);
      const timestampMatch = content.match(
        /minime_cron_last_success_timestamp\{cron="Daily Pi \/ Main!"\} (\d+)/,
      );

      assert.ok(timestampMatch, content);
      const timestamp = Number(timestampMatch[1]);
      assert.ok(timestamp >= before && timestamp <= after, `timestamp ${timestamp} outside test window`);
      assert.match(content, /minime_cron_last_exit_code\{cron="Daily Pi \/ Main!"\} 0/);
      assert.deepStrictEqual(
        readdirSync(METRIC_DIR).filter((name) => name.endsWith(".tmp")),
        [],
      );
    });

    it("preserves the previous success timestamp when writing a failure exit code", () => {
      writeCronHealthMetric("failing-cron", 0, true);
      const successFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".success.prom"));
      assert.ok(successFile);
      const successContent = readFileSync(join(METRIC_DIR, successFile), "utf8");

      writeCronHealthMetric("failing-cron", 2, false);

      assert.strictEqual(readFileSync(join(METRIC_DIR, successFile), "utf8"), successContent);
      const exitFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      assert.ok(exitFile);
      const exitContent = readFileSync(join(METRIC_DIR, exitFile), "utf8");
      assert.match(exitContent, /minime_cron_last_exit_code\{cron="failing-cron"\} 2/);
    });

    it("keeps distinct files and labels for cron names that sanitize to the same stem", () => {
      writeCronHealthMetric("a/b", 0, false);
      writeCronHealthMetric("a_b", 1, false);

      const files = readdirSync(METRIC_DIR).filter((name) => name.endsWith(".exit.prom")).sort();
      assert.strictEqual(files.length, 2);
      assert.notStrictEqual(files[0], files[1]);
      const content = files.map((name) => readFileSync(join(METRIC_DIR, name), "utf8")).join("\n");
      assert.match(content, /minime_cron_last_exit_code\{cron="a\/b"\} 0/);
      assert.match(content, /minime_cron_last_exit_code\{cron="a_b"\} 1/);
    });

    it("escapes quotes, backslashes, newlines, and carriage returns in Prometheus labels", () => {
      writeCronHealthMetric('quoted"slash\\newline\ncarriage\rname', 7, false);

      const file = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      assert.ok(file);
      assert.strictEqual(
        readFileSync(join(METRIC_DIR, file), "utf8"),
        'minime_cron_last_exit_code{cron="quoted\\"slash\\\\newline\\ncarriage\\rname"} 7\n',
      );
    });

    it("warns but does not throw when the textfile path cannot be written", () => {
      const blocker = join(METRIC_DIR, "not-a-directory");
      writeFileSync(blocker, "blocking file", "utf8");
      process.env.CRON_HEALTH_TEXTFILE_DIR = join(blocker, "child");
      const oldWrite = process.stderr.write;
      const stderrWrites: string[] = [];

      try {
        process.stderr.write = ((chunk: string | Uint8Array) => {
          stderrWrites.push(String(chunk));
          return true;
        }) as typeof process.stderr.write;

        assert.doesNotThrow(() => writeCronHealthMetric("blocked metric", 1, false));
      } finally {
        process.stderr.write = oldWrite;
      }
      const stderr = stderrWrites.join("");
      assert.match(stderr, /blocked metric/);
      assert.match(stderr, /failed to prepare cron health metric dir/);
    });
  });

  describe("main behavior preservation", () => {
    class MainExitError extends Error {
      code: number;

      constructor(code: number) {
        super(`process.exit(${code})`);
        this.code = code;
      }
    }

    interface MainCalls {
      consoleErrors: string[];
      logs: Array<{ taskName: string; message: string }>;
      defaultLoads: number;
      cronLoads: Array<{ taskName: string; defaults?: DeliveryDefaults }>;
      adminLoads: number;
      workspaces: string[];
      scripts: string[];
      oneShots: Array<{ cronName: string; workspaceCwd: string; engine: "pi"; agentData?: CronAgentData }>;
      deliveries: Array<{ chatId: number; message: string; threadId?: number }>;
      deliveryFailures: Array<{
        cronName: string;
        targetChatId: number;
        errorMsg: string;
        adminChatId: number | undefined;
      }>;
      metrics: Array<{ cronName: string; exitCode: number; success: boolean }>;
      exits: number[];
    }

    function makeMainCron(overrides: Partial<CronJob> = {}): CronJob {
      return {
        name: "main-behavior-task",
        schedule: "0 * * * *",
        type: "llm",
        prompt: "test prompt",
        agentId: "main",
        deliveryChatId: 111111111,
        deliveryThreadId: 42,
        ...overrides,
      };
    }

    function makeMainHarness(cron: CronJob): { calls: MainCalls; deps: Partial<CronRunnerMainDeps> } {
      const calls: MainCalls = {
        consoleErrors: [],
        logs: [],
        defaultLoads: 0,
        cronLoads: [],
        adminLoads: 0,
        workspaces: [],
        scripts: [],
        oneShots: [],
        deliveries: [],
        deliveryFailures: [],
        metrics: [],
        exits: [],
      };

      const deps: Partial<CronRunnerMainDeps> = {
        argv: ["node", "cron-runner.ts", "--task", cron.name],
        consoleError: (message?: unknown) => {
          calls.consoleErrors.push(String(message));
        },
        exit: (code: number): never => {
          calls.exits.push(code);
          throw new MainExitError(code);
        },
        log: (taskName: string, message: string) => {
          calls.logs.push({ taskName, message });
        },
        loadDefaultDelivery: () => {
          calls.defaultLoads += 1;
          return {};
        },
        loadCronTask: (taskName: string, _cronsPath?: string, defaults?: DeliveryDefaults) => {
          calls.cronLoads.push({ taskName, defaults });
          return cron;
        },
        loadAdminChatId: () => {
          calls.adminLoads += 1;
          return 999999999;
        },
        resolveCronAgentData: (agentId: string) => {
          calls.workspaces.push(agentId);
          return { id: agentId, workspaceCwd: "/tmp/main-workspace", systemPrompt: "persona", thinking: "high" };
        },
        runScript: (scriptCron: CronJob) => {
          calls.scripts.push(scriptCron.name);
          return "script output";
        },
        runPi: (llmCron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => {
          calls.oneShots.push({ cronName: llmCron.name, workspaceCwd, engine: "pi", agentData });
          return "llm output";
        },
        deliver: (chatId: number, message: string, threadId?: number) => {
          calls.deliveries.push({ chatId, message, threadId });
        },
        handleDeliveryFailure: (
          cronName: string,
          targetChatId: number,
          errorMsg: string,
          adminChatId: number | undefined,
        ) => {
          calls.deliveryFailures.push({ cronName, targetChatId, errorMsg, adminChatId });
        },
        writeCronHealthMetric: (cronName: string, exitCode: number, success: boolean) => {
          calls.metrics.push({ cronName, exitCode, success });
        },
      };

      return { calls, deps };
    }

    async function assertMainExits(
      deps: Partial<CronRunnerMainDeps>,
      expectedCode: number,
    ): Promise<void> {
      await assert.rejects(
        () => main(deps),
        (err: unknown) => err instanceof MainExitError && err.code === expectedCode,
      );
    }

    it("writes an unknown failure metric and exits when --task is missing", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.argv = ["node", "cron-runner.ts"];

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.consoleErrors, ["Usage: cron-runner.ts --task <name>"]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: "unknown", exitCode: 1, success: false },
      ]);
      assert.deepStrictEqual(calls.cronLoads, []);
    });

    it("keeps script crons on the script path and delivers their output", async () => {
      const cron = makeMainCron({
        type: "script",
        prompt: undefined,
        command: "echo script",
        engine: "pi",
      });
      const { calls, deps } = makeMainHarness(cron);
      deps.resolveCronAgentData = () => {
        throw new Error("script crons must not resolve an agent workspace");
      };
      deps.runPi = () => {
        throw new Error("script crons must not use LLM dispatch");
      };

      await main(deps);

      assert.deepStrictEqual(calls.scripts, [cron.name]);
      assert.deepStrictEqual(calls.workspaces, []);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.deliveries, [
        { chatId: 111111111, message: "script output", threadId: 42 },
      ]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
      assert.strictEqual(calls.exits.length, 0);
      assert.ok(calls.logs.some((entry) => entry.message === "Script returned 13 chars"));
      assert.ok(calls.logs.some((entry) => entry.message === "DONE"));
    });

    it("resolves workspace and uses one-shot LLM dispatch for LLM crons", async () => {
      const cron = makeMainCron({ engine: "pi" });
      const { calls, deps } = makeMainHarness(cron);

      await main(deps);

      assert.deepStrictEqual(calls.workspaces, ["main"]);
      assert.deepStrictEqual(calls.oneShots, [
        {
          cronName: cron.name,
          workspaceCwd: "/tmp/main-workspace",
          engine: "pi",
          agentData: { id: "main", workspaceCwd: "/tmp/main-workspace", systemPrompt: "persona", thinking: "high" },
        },
      ]);
      assert.deepStrictEqual(calls.deliveries, [
        { chatId: 111111111, message: "llm output", threadId: 42 },
      ]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
      assert.ok(calls.logs.some((entry) => entry.message === "Pi returned 10 chars"));
    });

    it("sends cron FAIL notifications when the old Pi kill-switch is set", async () => {
      const oldCronPiDisabled = process.env.CRON_PI_DISABLED;
      const cron = makeMainCron({ engine: "pi" });
      const { calls, deps } = makeMainHarness(cron);

      try {
        process.env.CRON_PI_DISABLED = "1";
        await assertMainExits(deps, 1);
      } finally {
        if (oldCronPiDisabled === undefined) {
          delete process.env.CRON_PI_DISABLED;
        } else {
          process.env.CRON_PI_DISABLED = oldCronPiDisabled;
        }
      }

      assert.deepStrictEqual(calls.oneShots, []);
      assert.strictEqual(calls.deliveries.length, 1);
      assert.match(calls.deliveries[0].message, /Cron FAIL: main-behavior-task/);
      assert.match(calls.deliveries[0].message, /CRON_PI_DISABLED=1 is no longer supported/);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("keeps empty output as a successful skip without delivery", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = (llmCron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => {
        calls.oneShots.push({ cronName: llmCron.name, workspaceCwd, engine: "pi", agentData });
        return "";
      };

      await main(deps);

      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
      assert.ok(calls.logs.some((entry) => entry.message === "WARN: empty output — skipping delivery"));
      assert.ok(calls.logs.some((entry) => entry.message === "DONE"));
    });

    it("keeps LLM NO_REPLY output as a successful skip without delivery", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = (llmCron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => {
        calls.oneShots.push({ cronName: llmCron.name, workspaceCwd, engine: "pi", agentData });
        return "All clean.\n\nNO_REPLY";
      };

      await main(deps);

      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
      assert.ok(calls.logs.some((entry) => entry.message === "NO_REPLY — skipping delivery"));
      assert.ok(calls.logs.some((entry) => entry.message === "DONE"));
    });

    it("does not apply NO_REPLY suppression to script output", async () => {
      const cron = makeMainCron({
        type: "script",
        prompt: undefined,
        command: "echo NO_REPLY",
      });
      const { calls, deps } = makeMainHarness(cron);
      deps.runScript = (scriptCron: CronJob) => {
        calls.scripts.push(scriptCron.name);
        return "NO_REPLY";
      };

      await main(deps);

      assert.deepStrictEqual(calls.deliveries, [
        { chatId: 111111111, message: "NO_REPLY", threadId: 42 },
      ]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
    });

    it("sends cron FAIL notifications and exits when execution fails", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = () => {
        throw new Error("runner exploded");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(calls.deliveries.length, 1);
      assert.strictEqual(calls.deliveries[0].chatId, 111111111);
      assert.strictEqual(calls.deliveries[0].threadId, 42);
      assert.match(calls.deliveries[0].message, /Cron FAIL: main-behavior-task/);
      assert.match(calls.deliveries[0].message, /runner exploded/);
      assert.deepStrictEqual(calls.deliveryFailures, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("sends cron FAIL notifications and exits when LLM workspace resolution fails", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.resolveCronAgentData = () => {
        throw new Error('Agent "missing" not found in config.yaml / config.local.yaml');
      };
      deps.runPi = () => {
        throw new Error("LLM dispatch must not run without a workspace");
      };

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.oneShots, []);
      assert.strictEqual(calls.deliveries.length, 1);
      assert.strictEqual(calls.deliveries[0].chatId, 111111111);
      assert.match(calls.deliveries[0].message, /Cron FAIL: main-behavior-task/);
      assert.match(calls.deliveries[0].message, /Agent "missing" not found/);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("keeps subprocess diagnostics out of cron FAIL notifications", async () => {
      const cron = makeMainCron({ engine: "pi" });
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = () => {
        throw Object.assign(new Error("Pi cron produced stderr without stdout"), {
          diagnostics: "stderr: secret-token-should-stay-in-local-log",
        });
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(calls.deliveries.length, 1);
      assert.match(calls.deliveries[0].message, /Pi cron produced stderr without stdout/);
      assert.doesNotMatch(calls.deliveries[0].message, /secret-token/);
      assert.ok(
        calls.logs.some((entry) => entry.message.includes("secret-token-should-stay-in-local-log")),
        "expected local diagnostics log",
      );
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("uses the admin fallback when cron FAIL notification delivery fails", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = () => {
        throw new Error("runner exploded");
      };
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("bot blocked");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(calls.deliveryFailures.length, 1);
      assert.deepStrictEqual(calls.deliveryFailures[0], {
        cronName: cron.name,
        targetChatId: 111111111,
        errorMsg: 'Cron task "main-behavior-task" failed: runner exploded\n(notification delivery failed: bot blocked)',
        adminChatId: 999999999,
      });
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("uses the admin fallback and exits when final output delivery fails", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("delivery transport failed");
      };

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.deliveries, [
        { chatId: 111111111, message: "llm output", threadId: 42 },
      ]);
      assert.deepStrictEqual(calls.deliveryFailures, [
        {
          cronName: cron.name,
          targetChatId: 111111111,
          errorMsg: "delivery transport failed",
          adminChatId: 999999999,
        },
      ]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
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

    it("scrubs legacy runtime environment for direct script execution", () => {
      const legacyAnthropicEnv = "ANTHROPIC_" + "API_KEY";
      const oldValues = {
        token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        anthropic: process.env[legacyAnthropicEnv],
        marker: process.env.CLAUDECODE,
      };
      try {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-token";
        process.env[legacyAnthropicEnv] = "stale-anthropic-key";
        process.env.CLAUDECODE = "nested-marker";
        const cron: CronJob = {
          name: "env-script",
          schedule: "0 * * * *",
          type: "script",
          command: `printf 'token=%s\\nanthropic=%s\\nmarker=%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-__unset__}" "\${ANTHROPIC_API_KEY-__unset__}" "\${CLAUDECODE-__unset__}"`,
          agentId: "main",
          deliveryChatId: 111111111,
        };

        assert.strictEqual(
          runScript(cron),
          "token=__unset__\nanthropic=__unset__\nmarker=__unset__",
        );
      } finally {
        if (oldValues.token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldValues.token;
        if (oldValues.anthropic === undefined) delete process.env[legacyAnthropicEnv];
        else process.env[legacyAnthropicEnv] = oldValues.anthropic;
        if (oldValues.marker === undefined) delete process.env.CLAUDECODE;
        else process.env.CLAUDECODE = oldValues.marker;
      }
    });
  });
});

describe("cron-runner NO_REPLY suppression (shouldSuppressNoReply)", () => {
  // The cron LLM-output gate (cron-runner.ts) calls shouldSuppressNoReply on
  // raw output before delivery. Verify the same end-of-message + start-of-message
  // patterns the stream-relay tests cover.
  let shouldSuppressNoReply: (s: string) => boolean;

  before(async () => {
    ({ shouldSuppressNoReply } = await import("../no-reply.js"));
  });

  it("suppresses <content>\\n\\nNO_REPLY (end-of-message, blank line before)", () => {
    assert.strictEqual(shouldSuppressNoReply("All checks complete. Everything is clean.\n\nNO_REPLY"), true);
  });

  it("suppresses <content>\\nNO_REPLY (single newline before)", () => {
    assert.strictEqual(shouldSuppressNoReply("All clean.\nNO_REPLY"), true);
  });

  it("suppresses <content>\\nNO_REPLY\\n (trailing newline)", () => {
    assert.strictEqual(shouldSuppressNoReply("All clean.\nNO_REPLY\n"), true);
  });

  it("suppresses operator's leaked workspace-health sample verbatim", () => {
    const sample = [
      "All checks complete. Let me compile the results:",
      "• Size audit: OK (335M, no bloat)",
      "• Hook integrity: OK",
      "• Config check: 1 warning (settings.local.json missing outputStyle — minor, file doesn't exist)",
      "The only finding is the settings.local.json warning, which is informational.",
      "",
      "NO_REPLY",
    ].join("\n");
    assert.strictEqual(shouldSuppressNoReply(sample), true);
  });

  it("delivers same-line `Some text NO_REPLY` (token shares line with content)", () => {
    assert.strictEqual(shouldSuppressNoReply("Some text NO_REPLY"), false);
  });

  it("delivers `Done. NO_REPLY_EXTRA more` (substring prefix on same line)", () => {
    assert.strictEqual(shouldSuppressNoReply("Done. NO_REPLY_EXTRA more"), false);
  });

  it("preserves issue #80: suppresses NO_REPLY at start (exact)", () => {
    assert.strictEqual(shouldSuppressNoReply("NO_REPLY"), true);
  });

  it("preserves issue #80: suppresses NO_REPLY\\n\\n<text> at start", () => {
    assert.strictEqual(shouldSuppressNoReply("NO_REPLY\n\nSome explanation text..."), true);
  });

  it("preserves issue #80: suppresses NO_REPLY: reason at start", () => {
    assert.strictEqual(shouldSuppressNoReply("NO_REPLY: nothing actionable"), true);
  });

  it("preserves issue #80: suppresses whitespace-padded NO_REPLY", () => {
    assert.strictEqual(shouldSuppressNoReply("  NO_REPLY  "), true);
  });

  it("does not suppress regular output", () => {
    assert.strictEqual(shouldSuppressNoReply("Hello, this is a normal response"), false);
  });

  it("does not suppress empty / whitespace-only output", () => {
    assert.strictEqual(shouldSuppressNoReply(""), false);
    assert.strictEqual(shouldSuppressNoReply("   \n\n  "), false);
  });

  it("does not suppress NO_REPLY_EXTRA alone on last line (substring, not equal)", () => {
    assert.strictEqual(shouldSuppressNoReply("Some content\n\nNO_REPLY_EXTRA"), false);
  });
});
