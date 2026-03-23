process.env.TZ = "UTC";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBinding, isAuthorized, sessionKey, isImageMimeType, imageExtensionForMime, buildSourcePrefix, shouldRespondInGroup, BOT_COMMANDS, isStaleMessage, buildReplyContext, buildForwardContext, extensionForDocument, formatFileSize, formatDocumentMeta, buildReactionContext, AUTO_RETRY_OPTIONS, extractMediaInfo, extensionForMedia, formatMediaMeta } from "../telegram-bot.js";
import type { TelegramBinding } from "../types.js";

const testBindings: TelegramBinding[] = [
  { chatId: 111111111, agentId: "main", kind: "dm", label: "User1 DM" },
  { chatId: 222222222, agentId: "agent-b", kind: "dm", label: "User2 DM" },
  { chatId: 333333333, agentId: "agent-c", kind: "dm", label: "User3 DM" },
  { chatId: -1009999999999, agentId: "cyber-architect", kind: "group", label: "Test Group" },
];

describe("resolveBinding", () => {
  it("resolves User1 DM binding", () => {
    const binding = resolveBinding(111111111, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    assert.strictEqual(binding.kind, "dm");
  });

  it("resolves User2 DM binding", () => {
    const binding = resolveBinding(222222222, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "agent-b");
  });

  it("resolves User3 DM binding", () => {
    const binding = resolveBinding(333333333, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "agent-c");
  });

  it("resolves group binding with negative chatId", () => {
    const binding = resolveBinding(-1009999999999, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "cyber-architect");
    assert.strictEqual(binding.kind, "group");
  });

  it("returns undefined for unknown chatId", () => {
    const binding = resolveBinding(999999, testBindings);
    assert.strictEqual(binding, undefined);
  });
});

describe("sessionKey", () => {
  it("returns chatId string when no topicId", () => {
    assert.strictEqual(sessionKey(123456), "123456");
  });

  it("returns chatId:topicId when topicId is present", () => {
    assert.strictEqual(sessionKey(123456, 42), "123456:42");
  });

  it("works with negative chatId (group)", () => {
    assert.strictEqual(sessionKey(-1009999999999, 99), "-1009999999999:99");
  });

  it("accepts string chatId", () => {
    assert.strictEqual(sessionKey("123456", 7), "123456:7");
  });

  it("does not append colon when topicId is undefined", () => {
    assert.strictEqual(sessionKey(123456, undefined), "123456");
  });

  it("handles topicId 0 (General topic in forums)", () => {
    assert.strictEqual(sessionKey(123456, 0), "123456:0");
  });
});

describe("resolveBinding with topicId", () => {
  const topicBindings: TelegramBinding[] = [
    { chatId: -100999, agentId: "general", kind: "group", label: "General" },
    { chatId: -100999, agentId: "dev-topic", kind: "group", topicId: 10, label: "Dev Topic" },
    { chatId: -100999, agentId: "ops-topic", kind: "group", topicId: 20, label: "Ops Topic" },
  ];

  it("returns exact topic match when topicId matches", () => {
    const binding = resolveBinding(-100999, topicBindings, 10);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "dev-topic");
  });

  it("returns different topic binding for different topicId", () => {
    const binding = resolveBinding(-100999, topicBindings, 20);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "ops-topic");
  });

  it("falls back to chatId-only binding for unknown topicId", () => {
    const binding = resolveBinding(-100999, topicBindings, 999);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "general");
    assert.strictEqual(binding.topicId, 999);
  });

  it("falls back to chatId-only binding when no topicId provided", () => {
    const binding = resolveBinding(-100999, topicBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "general");
  });

  it("returns undefined when chatId does not match at all", () => {
    const binding = resolveBinding(-999999, topicBindings, 10);
    assert.strictEqual(binding, undefined);
  });

  it("returns undefined when only topic bindings exist and topicId does not match", () => {
    const topicOnly: TelegramBinding[] = [
      { chatId: -100999, agentId: "dev-topic", kind: "group", topicId: 10 },
    ];
    const binding = resolveBinding(-100999, topicOnly, 999);
    assert.strictEqual(binding, undefined);
  });

  it("existing bindings without topicId still work (backward compatible)", () => {
    const binding = resolveBinding(111111111, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
  });
});

describe("isAuthorized", () => {
  it("authorizes known DM chat", () => {
    assert.strictEqual(isAuthorized(111111111, testBindings), true);
  });

  it("authorizes known group chat", () => {
    assert.strictEqual(isAuthorized(-1009999999999, testBindings), true);
  });

  it("rejects unknown chatId", () => {
    assert.strictEqual(isAuthorized(123456, testBindings), false);
  });

  it("rejects zero", () => {
    assert.strictEqual(isAuthorized(0, testBindings), false);
  });

  it("handles empty bindings", () => {
    assert.strictEqual(isAuthorized(111111111, []), false);
  });
});

