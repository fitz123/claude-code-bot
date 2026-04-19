import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateSessionDefaults, validateAgent, loadConfig } from "../config.js";

const TEST_DIR = join("/tmp", "config-defaults-test-" + Date.now());

describe("validateSessionDefaults", () => {
  it("returns production defaults when input is null", () => {
    const defaults = validateSessionDefaults(null);
    assert.strictEqual(defaults.idleTimeoutMs, 3600000);
    assert.strictEqual(defaults.maxConcurrentSessions, 12);
    assert.strictEqual(defaults.maxMessageAgeMs, 600000);
    assert.strictEqual(defaults.requireMention, true);
  });

  it("returns production defaults when input is undefined", () => {
    const defaults = validateSessionDefaults(undefined);
    assert.strictEqual(defaults.idleTimeoutMs, 3600000);
    assert.strictEqual(defaults.maxConcurrentSessions, 12);
    assert.strictEqual(defaults.maxMessageAgeMs, 600000);
    assert.strictEqual(defaults.requireMention, true);
  });

  it("returns production defaults when input is empty object", () => {
    const defaults = validateSessionDefaults({});
    assert.strictEqual(defaults.idleTimeoutMs, 3600000);
    assert.strictEqual(defaults.maxConcurrentSessions, 12);
    assert.strictEqual(defaults.maxMessageAgeMs, 600000);
    assert.strictEqual(defaults.requireMention, true);
  });

  it("allows overriding individual fields", () => {
    const defaults = validateSessionDefaults({ idleTimeoutMs: 1000 });
    assert.strictEqual(defaults.idleTimeoutMs, 1000);
    assert.strictEqual(defaults.maxConcurrentSessions, 12);
    assert.strictEqual(defaults.maxMessageAgeMs, 600000);
  });

  it("allows overriding all fields", () => {
    const defaults = validateSessionDefaults({
      idleTimeoutMs: 5000,
      maxConcurrentSessions: 5,
      maxMessageAgeMs: 10000,
      requireMention: true,
    });
    assert.strictEqual(defaults.idleTimeoutMs, 5000);
    assert.strictEqual(defaults.maxConcurrentSessions, 5);
    assert.strictEqual(defaults.maxMessageAgeMs, 10000);
    assert.strictEqual(defaults.requireMention, true);
  });

  it("throws on invalid maxMessageAgeMs", () => {
    assert.throws(
      () => validateSessionDefaults({ maxMessageAgeMs: -1 }),
      /Invalid maxMessageAgeMs/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxMessageAgeMs: 0 }),
      /Invalid maxMessageAgeMs/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxMessageAgeMs: Infinity }),
      /Invalid maxMessageAgeMs/,
    );
  });

  it("throws on invalid idleTimeoutMs", () => {
    assert.throws(
      () => validateSessionDefaults({ idleTimeoutMs: -1 }),
      /Invalid idleTimeoutMs/,
    );
    assert.throws(
      () => validateSessionDefaults({ idleTimeoutMs: 0 }),
      /Invalid idleTimeoutMs/,
    );
    assert.throws(
      () => validateSessionDefaults({ idleTimeoutMs: Infinity }),
      /Invalid idleTimeoutMs/,
    );
  });

  it("throws on invalid maxConcurrentSessions", () => {
    assert.throws(
      () => validateSessionDefaults({ maxConcurrentSessions: 0 }),
      /Invalid maxConcurrentSessions/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxConcurrentSessions: -1 }),
      /Invalid maxConcurrentSessions/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxConcurrentSessions: 0.5 }),
      /Invalid maxConcurrentSessions/,
    );
  });

  it("ignores non-numeric types and uses defaults", () => {
    const defaults = validateSessionDefaults({ idleTimeoutMs: "not a number" });
    assert.strictEqual(defaults.idleTimeoutMs, 3600000);
  });

  it("parses requireMention boolean", () => {
    const on = validateSessionDefaults({ requireMention: true });
    assert.strictEqual(on.requireMention, true);
    const off = validateSessionDefaults({ requireMention: false });
    assert.strictEqual(off.requireMention, false);
  });

  it("throws on non-boolean requireMention", () => {
    assert.throws(
      () => validateSessionDefaults({ requireMention: "true" }),
      /Invalid requireMention/,
    );
    assert.throws(
      () => validateSessionDefaults({ requireMention: 1 }),
      /Invalid requireMention/,
    );
  });
});

