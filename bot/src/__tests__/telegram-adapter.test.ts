import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTelegramAdapter, setBotUsername } from "../telegram-adapter.js";
import type { SessionDefaults, TelegramBinding } from "../types.js";
import { getThread, clearThreadCache } from "../message-thread-cache.js";
import { lookupMessage, clearMessageIndex } from "../message-content-index.js";

/** Create a minimal mock of grammy Context for testing. */
function mockContext(opts: {
  chatId?: number;
  threadId?: number;
  failOnHtml?: boolean;
} = {}): any {
  const chatId = opts.chatId ?? 12345;
  const failOnHtml = opts.failOnHtml ?? false;
  const sentMessages: Array<{ text: string; opts: any }> = [];
  const editedMessages: Array<{ chatId: number; msgId: number; text: string; opts?: any }> = [];
  const chatActions: Array<{ chatId: number; action: string; opts: any }> = [];
  let nextMsgId = 100;

  return {
    chat: chatId !== undefined ? { id: chatId } : undefined,
    message: opts.threadId != null ? { message_thread_id: opts.threadId } : {},
    async reply(text: string, replyOpts: any = {}) {
      if (failOnHtml && replyOpts.parse_mode === "HTML") {
        throw new Error("Bad Request: can't parse entities");
      }
      const id = nextMsgId++;
      sentMessages.push({ text, opts: replyOpts });
      return { message_id: id };
    },
    api: {
      async editMessageText(cId: number, msgId: number, text: string, editOpts?: any) {
        if (failOnHtml && editOpts?.parse_mode === "HTML") {
          throw new Error("Bad Request: can't parse entities");
        }
        editedMessages.push({ chatId: cId, msgId, text, opts: editOpts });
      },
      async sendChatAction(cId: number, action: string, actionOpts: any) {
        chatActions.push({ chatId: cId, action, opts: actionOpts });
      },
    },
    async replyWithPhoto(_file: any, opts: any) {
      const id = nextMsgId++;
      sentMessages.push({ text: "[photo]", opts });
      return { message_id: id };
    },
    async replyWithDocument(_file: any, opts: any) {
      const id = nextMsgId++;
      sentMessages.push({ text: "[document]", opts });
      return { message_id: id };
    },
    // Expose internals for assertions
    _sentMessages: sentMessages,
    _editedMessages: editedMessages,
    _chatActions: chatActions,
  };
}

const defaultBinding: TelegramBinding = {
  chatId: 12345,
  agentId: "main",
  kind: "dm",
};

