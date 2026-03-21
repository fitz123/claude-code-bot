import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadMergedCrons, loadCronTask } from "../cron-runner.js";

const TEST_DIR = join("/tmp", "cron-merge-test-" + Date.now());

describe("loadMergedCrons", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns base crons when no local file exists", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    writeFileSync(cronsPath, `crons:
  - name: base-task
    schedule: "0 9 * * *"
    prompt: "do something"
    agentId: main
    deliveryChatId: 111111111
`);
    const crons = loadMergedCrons(cronsPath);
    assert.strictEqual(crons.length, 1);
    assert.strictEqual(crons[0].name, "base-task");
  });

  it("appends local crons to base when names differ", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    const localPath = join(TEST_DIR, "crons.local.yaml");
    writeFileSync(cronsPath, `crons:
  - name: base-task
    schedule: "0 9 * * *"
    prompt: "base"
    agentId: main
    deliveryChatId: 111111111
`);
    writeFileSync(localPath, `crons:
  - name: local-task
    schedule: "0 10 * * *"
    prompt: "local"
    agentId: main
    deliveryChatId: 222222222
`);
    const crons = loadMergedCrons(cronsPath);
    assert.strictEqual(crons.length, 2);
    assert.ok(crons.some((c) => c.name === "base-task"));
    assert.ok(crons.some((c) => c.name === "local-task"));
  });

  it("local cron wins over base cron with same name", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    const localPath = join(TEST_DIR, "crons.local.yaml");
    writeFileSync(cronsPath, `crons:
  - name: shared-task
    schedule: "0 9 * * *"
    prompt: "base prompt"
    agentId: main
    deliveryChatId: 111111111
    enabled: false
`);
    writeFileSync(localPath, `crons:
  - name: shared-task
    schedule: "0 9 * * *"
    prompt: "local prompt"
    agentId: main
    deliveryChatId: 999999999
`);
    const crons = loadMergedCrons(cronsPath);
    assert.strictEqual(crons.length, 1);
    assert.strictEqual(crons[0].prompt, "local prompt");
    assert.strictEqual(crons[0].deliveryChatId, 999999999);
  });

  it("local wins preserves position of replaced cron", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    const localPath = join(TEST_DIR, "crons.local.yaml");
    writeFileSync(cronsPath, `crons:
  - name: first
    schedule: "0 1 * * *"
    prompt: "first"
    agentId: main
    deliveryChatId: 111111111
  - name: second
    schedule: "0 2 * * *"
    prompt: "second base"
    agentId: main
    deliveryChatId: 111111111
  - name: third
    schedule: "0 3 * * *"
    prompt: "third"
    agentId: main
    deliveryChatId: 111111111
`);
    writeFileSync(localPath, `crons:
  - name: second
    schedule: "0 2 * * *"
    prompt: "second local"
    agentId: main
    deliveryChatId: 222222222
`);
    const crons = loadMergedCrons(cronsPath);
    assert.strictEqual(crons.length, 3);
    assert.strictEqual(crons[0].name, "first");
    assert.strictEqual(crons[1].name, "second");
    assert.strictEqual(crons[1].prompt, "second local");
    assert.strictEqual(crons[2].name, "third");
  });

  it("handles empty local file gracefully", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    const localPath = join(TEST_DIR, "crons.local.yaml");
    writeFileSync(cronsPath, `crons:
  - name: base-task
    schedule: "0 9 * * *"
    prompt: "do something"
    agentId: main
    deliveryChatId: 111111111
`);
    writeFileSync(localPath, "# no overrides\n");
    const crons = loadMergedCrons(cronsPath);
    assert.strictEqual(crons.length, 1);
    assert.strictEqual(crons[0].name, "base-task");
  });

  it("local-only crons are added after base crons", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    const localPath = join(TEST_DIR, "crons.local.yaml");
    writeFileSync(cronsPath, `crons:
  - name: base-task
    schedule: "0 9 * * *"
    prompt: "base"
    agentId: main
    deliveryChatId: 111111111
    enabled: false
`);
    writeFileSync(localPath, `crons:
  - name: user-task-1
    schedule: "0 10 * * *"
    prompt: "user 1"
    agentId: main
    deliveryChatId: 222222222
  - name: user-task-2
    schedule: "0 11 * * *"
    prompt: "user 2"
    agentId: main
    deliveryChatId: 333333333
`);
    const crons = loadMergedCrons(cronsPath);
    assert.strictEqual(crons.length, 3);
    assert.strictEqual(crons[0].name, "base-task");
    assert.strictEqual(crons[1].name, "user-task-1");
    assert.strictEqual(crons[2].name, "user-task-2");
  });

  it("loadCronTask finds a task defined only in local file", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    const localPath = join(TEST_DIR, "crons.local.yaml");
    writeFileSync(cronsPath, `crons:
  - name: base-task
    schedule: "0 9 * * *"
    prompt: "base"
    agentId: main
    deliveryChatId: 111111111
    enabled: false
`);
    writeFileSync(localPath, `crons:
  - name: user-task
    schedule: "0 10 * * *"
    prompt: "user prompt"
    agentId: main
    deliveryChatId: 222222222
`);
    const cron = loadCronTask("user-task", cronsPath);
    assert.strictEqual(cron.name, "user-task");
    assert.strictEqual(cron.deliveryChatId, 222222222);
    assert.strictEqual(cron.prompt, "user prompt");
  });

  it("loadCronTask uses local override values when same name in both files", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    const localPath = join(TEST_DIR, "crons.local.yaml");
    writeFileSync(cronsPath, `crons:
  - name: health-check
    schedule: "0 10 * * 1"
    prompt: /workspace-health
    agentId: main
    enabled: false
`);
    writeFileSync(localPath, `crons:
  - name: health-check
    schedule: "0 10 * * 1"
    prompt: /workspace-health
    agentId: main
    deliveryChatId: 123456789
    enabled: true
`);
    const cron = loadCronTask("health-check", cronsPath);
    assert.strictEqual(cron.deliveryChatId, 123456789);
    assert.strictEqual(cron.enabled, undefined); // enabled: true normalizes to undefined
  });
});
