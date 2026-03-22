import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { splitMessage, extractText, isImageExtension, sendOutboxFiles, relayStream, collapseNewlines } from "../stream-relay.js";
import type { StreamLine, StreamEvent, AssistantMessage, ResultMessage, ToolProgress, PlatformContext } from "../types.js";

describe("splitMessage", () => {
  it("returns single chunk for short text", () => {
    const result = splitMessage("Hello world", 4096);
    assert.deepStrictEqual(result, ["Hello world"]);
  });

  it("returns single chunk for exactly max length", () => {
    const text = "a".repeat(4096);
    const result = splitMessage(text, 4096);
    assert.deepStrictEqual(result, [text]);
  });

  it("splits at paragraph boundary", () => {
    const para1 = "a".repeat(100);
    const para2 = "b".repeat(100);
    const text = para1 + "\n\n" + para2;
    const result = splitMessage(text, 150);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], para1);
    assert.strictEqual(result[1], para2);
  });

  it("splits at newline if no paragraph boundary", () => {
    const line1 = "a".repeat(100);
    const line2 = "b".repeat(100);
    const text = line1 + "\n" + line2;
    const result = splitMessage(text, 150);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], line1);
    assert.strictEqual(result[1], line2);
  });

  it("splits at space if no newline", () => {
    const text = "word ".repeat(30).trim(); // ~150 chars
    const result = splitMessage(text, 50);
    assert.ok(result.length > 1);
    for (const chunk of result) {
      assert.ok(chunk.length <= 50, `Chunk too long: ${chunk.length}`);
    }
  });

  it("hard-cuts if no natural boundary", () => {
    const text = "a".repeat(200);
    const result = splitMessage(text, 50);
    assert.ok(result.length >= 4);
    assert.strictEqual(result[0].length, 50);
  });

  it("preserves paragraph breaks across split chunks", () => {
    // When splitting at \n\n, extra newlines after the boundary must survive
    const para1 = "a".repeat(100);
    const para2 = "b".repeat(100);
    // Three newlines: split consumes \n\n boundary, one \n remains at start of next chunk
    const text = para1 + "\n\n\n" + para2;
    const result = splitMessage(text, 150);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], para1);
    assert.strictEqual(result[1], "\n" + para2, "extra newline after split boundary should be preserved");
  });

  it("preserves multiple paragraph breaks across split chunks", () => {
    const para1 = "a".repeat(80);
    const para2 = "b".repeat(80);
    const para3 = "c".repeat(80);
    // Build text: para1 \n\n para2 \n\n para3
    const text = para1 + "\n\n" + para2 + "\n\n" + para3;
    const result = splitMessage(text, 100);
    // Should split into 3 chunks, each paragraph intact
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0], para1);
    assert.strictEqual(result[1], para2);
    assert.strictEqual(result[2], para3);
  });

  it("handles empty string", () => {
    const result = splitMessage("", 4096);
    assert.deepStrictEqual(result, [""]);
  });

  it("splits long response into multiple 4096-char chunks", () => {
    const text = "x".repeat(10000);
    const result = splitMessage(text, 4096);
    assert.ok(result.length >= 3);
    for (const chunk of result) {
      assert.ok(chunk.length <= 4096);
    }
    // Total content preserved
    assert.strictEqual(result.join("").length, 10000);
  });
});

