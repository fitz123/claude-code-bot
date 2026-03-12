import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBinding, isAuthorized, sessionKey, isImageMimeType, imageExtensionForMime, buildSourcePrefix, shouldRespondInGroup, BOT_COMMANDS } from "../telegram-bot.js";
import type { TelegramBinding } from "../types.js";

const testBindings: TelegramBinding[] = [
  { chatId: 306600687, agentId: "main", kind: "dm", label: "Ninja DM" },
  { chatId: 1320328600, agentId: "yulia", kind: "dm", label: "Yulia DM" },
  { chatId: 7418988410, agentId: "anna", kind: "dm", label: "Anna DM" },
  { chatId: -1003783997959, agentId: "cyber-architect", kind: "group", label: "Cyber Architect Group" },
];

describe("resolveBinding", () => {
  it("resolves Ninja DM binding", () => {
    const binding = resolveBinding(306600687, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    assert.strictEqual(binding.kind, "dm");
  });

  it("resolves Yulia DM binding", () => {
    const binding = resolveBinding(1320328600, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "yulia");
  });

  it("resolves Anna DM binding", () => {
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
    const binding = resolveBinding(306600687, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
  });
});

describe("isAuthorized", () => {
  it("authorizes known DM chat", () => {
    assert.strictEqual(isAuthorized(306600687, testBindings), true);
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
    assert.strictEqual(isAuthorized(306600687, []), false);
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
    const binding: TelegramBinding = { chatId: 1, agentId: "main", kind: "dm", label: "Ninja DM" };
    const from = { first_name: "Alice" };
    assert.strictEqual(buildSourcePrefix(binding, from), "[Chat: Ninja DM | From: Alice]\n");
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
