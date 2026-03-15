import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "..", "markdown-html-cli.ts");
const TSX_BIN = resolve(__dirname, "..", "..", "node_modules", ".bin", "tsx");

function runCli(input: string): string {
  return execSync(`"${TSX_BIN}" "${CLI_PATH}"`, {
    input,
    encoding: "utf8",
    timeout: 10000,
  });
}

describe("markdown-html-cli", () => {
  it("converts bold markdown to HTML", () => {
    assert.strictEqual(runCli("**bold**"), "<b>bold</b>");
  });

  it("converts mixed markdown to HTML", () => {
    assert.strictEqual(
      runCli("**bold** and *italic*"),
      "<b>bold</b> and <i>italic</i>",
    );
  });

  it("passes plain text through unchanged", () => {
    assert.strictEqual(runCli("hello world"), "hello world");
  });

  it("escapes HTML entities in plain text", () => {
    assert.strictEqual(runCli("a < b & c"), "a &lt; b &amp; c");
  });

  it("handles empty input", () => {
    assert.strictEqual(runCli(""), "");
  });

  it("handles multiline input", () => {
    const input = "line1\n**bold line**\nline3";
    const expected = "line1\n<b>bold line</b>\nline3";
    assert.strictEqual(runCli(input), expected);
  });

  it("converts code blocks", () => {
    const input = "```js\nconst x = 1;\n```";
    const expected = '<pre><code class="language-js">const x = 1;</code></pre>';
    assert.strictEqual(runCli(input), expected);
  });
});