describe("extractText", () => {
  it("extracts text_delta from stream_event", () => {
    const msg: StreamEvent = {
      type: "stream_event",
      event: {
        delta: { type: "text_delta", text: "Hello" },
      },
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, "Hello");
    assert.strictEqual(result.isFinal, false);
  });

  it("ignores assistant message snapshot (text already delivered via deltas)", () => {
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
      session_id: "test-id",
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, false);
  });

  it("returns isFinal for result message without duplicating text", () => {
    const msg: ResultMessage = {
      type: "result",
      result: "Final answer",
      session_id: "test-id",
      cost_usd: 0.01,
      duration_ms: 1000,
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, true);
  });

  it("returns null for tool_progress", () => {
    const msg: ToolProgress = {
      type: "assistant",
      subtype: "tool_progress",
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, false);
  });

  it("returns isFinal=true for result with no text", () => {
    const msg: ResultMessage = {
      type: "result",
      result: "",
      session_id: "test-id",
    };
    const result = extractText(msg);
    assert.strictEqual(result.isFinal, true);
  });

  it("handles stream_event without text delta", () => {
    const msg: StreamEvent = {
      type: "stream_event",
      event: {
        delta: { type: "input_json_delta" },
      },
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, false);
  });

  it("does not duplicate text when processing full CLI event sequence", () => {
    // Simulates the event sequence from Claude CLI with --include-partial-messages:
    // 1. text_delta events (streaming chunks)
    // 2. assistant message snapshot (full text)
    // 3. result message (full text again)
    const events: StreamLine[] = [
      { type: "stream_event", event: { delta: { type: "text_delta", text: "Hello" } } } as StreamEvent,
      { type: "stream_event", event: { delta: { type: "text_delta", text: " world" } } } as StreamEvent,
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] }, session_id: "s" } as AssistantMessage,
      { type: "result", result: "Hello world", session_id: "s" } as ResultMessage,
    ];

    let accumulated = "";
    let isFinal = false;
    for (const msg of events) {
      const r = extractText(msg);
      if (r.text !== null) accumulated += r.text;
      if (r.isFinal) isFinal = true;
    }

    assert.strictEqual(accumulated, "Hello world");
    assert.strictEqual(isFinal, true);
  });
});

describe("isImageExtension", () => {
  it("returns true for supported image extensions", () => {
    assert.strictEqual(isImageExtension("/path/to/file.jpg"), true);
    assert.strictEqual(isImageExtension("/path/to/file.jpeg"), true);
    assert.strictEqual(isImageExtension("/path/to/file.png"), true);
    assert.strictEqual(isImageExtension("/path/to/file.gif"), true);
    assert.strictEqual(isImageExtension("/path/to/file.webp"), true);
  });

  it("returns true for uppercase extensions", () => {
    assert.strictEqual(isImageExtension("/path/to/file.PNG"), true);
    assert.strictEqual(isImageExtension("/path/to/file.JPG"), true);
  });

  it("returns false for non-image extensions", () => {
    assert.strictEqual(isImageExtension("/path/to/file.txt"), false);
    assert.strictEqual(isImageExtension("/path/to/file.pdf"), false);
    assert.strictEqual(isImageExtension("/path/to/file.bmp"), false);
    assert.strictEqual(isImageExtension("/path/to/file.ts"), false);
  });

  it("returns false for files with no extension", () => {
    assert.strictEqual(isImageExtension("/path/to/Makefile"), false);
  });
});

