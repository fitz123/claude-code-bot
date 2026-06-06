import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable, PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { BotConfig } from "../types.js";
import { waitForSpawn, outboxDir, type ActiveSession } from "../session-manager.js";
import { piRetryTotal, piTurnDuration } from "../metrics.js";
import PQueue from "p-queue";

const TEST_DIR = "/tmp/minime-test-session-manager";
const TEST_STORE_PATH = `${TEST_DIR}/sessions.json`;

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

const testConfig: BotConfig = {
  telegramToken: "test-token",
  agents: {
    main: {
      id: "main",
      workspaceCwd: "/tmp/test-workspace",
      model: "gpt-5.5",
    },
    "agent-b": {
      id: "agent-b",
      workspaceCwd: "/tmp/test-workspace-b",
      model: "gpt-5.5",
    },
  },
  bindings: [
    { chatId: 123, agentId: "main", kind: "dm" },
    { chatId: 456, agentId: "agent-b", kind: "dm" },
  ],
  sessionDefaults: {
    idleTimeoutMs: 100, // Short for testing
    maxConcurrentSessions: 2,
    maxMessageAgeMs: 300000,
    requireMention: false,
    maxMediaBytes: 209715200,
  },
};

/** Create a mock ChildProcess that emits data and can be killed. */
function createMockChild(initSessionId: string = "mock-session-id"): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdoutEmitter = new Readable({ read() {} });
  const stderrEmitter = new Readable({ read() {} });
  const stdinStream = new Writable({ write(_chunk, _enc, cb) { cb(); } });

  Object.assign(child, {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    stdin: stdinStream,
    pid: Math.floor(Math.random() * 100000),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal?: string) {
      (child as unknown as Record<string, unknown>).killed = true;
      (child as unknown as Record<string, unknown>).exitCode = signal === "SIGKILL" ? 137 : 0;
      child.emit("exit", signal === "SIGKILL" ? 137 : 0, signal ?? "SIGTERM");
      return true;
    },
  });

  // Emit system/init after a tick to simulate CLI startup
  setTimeout(() => {
    stdoutEmitter.push(
      JSON.stringify({ type: "system", subtype: "init", session_id: initSessionId }) + "\n"
    );
  }, 10);

  return child;
}

function piTextDelta(text: string): string {
  return JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
  }) + "\n";
}

function piAgentEnd(result: string, sessionId = "pi-session"): string {
  return JSON.stringify({
    type: "agent_end",
    sessionId,
    messages: [
      { role: "assistant", content: [{ type: "text", text: result }] },
    ],
  }) + "\n";
}

let mockChildFactory: () => ChildProcess;

// Instead of mocking the module, we'll test SessionStore and SessionManager behavior
// by testing their internal logic through the public API

describe("SessionManager", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  // Since we can't easily mock ES module imports with node:test,
  // we'll test the SessionStore integration and the manager's state logic

  it("imports without error", async () => {
    const mod = await import("../session-manager.js");
    assert.ok(mod.SessionManager);
  });

  it("constructs with config", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    assert.strictEqual(manager.getActiveCount(), 0);
  });

  it("closeAll works on empty manager", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    await manager.closeAll();
    assert.strictEqual(manager.getActiveCount(), 0);
  });

  it("getActive returns undefined for unknown chatId", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    assert.strictEqual(manager.getActive("unknown"), undefined);
  });

  it("closeSession is safe for unknown chatId", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    // Should not throw
    await manager.closeSession("nonexistent");
  });

  it("destroySession is safe for unknown chatId", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    // Should not throw
    await manager.destroySession("nonexistent");
  });

  it("destroySession wipes media dir even when no active session exists", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { sessionMediaDir, ensureSessionMediaDir } = await import("../media-store.js");

    // Simulate post-crash state: media dir populated but no in-memory session
    const dir = ensureSessionMediaDir("chat-orphan-media");
    const filePath = `${dir}/leftover.jpg`;
    writeFileSync(filePath, "stale");
    assert.ok(existsSync(filePath), "precondition: leftover file exists");

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    await manager.destroySession("chat-orphan-media");

    assert.ok(!existsSync(filePath), "destroySession must remove leftover media");
    assert.ok(!existsSync(sessionMediaDir("chat-orphan-media")), "media dir should be gone");
  });

  it("resolveStoredSession purges stale media on agent mismatch but preserves current-turn download", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");
    const { ensureSessionMediaDir, allocateMediaPath, releaseMediaPath } = await import("../media-store.js");

    // Pre-populate store with a session using "main" agent
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("chat-race", {
      sessionId: "old-session-id",
      chatId: "chat-race",
      agentId: "main",
      lastActivity: Date.now(),
    });

    // Stale leftover from the prior agent — written directly, not tracked as in-flight.
    // Simulates both aged orphans and just-crashed-process leftovers.
    const dir = ensureSessionMediaDir("chat-race");
    const stale = `${dir}/photo-prior-session.jpg`;
    writeFileSync(stale, "stale");

    // Current-turn download — registered as in-flight via allocateMediaPath.
    const justDownloaded = allocateMediaPath("chat-race", "photo", ".jpg");
    writeFileSync(justDownloaded, "current");

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    const result = manager.resolveStoredSession("chat-race", "agent-b");

    assert.strictEqual(result.resume, false, "mismatched agent should not resume");
    assert.ok(existsSync(justDownloaded), "current-turn download must survive mismatch resolution");
    assert.ok(!existsSync(stale), "prior-agent leftover must be purged on rotation");

    releaseMediaPath(justDownloaded);
  });

  it("resolveStoredSession preserves session media when agent matches (same-session resume)", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");
    const { ensureSessionMediaDir } = await import("../media-store.js");

    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("chat-resume", {
      sessionId: "resume-session-id",
      chatId: "chat-resume",
      agentId: "main",
      lastActivity: Date.now(),
    });

    // A file from the prior turn of the SAME logical session — legitimate context.
    const dir = ensureSessionMediaDir("chat-resume");
    const priorTurn = `${dir}/photo-prior-turn.jpg`;
    writeFileSync(priorTurn, "prior");

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    const result = manager.resolveStoredSession("chat-resume", "main");

    assert.strictEqual(result.resume, true, "matching agent must allow resume");
    assert.ok(existsSync(priorTurn), "prior-turn media must survive resume of same session");
  });

  it("closeSession preserves stored state (reconnect can resume)", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");

    // Pre-populate store with a session
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("chat-reconnect", {
      sessionId: "reconnect-session-id",
      chatId: "chat-reconnect",
      agentId: "main",
      lastActivity: Date.now(),
    });

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    await manager.closeSession("chat-reconnect");

    // Stored state should still exist — /reconnect preserves it for resume
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.ok(storeAfter.getSession("chat-reconnect"), "closeSession should preserve stored state");

    // resolveStoredSession should find the stored session and allow resume
    const result = manager.resolveStoredSession("chat-reconnect", "main");
    assert.strictEqual(result.resume, true, "closed session should resume on next message");
  });

  it("destroySession closes session and deletes stored state", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");

    // Pre-populate store with a session
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("chat-destroy", {
      sessionId: "destroy-session-id",
      chatId: "chat-destroy",
      agentId: "main",
      lastActivity: Date.now(),
    });
    // Also store another session that should NOT be affected
    store.setSession("chat-keep", {
      sessionId: "keep-session-id",
      chatId: "chat-keep",
      agentId: "main",
      lastActivity: Date.now(),
    });

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    await manager.destroySession("chat-destroy");

    // Verify stored state was deleted
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("chat-destroy"), undefined, "destroyed session should be removed from store");
    assert.ok(storeAfter.getSession("chat-keep"), "other sessions should be unaffected");

    // Verify resolveStoredSession returns fresh (no resume)
    const result = manager.resolveStoredSession("chat-destroy", "main");
    assert.strictEqual(result.resume, false, "destroyed session should not resume");
  });

  it("destroySession removes stored state before awaiting child exit (race-safe)", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");

    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("chat-race", {
      sessionId: "race-sid",
      chatId: "chat-race",
      agentId: "main",
      lastActivity: Date.now(),
    });

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    // Build a child that delays its exit to widen the race window
    const slowChild = new EventEmitter() as unknown as ChildProcess;
    Object.assign(slowChild, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
      pid: 99999,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (slowChild as unknown as Record<string, unknown>).killed = true;
        setTimeout(() => {
          (slowChild as unknown as Record<string, unknown>).exitCode = 0;
          slowChild.emit("exit", 0, signal ?? "SIGTERM");
        }, 200);
        return true;
      },
    });

    const outboxPath = `${TEST_DIR}/outbox-race`;
    mkdirSync(outboxPath, { recursive: true });

    const fakeSession: ActiveSession = {
      child: slowChild,
      sessionId: "race-sid",
      agentId: "main",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      thinking: "high",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 100000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath,
    };

    (manager as unknown as { active: Map<string, ActiveSession> }).active.set("chat-race", fakeSession);

    const destroyPromise = manager.destroySession("chat-race");

    // Mid-flight: store entry must already be gone (delete precedes child-exit await)
    const storeMid = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      storeMid.getSession("chat-race"),
      undefined,
      "destroySession must delete store entry BEFORE awaiting child exit",
    );

    await destroyPromise;

    // And destroySession's {persist: false} must keep it gone
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      storeAfter.getSession("chat-race"),
      undefined,
      "store must remain empty after destroy completes (persist: false)",
    );
  });

  it("destroySession deletes state that closeSession would preserve", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");

    // Pre-populate store with two sessions
    const store = new SessionStore(TEST_STORE_PATH);
    const now = Date.now();
    store.setSession("chat-close", {
      sessionId: "close-sid",
      chatId: "chat-close",
      agentId: "main",
      lastActivity: now,
    });
    store.setSession("chat-destroy", {
      sessionId: "destroy-sid",
      chatId: "chat-destroy",
      agentId: "main",
      lastActivity: now,
    });

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    // closeSession (what /reconnect calls) — preserves store
    await manager.closeSession("chat-close");
    // destroySession (what /clean calls) — deletes from store
    await manager.destroySession("chat-destroy");

    const closeResult = manager.resolveStoredSession("chat-close", "main");
    const destroyResult = manager.resolveStoredSession("chat-destroy", "main");

    assert.strictEqual(closeResult.resume, true, "/reconnect: session resumes");
    assert.strictEqual(destroyResult.resume, false, "/clean: session starts fresh");
  });

  it("throws for unknown agent", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    await assert.rejects(
      () => manager.getOrCreateSession("123", "nonexistent-agent"),
      /Unknown agent/
    );
  });
});

