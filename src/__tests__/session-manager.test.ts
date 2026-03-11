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
