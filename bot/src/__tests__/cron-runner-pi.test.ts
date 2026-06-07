import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import { runPi, type PiRunDeps } from "../cron-runner.js";
import { assemblePiContext } from "../pi-context-assembler.js";
import {
  buildPiSpawnEnv,
} from "../pi-rpc-protocol.js";
import type { AgentConfig, CronJob } from "../types.js";
import {
  MINIME_CONFIG_PATH_ENV,
  MINIME_CRONS_PATH_ENV,
  MINIME_WORKSPACE_ROOT_ENV,
} from "../workspace-contract.js";

interface SpawnCapture {
  command: string;
  args: string[];
  options: SpawnSyncOptionsWithStringEncoding;
}

const fixtures: string[] = [];

after(() => {
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "cron-runner-pi-"));
  fixtures.push(ws);
  return ws;
}

function makeCron(overrides: Partial<CronJob> = {}): CronJob {
  return {
    name: "pi-cron-test",
    schedule: "0 * * * *",
    type: "llm",
    prompt: "Summarize the workspace",
    agentId: "main",
    deliveryChatId: 111111111,
    engine: "pi",
    ...overrides,
  };
}

function makeAgent(workspaceCwd: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "main",
    workspaceCwd,
    provider: "pi",
    model: "openai-codex/gpt-5.5",
    ...overrides,
  };
}

function spawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 12345,
    output: [null, " pi output\n", ""],
    stdout: " pi output\n",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

function capturingSpawn(
  captures: SpawnCapture[],
  result: SpawnSyncReturns<string> = spawnResult(),
): PiRunDeps["spawnSync"] {
  return (command, args, options) => {
    captures.push({ command, args: [...args], options });
    return result;
  };
}

function makeDeps(
  captures: SpawnCapture[],
  overrides: Partial<PiRunDeps> = {},
): PiRunDeps {
  return {
    spawnSync: capturingSpawn(captures),
    buildAgentConfig: (_cron, cwd) => makeAgent(cwd),
    buildEnv: () => ({}),
    assembleContext: () => null,
    ...overrides,
  };
}

function flagValue(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  assert.notStrictEqual(idx, -1, `missing ${flag}`);
  return args[idx + 1];
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let idx = args.indexOf(flag); idx !== -1; idx = args.indexOf(flag, idx + 2)) {
    values.push(args[idx + 1]);
  }
  return values;
}

function assertCronSystemInstruction(value: string): void {
  assert.match(value, /^Today is \d{4}-\d{2}-\d{2}\. Respond concisely\.$/);
}