describe("sendOutboxFiles", () => {
  const outboxPath = "/tmp/bot-outbox-test-relay";

  beforeEach(() => {
    rmSync(outboxPath, { recursive: true, force: true });
    mkdirSync(outboxPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(outboxPath, { recursive: true, force: true });
  });

  it("sends files from outbox directory", async () => {
    writeFileSync(join(outboxPath, "chart.png"), "fake-png");
    writeFileSync(join(outboxPath, "report.pdf"), "fake-pdf");

    const sentFiles: Array<{ path: string; isImage: boolean }> = [];
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string, isImage: boolean): Promise<void> {
        sentFiles.push({ path: filePath, isImage });
      },
    };

    await sendOutboxFiles(outboxPath, platform);

    assert.strictEqual(sentFiles.length, 2);
    const names = sentFiles.map(f => f.path.split("/").pop());
    assert.ok(names.includes("chart.png"));
    assert.ok(names.includes("report.pdf"));

    // Image detection
    const png = sentFiles.find(f => f.path.endsWith("chart.png"));
    assert.strictEqual(png?.isImage, true);
    const pdf = sentFiles.find(f => f.path.endsWith("report.pdf"));
    assert.strictEqual(pdf?.isImage, false);
  });

  it("cleans up files after sending", async () => {
    writeFileSync(join(outboxPath, "output.txt"), "hello");

    await sendOutboxFiles(outboxPath, mockPlatform().platform);

    const remaining = readdirSync(outboxPath);
    assert.strictEqual(remaining.length, 0);
  });

  it("skips subdirectories in outbox", async () => {
    mkdirSync(join(outboxPath, "subdir"));
    writeFileSync(join(outboxPath, "file.txt"), "hello");

    const sentFiles: string[] = [];
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string): Promise<void> {
        sentFiles.push(filePath);
      },
    };

    await sendOutboxFiles(outboxPath, platform);
    assert.strictEqual(sentFiles.length, 1);
    assert.ok(sentFiles[0].endsWith("file.txt"));
  });

  it("handles nonexistent outbox directory gracefully", async () => {
    rmSync(outboxPath, { recursive: true, force: true });
    // Should not throw
    await sendOutboxFiles(outboxPath, mockPlatform().platform);
  });

  it("handles empty outbox directory", async () => {
    const sentFiles: string[] = [];
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string): Promise<void> {
        sentFiles.push(filePath);
      },
    };

    await sendOutboxFiles(outboxPath, platform);
    assert.strictEqual(sentFiles.length, 0);
  });

  it("continues sending remaining files if one fails", async () => {
    writeFileSync(join(outboxPath, "a.txt"), "aaa");
    writeFileSync(join(outboxPath, "b.png"), "bbb");

    const sentFiles: string[] = [];
    let callCount = 0;
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string): Promise<void> {
        callCount++;
        if (callCount === 1) throw new Error("network error");
        sentFiles.push(filePath);
      },
    };

    await sendOutboxFiles(outboxPath, platform);
    // One succeeded, one failed — but both were attempted
    assert.strictEqual(sentFiles.length, 1);

    // Failed file should still exist (not deleted), successful file should be gone
    const remaining = readdirSync(outboxPath);
    assert.strictEqual(remaining.length, 1, "failed file should remain in outbox");
  });
});

// -------------------------------------------------------------------
// relayStream — tests using PlatformContext
// -------------------------------------------------------------------

/** Create a mock async generator yielding text deltas and a result. */
async function* fakeStream(deltas: string[]): AsyncGenerator<StreamLine> {
  for (const delta of deltas) {
    yield {
      type: "stream_event",
      event: { delta: { type: "text_delta", text: delta } },
    } as StreamEvent;
  }
  yield {
    type: "result",
    result: deltas.join(""),
    session_id: "test",
  } as ResultMessage;
}

/**
 * Create a mock stream that simulates text → tool_use → text sequences.
 * Each segment is either a string (text deltas) or "tool_use" (a tool block).
 */
async function* fakeStreamWithTools(segments: Array<string | "tool_use">): AsyncGenerator<StreamLine> {
  let fullText = "";
  for (const seg of segments) {
    if (seg === "tool_use") {
      // content_block_start for tool_use
      yield {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Edit" } },
      } as unknown as StreamEvent;
      // input_json_delta
      yield {
        type: "stream_event",
        event: { delta: { type: "input_json_delta", partial_json: "{}" } },
      } as unknown as StreamEvent;
      // content_block_stop
      yield {
        type: "stream_event",
        event: { type: "content_block_stop" },
      } as unknown as StreamEvent;
    } else {
      // content_block_start for text
      yield {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "text" } },
      } as unknown as StreamEvent;
      // text_delta
      yield {
        type: "stream_event",
        event: { delta: { type: "text_delta", text: seg } },
      } as StreamEvent;
      fullText += seg;
    }
  }
  yield {
    type: "result",
    result: fullText,
    session_id: "test",
  } as ResultMessage;
}

/** Create a mock PlatformContext for relayStream tests. */
function mockPlatform(options?: {
  sendShouldThrow?: boolean | number;
  typingIndicator?: boolean;
}) {
  const sends: Array<{ text: string }> = [];
  const drafts: Array<{ draftId: number; text: string }> = [];
  const typings: number[] = [];
  let messageCounter = 0;

  const platform: PlatformContext = {
    maxMessageLength: 4096,
    typingIntervalMs: 4000,
    typingIndicator: options?.typingIndicator !== false,

    async sendMessage(text: string): Promise<string> {
      messageCounter++;
      if (options?.sendShouldThrow === true ||
          (typeof options?.sendShouldThrow === "number" && messageCounter === options.sendShouldThrow)) {
        throw new Error("NetworkError: sendMessage failed");
      }
      sends.push({ text });
      return String(messageCounter);
    },

    async editMessage(): Promise<void> {},

    async sendDraft(draftId: number, text: string): Promise<void> {
      drafts.push({ draftId, text });
    },

    async sendTyping(): Promise<void> {
      typings.push(Date.now());
    },

    async deleteMessage(): Promise<void> {},

    async sendFile(): Promise<void> {},

    async replyError(text: string): Promise<void> {
      sends.push({ text });
    },
  };

  return { platform, sends, drafts, typings };
}

