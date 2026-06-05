import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runCronScript = resolve(__dirname, "../../scripts/run-cron.sh");

describe("run-cron.sh", () => {
  it("continues without CLAUDE_CODE_OAUTH_TOKEN when the Keychain lookup fails", () => {
    const fixture = mkdtempSync(join(tmpdir(), "run-cron-wrapper-"));
    const binDir = join(fixture, "bin");
    const captureFile = join(fixture, "capture.txt");

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "security"), "#!/bin/bash\nexit 44\n", "utf8");
      writeFileSync(
        join(binDir, "npx"),
        `#!/bin/bash
{
  printf 'args=%s\\n' "$*"
  printf 'token=%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-__unset__}"
  printf 'anthropic=%s\\n' "\${ANTHROPIC_API_KEY-__unset__}"
  printf 'claudecode=%s\\n' "\${CLAUDECODE-__unset__}"
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
          CLAUDE_CODE_OAUTH_TOKEN: "stale-token",
          ANTHROPIC_API_KEY: "stale-anthropic-key",
          CLAUDECODE: "stale-claudecode",
        },
      });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout || "run-cron.sh failed");
      const capture = readFileSync(captureFile, "utf8");
      assert.match(capture, /^args=tsx src\/cron-runner\.ts --task pi-task$/m);
      assert.match(capture, /^token=__unset__$/m);
      assert.match(capture, /^anthropic=__unset__$/m);
      assert.match(capture, /^claudecode=__unset__$/m);
      const pathLine = capture.split("\n").find((line) => line.startsWith("path="));
      assert.strictEqual(pathLine, `path=${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