describe("isImageMimeType", () => {
  it("returns true for image/jpeg", () => {
    assert.strictEqual(isImageMimeType("image/jpeg"), true);
  });

  it("returns true for image/png", () => {
    assert.strictEqual(isImageMimeType("image/png"), true);
  });

  it("returns true for image/gif", () => {
    assert.strictEqual(isImageMimeType("image/gif"), true);
  });

  it("returns true for image/webp", () => {
    assert.strictEqual(isImageMimeType("image/webp"), true);
  });

  it("returns true for image/bmp", () => {
    assert.strictEqual(isImageMimeType("image/bmp"), true);
  });

  it("returns false for application/pdf", () => {
    assert.strictEqual(isImageMimeType("application/pdf"), false);
  });

  it("returns false for text/plain", () => {
    assert.strictEqual(isImageMimeType("text/plain"), false);
  });

  it("returns false for undefined", () => {
    assert.strictEqual(isImageMimeType(undefined), false);
  });

  it("returns false for video/mp4", () => {
    assert.strictEqual(isImageMimeType("video/mp4"), false);
  });

  it("returns false for image/svg+xml (unsupported by Claude vision)", () => {
    assert.strictEqual(isImageMimeType("image/svg+xml"), false);
  });

  it("returns false for image/tiff (unsupported by Claude vision)", () => {
    assert.strictEqual(isImageMimeType("image/tiff"), false);
  });
});

describe("BOT_COMMANDS", () => {
  it("contains start, reset, and status commands", () => {
    const names = BOT_COMMANDS.map((c) => c.command);
    assert.deepStrictEqual(names, ["start", "reset", "status"]);
  });

  it("each command has a non-empty description", () => {
    for (const cmd of BOT_COMMANDS) {
      assert.ok(cmd.description.length > 0, `${cmd.command} has empty description`);
    }
  });
});

describe("buildSourcePrefix", () => {
  it("includes chat label and sender with username", () => {
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "group", label: "Minime HQ" };
    const from = { first_name: "John", username: "johndoe" };
    assert.strictEqual(buildSourcePrefix(binding, from), "[Chat: Minime HQ | From: John (@johndoe)]\n");
  });

  it("includes sender without username", () => {
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "dm", label: "User1 DM" };
    const from = { first_name: "Alice" };
    assert.strictEqual(buildSourcePrefix(binding, from), "[Chat: User1 DM | From: Alice]\n");
  });

  it("omits chat label when binding has no label", () => {
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "dm" };
    const from = { first_name: "Bob", username: "bob123" };
    assert.strictEqual(buildSourcePrefix(binding, from), "[From: Bob (@bob123)]\n");
  });

  it("omits sender when from is undefined", () => {
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "group", label: "Dev Chat" };
    assert.strictEqual(buildSourcePrefix(binding, undefined), "[Chat: Dev Chat]\n");
  });

  it("returns empty string when no label and no from", () => {
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "dm" };
    assert.strictEqual(buildSourcePrefix(binding, undefined), "");
  });

  it("includes topicId between chat and from when present", () => {
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "group", label: "Minime HQ", topicId: 591 };
    const from = { first_name: "User", username: "user" };
    assert.strictEqual(buildSourcePrefix(binding, from), "[Chat: Minime HQ | Topic: 591 | From: User (@user)]\n");
  });

  it("omits topic field when topicId is undefined", () => {
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "dm", label: "DM Chat" };
    const from = { first_name: "Alice" };
    assert.strictEqual(buildSourcePrefix(binding, from), "[Chat: DM Chat | From: Alice]\n");
  });

  it("shows topicId for unlisted topic via resolveBinding fallback", () => {
    const bindings: TelegramBinding[] = [
      {
        chatId: -100999,
        agentId: "main",
        kind: "group",
        label: "HQ",
        topics: [{ topicId: 10, agentId: "finance" }],
      },
    ];
    const binding = resolveBinding(-100999, bindings, 1890);
    assert.ok(binding);
    assert.strictEqual(buildSourcePrefix(binding, { first_name: "User" }), "[Chat: HQ | Topic: 1890 | From: User]\n");
  });

  it("DM binding without topicId shows no Topic field", () => {
    const bindings: TelegramBinding[] = [
      { chatId: 100, agentId: "main", kind: "dm", label: "User1 DM" },
    ];
    const binding = resolveBinding(100, bindings);
    assert.ok(binding);
    assert.strictEqual(buildSourcePrefix(binding, { first_name: "User1" }), "[Chat: User1 DM | From: User1]\n");
  });

  it("appends HH:MM timestamp as last field when timestampUnixSec is provided", () => {
    // 1700000000 Unix sec = 2023-11-14T22:13:20Z (UTC)
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "group", label: "HQ" };
    const from = { first_name: "Alice", username: "alice" };
    assert.strictEqual(
      buildSourcePrefix(binding, from, 1700000000),
      "[Chat: HQ | From: Alice (@alice) | 22:13]\n",
    );
  });

  it("works without crash when timestamp is undefined (backward compat)", () => {
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "group", label: "HQ" };
    const from = { first_name: "Alice" };
    assert.strictEqual(buildSourcePrefix(binding, from, undefined), "[Chat: HQ | From: Alice]\n");
  });

  it("includes timestamp even when no label and no from", () => {
    // 1700000000 Unix sec = 2023-11-14T22:13:20Z (UTC)
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "dm" };
    assert.strictEqual(buildSourcePrefix(binding, undefined, 1700000000), "[22:13]\n");
  });

  it("includes timestamp after topic field when topicId and timestamp are both set", () => {
    // 1700000000 Unix sec = 2023-11-14T22:13:20Z (UTC)
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "group", label: "HQ", topicId: 42 };
    const from = { first_name: "Alice", username: "alice" };
    assert.strictEqual(
      buildSourcePrefix(binding, from, 1700000000),
      "[Chat: HQ | Topic: 42 | From: Alice (@alice) | 22:13]\n",
    );
  });

  it("zero-pads single-digit hours and minutes in timestamp", () => {
    // 1700006700 Unix sec = 2023-11-15T00:05:00Z (UTC) → "00:05"
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "group", label: "HQ" };
    const from = { first_name: "Alice" };
    assert.strictEqual(buildSourcePrefix(binding, from, 1700006700), "[Chat: HQ | From: Alice | 00:05]\n");
  });
});

