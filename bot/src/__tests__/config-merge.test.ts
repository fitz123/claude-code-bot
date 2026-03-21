import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { mergeDeep, loadRawMergedConfig } from "../config.js";

const TEST_DIR = join("/tmp", "config-merge-test-" + Date.now());

describe("mergeDeep", () => {
  it("returns base values when override is empty", () => {
    const result = mergeDeep({ a: 1, b: 2 }, {});
    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });

  it("override wins on scalar values", () => {
    const result = mergeDeep({ a: 1 }, { a: 2 });
    assert.strictEqual(result.a, 2);
  });

  it("preserves base keys not present in override", () => {
    const result = mergeDeep({ a: 1, b: 2 }, { a: 99 });
    assert.strictEqual(result.a, 99);
    assert.strictEqual(result.b, 2);
  });

  it("deep merges nested objects without losing sibling keys", () => {
    const result = mergeDeep(
      { sessionDefaults: { idleTimeoutMs: 3600000, maxConcurrentSessions: 12 } },
      { sessionDefaults: { idleTimeoutMs: 7200000 } },
    );
    const sd = result.sessionDefaults as Record<string, unknown>;
    assert.strictEqual(sd.idleTimeoutMs, 7200000);        // overridden
    assert.strictEqual(sd.maxConcurrentSessions, 12);     // preserved
  });

  it("replaces arrays entirely (no element-level merge)", () => {
    const result = mergeDeep(
      { bindings: [{ chatId: 111 }, { chatId: 222 }] },
      { bindings: [{ chatId: 999 }] },
    );
    const bindings = result.bindings as Array<Record<string, unknown>>;
    assert.strictEqual(bindings.length, 1);
    assert.strictEqual(bindings[0].chatId, 999);
  });

  it("adds keys from override not present in base", () => {
    const result = mergeDeep({ a: 1 }, { b: 2 });
    assert.strictEqual(result.a, 1);
    assert.strictEqual(result.b, 2);
  });

  it("override can set key to null", () => {
    const result = mergeDeep({ a: 1 }, { a: null });
    assert.strictEqual(result.a, null);
  });

  it("does not mutate base object", () => {
    const base = { a: 1, nested: { x: 10 } };
    mergeDeep(base as Record<string, unknown>, { a: 99, nested: { x: 20 } });
    assert.strictEqual(base.a, 1);
    assert.strictEqual(base.nested.x, 10);
  });

  it("deep merges agents object: local workspaceCwd overrides base, model preserved", () => {
    const base = parseYaml(`
agents:
  main:
    workspaceCwd: /tmp/minime-workspace
    model: claude-opus-4-6
    fallbackModel: claude-sonnet-4-6
    maxTurns: 250
`) as Record<string, unknown>;
    const local = { agents: { main: { workspaceCwd: "/real/workspace" } } };
    const merged = mergeDeep(base, local as Record<string, unknown>);
    const agents = merged.agents as Record<string, Record<string, unknown>>;
    assert.strictEqual(agents.main.workspaceCwd, "/real/workspace");  // overridden
    assert.strictEqual(agents.main.model, "claude-opus-4-6");         // preserved
    assert.strictEqual(agents.main.maxTurns, 250);                    // preserved
  });

  it("local bindings array replaces base bindings entirely", () => {
    const base = { bindings: [{ chatId: 111111111, agentId: "main", kind: "dm" }] };
    const local = { bindings: [{ chatId: 987654321, agentId: "main", kind: "dm", label: "Real DM" }] };
    const merged = mergeDeep(
      base as Record<string, unknown>,
      local as Record<string, unknown>,
    );
    const bindings = merged.bindings as Array<Record<string, unknown>>;
    assert.strictEqual(bindings.length, 1);
    assert.strictEqual(bindings[0].chatId, 987654321);
    assert.strictEqual(bindings[0].label, "Real DM");
  });

  it("local sessionDefaults partially overrides without losing other fields", () => {
    const base = parseYaml(`
sessionDefaults:
  idleTimeoutMs: 3600000
  maxConcurrentSessions: 12
  maxMessageAgeMs: 600000
`) as Record<string, unknown>;
    const local = { sessionDefaults: { idleTimeoutMs: 7200000 } };
    const merged = mergeDeep(base, local as Record<string, unknown>);
    const sd = merged.sessionDefaults as Record<string, unknown>;
    assert.strictEqual(sd.idleTimeoutMs, 7200000);     // overridden
    assert.strictEqual(sd.maxConcurrentSessions, 12);  // preserved
    assert.strictEqual(sd.maxMessageAgeMs, 600000);    // preserved
  });

  it("merge precedence: local always wins over base on conflict", () => {
    const result = mergeDeep(
      { logLevel: "info", metricsPort: 9091 },
      { logLevel: "debug", metricsPort: 8080 },
    );
    assert.strictEqual(result.logLevel, "debug");
    assert.strictEqual(result.metricsPort, 8080);
  });
});

describe("loadRawMergedConfig", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns base config when no local file exists", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(configPath, "logLevel: debug\nmetricsPort: 9091\n");
    const result = loadRawMergedConfig(configPath);
    assert.strictEqual(result.logLevel, "debug");
    assert.strictEqual(result.metricsPort, 9091);
  });

  it("merges local file when it exists alongside config.yaml", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(configPath, "logLevel: info\nmetricsPort: 9091\n");
    writeFileSync(localPath, "logLevel: debug\nadminChatId: 123456789\n");
    const result = loadRawMergedConfig(configPath);
    assert.strictEqual(result.logLevel, "debug");       // local wins
    assert.strictEqual(result.metricsPort, 9091);       // base preserved
    assert.strictEqual(result.adminChatId, 123456789);  // local addition
  });

  it("local value takes precedence over base", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(configPath, "metricsPort: 9091\n");
    writeFileSync(localPath, "metricsPort: 8080\n");
    const result = loadRawMergedConfig(configPath);
    assert.strictEqual(result.metricsPort, 8080);
  });

  it("handles empty local file gracefully", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(configPath, "logLevel: info\n");
    writeFileSync(localPath, "# no overrides\n");
    const result = loadRawMergedConfig(configPath);
    assert.strictEqual(result.logLevel, "info");
  });

  it("deep merges nested agent config from local", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(configPath, `
agents:
  main:
    workspaceCwd: /tmp/default
    model: claude-opus-4-6
    maxTurns: 250
`);
    writeFileSync(localPath, `
agents:
  main:
    workspaceCwd: /real/workspace
`);
    const result = loadRawMergedConfig(configPath);
    const agents = result.agents as Record<string, Record<string, unknown>>;
    assert.strictEqual(agents.main.workspaceCwd, "/real/workspace");  // overridden
    assert.strictEqual(agents.main.model, "claude-opus-4-6");         // preserved
    assert.strictEqual(agents.main.maxTurns, 250);                    // preserved
  });
});
