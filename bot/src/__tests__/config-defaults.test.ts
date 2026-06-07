import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateSessionDefaults, validateAgent, loadConfig } from "../config.js";
import { DEFAULT_MAX_MEDIA_BYTES } from "../media-store.js";
import { MINIME_CONFIG_PATH_ENV, MINIME_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

const TEST_DIR = join("/tmp", "config-defaults-test-" + Date.now());

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

describe("validateSessionDefaults", () => {
  it("returns production defaults when input is null", () => {
    const defaults = validateSessionDefaults(null);
    assert.strictEqual(defaults.idleTimeoutMs, 3600000);
    assert.strictEqual(defaults.maxConcurrentSessions, 12);
    assert.strictEqual(defaults.maxMessageAgeMs, 600000);
    assert.strictEqual(defaults.requireMention, true);
    assert.strictEqual(defaults.maxMediaBytes, DEFAULT_MAX_MEDIA_BYTES);
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

  it("throws on invalid maxMediaBytes", () => {
    assert.throws(
      () => validateSessionDefaults({ maxMediaBytes: 0 }),
      /Invalid maxMediaBytes/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxMediaBytes: -1 }),
      /Invalid maxMediaBytes/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxMediaBytes: Infinity }),
      /Invalid maxMediaBytes/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxMediaBytes: "big" }),
      /Invalid maxMediaBytes/,
    );
  });

  it("allows overriding maxMediaBytes", () => {
    const defaults = validateSessionDefaults({ maxMediaBytes: 1024 });
    assert.strictEqual(defaults.maxMediaBytes, 1024);
  });
});

describe("validateAgent model validation", () => {
  it("does not inherit defaultModel when agent has no model", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x" },
        "main",
        "gpt-5.5",
      ),
      /Agent "main" missing model \(Pi agents must set an explicit model; top-level defaultModel is no longer inherited by Pi agents\)/,
    );
  });

  it("per-agent model overrides defaultModel", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "gpt-5.5" },
      "main",
      "gpt-4.2",
    );
    assert.strictEqual(agent.model, "gpt-5.5");
  });

  it("rejects per-agent fallbackModel", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", fallbackModel: "gpt-5-mini" },
        "main",
      ),
      /Agent "main" uses fallbackModel, but fallback models were removed with the Claude runtime/,
    );
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
        model: "gpt-5.5",
      },
      "main",
    );
    assert.strictEqual(agent.model, "gpt-5.5");
  });

  it("throws when agent model is present but non-string (does not silently inherit)", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: 42 },
        "main",
        "gpt-5.5",
      ),
      /Agent "main" has invalid model/,
    );
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: ["gpt-5.5"] },
        "main",
        "gpt-5.5",
      ),
      /Agent "main" has invalid model/,
    );
  });

  it("throws when agent fallbackModel is present", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", fallbackModel: 99 },
        "main",
      ),
      /Agent "main" uses fallbackModel, but fallback models were removed with the Claude runtime/,
    );
  });
});