describe("imageExtensionForMime", () => {
  it("returns .jpg for image/jpeg", () => {
    assert.strictEqual(imageExtensionForMime("image/jpeg"), ".jpg");
  });

  it("returns .png for image/png", () => {
    assert.strictEqual(imageExtensionForMime("image/png"), ".png");
  });

  it("returns .gif for image/gif", () => {
    assert.strictEqual(imageExtensionForMime("image/gif"), ".gif");
  });

  it("returns .webp for image/webp", () => {
    assert.strictEqual(imageExtensionForMime("image/webp"), ".webp");
  });

  it("returns .bmp for image/bmp", () => {
    assert.strictEqual(imageExtensionForMime("image/bmp"), ".bmp");
  });

  it("returns .jpg for undefined", () => {
    assert.strictEqual(imageExtensionForMime(undefined), ".jpg");
  });

  it("returns .jpg for unknown image type", () => {
    assert.strictEqual(imageExtensionForMime("image/tiff"), ".jpg");
  });
});

describe("resolveBinding with topics array", () => {
  const bindingsWithTopics: TelegramBinding[] = [
    {
      chatId: -100999,
      agentId: "main",
      kind: "group",
      label: "HQ",
      requireMention: true,
      topics: [
        { topicId: 10, agentId: "finance", requireMention: false },
        { topicId: 20, requireMention: false },
        { topicId: 30, agentId: "ops" },
      ],
    },
  ];

  it("returns topic-overridden agentId when topic matches", () => {
    const binding = resolveBinding(-100999, bindingsWithTopics, 10);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "finance");
    assert.strictEqual(binding.requireMention, false);
    assert.strictEqual(binding.topicId, 10);
  });

  it("inherits group agentId when topic has no agentId override", () => {
    const binding = resolveBinding(-100999, bindingsWithTopics, 20);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    assert.strictEqual(binding.requireMention, false);
  });

  it("inherits group requireMention when topic has no requireMention override", () => {
    const binding = resolveBinding(-100999, bindingsWithTopics, 30);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "ops");
    assert.strictEqual(binding.requireMention, true);
  });

  it("falls back to group defaults for unlisted topic but preserves topicId", () => {
    const binding = resolveBinding(-100999, bindingsWithTopics, 999);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    assert.strictEqual(binding.requireMention, true);
    assert.strictEqual(binding.topicId, 999);
  });

  it("falls back to group defaults when no topicId provided", () => {
    const binding = resolveBinding(-100999, bindingsWithTopics);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
  });

  it("preserves label from base binding in topic override", () => {
    const binding = resolveBinding(-100999, bindingsWithTopics, 10);
    assert.ok(binding);
    assert.strictEqual(binding.label, "HQ");
  });
});