describe("SessionManager agentId mismatch detection", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("resumes session when agentId matches stored session", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");

    // Pre-populate store with a session using "main" agent
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("chat-1", {
      sessionId: "existing-session-id",
      chatId: "chat-1",
      agentId: "main",
      lastActivity: Date.now(),
    });

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    const result = manager.resolveStoredSession("chat-1", "main");
    assert.strictEqual(result.resume, true);
    assert.strictEqual(result.sessionId, "existing-session-id");
  });

  it("discards stored session when agentId changes", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");

    // Pre-populate store with a session using "main" agent
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("chat-1", {
      sessionId: "old-session-id",
      chatId: "chat-1",
      agentId: "main",
      lastActivity: Date.now(),
    });
    // Also store a second session that should NOT be affected
    store.setSession("chat-2", {
      sessionId: "other-session-id",
      chatId: "chat-2",
      agentId: "main",
      lastActivity: Date.now(),
    });

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    const result = manager.resolveStoredSession("chat-1", "agent-b");

    assert.strictEqual(result.resume, false, "should not resume mismatched session");
    assert.notStrictEqual(result.sessionId, "old-session-id", "should generate a fresh sessionId");

    // Verify store: stale session deleted, other session intact
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("chat-1"), undefined, "stale session should be deleted from store");
    assert.ok(storeAfter.getSession("chat-2"), "other sessions should be unaffected");
  });

  it("discards stored session when stored agentId references a deleted agent", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");

    // Pre-populate store with a session referencing a non-existent agent
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("chat-1", {
      sessionId: "orphan-session-id",
      chatId: "chat-1",
      agentId: "deleted-agent",
      lastActivity: Date.now(),
    });

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    const result = manager.resolveStoredSession("chat-1", "main");

    assert.strictEqual(result.resume, false, "should not resume session with deleted agent");
    assert.notStrictEqual(result.sessionId, "orphan-session-id", "should generate a fresh sessionId");

    // Verify store cleanup
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("chat-1"), undefined, "orphan session should be deleted");
  });

  it("creates fresh session when no stored session exists", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const result = manager.resolveStoredSession("new-chat", "main");
    assert.strictEqual(result.resume, false, "should not resume non-existent session");
    assert.ok(result.sessionId, "should generate a sessionId");
  });

  it("creates fresh session when stored sessionId is empty", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const { SessionStore } = await import("../session-store.js");

    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("chat-1", {
      sessionId: "",
      chatId: "chat-1",
      agentId: "main",
      lastActivity: Date.now(),
    });

    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    const result = manager.resolveStoredSession("chat-1", "main");
    assert.strictEqual(result.resume, false, "should not resume empty sessionId");
  });
});

