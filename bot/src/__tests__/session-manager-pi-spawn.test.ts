import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { AgentConfig, BotConfig, StreamLine } from "../types.js";
// Real (un-mocked) modules — the SAME singletons session-manager imports, so a
// spy on log.warn and a read of piSessionResumeDiscarded observe its behavior.
import { log } from "../logger.js";
import { piSessionResumeDiscarded } from "../metrics.js";
import { ensureSessionMediaDir, sessionMediaDir, allocateMediaPath, releaseMediaPath } from "../media-store.js";
// Real protocol helpers the spawn-path capture needs (parse get_state replies).
// Resolved here BEFORE mock.module installs the stub, so these are the genuine
// implementations; the stub below re-exports them so capture parses correctly.
import { NewlineOnlyJsonlSplitter, normalizePiModel, parsePiRecord } from "../pi-rpc-protocol.js";

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

/** Args captured from the mocked Pi spawnPiRpcSession. */
interface PiSpawnCapture {
  agent: AgentConfig;
  resumeSessionId?: string;
}

const piSpawnCaptures: PiSpawnCapture[] = [];

/**
 * The session id the mocked readPiStream surfaces from get_state. Set to null to
 * model a Pi process that goes idle without ever emitting a SystemInit record
 * (capture must then fall back to the bot's local id).
 */
let nextPiSessionId: string | null = "pi-generated-id";
let suppressGetStateResponse = false;

/**
 * When set, the mocked sendPiGetState throws this error — models the
 * spawn-then-exit race where the child dies after waitForSpawn resolves but
 * before get_state is written (the real writePiCommand rejects a closed stdin).
 * Capture must swallow it and fall back to the local id, never escaping spawn.
 */
let getStateError: Error | null = null;

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

/**
 * Per-spawn outcomes consumed FIFO by the mocked spawnPiRpcSession. Empty → the
 * default "ok" auto-spawn, so the Task 3 capture/resume tests are unaffected.
 *  - `{ failStderr }` models a Pi process that fails BEFORE 'spawn' (it never
 *    emits 'spawn', exits 1 → waitForSpawn rejects). This is the rare edge path.
 *  - `{ spawnThenExitStderr }` models the REAL `pi` timing for a stale --session:
 *    it execs cleanly (emits 'spawn', so waitForSpawn RESOLVES) and only THEN
 *    exits 1. The resume failure surfaces during the get_state capture, not as a
 *    spawn rejection — the production path the recovery must actually cover.
 * Both expose their stderr via the same piStartupStderr accessor the real
 * spawnPiRpcSession installs (Pi prints `No session found matching <id>`).
 */
type PiSpawnOutcome = "ok" | { failStderr: string } | { spawnThenExitStderr: string };
let piSpawnOutcomes: PiSpawnOutcome[] = [];

/** A Pi child that fails startup (no 'spawn', exit 1) with buffered stderr. */
function createFailingPiChild(failStderr: string): ChildProcess {
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
    kill() {
      (child as unknown as Record<string, unknown>).killed = true;
      return true;
    },
  });

  // Mirror spawnPiRpcSession: expose buffered startup stderr so the spawn-failure
  // classifier can match Pi's "No session found matching" signal.
  (child as unknown as { piStartupStderr: () => string }).piStartupStderr = () => failStderr;

  // Fail startup: exit 1, never 'spawn' → waitForSpawn rejects with code=1.
  process.nextTick(() => {
    (child as unknown as Record<string, unknown>).exitCode = 1;
    child.emit("exit", 1, null);
  });

  return child;
}

/**
 * A Pi child that execs successfully (emits 'spawn', so waitForSpawn RESOLVES)
 * and only THEN exits 1 with buffered stderr — the REAL `pi` timing for a stale
 * --session. Node guarantees 'spawn' fires before all other events, so the
 * resume failure does NOT reach the waitForSpawn catch; it surfaces when the
 * get_state capture finds the child already dead. Marked `__resumeFailed` so the
 * mocked readPiStream yields no SystemInit (a dead process emits no records),
 * forcing capture to return null.
 */
