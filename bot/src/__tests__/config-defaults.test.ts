import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSessionDefaults } from "../config.js";

describe("validateSessionDefaults", () => {
  it("returns production defaults when input is null", () => {
    const defaults = validateSessionDefaults(null);
    assert.strictEqual(defaults.idleTimeoutMs, 3600000);
    assert.strictEqual(defaults.maxConcurrentSessions, 12);
    assert.strictEqual(defaults.maxMessageAgeMs, 600000);
    assert.strictEqual(defaults.streamingUpdates, false);
    assert.strictEqual(defaults.requireMention, false);
  });

  it("returns production defaults when input is undefined", () => {
    const defaults = validateSessionDefaults(undefined);
    assert.strictEqual(defaults.idleTimeoutMs, 3600000);
    assert.strictEqual(defaults.maxConcurrentSessions, 12);
    assert.strictEqual(defaults.maxMessageAgeMs, 600000);
    assert.strictEqual(defaults.streamingUpdates, false);
    assert.strictEqual(defaults.requireMention, false);
  });

  it("returns production defaults when input is empty object", () => {
    const defaults = validateSessionDefaults({});
    assert.strictEqual(defaults.idleTimeoutMs, 3600000);
    assert.strictEqual(defaults.maxConcurrentSessions, 12);
    assert.strictEqual(defaults.maxMessageAgeMs, 600000);
    assert.strictEqual(defaults.streamingUpdates, false);
    assert.strictEqual(defaults.requireMention, false);
  });

  it("allows overriding individual fields", () => {
    const defaults = validateSessionDefaults({ idleTimeoutMs: 1000 });
    assert.strictEqual(defaults.idleTimeoutMs, 1000);
    assert.strictEqual(defaults.maxConcurrentSessions, 12);
    assert.strictEqual(defaults.maxMessageAgeMs, 600000);
  });

  it("allows overriding all fields", () => {
    const defaults = validateSessionDefaults({
      idleTimeoutMs: 5000,
      maxConcurrentSessions: 5,
      maxMessageAgeMs: 10000,
      streamingUpdates: true,
      requireMention: true,
    });
    assert.strictEqual(defaults.idleTimeoutMs, 5000);
    assert.strictEqual(defaults.maxConcurrentSessions, 5);
    assert.strictEqual(defaults.maxMessageAgeMs, 10000);
    assert.strictEqual(defaults.streamingUpdates, true);
    assert.strictEqual(defaults.requireMention, true);
  });

  it("throws on invalid maxMessageAgeMs", () => {
    assert.throws(
      () => validateSessionDefaults({ maxMessageAgeMs: -1 }),
      /Invalid maxMessageAgeMs/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxMessageAgeMs: 0 }),
      /Invalid maxMessageAgeMs/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxMessageAgeMs: Infinity }),
      /Invalid maxMessageAgeMs/,
    );
  });

  it("throws on invalid idleTimeoutMs", () => {
    assert.throws(
      () => validateSessionDefaults({ idleTimeoutMs: -1 }),
      /Invalid idleTimeoutMs/,
    );
    assert.throws(
      () => validateSessionDefaults({ idleTimeoutMs: 0 }),
      /Invalid idleTimeoutMs/,
    );
    assert.throws(
      () => validateSessionDefaults({ idleTimeoutMs: Infinity }),
      /Invalid idleTimeoutMs/,
    );
  });

  it("throws on invalid maxConcurrentSessions", () => {
    assert.throws(
      () => validateSessionDefaults({ maxConcurrentSessions: 0 }),
      /Invalid maxConcurrentSessions/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxConcurrentSessions: -1 }),
      /Invalid maxConcurrentSessions/,
    );
    assert.throws(
      () => validateSessionDefaults({ maxConcurrentSessions: 0.5 }),
      /Invalid maxConcurrentSessions/,
    );
  });

  it("ignores non-numeric types and uses defaults", () => {
    const defaults = validateSessionDefaults({ idleTimeoutMs: "not a number" });
    assert.strictEqual(defaults.idleTimeoutMs, 3600000);
  });

  it("parses streamingUpdates boolean", () => {
    const on = validateSessionDefaults({ streamingUpdates: true });
    assert.strictEqual(on.streamingUpdates, true);
    const off = validateSessionDefaults({ streamingUpdates: false });
    assert.strictEqual(off.streamingUpdates, false);
  });

  it("parses requireMention boolean", () => {
    const on = validateSessionDefaults({ requireMention: true });
    assert.strictEqual(on.requireMention, true);
    const off = validateSessionDefaults({ requireMention: false });
    assert.strictEqual(off.requireMention, false);
  });

  it("ignores non-boolean streamingUpdates and requireMention", () => {
    const defaults = validateSessionDefaults({
      streamingUpdates: "yes",
      requireMention: 1,
    });
    assert.strictEqual(defaults.streamingUpdates, false);
    assert.strictEqual(defaults.requireMention, false);
  });
});
