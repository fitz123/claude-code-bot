import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = resolve(__dirname, "..", "..");
const CHECK_SCRIPT = join(BOT_ROOT, "scripts", "check-no-active-schema-guard-contract.mjs");
const fixtures: string[] = [];

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "schema-guard-contract-check-"));
  fixtures.push(root);
  return root;
}

function writeFixture(root: string, relpath: string, content: string): void {
  const path = join(root, relpath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function runCheck(root: string) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, root], {
    cwd: BOT_ROOT,
    encoding: "utf8",
  });
}

describe("check-no-active-schema-guard-contract", () => {
  it("fails active prose that still claims cron guard-extension loading", () => {
    const root = makeFixture();
    writeFixture(root, "crons.yaml", "# LLM crons use only the explicit A1 guard extension.\n");

    const result = runCheck(root);

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /A1 guard extension/);
  });

  it("fails active source comments that still claim A1 write guard behavior", () => {
    const root = makeFixture();
    writeFixture(root, join("bot", "src", "pi-extensions", "subagent-args.ts"), "// Loads the A1 write guard.\n");

    const result = runCheck(root);

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /A1 write guard/);
  });

  it("allows retired-context prose and explicitly historical plan paths", () => {
    const root = makeFixture();
    writeFixture(root, "README.md", "schema.md is retired and no longer required for runtime correctness.\n");
    writeFixture(root, join("docs", "plans", "historical.md"), "guardian-protect-files was removed here.\n");

    const result = runCheck(root);

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  });
});