describe("SessionManager idle timer logic", () => {
  it("resetIdleTimer is safe for unknown chatId", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    // Should not throw
    manager.resetIdleTimer("unknown");
  });
});

describe("SessionManager LRU eviction logic", () => {
  // Test the concept: with max=2 sessions, creating a 3rd should evict oldest

  it("config respects maxConcurrentSessions", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const restrictedConfig = {
      ...testConfig,
      sessionDefaults: { ...testConfig.sessionDefaults, maxConcurrentSessions: 1 },
    };
    const manager = new SessionManager(() => restrictedConfig, TEST_STORE_PATH);
    // Just verify construction works with the limit
    assert.strictEqual(manager.getActiveCount(), 0);
  });
});

describe("ActiveSession shape", () => {
  it("has expected properties type", async () => {
    // Type-level test: ensure the ActiveSession interface is exported and usable
    const mod = await import("../session-manager.js");
    assert.ok(mod.SessionManager);
    // ActiveSession is exported as interface, verified by TypeScript compilation
  });
});

describe("outboxDir", () => {
  it("returns deterministic path for a chatId", () => {
    const path = outboxDir("chat123");
    assert.strictEqual(path, "/tmp/bot-outbox/chat123");
  });

  it("sanitizes special characters in chatId", () => {
    const path = outboxDir("tg:12345");
    assert.strictEqual(path, "/tmp/bot-outbox/tg_12345");
  });

  it("returns same path for same chatId", () => {
    assert.strictEqual(outboxDir("abc"), outboxDir("abc"));
  });
});

describe("SessionManager sendSessionMessage streaming", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("yields lines in real-time before response completes", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    // Create a mock child process (no auto-init emission)
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    Object.assign(child, {
      stdout, stderr, stdin,
      pid: 12345,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (child as unknown as Record<string, unknown>).killed = true;
        // Emit exit async to match real process behavior (allows .once("exit") to attach)
        process.nextTick(() => {
          (child as unknown as Record<string, unknown>).exitCode = 0;
          child.emit("exit", 0, signal ?? "SIGTERM");
        });
        return true;
      },
    });

    // Inject mock session into private active map so getOrCreateSession reuses it
    const session = {
      child,
      sessionId: "test-session",
      agentId: "main",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["123", session]]);

    const gen = manager.sendSessionMessage("123", "main", "hello");

    // Push a text_delta line after a tick (readPiStream needs time to attach)
    setTimeout(() => {
      stdout.push(piTextDelta("Hello"));
    }, 30);

    // First gen.next() should resolve with the text_delta BEFORE result is pushed.
    // In the old buffered implementation, this would hang forever (timeout)
    // because no lines were yielded until queue.add() fully resolved.
    const first = await gen.next();
    assert.ok(!first.done, "generator should not be done after first line");
    assert.strictEqual(first.value.type, "stream_event");

    // Now push the result — proves first line was streamed in real-time
    stdout.push(piAgentEnd("Hello", "test-session"));

    const second = await gen.next();
    assert.ok(!second.done, "generator should not be done on result line");
    assert.strictEqual(second.value.type, "result");

    const third = await gen.next();
    assert.ok(third.done, "generator should be done after result");

    await manager.closeAll();
  });

  it("propagates errors from the queue task", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    // Create a child with a destroyed stdin to trigger an error in sendPiPrompt
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    stdin.destroy();
    Object.assign(child, {
      stdout, stderr, stdin,
      pid: 12346,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (child as unknown as Record<string, unknown>).killed = true;
        process.nextTick(() => {
          (child as unknown as Record<string, unknown>).exitCode = 0;
          child.emit("exit", 0, signal ?? "SIGTERM");
        });
        return true;
      },
    });

    const session = {
      child,
      sessionId: "test-session-err",
      agentId: "main",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["err-chat", session]]);

    const gen = manager.sendSessionMessage("err-chat", "main", "hello");

    // sendPiPrompt should throw because stdin is destroyed
    await assert.rejects(async () => {
      for await (const _line of gen) {
        // consume
      }
    }, /Pi RPC child process is not available/);

    await manager.closeAll();
  });

  it("throws when subprocess dies before sending result", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    // Create a mock child that will die mid-stream (stdout closes without result)
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    Object.assign(child, {
      stdout, stderr, stdin,
      pid: 12347,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (child as unknown as Record<string, unknown>).killed = true;
        process.nextTick(() => {
          (child as unknown as Record<string, unknown>).exitCode = 1;
          child.emit("exit", 1, signal ?? "SIGTERM");
        });
        return true;
      },
    });

    const session = {
      child,
      sessionId: "test-session-dead",
      agentId: "main",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["dead-chat", session]]);

    const gen = manager.sendSessionMessage("dead-chat", "main", "hello");

    // Push a partial line then close stdout (simulating subprocess death)
    setTimeout(() => {
      stdout.push(piTextDelta("partial"));
      // Close stdout without sending a result — simulates process death
      stdout.push(null);
    }, 30);

    // Consuming the generator should yield the partial line then throw
    await assert.rejects(async () => {
      for await (const _line of gen) {
        // consume
      }
    }, /Pi subprocess exited before sending a result/);

    await manager.closeAll();
  });

  it("catches EPIPE on stdin without crashing the process", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    // Create a child that looks alive but whose stdin emits EPIPE on write
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    // stdin that emits EPIPE error asynchronously (simulates dead pipe fd)
    const stdin = new Writable({
      write(_chunk, _enc, cb) {
        const err = new Error("write EPIPE") as NodeJS.ErrnoException;
        err.code = "EPIPE";
        cb(err);
        return false;
      },
    });
    // Attach error handler like getOrCreateSession does
    stdin.on("error", () => {});

    Object.assign(child, {
      stdout, stderr, stdin,
      pid: 12348,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (child as unknown as Record<string, unknown>).killed = true;
        process.nextTick(() => {
          (child as unknown as Record<string, unknown>).exitCode = 1;
          child.emit("exit", 1, signal ?? "SIGTERM");
        });
        return true;
      },
    });

    const session = {
      child,
      sessionId: "test-session-epipe",
      agentId: "main",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["epipe-chat", session]]);

    const gen = manager.sendSessionMessage("epipe-chat", "main", "hello");

    // Close stdout shortly after — subprocess died, no result
    setTimeout(() => { stdout.push(null); }, 30);

    // The EPIPE write error is caught, and stream ends without result
    await assert.rejects(async () => {
      for await (const _line of gen) {
        // consume
      }
    }, /Pi subprocess exited before sending a result/);

    await manager.closeAll();
  });
});

