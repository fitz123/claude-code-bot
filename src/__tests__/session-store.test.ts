import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../session-store.js";

const TEST_DIR = "/tmp/openclaw-test-store";
const TEST_PATH = `${TEST_DIR}/sessions.json`;

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

describe("SessionStore", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("creates empty store when file does not exist", () => {
    const store = new SessionStore(TEST_PATH);
    assert.strictEqual(store.size, 0);
    assert.deepStrictEqual(store.getAllSessions(), {});
  });

  it("sets and gets a session", () => {
    const store = new SessionStore(TEST_PATH);
    const state = {
      sessionId: "uuid-1",
      chatId: "123",
      agentId: "main",
      lastActivity: Date.now(),
    };
    store.setSession("123", state);

    const retrieved = store.getSession("123");
    assert.deepStrictEqual(retrieved, state);
    assert.strictEqual(store.size, 1);
  });

  it("persists to disk on set", () => {
    const store = new SessionStore(TEST_PATH);
    store.setSession("123", {
      sessionId: "uuid-1",
      chatId: "123",
      agentId: "main",
      lastActivity: 1000,
    });

    assert.ok(existsSync(TEST_PATH));
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf8"));
    assert.strictEqual(raw["123"].sessionId, "uuid-1");
  });

  it("loads from existing file", () => {
    // Write a file first
    const store1 = new SessionStore(TEST_PATH);
    store1.setSession("456", {
      sessionId: "uuid-2",
      chatId: "456",
      agentId: "yulia",
      lastActivity: 2000,
    });

    // Load from same path
    const store2 = new SessionStore(TEST_PATH);
    const session = store2.getSession("456");
    assert.ok(session);
    assert.strictEqual(session!.sessionId, "uuid-2");
    assert.strictEqual(session!.agentId, "yulia");
  });

  it("deletes a session", () => {
    const store = new SessionStore(TEST_PATH);
    store.setSession("123", {
      sessionId: "uuid-1",
      chatId: "123",
      agentId: "main",
      lastActivity: 1000,
    });
    assert.strictEqual(store.size, 1);

    store.deleteSession("123");
    assert.strictEqual(store.size, 0);
    assert.strictEqual(store.getSession("123"), undefined);

    // Verify persisted
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf8"));
    assert.strictEqual(raw["123"], undefined);
  });

  it("getAllSessions returns a copy", () => {
    const store = new SessionStore(TEST_PATH);
    store.setSession("a", {
      sessionId: "u1",
      chatId: "a",
      agentId: "main",
      lastActivity: 1,
    });
    store.setSession("b", {
      sessionId: "u2",
      chatId: "b",
      agentId: "yulia",
      lastActivity: 2,
    });

    const all = store.getAllSessions();
    assert.strictEqual(Object.keys(all).length, 2);

    // Modifying returned object should not affect store
    delete all["a"];
    assert.ok(store.getSession("a"));
  });

  it("handles corrupted JSON gracefully", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_PATH, "not valid json{{{");

    const store = new SessionStore(TEST_PATH);
    assert.strictEqual(store.size, 0);
  });

  it("atomic write: .tmp file is cleaned up", () => {
    const store = new SessionStore(TEST_PATH);
    store.setSession("123", {
      sessionId: "uuid-1",
      chatId: "123",
      agentId: "main",
      lastActivity: 1000,
    });

    // .tmp should not exist after save
    assert.ok(!existsSync(TEST_PATH + ".tmp"));
    // But the main file should
    assert.ok(existsSync(TEST_PATH));
  });

  it("creates parent directories if they don't exist", () => {
    const deepPath = `${TEST_DIR}/deep/nested/sessions.json`;
    const store = new SessionStore(deepPath);
    store.setSession("123", {
      sessionId: "uuid-1",
      chatId: "123",
      agentId: "main",
      lastActivity: 1000,
    });

    assert.ok(existsSync(deepPath));
  });

  it("default path resolves relative to project dir (not hardcoded)", () => {
    // Create a store with no explicit path — it should use the project-relative default
    const store = new SessionStore();
    // Write a session so the file gets created
    store.setSession("path-test", {
      sessionId: "uuid-path",
      chatId: "path-test",
      agentId: "main",
      lastActivity: 1000,
    });
    // The project root is two levels up from src/__tests__
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const expectedPath = resolve(projectRoot, "data", "sessions.json");
    assert.ok(existsSync(expectedPath), `Default store should write to ${expectedPath}`);
    // Clean up the test session
    store.deleteSession("path-test");
  });
});
