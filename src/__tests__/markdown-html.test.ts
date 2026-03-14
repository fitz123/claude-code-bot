import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, escapeHtml } from "../markdown-html.js";

describe("escapeHtml", () => {
  it("escapes <, >, and &", () => {
    assert.strictEqual(escapeHtml("a < b > c & d"), "a &lt; b &gt; c &amp; d");
  });

  it("returns plain text unchanged", () => {
    assert.strictEqual(escapeHtml("hello world"), "hello world");
  });
});

describe("markdownToHtml", () => {
  describe("bold", () => {
    it("converts **text** to <b>text</b>", () => {
      assert.strictEqual(markdownToHtml("**bold**"), "<b>bold</b>");
    });

    it("handles multiple bold spans", () => {
      assert.strictEqual(
        markdownToHtml("**a** and **b**"),
        "<b>a</b> and <b>b</b>",
      );
    });
  });

  describe("italic", () => {
    it("converts *text* to <i>text</i>", () => {
      assert.strictEqual(markdownToHtml("*italic*"), "<i>italic</i>");
    });

    it("does not conflict with bold", () => {
      assert.strictEqual(
        markdownToHtml("**bold** and *italic*"),
        "<b>bold</b> and <i>italic</i>",
      );
    });
  });

  describe("strikethrough", () => {
    it("converts ~~text~~ to <s>text</s>", () => {
      assert.strictEqual(markdownToHtml("~~removed~~"), "<s>removed</s>");
    });
  });

  describe("inline code", () => {
    it("converts `code` to <code>code</code>", () => {
      assert.strictEqual(markdownToHtml("`foo`"), "<code>foo</code>");
    });

    it("escapes HTML inside inline code", () => {
      assert.strictEqual(
        markdownToHtml("`a < b`"),
        "<code>a &lt; b</code>",
      );
    });

    it("does not convert markdown inside inline code", () => {
      assert.strictEqual(
        markdownToHtml("`**not bold**`"),
        "<code>**not bold**</code>",
      );
    });
  });

  describe("fenced code blocks", () => {
    it("converts code block without language", () => {
      assert.strictEqual(
        markdownToHtml("```\nfoo\n```"),
        "<pre>foo</pre>",
      );
    });

    it("converts code block with language tag", () => {
      assert.strictEqual(
        markdownToHtml("```typescript\nconst x = 1;\n```"),
        '<pre><code class="language-typescript">const x = 1;</code></pre>',
      );
    });

    it("escapes HTML inside code blocks", () => {
      assert.strictEqual(
        markdownToHtml("```\na < b && c > d\n```"),
        "<pre>a &lt; b &amp;&amp; c &gt; d</pre>",
      );
    });

    it("handles text around code blocks", () => {
      const input = "before\n```\ncode\n```\nafter";
      const expected = "before\n<pre>code</pre>\nafter";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("handles multiple code blocks", () => {
      const input = "```js\na\n```\nmiddle\n```py\nb\n```";
      const expected =
        '<pre><code class="language-js">a</code></pre>\nmiddle\n' +
        '<pre><code class="language-py">b</code></pre>';
      assert.strictEqual(markdownToHtml(input), expected);
    });
  });

  describe("links", () => {
    it("converts [text](url) to <a> tag", () => {
      assert.strictEqual(
        markdownToHtml("[click](https://example.com)"),
        '<a href="https://example.com">click</a>',
      );
    });
  });

  describe("HTML special characters", () => {
    it("escapes < > & in regular text", () => {
      assert.strictEqual(
        markdownToHtml("a < b > c & d"),
        "a &lt; b &gt; c &amp; d",
      );
    });

    it("escapes HTML inside bold text", () => {
      assert.strictEqual(
        markdownToHtml("**a < b**"),
        "<b>a &lt; b</b>",
      );
    });
  });

  describe("mixed formatting", () => {
    it("handles bold, code, and links together", () => {
      const input = "Use **`foo`** from [docs](https://x.com)";
      const expected =
        'Use <b><code>foo</code></b> from <a href="https://x.com">docs</a>';
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("handles code block with surrounding markdown", () => {
      const input = "**Title**\n```js\ncode()\n```\n*footer*";
      const expected =
        '<b>Title</b>\n<pre><code class="language-js">code()</code></pre>\n<i>footer</i>';
      assert.strictEqual(markdownToHtml(input), expected);
    });
  });

  describe("plain text", () => {
    it("passes through text without markdown unchanged", () => {
      assert.strictEqual(markdownToHtml("hello world"), "hello world");
    });

    it("handles empty string", () => {
      assert.strictEqual(markdownToHtml(""), "");
    });
  });
});