describe("shouldRespondInGroup", () => {
  const groupBinding: TelegramBinding = { chatId: -100, agentId: "main", kind: "group" };
  const groupRequireMention: TelegramBinding = { chatId: -100, agentId: "main", kind: "group", requireMention: true };
  const groupNoMention: TelegramBinding = { chatId: -100, agentId: "main", kind: "group", requireMention: false };
  const dmBinding: TelegramBinding = { chatId: 123, agentId: "main", kind: "dm" };
  const botId = 999;
  const botUsername = "testbot";

  it("always returns true for DM bindings", () => {
    assert.strictEqual(shouldRespondInGroup(dmBinding, botId, botUsername, {}), true);
  });

  it("returns true for group with requireMention: false", () => {
    assert.strictEqual(shouldRespondInGroup(groupNoMention, botId, botUsername, {}), true);
  });

  it("returns false for group with no requireMention set and no sessionDefaults (default true)", () => {
    const msg = { text: "hello everyone" };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns false for group with requireMention: true and no reply/mention", () => {
    const msg = { text: "hello everyone" };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("falls back to sessionDefaults.requireMention when binding has none", () => {
    const msg = { text: "hello everyone" };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg, { requireMention: true }), false);
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg, { requireMention: false }), true);
  });

  it("binding requireMention overrides sessionDefaults", () => {
    const msg = { text: "hello everyone" };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg, { requireMention: false }), false);
    assert.strictEqual(shouldRespondInGroup(groupNoMention, botId, botUsername, msg, { requireMention: true }), true);
  });

  it("returns true when message is reply to bot", () => {
    const msg = { reply_to_message: { from: { id: botId } } };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), true);
  });

  it("returns true when bot is @mentioned in text", () => {
    const msg = {
      text: "hey @testbot help me",
      entities: [{ type: "mention", offset: 4, length: 8 }],
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), true);
  });

  it("returns true when bot is @mentioned in caption", () => {
    const msg = {
      caption: "@testbot check this",
      caption_entities: [{ type: "mention", offset: 0, length: 8 }],
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), true);
  });

  it("returns false for reply to a different user", () => {
    const msg = { reply_to_message: { from: { id: 888 } } };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("returns false when a different bot is mentioned", () => {
    const msg = {
      text: "hey @otherbot help me",
      entities: [{ type: "mention", offset: 4, length: 9 }],
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("returns true when bot is @mentioned in text without entities", () => {
    const msg = { text: "hey @testbot help me" };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), true);
  });

  it("returns false for substring username match without entities", () => {
    const msg = { text: "hey @testbot2 help me" };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("returns false for email-like substring match without entities", () => {
    const msg = { text: "send to user@testbot.com" };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("returns true when @mention is at end of text without entities", () => {
    const msg = { text: "hey @testbot" };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), true);
  });

  it("returns true for group with explicit requireMention: true and reply to bot", () => {
    const explicit: TelegramBinding = { ...groupBinding, requireMention: true };
    const msg = { reply_to_message: { from: { id: botId } } };
    assert.strictEqual(shouldRespondInGroup(explicit, botId, botUsername, msg), true);
  });

  it("returns false when reply_to_message is a forum topic creation service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, forum_topic_created: { name: "Topic", icon_color: 0 } },
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("returns false when reply_to_message is a forum_topic_edited service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, forum_topic_edited: { name: "New Name" } },
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("returns false when reply_to_message is a forum_topic_closed service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, forum_topic_closed: {} },
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("returns false when reply_to_message is a forum_topic_reopened service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, forum_topic_reopened: {} },
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("returns true when replying to a real bot message in a forum topic (no service fields)", () => {
    const msg = {
      text: "thanks bot",
      reply_to_message: { from: { id: botId } },
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), true);
  });

  it("returns true when requireMention is false, even for forum service messages (early exit)", () => {
    // When requireMention is false, shouldRespondInGroup returns true before reaching the service message check
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, forum_topic_created: { name: "Topic", icon_color: 0 } },
    };
    assert.strictEqual(shouldRespondInGroup(groupNoMention, botId, botUsername, msg), true);
  });

  it("returns false for general_forum_topic_hidden service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, general_forum_topic_hidden: {} },
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });

  it("returns false for general_forum_topic_unhidden service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, general_forum_topic_unhidden: {} },
    };
    assert.strictEqual(shouldRespondInGroup(groupRequireMention, botId, botUsername, msg), false);
  });
});

describe("voiceTranscriptEcho config", () => {
  it("is preserved through resolveBinding", () => {
    const bindings: TelegramBinding[] = [
      { chatId: 100, agentId: "main", kind: "dm", voiceTranscriptEcho: false },
    ];
    const binding = resolveBinding(100, bindings);
    assert.ok(binding);
    assert.strictEqual(binding.voiceTranscriptEcho, false);
  });

  it("is preserved through resolveBinding with topic override", () => {
    const bindings: TelegramBinding[] = [
      {
        chatId: -200,
        agentId: "main",
        kind: "group",
        voiceTranscriptEcho: false,
        topics: [{ topicId: 10, agentId: "finance" }],
      },
    ];
    const binding = resolveBinding(-200, bindings, 10);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "finance");
    assert.strictEqual(binding.voiceTranscriptEcho, false);
  });
});

describe("isStaleMessage", () => {
  it("returns true for messages older than threshold", () => {
    const sixMinAgoMs = Date.now() - 6 * 60 * 1000;
    assert.strictEqual(isStaleMessage(sixMinAgoMs, 300000), true);
  });

  it("returns false for recent messages", () => {
    const tenSecAgoMs = Date.now() - 10000;
    assert.strictEqual(isStaleMessage(tenSecAgoMs, 300000), false);
  });

  it("returns true for messages just past threshold", () => {
    const justPastMs = Date.now() - 300001;
    assert.strictEqual(isStaleMessage(justPastMs, 300000), true);
  });

  it("returns false for messages at exact threshold boundary", () => {
    // At exactly maxAge, not stale (> not >=). Use small buffer to avoid
    // flakiness from wall-clock drift between the two Date.now() calls.
    const nearExactMs = Date.now() - 299990;
    assert.strictEqual(isStaleMessage(nearExactMs, 300000), false);
  });

  it("returns true for very old messages (hours)", () => {
    const threeHoursAgoMs = Date.now() - 3 * 60 * 60 * 1000;
    assert.strictEqual(isStaleMessage(threeHoursAgoMs, 300000), true);
  });

  it("returns false for messages in the future (clock skew)", () => {
    const futureMs = Date.now() + 10000;
    assert.strictEqual(isStaleMessage(futureMs, 300000), false);
  });

  it("works with Telegram-style timestamps (seconds converted to ms)", () => {
    const fiveMinAgoSec = Math.floor(Date.now() / 1000) - 301;
    assert.strictEqual(isStaleMessage(fiveMinAgoSec * 1000, 300000), true);
  });

  it("works with Discord-style timestamps (already ms)", () => {
    const fourMinAgoMs = Date.now() - 4 * 60 * 1000;
    assert.strictEqual(isStaleMessage(fourMinAgoMs, 300000), false);
  });
});

