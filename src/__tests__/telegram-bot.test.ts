import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBinding, isAuthorized, sessionKey, isImageMimeType, imageExtensionForMime, buildSourcePrefix, shouldRespondInGroup, BOT_COMMANDS, isStaleMessage, buildReplyContext, buildForwardContext } from "../telegram-bot.js";
import type { TelegramBinding } from "../types.js";

const testBindings: TelegramBinding[] = [
  { chatId: <redacted-user-id>, agentId: "main", kind: "dm", label: "User DM" },
  { chatId: 1320328600, agentId: "yulia", kind: "dm", label: "Contact DM" },
  { chatId: 7418988410, agentId: "anna", kind: "dm", label: "Contact DM" },
  { chatId: -1003783997959, agentId: "cyber-architect", kind: "group", label: "Cyber Architect Group" },
];

describe("resolveBinding", () => {
  it("resolves User DM binding", () => {
    const binding = resolveBinding(<redacted-user-id>, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    assert.strictEqual(binding.kind, "dm");
  });

  it("resolves Contact DM binding", () => {
    const binding = resolveBinding(1320328600, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "yulia");
  });

  it("resolves Contact DM binding", () => {
    const binding = resolveBinding(7418988410, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "anna");
  });

  it("resolves group binding with negative chatId", () => {
    const binding = resolveBinding(-1003783997959, testBindings);
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
    assert.strictEqual(sessionKey(-1003783997959, 99), "-1003783997959:99");
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
    const binding = resolveBinding(<redacted-user-id>, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
  });
});

describe("isAuthorized", () => {
  it("authorizes known DM chat", () => {
    assert.strictEqual(isAuthorized(<redacted-user-id>, testBindings), true);
  });

  it("authorizes known group chat", () => {
    assert.strictEqual(isAuthorized(-1003783997959, testBindings), true);
  });

  it("rejects unknown chatId", () => {
    assert.strictEqual(isAuthorized(123456, testBindings), false);
  });

  it("rejects zero", () => {
    assert.strictEqual(isAuthorized(0, testBindings), false);
  });

  it("handles empty bindings", () => {
    assert.strictEqual(isAuthorized(<redacted-user-id>, []), false);
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
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "dm", label: "User DM" };
    const from = { first_name: "Alice" };
    assert.strictEqual(buildSourcePrefix(binding, from), "[Chat: User DM | From: Alice]\n");
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

  it("falls back to group defaults for unlisted topic", () => {
    const binding = resolveBinding(-100999, bindingsWithTopics, 999);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    assert.strictEqual(binding.requireMention, true);
    assert.strictEqual(binding.topicId, undefined);
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

  it("returns false for group with default requireMention and no reply/mention", () => {
    const msg = { text: "hello everyone" };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns true when message is reply to bot", () => {
    const msg = { reply_to_message: { from: { id: botId } } };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), true);
  });

  it("returns true when bot is @mentioned in text", () => {
    const msg = {
      text: "hey @testbot help me",
      entities: [{ type: "mention", offset: 4, length: 8 }],
    };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), true);
  });

  it("returns true when bot is @mentioned in caption", () => {
    const msg = {
      caption: "@testbot check this",
      caption_entities: [{ type: "mention", offset: 0, length: 8 }],
    };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), true);
  });

  it("returns false for reply to a different user", () => {
    const msg = { reply_to_message: { from: { id: 888 } } };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns false when a different bot is mentioned", () => {
    const msg = {
      text: "hey @otherbot help me",
      entities: [{ type: "mention", offset: 4, length: 9 }],
    };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns true when bot is @mentioned in text without entities", () => {
    const msg = { text: "hey @testbot help me" };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), true);
  });

  it("returns false for substring username match without entities", () => {
    const msg = { text: "hey @testbot2 help me" };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns false for email-like substring match without entities", () => {
    const msg = { text: "send to user@testbot.com" };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns true when @mention is at end of text without entities", () => {
    const msg = { text: "hey @testbot" };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), true);
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
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns false when reply_to_message is a forum_topic_edited service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, forum_topic_edited: { name: "New Name" } },
    };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns false when reply_to_message is a forum_topic_closed service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, forum_topic_closed: {} },
    };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns false when reply_to_message is a forum_topic_reopened service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, forum_topic_reopened: {} },
    };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns true when replying to a real bot message in a forum topic (no service fields)", () => {
    const msg = {
      text: "thanks bot",
      reply_to_message: { from: { id: botId } },
    };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), true);
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
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
  });

  it("returns false for general_forum_topic_unhidden service message from bot", () => {
    const msg = {
      text: "hello",
      reply_to_message: { from: { id: botId }, general_forum_topic_unhidden: {} },
    };
    assert.strictEqual(shouldRespondInGroup(groupBinding, botId, botUsername, msg), false);
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
    assert.ok(result.includes("A".repeat(200) + "..."));
    assert.ok(!result.includes("A".repeat(201)));
  });

  it("does not truncate text at exactly 200 chars", () => {
    const exactText = "B".repeat(200);
    const result = buildReplyContext({
      from: { first_name: "Max" },
      text: exactText,
    });
    assert.ok(result.includes("B".repeat(200)));
    assert.ok(!result.includes("..."));
  });

  it("collapses newlines in reply text to spaces", () => {
    const result = buildReplyContext({
      from: { first_name: "Pat" },
      text: "line one\nline two\nline three",
    });
    assert.strictEqual(result, "[Reply to Pat]\n> line one line two line three\n");
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

  it("handles unknown forward type", () => {
    const result = buildForwardContext({ type: "something_new" });
    assert.strictEqual(result, "[Forwarded from Unknown]\n");
  });
});
