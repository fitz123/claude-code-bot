import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDiscordAdapter, type DiscordSendableChannel } from "../discord-adapter.js";
import type { DiscordBinding, SessionDefaults } from "../types.js";

/** Create a mock Discord channel for testing. */
function mockChannel(): DiscordSendableChannel & { sentMessages: Array<{ content?: string; files?: unknown[] }>; editedMessages: Array<{ id: string; content: string }> } {
  let nextId = 1;
  const sentMessages: Array<{ content?: string; files?: unknown[] }> = [];
  const editedMessages: Array<{ id: string; content: string }> = [];

  return {
    sentMessages,
    editedMessages,
    async send(options: string | { content?: string; files?: Array<{ attachment: string }> }) {
      const id = String(nextId++);
      if (typeof options === "string") {
        sentMessages.push({ content: options });
      } else {
        sentMessages.push(options);
      }
      return {
        id,
        async edit(text: string) {
          editedMessages.push({ id, content: text });
          return { id } as any;
        },
      } as any;
    },
    async sendTyping() {},
  };
}

const defaultBinding: DiscordBinding = {
  channelId: "123",
  guildId: "g1",
  agentId: "main",
  kind: "channel",
};

describe("createDiscordAdapter", () => {
  describe("platform constants", () => {
    it("sets Discord-specific limits", () => {
      const channel = mockChannel();
      const adapter = createDiscordAdapter(channel, defaultBinding);
      assert.strictEqual(adapter.maxMessageLength, 2000);
      assert.strictEqual(adapter.editDebounceMs, 2000);
      assert.strictEqual(adapter.typingIntervalMs, 9000);
    });
  });

  describe("streamingUpdates and typingIndicator flags", () => {
    it("defaults to false when binding and sessionDefaults have no flags", () => {
      const channel = mockChannel();
      const adapter = createDiscordAdapter(channel, defaultBinding);
      assert.strictEqual(adapter.streamingUpdates, false);
      assert.strictEqual(adapter.typingIndicator, true);
    });

    it("defaults to false when no binding or sessionDefaults provided", () => {
      const channel = mockChannel();
      const adapter = createDiscordAdapter(channel);
      assert.strictEqual(adapter.streamingUpdates, false);
      assert.strictEqual(adapter.typingIndicator, true);
    });

    it("respects binding streamingUpdates: true", () => {
      const channel = mockChannel();
      const binding: DiscordBinding = { ...defaultBinding, streamingUpdates: true };
      const adapter = createDiscordAdapter(channel, binding);
      assert.strictEqual(adapter.streamingUpdates, true);
    });

    it("respects streamingUpdates: false", () => {
      const channel = mockChannel();
      const binding: DiscordBinding = { ...defaultBinding, streamingUpdates: false };
      const adapter = createDiscordAdapter(channel, binding);
      assert.strictEqual(adapter.streamingUpdates, false);
    });

    it("respects typingIndicator: false", () => {
      const channel = mockChannel();
      const binding: DiscordBinding = { ...defaultBinding, typingIndicator: false };
      const adapter = createDiscordAdapter(channel, binding);
      assert.strictEqual(adapter.typingIndicator, false);
    });

    it("uses sessionDefaults.streamingUpdates as fallback when binding has no flag", () => {
      const channel = mockChannel();
      const defaults: SessionDefaults = { idleTimeoutMs: 3600000, maxConcurrentSessions: 12, maxMessageAgeMs: 600000, streamingUpdates: true, requireMention: false };
      const adapter = createDiscordAdapter(channel, defaultBinding, defaults);
      assert.strictEqual(adapter.streamingUpdates, true);
    });

    it("binding streamingUpdates overrides sessionDefaults", () => {
      const channel = mockChannel();
      const binding: DiscordBinding = { ...defaultBinding, streamingUpdates: false };
      const defaults: SessionDefaults = { idleTimeoutMs: 3600000, maxConcurrentSessions: 12, maxMessageAgeMs: 600000, streamingUpdates: true, requireMention: false };
      const adapter = createDiscordAdapter(channel, binding, defaults);
      assert.strictEqual(adapter.streamingUpdates, false);
    });
  });

  describe("sendMessage", () => {
    it("sends text and returns message ID", async () => {
      const channel = mockChannel();
      const adapter = createDiscordAdapter(channel, defaultBinding);
      const id = await adapter.sendMessage("Hello");
      assert.strictEqual(id, "1");
      assert.strictEqual(channel.sentMessages.length, 1);
      assert.strictEqual(channel.sentMessages[0].content, "Hello");
    });

    it("returns incrementing IDs for multiple messages", async () => {
      const channel = mockChannel();
      const adapter = createDiscordAdapter(channel, defaultBinding);
      const id1 = await adapter.sendMessage("First");
      const id2 = await adapter.sendMessage("Second");
      assert.strictEqual(id1, "1");
      assert.strictEqual(id2, "2");
    });
  });

  describe("editMessage", () => {
    it("edits a previously sent message by ID", async () => {
      const channel = mockChannel();
      const adapter = createDiscordAdapter(channel, defaultBinding);
      const id = await adapter.sendMessage("Initial");
      await adapter.editMessage(id, "Updated");
      assert.strictEqual(channel.editedMessages.length, 1);
      assert.strictEqual(channel.editedMessages[0].id, id);
      assert.strictEqual(channel.editedMessages[0].content, "Updated");
    });

    it("is a no-op for unknown message ID", async () => {
      const channel = mockChannel();
      const adapter = createDiscordAdapter(channel, defaultBinding);
      await adapter.editMessage("unknown-id", "text");
      assert.strictEqual(channel.editedMessages.length, 0);
    });
  });

  describe("sendTyping", () => {
    it("calls channel.sendTyping()", async () => {
      let typingCalled = false;
      const channel = mockChannel();
      channel.sendTyping = async () => { typingCalled = true; };
      const adapter = createDiscordAdapter(channel, defaultBinding);
      await adapter.sendTyping();
      assert.strictEqual(typingCalled, true);
    });
  });

  describe("sendFile", () => {
    it("sends file as attachment", async () => {
      const channel = mockChannel();
      const adapter = createDiscordAdapter(channel, defaultBinding);
      await adapter.sendFile("/path/to/file.png", true);
      assert.strictEqual(channel.sentMessages.length, 1);
      assert.deepStrictEqual(channel.sentMessages[0].files, [{ attachment: "/path/to/file.png" }]);
    });
  });

  describe("replyError", () => {
    it("sends error text as a message", async () => {
      const channel = mockChannel();
      const adapter = createDiscordAdapter(channel, defaultBinding);
      await adapter.replyError("Something went wrong");
      assert.strictEqual(channel.sentMessages.length, 1);
      assert.strictEqual(channel.sentMessages[0].content, "Something went wrong");
    });
  });
});
