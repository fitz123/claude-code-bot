import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTelegramAdapter } from "../telegram-adapter.js";
import type { TelegramBinding } from "../types.js";

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
    message: opts.threadId ? { message_thread_id: opts.threadId } : {},
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
      sentMessages.push({ text: "[photo]", opts });
    },
    async replyWithDocument(_file: any, opts: any) {
      sentMessages.push({ text: "[document]", opts });
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
  describe("platform constants", () => {
    it("sets Telegram-specific limits", () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      assert.strictEqual(adapter.maxMessageLength, 4096);
      assert.strictEqual(adapter.editDebounceMs, 2000);
      assert.strictEqual(adapter.typingIntervalMs, 4000);
    });
  });

  describe("streamingUpdates and typingIndicator flags", () => {
    it("defaults to true when binding has no flags", () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      assert.strictEqual(adapter.streamingUpdates, true);
      assert.strictEqual(adapter.typingIndicator, true);
    });

    it("defaults to true when no binding provided", () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx);
      assert.strictEqual(adapter.streamingUpdates, true);
      assert.strictEqual(adapter.typingIndicator, true);
    });

    it("respects streamingUpdates: false", () => {
      const ctx = mockContext();
      const binding: TelegramBinding = { ...defaultBinding, streamingUpdates: false };
      const adapter = createTelegramAdapter(ctx, binding);
      assert.strictEqual(adapter.streamingUpdates, false);
    });

    it("respects typingIndicator: false", () => {
      const ctx = mockContext();
      const binding: TelegramBinding = { ...defaultBinding, typingIndicator: false };
      const adapter = createTelegramAdapter(ctx, binding);
      assert.strictEqual(adapter.typingIndicator, false);
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
  });

  describe("editMessage", () => {
    it("edits message via ctx.api.editMessageText", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.editMessage("50", "Updated text");
      assert.strictEqual(ctx._editedMessages.length, 1);
      assert.strictEqual(ctx._editedMessages[0].chatId, 12345);
      assert.strictEqual(ctx._editedMessages[0].msgId, 50);
      assert.strictEqual(ctx._editedMessages[0].text, "Updated text");
    });

    it("edits with parse_mode HTML", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.editMessage("50", "**bold**");
      assert.strictEqual(ctx._editedMessages[0].text, "<b>bold</b>");
      assert.strictEqual(ctx._editedMessages[0].opts?.parse_mode, "HTML");
    });

    it("falls back to plain text when HTML parse fails", async () => {
      const ctx = mockContext({ failOnHtml: true });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.editMessage("50", "**bold**");
      assert.strictEqual(ctx._editedMessages.length, 1);
      // Fallback sends original text without parse_mode
      assert.strictEqual(ctx._editedMessages[0].text, "**bold**");
      assert.strictEqual(ctx._editedMessages[0].opts, undefined);
    });

    it("is a no-op when chatId is undefined", async () => {
      const ctx = mockContext();
      ctx.chat = undefined;
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.editMessage("50", "text");
      assert.strictEqual(ctx._editedMessages.length, 0);
    });
  });

  describe("sendTyping", () => {
    it("sends typing action with correct chat ID", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendTyping();
      assert.strictEqual(ctx._chatActions.length, 1);
      assert.strictEqual(ctx._chatActions[0].chatId, 12345);
      assert.strictEqual(ctx._chatActions[0].action, "typing");
    });

    it("includes thread ID when present", async () => {
      const ctx = mockContext({ threadId: 42 });
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendTyping();
      assert.strictEqual(ctx._chatActions[0].opts.message_thread_id, 42);
    });

    it("is a no-op when chatId is undefined", async () => {
      const ctx = mockContext();
      ctx.chat = undefined;
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.sendTyping();
      assert.strictEqual(ctx._chatActions.length, 0);
    });
  });

  describe("replyError", () => {
    it("sends error text as a reply", async () => {
      const ctx = mockContext();
      const adapter = createTelegramAdapter(ctx, defaultBinding);
      await adapter.replyError("Something went wrong");
      assert.strictEqual(ctx._sentMessages.length, 1);
      assert.strictEqual(ctx._sentMessages[0].text, "Something went wrong");
    });
  });
});