describe("cron-runner runPi", () => {
  it("spawns Pi in print one-shot mode with the required argv and spawn options", () => {
    const ws = makeWorkspace();
    const captures: SpawnCapture[] = [];
    const deps = makeDeps(captures, {
      buildAgentConfig: (_cron, cwd) => makeAgent(cwd, { thinking: "high" }),
    });

    const output = runPi(makeCron({ timeout: 1234 }), ws, deps);

    assert.strictEqual(output, "pi output");
    assert.strictEqual(captures.length, 1);
    const capture = captures[0];
    assert.strictEqual(capture.command, "pi");
    assert.deepStrictEqual(capture.args.slice(0, 8), [
      "-p",
      "Summarize the workspace",
      "--no-session",
      "--no-extensions",
      "--model",
      "openai-codex/gpt-5.5",
      "--thinking",
      "high",
    ]);
    assertCronSystemInstruction(flagValue(capture.args, "--append-system-prompt"));
    assert.ok(!capture.args.includes("--extension"));
    assert.strictEqual(capture.options.input, undefined);
    assert.strictEqual(capture.options.cwd, ws);
    assert.strictEqual(capture.options.timeout, 1234);
    assert.strictEqual(capture.options.encoding, "utf8");
    assert.strictEqual(capture.options.maxBuffer, 10 * 1024 * 1024);

    for (const forbidden of [
      "--mode",
      "--output-format",
      "--fallback-model",
      "--max-turns",
      "--dangerously-skip-permissions",
      "--add-dir",
      "--session",
    ]) {
      assert.ok(!capture.args.includes(forbidden), `forbidden Pi cron flag present: ${forbidden}`);
    }
  });

  it("passes option-like cron prompts as safe positional argv", () => {
    for (const prompt of [
      "- start with a single dash",
      "--model malicious-model",
      "@prompt-file.md should be literal text",
    ]) {
      const ws = makeWorkspace();
      const captures: SpawnCapture[] = [];
      const deps = makeDeps(captures);

      runPi(makeCron({ prompt }), ws, deps);

      assert.strictEqual(captures[0].options.input, undefined);
      assert.strictEqual(captures[0].args[0], "-p");
      assert.strictEqual(captures[0].args[1], ` ${prompt}`);
      assert.strictEqual(captures[0].args[2], "--no-session");
    }
  });

  it("defaults --thinking to medium when thinking is absent or unsupported", () => {
    for (const thinking of [undefined, "turbo" as unknown as AgentConfig["thinking"]]) {
      const ws = makeWorkspace();
      const captures: SpawnCapture[] = [];
      const deps = makeDeps(captures, {
        buildAgentConfig: (_cron, cwd) => makeAgent(cwd, { thinking }),
      });

      runPi(makeCron(), ws, deps);

      assert.strictEqual(flagValue(captures[0].args, "--thinking"), "medium");
    }
  });

  it("passes context artifact args before the fixed cron instruction", () => {
    const ws = makeWorkspace();
    const captures: SpawnCapture[] = [];
    const deps = makeDeps(captures, {
      assembleContext: () => ({
        systemPromptPath: "/tmp/pi-persona.md",
        appendSystemPromptPath: "/tmp/pi-bundle.md",
      }),
    });

    runPi(makeCron(), ws, deps);

    const args = captures[0].args;
    assert.strictEqual(flagValue(args, "--system-prompt"), "/tmp/pi-persona.md");
    const appendPrompts = flagValues(args, "--append-system-prompt");
    assert.strictEqual(appendPrompts[0], "/tmp/pi-bundle.md");
    assertCronSystemInstruction(appendPrompts[1]);
    assert.ok(args.includes("--no-context-files"));

    const thinkingIdx = args.indexOf("--thinking");
    const systemIdx = args.indexOf("--system-prompt");
    const appendIdx = args.indexOf("--append-system-prompt");
    const noContextIdx = args.indexOf("--no-context-files");
    const cronInstructionIdx = args.indexOf("--append-system-prompt", appendIdx + 2);
    assert.ok(thinkingIdx < systemIdx);
    assert.ok(systemIdx < appendIdx);
    assert.ok(appendIdx < noContextIdx);
    assert.ok(noContextIdx < cronInstructionIdx);
    assert.ok(!args.includes("--extension"));
  });

  it("suppresses flat context loading when context assembly throws", () => {
    const ws = makeWorkspace();
    const captures: SpawnCapture[] = [];
    const deps = makeDeps(captures, {
      assembleContext: () => {
        throw new Error("artifact write failed");
      },
    });

    runPi(makeCron(), ws, deps);

    const args = captures[0].args;
    assert.ok(!args.includes("--system-prompt"));
    assert.ok(args.includes("--no-context-files"));
    const appendPrompts = flagValues(args, "--append-system-prompt");
    assert.strictEqual(appendPrompts.length, 1);
    assertCronSystemInstruction(appendPrompts[0]);
    assert.ok(args.indexOf("--no-context-files") < args.indexOf("--append-system-prompt"));
  });

  it("passes pre-resolved cron agent data into the Pi agent builder", () => {
    const ws = makeWorkspace();
    const captures: SpawnCapture[] = [];
    const agentData = {
      id: "main",
      workspaceCwd: ws,
      systemPrompt: "PERSONA_TOKEN",
      thinking: "low" as const,
    };
    let seenAgentData: typeof agentData | undefined;
    const deps = makeDeps(captures, {
      buildAgentConfig: (_cron, cwd, data) => {
        seenAgentData = data as typeof agentData;
        return makeAgent(cwd, { systemPrompt: data?.systemPrompt, thinking: data?.thinking });
      },
    });

    runPi(makeCron(), ws, deps, agentData);

    assert.deepStrictEqual(seenAgentData, agentData);
    assert.strictEqual(flagValue(captures[0].args, "--thinking"), "low");
  });

  it("uses the real context assembler output when the default context dependency is in place", () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, ".claude", "rules", "platform"), { recursive: true });
    writeFileSync(join(ws, "CLAUDE.md"), "# Cron Agent\n\nBODY_TOKEN", "utf8");
    writeFileSync(join(ws, ".claude", "rules", "platform", "cron.md"), "RULE_TOKEN", "utf8");
    const captures: SpawnCapture[] = [];
    const deps = makeDeps(captures, {
      buildAgentConfig: (_cron, cwd) => makeAgent(cwd, { systemPrompt: "PERSONA_TOKEN" }),
      assembleContext: assemblePiContext,
    });

    runPi(makeCron(), ws, deps);

    const args = captures[0].args;
    const personaPath = flagValue(args, "--system-prompt");
    const bundlePath = flagValue(args, "--append-system-prompt");
    assert.ok(personaPath.endsWith(join(".tmp", "pi-context-main.persona.md")));
    assert.ok(bundlePath.endsWith(join(".tmp", "pi-context-main.bundle.md")));
    assert.ok(args.includes("--no-context-files"));
  });

  it("validates the agent workspace before assembling cron context", () => {
    const workspaceRoot = makeWorkspace();
    const missingWorkspace = join(workspaceRoot, "missing-agent-workspace");
    const oldWorkspace = process.env[MINIME_WORKSPACE_ROOT_ENV];
    let assembled = false;

    try {
      process.env[MINIME_WORKSPACE_ROOT_ENV] = workspaceRoot;
      const captures: SpawnCapture[] = [];
      const deps = makeDeps(captures, {
        buildEnv: buildPiSpawnEnv,
        assembleContext: () => {
          assembled = true;
          return null;
        },
      });

      assert.throws(
        () => runPi(makeCron(), missingWorkspace, deps),
        /workspaceCwd does not exist/,
      );
      assert.strictEqual(assembled, false);
      assert.strictEqual(captures.length, 0);
    } finally {
      if (oldWorkspace === undefined) {
        delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_WORKSPACE_ROOT_ENV] = oldWorkspace;
      }
    }
  });

  it("uses a scrubbed Pi env and sets HOME when the parent environment lacks it", () => {
    const oldHome = process.env.HOME;
    const oldClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const oldClaudeCode = process.env.CLAUDECODE;
    const openAiKeyEnv = ["OPENAI", "API", "KEY"].join("_");
    const piSessionDirEnv = ["PI", "CODING", "AGENT", "SESSION", "DIR"].join("_");
    const telegramTokenEnv = ["TELEGRAM", "BOT", "TOKEN"].join("_");
    const tavilyKeyEnv = ["TAVILY", "API", "KEY"].join("_");
    const sessionSecretEnv = ["MINIME", "SESSION", "SECRET"].join("_");
    const githubTokenEnv = ["GITHUB", "TOKEN"].join("_");
    const awsSecretEnv = ["AWS", "SECRET", "ACCESS", "KEY"].join("_");
    const discordTokenEnv = ["DISCORD", "BOT", "TOKEN"].join("_");
    const oldOpenAiKey = process.env[openAiKeyEnv];
    const oldPiSessionDir = process.env[piSessionDirEnv];
    const oldTelegramToken = process.env[telegramTokenEnv];
    const oldTavilyKey = process.env[tavilyKeyEnv];
    const oldSessionSecret = process.env[sessionSecretEnv];
    const oldGithubToken = process.env[githubTokenEnv];
    const oldAwsSecret = process.env[awsSecretEnv];
    const oldDiscordToken = process.env[discordTokenEnv];
    const oldWorkspace = process.env[MINIME_WORKSPACE_ROOT_ENV];
    const oldConfigPath = process.env[MINIME_CONFIG_PATH_ENV];
    const oldCronsPath = process.env[MINIME_CRONS_PATH_ENV];
    const fixtureValues = ["cron-telegram-fixture", "cron-discord-fixture", "cron-tavily-fixture"];

    try {
      delete process.env.HOME;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "value-one";
      process.env.ANTHROPIC_API_KEY = "value-two";
      process.env[openAiKeyEnv] = "secret-openai";
      process.env[piSessionDirEnv] = "/tmp/pi-sessions";
      process.env.CLAUDECODE = "session-marker";
      process.env[telegramTokenEnv] = fixtureValues[0];
      process.env[discordTokenEnv] = fixtureValues[1];
      process.env[tavilyKeyEnv] = fixtureValues[2];
      process.env[sessionSecretEnv] = "fixture";
      process.env[githubTokenEnv] = "fixture";
      process.env[awsSecretEnv] = "fixture";

      const ws = makeWorkspace();
      process.env[MINIME_WORKSPACE_ROOT_ENV] = ws;
      process.env[MINIME_CONFIG_PATH_ENV] = "settings/config.yaml";
      process.env[MINIME_CRONS_PATH_ENV] = join(ws, "settings", "crons.yaml");
      const captures: SpawnCapture[] = [];
      const deps = makeDeps(captures, { buildEnv: buildPiSpawnEnv });

      runPi(makeCron(), ws, deps);

      const env = captures[0].options.env ?? {};
      assert.strictEqual(env.HOME, homedir());
      assert.strictEqual(env[MINIME_WORKSPACE_ROOT_ENV], ws);
      assert.strictEqual(env[MINIME_CONFIG_PATH_ENV], join(ws, "settings", "config.yaml"));
      assert.strictEqual(env[MINIME_CRONS_PATH_ENV], join(ws, "settings", "crons.yaml"));
      assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
      assert.strictEqual(env[openAiKeyEnv], undefined);
      assert.strictEqual(env[piSessionDirEnv], "/tmp/pi-sessions");
      assert.strictEqual(env.CLAUDECODE, undefined);
      assert.strictEqual(env[telegramTokenEnv], undefined);
      assert.strictEqual(env[discordTokenEnv], undefined);
      assert.strictEqual(env[tavilyKeyEnv], undefined);
      assert.strictEqual(env[sessionSecretEnv], undefined);
      assert.strictEqual(env[githubTokenEnv], undefined);
      assert.strictEqual(env[awsSecretEnv], undefined);
      assert.ok(env.PATH?.includes("/opt/homebrew/bin"));
      assert.strictEqual(captures[0].options.timeout, 900000);
      const serializedChildContract = JSON.stringify({ env, args: captures[0].args });
      for (const value of fixtureValues) {
        assert.doesNotMatch(serializedChildContract, new RegExp(value));
      }
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      if (oldClaudeToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = oldClaudeToken;
      }
      if (oldAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env["ANTHROPIC_API_KEY"] = oldAnthropicKey;
      }
      if (oldOpenAiKey === undefined) {
        delete process.env[openAiKeyEnv];
      } else {
        process.env[openAiKeyEnv] = oldOpenAiKey;
      }
      if (oldPiSessionDir === undefined) {
        delete process.env[piSessionDirEnv];
      } else {
        process.env[piSessionDirEnv] = oldPiSessionDir;
      }
      if (oldClaudeCode === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = oldClaudeCode;
      }
      if (oldTelegramToken === undefined) {
        delete process.env[telegramTokenEnv];
      } else {
        process.env[telegramTokenEnv] = oldTelegramToken;
      }
      if (oldTavilyKey === undefined) {
        delete process.env[tavilyKeyEnv];
      } else {
        process.env[tavilyKeyEnv] = oldTavilyKey;
      }
      if (oldDiscordToken === undefined) {
        delete process.env[discordTokenEnv];
      } else {
        process.env[discordTokenEnv] = oldDiscordToken;
      }
      if (oldSessionSecret === undefined) {
        delete process.env[sessionSecretEnv];
      } else {
        process.env[sessionSecretEnv] = oldSessionSecret;
      }
      if (oldGithubToken === undefined) {
        delete process.env[githubTokenEnv];
      } else {
        process.env[githubTokenEnv] = oldGithubToken;
      }
      if (oldAwsSecret === undefined) {
        delete process.env[awsSecretEnv];
      } else {
        process.env[awsSecretEnv] = oldAwsSecret;
      }
      if (oldWorkspace === undefined) {
        delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_WORKSPACE_ROOT_ENV] = oldWorkspace;
      }
      if (oldConfigPath === undefined) {
        delete process.env[MINIME_CONFIG_PATH_ENV];
      } else {
        process.env[MINIME_CONFIG_PATH_ENV] = oldConfigPath;
      }
      if (oldCronsPath === undefined) {
        delete process.env[MINIME_CRONS_PATH_ENV];
      } else {
        process.env[MINIME_CRONS_PATH_ENV] = oldCronsPath;
      }
    }
  });

  it("keeps only allowed Pi runtime keys in the hardened cron env", () => {
    const oldWorkspace = process.env[MINIME_WORKSPACE_ROOT_ENV];
    const workspace = makeWorkspace();
    const agentWorkspace = join(workspace, "agent-workspace");
    mkdirSync(agentWorkspace, { recursive: true });

    try {
      process.env[MINIME_WORKSPACE_ROOT_ENV] = workspace;
      const captures: SpawnCapture[] = [];
      const deps = makeDeps(captures, {
        buildEnv: buildPiSpawnEnv,
        buildAgentConfig: (_cron, cwd) => makeAgent(cwd),
      });

      runPi(makeCron(), agentWorkspace, deps);

      const env = captures[0].options.env ?? {};
      assert.strictEqual(env[MINIME_WORKSPACE_ROOT_ENV], workspace);
      assert.strictEqual(captures[0].options.cwd, agentWorkspace);
    } finally {
      if (oldWorkspace === undefined) {
        delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_WORKSPACE_ROOT_ENV] = oldWorkspace;
      }
    }
  });

  it("allows Pi cron spawns with no explicit first-party wrappers", () => {
    const ws = makeWorkspace();
    const captures: SpawnCapture[] = [];
    const deps = makeDeps(captures);

    runPi(makeCron(), ws, deps);

    assert.strictEqual(captures.length, 1);
    assert.ok(!captures[0].args.includes("--extension"));
  });

  it("throws classified Pi errors with bounded private diagnostics so main can use the FAIL path", () => {
    const ws = makeWorkspace();
    const captures: SpawnCapture[] = [];
    const deps = makeDeps(captures, {
      spawnSync: capturingSpawn(captures, spawnResult({ stdout: "", stderr: "auth expired" })),
    });

    assert.throws(() => runPi(makeCron(), ws, deps), (err: unknown) => {
      assert.match((err as Error).message, /Pi cron produced stderr without stdout/);
      assert.doesNotMatch((err as Error).message, /auth expired/);
      assert.match((err as { diagnostics?: string }).diagnostics ?? "", /stderr: auth expired/);
      return true;
    });
  });

  it("throws spawn errors before result classification", () => {
    const ws = makeWorkspace();
    const captures: SpawnCapture[] = [];
    const deps = makeDeps(captures, {
      spawnSync: capturingSpawn(captures, spawnResult({ error: new Error("ENOENT pi") })),
    });

    assert.throws(() => runPi(makeCron(), ws, deps), /Pi cron spawn failed: ENOENT pi/);
  });

  it("keeps timeout spawn diagnostics separate from the public spawn error", () => {
    const ws = makeWorkspace();
    const captures: SpawnCapture[] = [];
    const timeoutError = Object.assign(new Error("spawnSync pi ETIMEDOUT"), { code: "ETIMEDOUT" });
    const deps = makeDeps(captures, {
      spawnSync: capturingSpawn(captures, spawnResult({
        error: timeoutError,
        stdout: "partial timeout stdout",
        stderr: "timeout stderr details",
        status: null,
        signal: "SIGTERM",
      })),
    });

    assert.throws(() => runPi(makeCron(), ws, deps), (err: unknown) => {
      assert.match((err as Error).message, /Pi cron spawn failed: spawnSync pi ETIMEDOUT/);
      assert.doesNotMatch((err as Error).message, /timeout stderr details/);
      assert.match((err as { diagnostics?: string }).diagnostics ?? "", /stderr: timeout stderr details/);
      assert.match((err as { diagnostics?: string }).diagnostics ?? "", /stdout: partial timeout stdout/);
      return true;
    });
  });
});
