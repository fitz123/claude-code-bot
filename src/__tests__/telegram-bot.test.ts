import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBinding, isAuthorized } from "../telegram-bot.js";
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
