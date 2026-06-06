import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";

describe("config secret resolution: env var sources", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-secrets-test-"));
    configPath = join(tmpDir, "config.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TEST_TELEGRAM_TOKEN_ENV;
    delete process.env.TEST_DISCORD_TOKEN_ENV;
  });

  const minimalAgentsYaml = `
agents:
  main:
    workspaceCwd: /tmp/foo
    model: gpt-5.5
`;

  it("reads telegramToken from env var when telegramTokenEnv set", () => {
    process.env.TEST_TELEGRAM_TOKEN_ENV = "tg-token-from-env";
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
telegramTokenEnv: TEST_TELEGRAM_TOKEN_ENV
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    const config = loadConfig(configPath);
    assert.strictEqual(config.telegramToken, "tg-token-from-env");
  });

  it("trims telegramToken values read from env", () => {
    process.env.TEST_TELEGRAM_TOKEN_ENV = " env-value ";
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
telegramTokenEnv: TEST_TELEGRAM_TOKEN_ENV
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    const config = loadConfig(configPath);
    assert.strictEqual(config.telegramToken, "env-value");
  });

  it("can validate configured Telegram env references without resolving values", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
telegramTokenEnv: TEST_TELEGRAM_TOKEN_ENV
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );

    assert.throws(
      () => loadConfig(configPath),
      /env var 'TEST_TELEGRAM_TOKEN_ENV' failed \(unset\)/,
    );

    const config = loadConfig(configPath, { resolveSecrets: false });
    assert.equal(config.telegramToken, "[configured]");
    assert.equal(config.bindings.length, 1);
  });

  it("throws when telegramTokenEnv set but env var is empty string", () => {
    process.env.TEST_TELEGRAM_TOKEN_ENV = "";
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
telegramTokenEnv: TEST_TELEGRAM_TOKEN_ENV
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    assert.throws(
      () => loadConfig(configPath),
      /env var 'TEST_TELEGRAM_TOKEN_ENV' failed \(blank\)/
    );
  });

  it("throws when bindings present but no Telegram token source is set", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    assert.throws(
      () => loadConfig(configPath),
      /Telegram bindings require telegramTokenEnv/
    );
  });

  it("reads discord.token from env var when tokenEnv set", () => {
    process.env.TEST_DISCORD_TOKEN_ENV = "dc-token-from-env";
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
discord:
  tokenEnv: TEST_DISCORD_TOKEN_ENV
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );
    const config = loadConfig(configPath);
    assert.ok(config.discord, "discord config should exist");
    assert.strictEqual(config.discord!.token, "dc-token-from-env");
  });

  it("can validate configured Discord env references without resolving values", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
discord:
  tokenEnv: TEST_DISCORD_TOKEN_ENV
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );

    assert.throws(
      () => loadConfig(configPath),
      /env var 'TEST_DISCORD_TOKEN_ENV' failed \(unset\)/,
    );

    const config = loadConfig(configPath, { resolveSecrets: false });
    assert.equal(config.discord!.token, "[configured]");
    assert.equal(config.discord!.bindings.length, 1);
  });

  it("throws when discord token sources are missing", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
discord:
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );
    assert.throws(
      () => loadConfig(configPath),
      /discord requires tokenEnv/
    );
  });

  it("validates discord.tokenEnv type (must be string)", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
discord:
  tokenEnv: 123
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );
    assert.throws(() => loadConfig(configPath), /discord.tokenEnv must be a string/);
  });
});