describe("loadConfig workspace contract defaults", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("uses MINIME_WORKSPACE_ROOT config.yaml when no config path is passed", () => {
    const workspaceRoot = join(TEST_DIR, "workspace-default");
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(workspaceRoot, "config.yaml"),
      `
agents:
  main:
    workspaceCwd: /tmp/x
    model: gpt-5.5
telegramTokenEnv: TEST_UNSET_TELEGRAM_TOKEN
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`,
    );

    const config = withEnv(
      {
        [MINIME_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CONFIG_PATH_ENV]: undefined,
      },
      () => loadConfig(undefined, { resolveSecrets: false }),
    );

    assert.strictEqual(config.agents.main.workspaceCwd, "/tmp/x");
    assert.strictEqual(config.telegramToken, "[configured]");
    assert.strictEqual(config.bindings.length, 1);
  });

  it("resolves relative agent workspaceCwd against MINIME_WORKSPACE_ROOT", () => {
    const workspaceRoot = join(TEST_DIR, "workspace-agent-cwd");
    mkdirSync(join(workspaceRoot, "agent-workspace"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "config.yaml"),
      `
agents:
  main:
    workspaceCwd: ./agent-workspace
    model: gpt-5.5
telegramTokenEnv: TEST_UNSET_TELEGRAM_TOKEN
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`,
    );

    const config = withEnv(
      {
        [MINIME_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CONFIG_PATH_ENV]: undefined,
      },
      () => loadConfig(undefined, { resolveSecrets: false }),
    );

    assert.strictEqual(config.agents.main.workspaceCwd, join(workspaceRoot, "agent-workspace"));
  });

  it("uses MINIME_CONFIG_PATH relative to workspace root and keeps SOPS paths relative to the control workspace", () => {
    const workspaceRoot = join(TEST_DIR, "workspace-config-override");
    const configDir = join(workspaceRoot, "settings");
    const sopsPath = join(workspaceRoot, "config", "secrets.sops.yaml");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dirname(sopsPath), { recursive: true });
    writeFileSync(sopsPath, "telegram:\n  bot_token: encrypted-placeholder\n");
    writeFileSync(
      join(configDir, "bot.yaml"),
      `
agents:
  main:
    workspaceCwd: /tmp/x
    model: gpt-5.5
secrets:
  sopsFile: config/secrets.sops.yaml
telegramTokenSopsKey: telegram.bot_token
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`,
    );
    const calls: Array<{ file: string; args: readonly string[] }> = [];

    const config = withEnv(
      {
        [MINIME_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CONFIG_PATH_ENV]: "settings/bot.yaml",
      },
      () => loadConfig(undefined, {
        secretExecFileSync: (file, args) => {
          calls.push({ file, args });
          return "tg-token-from-sops\n";
        },
      }),
    );

    assert.strictEqual(config.telegramToken, "tg-token-from-sops");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].file, "sops");
    assert.deepStrictEqual(calls[0].args, [
      "-d",
      "--extract",
      '["telegram"]["bot_token"]',
      sopsPath,
    ]);
  });

  it("keeps relative agent workspaceCwd rooted at workspace when MINIME_CONFIG_PATH points to a subdirectory", () => {
    const workspaceRoot = join(TEST_DIR, "workspace-config-agent-cwd");
    const configDir = join(workspaceRoot, "settings");
    mkdirSync(join(workspaceRoot, "agent-workspace"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "bot.yaml"),
      `
agents:
  main:
    workspaceCwd: ./agent-workspace
    model: gpt-5.5
telegramTokenEnv: TEST_UNSET_TELEGRAM_TOKEN
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`,
    );

    const config = withEnv(
      {
        [MINIME_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CONFIG_PATH_ENV]: "settings/bot.yaml",
      },
      () => loadConfig(undefined, { resolveSecrets: false }),
    );

    assert.strictEqual(config.agents.main.workspaceCwd, join(workspaceRoot, "agent-workspace"));
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

  it("rejects defaultFallbackModel with a migration error", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configPath,
      `
defaultFallbackModel:
  not: a string
agents:
  main:
    workspaceCwd: /tmp/x
    model: gpt-5.5
`,
    );
    assert.throws(() => loadConfig(configPath), /defaultFallbackModel was removed with the Claude runtime; remove defaultFallbackModel/);
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

  it("does not inherit top-level defaultModel end-to-end for agents without model", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(
      configPath,
      `
defaultModel: gpt-5.5
agents:
  inheritor:
    workspaceCwd: /tmp/x
  pinned:
    workspaceCwd: /tmp/y
    model: gpt-5.5
`,
    );
    assert.throws(() => loadConfig(configPath), (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /Agent "inheritor" missing model/);
      return true;
    });
  });

  it("local config defaultModel replaces base defaultModel", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(
      configPath,
      `
defaultModel: gpt-4.2
agents:
  main:
    workspaceCwd: /tmp/x
    model: gpt-5.5
`,
    );
    writeFileSync(
      localPath,
      `
defaultModel: gpt-5.6
`,
    );
    // Agents validated OK using their explicit model; fails at platform guard.
    assert.throws(() => loadConfig(configPath), /At least one platform must be configured/);
  });
});
