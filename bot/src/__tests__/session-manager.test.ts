import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable, PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { BotConfig } from "../types.js";
import { waitForSpawn, outboxDir, type ActiveSession } from "../session-manager.js";
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
      model: "claude-opus-4-6",
    },
    "agent-b": {
      id: "agent-b",
      workspaceCwd: "/tmp/test-workspace-b",
      model: "claude-opus-4-6",
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

// We need to mock spawnClaudeSession to return our mock child
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
    assert.strictEqual(manager.getActiveCount(), 0);
  });

  it("closeAll works on empty manager", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
    await manager.closeAll();
    assert.strictEqual(manager.getActiveCount(), 0);
  });

  it("getActive returns undefined for unknown chatId", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
    assert.strictEqual(manager.getActive("unknown"), undefined);
  });

  it("closeSession is safe for unknown chatId", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
    // Should not throw
    await manager.closeSession("nonexistent");
  });

  it("throws for unknown agent", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
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

    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
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

    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
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

    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
    const result = manager.resolveStoredSession("chat-1", "main");

    assert.strictEqual(result.resume, false, "should not resume session with deleted agent");
    assert.notStrictEqual(result.sessionId, "orphan-session-id", "should generate a fresh sessionId");

    // Verify store cleanup
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("chat-1"), undefined, "orphan session should be deleted");
  });

  it("creates fresh session when no stored session exists", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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

    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
    const result = manager.resolveStoredSession("chat-1", "main");
    assert.strictEqual(result.resume, false, "should not resume empty sessionId");
  });
});

