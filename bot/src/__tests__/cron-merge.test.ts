import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadMergedCrons, loadCronTask } from "../cron-runner.js";
import { MINIME_CRONS_PATH_ENV, MINIME_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

const TEST_DIR = join("/tmp", "cron-merge-test-" + Date.now());

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

  it("uses MINIME_WORKSPACE_ROOT crons.yaml when no crons path is passed", () => {
    const workspaceRoot = join(TEST_DIR, "workspace-default");
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, "crons.yaml"), `crons:
  - name: workspace-task
    schedule: "0 9 * * *"
    prompt: "workspace"
    agentId: main
    deliveryChatId: 111111111
`);

    const crons = withEnv(
      {
        [MINIME_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CRONS_PATH_ENV]: undefined,
      },
      () => loadMergedCrons(),
    );

    assert.strictEqual(crons.length, 1);
    assert.strictEqual(crons[0].name, "workspace-task");
  });

  it("uses MINIME_CRONS_PATH relative to workspace root", () => {
    const workspaceRoot = join(TEST_DIR, "workspace-crons-override");
    const cronsDir = join(workspaceRoot, "settings");
    mkdirSync(cronsDir, { recursive: true });
    writeFileSync(join(cronsDir, "scheduled.yaml"), `crons:
  - name: override-task
    schedule: "0 9 * * *"
    prompt: "override"
    agentId: main
    deliveryChatId: 222222222
`);

    const cron = withEnv(
      {
        [MINIME_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CRONS_PATH_ENV]: "settings/scheduled.yaml",
      },
      () => loadCronTask("override-task"),
    );

    assert.strictEqual(cron.name, "override-task");
    assert.strictEqual(cron.deliveryChatId, 222222222);
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

  it("local file with non-array crons falls back to base", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    const localPath = join(TEST_DIR, "crons.local.yaml");
    writeFileSync(cronsPath, `crons:
  - name: base-task
    schedule: "0 9 * * *"
    prompt: "base"
    agentId: main
    deliveryChatId: 111111111
`);
    writeFileSync(localPath, "crons: not-an-array\n");
    const crons = loadMergedCrons(cronsPath);
    assert.strictEqual(crons.length, 1);
    assert.strictEqual(crons[0].name, "base-task");
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

  it("loadCronTask: enabled:true normalizes to undefined (truthy is the default)", () => {
    const cronsPath = join(TEST_DIR, "crons.yaml");
    writeFileSync(cronsPath, `crons:
  - name: explicit-enabled
    schedule: "0 9 * * *"
    prompt: "do something"
    agentId: main
    deliveryChatId: 111111111
    enabled: true
`);
    const cron = loadCronTask("explicit-enabled", cronsPath);
    assert.strictEqual(cron.enabled, undefined);
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
