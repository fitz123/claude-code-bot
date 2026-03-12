import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { BotConfig } from "../types.js";

const TEST_DIR = "/tmp/openclaw-test-session-manager";
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
    yulia: {
      id: "yulia",
      workspaceCwd: "/tmp/test-workspace-yulia",
      model: "claude-opus-4-6",
    },
  },
  bindings: [
    { chatId: 123, agentId: "main", kind: "dm" },
    { chatId: 456, agentId: "yulia", kind: "dm" },
  ],
  sessionDefaults: {
    idleTimeoutMs: 100, // Short for testing
    maxConcurrentSessions: 2,
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
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["123", session]]);

    const gen = manager.sendSessionMessage("123", "main", "hello");

    // Push a text_delta line after a tick (readStream needs time to attach readline)
    setTimeout(() => {
      stdout.push(
        JSON.stringify({
          type: "assistant",
          subtype: "stream_event",
          event: { delta: { type: "text_delta", text: "Hello" } },
        }) + "\n"
      );
    }, 30);

    // First gen.next() should resolve with the text_delta BEFORE result is pushed.
    // In the old buffered implementation, this would hang forever (timeout)
    // because no lines were yielded until queue.add() fully resolved.
    const first = await gen.next();
    assert.ok(!first.done, "generator should not be done after first line");
    assert.strictEqual(first.value.type, "assistant");

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
    };
    (manager as unknown as Record<string, unknown>).active = new Map([["err-chat", session]]);

    const gen = manager.sendSessionMessage("err-chat", "main", "hello");

    // sendMessage should throw because stdin is destroyed
    await assert.rejects(async () => {
      for await (const _line of gen) {
        // consume
      }
    });

    await manager.closeAll();
  });
});