describe("buildReplyContext", () => {
  it("returns empty string when replyTo is undefined", () => {
    assert.strictEqual(buildReplyContext(undefined), "");
  });

  it("returns empty string for forum service messages", () => {
    assert.strictEqual(
      buildReplyContext({ forum_topic_created: { name: "Test", icon_color: 0 } }),
      "",
    );
  });

  it("returns empty string for forum_topic_edited service message", () => {
    assert.strictEqual(
      buildReplyContext({ forum_topic_edited: { name: "New" } }),
      "",
    );
  });

  it("returns empty string for forum_topic_closed service message", () => {
    assert.strictEqual(buildReplyContext({ forum_topic_closed: {} }), "");
  });

  it("returns empty string for forum_topic_reopened service message", () => {
    assert.strictEqual(buildReplyContext({ forum_topic_reopened: {} }), "");
  });

  it("returns empty string for general_forum_topic_hidden service message", () => {
    assert.strictEqual(buildReplyContext({ general_forum_topic_hidden: {} }), "");
  });

  it("returns empty string for general_forum_topic_unhidden service message", () => {
    assert.strictEqual(buildReplyContext({ general_forum_topic_unhidden: {} }), "");
  });

  it("includes sender name and username", () => {
    const result = buildReplyContext({
      from: { first_name: "Alice", username: "alice42" },
      text: "Hello world",
    });
    assert.strictEqual(result, "[Reply to Alice (@alice42)]\n> Hello world\n");
  });

  it("includes sender name without username", () => {
    const result = buildReplyContext({
      from: { first_name: "Bob" },
      text: "Hi there",
    });
    assert.strictEqual(result, "[Reply to Bob]\n> Hi there\n");
  });

  it("uses caption when text is absent", () => {
    const result = buildReplyContext({
      from: { first_name: "Eve" },
      caption: "Check this photo",
    });
    assert.strictEqual(result, "[Reply to Eve]\n> Check this photo\n");
  });

  it("shows [Reply] header when from is undefined", () => {
    const result = buildReplyContext({ text: "Some text" });
    assert.strictEqual(result, "[Reply]\n> Some text\n");
  });

  it("shows header only when no text or caption", () => {
    const result = buildReplyContext({ from: { first_name: "Dave" } });
    assert.strictEqual(result, "[Reply to Dave]\n");
  });

  it("truncates long reply text at 200 chars", () => {
    const longText = "A".repeat(250);
    const result = buildReplyContext({
      from: { first_name: "Zoe" },
      text: longText,
    });
    assert.strictEqual(result, `[Reply to Zoe]\n> ${"A".repeat(200)}...\n`);
  });

  it("does not truncate text at exactly 200 chars", () => {
    const exactText = "B".repeat(200);
    const result = buildReplyContext({
      from: { first_name: "Max" },
      text: exactText,
    });
    assert.strictEqual(result, `[Reply to Max]\n> ${"B".repeat(200)}\n`);
  });

  it("collapses newlines in reply text to spaces", () => {
    const result = buildReplyContext({
      from: { first_name: "Pat" },
      text: "line one\nline two\nline three",
    });
    assert.strictEqual(result, "[Reply to Pat]\n> line one line two line three\n");
  });

  it("uses quote text instead of full message when quote is provided", () => {
    const result = buildReplyContext(
      {
        from: { first_name: "Alice", username: "alice42" },
        text: "This is a very long message that the user did not select",
      },
      { text: "selected part" },
    );
    assert.strictEqual(result, "[Reply to Alice (@alice42), quoting]\n> selected part\n");
  });

  it("shows quoting in header without sender when quote is provided", () => {
    const result = buildReplyContext(
      { text: "Full message here" },
      { text: "just this bit" },
    );
    assert.strictEqual(result, "[Reply, quoting]\n> just this bit\n");
  });

  it("truncates quote text at 200 chars", () => {
    const longQuote = "Q".repeat(250);
    const result = buildReplyContext(
      { from: { first_name: "Zoe" }, text: "original" },
      { text: longQuote },
    );
    assert.strictEqual(result, `[Reply to Zoe, quoting]\n> ${"Q".repeat(200)}...\n`);
  });

  it("does not truncate quote text at exactly 200 chars", () => {
    const exactQuote = "R".repeat(200);
    const result = buildReplyContext(
      { from: { first_name: "Max" }, text: "original" },
      { text: exactQuote },
    );
    assert.strictEqual(result, `[Reply to Max, quoting]\n> ${"R".repeat(200)}\n`);
  });

  it("falls back to full text when quote is undefined", () => {
    const result = buildReplyContext(
      { from: { first_name: "Bob" }, text: "full message" },
      undefined,
    );
    assert.strictEqual(result, "[Reply to Bob]\n> full message\n");
  });

  it("falls back to full text when quote has empty text", () => {
    const result = buildReplyContext(
      { from: { first_name: "Eve" }, text: "original text" },
      { text: "" },
    );
    assert.strictEqual(result, "[Reply to Eve]\n> original text\n");
  });

  it("collapses newlines in quote text", () => {
    const result = buildReplyContext(
      { from: { first_name: "Dan" }, text: "full msg" },
      { text: "line one\nline two" },
    );
    assert.strictEqual(result, "[Reply to Dan, quoting]\n> line one line two\n");
  });
});

