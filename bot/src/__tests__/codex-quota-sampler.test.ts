import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  CODEX_QUOTA_PROBE_TEXTFILE_NAME,
  buildCodexQuotaSamplerArgs,
  buildSamplerChildEnv,
  ensureSamplerProjectSettings,
  formatCodexQuotaSamplerHelp,
  parseCodexQuotaSamplerArgs,
  resolveCodexQuotaSamplerConfig,
  runCodexQuotaSampler,
  runPiProbe,
  type SamplerChildLike,
  type SamplerSpawn,
} from "../codex-quota-sampler.js";
import {
  CODEX_QUOTA_ATTEMPT_FILE_ENV,
  CODEX_USAGE_TEXTFILE_NAME,
  captureCodexQuotaFromHeaders,
} from "../pi-extensions/codex-usage.js";

const fixtures: string[] = [];

after(() => {
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-quota-sampler-test-"));
  fixtures.push(dir);
  return dir;
}

class FakeChild extends EventEmitter implements SamplerChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    return true;
  }

  close(code: number | null): void {
    this.emit("close", code);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

describe("codex quota sampler command setup", () => {
  it("writes isolated project settings only in the sampler cwd", () => {
    const workspace = tempDir();
    const samplerCwd = join(workspace, "sampler");

    const settingsFile = ensureSamplerProjectSettings(samplerCwd);

    assert.equal(settingsFile, join(samplerCwd, ".pi", "settings.json"));
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { transport: "sse" });
    assert.equal(existsSync(join(workspace, ".pi", "settings.json")), false);
    if (typeof process.getuid === "function") {
      assert.equal(statSync(samplerCwd).mode & 0o077, 0);
      assert.equal(statSync(join(samplerCwd, ".pi")).mode & 0o077, 0);
      assert.equal(statSync(join(samplerCwd, ".tmp")).mode & 0o077, 0);
    }
  });

  it("reuses sampler settings but refuses to overwrite other Pi project settings", () => {
    const workspace = tempDir();
    const samplerCwd = join(workspace, "sampler");
    const settingsFile = join(samplerCwd, ".pi", "settings.json");
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, `${JSON.stringify({ transport: "sse" }, null, 2)}\n`);

    assert.equal(ensureSamplerProjectSettings(samplerCwd), settingsFile);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { transport: "sse" });

    const existingSettings = { transport: "auto", customSetting: true };
    writeFileSync(settingsFile, `${JSON.stringify(existingSettings, null, 2)}\n`);

    assert.throws(
      () => ensureSamplerProjectSettings(samplerCwd),
      /Refusing to overwrite existing Pi project settings/,
    );
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), existingSettings);
  });

  it("constructs a tiny explicit Pi SSE probe command", () => {
    const args = buildCodexQuotaSamplerArgs({
      model: "gpt-5.5",
      extensionPath: "/abs/codex-usage.ts",
      prompt: "OK?",
    });

    assert.deepEqual(args, [
      "--provider",
      "openai-codex",
      "--model",
      "openai-codex/gpt-5.5",
      "--thinking",
      "off",
      "--no-context-files",
      "--no-skills",
      "--no-extensions",
      "--extension",
      "/abs/codex-usage.ts",
      "--no-session",
      "--no-tools",
      "-p",
      "OK?",
    ]);
  });

  it("uses a private per-user sampler cwd by default", () => {
    const cwd = tempDir();
    const config = resolveCodexQuotaSamplerConfig({
      cwd,
      env: { CODEX_QUOTA_TEXTFILE_DIR: "metrics" },
      extensionPath: "/abs/ext.ts",
      forbiddenSamplerCwds: [],
    });
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";

    assert.equal(config.samplerCwd, join(tmpdir(), `codex-quota-sampler-${uid}`));
    assert.notEqual(config.samplerCwd, join(tmpdir(), "codex-quota-sampler"));
  });

  it("fails loudly when no Prometheus textfile directory is configured or writable", () => {
    const cwd = tempDir();

    assert.throws(
      () => resolveCodexQuotaSamplerConfig({
        cwd,
        env: {},
        extensionPath: "/abs/ext.ts",
        forbiddenSamplerCwds: [],
        isWritableDir: () => false,
      }),
      /requires a configured or writable Prometheus textfile directory/,
    );
  });

  it("rejects sampler cwd values that target the bot dir or configured agent workspaces", () => {
    const workspace = tempDir();
    const botDir = join(workspace, "bot");
    const agentWorkspace = join(workspace, "agent-workspace");
    mkdirSync(botDir, { recursive: true });
    writeFileSync(
      join(workspace, "config.yaml"),
      `
agents:
  main:
    workspaceCwd: ${agentWorkspace}
    model: gpt-5.5
telegramTokenEnv: FAKE_TELEGRAM_TOKEN
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`,
    );

    assert.throws(
      () => resolveCodexQuotaSamplerConfig({
        cwd: workspace,
        botDir,
        env: {},
        cli: { textfileDir: "metrics", samplerCwd: botDir },
        extensionPath: "/abs/ext.ts",
      }),
      /Refusing to use sampler cwd/,
    );
    assert.throws(
      () => resolveCodexQuotaSamplerConfig({
        cwd: workspace,
        botDir,
        env: {},
        cli: { textfileDir: "metrics", samplerCwd: agentWorkspace },
        extensionPath: "/abs/ext.ts",
      }),
      /Refusing to use sampler cwd/,
    );
    assert.doesNotThrow(() => resolveCodexQuotaSamplerConfig({
      cwd: workspace,
      botDir,
      env: {},
      cli: { textfileDir: "metrics", samplerCwd: join(workspace, "isolated-sampler") },
      extensionPath: "/abs/ext.ts",
    }));
  });

  it("parses CLI flags and documents supported options", () => {
    assert.deepEqual(
      parseCodexQuotaSamplerArgs([
        "--model",
        "gpt-5.5",
        "--textfile-dir",
        "metrics",
        "--state-file",
        "quota.json",
        "--sampler-cwd",
        "sampler",
        "--timeout",
        "1234",
        "--pi-bin",
        "/opt/bin/pi",
        "--prompt",
        "OK?",
        "--dry-run",
      ]),
      {
        model: "gpt-5.5",
        textfileDir: "metrics",
        stateFile: "quota.json",
        samplerCwd: "sampler",
        timeoutMs: 1234,
        piBin: "/opt/bin/pi",
        prompt: "OK?",
        dryRun: true,
      },
    );

    assert.throws(() => parseCodexQuotaSamplerArgs(["--state-file"]), /requires a value/);
    assert.throws(() => parseCodexQuotaSamplerArgs(["--timeout-ms", "0"]), /positive integer/);
    assert.throws(() => parseCodexQuotaSamplerArgs(["--unknown"]), /Unknown argument/);

    const help = formatCodexQuotaSamplerHelp();
    for (const flag of ["--model", "--textfile-dir", "--state-file", "--sampler-cwd", "--timeout", "--timeout-ms", "--pi-bin", "--prompt", "--dry-run", "--help"]) {
      assert.ok(help.includes(flag), `help should mention ${flag}`);
    }
  });

  it("resolves CLI/env paths and passes only allowlisted values to the child env", () => {
    const cwd = tempDir();
    const config = resolveCodexQuotaSamplerConfig({
      cwd,
      env: {
        CODEX_QUOTA_MODEL: "codex-mini",
        CODEX_QUOTA_STATE_FILE: "quota/state.json",
        CODEX_QUOTA_TEXTFILE_DIR: "metrics",
        CODEX_QUOTA_SAMPLER_CWD: "sampler-cwd",
        CODEX_QUOTA_TIMEOUT_MS: "1234",
        CODEX_QUOTA_DRY_RUN: "off",
        PATH: "/usr/bin",
      },
      extensionPath: "/abs/ext.ts",
      forbiddenSamplerCwds: [],
    });

    assert.equal(config.model, "openai-codex/codex-mini");
    assert.equal(config.stateFile, join(cwd, "quota", "state.json"));
    assert.equal(config.textfileDir, join(cwd, "metrics"));
    assert.equal(config.samplerCwd, join(cwd, "sampler-cwd"));
    assert.equal(config.timeoutMs, 1234);
    assert.equal(config.extensionPath, "/abs/ext.ts");

    const attemptFile = join(cwd, "attempt.json");
    const env = buildSamplerChildEnv({ ...config, attemptFile }, {
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      ANTHROPIC_API_KEY: "secret",
      CLAUDECODE: "1",
      TELEGRAM_BOT_TOKEN: "secret",
      DISCORD_BOT_TOKEN: "secret",
      TAVILY_API_KEY: "secret",
      NODE_EXPORTER_TEXTFILE_DIR: "/ignored",
      PATH: "/usr/bin",
      HOME: "/Users/test",
    });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.DISCORD_BOT_TOKEN, undefined);
    assert.equal(env.TAVILY_API_KEY, undefined);
    assert.equal(env.NODE_EXPORTER_TEXTFILE_DIR, undefined);
    assert.equal(env.HOME, "/Users/test");
    assert.equal(env.CODEX_QUOTA_STATE_FILE, config.stateFile);
    assert.equal(env.CODEX_QUOTA_TEXTFILE_DIR, config.textfileDir);
    assert.equal(env[CODEX_QUOTA_ATTEMPT_FILE_ENV], attemptFile);
    assert.match(env.PATH ?? "", /^\/opt\/homebrew\/bin:/);
  });

  it("rejects invalid boolean environment values", () => {
    assert.throws(
      () => resolveCodexQuotaSamplerConfig({
        env: {
          CODEX_QUOTA_DRY_RUN: "maybe",
          CODEX_QUOTA_TEXTFILE_DIR: "metrics",
        },
        forbiddenSamplerCwds: [],
      }),
      /CODEX_QUOTA_DRY_RUN must be boolean-like/,
    );
  });
});