function createSpawnThenExitChild(failStderr: string): ChildProcess {
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
    kill() {
      (child as unknown as Record<string, unknown>).killed = true;
      return true;
    },
  });

  (child as unknown as { piStartupStderr: () => string }).piStartupStderr = () => failStderr;
  (child as unknown as { __resumeFailed: boolean }).__resumeFailed = true;

  // Real timing: 'spawn' fires first (waitForSpawn resolves and drops its exit
  // listener), THEN exit 1. Set exitCode synchronously alongside the spawn emit
  // so hasExited(child) is already true by the time the capture completes.
  process.nextTick(() => {
    child.emit("spawn");
    (child as unknown as Record<string, unknown>).exitCode = 1;
    child.emit("exit", 1, null);
  });

  return child;
}

// ---------------------------------------------------------------------------
// Mock the Pi protocol module BEFORE importing session-manager so the mock is
// in place when session-manager's static imports resolve. The spawn path needs
// the REAL session-manager but stubbed protocol fns (mirrors hot-reload.test.ts).
// ---------------------------------------------------------------------------
mock.module("../pi-rpc-protocol.js", {
  namedExports: {
    spawnPiRpcSession(agent: AgentConfig, resumeSessionId?: string) {
      piSpawnCaptures.push({ agent, resumeSessionId });
      const outcome = piSpawnOutcomes.shift() ?? "ok";
      if (outcome === "ok") return createAutoSpawnChild();
      if ("failStderr" in outcome) return createFailingPiChild(outcome.failStderr);
      return createSpawnThenExitChild(outcome.spawnThenExitStderr);
    },
    sendPiGetState(child: ChildProcess) {
      if (getStateError) throw getStateError;
      if (suppressGetStateResponse) return;
      // capturePiSessionId reads child.stdout directly (abortable), so model Pi's
      // get_state reply by pushing the real JSONL record onto stdout. `null`
      // models a process that answers without a session id: end the stream so
      // capture returns promptly (close ends the read) instead of timing out.
      const stdout = child.stdout as Readable | undefined;
      if (!stdout) return;
      if (nextPiSessionId !== null) {
        stdout.push(
          JSON.stringify({ type: "response", success: true, data: { sessionId: nextPiSessionId } }) + "\n",
        );
      } else {
        stdout.push(null);
      }
    },
    sendPiPrompt() {},
    sendPiSteer() {},
    normalizePiModel,
    async *readPiStream(): AsyncGenerator<StreamLine> {
      // Message-path reader (unused by the spawn-path capture, which now reads
      // child.stdout directly). Present so session-manager's import resolves.
    },
    // Re-export the genuine parse helpers the capture uses.
    NewlineOnlyJsonlSplitter,
    parsePiRecord,
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
        model: "gpt-5.5",
      },
      pi: {
        id: "pi",
        workspaceCwd: "/tmp/test-workspace-pi",
        model: "gpt-5.5",
        provider: "pi",
        thinking: "xhigh",
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
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = "pi-generated-id";
    suppressGetStateResponse = false;
    getStateError = null;
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
    assert.strictEqual(session.provider, "pi");
    assert.strictEqual(session.model, "openai-codex/gpt-5.5");
    assert.strictEqual(session.thinking, "xhigh");

    const health = manager.getSessionHealth("pi-chat");
    assert.ok(health);
    assert.strictEqual(health.provider, "pi");
    assert.strictEqual(health.model, "openai-codex/gpt-5.5");
    assert.strictEqual(health.thinking, "xhigh");

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

  it("falls back to the bot's local id when get_state capture times out on an idle child", async () => {
    suppressGetStateResponse = true;

    const manager = new SessionManager(
      () => makeConfig(),
      TEST_STORE_PATH,
      undefined,
      { startupTimeoutMs: 20 },
    );
    const session = await manager.getOrCreateSession("pi-timeout", "pi");

    assert.ok(session.sessionId.length > 0, "session keeps a usable local id");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, undefined, "fresh start: no resume id");

    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      store.getSession("pi-timeout")?.sessionId,
      session.sessionId,
      "the local id is persisted after capture timeout",
    );

    await manager.closeAll();
  });

  it("get_state throwing (child died right after spawn) falls back to the local id, not an uncaught throw", async () => {
    // Spawn succeeds (waitForSpawn resolves on 'spawn'), but the child dies before
    // get_state is written, so sendPiGetState throws — the spawn-then-exit race.
    getStateError = new Error("Pi RPC child process is not available");

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    // getOrCreateSession must NOT reject: capture swallows the throw and the
    // session falls back to the bot's local id.
    const session = await manager.getOrCreateSession("pi-getstate-fail", "pi");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn, no recovery loop");
    assert.ok(session.sessionId.length > 0, "session keeps a usable local id");

    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      store.getSession("pi-getstate-fail")?.sessionId,
      session.sessionId,
      "the local id is persisted",
    );

    await manager.closeAll();
  });

  it("spawns an absent-provider agent via Pi and captures its Pi session id", async () => {
    nextPiSessionId = "main-pi-id";
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("main-chat", "main");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(piSpawnCaptures[0].agent.id, "main");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, undefined);
    assert.strictEqual(session.sessionId, "main-pi-id");
    assert.strictEqual(session.provider, "pi");
    assert.strictEqual(session.model, "openai-codex/gpt-5.5");
    assert.strictEqual(session.thinking, undefined);

    await manager.closeAll();
  });
});

