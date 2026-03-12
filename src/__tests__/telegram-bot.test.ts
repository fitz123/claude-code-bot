import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBinding, isAuthorized, sessionKey, isImageMimeType, imageExtensionForMime, BOT_COMMANDS } from "../telegram-bot.js";
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