describe("validateAgent defaultModel inheritance", () => {
  it("inherits defaultModel when agent has no model", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x" },
      "main",
      "claude-opus-4-7",
    );
    assert.strictEqual(agent.model, "claude-opus-4-7");
    assert.strictEqual(agent.fallbackModel, undefined);
  });

  it("inherits defaultFallbackModel when agent has no fallbackModel", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x" },
      "main",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    );
    assert.strictEqual(agent.model, "claude-opus-4-7");
    assert.strictEqual(agent.fallbackModel, "claude-sonnet-4-6");
  });

  it("per-agent model overrides defaultModel", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "claude-haiku-4-5-20251001" },
      "main",
      "claude-opus-4-7",
    );
    assert.strictEqual(agent.model, "claude-haiku-4-5-20251001");
  });

  it("per-agent fallbackModel overrides defaultFallbackModel", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "claude-opus-4-7", fallbackModel: "claude-haiku-4-5-20251001" },
      "main",
      undefined,
      "claude-sonnet-4-6",
    );
    assert.strictEqual(agent.fallbackModel, "claude-haiku-4-5-20251001");
  });

  it("throws when agent has no model and no defaultModel is set", () => {
    assert.throws(
      () => validateAgent({ workspaceCwd: "/tmp/x" }, "main"),
      /Agent "main" missing model/,
    );
  });

  it("throws when agent has no model and defaultModel is not a string", () => {
    assert.throws(
      () => validateAgent({ workspaceCwd: "/tmp/x" }, "main", 42 as unknown as string),
      /Agent "main" missing model/,
    );
  });

  it("backward compat: explicit model with no defaults still works", () => {
    const agent = validateAgent(
      {
        workspaceCwd: "/tmp/x",
        model: "claude-opus-4-7",
        fallbackModel: "claude-sonnet-4-6",
      },
      "main",
    );
    assert.strictEqual(agent.model, "claude-opus-4-7");
    assert.strictEqual(agent.fallbackModel, "claude-sonnet-4-6");
  });

  it("throws when agent model is present but non-string (does not silently inherit)", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: 42 },
        "main",
        "claude-opus-4-7",
      ),
      /Agent "main" has invalid model/,
    );
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: ["claude-opus-4-7"] },
        "main",
        "claude-opus-4-7",
      ),
      /Agent "main" has invalid model/,
    );
  });

  it("throws when agent fallbackModel is present but non-string", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "claude-opus-4-7", fallbackModel: 99 },
        "main",
        undefined,
        "claude-sonnet-4-6",
      ),
      /Agent "main" has invalid fallbackModel/,
    );
  });
});

describe("loadConfig top-level defaultModel validation", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("rejects non-string defaultModel with clear error", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configPath,
      `
defaultModel: 42
agents:
  main:
    workspaceCwd: /tmp/x
`,
    );
    assert.throws(() => loadConfig(configPath), /Invalid defaultModel/);
  });

  it("rejects non-string defaultFallbackModel with clear error", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configPath,
      `
defaultFallbackModel:
  not: a string
agents:
  main:
    workspaceCwd: /tmp/x
    model: claude-opus-4-7
`,
    );
    assert.throws(() => loadConfig(configPath), /Invalid defaultFallbackModel/);
  });

  it("fails when agent has no model and no defaultModel is set", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configPath,
      `
agents:
  main:
    workspaceCwd: /tmp/x
`,
    );
    assert.throws(() => loadConfig(configPath), /Agent "main" missing model/);
  });

  it("inherits top-level defaults end-to-end for agents without model/fallbackModel", () => {
    // No telegramTokenService / bindings / discord → loadConfig reaches the
    // "at least one platform" guard AFTER agent validation, proving the default
    // inheritance wiring succeeded without needing Keychain access.
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configPath,
      `
defaultModel: claude-opus-4-7
defaultFallbackModel: claude-sonnet-4-6
agents:
  inheritor:
    workspaceCwd: /tmp/x
  pinned:
    workspaceCwd: /tmp/y
    model: claude-haiku-4-5-20251001
`,
    );
    assert.throws(() => loadConfig(configPath), (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /At least one platform must be configured/);
      return true;
    });
  });

  it("local config defaultModel replaces base defaultModel", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(
      configPath,
      `
defaultModel: claude-opus-4-6
agents:
  main:
    workspaceCwd: /tmp/x
`,
    );
    writeFileSync(
      localPath,
      `
defaultModel: claude-opus-4-7
`,
    );
    // Agents validated OK (no missing-model error); fails at platform guard.
    assert.throws(() => loadConfig(configPath), /At least one platform must be configured/);
  });
});
