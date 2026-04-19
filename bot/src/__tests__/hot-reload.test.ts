import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { BotConfig } from "../types.js";

const TEST_DIR = "/tmp/minime-test-hot-reload";
const TEST_STORE_PATH = `${TEST_DIR}/sessions.json`;

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

/** Captured opts from mocked spawnClaudeSession calls. */
interface CapturedSpawn {
  agent: { model: string; [key: string]: unknown };
  [key: string]: unknown;
}

const spawnCaptures: CapturedSpawn[] = [];

/** Create a mock ChildProcess that auto-emits 'spawn' on next tick. */
function createAutoSpawnChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    pid: Math.floor(Math.random() * 100000),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal?: string) {
      (child as unknown as Record<string, unknown>).killed = true;
      process.nextTick(() => {
        (child as unknown as Record<string, unknown>).exitCode =
          signal === "SIGKILL" ? 137 : 0;
        child.emit(
          "exit",
          signal === "SIGKILL" ? 137 : 0,
          signal ?? "SIGTERM",
        );
      });
      return true;
    },
  });

  // Emit 'spawn' on next tick so waitForSpawn() can attach listeners first
  process.nextTick(() => child.emit("spawn"));

  return child;
}

// ---------------------------------------------------------------------------
// Mock cli-protocol BEFORE importing session-manager so the mock is in place
// when session-manager's static import of cli-protocol resolves.
// ---------------------------------------------------------------------------
mock.module("../cli-protocol.js", {
  namedExports: {
    spawnClaudeSession(opts: CapturedSpawn) {
      spawnCaptures.push(opts);
      return createAutoSpawnChild();
    },
    sendMessage() {},
    async *readStream() {},
  },
});

const { SessionManager } = await import("../session-manager.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal BotConfig with the given model for agent "main". */
function makeConfig(model: string): BotConfig {
  return {
    telegramToken: "test-token",
    agents: {
      main: {
        id: "main",
        workspaceCwd: "/tmp/test-workspace",
        model,
      },
    },
    bindings: [{ chatId: 123, agentId: "main", kind: "dm" as const }],
    sessionDefaults: {
      idleTimeoutMs: 60_000,
      maxConcurrentSessions: 5,
      maxMessageAgeMs: 300_000,
      requireMention: false,
      maxMediaBytes: 209715200,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Hot-reload: mutable config loader", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    spawnCaptures.length = 0;
  });

  afterEach(async () => {
    cleanup();
  });

  it("new session picks up changed model after config swap", async () => {
    let currentModel = "claude-opus-4-6";
    const manager = new SessionManager(
      () => makeConfig(currentModel),
      TEST_STORE_PATH,
    );

    // First session — spawned with opus-4-6
    await manager.getOrCreateSession("chat-reload", "main");
    assert.strictEqual(spawnCaptures.length, 1, "one spawn after first call");
    assert.strictEqual(
      spawnCaptures[0].agent.model,
      "claude-opus-4-6",
      "first spawn uses original model",
    );

    // Close session so next getOrCreateSession triggers a new spawn
    await manager.closeSession("chat-reload");

    // Swap model
    currentModel = "claude-opus-4-7";

    // Second session — should spawn with opus-4-7
    await manager.getOrCreateSession("chat-reload", "main");
    assert.strictEqual(spawnCaptures.length, 2, "two spawns total");
    assert.strictEqual(
      spawnCaptures[1].agent.model,
      "claude-opus-4-7",
      "second spawn uses updated model",
    );

    await manager.closeAll();
  });

  it("different chats in sequence reflect config changes", async () => {
    let currentModel = "claude-opus-4-6";
    const manager = new SessionManager(
      () => makeConfig(currentModel),
      TEST_STORE_PATH,
    );

    // Spawn first chat with model A
    await manager.getOrCreateSession("chat-a", "main");
    assert.strictEqual(spawnCaptures[0].agent.model, "claude-opus-4-6");

    // Swap model before spawning second chat
    currentModel = "claude-opus-4-7";
    await manager.getOrCreateSession("chat-b", "main");
    assert.strictEqual(spawnCaptures[1].agent.model, "claude-opus-4-7");

    await manager.closeAll();
  });
});

describe("Hot-reload: config loader error propagation", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    spawnCaptures.length = 0;
  });

  afterEach(async () => {
    cleanup();
  });

  it("getOrCreateSession throws when loader fails", async () => {
    let shouldThrow = false;
    const manager = new SessionManager(
      () => {
        if (shouldThrow) throw new Error("YAML syntax error on line 42");
        return makeConfig("claude-opus-4-6");
      },
      TEST_STORE_PATH,
    );

    // First call succeeds — config is valid
    await manager.getOrCreateSession("chat-err", "main");
    assert.strictEqual(spawnCaptures.length, 1, "spawn succeeded initially");

    // Close so next call needs a new spawn (and thus a fresh config load)
    await manager.closeSession("chat-err");

    // Break the config loader
    shouldThrow = true;

    // getOrCreateSession should propagate the config error
    await assert.rejects(
      () => manager.getOrCreateSession("chat-err", "main"),
      /YAML syntax error/,
      "config error propagates to caller",
    );

    // No second spawn should have happened (error is before spawn)
    assert.strictEqual(spawnCaptures.length, 1, "no spawn after config error");

    await manager.closeAll();
  });

  it("existing active session is unaffected by broken config", async () => {
    let shouldThrow = false;
    const manager = new SessionManager(
      () => {
        if (shouldThrow) throw new Error("broken config");
        return makeConfig("claude-opus-4-6");
      },
      TEST_STORE_PATH,
    );

    // Create a live session
    const session = await manager.getOrCreateSession("chat-live", "main");
    assert.ok(session, "session created");

    // Break config
    shouldThrow = true;

    // Existing session is still returned (child is alive, no new spawn needed)
    const same = await manager.getOrCreateSession("chat-live", "main");
    assert.strictEqual(same.sessionId, session.sessionId, "reuses existing session");
    assert.strictEqual(spawnCaptures.length, 1, "no extra spawn for existing session");

    await manager.closeAll();
  });
});