describe("SessionManager Pi graceful resume-recovery (Task 4)", () => {
  /** Current value of the discard metric for an agent (0 if never set). */
  async function discardedCount(agentId: string): Promise<number> {
    const metric = await piSessionResumeDiscarded.get();
    const entry = metric.values.find((v) => v.labels.agent_id === agentId);
    return entry?.value ?? 0;
  }

  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = "pi-generated-id";
    getStateError = null;
    // The media-preserved assertions write into the test media root; clear each
    // chat's dir between runs so a prior run's file can't mask a regression.
    try { rmSync(sessionMediaDir("pi-keep"), { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(sessionMediaDir("pi-inflight"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    cleanup();
    try { rmSync(sessionMediaDir("pi-keep"), { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(sessionMediaDir("pi-inflight"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("missing-session signal: discards once, warns once, increments metric, then starts fresh", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-stale", {
      sessionId: "stored-pi-id",
      chatId: "pi-stale",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // The resume spawn fails with Pi's "No session found" signal; the inline
    // fresh re-spawn then succeeds and get_state mints a new id.
    piSpawnOutcomes = [{ failStderr: "No session found matching stored-pi-id" }];
    nextPiSessionId = "fresh-pi-id";

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    let session;
    try {
      session = await manager.getOrCreateSession("pi-stale", "pi");
    } finally {
      warnSpy.mock.restore();
    }

    // Exactly two spawns: the failed resume, then ONE inline fresh start.
    assert.strictEqual(piSpawnCaptures.length, 2, "resume spawn + one inline fresh re-spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "first spawn resumed the stored id");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn starts fresh (no --session)");

    // The recovered session is live on the freshly-captured id, and it's persisted.
    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered session adopts the new Pi id");
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-stale")?.sessionId, "fresh-pi-id", "fresh id persisted");

    // Exactly one discard warning + one metric increment.
    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session stored-pi-id — starting fresh"),
    );
    assert.strictEqual(recoveryWarns.length, 1, "exactly one recovery warning");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "metric incremented exactly once");

    await manager.closeAll();
  });

  it("resume-recovery preserves the current turn's in-flight media while discarding the stored id", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-inflight", {
      sessionId: "stored-pi-id",
      chatId: "pi-inflight",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // The triggering turn already staged a media file under this chat's dir and
    // it is tracked as in-flight (allocateMediaPath registers it). The fresh Pi
    // session's prompt will reference this path, so recovery must NOT delete it.
    const inflightPath = allocateMediaPath("pi-inflight", "photo", ".jpg");
    writeFileSync(inflightPath, "current turn media");
    // A leftover from the prior (now-unresumable) session — NOT in-flight. This
    // SHOULD be swept by the stale cleanup.
    const stalePath = `${sessionMediaDir("pi-inflight")}/prior-session.jpg`;
    writeFileSync(stalePath, "stale leftover");

    // Resume fails with the "No session found" signal → recovery fires; the
    // inline fresh re-spawn then succeeds.
    piSpawnOutcomes = [{ failStderr: "No session found matching stored-pi-id" }];
    nextPiSessionId = "fresh-pi-id";

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const warnSpy = mock.method(log, "warn", () => {});
    let session;
    try {
      session = await manager.getOrCreateSession("pi-inflight", "pi");
    } finally {
      warnSpy.mock.restore();
    }

    // Recovery happened: fresh id adopted, stored id discarded (then re-persisted
    // with the fresh id by the successful spawn).
    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered onto the fresh id");

    // The in-flight file for the current turn SURVIVES (the bug fix): the fresh
    // Pi session's prompt can still reach it.
    assert.ok(existsSync(inflightPath), "in-flight media for the current turn is preserved across recovery");
    // The prior-session leftover is swept (it was not in-flight).
    assert.strictEqual(existsSync(stalePath), false, "prior-session media leftover is removed");

    releaseMediaPath(inflightPath);
    await manager.closeAll();
  });

  it("both spawns fail: discards once, warns once, then throws — no loop", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-doomed", {
      sessionId: "stored-pi-id",
      chatId: "pi-doomed",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // Resume fails with the signal; the inline fresh re-spawn ALSO fails. The
    // second failure must propagate (no third spawn, no recursion).
    piSpawnOutcomes = [
      { failStderr: "No session found matching stored-pi-id" },
      { failStderr: "still broken on the fresh start" },
    ];

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    try {
      await assert.rejects(
        () => manager.getOrCreateSession("pi-doomed", "pi"),
        /exited during startup/,
        "the second (fresh) failure propagates as a startup error",
      );
    } finally {
      warnSpy.mock.restore();
    }

    // At-most-once: exactly two spawn attempts (resume + one fresh), no loop.
    assert.strictEqual(piSpawnCaptures.length, 2, "exactly two spawns — recovery does not loop");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn was a fresh start");

    // The discard + warn + metric ran exactly once despite the fresh start failing.
    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session stored-pi-id — starting fresh"),
    );
    assert.strictEqual(recoveryWarns.length, 1, "exactly one recovery warning");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "metric incremented exactly once");

    // The final failure feeds the normal crash backoff (restart count increments).
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("pi-doomed"), 1, "second failure increments the crash count");
  });

  it("preserves an accumulated crash count across a resume-recovery discard", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-flap", {
      sessionId: "stored-pi-id",
      chatId: "pi-flap",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // Resume fails with the signal; the inline fresh re-spawn then succeeds.
    piSpawnOutcomes = [{ failStderr: "No session found matching stored-pi-id" }];
    nextPiSessionId = "fresh-pi-id";

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    // Seed a prior crash history. The recovery discard routes through
    // destroySession → closeSession, which clears restartCounts; the fix must
    // restore the count so a flapping chat keeps advancing toward the circuit
    // breaker instead of resetting to zero on every recovery. (prevCrashCount=1
    // triggers a ~5s crash backoff before the spawn — expected.)
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    restartCounts.set("pi-flap", 1);

    const warnSpy = mock.method(log, "warn", () => {});
    let session;
    try {
      session = await manager.getOrCreateSession("pi-flap", "pi");
    } finally {
      warnSpy.mock.restore();
    }

    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered onto the fresh id");
    assert.strictEqual(
      restartCounts.get("pi-flap"),
      1,
      "prior crash count survives the recovery discard (not reset to 0)",
    );

    await manager.closeAll();
  });

  it("non-matching startup failure: no discard, stored id + media preserved, normal backoff", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-keep", {
      sessionId: "keep-pi-id",
      chatId: "pi-keep",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // A media file from a prior turn — a non-recovery failure must preserve it so
    // a later successful resume can still reference it.
    const mediaDir = ensureSessionMediaDir("pi-keep");
    const mediaFile = `${mediaDir}/prior-turn.jpg`;
    writeFileSync(mediaFile, "keep me");

    // Resume fails, but NOT with the "No session found" signal → no recovery.
    piSpawnOutcomes = [{ failStderr: "codex: authentication token expired" }];

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    try {
      await assert.rejects(
        () => manager.getOrCreateSession("pi-keep", "pi"),
        /exited during startup/,
        "a non-matching failure propagates unchanged",
      );
    } finally {
      warnSpy.mock.restore();
    }

    // Exactly one spawn — no inline recovery re-spawn.
    assert.strictEqual(piSpawnCaptures.length, 1, "no recovery spawn for a non-matching failure");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "keep-pi-id", "the resume attempt used the stored id");

    // No discard: stored id preserved (NOT deleted), media dir preserved.
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-keep")?.sessionId, "keep-pi-id", "stored id preserved");
    assert.ok(existsSync(mediaFile), "media file preserved on a non-recovery failure");

    // No recovery warning, metric untouched.
    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session"),
    );
    assert.strictEqual(recoveryWarns.length, 0, "no recovery warning for a non-matching failure");
    assert.strictEqual((await discardedCount("pi")) - before, 0, "metric not incremented");

    // Existing crash backoff still applies.
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("pi-keep"), 1, "non-matching failure increments the crash count");
  });

  // The tests above drive failure via createFailingPiChild, which never emits
  // 'spawn' — an edge that a real exec'd binary cannot produce. The tests below
  // use createSpawnThenExitChild, which mirrors REAL `pi` timing: it execs
  // (emits 'spawn', so waitForSpawn RESOLVES) and only THEN exits 1. This is the
  // production path the recovery must cover — the failure surfaces during the
  // get_state capture, not as a spawn rejection.

  it("real pi timing (spawn then exit 1 with the signal): recovery still fires", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-real", {
      sessionId: "stored-pi-id",
      chatId: "pi-real",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // The resume spawn execs then exits 1 with the signal (real timing); the
    // inline fresh re-spawn then succeeds and get_state mints a new id.
    piSpawnOutcomes = [{ spawnThenExitStderr: "No session found matching stored-pi-id" }];
    nextPiSessionId = "fresh-pi-id";

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    let session;
    try {
      session = await manager.getOrCreateSession("pi-real", "pi");
    } finally {
      warnSpy.mock.restore();
    }

    // Exactly two spawns: the failed resume, then ONE inline fresh start — even
    // though waitForSpawn RESOLVED for the failed resume (this is the bug fix).
    assert.strictEqual(piSpawnCaptures.length, 2, "resume spawn + one inline fresh re-spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "first spawn resumed the stored id");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn starts fresh (no --session)");

    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered session adopts the new Pi id");
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-real")?.sessionId, "fresh-pi-id", "fresh id persisted");

    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session stored-pi-id — starting fresh"),
    );
    assert.strictEqual(recoveryWarns.length, 1, "exactly one recovery warning");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "metric incremented exactly once");

    await manager.closeAll();
  });

  it("real pi timing (spawn then exit 1 with a non-matching error): no discard, crash count increments", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-real-keep", {
      sessionId: "keep-pi-id",
      chatId: "pi-real-keep",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // Execs then exits 1, but NOT with the "No session found" signal → no recovery.
    piSpawnOutcomes = [{ spawnThenExitStderr: "codex: authentication token expired" }];

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    try {
      await assert.rejects(
        () => manager.getOrCreateSession("pi-real-keep", "pi"),
        /exited during startup/,
        "a non-matching post-spawn exit propagates as a startup error",
      );
    } finally {
      warnSpy.mock.restore();
    }

    // Exactly one spawn — no inline recovery re-spawn.
    assert.strictEqual(piSpawnCaptures.length, 1, "no recovery spawn for a non-matching failure");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "keep-pi-id", "the resume attempt used the stored id");

    // No discard: stored id preserved.
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-real-keep")?.sessionId, "keep-pi-id", "stored id preserved");

    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session"),
    );
    assert.strictEqual(recoveryWarns.length, 0, "no recovery warning for a non-matching failure");
    assert.strictEqual((await discardedCount("pi")) - before, 0, "metric not incremented");

    // A post-spawn startup exit must still feed crash backoff (the bug fix also
    // closes the gap where a spawned-then-died child created a session with no
    // crash count and could tight-loop).
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("pi-real-keep"), 1, "post-spawn startup exit increments the crash count");
  });
});