describe("buildForwardContext", () => {
  it("returns empty string when forwardOrigin is undefined", () => {
    assert.strictEqual(buildForwardContext(undefined), "");
  });

  it("formats user forward with username", () => {
    const result = buildForwardContext({
      type: "user",
      sender_user: { first_name: "John", username: "john_doe" },
    });
    assert.strictEqual(result, "[Forwarded from John (@john_doe)]\n");
  });

  it("formats user forward without username", () => {
    const result = buildForwardContext({
      type: "user",
      sender_user: { first_name: "Jane" },
    });
    assert.strictEqual(result, "[Forwarded from Jane]\n");
  });

  it("formats hidden_user forward", () => {
    const result = buildForwardContext({
      type: "hidden_user",
      sender_user_name: "Secret Person",
    });
    assert.strictEqual(result, "[Forwarded from Secret Person]\n");
  });

  it("formats hidden_user with missing name", () => {
    const result = buildForwardContext({ type: "hidden_user" });
    assert.strictEqual(result, "[Forwarded from Unknown]\n");
  });

  it("formats chat forward", () => {
    const result = buildForwardContext({
      type: "chat",
      sender_chat: { title: "Dev Group" },
    });
    assert.strictEqual(result, "[Forwarded from Dev Group]\n");
  });

  it("formats channel forward with author signature", () => {
    const result = buildForwardContext({
      type: "channel",
      chat: { title: "News Channel" },
      author_signature: "Editor",
    });
    assert.strictEqual(result, "[Forwarded from News Channel (Editor)]\n");
  });

  it("formats channel forward without author signature", () => {
    const result = buildForwardContext({
      type: "channel",
      chat: { title: "Updates" },
    });
    assert.strictEqual(result, "[Forwarded from Updates]\n");
  });

  it("formats user forward with missing sender_user", () => {
    const result = buildForwardContext({ type: "user" });
    assert.strictEqual(result, "[Forwarded from Unknown]\n");
  });

  it("formats chat forward with missing sender_chat", () => {
    const result = buildForwardContext({ type: "chat" });
    assert.strictEqual(result, "[Forwarded from Unknown chat]\n");
  });

  it("formats channel forward with missing chat", () => {
    const result = buildForwardContext({ type: "channel" });
    assert.strictEqual(result, "[Forwarded from Unknown channel]\n");
  });

  it("handles unknown forward type", () => {
    const result = buildForwardContext({ type: "something_new" });
    assert.strictEqual(result, "[Forwarded from Unknown]\n");
  });
});

describe("extensionForDocument", () => {
  it("extracts extension from filename", () => {
    assert.strictEqual(extensionForDocument("report.pdf", "application/pdf"), ".pdf");
  });

  it("extracts extension from filename with multiple dots", () => {
    assert.strictEqual(extensionForDocument("my.data.csv", "text/csv"), ".csv");
  });

  it("falls back to MIME type when no filename", () => {
    assert.strictEqual(extensionForDocument(undefined, "application/pdf"), ".pdf");
  });

  it("falls back to MIME type when filename has no extension", () => {
    assert.strictEqual(extensionForDocument("Makefile", "text/plain"), ".txt");
  });

  it("returns .bin for unknown MIME type and no filename", () => {
    assert.strictEqual(extensionForDocument(undefined, "application/octet-stream"), ".bin");
  });

  it("returns .bin when both are undefined", () => {
    assert.strictEqual(extensionForDocument(undefined, undefined), ".bin");
  });

  it("maps text/csv to .csv", () => {
    assert.strictEqual(extensionForDocument(undefined, "text/csv"), ".csv");
  });

  it("maps application/json to .json", () => {
    assert.strictEqual(extensionForDocument(undefined, "application/json"), ".json");
  });

  it("maps application/xml to .xml", () => {
    assert.strictEqual(extensionForDocument(undefined, "application/xml"), ".xml");
  });

  it("maps text/xml to .xml", () => {
    assert.strictEqual(extensionForDocument(undefined, "text/xml"), ".xml");
  });

  it("maps text/html to .html", () => {
    assert.strictEqual(extensionForDocument(undefined, "text/html"), ".html");
  });

  it("maps application/zip to .zip", () => {
    assert.strictEqual(extensionForDocument(undefined, "application/zip"), ".zip");
  });

  it("maps application/gzip to .gz", () => {
    assert.strictEqual(extensionForDocument(undefined, "application/gzip"), ".gz");
  });

  it("prefers filename extension over MIME type", () => {
    assert.strictEqual(extensionForDocument("data.tsv", "text/plain"), ".tsv");
  });

  it("sanitizes path separators from filename extension", () => {
    assert.strictEqual(extensionForDocument("evil.../../etc/passwd", "text/plain"), ".etcpasswd");
  });

  it("sanitizes special characters from filename extension", () => {
    assert.strictEqual(extensionForDocument("file.tx t", "text/plain"), ".txt");
  });
});

describe("formatFileSize", () => {
  it("formats bytes", () => {
    assert.strictEqual(formatFileSize(512), "512 B");
  });

  it("formats kilobytes", () => {
    assert.strictEqual(formatFileSize(1536), "1.5 KB");
  });

  it("formats megabytes", () => {
    assert.strictEqual(formatFileSize(2.5 * 1024 * 1024), "2.5 MB");
  });

  it("formats zero bytes", () => {
    assert.strictEqual(formatFileSize(0), "0 B");
  });

  it("formats exactly 1 KB", () => {
    assert.strictEqual(formatFileSize(1024), "1.0 KB");
  });

  it("formats exactly 1 MB", () => {
    assert.strictEqual(formatFileSize(1024 * 1024), "1.0 MB");
  });
});

