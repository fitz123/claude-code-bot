import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("project naming", () => {
  const readme = readRepoFile("README.md");
  const configExample = readRepoFile("bot/config.yaml.example");
  const packageJson = JSON.parse(readRepoFile("bot/package.json"));
  const changelog = readRepoFile("CHANGELOG.md");

  it("README has no ~/.openclaw/ path references", () => {
    assert.ok(
      !readme.includes("~/.openclaw/"),
      "README.md still contains ~/.openclaw/ paths"
    );
  });

  it("README has no bot/bot double-path commands", () => {
    assert.ok(
      !readme.includes("bot/bot"),
      "README.md still contains bot/bot double-path"
    );
  });

  it("README has no OpenClaw references", () => {
    assert.ok(
      !readme.toLowerCase().includes("openclaw"),
      "README.md still contains OpenClaw references"
    );
  });

  it("README title is Minime", () => {
    assert.ok(
      readme.startsWith("# Minime"),
      "README.md title should be '# Minime'"
    );
  });

  it("config.yaml.example has no openclaw references", () => {
    assert.ok(
      !configExample.toLowerCase().includes("openclaw"),
      "config.yaml.example still contains openclaw references"
    );
  });

  it("package.json name is minime", () => {
    assert.strictEqual(packageJson.name, "minime");
  });

  it("package.json has no OpenClaw references in description", () => {
    assert.ok(
      !packageJson.description.toLowerCase().includes("openclaw"),
      "package.json description still contains OpenClaw"
    );
  });

  it("package.json version is 0.1.0", () => {
    assert.strictEqual(packageJson.version, "0.1.0");
  });

  it("CHANGELOG.md exists and references v0.1.0", () => {
    assert.ok(
      existsSync(resolve(repoRoot, "CHANGELOG.md")),
      "CHANGELOG.md does not exist"
    );
    assert.ok(
      changelog.includes("0.1.0"),
      "CHANGELOG.md does not reference v0.1.0"
    );
  });

  it("CHANGELOG.md documents major features", () => {
    const requiredFeatures = [
      "Telegram",
      "Discord",
      "Session Management",
      "Message Processing",
      "Streaming",
      "Voice",
      "Cron",
      "Monitoring",
      "NO_REPLY",
    ];
    for (const feature of requiredFeatures) {
      assert.ok(
        changelog.includes(feature),
        `CHANGELOG.md missing feature: ${feature}`
      );
    }
  });

  it("types.ts has no OpenClaw references", () => {
    const types = readRepoFile("bot/src/types.ts");
    assert.ok(
      !types.toLowerCase().includes("openclaw"),
      "types.ts still contains OpenClaw references"
    );
  });

  it("test files have no openclaw references in temp paths", () => {
    const testFiles = [
      "bot/src/__tests__/voice.test.ts",
      "bot/src/__tests__/session-manager.test.ts",
      "bot/src/__tests__/session-store.test.ts",
    ];
    for (const file of testFiles) {
      const content = readRepoFile(file);
      assert.ok(
        !content.includes("openclaw"),
        `${file} still contains openclaw references`
      );
    }
  });
});
