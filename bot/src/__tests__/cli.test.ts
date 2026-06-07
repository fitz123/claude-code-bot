import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../cli.js";
import { MINIME_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = resolve(__dirname, "..", "..");
const CLI_TS = join(BOT_ROOT, "src", "cli.ts");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const MINIMAL_WORKSPACE_FIXTURE = join(BOT_ROOT, "test-fixtures", "minimal-workspace");

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "minime-cli-workspace-"));
  mkdirSync(join(workspace, "agent-workspace"), { recursive: true });
  writeFileSync(
    join(workspace, "config.yaml"),
    `
agents:
  main:
    workspaceCwd: ./agent-workspace
    model: gpt-5.5
secrets:
  sopsFile: missing.sops.yaml
telegramTokenSopsKey: telegram.bot_token
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`,
  );
  writeFileSync(
    join(workspace, "crons.yaml"),
    `
crons:
  - name: smoke
    schedule: "0 9 * * *"
    prompt: "smoke"
    agentId: main
    deliveryChatId: 111
`,
  );
  return workspace;
}

function runWithCapture(args: readonly string[], workspace?: string, env: NodeJS.ProcessEnv = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
  let stdout = "";
  let stderr = "";
  const code = runCli(args, {
    cwd: workspace,
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("minime-bot CLI", () => {
  it("prints help", () => {
    const result = runWithCapture(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /minime-bot config validate --workspace <path>/);
    assert.match(result.stdout, /minime-bot workspace validate --workspace <path>/);
    assert.match(result.stdout, /Control\/app workspace root/);
    assert.match(result.stdout, /Defaults to MINIME_WORKSPACE_ROOT, then source repo root or package cwd\./);
    assert.doesNotMatch(result.stdout, /current repo layout/);
    assert.equal(result.stderr, "");
  });

  it("validates config with explicit --workspace and does not resolve SOPS secrets", () => {
    const workspace = createWorkspace();
    try {
      const result = runWithCapture(["config", "validate", "--workspace", workspace], workspace);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /Config valid\./);
      assert.match(result.stdout, /Agents: main/);
      assert.doesNotMatch(result.stdout, /telegram\.bot_token/);
      assert.equal(result.stderr, "");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("validates a workspace and prints effective path diagnostics", () => {
    const workspace = createWorkspace();
    try {
      const result = runWithCapture(["workspace", "validate", "--workspace", workspace], workspace);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /Workspace valid\./);
      assert.match(result.stdout, /Effective paths:/);
      assert.match(result.stdout, new RegExp(`control workspace root: ${escapeRegExp(workspace)} \\(cli\\)`));
      assert.match(result.stdout, /package root:/);
      assert.match(result.stdout, /config path:/);
      assert.match(result.stdout, /crons path:/);
      assert.match(result.stdout, /Pi extension dir:/);
      assert.match(result.stdout, /data dir:/);
      assert.match(result.stdout, /session store path:/);
      assert.match(result.stdout, /log dir:/);
      assert.match(result.stdout, /media base dir:/);
      assert.match(result.stdout, /runtime dir:/);
      assert.match(result.stdout, new RegExp(`Agent workspaces:\\n  main: ${escapeRegExp(join(workspace, "agent-workspace"))}`));
      assert.match(result.stdout, /Crons: 1/);
      assert.equal(result.stderr, "");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("validates the tracked fixture through MINIME_WORKSPACE_ROOT", () => {
    const result = runWithCapture(
      ["workspace", "validate"],
      BOT_ROOT,
      { [MINIME_WORKSPACE_ROOT_ENV]: MINIMAL_WORKSPACE_FIXTURE },
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Workspace valid\./);
    assert.match(result.stdout, new RegExp(`control workspace root: ${escapeRegExp(MINIMAL_WORKSPACE_FIXTURE)} \\(env\\)`));
    assert.match(result.stdout, /config path: .*minimal-workspace\/config\.yaml \(workspace-default\)/);
    assert.equal(result.stderr, "");
  });

  it("reports workspace validation hard failures separately from warnings", () => {
    const workspace = createWorkspace();
    try {
      rmSync(join(workspace, "agent-workspace"), { recursive: true, force: true });
      const result = runWithCapture(["workspace", "validate", "--workspace", workspace], workspace);

      assert.equal(result.code, 1);
      assert.match(result.stdout, /Workspace invalid\./);
      assert.match(result.stdout, /Hard failures:/);
      assert.match(result.stdout, /workspaceCwd does not exist/);
      assert.match(result.stderr, /Error: Workspace validation failed\./);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("runs through a minime-bot bin-style shim in source development", () => {
    const temp = mkdtempSync(join(tmpdir(), "minime-cli-bin-"));
    const binDir = join(temp, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "minime-bot");
    writeFileSync(
      binPath,
      [
        "#!/bin/sh",
        `exec ${shellQuote(process.execPath)} --import ${shellQuote(TSX_LOADER)} ${shellQuote(CLI_TS)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(binPath, 0o755);

    try {
      const result = spawnSync(binPath, ["--help"], {
        cwd: temp,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage:/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("declares the package bin target and keeps a shebang in the source entrypoint", () => {
    const packageJson = JSON.parse(readFileSync(join(BOT_ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    assert.equal(packageJson.bin?.["minime-bot"], "./dist/cli.js");
    assert.match(readFileSync(CLI_TS, "utf8"), /^#!\/usr\/bin\/env node/);
  });
});