describe("formatDocumentMeta", () => {
  it("formats full metadata", () => {
    assert.strictEqual(
      formatDocumentMeta("report.pdf", "application/pdf", 1536),
      "[Document: report.pdf | Type: application/pdf | Size: 1.5 KB]",
    );
  });

  it("handles missing filename", () => {
    assert.strictEqual(
      formatDocumentMeta(undefined, "text/plain", 100),
      "[Document: unknown | Type: text/plain | Size: 100 B]",
    );
  });

  it("handles missing MIME type", () => {
    assert.strictEqual(
      formatDocumentMeta("data.bin", undefined, 2048),
      "[Document: data.bin | Size: 2.0 KB]",
    );
  });

  it("handles missing file size", () => {
    assert.strictEqual(
      formatDocumentMeta("notes.txt", "text/plain", undefined),
      "[Document: notes.txt | Type: text/plain]",
    );
  });

  it("handles all undefined", () => {
    assert.strictEqual(
      formatDocumentMeta(undefined, undefined, undefined),
      "[Document: unknown]",
    );
  });
});

describe("buildReactionContext", () => {
  it("formats a single added emoji", () => {
    assert.strictEqual(
      buildReactionContext(123, ["👍"], []),
      "[Reaction: 👍 on message 123]",
    );
  });

  it("formats a single removed emoji", () => {
    assert.strictEqual(
      buildReactionContext(456, [], ["👎"]),
      "[Reaction removed: 👎 on message 456]",
    );
  });

  it("formats multiple added emojis", () => {
    assert.strictEqual(
      buildReactionContext(789, ["👍", "❤️"], []),
      "[Reaction: 👍 on message 789]\n[Reaction: ❤️ on message 789]",
    );
  });

  it("formats both added and removed emojis", () => {
    assert.strictEqual(
      buildReactionContext(100, ["👍"], ["👎"]),
      "[Reaction: 👍 on message 100]\n[Reaction removed: 👎 on message 100]",
    );
  });

  it("returns empty string when no emojis", () => {
    assert.strictEqual(buildReactionContext(100, [], []), "");
  });

  it("handles large message IDs", () => {
    assert.strictEqual(
      buildReactionContext(9999999, ["🔥"], []),
      "[Reaction: 🔥 on message 9999999]",
    );
  });

  it("includes author and preview when content record is provided (cache hit)", () => {
    const content = { from: "@alice", preview: "Hello world", direction: "in" as const, timestamp: 1000 };
    assert.strictEqual(
      buildReactionContext(123, ["👍"], [], content),
      '[Reaction: 👍 on message by @alice: "Hello world"]',
    );
  });

  it("includes content for removed emoji with cache hit", () => {
    const content = { from: "@bot", preview: "Some response", direction: "out" as const, timestamp: 2000 };
    assert.strictEqual(
      buildReactionContext(456, [], ["👎"], content),
      '[Reaction removed: 👎 on message by @bot: "Some response"]',
    );
  });

  it("formats multiple emojis with content record", () => {
    const content = { from: "@alice", preview: "Test message", direction: "in" as const, timestamp: 1000 };
    assert.strictEqual(
      buildReactionContext(100, ["👍", "❤️"], [], content),
      '[Reaction: 👍 on message by @alice: "Test message"]\n[Reaction: ❤️ on message by @alice: "Test message"]',
    );
  });

  it("falls back to message ID when content is undefined (cache miss)", () => {
    assert.strictEqual(
      buildReactionContext(123, ["👍"], [], undefined),
      "[Reaction: 👍 on message 123]",
    );
  });
});

describe("AUTO_RETRY_OPTIONS", () => {
  it("has rethrowHttpErrors set to false so network errors retry infinitely", () => {
    assert.strictEqual(AUTO_RETRY_OPTIONS.rethrowHttpErrors, false);
  });

  it("has maxRetryAttempts and maxDelaySeconds configured", () => {
    assert.strictEqual(AUTO_RETRY_OPTIONS.maxRetryAttempts, 5);
    assert.strictEqual(AUTO_RETRY_OPTIONS.maxDelaySeconds, 60);
  });
});