describe("waitForSpawn", () => {
  it("resolves when child emits 'spawn'", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { pid: 1, exitCode: null, killed: false });

    setTimeout(() => child.emit("spawn"), 10);

    await waitForSpawn(child, 1000);
    // No error = success
  });

  it("rejects when child emits 'error' (e.g. ENOENT)", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { pid: undefined, exitCode: null, killed: false });

    setTimeout(() => {
      const err = new Error("spawn pi ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      child.emit("error", err);
    }, 10);

    await assert.rejects(
      () => waitForSpawn(child, 1000),
      /Pi subprocess failed to start: spawn pi ENOENT/
    );
  });

  it("rejects when child exits immediately (e.g. auth failure)", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { pid: 1, exitCode: null, killed: false });

    setTimeout(() => child.emit("exit", 1, null), 10);

    await assert.rejects(
      () => waitForSpawn(child, 1000),
      /Pi subprocess exited during startup: code=1 signal=null/
    );
  });

  it("rejects on timeout and kills the child with SIGKILL", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    let killedWithSignal: string | undefined;
    Object.assign(child, {
      pid: 1,
      exitCode: null,
      killed: false,
      kill(signal?: string) {
        killedWithSignal = signal;
        (child as unknown as Record<string, unknown>).killed = true;
        return true;
      },
    });

    await assert.rejects(
      () => waitForSpawn(child, 50),
      /Pi subprocess did not start within 50ms/
    );
    assert.strictEqual(killedWithSignal, "SIGKILL", "child should have been killed with SIGKILL on timeout");
  });

  it("cleans up listeners after resolving", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { pid: 1, exitCode: null, killed: false });

    setTimeout(() => child.emit("spawn"), 10);
    await waitForSpawn(child, 1000);

    assert.strictEqual(child.listenerCount("spawn"), 0);
    assert.strictEqual(child.listenerCount("error"), 0);
    assert.strictEqual(child.listenerCount("exit"), 0);
  });

  it("cleans up listeners after rejecting", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { pid: 1, exitCode: null, killed: false });

    setTimeout(() => child.emit("exit", 1, null), 10);

    await assert.rejects(() => waitForSpawn(child, 1000));

    assert.strictEqual(child.listenerCount("spawn"), 0);
    assert.strictEqual(child.listenerCount("error"), 0);
    assert.strictEqual(child.listenerCount("exit"), 0);
  });
});

describe("setupStderrLogging", () => {
  const STDERR_LOG_DIR = `${TEST_DIR}/stderr-logs`;

  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("captures stderr data that arrives after exit event", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);

    // Create mock child with a PassThrough as stderr
    const child = new EventEmitter() as unknown as ChildProcess;
    const stderr = new PassThrough();
    Object.assign(child, { stderr, pid: 77777, exitCode: null, signalCode: null, killed: false });

    // Call the private method via cast
    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupStderrLogging("stderr-test", child);

    // Write stderr data before exit
    stderr.write("error: crash detected\n");

    // Simulate process exit (fires before stdio closes)
    (child as unknown as Record<string, unknown>).exitCode = 1;
    child.emit("exit", 1, null);

    // Write more stderr data after exit but before stdio closes
    stderr.write("backtrace: frame0 frame1\n");

    // End stderr (simulates stdio close — the 'close' event follows)
    stderr.end();

    // Wait for pipe to flush to disk
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const logPath = `${STDERR_LOG_DIR}/session-stderr-test.log`;
    assert.ok(existsSync(logPath), "log file should exist");
    const content = readFileSync(logPath, "utf8");
    assert.ok(content.includes("error: crash detected"), "should capture stderr before exit");
    assert.ok(content.includes("backtrace: frame0 frame1"), "should capture stderr after exit");
  });

  it("creates log directory if it does not exist", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const nestedDir = `${TEST_DIR}/nested/deep/logs`;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH, nestedDir);

    const child = new EventEmitter() as unknown as ChildProcess;
    const stderr = new PassThrough();
    Object.assign(child, { stderr, pid: 77778, exitCode: null, signalCode: null, killed: false });

    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupStderrLogging("dir-test", child);

    stderr.write("test output\n");
    stderr.end();

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    assert.ok(existsSync(nestedDir), "log directory should be created");
    const content = readFileSync(`${nestedDir}/session-dir-test.log`, "utf8");
    assert.ok(content.includes("test output"), "should capture stderr output");
  });

  it("appends to existing log file", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);
    mkdirSync(STDERR_LOG_DIR, { recursive: true });

    // First child writes some output
    const child1 = new EventEmitter() as unknown as ChildProcess;
    const stderr1 = new PassThrough();
    Object.assign(child1, { stderr: stderr1, pid: 77779, exitCode: null, signalCode: null, killed: false });

    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupStderrLogging("append-test", child1);

    stderr1.write("first session output\n");
    stderr1.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // Second child appends to same log
    const child2 = new EventEmitter() as unknown as ChildProcess;
    const stderr2 = new PassThrough();
    Object.assign(child2, { stderr: stderr2, pid: 77780, exitCode: null, signalCode: null, killed: false });

    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupStderrLogging("append-test", child2);

    stderr2.write("second session output\n");
    stderr2.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const content = readFileSync(`${STDERR_LOG_DIR}/session-append-test.log`, "utf8");
    assert.ok(content.includes("first session output"), "should contain first session output");
    assert.ok(content.includes("second session output"), "should contain second session output");
  });

  it("skips logging when child has no stderr", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);

    // Create a mock child with null stderr
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { stderr: null, pid: 77781, exitCode: null, signalCode: null, killed: false });

    // Should not throw
    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupStderrLogging("no-stderr-test", child);

    // No log file should be created
    assert.ok(!existsSync(`${STDERR_LOG_DIR}/session-no-stderr-test.log`), "no log file when stderr is null");
  });

  it("crash recovery does not interfere with stderr capture", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);

    // Create a mock child that simulates a crash
    const child = new EventEmitter() as unknown as ChildProcess;
    const stderr = new PassThrough();
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    Object.assign(child, {
      stderr, stdout, stdin,
      pid: 77782,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (child as unknown as Record<string, unknown>).killed = true;
        process.nextTick(() => {
          (child as unknown as Record<string, unknown>).exitCode = signal === "SIGKILL" ? 137 : 0;
          child.emit("exit", signal === "SIGKILL" ? 137 : 0, signal ?? "SIGTERM");
        });
        return true;
      },
    });

    // Set up both stderr logging and crash recovery (like getOrCreateSession does)
    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupStderrLogging("crash-integration", child);
    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupCrashRecovery("crash-integration", child);

    // Inject session into active map so crash recovery has something to clean up
    const session = {
      child,
      sessionId: "crash-test-session",
      agentId: "main",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, Map<string, unknown>>).active.set("crash-integration", session);

    // Write stderr data, then crash the process
    stderr.write("FATAL: segmentation fault\n");
    stderr.write("stack trace: 0x7fff...\n");

    // Simulate crash: exit fires first, then stderr has more data
    (child as unknown as Record<string, unknown>).exitCode = 139;
    (child as unknown as Record<string, unknown>).signalCode = "SIGSEGV";
    child.emit("exit", 139, "SIGSEGV");

    // Crash recovery should have removed the session from active map
    assert.strictEqual(manager.getActive("crash-integration"), undefined,
      "crash recovery should remove session from active map");

    // More stderr data arrives after exit (from kernel buffers)
    stderr.write("core dumped\n");
    stderr.end();

    // Wait for pipe to flush
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // All stderr data should be captured despite crash recovery running
    const logPath = `${STDERR_LOG_DIR}/session-crash-integration.log`;
    assert.ok(existsSync(logPath), "log file should exist");
    const content = readFileSync(logPath, "utf8");
    assert.ok(content.includes("FATAL: segmentation fault"), "should capture pre-crash stderr");
    assert.ok(content.includes("stack trace: 0x7fff"), "should capture stack trace");
    assert.ok(content.includes("core dumped"), "should capture post-exit stderr data");
  });

  it("captures large stderr output without truncation", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);

    const child = new EventEmitter() as unknown as ChildProcess;
    const stderr = new PassThrough();
    Object.assign(child, { stderr, pid: 77783, exitCode: null, signalCode: null, killed: false });

    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupStderrLogging("large-output", child);

    // Write many lines of stderr output (simulates verbose crash with backtrace)
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      const line = `frame #${i}: 0x${i.toString(16).padStart(8, "0")} in function_${i}()`;
      lines.push(line);
      stderr.write(line + "\n");
    }

    stderr.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const content = readFileSync(`${STDERR_LOG_DIR}/session-large-output.log`, "utf8");
    // Verify first, middle, and last lines are present
    assert.ok(content.includes(lines[0]), "should contain first line");
    assert.ok(content.includes(lines[49]), "should contain middle line");
    assert.ok(content.includes(lines[99]), "should contain last line");
  });
});