describe("relayStream draft streaming", () => {
  it("sends final message via sendMessage", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1, "Should send exactly one final message");
    assert.strictEqual(sends[0].text, "Hello world");
  });

  it("sends draft updates during streaming", async () => {
    const { platform, drafts } = mockPlatform();
    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, platform);

    // Draft updates are debounced, so at least one should fire
    assert.ok(drafts.length >= 1, "Should send at least one draft update");
    // All drafts use the same draftId
    const draftIds = new Set(drafts.map(d => d.draftId));
    assert.strictEqual(draftIds.size, 1, "All drafts should share the same draftId");
  });

  it("handles multi-chunk final message", async () => {
    const { platform, sends } = mockPlatform();
    const longText = "x".repeat(5000);
    const stream = fakeStream([longText]);

    await relayStream(stream, platform);

    assert.ok(sends.length >= 2, "Should split into multiple messages");
    const totalText = sends.map(s => s.text).join("");
    assert.strictEqual(totalText.length, 5000);
  });

  it("does not send drafts for the final delta", async () => {
    // The last delta before result should not trigger a draft since sendMessage follows immediately
    const { platform, drafts, sends } = mockPlatform();
    const stream = fakeStream(["Only chunk"]);

    await relayStream(stream, platform);

    // Final delivery via sendMessage
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Only chunk");
  });
});

describe("relayStream typingIndicator=false", () => {
  it("sends no typing indicators when disabled", async () => {
    const { platform, typings } = mockPlatform({ typingIndicator: false });
    const stream = fakeStream(["Hello"]);

    await relayStream(stream, platform);

    assert.strictEqual(typings.length, 0, "Should have no typing indicators");
  });

  it("sends typing indicators when enabled (default)", async () => {
    const { platform, typings } = mockPlatform({ typingIndicator: true });
    const stream = fakeStream(["Hello"]);

    await relayStream(stream, platform);

    assert.ok(typings.length >= 1, "Should have at least one typing indicator");
  });
});

describe("relayStream pre-stream typing handoff", () => {
  it("clears preStreamTypingTimer when relayStream starts", async () => {
    const { platform, typings } = mockPlatform({ typingIndicator: true });
    const stream = fakeStream(["Hello"]);

    // Simulate message queue having set a pre-stream typing timer
    let preStreamTimerCleared = false;
    platform.preStreamTypingTimer = setInterval(() => {
      // this would fire if not cleared
    }, 50);
    const originalTimer = platform.preStreamTypingTimer;

    await relayStream(stream, platform);

    // Pre-stream timer should have been cleared
    assert.strictEqual(platform.preStreamTypingTimer, undefined, "preStreamTypingTimer should be cleared");
    // relayStream's own typing should still have fired
    assert.ok(typings.length >= 1, "relayStream should send its own typing");

    // Clean up just in case
    clearInterval(originalTimer);
  });

  it("clears preStreamTypingTimer even when typingIndicator is false", async () => {
    const { platform } = mockPlatform({ typingIndicator: false });
    const stream = fakeStream(["Hello"]);

    // Pre-stream timer should still be cleared even if typing is disabled
    platform.preStreamTypingTimer = setInterval(() => {}, 50);
    const originalTimer = platform.preStreamTypingTimer;

    await relayStream(stream, platform);

    assert.strictEqual(platform.preStreamTypingTimer, undefined, "preStreamTypingTimer should be cleared");

    clearInterval(originalTimer);
  });
});