describe("extractMediaInfo", () => {
  it("extracts video info", () => {
    const msg = { video: { file_id: "vid1", file_name: "clip.mp4", mime_type: "video/mp4", file_size: 5000 } };
    const result = extractMediaInfo(msg);
    assert.strictEqual(result.mediaType, "video");
    assert.strictEqual(result.typeLabel, "Video");
    assert.strictEqual(result.media.file_id, "vid1");
    assert.strictEqual(result.media.file_name, "clip.mp4");
  });

  it("extracts animation info", () => {
    const msg = { animation: { file_id: "anim1", file_name: "funny.gif", mime_type: "video/mp4", file_size: 2000 } };
    const result = extractMediaInfo(msg);
    assert.strictEqual(result.mediaType, "animation");
    assert.strictEqual(result.typeLabel, "Animation");
    assert.strictEqual(result.media.file_id, "anim1");
  });

  it("extracts video_note info", () => {
    const msg = { video_note: { file_id: "vn1", file_size: 1500 } };
    const result = extractMediaInfo(msg);
    assert.strictEqual(result.mediaType, "video_note");
    assert.strictEqual(result.typeLabel, "Video Note");
    assert.strictEqual(result.media.file_id, "vn1");
    assert.strictEqual(result.media.file_name, undefined);
  });

  it("extracts audio info", () => {
    const msg = { audio: { file_id: "aud1", file_name: "song.mp3", mime_type: "audio/mpeg", file_size: 3000 } };
    const result = extractMediaInfo(msg);
    assert.strictEqual(result.mediaType, "audio");
    assert.strictEqual(result.typeLabel, "Audio");
    assert.strictEqual(result.media.file_id, "aud1");
  });

  it("extracts sticker info", () => {
    const msg = { sticker: { file_id: "stk1", file_size: 45000, is_animated: false, is_video: false } };
    const result = extractMediaInfo(msg);
    assert.strictEqual(result.mediaType, "sticker");
    assert.strictEqual(result.typeLabel, "Sticker");
    assert.strictEqual(result.media.file_id, "stk1");
  });

  it("prefers video over other types when multiple present", () => {
    const msg = {
      video: { file_id: "vid1", mime_type: "video/mp4" },
      audio: { file_id: "aud1", mime_type: "audio/mpeg" },
    };
    const result = extractMediaInfo(msg);
    assert.strictEqual(result.mediaType, "video");
  });

  it("throws when no supported media type found", () => {
    assert.throws(() => extractMediaInfo({}), /No supported media type found/);
  });
});

describe("extensionForMedia", () => {
  it("returns .mp4 for video", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x" }, "video"), ".mp4");
  });

  it("returns .mp4 for animation", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x" }, "animation"), ".mp4");
  });

  it("returns .mp4 for video_note", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x" }, "video_note"), ".mp4");
  });

  it("returns .mp3 for audio with audio/mpeg", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", mime_type: "audio/mpeg" }, "audio"), ".mp3");
  });

  it("returns .m4a for audio with audio/mp4", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", mime_type: "audio/mp4" }, "audio"), ".m4a");
  });

  it("returns .m4a for audio with audio/x-m4a", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", mime_type: "audio/x-m4a" }, "audio"), ".m4a");
  });

  it("returns .ogg for audio with audio/ogg", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", mime_type: "audio/ogg" }, "audio"), ".ogg");
  });

  it("returns .flac for audio with audio/flac", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", mime_type: "audio/flac" }, "audio"), ".flac");
  });

  it("returns .wav for audio with audio/wav", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", mime_type: "audio/wav" }, "audio"), ".wav");
  });

  it("returns .wav for audio with audio/x-wav", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", mime_type: "audio/x-wav" }, "audio"), ".wav");
  });

  it("returns .mp3 for audio with unknown MIME", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", mime_type: "audio/aac" }, "audio"), ".mp3");
  });

  it("returns .webp for static sticker", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", is_animated: false, is_video: false }, "sticker"), ".webp");
  });

  it("returns .tgs for animated sticker", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", is_animated: true, is_video: false }, "sticker"), ".tgs");
  });

  it("returns .webm for video sticker", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", is_animated: false, is_video: true }, "sticker"), ".webm");
  });

  it("prefers filename extension over default", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", file_name: "clip.mov" }, "video"), ".mov");
  });

  it("falls back to default when filename has no extension", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", file_name: "Untitled" }, "video"), ".mp4");
  });

  it("sanitizes path separators from filename extension", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x", file_name: "evil.../../etc/passwd" }, "video"), ".etcpasswd");
  });

  it("returns .bin for unknown media type", () => {
    assert.strictEqual(extensionForMedia({ file_id: "x" }, "unknown"), ".bin");
  });
});

describe("formatMediaMeta", () => {
  it("formats full metadata with filename", () => {
    assert.strictEqual(
      formatMediaMeta("Video", "clip.mp4", "video/mp4", 5 * 1024 * 1024),
      "[Video: clip.mp4 | Type: video/mp4 | Size: 5.0 MB]",
    );
  });

  it("formats without filename", () => {
    assert.strictEqual(
      formatMediaMeta("Video Note", undefined, undefined, 1500),
      "[Video Note | Size: 1.5 KB]",
    );
  });

  it("formats sticker without MIME or size", () => {
    assert.strictEqual(
      formatMediaMeta("Sticker", undefined, undefined, undefined),
      "[Sticker]",
    );
  });

  it("formats audio with all fields", () => {
    assert.strictEqual(
      formatMediaMeta("Audio", "song.mp3", "audio/mpeg", 3072),
      "[Audio: song.mp3 | Type: audio/mpeg | Size: 3.0 KB]",
    );
  });

  it("formats animation without size", () => {
    assert.strictEqual(
      formatMediaMeta("Animation", "funny.gif", "video/mp4", undefined),
      "[Animation: funny.gif | Type: video/mp4]",
    );
  });

  it("formats with filename but no MIME", () => {
    assert.strictEqual(
      formatMediaMeta("Video", "clip.mp4", undefined, 2048),
      "[Video: clip.mp4 | Size: 2.0 KB]",
    );
  });
});
