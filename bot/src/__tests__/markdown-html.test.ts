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

  describe("tables (narrow — box-drawing)", () => {
    it("converts basic markdown table to box-drawn <pre> block", () => {
      const input = "| A | B |\n|---|---|\n| 1 | 2 |";
      const expected = "<pre>  A │ B  \n────┼────\n  1 │ 2  </pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("converts table without leading pipes", () => {
      const input = "A | B\n--- | ---\n1 | 2";
      const expected = "<pre>  A │ B  \n────┼────\n  1 │ 2  </pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("handles table with alignment colons in separator", () => {
      const input = "| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |";
      const expected = "<pre>  L │ C │ R  \n────┼───┼────\n  a │ b │ c  </pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("HTML-escapes content inside table <pre>", () => {
      const input = "| A | B |\n|---|---|\n| < | & |";
      const expected = "<pre>  A │ B  \n────┼────\n  &lt; │ &amp;  </pre>";
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
      const expected = "before\n<pre>  A │ B  \n────┼────\n  1 │ 2  </pre>\nafter";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("handles table with blank lines around it", () => {
      const input = "before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nafter";
      const expected = "before\n\n<pre>  A │ B  \n────┼────\n  1 │ 2  </pre>\n\nafter";
      assert.strictEqual(markdownToHtml(input), expected);
    });
  });

  describe("tables (wide — transposed key:value)", () => {
    it("transposes wide table to key:value format", () => {
      const input = "| Description | Priority | Status | Owner |\n|---|---|---|---|\n| Fix bug | High | Open | Alice |";
      const expected = "<pre>Description: Fix bug\nPriority: High\nStatus: Open\nOwner: Alice</pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("transposes multiple rows with blank line separator", () => {
      const input = "| Description | Priority | Status | Owner |\n|---|---|---|---|\n| Fix bug | High | Open | Alice |\n| Add test | Low | Done | Bob |";
      const expected = "<pre>Description: Fix bug\nPriority: High\nStatus: Open\nOwner: Alice\n\nDescription: Add test\nPriority: Low\nStatus: Done\nOwner: Bob</pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("HTML-escapes content in transposed format", () => {
      const input = "| Key | Value | Description | Notes |\n|---|---|---|---|\n| A | < | x & y | \"z\" |";
      const expected = "<pre>Key: A\nValue: &lt;\nDescription: x &amp; y\nNotes: &quot;z&quot;</pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("handles missing cells in wide table gracefully", () => {
      const input = "| Column1 | Column2 | Column3 | Column4 |\n|---|---|---|---|\n| val1 | val2 | | |";
      const expected = "<pre>Column1: val1\nColumn2: val2\nColumn3: \nColumn4: </pre>";
      assert.strictEqual(markdownToHtml(input), expected);
    });

    it("box-draws table at exactly 34 chars (boundary)", () => {
      // widths: [5,3,6,6] → 20 + 3*4 + 1 = 33 (under 34, box-drawn)
      const input = "| Name | Age | City | Status |\n|---|---|---|---|\n| Alice | 30 | Moscow | Active |";
      const result = markdownToHtml(input);
      assert.ok(result.includes("│"), "should use box-drawing for 33-char table");
      assert.ok(!result.includes(": "), "should not transpose");
    });

    it("transposes table at 35 chars (just over boundary)", () => {
      // widths: [5,3,7,6] → 21 + 3*4 + 1 = 34 → equal, stays box. widths: [6,3,7,6] → 22+13=35 → transpose
      const input = "| Name__ | Age | City__ | Status |\n|---|---|---|---|\n| Alice_ | 30 | Moscow_ | Active |";
      const result = markdownToHtml(input);
      assert.ok(result.includes(": "), "should transpose for 35+ char table");
      assert.ok(!result.includes("│"), "should not use box-drawing");
    });
  });

  describe("blockquotes", () => {
    it("converts single > line to <blockquote>", () => {
      assert.strictEqual(
        markdownToHtml("> hello"),
        "<blockquote>hello</blockquote>",
      );
    });

    it("merges consecutive > lines into one <blockquote>", () => {
      assert.strictEqual(
        markdownToHtml("> line one\n> line two\n> line three"),
        "<blockquote>line one\nline two\nline three</blockquote>",
      );
    });

    it("uses <blockquote expandable> for 5+ lines", () => {
      const input = "> a\n> b\n> c\n> d\n> e";
      assert.strictEqual(
        markdownToHtml(input),
        "<blockquote expandable>a\nb\nc\nd\ne</blockquote>",
      );
    });

    it("does not use expandable for exactly 4 lines", () => {
      const input = "> a\n> b\n> c\n> d";
      const result = markdownToHtml(input);
      assert.ok(result.startsWith("<blockquote>"), "should use plain blockquote for 4 lines");
      assert.ok(!result.includes("expandable"), "should not be expandable");
    });

    it("converts inline markdown inside blockquote", () => {
      assert.strictEqual(
        markdownToHtml("> **bold** and *italic*"),
        "<blockquote><b>bold</b> and <i>italic</i></blockquote>",
      );
    });

    it("handles empty > line inside blockquote", () => {
      assert.strictEqual(
        markdownToHtml("> first\n>\n> third"),
        "<blockquote>first\n\nthird</blockquote>",
      );
    });

    it("handles text before and after blockquote", () => {
      assert.strictEqual(
        markdownToHtml("before\n> quoted\nafter"),
        "before\n<blockquote>quoted</blockquote>\nafter",
      );
    });

    it("does not convert > inside fenced code block", () => {
      assert.strictEqual(
        markdownToHtml("```\n> not a blockquote\n```"),
        "<pre>&gt; not a blockquote</pre>",
      );
    });

    it("handles inline code inside blockquote", () => {
      assert.strictEqual(
        markdownToHtml("> use `foo` here"),
        "<blockquote>use <code>foo</code> here</blockquote>",
      );
    });
  });

  describe("list bullet normalization", () => {
    it("converts - item at line start to • item", () => {
      assert.strictEqual(markdownToHtml("- foo"), "• foo");
    });

    it("converts * item at line start to • item", () => {
      assert.strictEqual(markdownToHtml("* foo"), "• foo");
    });

    it("preserves indentation on nested list items", () => {
      assert.strictEqual(markdownToHtml("  - nested"), "  • nested");
    });

    it("does not convert numbered lists", () => {
      assert.strictEqual(markdownToHtml("1. item"), "1. item");
    });

    it("does not convert - inside a fenced code block", () => {
      assert.strictEqual(markdownToHtml("```\n- not a bullet\n```"), "<pre>- not a bullet</pre>");
    });

    it("does not convert * italic syntax (mid-line asterisk with no space after)", () => {
      assert.strictEqual(markdownToHtml("*italic*"), "<i>italic</i>");
    });

    it("handles inline markdown in list items (bold)", () => {
      assert.strictEqual(markdownToHtml("- **bold item**"), "• <b>bold item</b>");
    });

    it("handles inline markdown in list items (link)", () => {
      assert.strictEqual(
        markdownToHtml("- [click](https://example.com)"),
        '• <a href="https://example.com">click</a>',
      );
    });

    it("converts multiple list items", () => {
      assert.strictEqual(
        markdownToHtml("- one\n- two\n- three"),
        "• one\n• two\n• three",
      );
    });

    it("* at mid-line (not line start) is not converted", () => {
      assert.strictEqual(markdownToHtml("text * not a bullet"), "text * not a bullet");
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