describe("SessionManager.getSessionHealth", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("returns undefined for unknown chatId", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    assert.strictEqual(manager.getSessionHealth("unknown"), undefined);
  });

  it("returns health info for an alive session", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } }),
      pid: 42000,
      exitCode: null,
      signalCode: null,
      killed: false,
    });

    const now = Date.now();
    const session = {
      child,
      sessionId: "health-test",
      agentId: "main",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      thinking: "high",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: now - 5000,
      processingStartedAt: null,
      lastSuccessAt: now - 10000,
      restartCount: 2,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["health-chat", session]]);
    // restartCount now reads from the restartCounts map (not the frozen session field)
    (manager as unknown as Record<string, Map<string, number>>).restartCounts = new Map([["health-chat", 2]]);

    const health = manager.getSessionHealth("health-chat");
    assert.ok(health);
    assert.strictEqual(health.pid, 42000);
    assert.strictEqual(health.alive, true);
    assert.strictEqual(health.agentId, "main");
    assert.strictEqual(health.provider, "pi");
    assert.strictEqual(health.model, "openai-codex/gpt-5.5");
    assert.strictEqual(health.thinking, "high");
    assert.ok(health.idleMs >= 5000, "idle should be at least 5s");
    assert.strictEqual(health.processingMs, null);
    assert.strictEqual(health.lastSuccessAt, now - 10000);
    assert.strictEqual(health.restartCount, 2);
  });

  it("returns processing duration when session is processing", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } }),
      pid: 42001,
      exitCode: null,
      signalCode: null,
      killed: false,
    });

    const now = Date.now();
    const session = {
      child,
      sessionId: "proc-test",
      agentId: "main",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: now,
      processingStartedAt: now - 3000,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["proc-chat", session]]);

    const health = manager.getSessionHealth("proc-chat");
    assert.ok(health);
    assert.ok(health.processingMs !== null && health.processingMs >= 3000,
      "processingMs should be at least 3s");
  });

  it("reports dead when child has exited", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } }),
      pid: 42002,
      exitCode: 1,
      signalCode: null,
      killed: false,
    });

    const session = {
      child,
      sessionId: "dead-health-test",
      agentId: "main",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["dead-health", session]]);

    const health = manager.getSessionHealth("dead-health");
    assert.ok(health);
    assert.strictEqual(health.alive, false);
  });

  it("reports dead when child was killed", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } }),
      pid: 42003,
      exitCode: null,
      signalCode: null,
      killed: true,
    });

    const session = {
      child,
      sessionId: "killed-test",
      agentId: "main",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["killed-chat", session]]);

    const health = manager.getSessionHealth("killed-chat");
    assert.ok(health);
    assert.strictEqual(health.alive, false);
  });

  it("handles null PID gracefully", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } }),
      pid: undefined,
      exitCode: null,
      signalCode: null,
      killed: false,
    });

    const session = {
      child,
      sessionId: "no-pid-test",
      agentId: "agent-b",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["nopid-chat", session]]);

    const health = manager.getSessionHealth("nopid-chat");
    assert.ok(health);
    assert.strictEqual(health.pid, null);
    assert.strictEqual(health.agentId, "agent-b");
  });
});

describe("ActiveSession health fields tracked in sendSessionMessage", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("sets processingStartedAt during processing and clears after result", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } });
    Object.assign(child, {
      stdout, stderr, stdin,
      pid: 55000,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (child as unknown as Record<string, unknown>).killed = true;
        process.nextTick(() => {
          (child as unknown as Record<string, unknown>).exitCode = 0;
          child.emit("exit", 0, signal ?? "SIGTERM");
        });
        return true;
      },
    });

    const session = {
      child,
      sessionId: "proc-track-test",
      agentId: "main",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["proc-track", session]]);

    const gen = manager.sendSessionMessage("proc-track", "main", "hello");

    // After sending, processingStartedAt should be set
    setTimeout(() => {
      assert.ok(session.processingStartedAt !== null, "processingStartedAt should be set during processing");

      stdout.push(piAgentEnd("done", "proc-track-test"));
    }, 30);

    for await (const _line of gen) {
      // consume
    }

    // After completion, processingStartedAt should be cleared and lastSuccessAt set
    assert.strictEqual(session.processingStartedAt, null, "processingStartedAt should be null after completion");
    assert.ok(session.lastSuccessAt !== null, "lastSuccessAt should be set after success");
  });
});

