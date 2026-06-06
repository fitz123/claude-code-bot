import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runCronScript = resolve(__dirname, "../../scripts/run-cron.sh");
const startBotScript = resolve(__dirname, "../../scripts/start-bot.sh");
const deliverScript = resolve(__dirname, "../../scripts/deliver.sh");

describe("start-bot.sh", () => {
  it("does not read Claude OAuth credentials or export Claude runtime flags", () => {
    const script = readFileSync(startBotScript, "utf8");

    assert.doesNotMatch(script, /security find-generic-password/);
    assert.doesNotMatch(script, /claude-code-oauth-token/);
    assert.doesNotMatch(script, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.doesNotMatch(script, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(script, /^export CLAUDE_CODE_/m);
  });

  it("scrubs inherited legacy runtime env before boot", () => {
    const fixture = mkdtempSync(join(tmpdir(), "start-bot-wrapper-"));
    const binDir = join(fixture, "bin");
    const captureFile = join(fixture, "capture.txt");

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, "npx"),
        `#!/bin/bash
{
  printf 'args=%s\\n' "$*"
  printf 'token=%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-__unset__}"
  printf 'anthropic=%s\\n' "\${ANTHROPIC_API_KEY-__unset__}"
  printf 'marker=%s\\n' "\${CLAUDECODE-__unset__}"
} > "$CAPTURE_FILE"
`,
        "utf8",
      );
      chmodSync(join(binDir, "npx"), 0o755);

      const result = spawnSync("/bin/bash", [startBotScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixture,
          PATH: "",
          MINIME_PATH_PREFIX: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
          CAPTURE_FILE: captureFile,
          CLAUDE_CODE_OAUTH_TOKEN: "stale-token",
          ANTHROPIC_API_KEY: "stale-anthropic-key",
          CLAUDECODE: "nested-marker",
        },
      });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout || "start-bot.sh failed");
      const capture = readFileSync(captureFile, "utf8");
      assert.match(capture, /^args=tsx src\/main\.ts$/m);
      assert.match(capture, /^token=__unset__$/m);
      assert.match(capture, /^anthropic=__unset__$/m);
      assert.match(capture, /^marker=__unset__$/m);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("run-cron.sh", () => {
  it("does not read Keychain credentials and scrubs inherited legacy runtime env", () => {
    const fixture = mkdtempSync(join(tmpdir(), "run-cron-wrapper-"));
    const binDir = join(fixture, "bin");
    const captureFile = join(fixture, "capture.txt");
    const securityCallsFile = join(fixture, "security-calls.txt");

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, "security"),
        "#!/bin/bash\nprintf 'security-called\\n' >> \"$SECURITY_CALLS_FILE\"\nexit 44\n",
        "utf8",
      );
      writeFileSync(
        join(binDir, "npx"),
        `#!/bin/bash
{
  printf 'args=%s\\n' "$*"
  printf 'token=%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-__unset__}"
  printf 'anthropic=%s\\n' "\${ANTHROPIC_API_KEY-__unset__}"
  printf 'marker=%s\\n' "\${CLAUDECODE-__unset__}"
  printf 'auto_memory=%s\\n' "\${CLAUDE_CODE_DISABLE_AUTO_MEMORY-__unset__}"
  printf 'background_tasks=%s\\n' "\${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS-__unset__}"
  printf 'cron=%s\\n' "\${CLAUDE_CODE_DISABLE_CRON-__unset__}"
  printf 'exit_delay=%s\\n' "\${CLAUDE_CODE_EXIT_AFTER_STOP_DELAY-__unset__}"
  printf 'telemetry=%s\\n' "\${CLAUDE_CODE_ENABLE_TELEMETRY-__unset__}"
  printf 'path=%s\\n' "$PATH"
} > "$CAPTURE_FILE"
`,
        "utf8",
      );
      chmodSync(join(binDir, "security"), 0o755);
      chmodSync(join(binDir, "npx"), 0o755);

      const result = spawnSync("/bin/bash", [runCronScript, "pi-task"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixture,
          PATH: "",
          MINIME_PATH_PREFIX: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
          CAPTURE_FILE: captureFile,
          SECURITY_CALLS_FILE: securityCallsFile,
          CLAUDE_CODE_OAUTH_TOKEN: "stale-token",
          ANTHROPIC_API_KEY: "stale-anthropic-key",
          CLAUDECODE: "nested-marker",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
          CLAUDE_CODE_DISABLE_CRON: "1",
          CLAUDE_CODE_EXIT_AFTER_STOP_DELAY: "900000",
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        },
      });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout || "run-cron.sh failed");
      assert.strictEqual(existsSync(securityCallsFile), false);
      const capture = readFileSync(captureFile, "utf8");
      assert.match(capture, /^args=tsx src\/cron-runner\.ts --task pi-task$/m);
      assert.match(capture, /^token=__unset__$/m);
      assert.match(capture, /^anthropic=__unset__$/m);
      assert.match(capture, /^marker=__unset__$/m);
      assert.match(capture, /^auto_memory=__unset__$/m);
      assert.match(capture, /^background_tasks=__unset__$/m);
      assert.match(capture, /^cron=__unset__$/m);
      assert.match(capture, /^exit_delay=__unset__$/m);
      assert.match(capture, /^telemetry=__unset__$/m);
      const pathLine = capture.split("\n").find((line) => line.startsWith("path="));
      assert.strictEqual(pathLine, `path=${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("deliver.sh", () => {
  it("does not read Keychain credentials and expects a resolved Telegram token in env", () => {
    const script = readFileSync(deliverScript, "utf8");

    assert.doesNotMatch(script, /security find-generic-password/);
    assert.doesNotMatch(script, /Keychain/);
    assert.match(script, /TELEGRAM_BOT_TOKEN/);
    assert.match(script, /\nTOKEN="\$\{TELEGRAM_BOT_TOKEN:-\}"[\s\S]*\nunset TELEGRAM_BOT_TOKEN\n[\s\S]*\nAPI=/);
  });
});
