import { test, describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";

/**
 * Tests for the env-var / Keychain secret resolver (resolveSecret) introduced
 * in PR feat/env-var-secrets. Covers the env path exclusively — Keychain path
 * is unchanged behavior and not testable here without a real macOS Keychain
 * entry (which would couple tests to host state).
 */

describe("config secret resolution: env var + Keychain priority", () => {
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
    maxTurns: 10
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

  it("env wins over Keychain when both telegramTokenService and telegramTokenEnv set", () => {
    process.env.TEST_TELEGRAM_TOKEN_ENV = "env-wins";
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
telegramTokenService: this-keychain-service-would-fail-if-read
telegramTokenEnv: TEST_TELEGRAM_TOKEN_ENV
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    // If env did not win, Keychain lookup of nonexistent service would throw.
    const config = loadConfig(configPath);
    assert.strictEqual(config.telegramToken, "env-wins");
  });

  it("can validate configured Telegram secret references without resolving Keychain", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
telegramTokenService: this-keychain-service-would-fail-if-read
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );

    assert.throws(
      () => loadConfig(configPath),
      /Failed to read Keychain service/,
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
    // Empty env => skip env, no service => throws with helpful message
    assert.throws(
      () => loadConfig(configPath),
      /telegramToken requires either a Keychain service name or an env var name/
    );
  });

  it("throws when bindings present but neither telegramTokenService nor telegramTokenEnv set", () => {
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
      /Telegram bindings require telegramTokenService/
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

  it("can validate configured Discord secret references without resolving Keychain", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
discord:
  tokenService: this-keychain-service-would-fail-if-read
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );

    assert.throws(
      () => loadConfig(configPath),
      /Failed to read Keychain service/,
    );

    const config = loadConfig(configPath, { resolveSecrets: false });
    assert.equal(config.discord!.token, "[configured]");
    assert.equal(config.discord!.bindings.length, 1);
  });

  it("throws when discord.tokenService AND tokenEnv both missing", () => {
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
      /discord requires either tokenService.*or tokenEnv/
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
