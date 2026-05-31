import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { AgentConfig, BotConfig, StreamLine } from "../types.js";

const TEST_DIR = "/tmp/minime-test-pi-spawn";
const TEST_STORE_PATH = `${TEST_DIR}/sessions.json`;

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Captures + tunables driven by the module mocks below.
// ---------------------------------------------------------------------------

/** Opts captured from the mocked claude spawnClaudeSession. */
interface ClaudeSpawnOpts {
  agent: { model: string; [key: string]: unknown };
  sessionId?: string;
  resume?: boolean;
  [key: string]: unknown;
}

/** Args captured from the mocked Pi spawnPiRpcSession. */
interface PiSpawnCapture {
  agent: AgentConfig;
  resumeSessionId?: string;
}

const claudeSpawnCaptures: ClaudeSpawnOpts[] = [];
const piSpawnCaptures: PiSpawnCapture[] = [];

/**
 * The session id the mocked readPiStream surfaces from get_state. Set to null to
 * model a Pi process that goes idle without ever emitting a SystemInit record
 * (capture must then fall back to the bot's local id).
 */
let nextPiSessionId: string | null = "pi-generated-id";

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
        child.emit("exit", signal === "SIGKILL" ? 137 : 0, signal ?? "SIGTERM");
      });
      return true;
    },
  });

  process.nextTick(() => child.emit("spawn"));

  return child;
}

// ---------------------------------------------------------------------------
// Mock BOTH protocol modules BEFORE importing session-manager so the mocks are
// in place when session-manager's static imports resolve. The spawn path needs
// the REAL session-manager but stubbed protocol fns (mirrors hot-reload.test.ts).
// ---------------------------------------------------------------------------
mock.module("../cli-protocol.js", {
  namedExports: {
    spawnClaudeSession(opts: ClaudeSpawnOpts) {
      claudeSpawnCaptures.push(opts);
      return createAutoSpawnChild();
    },
    sendMessage() {},
    async *readStream(): AsyncGenerator<StreamLine> {},
  },
});

mock.module("../pi-rpc-protocol.js", {
  namedExports: {
    spawnPiRpcSession(agent: AgentConfig, resumeSessionId?: string) {
      piSpawnCaptures.push({ agent, resumeSessionId });
      return createAutoSpawnChild();
    },
    sendPiGetState() {},
    sendPiPrompt() {},
    async *readPiStream(): AsyncGenerator<StreamLine> {
      if (nextPiSessionId !== null) {
        yield { type: "system", subtype: "init", session_id: nextPiSessionId };
      }
    },
  },
});

const { SessionManager } = await import("../session-manager.js");
const { SessionStore } = await import("../session-store.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(): BotConfig {
  return {
    telegramToken: "test-token",
    agents: {
      main: {
        id: "main",
        workspaceCwd: "/tmp/test-workspace",
        model: "claude-opus-4-6",
      },
      pi: {
        id: "pi",
        workspaceCwd: "/tmp/test-workspace-pi",
        model: "gpt-5.5",
        provider: "pi",
      },
    },
    bindings: [
      { chatId: 123, agentId: "main", kind: "dm" as const },
      { chatId: 456, agentId: "pi", kind: "dm" as const },
    ],
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

describe("SessionManager Pi session-id capture + resume", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    claudeSpawnCaptures.length = 0;
    piSpawnCaptures.length = 0;
    nextPiSessionId = "pi-generated-id";
  });

  afterEach(() => {
    cleanup();
  });

  it("captures the Pi-minted session id via get_state and persists it", async () => {
    nextPiSessionId = "pi-generated-id";
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    const session = await manager.getOrCreateSession("pi-chat", "pi");

    // A fresh Pi spawn must NOT pass --session (no resume id).
    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, undefined, "fresh start: no resume id");

    // The in-memory session adopts the Pi-minted id (not the local UUID).
    assert.strictEqual(session.sessionId, "pi-generated-id", "session uses the captured Pi id");

    // ...and the captured id is persisted for resume across restarts.
    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      store.getSession("pi-chat")?.sessionId,
      "pi-generated-id",
      "captured Pi id is persisted to the store",
    );

    await manager.closeAll();
  });

  it("resumes a stored Pi session by spawning with the stored id as --session", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-resume", {
      sessionId: "stored-pi-id",
      chatId: "pi-resume",
      agentId: "pi",
      lastActivity: Date.now(),
    });
    // On resume, Pi re-confirms the same id through get_state.
    nextPiSessionId = "stored-pi-id";

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-resume", "pi");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(
      piSpawnCaptures[0].resumeSessionId,
      "stored-pi-id",
      "resume passes the stored Pi id as --session",
    );
    assert.strictEqual(session.sessionId, "stored-pi-id", "resumed session keeps its id");

    await manager.closeAll();
  });

  it("falls back to the bot's local id when get_state surfaces no session id", async () => {
    nextPiSessionId = null; // process goes idle without a SystemInit record

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-noid", "pi");

    // The session stays functional on its locally-generated id (resume just
    // can't target it; Task 4 recovery handles a later "No session found").
    assert.ok(session.sessionId.length > 0, "session keeps a usable local id");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, undefined, "fresh start: no resume id");

    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      store.getSession("pi-noid")?.sessionId,
      session.sessionId,
      "the local id is persisted",
    );

    await manager.closeAll();
  });

  it("claude path bot-generates --session-id and never issues get_state (regression)", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("claude-chat", "main");

    assert.strictEqual(claudeSpawnCaptures.length, 1, "one claude spawn");
    assert.strictEqual(claudeSpawnCaptures[0].resume, false, "fresh claude session does not resume");
    assert.ok(
      typeof claudeSpawnCaptures[0].sessionId === "string" && claudeSpawnCaptures[0].sessionId.length > 0,
      "claude path bot-generates a --session-id",
    );

    // No get_state override: the session keeps the bot-generated id exactly.
    assert.strictEqual(
      session.sessionId,
      claudeSpawnCaptures[0].sessionId,
      "claude session keeps the bot-generated id (no Pi capture override)",
    );
    // The claude path must not have touched the Pi spawn path at all.
    assert.strictEqual(piSpawnCaptures.length, 0, "claude path must not spawn a Pi process");

    await manager.closeAll();
  });
});