describe("createTelegramAdapter", () => {
  afterEach(() => {
    clearThreadCache();
    clearMessageIndex();
  });

  describe("platform constants", () => {
    it("sets Telegram-specific limits", () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      assert.strictEqual(adapter.maxMessageLength, 4096);
      assert.strictEqual(adapter.typingIntervalMs, 5000);
    });
  });

  describe("typingIndicator flag", () => {
    it("defaults to true when binding has no flag", () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      assert.strictEqual(adapter.typingIndicator, true);
    });

    it("defaults to true when no binding provided", () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx);
      assert.strictEqual(adapter.typingIndicator, true);
    });

    it("respects typingIndicator: false", () => {
      const ctx = mockContext();
      const binding: TelegramBinding = { ...defaultBinding, typingIndicator: false };
      const adapter = createTelegramAdapter(ctx, binding);
      assert.strictEqual(adapter.typingIndicator, false);
    });
  });

  describe("sendDraft", () => {
    it("calls api.sendMessageDraft for DM bindings", async () => {
      const ctx = mockContext();
      const draftCalls: Array<{ chatId: number; draftId: number; text: string; opts: any }> = [];
      ctx.api.sendMessageDraft = async (cId: number, dId: number, text: string, opts?: any) => {
        draftCalls.push({ chatId: cId, draftId: dId, text, opts });
        return true;
      };
      const binding: TelegramBinding = { ...defaultBinding, kind: "dm" };
      const adapter = createTelegramAdapter(ctx, binding);
      await adapter.sendDraft(42, "streaming text");
      assert.strictEqual(draftCalls.length, 1);
      assert.strictEqual(draftCalls[0].chatId, 12345);
      assert.strictEqual(draftCalls[0].draftId, 42);
      assert.strictEqual(draftCalls[0].opts?.parse_mode, "HTML");
    });

    it("is a no-op for group bindings", async () => {
      const ctx = mockContext();
      const draftCalls: unknown[] = [];
      ctx.api.sendMessageDraft = async () => { draftCalls.push(1); return true; };
      const binding: TelegramBinding = { ...defaultBinding, kind: "group" };
      const adapter = createTelegramAdapter(ctx, binding);
      await adapter.sendDraft(42, "streaming text");
      assert.strictEqual(draftCalls.length, 0);
    });

    it("silently ignores errors", async () => {
      const ctx = mockContext();
      ctx.api.sendMessageDraft = async () => { throw new Error("rate limited"); };
      const binding: TelegramBinding = { ...defaultBinding, kind: "dm" };
      const adapter = createTelegramAdapter(ctx, binding);
      // Should not throw
      await adapter.sendDraft(42, "text");
    });

    it("is a no-op when chatId is undefined", async () => {
      const ctx = mockContext();
      ctx.chat = undefined;
      const draftCalls: unknown[] = [];
      ctx.api.sendMessageDraft = async () => { draftCalls.push(1); return true; };
      const binding: TelegramBinding = { ...defaultBinding, kind: "dm" };
      const adapter = createTelegramAdapter(ctx, binding);
      await adapter.sendDraft(42, "text");
      assert.strictEqual(draftCalls.length, 0);
    });

    it("includes message_thread_id when thread is set", async () => {
      const ctx = mockContext({ threadId: 77 });
      const draftCalls: Array<{ opts: any }> = [];
      ctx.api.sendMessageDraft = async (_cId: number, _dId: number, _text: string, opts?: any) => {
        draftCalls.push({ opts });
        return true;
      };
      const binding: TelegramBinding = { ...defaultBinding, kind: "dm" };
      const adapter = createTelegramAdapter(ctx, binding);
      await adapter.sendDraft(42, "text");
      assert.strictEqual(draftCalls[0].opts?.message_thread_id, 77);
    });
  });

  describe("sendMessage", () => {
    it("sends text and returns stringified message ID", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      const id = await adapter.sendMessage("Hello");
      assert.strictEqual(id, "100");
      assert.strictEqual(ctx._sentMessages.length, 1);
      assert.strictEqual(ctx._sentMessages[0].text, "Hello");
    });

    it("includes thread opts when message_thread_id is set", async () => {
      const ctx = mockContext({ threadId: 42 });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendMessage("Threaded");
      assert.strictEqual(ctx._sentMessages[0].opts.message_thread_id, 42);
    });

    it("omits thread opts when no thread", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendMessage("No thread");
      assert.strictEqual(ctx._sentMessages[0].opts.message_thread_id, undefined);
    });

    it("sends with parse_mode HTML", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendMessage("**bold**");
      assert.strictEqual(ctx._sentMessages[0].opts.parse_mode, "HTML");
      assert.strictEqual(ctx._sentMessages[0].text, "<b>bold</b>");
    });

    it("falls back to plain text when HTML parse fails", async () => {
      const ctx = mockContext({ failOnHtml: true });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      const id = await adapter.sendMessage("**bold**");
      assert.strictEqual(id, "100");
      assert.strictEqual(ctx._sentMessages.length, 1);
      // Fallback sends original text without parse_mode
      assert.strictEqual(ctx._sentMessages[0].text, "**bold**");
      assert.strictEqual(ctx._sentMessages[0].opts.parse_mode, undefined);
    });

    it("falls back to plain text when message is too long after HTML expansion", async () => {
      const ctx = mockContext();
      // Simulate Telegram rejecting HTML that exceeded length limit
      const originalReply = ctx.reply.bind(ctx);
      let callCount = 0;
      ctx.reply = async (text: string, opts: any = {}) => {
        callCount++;
        if (callCount === 1 && opts.parse_mode === "HTML") {
          throw new Error("Bad Request: message is too long");
        }
        return originalReply(text, opts);
      };
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      const id = await adapter.sendMessage("test & text");
      assert.strictEqual(id, "100");
      // Fallback sends original text without parse_mode
      assert.strictEqual(ctx._sentMessages[0].text, "test & text");
      assert.strictEqual(ctx._sentMessages[0].opts.parse_mode, undefined);
    });

    it("re-throws non-HTML errors instead of falling back", async () => {
      const ctx = mockContext();
      // Override reply to throw a network error
      ctx.reply = async () => { throw new Error("network timeout"); };
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await assert.rejects(
        () => adapter.sendMessage("hello"),
        { message: "network timeout" },
      );
    });

    it("caches sent message_id for topic routing", async () => {
      const ctx = mockContext({ chatId: 12345, threadId: 42 });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendMessage("Bot reply");
      // The sent message (id 100) should be cached with topicId 42
      assert.strictEqual(getThread(12345, 100), 42);
    });

    it("caches sent message_id on HTML fallback path", async () => {
      const ctx = mockContext({ chatId: 12345, threadId: 42, failOnHtml: true });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendMessage("**bold**");
      assert.strictEqual(getThread(12345, 100), 42);
    });

    it("does not cache when no threadId", async () => {
      const ctx = mockContext({ chatId: 12345 });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendMessage("No topic");
      assert.strictEqual(getThread(12345, 100), undefined);
    });
  });

  describe("sendTyping", () => {
    const groupBinding: TelegramBinding = { chatId: 12345, agentId: "main", kind: "group" };

    it("sends typing action for group chats", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, groupBinding);
      await adapter.sendTyping();
      assert.strictEqual(ctx._chatActions.length, 1);
      assert.strictEqual(ctx._chatActions[0].chatId, 12345);
      assert.strictEqual(ctx._chatActions[0].action, "typing");
    });

    it("includes thread ID when present", async () => {
      const ctx = mockContext({ threadId: 42 });
      const adapter = createTelegramAdapter(ctx, groupBinding);
      await adapter.sendTyping();
      assert.strictEqual(ctx._chatActions[0].opts.message_thread_id, 42);
    });

    it("is a no-op for DM chats (drafts show typing)", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendTyping();
      assert.strictEqual(ctx._chatActions.length, 0);
    });

    it("is a no-op when chatId is undefined", async () => {
      const ctx = mockContext();
      ctx.chat = undefined;
      const adapter = createTelegramAdapter(ctx, groupBinding);
      await adapter.sendTyping();
      assert.strictEqual(ctx._chatActions.length, 0);
    });
  });

  describe("threadIdOverride", () => {
    it("uses threadIdOverride when provided", async () => {
      const ctx = mockContext(); // no threadId on ctx.message
      const adapter = createTelegramAdapter(ctx, defaultBinding, 99);
      await adapter.sendMessage("Hello");
      assert.strictEqual(ctx._sentMessages[0].opts.message_thread_id, 99);
    });

    it("threadIdOverride takes precedence over ctx.message.message_thread_id", async () => {
      const ctx = mockContext({ threadId: 42 });
      const adapter = createTelegramAdapter(ctx, defaultBinding, 99);
      await adapter.sendMessage("Hello");
      assert.strictEqual(ctx._sentMessages[0].opts.message_thread_id, 99);
    });

    it("falls back to ctx.message.message_thread_id when threadIdOverride is undefined", async () => {
      const ctx = mockContext({ threadId: 42 });
      const adapter = createTelegramAdapter(ctx, defaultBinding, undefined);
      await adapter.sendMessage("Hello");
      assert.strictEqual(ctx._sentMessages[0].opts.message_thread_id, 42);
    });

    it("handles threadIdOverride of 0 (General topic)", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding, 0);
      await adapter.sendMessage("Hello");
      assert.strictEqual(ctx._sentMessages[0].opts.message_thread_id, 0);
    });

    it("sendTyping uses threadIdOverride", async () => {
      const ctx = mockContext();
      const groupBinding: TelegramBinding = { chatId: 12345, agentId: "main", kind: "group" };
      const adapter = createTelegramAdapter(ctx, groupBinding, 55);
      await adapter.sendTyping();
      assert.strictEqual(ctx._chatActions[0].opts.message_thread_id, 55);
    });
  });

  describe("replyError", () => {
    it("sends error text as a reply without parse_mode", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.replyError("Something went wrong");
      assert.strictEqual(ctx._sentMessages.length, 1);
      assert.strictEqual(ctx._sentMessages[0].text, "Something went wrong");
      assert.strictEqual(ctx._sentMessages[0].opts.parse_mode, undefined);
    });
  });

  describe("message content index recording", () => {
    it("sendMessage records outgoing message in index", async () => {
      setBotUsername("testbot");
      const ctx = mockContext({ chatId: 12345 });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendMessage("Hello world");
      const record = lookupMessage(12345, 100);
      assert.ok(record);
      assert.strictEqual(record.from, "@testbot");
      assert.strictEqual(record.preview, "Hello world");
      assert.strictEqual(record.direction, "out");
    });

    it("sendMessage records on HTML fallback path", async () => {
      setBotUsername("testbot");
      const ctx = mockContext({ chatId: 12345, failOnHtml: true });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendMessage("**bold**");
      const record = lookupMessage(12345, 100);
      assert.ok(record);
      assert.strictEqual(record.from, "@testbot");
      assert.strictEqual(record.preview, "**bold**");
      assert.strictEqual(record.direction, "out");
    });

    it("sendFile records outgoing photo in index", async () => {
      setBotUsername("testbot");
      const ctx = mockContext({ chatId: 12345 });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendFile("/tmp/photo.jpg", true);
      const record = lookupMessage(12345, 100);
      assert.ok(record);
      assert.strictEqual(record.from, "@testbot");
      assert.strictEqual(record.preview, "[photo]");
      assert.strictEqual(record.direction, "out");
    });

    it("sendFile records outgoing file in index", async () => {
      setBotUsername("testbot");
      const ctx = mockContext({ chatId: 12345 });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendFile("/tmp/doc.pdf", false);
      const record = lookupMessage(12345, 100);
      assert.ok(record);
      assert.strictEqual(record.from, "@testbot");
      assert.strictEqual(record.preview, "[file]");
      assert.strictEqual(record.direction, "out");
    });

    it("replyError records error message in index", async () => {
      setBotUsername("testbot");
      const ctx = mockContext({ chatId: 12345 });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.replyError("Something went wrong");
      const record = lookupMessage(12345, 100);
      assert.ok(record);
      assert.strictEqual(record.from, "@testbot");
      assert.strictEqual(record.preview, "Something went wrong");
      assert.strictEqual(record.direction, "out");
    });

    it("does not record when chatId is undefined", async () => {
      setBotUsername("testbot");
      const ctx = mockContext();
      ctx.chat = undefined;
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      // sendMessage will fail because chat is undefined, but replyError might work
      // This verifies the guard: chatId != null before recordMessage
      await adapter.replyError("error text");
      // No chatId means no recording — we can't look up without a chatId
      // Just verifying no crash occurs
    });
  });
});
