import { describe, it, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { loadConfig } from "../config.js";
import { MINIME_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";
import type { ExecFileSyncLike } from "../secrets.js";

interface SpawnCapture {
  command: string;
  args: string[];
  options: SpawnOptions;
}

const fixtures: string[] = [];
const spawnCaptures: SpawnCapture[] = [];

mock.module("node:child_process", {
  namedExports: {
    spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
      spawnCaptures.push({ command, args: [...args], options });
      return createMockChild();
    },
  },
});

const {
  PI_EXTENSIONS_DISABLED_ENV,
  spawnPiRpcSession,
} = await import("../pi-rpc-protocol.js");

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

afterEach(() => {
  spawnCaptures.length = 0;
});

function createMockChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    stdin: new Writable({ write(_chunk, _enc, callback) { callback(); } }),
    pid: 12345,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill() {
      (child as unknown as { killed: boolean }).killed = true;
      return true;
    },
  });
  return child;
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1];
}

describe("Pi spawn workspace contract", () => {
  it("uses per-agent sibling workspace cwd/context while reading config secrets from the control workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "minime-pi-spawn-workspaces-"));
    fixtures.push(root);
    const controlWorkspace = join(root, "control-workspace");
    const mainWorkspace = join(root, "agent-workspace-main");
    const reviewerWorkspace = join(root, "agent-workspace-reviewer");
    const controlSecretsFile = join(controlWorkspace, "config", "secrets.sops.yaml");
    mkdirSync(dirname(controlSecretsFile), { recursive: true });
    mkdirSync(mainWorkspace, { recursive: true });
    mkdirSync(reviewerWorkspace, { recursive: true });
    writeFileSync(controlSecretsFile, "telegram:\n  bot_token: ENC[AES256_GCM,data:test]\n", "utf8");
    writeFileSync(join(mainWorkspace, "CLAUDE.md"), "# Main\n\nMAIN_CONTEXT_TOKEN", "utf8");
    writeFileSync(join(reviewerWorkspace, "CLAUDE.md"), "# Reviewer\n\nREVIEWER_CONTEXT_TOKEN", "utf8");
    writeFileSync(
      join(controlWorkspace, "config.yaml"),
      [
        "secrets:",
        "  sopsFile: config/secrets.sops.yaml",
        "telegramTokenSopsKey: telegram.bot_token",
        "agents:",
        "  main:",
        `    workspaceCwd: ${mainWorkspace}`,
        "    model: gpt-5.5",
        "  reviewer:",
        `    workspaceCwd: ${reviewerWorkspace}`,
        "    model: gpt-5.5",
        "bindings:",
        "  - chatId: 111",
        "    agentId: main",
        "    kind: dm",
        "  - chatId: 222",
        "    agentId: reviewer",
        "    kind: dm",
        "",
      ].join("\n"),
      "utf8",
    );

    const secretReads: string[] = [];
    const fakeSops: ExecFileSyncLike = (_file, args) => {
      secretReads.push(args[args.length - 1]);
      return "resolved-telegram-token\n";
    };
    const oldWorkspace = process.env[MINIME_WORKSPACE_ROOT_ENV];
    const oldDisabled = process.env[PI_EXTENSIONS_DISABLED_ENV];
    const secretEnvKeys = [
      ["TELEGRAM", "BOT", "TOKEN"].join("_"),
      ["DISCORD", "BOT", "TOKEN"].join("_"),
      ["TAVILY", "API", "KEY"].join("_"),
    ] as const;
    const oldSecretValues = new Map(secretEnvKeys.map((key) => [key, process.env[key]]));
    const fixtureValues = [
      "parent-telegram-fixture",
      "parent-discord-fixture",
      "parent-tavily-fixture",
      "resolved-telegram-token",
    ];

    try {
      process.env[MINIME_WORKSPACE_ROOT_ENV] = controlWorkspace;
      process.env[PI_EXTENSIONS_DISABLED_ENV] = "1";
      process.env[secretEnvKeys[0]] = fixtureValues[0];
      process.env[secretEnvKeys[1]] = fixtureValues[1];
      process.env[secretEnvKeys[2]] = fixtureValues[2];
      const config = loadConfig(join(controlWorkspace, "config.yaml"), {
        workspaceRoot: controlWorkspace,
        secretExecFileSync: fakeSops,
      });

      assert.equal(config.agents.main.workspaceCwd, mainWorkspace);
      assert.equal(config.agents.reviewer.workspaceCwd, reviewerWorkspace);
      assert.deepEqual(secretReads, [controlSecretsFile]);

      spawnPiRpcSession(config.agents.main);
      spawnPiRpcSession(config.agents.reviewer);

      assert.equal(spawnCaptures.length, 2);
      assert.equal(spawnCaptures[0].command, "pi");
      assert.equal(spawnCaptures[0].options.cwd, mainWorkspace);
      assert.equal(spawnCaptures[1].options.cwd, reviewerWorkspace);
      for (const capture of spawnCaptures) {
        const env = capture.options.env as NodeJS.ProcessEnv;
        assert.equal(env[MINIME_WORKSPACE_ROOT_ENV], controlWorkspace);
        const serializedChildContract = JSON.stringify({ env, args: capture.args });
        for (const value of fixtureValues) {
          assert.doesNotMatch(serializedChildContract, new RegExp(value));
        }
      }

      const mainBundle = readFileSync(flagValue(spawnCaptures[0].args, "--append-system-prompt"), "utf8");
      const reviewerBundle = readFileSync(flagValue(spawnCaptures[1].args, "--append-system-prompt"), "utf8");
      assert.match(mainBundle, /MAIN_CONTEXT_TOKEN/);
      assert.doesNotMatch(mainBundle, /REVIEWER_CONTEXT_TOKEN/);
      assert.match(reviewerBundle, /REVIEWER_CONTEXT_TOKEN/);
      assert.doesNotMatch(reviewerBundle, /MAIN_CONTEXT_TOKEN/);
    } finally {
      if (oldWorkspace === undefined) {
        delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_WORKSPACE_ROOT_ENV] = oldWorkspace;
      }
      if (oldDisabled === undefined) {
        delete process.env[PI_EXTENSIONS_DISABLED_ENV];
      } else {
        process.env[PI_EXTENSIONS_DISABLED_ENV] = oldDisabled;
      }
      for (const key of secretEnvKeys) {
        const oldValue = oldSecretValues.get(key);
        if (oldValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = oldValue;
        }
      }
    }
  });
});