describe("SessionManager crash backoff", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("blocks session after MAX_CRASH_RESTARTS consecutive crashes", async () => {
    const { SessionManager, MAX_CRASH_RESTARTS } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    // Simulate crash count reaching the limit by injecting restartCounts directly
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    restartCounts.set("crash-chat", MAX_CRASH_RESTARTS);

    await assert.rejects(
      () => manager.getOrCreateSession("crash-chat", "main"),
      /Session blocked.*consecutive crashes/,
    );
  });

  it("does not block session below MAX_CRASH_RESTARTS", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    // Use crash count 1 (not MAX-1) to keep backoff delay short (5s vs 40s)
    restartCounts.set("ok-chat", 1);

    // This should not throw from backoff. It may throw during process startup
    // because we're not mocking it, but we verify the error is NOT "Session blocked".
    try {
      await manager.getOrCreateSession("ok-chat", "main");
    } catch (err) {
      // Should fail for some other reason (e.g. spawn), not backoff blocking
      assert.ok(
        !(err instanceof Error && /Session blocked/.test(err.message)),
        "should not be blocked by crash backoff",
      );
    }
  });

  it("crash count increments in setupCrashRecovery on abnormal exit", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } }),
      pid: 90001,
      exitCode: null,
      signalCode: null,
      killed: false,
    });

    const session = {
      child,
      sessionId: "crash-count-test",
      agentId: "main",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, Map<string, unknown>>).active.set("crash-count-chat", session);

    // Set up crash recovery
    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupCrashRecovery("crash-count-chat", child);

    // Simulate crash (code=1, not SIGTERM/SIGKILL)
    (child as unknown as Record<string, unknown>).exitCode = 1;
    child.emit("exit", 1, null);

    // Check crash count was incremented
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("crash-count-chat"), 1, "crash count should be 1 after first crash");

    // Simulate another crash on a new child
    const child2 = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child2, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } }),
      pid: 90002,
      exitCode: null,
      signalCode: null,
      killed: false,
    });
    const session2 = { ...session, child: child2 };
    (manager as unknown as Record<string, Map<string, unknown>>).active.set("crash-count-chat", session2);
    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupCrashRecovery("crash-count-chat", child2);

    (child2 as unknown as Record<string, unknown>).exitCode = 1;
    child2.emit("exit", 1, null);

    assert.strictEqual(restartCounts.get("crash-count-chat"), 2, "crash count should be 2 after second crash");
  });

  it("does not increment crash count for SIGTERM exits", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } }),
      pid: 90003,
      exitCode: null,
      signalCode: null,
      killed: false,
    });

    const session = {
      child,
      sessionId: "sigterm-test",
      agentId: "main",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, Map<string, unknown>>).active.set("sigterm-chat", session);
    (manager as unknown as Record<string, (...args: unknown[]) => void>)
      .setupCrashRecovery("sigterm-chat", child);

    // SIGTERM exit (graceful) should NOT increment crash count
    (child as unknown as Record<string, unknown>).exitCode = 0;
    child.emit("exit", 0, "SIGTERM");

    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("sigterm-chat") ?? 0, 0, "SIGTERM should not increment crash count");
  });

  it("resets crash count on successful result", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    // Set up a session with accumulated crash count
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    restartCounts.set("success-chat", 3);

    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } });
    Object.assign(child, {
      stdout, stderr, stdin,
      pid: 90010,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (child as unknown as Record<string, unknown>).killed = true;
        process.nextTick(() => {
          (child as unknown as Record<string, unknown>).exitCode = 0;
          child.emit("exit", 0, signal ?? "SIGTERM");
        });
        return true;
      },
    });

    const session = {
      child,
      sessionId: "success-session",
      agentId: "main",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 3,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["success-chat", session]]);

    const gen = manager.sendSessionMessage("success-chat", "main", "hello");

    // Push a result
    setTimeout(() => {
      stdout.push(piAgentEnd("Success", "success-session"));
    }, 30);

    for await (const _line of gen) {
      // consume
    }

    // Crash count should be reset to 0
    assert.strictEqual(restartCounts.get("success-chat"), 0, "crash count should reset to 0 after success");

    await manager.closeAll();
  });

  it("closeSession clears crash count", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    restartCounts.set("close-chat", 4);

    // closeSession on unknown chatId is safe (no active session to close)
    // but it deletes restartCounts
    await manager.closeSession("close-chat");

    assert.strictEqual(restartCounts.get("close-chat"), undefined, "crash count should be deleted after closeSession");
  });

});

describe("SessionManager gracefulShutdown", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  /** Insert a mock session into the manager's active map. */
  function insertMockSession(
    manager: InstanceType<typeof import("../session-manager.js").SessionManager>,
    chatId: string,
    opts: { processing: boolean },
  ): { queue: PQueue; child: ChildProcess; stdinWrites: string[] } {
    const activeMap = (manager as unknown as Record<string, Map<string, ActiveSession>>).active;
    const stdinWrites: string[] = [];
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(chunk, _enc, cb) { stdinWrites.push(chunk.toString()); cb(); } }),
      pid: Math.floor(Math.random() * 100000),
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (child as unknown as Record<string, unknown>).killed = true;
        (child as unknown as Record<string, unknown>).exitCode = 0;
        child.emit("exit", 0, signal ?? "SIGTERM");
        return true;
      },
    });
    child.emit("spawn");
    const queue = new PQueue({ concurrency: 1 });

    activeMap.set(chatId, {
      child,
      sessionId: "test-session-" + chatId,
      agentId: "main",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      thinking: "high",
      queue,
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: opts.processing ? Date.now() : null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: `${TEST_DIR}/outbox-${chatId}`,
    });

    return { queue, child, stdinWrites };
  }

  it("returns immediately with no active sessions", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);
    await manager.gracefulShutdown(5000);
    assert.strictEqual(manager.getActiveCount(), 0);
  });

  it("returns immediately when active sessions are idle (not processing)", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const { stdinWrites } = insertMockSession(manager, "idle-chat", { processing: false });

    await manager.gracefulShutdown(5000);
    assert.strictEqual(stdinWrites.length, 0, "no steer for idle session");
  });

  it("steers shutdown notice for busy sessions", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const { queue, stdinWrites } = insertMockSession(manager, "busy-chat", { processing: true });

    // Keep the queue busy so gracefulShutdown has something to wait for
    let resolveTask!: () => void;
    const taskPromise = queue.add(() => new Promise<void>(r => { resolveTask = r; }));

    const shutdownPromise = manager.gracefulShutdown(200);

    assert.strictEqual(stdinWrites.length, 1, "exactly one steer write");
    const sent = JSON.parse(stdinWrites[0]);
    assert.strictEqual(sent.type, "steer");
    assert.ok(sent.message.includes("shutting down"), "steer should contain shutdown message");
    assert.ok(sent.message.includes("Do NOT attempt to restart"), "steer should warn against restart");

    // Let the task finish
    resolveTask();
    await taskPromise;
    await shutdownPromise;
  });

  it("waits for busy session to finish within timeout", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const { queue } = insertMockSession(manager, "wait-chat", { processing: true });

    // Simulate a task that finishes after 50ms
    let resolveTask!: () => void;
    const taskPromise = queue.add(() => new Promise<void>(r => { resolveTask = r; }));

    const start = Date.now();
    const shutdownPromise = manager.gracefulShutdown(5000);

    // Finish the task after 50ms
    setTimeout(() => {
      const session = manager.getActive("wait-chat");
      if (session) session.processingStartedAt = null;
      resolveTask();
    }, 50);

    await shutdownPromise;
    const elapsed = Date.now() - start;

    // Should have finished quickly (within ~200ms), not waited for full timeout
    assert.ok(elapsed < 2000, `should finish quickly, took ${elapsed}ms`);
    await taskPromise;
  });

  it("times out for sessions that exceed the deadline", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const { queue } = insertMockSession(manager, "slow-chat", { processing: true });

    // Task that never resolves (simulating a long-running turn)
    let resolveTask!: () => void;
    const taskPromise = queue.add(() => new Promise<void>(r => { resolveTask = r; }));

    const start = Date.now();
    await manager.gracefulShutdown(100); // 100ms timeout
    const elapsed = Date.now() - start;

    // Should have timed out around 100ms
    assert.ok(elapsed >= 90, `should wait at least ~100ms, took ${elapsed}ms`);
    assert.ok(elapsed < 1000, `should not wait much longer than timeout, took ${elapsed}ms`);

    // Session should still be marked as processing (it didn't finish)
    const session = manager.getActive("slow-chat");
    assert.ok(session?.processingStartedAt !== null, "session should still be processing after timeout");

    // Clean up
    resolveTask();
    await taskPromise;
  });

  it("handles mix of idle and busy sessions", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => testConfig, TEST_STORE_PATH);

    const idle = insertMockSession(manager, "idle-mix", { processing: false });
    const busy = insertMockSession(manager, "busy-mix", { processing: true });

    let resolveTask!: () => void;
    const taskPromise = busy.queue.add(() => new Promise<void>(r => { resolveTask = r; }));

    const shutdownPromise = manager.gracefulShutdown(200);

    assert.strictEqual(idle.stdinWrites.length, 0, "idle session should not get steer");
    assert.strictEqual(busy.stdinWrites.length, 1, "busy session should get steer");

    resolveTask();
    await taskPromise;
    await shutdownPromise;
  });

});