describe("codex quota sampler probe execution", () => {
  it("records a successful quota snapshot and probe attempt", async () => {
    const dir = tempDir();
    const stateFile = join(dir, "state.json");
    const textfileDir = join(dir, "metrics");
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const spawn: SamplerSpawn = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      const child = new FakeChild();
      setImmediate(() => {
        const captured = captureCodexQuotaFromHeaders(
          {
            "x-codex-primary-used-percent": "12.5",
            "x-codex-secondary-used-percent": "88",
            "x-codex-primary-reset-at": "2026-06-05T17:00:00.000Z",
            "x-codex-secondary-reset-at": "2026-06-12T00:00:00.000Z",
          },
          {
            env: options.env,
            now: new Date("2026-06-05T12:00:01.000Z"),
          },
        );
        assert.equal(captured.status, "captured");
        child.close(0);
      });
      return child;
    };

    const result = await runCodexQuotaSampler({
      now: new Date("2026-06-05T12:00:00.000Z"),
      spawn,
      config: {
        piBin: "pi",
        model: "openai-codex/gpt-5.5",
        prompt: "OK?",
        stateFile,
        textfileDir,
        samplerCwd: join(dir, "sampler"),
        extensionPath: "/abs/codex-usage.ts",
        timeoutMs: 1_000,
        killGraceMs: 10,
        dryRun: false,
      },
    });

    assert.equal(result.status, "success");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "pi");
    assert.equal(calls[0].cwd, join(dir, "sampler"));
    assert.equal(calls[0].args.includes("--no-extensions"), true);
    assert.equal(calls[0].args.includes("--extension"), true);
    assert.ok(result.attemptFile?.startsWith(join(dir, "sampler", ".tmp")));
    assert.equal(result.attemptMetricsFile, join(dir, "metrics", CODEX_QUOTA_PROBE_TEXTFILE_NAME));

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.windows["5h"].usedPercent, 12.5);
    assert.equal(state.lastSuccessTimestamp, 1780660801);
    assert.equal(state.lastAttemptTimestamp, 1780660800);
    assert.equal(state.probeSuccess, true);

    const usageMetrics = readFileSync(join(textfileDir, CODEX_USAGE_TEXTFILE_NAME), "utf8");
    assert.match(usageMetrics, /codex_usage_5h_percent 12\.5/);

    const metrics = readFileSync(result.attemptMetricsFile, "utf8");
    assert.match(metrics, /codex_usage_last_attempt_timestamp 1780660800/);
    assert.match(metrics, /codex_usage_probe_success 1/);
    assert.equal(readdirSync(dirname(result.attemptMetricsFile)).some((name) => name.endsWith(".tmp")), false);
  });

  it("times out a hung child, kills it, and resolves as failure", async () => {
    const child = new FakeChild();
    const result = await runPiProbe({
      command: "pi",
      args: ["-p", "OK?"],
      cwd: tempDir(),
      env: {},
      timeoutMs: 5,
      killGraceMs: 5,
      spawn: () => child,
    });

    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  });

  it("records failure attempts without overwriting prior successful state or usage metrics", async () => {
    const dir = tempDir();
    const stateFile = join(dir, "state.json");
    const textfileDir = join(dir, "metrics");
    const successMetricsFile = join(textfileDir, "codex_usage.prom");
    const priorState = {
      provider: "codex",
      sampledAt: "2026-06-05T12:00:00.000Z",
      lastSuccess: "2026-06-05T12:00:00.000Z",
      lastSuccessTimestamp: 1780660800,
      windows: {
        "5h": { usedPercent: 42 },
        week: {},
      },
    };
    const priorMetrics = "codex_usage_5h_percent 42\n";
    mkdirSync(textfileDir, { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify(priorState, null, 2)}\n`);
    writeFileSync(successMetricsFile, priorMetrics);

    const spawn: SamplerSpawn = (_command, _args, options) => {
      const child = new FakeChild();
      setImmediate(() => {
        const captured = captureCodexQuotaFromHeaders(
          { "x-codex-primary-used-percent": "99" },
          {
            env: options.env,
            now: new Date("2026-06-05T12:30:01.000Z"),
          },
        );
        assert.equal(captured.status, "captured");
        child.stderr.write("provider failed\n");
        child.close(1);
      });
      return child;
    };

    const result = await runCodexQuotaSampler({
      now: new Date("2026-06-05T12:30:00.000Z"),
      spawn,
      config: {
        piBin: "pi",
        model: "openai-codex/gpt-5.5",
        prompt: "OK?",
        stateFile,
        textfileDir,
        samplerCwd: join(dir, "sampler"),
        extensionPath: "/abs/codex-usage.ts",
        timeoutMs: 1_000,
        killGraceMs: 10,
        dryRun: false,
      },
    });

    assert.equal(result.status, "failure");
    assert.equal(readFileSync(successMetricsFile, "utf8"), priorMetrics);

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.windows["5h"].usedPercent, 42);
    assert.equal(state.lastSuccessTimestamp, 1780660800);
    assert.equal(state.lastAttemptTimestamp, 1780662600);
    assert.equal(state.probeSuccess, false);

    const attemptMetrics = readFileSync(join(textfileDir, CODEX_QUOTA_PROBE_TEXTFILE_NAME), "utf8");
    assert.match(attemptMetrics, /codex_usage_last_attempt_timestamp 1780662600/);
    assert.match(attemptMetrics, /codex_usage_probe_success 0/);
  });

  it("writes failure attempt metrics even when attempt state cannot be updated", async () => {
    const dir = tempDir();
    const stateFile = join(dir, "state-as-dir");
    const textfileDir = join(dir, "metrics");
    mkdirSync(stateFile);

    const spawn: SamplerSpawn = () => {
      const child = new FakeChild();
      setImmediate(() => child.close(0));
      return child;
    };

    const result = await runCodexQuotaSampler({
      now: new Date("2026-06-05T13:00:00.000Z"),
      spawn,
      config: {
        piBin: "pi",
        model: "openai-codex/gpt-5.5",
        prompt: "OK?",
        stateFile,
        textfileDir,
        samplerCwd: join(dir, "sampler"),
        extensionPath: "/abs/codex-usage.ts",
        timeoutMs: 1_000,
        killGraceMs: 10,
        dryRun: false,
      },
    });

    assert.equal(result.status, "failure");
    assert.match(result.failureReason ?? "", /probe attempt state write failed/);
    const attemptMetricsFile = result.attemptMetricsFile;
    assert.equal(attemptMetricsFile, join(textfileDir, CODEX_QUOTA_PROBE_TEXTFILE_NAME));
    assert.ok(attemptMetricsFile);

    const attemptMetrics = readFileSync(attemptMetricsFile, "utf8");
    assert.match(attemptMetrics, /codex_usage_last_attempt_timestamp 1780664400/);
    assert.match(attemptMetrics, /codex_usage_probe_success 0/);
  });

  it("treats child exit zero without a refreshed quota cache as failure", async () => {
    const dir = tempDir();
    const stateFile = join(dir, "state.json");
    const textfileDir = join(dir, "metrics");
    const spawn: SamplerSpawn = () => {
      const child = new FakeChild();
      setImmediate(() => child.close(0));
      return child;
    };

    const result = await runCodexQuotaSampler({
      now: new Date("2026-06-05T12:45:00.000Z"),
      spawn,
      config: {
        piBin: "pi",
        model: "openai-codex/gpt-5.5",
        prompt: "OK?",
        stateFile,
        textfileDir,
        samplerCwd: join(dir, "sampler"),
        extensionPath: "/abs/codex-usage.ts",
        timeoutMs: 1_000,
        killGraceMs: 10,
        dryRun: false,
      },
    });

    assert.equal(result.status, "failure");
    assert.equal(result.failureReason, "quota cache was not refreshed");

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.provider, "codex");
    assert.deepEqual(state.windows, { "5h": {}, week: {} });
    assert.equal(state.lastAttemptTimestamp, 1780663500);
    assert.equal(state.probeSuccess, false);

    const attemptMetrics = readFileSync(join(textfileDir, CODEX_QUOTA_PROBE_TEXTFILE_NAME), "utf8");
    assert.match(attemptMetrics, /codex_usage_probe_success 0/);
  });

  it("does not launch Pi or write files in dry-run mode", async () => {
    const dir = tempDir();
    let spawned = false;
    const samplerCwd = join(dir, "sampler");

    const result = await runCodexQuotaSampler({
      spawn: () => {
        spawned = true;
        return new FakeChild();
      },
      config: {
        piBin: "pi",
        model: "openai-codex/gpt-5.5",
        prompt: "OK?",
        stateFile: join(dir, "state.json"),
        textfileDir: join(dir, "metrics"),
        samplerCwd,
        extensionPath: "/abs/codex-usage.ts",
        timeoutMs: 1_000,
        killGraceMs: 10,
        dryRun: true,
      },
    });

    assert.equal(result.status, "dry_run");
    assert.equal(spawned, false);
    assert.equal(existsSync(samplerCwd), false);
    assert.equal(existsSync(result.settingsFile), false);
    assert.equal(existsSync(join(dir, "metrics", CODEX_QUOTA_PROBE_TEXTFILE_NAME)), false);
  });
});
