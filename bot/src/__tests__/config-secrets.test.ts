import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, loadTelegramToken } from "../config.js";
import type { ExecFileSyncLike } from "../secrets.js";
import { MINIME_CONFIG_PATH_ENV, MINIME_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

describe("config secret resolution: SOPS and env sources", () => {
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
    delete process.env[MINIME_CONFIG_PATH_ENV];
    delete process.env[MINIME_WORKSPACE_ROOT_ENV];
  });

  const minimalAgentsYaml = `
agents:
  main:
    workspaceCwd: /tmp/foo
    model: gpt-5.5
`;

  function writeSopsPlaceholder(): string {
    const dir = join(tmpDir, "config");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "secrets.sops.yaml");
    writeFileSync(file, "not_a_real_secret: true\n");
    return file;
  }

  it("prefers telegramTokenSopsKey over env and resolves direct configPath SOPS fallback from the config dir", () => {
    const sopsFile = writeSopsPlaceholder();
    process.env.TEST_TELEGRAM_TOKEN_ENV = "tg-token-from-env";
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFileSync: ExecFileSyncLike = (file, args) => {
      calls.push({ file, args });
      return "tg-token-from-sops\n";
    };
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/secrets.sops.yaml
telegramTokenSopsKey: telegram.bot_token
telegramTokenEnv: TEST_TELEGRAM_TOKEN_ENV
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    const config = loadConfig(configPath, { secretExecFileSync: execFileSync });
    assert.strictEqual(config.telegramToken, "tg-token-from-sops");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].file, "sops");
    assert.deepStrictEqual(calls[0].args, [
      "-d",
      "--extract",
      '["telegram"]["bot_token"]',
      sopsFile,
    ]);
  });

  it("loadTelegramToken resolves relative SOPS paths against the control workspace when config path is overridden", () => {
    const controlWorkspace = join(tmpDir, "control-workspace");
    const configDir = join(controlWorkspace, "settings");
    const sopsDir = join(controlWorkspace, "config");
    const sopsFile = join(sopsDir, "secrets.sops.yaml");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(sopsDir, { recursive: true });
    writeFileSync(sopsFile, "telegram:\n  bot_token: encrypted-placeholder\n");
    writeFileSync(
      join(configDir, "bot.yaml"),
      `
agents:
  main:
    workspaceCwd: /tmp/foo
    model: gpt-5.5
secrets:
  sopsFile: config/secrets.sops.yaml
telegramTokenSopsKey: telegram.bot_token
`,
    );
    process.env[MINIME_WORKSPACE_ROOT_ENV] = controlWorkspace;
    process.env[MINIME_CONFIG_PATH_ENV] = "settings/bot.yaml";
    const calls: Array<{ file: string; args: readonly string[] }> = [];

    const token = loadTelegramToken(undefined, {
      secretExecFileSync: (file, args) => {
        calls.push({ file, args });
        return "tg-token-from-control-sops\n";
      },
    });

    assert.strictEqual(token, "tg-token-from-control-sops");
    assert.deepStrictEqual(calls[0].args, [
      "-d",
      "--extract",
      '["telegram"]["bot_token"]',
      sopsFile,
    ]);
  });

  it("falls back to telegramTokenEnv when configured SOPS lookup fails", () => {
    writeSopsPlaceholder();
    process.env.TEST_TELEGRAM_TOKEN_ENV = "tg-token-from-env";
    const execFileSync: ExecFileSyncLike = () => {
      throw new Error("simulated decrypt failure");
    };
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/secrets.sops.yaml
telegramTokenSopsKey: telegram.bot_token
telegramTokenEnv: TEST_TELEGRAM_TOKEN_ENV
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    const config = loadConfig(configPath, { secretExecFileSync: execFileSync });
    assert.strictEqual(config.telegramToken, "tg-token-from-env");
  });

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

  it("can validate configured Telegram SOPS references without resolving values", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/secrets.sops.yaml
telegramTokenSopsKey: telegram.bot_token
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );

    assert.throws(
      () => loadConfig(configPath),
      /SOPS key 'telegram\.bot_token' failed \(missing-file\)/,
    );

    const config = loadConfig(configPath, { resolveSecrets: false });
    assert.equal(config.telegramToken, "[configured]");
    assert.equal(config.bindings.length, 1);
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
      /Telegram bindings require a token source \(telegramTokenSopsKey with secrets\.sopsFile, or telegramTokenEnv\)/
    );
  });

  it("does not resolve Telegram token sources when Telegram bindings are disabled", () => {
    process.env.TEST_DISCORD_TOKEN_ENV = "dc-token-from-env";
    const execFileSync: ExecFileSyncLike = () => {
      throw new Error("telegram sops should not be read");
    };
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/missing.sops.yaml
telegramTokenSopsKey: telegram.bot_token
bindings: []
discord:
  tokenEnv: TEST_DISCORD_TOKEN_ENV
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );

    const config = loadConfig(configPath, { secretExecFileSync: execFileSync });

    assert.equal(config.telegramToken, undefined);
    assert.equal(config.bindings.length, 0);
    assert.equal(config.discord!.token, "dc-token-from-env");
  });

  it("validates telegramTokenEnv type (must be string)", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
telegramTokenEnv: 123
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    assert.throws(() => loadConfig(configPath), /telegramTokenEnv must be a string/);
  });

  it("rejects Telegram SOPS keys without secrets.sopsFile even when env is configured", () => {
    process.env.TEST_TELEGRAM_TOKEN_ENV = "tg-token-from-env";
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
telegramTokenSopsKey: telegram.bot_token
telegramTokenEnv: TEST_TELEGRAM_TOKEN_ENV
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    assert.throws(() => loadConfig(configPath), /telegramTokenSopsKey requires secrets\.sopsFile/);
  });

  it("rejects invalid SOPS key syntax during structure-only validation", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/secrets.sops.yaml
telegramTokenSopsKey: telegram.bot/token
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    assert.throws(
      () => loadConfig(configPath, { resolveSecrets: false }),
      /telegramTokenSopsKey must be a dot path with segments matching \[A-Za-z0-9_-\]\+/,
    );
  });

  it("reads discord.token from SOPS when tokenSopsKey is configured", () => {
    const sopsFile = writeSopsPlaceholder();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFileSync: ExecFileSyncLike = (file, args) => {
      calls.push({ file, args });
      return "dc-token-from-sops\n";
    };
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/secrets.sops.yaml
discord:
  tokenSopsKey: discord.bot_token
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );
    const config = loadConfig(configPath, { secretExecFileSync: execFileSync });
    assert.ok(config.discord, "discord config should exist");
    assert.strictEqual(config.discord!.token, "dc-token-from-sops");
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].args, [
      "-d",
      "--extract",
      '["discord"]["bot_token"]',
      sopsFile,
    ]);
  });

  it("prefers discord.tokenSopsKey over tokenEnv when both are configured", () => {
    writeSopsPlaceholder();
    process.env.TEST_DISCORD_TOKEN_ENV = "dc-token-from-env";
    const execFileSync: ExecFileSyncLike = () => "dc-token-from-sops\n";
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/secrets.sops.yaml
discord:
  tokenSopsKey: discord.bot_token
  tokenEnv: TEST_DISCORD_TOKEN_ENV
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );

    const config = loadConfig(configPath, { secretExecFileSync: execFileSync });

    assert.ok(config.discord, "discord config should exist");
    assert.strictEqual(config.discord!.token, "dc-token-from-sops");
  });

  it("falls back to discord.tokenEnv when configured SOPS lookup fails", () => {
    writeSopsPlaceholder();
    process.env.TEST_DISCORD_TOKEN_ENV = "dc-token-from-env";
    const execFileSync: ExecFileSyncLike = () => {
      throw new Error("simulated decrypt failure");
    };
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/secrets.sops.yaml
discord:
  tokenSopsKey: discord.bot_token
  tokenEnv: TEST_DISCORD_TOKEN_ENV
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );

    const config = loadConfig(configPath, { secretExecFileSync: execFileSync });

    assert.ok(config.discord, "discord config should exist");
    assert.strictEqual(config.discord!.token, "dc-token-from-env");
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

  it("can validate configured Discord SOPS references without resolving values", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/secrets.sops.yaml
discord:
  tokenSopsKey: discord.bot_token
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );

    assert.throws(
      () => loadConfig(configPath),
      /SOPS key 'discord\.bot_token' failed \(missing-file\)/,
    );

    const config = loadConfig(configPath, { resolveSecrets: false });
    assert.equal(config.discord!.token, "[configured]");
    assert.equal(config.discord!.bindings.length, 1);
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
      /discord requires a token source \(discord\.tokenSopsKey with secrets\.sopsFile, or discord\.tokenEnv\)/
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

  it("rejects invalid Discord SOPS key syntax during structure-only validation", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: config/secrets.sops.yaml
discord:
  tokenSopsKey: discord.bot/token
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );
    assert.throws(
      () => loadConfig(configPath, { resolveSecrets: false }),
      /discord\.tokenSopsKey must be a dot path with segments matching \[A-Za-z0-9_-\]\+/,
    );
  });

  it("validates SOPS config field types", () => {
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
secrets:
  sopsFile: 123
telegramTokenSopsKey: telegram.bot_token
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    assert.throws(() => loadConfig(configPath), /secrets.sopsFile must be a string/);

    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
telegramTokenSopsKey: 123
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    assert.throws(() => loadConfig(configPath), /telegramTokenSopsKey must be a string/);

    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
discord:
  tokenSopsKey: 123
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );
    assert.throws(() => loadConfig(configPath), /discord.tokenSopsKey must be a string/);
  });

  it("rejects legacy Keychain service config with migration errors", () => {
    const legacyTelegramKey = ["telegramToken", "Service"].join("");
    const legacyDiscordKey = ["token", "Service"].join("");
    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
${legacyTelegramKey}: telegram-bot-token
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`
    );
    assert.throws(
      () => loadConfig(configPath),
      new RegExp(`${legacyTelegramKey} is no longer supported; migrate to telegramTokenSopsKey with secrets\\.sopsFile or telegramTokenEnv`),
    );

    writeFileSync(
      configPath,
      minimalAgentsYaml +
        `
discord:
  ${legacyDiscordKey}: discord-bot-token
  bindings:
    - guildId: "999"
      agentId: main
      kind: channel
`
    );
    assert.throws(
      () => loadConfig(configPath),
      new RegExp(`discord\\.${legacyDiscordKey} is no longer supported; migrate to discord\\.tokenSopsKey with secrets\\.sopsFile or discord\\.tokenEnv`),
    );
  });
});