describe("relayStream paragraph breaks across tool-use", () => {
  it("inserts paragraph break between text blocks separated by tool_use", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Here's the plan:", "tool_use", "Done! Applied."]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Here's the plan:\n\nDone! Applied.");
  });

  it("does not double paragraph break when text already ends with \\n\\n", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Plan:\n\n", "tool_use", "Done!"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Plan:\n\nDone!");
  });

  it("adds one \\n when text already ends with single \\n", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Plan:\n", "tool_use", "Done!"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Plan:\n\nDone!");
  });

  it("handles multiple tool-use blocks between text", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Part 1", "tool_use", "Part 2", "tool_use", "Part 3"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Part 1\n\nPart 2\n\nPart 3");
  });

  it("does not insert break when tool_use is before any text", async () => {
    const { platform, sends } = mockPlatform();
    // Tool use before first text — no accumulated text yet, no separator needed
    async function* toolFirst(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_stop" } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "Result here" } } } as StreamEvent;
      yield { type: "result", result: "Result here", session_id: "test" } as ResultMessage;
    }

    await relayStream(toolFirst(), platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Result here");
  });

  it("does not insert break when tool_use is before first text arriving in multiple deltas", async () => {
    const { platform, sends } = mockPlatform();
    // Tool use before first text, text arrives in multiple deltas — no spurious \n\n
    async function* toolFirstMultiDelta(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_stop" } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "Result" } } } as StreamEvent;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: " here" } } } as StreamEvent;
      yield { type: "result", result: "Result here", session_id: "test" } as ResultMessage;
    }

    await relayStream(toolFirstMultiDelta(), platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Result here");
  });

  it("preserves paragraph breaks in draft updates", async () => {
    const { platform, drafts, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Before tool", "tool_use", "After tool"]);

    await relayStream(stream, platform);

    // Final sendMessage should contain the paragraph break
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Before tool\n\nAfter tool");
  });

  it("preserves paragraph breaks in split messages over 4096 chars", async () => {
    const { platform, sends } = mockPlatform();
    const longBefore = "x".repeat(3000);
    const longAfter = "y".repeat(3000);
    const stream = fakeStreamWithTools([longBefore, "tool_use", longAfter]);

    await relayStream(stream, platform);

    // splitMessage splits at \n\n boundary, consuming it — the paragraph break
    // becomes a message boundary (separate Telegram messages), which is correct.
    assert.strictEqual(sends.length, 2, "Should split into 2 messages");
    assert.strictEqual(sends[0].text, longBefore);
    assert.strictEqual(sends[1].text, longAfter);
  });
});

describe("collapseNewlines", () => {
  it("collapses 4+ consecutive newlines to \\n\\n", () => {
    assert.strictEqual(collapseNewlines("a\n\n\n\nb"), "a\n\nb");
    assert.strictEqual(collapseNewlines("a\n\n\n\n\nb"), "a\n\nb");
  });

  it("collapses 3 consecutive newlines to \\n\\n", () => {
    assert.strictEqual(collapseNewlines("a\n\n\nb"), "a\n\nb");
  });

  it("does not collapse \\n\\n (paragraph break)", () => {
    assert.strictEqual(collapseNewlines("a\n\nb"), "a\n\nb");
  });

  it("does not affect single \\n (line break)", () => {
    assert.strictEqual(collapseNewlines("a\nb"), "a\nb");
  });

  it("handles multiple collapse sites in one string", () => {
    assert.strictEqual(collapseNewlines("a\n\n\nb\n\n\n\nc"), "a\n\nb\n\nc");
  });

  it("returns empty string unchanged", () => {
    assert.strictEqual(collapseNewlines(""), "");
  });

  it("handles string with no newlines", () => {
    assert.strictEqual(collapseNewlines("hello world"), "hello world");
  });
});

describe("relayStream newline collapsing", () => {
  it("collapses excess newlines produced by text ending in \\n + tool_use + text starting with \\n", async () => {
    const { platform, sends } = mockPlatform();
    // text1 ends with \n, tool_use adds another \n (making \n\n), text2 starts with \n → \n\n\n
    const stream = fakeStreamWithTools(["Line 1\n", "tool_use", "\nLine 2"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    // \n\n\n should be collapsed to \n\n
    assert.strictEqual(sends[0].text, "Line 1\n\nLine 2");
    assert.ok(!sends[0].text.includes("\n\n\n"), "Should not contain 3+ consecutive newlines");
  });

  it("collapses newlines in draft updates", async () => {
    const { platform, drafts } = mockPlatform();
    const stream = fakeStreamWithTools(["Before\n", "tool_use", "\nAfter"]);

    await relayStream(stream, platform);

    // If any drafts were sent, they should have collapsed newlines
    for (const draft of drafts) {
      assert.ok(!draft.text.includes("\n\n\n"), "Draft should not contain 3+ consecutive newlines");
    }
  });

  it("preserves \\n\\n after collapsing", async () => {
    const { platform, sends } = mockPlatform();
    // Normal case: paragraph break, no excess
    const stream = fakeStreamWithTools(["Para 1", "tool_use", "Para 2"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Para 1\n\nPara 2");
  });

  it("preserves single \\n after collapsing", async () => {
    const { platform, sends } = mockPlatform();
    // Text with line breaks (not paragraph breaks) — no tool use, no change
    const stream = fakeStream(["Line 1\nLine 2\nLine 3"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Line 1\nLine 2\nLine 3");
  });

  it("collapses newlines in final sendMessage", async () => {
    const { platform, sends } = mockPlatform();
    // Text with 3+ newlines — final sendMessage must collapse them
    const stream = fakeStream(["Hello\n\n\nWorld"]);

    await relayStream(stream, platform);

    assert.ok(sends.length >= 1, "Should have sent at least one message");
    assert.strictEqual(sends[0].text, "Hello\n\nWorld");
  });
});

describe("relayStream sendMessage error handling", () => {
  it("aborts remaining chunks when first chunk fails", async () => {
    const { platform, sends } = mockPlatform({ sendShouldThrow: 1 });
    // Create text that splits into 3 chunks (each ~3000 chars, max is 4096)
    const chunk1 = "a".repeat(3000);
    const chunk2 = "b".repeat(3000);
    const chunk3 = "c".repeat(3000);
    const text = chunk1 + "\n\n" + chunk2 + "\n\n" + chunk3;
    const stream = fakeStream([text]);

    // First chunk fails — throws so the queue's error handler can notify the user
    await assert.rejects(() => relayStream(stream, platform), /Failed to deliver response/);

    // No chunks should have been sent
    assert.strictEqual(sends.length, 0, "Should not send any chunks when first fails");
  });

  it("continues sending remaining chunks when a non-first chunk fails", async () => {
    const { platform, sends } = mockPlatform({ sendShouldThrow: 2 });
    // Create text that splits into 3 chunks (each ~3000 chars, max is 4096)
    const chunk1 = "a".repeat(3000);
    const chunk2 = "b".repeat(3000);
    const chunk3 = "c".repeat(3000);
    const text = chunk1 + "\n\n" + chunk2 + "\n\n" + chunk3;
    const stream = fakeStream([text]);

    await relayStream(stream, platform);

    // Chunk 1 succeeds, chunk 2 (call 2) fails, chunk 3 succeeds
    assert.strictEqual(sends.length, 2, "Should send chunks 1 and 3 (chunk 2 failed)");
  });

  it("throws when all sendMessage calls fail so queue can notify user", async () => {
    const { platform, sends } = mockPlatform({ sendShouldThrow: true });
    const stream = fakeStream(["Hello"]);

    // Should throw so the queue's error handler can send a user-facing error
    await assert.rejects(() => relayStream(stream, platform), /Failed to deliver response/);

    assert.strictEqual(sends.length, 0, "No messages should be recorded when all sends fail");
  });
});

describe("relayStream NO_REPLY with drafts", () => {
  it("suppresses delivery and does not call deleteMessage for NO_REPLY", async () => {
    const { platform, sends, drafts } = mockPlatform();
    let deleteCalled = false;
    platform.deleteMessage = async () => { deleteCalled = true; };

    const stream = fakeStream(["NO_REPLY"]);

    await relayStream(stream, platform);

    // No sendMessage for NO_REPLY — drafts auto-disappear
    assert.strictEqual(sends.length, 0, "Should not send any messages for NO_REPLY");
    assert.strictEqual(deleteCalled, false, "Should not call deleteMessage — drafts auto-disappear");
  });
});