describe("SessionManager Pi dispatch", () => {
  // Config with an absent-provider agent and an explicit pi agent. Session
  // dispatch is Pi-only; this keeps active-session reuse independent of config.
  const dispatchConfig: BotConfig = {
    ...testConfig,
    agents: {
      ...testConfig.agents,
      pi: {
        id: "pi",
        workspaceCwd: "/tmp/test-workspace-pi",
        model: "gpt-5.5",
        provider: "pi",
      },
    },
  };

  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * Build a mock child whose stdin writes are captured and whose stdout can be
   * driven by the test. Mirrors the reuse-path pattern used elsewhere in this
   * file (mock injected into the private active map — no module mocking).
   */
  function makeCapturingChild(): { child: ChildProcess; stdout: Readable; stdinWrites: string[] } {
    const stdinWrites: string[] = [];
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        stdinWrites.push(chunk.toString());
        cb();
      },
    });
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, {
      stdout, stderr, stdin,
      pid: Math.floor(Math.random() * 100000),
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: string) {
        (child as unknown as Record<string, unknown>).killed = true;
        process.nextTick(() => {
          (child as unknown as Record<string, unknown>).exitCode = 0;
          child.emit("exit", 0, signal ?? "SIGTERM");
        });
        return true;
      },
    });
    return { child, stdout, stdinWrites };
  }

  function injectSession(
    manager: InstanceType<typeof import("../session-manager.js").SessionManager>,
    chatId: string,
    agentId: string,
    child: ChildProcess,
  ): void {
    const session: ActiveSession = {
      child,
      sessionId: `sid-${chatId}`,
      agentId,
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      thinking: "xhigh",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 60_000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: `${TEST_DIR}/outbox-${chatId}`,
    };
    (manager as unknown as Record<string, Map<string, ActiveSession>>).active.set(chatId, session);
  }

  it("routes an active session through sendPiPrompt + readPiStream", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => dispatchConfig, TEST_STORE_PATH);

    const { child, stdout, stdinWrites } = makeCapturingChild();
    injectSession(manager, "pi-chat", "pi", child);

    const gen = manager.sendSessionMessage("pi-chat", "pi", "hello pi");

    // Drive a multi-turn-shaped Pi run: per-turn boundary then the terminal
    // agent_end. readPiStream/parsePiEvent translates agent_end into a terminal
    // result while turn_end is ignored.
    setTimeout(() => {
      stdout.push(JSON.stringify({ type: "turn_end", sessionId: "pi-real" }) + "\n");
      stdout.push(piAgentEnd("final pi answer", "pi-real"));
    }, 30);

    const lines: { type: string; result?: string }[] = [];
    for await (const line of gen) {
      lines.push(line as { type: string; result?: string });
    }

    // Send routed to sendPiPrompt → a Pi "prompt" command.
    assert.ok(stdinWrites.length >= 1, "should have written to stdin");
    const sent = JSON.parse(stdinWrites[0]);
    assert.strictEqual(sent.type, "prompt", "pi path must write a Pi prompt command");
    assert.ok(sent.message.startsWith("hello pi\n\n"), "user prompt should be preserved at the start");
    assert.ok(
      sent.message.includes("To share a file with the user, write or copy it to this outbox directory:"),
      "prompt should include the per-session outbox instruction",
    );
    assert.ok(
      sent.message.includes(`${TEST_DIR}/outbox-pi-chat`),
      "prompt should include the session outbox path",
    );
    // Defect B: the queue-driven Pi send path must NEVER deliver a bare prompt —
    // it always carries streamingBehavior:"followUp" so a prompt sent into a
    // busy child (bot busy-tracking desynced from the child's real lifecycle) is
    // queued behind the live turn instead of rejected as "already processing".
    assert.strictEqual(
      sent.streamingBehavior,
      "followUp",
      "pi prompt must carry streamingBehavior:followUp (never a bare prompt)",
    );

    // Read routed to readPiStream: agent_end became the single terminal result
    // carrying the FINAL assistant text; turn_end produced no line.
    const results = lines.filter((l) => l.type === "result");
    assert.strictEqual(results.length, 1, "exactly one terminal result from agent_end");
    assert.strictEqual(results[0].result, "final pi answer");

    await manager.closeAll();
  });

  it("does not truncate the in-flight Pi turn when an 'already processing' rejection arrives mid-stream (Defects A+B wedge)", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => dispatchConfig, TEST_STORE_PATH);

    const { child, stdout } = makeCapturingChild();
    injectSession(manager, "pi-wedge", "pi", child);

    const gen = manager.sendSessionMessage("pi-wedge", "pi", "hello pi");

    // The integrated failure mode: while the turn is live, Pi rejects a colliding
    // concurrent prompt with its "already processing" error. The read loop must
    // SKIP that rejection (parsePiEvent → null → not yielded), NOT terminate the
    // turn, and still complete on the real agent_end. Before Defect A's fix the
    // rejection became a terminal error result here — truncating the live answer
    // and relaying Pi's internal error to the user as the "answer".
    setTimeout(() => {
      stdout.push(JSON.stringify({ type: "turn_end", sessionId: "pi-real" }) + "\n");
      stdout.push(
        JSON.stringify({
          type: "response",
          command: "prompt",
          success: false,
          error:
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        }) + "\n",
      );
      stdout.push(piAgentEnd("final pi answer", "pi-real"));
    }, 30);

    const lines: { type: string; result?: string; is_error?: boolean }[] = [];
    for await (const line of gen) {
      lines.push(line as { type: string; result?: string; is_error?: boolean });
    }

    // Exactly one terminal result — from the real agent_end, NOT the rejection.
    const results = lines.filter((l) => l.type === "result");
    assert.strictEqual(results.length, 1, "the rejection must not produce a terminal result");
    assert.strictEqual(results[0].result, "final pi answer", "must relay the real answer, not Pi's error");
    assert.notStrictEqual(results[0].is_error, true, "the surviving result must not be an error");

    await manager.closeAll();
  });

  it("records Pi read-loop telemetry: one retry per auto_retry_start (not auto_retry_end) + one turn duration", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(() => dispatchConfig, TEST_STORE_PATH);

    // Metrics are global/cumulative — measure this turn's contribution as a delta.
    const retryCount = async (): Promise<number> =>
      (await piRetryTotal.get()).values.find((v) => v.labels.agent_id === "pi")?.value ?? 0;
    const turnDurationCount = async (): Promise<number> =>
      (await piTurnDuration.get()).values.find(
        (v) => v.metricName === "bot_pi_turn_duration_seconds_count" && v.labels.agent_id === "pi",
      )?.value ?? 0;
    const retryBefore = await retryCount();
    const durBefore = await turnDurationCount();

    const { child, stdout } = makeCapturingChild();
    injectSession(manager, "pi-telemetry", "pi", child);

    // A retry pair (start → end) followed by the terminal agent_end. The read
    // loop must count the retry exactly once (on auto_retry_start; auto_retry_end
    // signals recovery and would double-count) and record one turn duration.
    setTimeout(() => {
      stdout.push(JSON.stringify({ type: "auto_retry_start", errorMessage: "HTTP 429 rate limit" }) + "\n");
      stdout.push(JSON.stringify({ type: "auto_retry_end", errorMessage: "HTTP 429 rate limit" }) + "\n");
      stdout.push(piAgentEnd("done", "pi-real"));
    }, 30);

    for await (const _line of manager.sendSessionMessage("pi-telemetry", "pi", "go")) {
      void _line;
    }

    assert.strictEqual(
      (await retryCount()) - retryBefore,
      1,
      "exactly one retry counted (auto_retry_start only; auto_retry_end must not double-count)",
    );
    assert.strictEqual(
      (await turnDurationCount()) - durBefore,
      1,
      "exactly one Pi turn duration recorded on the terminal result",
    );

    await manager.closeAll();
  });

  it("does not re-read changed config before dispatching an active Pi session", async () => {
    const { SessionManager } = await import("../session-manager.js");
    // A mutable config the manager reloads on demand. The active session should
    // dispatch through its existing Pi child without reading the changed config.
    let liveConfig: BotConfig = dispatchConfig;
    const manager = new SessionManager(() => liveConfig, TEST_STORE_PATH);

    const { child, stdout, stdinWrites } = makeCapturingChild();
    injectSession(manager, "flip-chat", "main", child);

    liveConfig = {
      ...dispatchConfig,
      agents: { ...dispatchConfig.agents, main: { id: "main", workspaceCwd: "/tmp/test-workspace", model: "gpt-5.6" } },
    };

    const gen = manager.sendSessionMessage("flip-chat", "main", "hello");

    setTimeout(() => {
      stdout.push(piAgentEnd("pi answer", "pi-real"));
    }, 30);

    const lines: { type: string; result?: string }[] = [];
    for await (const line of gen) {
      lines.push(line as { type: string; result?: string });
    }

    // Send routed via Pi (a "prompt" command), proving no config dispatch switch.
    const sent = JSON.parse(stdinWrites[0]);
    assert.strictEqual(sent.type, "prompt", "must dispatch via Pi without reading the changed config");

    // Read routed via readPiStream: the Pi agent_end became the terminal result.
    const results = lines.filter((l) => l.type === "result");
    assert.strictEqual(results.length, 1, "Pi agent_end terminated the turn");
    assert.strictEqual(results[0].result, "pi answer");

    await manager.closeAll();
  });

  it("an active session does not re-read config before dispatch", async () => {
    const { SessionManager } = await import("../session-manager.js");
    // Manager boots on a valid config (constructor validates once), then the
    // loader starts throwing — modelling a hot-reload that produced a broken
    // config file. An ALREADY-LIVE session must still dispatch: getOrCreateSession
    // returns the existing child without reloading, so no config read happens on
    // the message path.
    let broken = false;
    const manager = new SessionManager(() => {
      if (broken) throw new Error("config reload failed");
      return dispatchConfig;
    }, TEST_STORE_PATH);

    const { child, stdout, stdinWrites } = makeCapturingChild();
    injectSession(manager, "broken-cfg-chat", "main", child);

    broken = true; // any later getFreshConfig() would now throw

    const gen = manager.sendSessionMessage("broken-cfg-chat", "main", "hello");

    setTimeout(() => {
      stdout.push(piAgentEnd("ok", "sid-broken-cfg-chat"));
    }, 30);

    const lines: { type: string; result?: string }[] = [];
    for await (const line of gen) {
      lines.push(line as { type: string; result?: string });
    }

    // The turn completed normally despite the broken loader — no config read on
    // the dispatch path. Send routed via the Pi prompt path.
    const sent = JSON.parse(stdinWrites[0]);
    assert.strictEqual(sent.type, "prompt", "Pi dispatch did not read broken config");
    const results = lines.filter((l) => l.type === "result");
    assert.strictEqual(results.length, 1, "turn completed despite broken config reload");
    assert.strictEqual(results[0].result, "ok");

    await manager.closeAll();
  });
});