describe("SessionManager idle timer logic", () => {
  it("resetIdleTimer is safe for unknown chatId", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
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
    const manager = new SessionManager(restrictedConfig, TEST_STORE_PATH);
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["123", session]]);

    const gen = manager.sendSessionMessage("123", "main", "hello");

    // Push a text_delta line after a tick (readStream needs time to attach readline)
    setTimeout(() => {
      stdout.push(
        JSON.stringify({
          type: "stream_event",
          event: { delta: { type: "text_delta", text: "Hello" } },
        }) + "\n"
      );
    }, 30);

    // First gen.next() should resolve with the text_delta BEFORE result is pushed.
    // In the old buffered implementation, this would hang forever (timeout)
    // because no lines were yielded until queue.add() fully resolved.
    const first = await gen.next();
    assert.ok(!first.done, "generator should not be done after first line");
    assert.strictEqual(first.value.type, "stream_event");

    // Now push the result — proves first line was streamed in real-time
    stdout.push(
      JSON.stringify({
        type: "result",
        result: "Hello",
        session_id: "test-session",
      }) + "\n"
    );

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

    // Create a child with a destroyed stdin to trigger an error in sendMessage
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
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: "/tmp/bot-outbox/test",
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["err-chat", session]]);

    const gen = manager.sendSessionMessage("err-chat", "main", "hello");

    // sendMessage should throw because stdin is destroyed
    await assert.rejects(async () => {
      for await (const _line of gen) {
        // consume
      }
    }, /Child process is not available/);

    await manager.closeAll();
  });

  it("throws when subprocess dies before sending result", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
      stdout.push(
        JSON.stringify({
          type: "stream_event",
          event: { delta: { type: "text_delta", text: "partial" } },
        }) + "\n"
      );
      // Close stdout without sending a result — simulates process death
      stdout.push(null);
    }, 30);

    // Consuming the generator should yield the partial line then throw
    await assert.rejects(async () => {
      for await (const _line of gen) {
        // consume
      }
    }, /subprocess exited before sending a result/);

    await manager.closeAll();
  });

  it("catches EPIPE on stdin without crashing the process", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
    }, /subprocess exited before sending a result/);

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
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      child.emit("error", err);
    }, 10);

    await assert.rejects(
      () => waitForSpawn(child, 1000),
      /Claude subprocess failed to start: spawn claude ENOENT/
    );
  });

  it("rejects when child exits immediately (e.g. auth failure)", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { pid: 1, exitCode: null, killed: false });

    setTimeout(() => child.emit("exit", 1, null), 10);

    await assert.rejects(
      () => waitForSpawn(child, 1000),
      /Claude subprocess exited during startup: code=1 signal=null/
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
      /Claude subprocess did not start within 50ms/
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH, nestedDir);

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH, STDERR_LOG_DIR);

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
    assert.strictEqual(manager.getSessionHealth("unknown"), undefined);
  });

  it("returns health info for an alive session", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
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
    assert.ok(health.idleMs >= 5000, "idle should be at least 5s");
    assert.strictEqual(health.processingMs, null);
    assert.strictEqual(health.lastSuccessAt, now - 10000);
    assert.strictEqual(health.restartCount, 2);
  });

  it("returns processing duration when session is processing", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const PQueue = (await import("p-queue")).default;
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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

      stdout.push(
        JSON.stringify({
          type: "result",
          result: "done",
          session_id: "proc-track-test",
        }) + "\n"
      );
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    // Use crash count 1 (not MAX-1) to keep backoff delay short (5s vs 40s)
    restartCounts.set("ok-chat", 1);

    // This should not throw from backoff — it will throw from spawnClaudeSession
    // because we're not mocking it, but we verify the error is NOT "Session blocked"
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
      stdout.push(
        JSON.stringify({
          type: "result",
          result: "Success",
          session_id: "success-session",
        }) + "\n"
      );
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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

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
    opts: { processing: boolean; injectDir: string },
  ): { queue: PQueue; child: ChildProcess } {
    const activeMap = (manager as unknown as Record<string, Map<string, ActiveSession>>).active;
    const child = createMockChild();
    child.emit("spawn");
    const queue = new PQueue({ concurrency: 1 });

    activeMap.set(chatId, {
      child,
      sessionId: "test-session-" + chatId,
      agentId: "main",
      queue,
      idleTimer: null,
      lastActivity: Date.now(),
      processingStartedAt: opts.processing ? Date.now() : null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: `${TEST_DIR}/outbox-${chatId}`,
      injectDir: opts.injectDir,
    });

    return { queue, child };
  }

  it("returns immediately with no active sessions", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);
    await manager.gracefulShutdown(5000);
    assert.strictEqual(manager.getActiveCount(), 0);
  });

  it("returns immediately when active sessions are idle (not processing)", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

    const injectDir = `${TEST_DIR}/inject-idle`;
    mkdirSync(injectDir, { recursive: true });
    insertMockSession(manager, "idle-chat", { processing: false, injectDir });

    await manager.gracefulShutdown(5000);
    // Should not have written inject file for idle session
    assert.strictEqual(existsSync(`${injectDir}/pending`), false, "no inject file for idle session");
  });

  it("writes shutdown inject file for busy sessions", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

    const injectDir = `${TEST_DIR}/inject-busy`;
    mkdirSync(injectDir, { recursive: true });
    const { queue } = insertMockSession(manager, "busy-chat", { processing: true, injectDir });

    // Keep the queue busy so gracefulShutdown has something to wait for
    let resolveTask!: () => void;
    const taskPromise = queue.add(() => new Promise<void>(r => { resolveTask = r; }));

    const shutdownPromise = manager.gracefulShutdown(200);

    // Check inject file was written
    const content = readFileSync(`${injectDir}/pending`, "utf-8");
    assert.ok(content.includes("shutting down"), "inject file should contain shutdown message");
    assert.ok(content.includes("Do NOT attempt to restart"), "inject file should warn against restart");

    // Let the task finish
    resolveTask();
    await taskPromise;
    await shutdownPromise;
  });

  it("waits for busy session to finish within timeout", async () => {
    const { SessionManager } = await import("../session-manager.js");
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

    const injectDir = `${TEST_DIR}/inject-wait`;
    mkdirSync(injectDir, { recursive: true });
    const { queue } = insertMockSession(manager, "wait-chat", { processing: true, injectDir });

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

    const injectDir = `${TEST_DIR}/inject-timeout`;
    mkdirSync(injectDir, { recursive: true });
    const { queue } = insertMockSession(manager, "slow-chat", { processing: true, injectDir });

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
    const manager = new SessionManager(testConfig, TEST_STORE_PATH);

    const idleInjectDir = `${TEST_DIR}/inject-mix-idle`;
    const busyInjectDir = `${TEST_DIR}/inject-mix-busy`;
    mkdirSync(idleInjectDir, { recursive: true });
    mkdirSync(busyInjectDir, { recursive: true });

    insertMockSession(manager, "idle-mix", { processing: false, injectDir: idleInjectDir });
    const { queue } = insertMockSession(manager, "busy-mix", { processing: true, injectDir: busyInjectDir });

    let resolveTask!: () => void;
    const taskPromise = queue.add(() => new Promise<void>(r => { resolveTask = r; }));

    const shutdownPromise = manager.gracefulShutdown(200);

    // Only busy session should get inject file
    assert.strictEqual(existsSync(`${idleInjectDir}/pending`), false, "idle session should not get inject");
    assert.strictEqual(existsSync(`${busyInjectDir}/pending`), true, "busy session should get inject");

    resolveTask();
    await taskPromise;
    await shutdownPromise;
  });
});

