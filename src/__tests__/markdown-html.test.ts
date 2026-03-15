import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, escapeHtml } from "../markdown-html.js";

describe("escapeHtml", () => {
  it("escapes <, >, &, and double quotes", () => {
    assert.strictEqual(escapeHtml("a < b > c & d"), "a &lt; b &gt; c &amp; d");
    assert.strictEqual(escapeHtml('<a href="x">'), "&lt;a href=&quot;x&quot;&gt;");
  });

  it("returns plain text unchanged", () => {
    assert.strictEqual(escapeHtml("hello world"), "hello world");
  });

  it("escapes double quotes", () => {
    assert.strictEqual(escapeHtml('a "b" c'), "a &quot;b&quot; c");
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

  describe("bold+italic", () => {
    it("converts ***text*** to properly nested <b><i>text</i></b>", () => {
      assert.strictEqual(markdownToHtml("***bold italic***"), "<b><i>bold italic</i></b>");
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

    it("handles language tags with non-word characters (c++)", () => {
      assert.strictEqual(
        markdownToHtml("```c++\nint x = 0;\n```"),
        '<pre><code class="language-c++">int x = 0;</code></pre>',
      );
    });

    it("handles language tags with hyphens (objective-c)", () => {
      assert.strictEqual(
        markdownToHtml("```objective-c\n@interface Foo\n```"),
        '<pre><code class="language-objective-c">@interface Foo</code></pre>',
      );
    });

    it("escapes HTML in language tags to prevent injection", () => {
      assert.strictEqual(
        markdownToHtml('```" onclick="alert(1)\ncode\n```'),
        '<pre><code class="language-&quot; onclick=&quot;alert(1)">code</code></pre>',
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

    it("handles URLs containing parentheses (e.g. Wikipedia)", () => {
      assert.strictEqual(
        markdownToHtml("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))"),
        '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">wiki</a>',
      );
    });

    it("handles URLs with multiple parenthesized groups", () => {
      assert.strictEqual(
        markdownToHtml("[link](https://example.com/a(b)c(d))"),
        '<a href="https://example.com/a(b)c(d)">link</a>',
      );
    });

    it("handles URLs with truly nested parentheses", () => {
      assert.strictEqual(
        markdownToHtml("[x](https://example.com/a(b(c)d)e)"),
        '<a href="https://example.com/a(b(c)d)e">x</a>',
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

  describe("tables", () => {
    it("converts basic markdown table to <pre> block", () => {
      const input = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
      const expected = "<pre>| Name | Age |\n| --- | --- |\n| Alice | 30 |</pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("converts table without leading pipes", () => {
      const input = "Name | Age\n--- | ---\nAlice | 30";
      const expected = "<pre>Name | Age\n--- | ---\nAlice | 30</pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("handles table with alignment colons in separator", () => {
      const input = "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |";
      const expected = "<pre>| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |</pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("HTML-escapes content inside table <pre>", () => {
      const input = "| A < B | C > D |\n|---|---|\n| x & y | z |";
      const expected = "<pre>| A &lt; B | C &gt; D |\n|---|---|\n| x &amp; y | z |</pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("preserves formatting chars as literal text in table pre block", () => {
      const input = "| **bold** | *italic* |\n|---|---|\n| ~~strike~~ | `code` |";
      const expected = "<pre>| **bold** | *italic* |\n|---|---|\n| ~~strike~~ | `code` |</pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("does not affect non-table text with pipes", () => {
      assert.strictEqual(markdownToHtml("cat foo | grep bar"), "cat foo | grep bar");
    });

    it("does not affect single pipe expression", () => {
      assert.strictEqual(markdownToHtml("a | b"), "a | b");
    });

    it("does not double-process table inside code block", () => {
      const input = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
      const expected = "<pre>| A | B |\n|---|---|\n| 1 | 2 |</pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("handles table with surrounding text", () => {
      const input = "before\n| A | B |\n|---|---|\n| 1 | 2 |\nafter";
      const expected = "before\n<pre>| A | B |\n|---|---|\n| 1 | 2 |</pre>\nafter";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("handles table with blank lines around it", () => {
      const input = "before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nafter";
      const expected = "before\n\n<pre>| A | B |\n|---|---|\n| 1 | 2 |</pre>\n\nafter";
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
