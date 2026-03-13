import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  discordSessionKey,
  resolveDiscordBinding,
  shouldRespondInDiscord,
  buildDiscordSourcePrefix,
} from "../discord-bot.js";
import type { DiscordBinding } from "../types.js";

// --- discordSessionKey ---

describe("discordSessionKey", () => {
  it("returns discord:channelId when no threadId", () => {
    assert.strictEqual(discordSessionKey("123456"), "discord:123456");
  });

  it("returns discord:channelId:threadId when threadId is present", () => {
    assert.strictEqual(discordSessionKey("123456", "789"), "discord:123456:789");
  });

  it("handles large snowflake IDs", () => {
    assert.strictEqual(
      discordSessionKey("1234567890123456789", "9876543210987654321"),
      "discord:1234567890123456789:9876543210987654321",
    );
  });

  it("does not append colon when threadId is undefined", () => {
    assert.strictEqual(discordSessionKey("123456", undefined), "discord:123456");
  });

  it("does not collide with Telegram session keys", () => {
    const discordKey = discordSessionKey("123456");
    // Telegram keys are just "123456" or "123456:topicId"
    assert.ok(discordKey.startsWith("discord:"));
    assert.notStrictEqual(discordKey, "123456");
  });
});

// --- resolveDiscordBinding ---

const testBindings: DiscordBinding[] = [
  { channelId: "111", guildId: "g1", agentId: "main", kind: "channel", label: "General" },
  { channelId: "222", guildId: "g1", agentId: "dev", kind: "channel", label: "Dev" },
  { channelId: "333", guildId: "g2", agentId: "support", kind: "dm" },
];

describe("resolveDiscordBinding", () => {
  it("resolves binding by channelId", () => {
    const binding = resolveDiscordBinding("111", testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    assert.strictEqual(binding.label, "General");
  });

  it("resolves second binding", () => {
    const binding = resolveDiscordBinding("222", testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "dev");
  });

  it("resolves DM binding", () => {
    const binding = resolveDiscordBinding("333", testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.kind, "dm");
    assert.strictEqual(binding.agentId, "support");
  });

  it("returns undefined for unknown channelId", () => {
    const binding = resolveDiscordBinding("999", testBindings);
    assert.strictEqual(binding, undefined);
  });

  it("handles empty bindings array", () => {
    const binding = resolveDiscordBinding("111", []);
    assert.strictEqual(binding, undefined);
  });
});

// --- shouldRespondInDiscord ---

describe("shouldRespondInDiscord", () => {
  const channelBinding: DiscordBinding = { channelId: "111", guildId: "g1", agentId: "main", kind: "channel" };
  const channelNoMention: DiscordBinding = { channelId: "111", guildId: "g1", agentId: "main", kind: "channel", requireMention: false };
  const dmBinding: DiscordBinding = { channelId: "333", guildId: "g1", agentId: "main", kind: "dm" };
  const botUserId = "bot999";

  // Minimal mock for Discord Message — only what shouldRespondInDiscord uses
  function mockMessage(opts: { hasBotMention?: boolean } = {}): any {
    return {
      mentions: {
        has(userId: string): boolean {
          return opts.hasBotMention === true && userId === botUserId;
        },
      },
    };
  }

  it("always returns true for DM bindings", () => {
    assert.strictEqual(shouldRespondInDiscord(dmBinding, botUserId, mockMessage()), true);
  });

  it("returns true for channel with requireMention: false", () => {
    assert.strictEqual(shouldRespondInDiscord(channelNoMention, botUserId, mockMessage()), true);
  });

  it("returns false for channel with default requireMention and no mention", () => {
    assert.strictEqual(shouldRespondInDiscord(channelBinding, botUserId, mockMessage()), false);
  });

  it("returns true when bot is mentioned", () => {
    assert.strictEqual(
      shouldRespondInDiscord(channelBinding, botUserId, mockMessage({ hasBotMention: true })),
      true,
    );
  });

  it("returns false when different user is mentioned", () => {
    const msg = {
      mentions: {
        has(userId: string): boolean {
          return userId === "other123";
        },
      },
    };
    assert.strictEqual(shouldRespondInDiscord(channelBinding, botUserId, msg as any), false);
  });

  it("returns true for channel with explicit requireMention: true and bot mention", () => {
    const explicit: DiscordBinding = { ...channelBinding, requireMention: true };
    assert.strictEqual(
      shouldRespondInDiscord(explicit, botUserId, mockMessage({ hasBotMention: true })),
      true,
    );
  });
});

// --- buildDiscordSourcePrefix ---

describe("buildDiscordSourcePrefix", () => {
  it("includes chat label and sender with username", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "General" };
    const author = { username: "johndoe", globalName: "John Doe" };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[Chat: General | From: John Doe (@johndoe)]\n",
    );
  });

  it("falls back to username when globalName is null", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "Dev" };
    const author = { username: "alice", globalName: null };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[Chat: Dev | From: alice (@alice)]\n",
    );
  });

  it("uses displayName when globalName is not available", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "Dev" };
    const author = { username: "bob", displayName: "Bobby", globalName: null };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[Chat: Dev | From: Bobby (@bob)]\n",
    );
  });

  it("omits chat label when binding has no label", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel" };
    const author = { username: "bob", globalName: "Bob Smith" };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[From: Bob Smith (@bob)]\n",
    );
  });

  it("omits sender when author is undefined", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "Help" };
    assert.strictEqual(buildDiscordSourcePrefix(binding, undefined), "[Chat: Help]\n");
  });

  it("returns empty string when no label and no author", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "dm" };
    assert.strictEqual(buildDiscordSourcePrefix(binding, undefined), "");
  });

  it("strips newlines from display names", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "Chat" };
    const author = { username: "evil\nuser", globalName: "Evil\nName" };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[Chat: Chat | From: Evil Name (@eviluser)]\n",
    );
  });
});

// --- Thread session isolation ---

describe("thread session isolation", () => {
  it("thread session key differs from parent channel key", () => {
    const parentKey = discordSessionKey("111");
    const threadKey = discordSessionKey("111", "thread1");
    assert.notStrictEqual(parentKey, threadKey);
  });

  it("different threads in same channel get different keys", () => {
    const thread1 = discordSessionKey("111", "t1");
    const thread2 = discordSessionKey("111", "t2");
    assert.notStrictEqual(thread1, thread2);
  });

  it("thread inherits parent channel binding", () => {
    // When a thread message arrives, we look up the parent channel's binding
    const parentChannelId = "111";
    const binding = resolveDiscordBinding(parentChannelId, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    // But the session key includes the thread ID for isolation
    const key = discordSessionKey(parentChannelId, "thread123");
    assert.strictEqual(key, "discord:111:thread123");
  });
});

// --- Streaming control flags ---

describe("Discord binding streaming control", () => {
  it("streamingUpdates defaults to undefined (treated as true by adapter)", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel" };
    assert.strictEqual(binding.streamingUpdates, undefined);
  });

  it("streamingUpdates can be set to false", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", streamingUpdates: false };
    assert.strictEqual(binding.streamingUpdates, false);
  });

  it("typingIndicator can be set to false", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", typingIndicator: false };
    assert.strictEqual(binding.typingIndicator, false);
  });
});
