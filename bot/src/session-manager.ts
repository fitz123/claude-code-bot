import { type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import PQueue from "p-queue";
import type { SessionState, StreamLine, BotConfig } from "./types.js";
import { spawnClaudeSession, sendMessage, readStream } from "./cli-protocol.js";
import { SessionStore } from "./session-store.js";
import { log } from "./logger.js";
import { recordResultMetrics, sessionsActive, sessionCrashes } from "./metrics.js";
import { injectDirForChat, cleanupInjectDir, writeInjectFile } from "./inject-file.js";
import { ensureSessionMediaDir, cleanupSessionMediaDir } from "./media-store.js";

const LOG_DIR = process.env.LOG_DIR ?? join(homedir(), ".minime", "logs");
const OUTBOX_BASE = "/tmp/bot-outbox";
const STARTUP_TIMEOUT_MS = 10_000;
const RESPONSE_ACTIVITY_TIMEOUT_MS = 1_800_000; // 30 minutes with no events = hung
const CRASH_BACKOFF_BASE_MS = 5_000; // Base delay for crash backoff
const MAX_CRASH_BACKOFF_MS = 60_000; // Maximum backoff delay (1 minute)
export const MAX_CRASH_RESTARTS = 5; // Block session after this many consecutive crashes

/** Deterministic outbox directory path for a given chat. */
export function outboxDir(chatId: string): string {
  const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${OUTBOX_BASE}/${safeChatId}`;
}

/** Check whether a child process has exited (by exit code or signal). */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export interface ActiveSession {
  child: ChildProcess;
  sessionId: string;
  agentId: string;
  queue: PQueue;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Idle timeout baked at spawn time from config. */
  idleTimeoutMs: number;
  lastActivity: number;
  /** Timestamp when current turn started processing, null if idle. */
  processingStartedAt: number | null;
  /** Timestamp of last successful response (result received). */
  lastSuccessAt: number | null;
  /** Number of times this session's subprocess was restarted. */
  restartCount: number;
  /** Per-session outbox directory for file delivery. */
  outboxPath: string;
  /** Per-session inject directory for mid-turn message delivery. */
  injectDir: string;
}

export interface SessionHealth {
  pid: number | null;
  alive: boolean;
  agentId: string;
  sessionId: string;
  idleMs: number;
  /** Milliseconds since current turn started, or null if not processing. */
  processingMs: number | null;
  /** Timestamp of last successful response, or null if none yet. */
  lastSuccessAt: number | null;
  restartCount: number;
}

/**
 * Wait for a child process to emit 'spawn' (successful start).
 * Rejects if the process emits 'error', exits early, or times out.
 */
export function waitForSpawn(child: ChildProcess, timeoutMs: number = STARTUP_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      removeListeners();
      child.kill("SIGKILL");
      reject(new Error(`Claude subprocess did not start within ${timeoutMs}ms`));
    }, timeoutMs);

    function removeListeners() {
      clearTimeout(timer);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    }

    function onSpawn() {
      removeListeners();
      resolve();
    }

    function onError(err: Error) {
      removeListeners();
      reject(new Error(`Claude subprocess failed to start: ${err.message}`));
    }

    function onExit(code: number | null, signal: string | null) {
      removeListeners();
      reject(new Error(`Claude subprocess exited during startup: code=${code} signal=${signal}`));
    }

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export class SessionManager {
  private active: Map<string, ActiveSession> = new Map();
  /** Restart counts survive crash recovery (active.delete) so they accumulate. */
  private restartCounts: Map<string, number> = new Map();
  private store: SessionStore;
  private loadConfig: () => BotConfig;
  private logDir: string;

  constructor(loadConfig: () => BotConfig, storePath?: string, logDir?: string) {
    this.loadConfig = loadConfig;
    // Validate config at boot — fail fast if config is broken
    loadConfig();
    this.store = new SessionStore(storePath);
    this.logDir = logDir ?? LOG_DIR;
  }

  /**
   * Load fresh config for use at each decision point (spawn, eviction, idle timer).
   * On failure, propagates the error — no cache fallback.
   */
  private getFreshConfig(): BotConfig {
    try {
      const config = this.loadConfig();
      log.debug("session-manager", "config: reload ok");
      return config;
    } catch (err) {
      log.error("session-manager", `config: reload failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Build a SessionState snapshot for persisting to the store. */
  private toSessionState(chatId: string, session: ActiveSession): SessionState {
    return {
      sessionId: session.sessionId,
      chatId,
      agentId: session.agentId,
      lastActivity: session.lastActivity,
    };
  }

  /**
   * Get or create a session for a given chatId.
   * If a session exists in memory with a live process, reuse it.
   * If a session exists in store but process is dead, respawn with --resume.
   * If no session exists, create a fresh one.
   * Enforces maxConcurrentSessions via LRU eviction.
   */
  async getOrCreateSession(chatId: string, agentId: string): Promise<ActiveSession> {
    // Check if session is active in memory
    const existing = this.active.get(chatId);
    if (existing && !hasExited(existing.child) && !existing.child.killed) {
      existing.lastActivity = Date.now();
      this.resetIdleTimer(chatId);
      return existing;
    }

    // If we had an active entry but child is dead/dying, clean it up
    if (existing) {
      // Clear idle timer to prevent it from closing the new session
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      // Ensure the child is actually dead before discarding the session;
      // a SIGTERM may have been sent (child.killed=true) but the process
      // could still be running if it ignored the signal.
      if (!hasExited(existing.child)) {
        existing.child.kill("SIGKILL");
      }
      this.active.delete(chatId);
      sessionsActive.dec();
    }

    // Reload config fresh — pick up any changes to agents/sessionDefaults
    const freshConfig = this.getFreshConfig();
    const agent = freshConfig.agents[agentId];
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // Check if we need to evict
    await this.evictIfNeeded(freshConfig);

    // Check if we have a stored session to resume (discards stale sessions)
    const { resume, sessionId } = this.resolveStoredSession(chatId, agentId, freshConfig);

    // Crash backoff: prevent rapid crash→spawn→crash loops
    const prevCrashCount = this.restartCounts.get(chatId) ?? 0;
    if (prevCrashCount >= MAX_CRASH_RESTARTS) {
      log.error("session-manager", `Session for chat ${chatId} blocked after ${prevCrashCount} consecutive crashes — use /reconnect to unblock`);
      throw new Error(`Session blocked: ${prevCrashCount} consecutive crashes for chat ${chatId}`);
    }
    if (prevCrashCount > 0) {
      const delayMs = Math.min(CRASH_BACKOFF_BASE_MS * 2 ** (prevCrashCount - 1), MAX_CRASH_BACKOFF_MS);
      log.warn("session-manager", `Crash backoff: ${delayMs}ms for chat ${chatId} (crash #${prevCrashCount})`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // Clean and recreate outbox directory to prevent stale files from
    // a previous crashed session from leaking into the new session's replies.
    const outboxPath = outboxDir(chatId);
    rmSync(outboxPath, { recursive: true, force: true });
    mkdirSync(outboxPath, { recursive: true });

    // Clean and recreate inject directory for mid-turn message delivery
    const injectPath = injectDirForChat(chatId);
    cleanupInjectDir(injectPath);
    mkdirSync(injectPath, { recursive: true });

    // Ensure media directory exists (do NOT wipe: a photo may have been
    // downloaded into it moments before this spawn was triggered).
    // Cleanup happens on session close, crash recovery, and via the global cap.
    ensureSessionMediaDir(chatId);

    // Spawn the claude subprocess
    const child = spawnClaudeSession({
      agent,
      sessionId,
      resume,
      includePartialMessages: true,
      outboxPath,
      injectDir: injectPath,
    });

    // Verify the subprocess actually started
    try {
      await waitForSpawn(child, STARTUP_TIMEOUT_MS);
    } catch (err) {
      // Ensure child is dead before throwing
      if (!hasExited(child) && !child.killed) {
        child.kill("SIGKILL");
      }
      // Increment crash count so startup failures contribute to backoff
      const count = (this.restartCounts.get(chatId) ?? 0) + 1;
      this.restartCounts.set(chatId, count);
      log.error("session-manager", `Startup failure for chat ${chatId} (crash #${count}): ${(err as Error).message}`);
      throw err;
    }

    // Prevent EPIPE from becoming uncaughtException when subprocess dies
    child.stdin?.on("error", (err) => {
      log.error("session-manager", `stdin error for chat ${chatId}: ${err.message}`);
    });

    // Pipe stderr to log file
    this.setupStderrLogging(chatId, child);

    // Restart/crash count accumulates via setupCrashRecovery and survives
    // active.delete(). Reset to 0 for fresh sessions (no existing, no resume).
    const restartCount = this.restartCounts.get(chatId) ?? 0;
    if (!existing && !resume) {
      this.restartCounts.set(chatId, 0);
    }

    const session: ActiveSession = {
      child,
      sessionId,
      agentId,
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: freshConfig.sessionDefaults.idleTimeoutMs,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount,
      outboxPath,
      injectDir: injectPath,
    };

    this.active.set(chatId, session);
    sessionsActive.inc();

    // Persist to store
    this.store.setSession(chatId, this.toSessionState(chatId, session));

    // Set up crash recovery
    this.setupCrashRecovery(chatId, child);

    // Start idle timer
    this.resetIdleTimer(chatId);

    return session;
  }

  /**
   * Send a message to a session, creating it if needed.
   * Returns an async generator of parsed stream lines.
   * Messages are queued per-session (concurrency=1).
   */
  async *sendSessionMessage(
    chatId: string,
    agentId: string,
    text: string
  ): AsyncGenerator<StreamLine> {
    const session = await this.getOrCreateSession(chatId, agentId);

    // Async channel: queue task pushes lines, generator yields them in real-time
    const buffer: StreamLine[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    let taskError: Error | null = null;

    const push = (line: StreamLine) => {
      buffer.push(line);
      if (notify) {
        notify();
        notify = null;
      }
    };

    const finish = (err?: Error) => {
      if (err) taskError = err;
      done = true;
      if (notify) {
        notify();
        notify = null;
      }
    };

    // Start the queue task — do NOT await, so we can yield concurrently
    const taskPromise = session.queue.add(async () => {
      let activityTimer: ReturnType<typeof setTimeout> | null = null;
      let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;
      const clearActivityTimers = () => {
        if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
        // Only cancel the SIGKILL escalation if the child has already exited;
        // if SIGTERM was sent and the child is still alive, let escalation
        // complete to avoid orphaning the process.
        if (killEscalationTimer && hasExited(session.child)) {
          clearTimeout(killEscalationTimer); killEscalationTimer = null;
        }
      };
      try {
        sendMessage(session.child, text, session.sessionId);
        session.lastActivity = Date.now();
        session.processingStartedAt = Date.now();
        this.resetIdleTimer(chatId);

        // Update store with new activity time
        this.store.setSession(chatId, this.toSessionState(chatId, session));

        // Read response lines until we get a result.
        // Activity timeout: if no events arrive for RESPONSE_ACTIVITY_TIMEOUT_MS,
        // kill the subprocess to unstick the queue (handles hung processes).
        let gotResult = false;
        const resetActivityTimer = () => {
          // Only reset the activity timer; never cancel a pending SIGKILL escalation.
          // Once we've decided to kill the process, the escalation must complete.
          if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
          activityTimer = setTimeout(() => {
            if (!hasExited(session.child)) {
              log.error("session-manager", `Response activity timeout for chat ${chatId} — killing subprocess`);
              if (!session.child.killed) {
                session.child.kill("SIGTERM");
              }
              // Escalate to SIGKILL if SIGTERM doesn't terminate within 5s
              if (!killEscalationTimer) {
                killEscalationTimer = setTimeout(() => {
                  if (!hasExited(session.child)) {
                    log.error("session-manager", `Subprocess ignored SIGTERM for chat ${chatId} — sending SIGKILL`);
                    session.child.kill("SIGKILL");
                  }
                }, 5000);
              }
            }
          }, RESPONSE_ACTIVITY_TIMEOUT_MS);
        };
        resetActivityTimer();
        const stream = readStream(session.child);
        for await (const line of stream) {
          resetActivityTimer();
          push(line);
          if (line.type === "result") {
            gotResult = true;
            session.lastSuccessAt = Date.now();
            session.lastActivity = Date.now();
            // Reset crash backoff on successful response
            this.restartCounts.set(chatId, 0);
            recordResultMetrics(session.agentId, line);
            break;
          }
        }
        clearActivityTimers();
        session.processingStartedAt = null;
        if (!gotResult) {
          finish(new Error("Claude subprocess exited before sending a result"));
          return;
        }
        finish();
      } catch (err) {
        clearActivityTimers();
        session.processingStartedAt = null;
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Yield lines as they arrive from the queue task
    try {
      while (true) {
        while (buffer.length > 0) {
          yield buffer.shift()!;
        }
        if (done) break;
        await new Promise<void>((r) => { notify = r; });
      }
      if (taskError) throw taskError;
    } finally {
      // Ensure queue bookkeeping completes even if consumer stops early
      await taskPromise;
    }
  }

  /** Reset the idle timer for a session. After timeout, session is closed. */
  resetIdleTimer(chatId: string): void {
    const session = this.active.get(chatId);
    if (!session) return;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    session.idleTimer = setTimeout(() => {
      this.closeSession(chatId).catch(() => {});
    }, session.idleTimeoutMs);
  }

  /** Close a session: persist state, SIGTERM child, clean up. */
  async closeSession(chatId: string): Promise<void> {
    // Always clear crash count so /reconnect unblocks circuit-broken chats
    this.restartCounts.delete(chatId);

    const session = this.active.get(chatId);
    if (!session) return;

    // Clear idle timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    // Persist final state
    this.store.setSession(chatId, this.toSessionState(chatId, session));

    // Remove from active map first to prevent re-entry
    this.active.delete(chatId);
    sessionsActive.dec();

    // Clean up outbox, inject, and media directories
    try {
      rmSync(session.outboxPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    try {
      cleanupInjectDir(session.injectDir);
    } catch {
      // Ignore cleanup errors
    }
    try {
      cleanupSessionMediaDir(chatId);
    } catch {
      // Ignore cleanup errors
    }

    // Gracefully terminate (even if SIGTERM was already sent elsewhere)
    if (!hasExited(session.child)) {
      if (!session.child.killed) {
        session.child.kill("SIGTERM");
      }

      // Wait up to 5s for graceful exit, then SIGKILL
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          if (!hasExited(session.child)) {
            session.child.kill("SIGKILL");
          }
          resolve();
        }, 5000);

        session.child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
  }

  /**
   * Graceful shutdown: inject notification into busy sessions, wait for
   * active turns to finish (up to timeoutMs), then log outcomes.
   * Called before closeAll() during SIGTERM/SIGINT handling.
   */
  async gracefulShutdown(timeoutMs: number): Promise<void> {
    const busySessions: { chatId: string; startedAt: number }[] = [];

    for (const [chatId, session] of this.active) {
      if (session.processingStartedAt !== null) {
        // Inject shutdown notification so the agent knows not to re-trigger restart
        try {
          writeInjectFile(session.injectDir, [
            "[System: Bot is shutting down for restart. Do NOT attempt to restart the bot — the restart is already in progress. Wrap up your current task.]",
          ]);
        } catch { /* best-effort */ }
        busySessions.push({ chatId, startedAt: session.processingStartedAt });
      }
    }

    if (busySessions.length === 0) {
      log.info("session-manager", "Graceful shutdown: no busy sessions");
      return;
    }

    log.info("session-manager", `Graceful shutdown: waiting for ${busySessions.length} session(s) (timeout: ${timeoutMs}ms)`);

    // Wait for all busy session queues to go idle, or timeout
    const idlePromises = busySessions.map(({ chatId }) => {
      const session = this.active.get(chatId);
      return session?.queue.onIdle() ?? Promise.resolve();
    });

    await Promise.race([
      Promise.all(idlePromises),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);

    // Log each session's outcome
    for (const { chatId, startedAt } of busySessions) {
      const session = this.active.get(chatId);
      const duration = Date.now() - startedAt;
      if (!session || session.processingStartedAt === null) {
        log.info("session-manager", `Shutdown: session ${chatId} finished naturally (${duration}ms)`);
      } else {
        log.warn("session-manager", `Shutdown: session ${chatId} timed out (${duration}ms)`);
      }
    }
  }

  /**
   * Destroy a session: close it AND delete stored state.
   * Next message will start a completely fresh session (no --resume).
   */
  async destroySession(chatId: string): Promise<void> {
    await this.closeSession(chatId);
    this.store.deleteSession(chatId);
  }

  /** Close all sessions gracefully. For shutdown. */
  async closeAll(): Promise<void> {
    const chatIds = [...this.active.keys()];
    await Promise.all(chatIds.map((id) => this.closeSession(id)));
  }

  /** Number of active sessions with live processes. */
  getActiveCount(): number {
    return this.active.size;
  }

  /** Get active session for a chatId (for monitoring/status). */
  getActive(chatId: string): ActiveSession | undefined {
    return this.active.get(chatId);
  }

  /** Get subprocess health info for a session (for /status command). */
  getSessionHealth(chatId: string): SessionHealth | undefined {
    const session = this.active.get(chatId);
    if (!session) return undefined;

    const alive = !hasExited(session.child) && !session.child.killed;
    const now = Date.now();

    return {
      pid: session.child.pid ?? null,
      alive,
      agentId: session.agentId,
      sessionId: session.sessionId,
      idleMs: now - session.lastActivity,
      processingMs: session.processingStartedAt ? now - session.processingStartedAt : null,
      lastSuccessAt: session.lastSuccessAt,
      restartCount: this.restartCounts.get(chatId) ?? 0,
    };
  }

  /**
   * Determine if a stored session should be resumed or discarded.
   * Discards and logs if the agentId changed or the stored agent was deleted.
   */
  resolveStoredSession(chatId: string, agentId: string, config?: BotConfig): { resume: boolean; sessionId: string } {
    const stored = this.store.getSession(chatId);
    if (!stored || stored.sessionId === "") {
      return { resume: false, sessionId: randomUUID() };
    }

    const agents = config ? config.agents : this.getFreshConfig().agents;
    const agentDeleted = !(stored.agentId in agents);
    const agentMismatch = stored.agentId !== agentId;

    if (agentMismatch || agentDeleted) {
      const reason = agentDeleted
        ? `agent "${stored.agentId}" no longer exists`
        : `agentId changed from "${stored.agentId}" to "${agentId}"`;
      log.warn("session-manager", `Discarding stale session for chat ${chatId}: ${reason}`);
      this.store.deleteSession(chatId);
      // Prevent leftover media from the prior agent's session leaking into the new one.
      try { cleanupSessionMediaDir(chatId); } catch { /* ignore */ }
      return { resume: false, sessionId: randomUUID() };
    }

    return { resume: true, sessionId: stored.sessionId };
  }

  /** LRU eviction: close the session with oldest lastActivity. */
  private async evictIfNeeded(config: BotConfig): Promise<void> {
    const maxConcurrentSessions = config.sessionDefaults.maxConcurrentSessions;
    if (this.active.size < maxConcurrentSessions) return;

    // Find session with oldest lastActivity
    let oldest: { chatId: string; lastActivity: number } | null = null;
    for (const [chatId, session] of this.active) {
      if (!oldest || session.lastActivity < oldest.lastActivity) {
        oldest = { chatId, lastActivity: session.lastActivity };
      }
    }

    if (oldest) {
      await this.closeSession(oldest.chatId);
    }
  }

  /** Set up crash recovery: when child exits unexpectedly, clean up. */
  private setupCrashRecovery(chatId: string, child: ChildProcess): void {
    child.once("exit", (code, signal) => {
      const session = this.active.get(chatId);
      if (!session || session.child !== child) return;

      // Clear idle timer
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }

      // Remove from active map (not from store — session can be resumed)
      this.active.delete(chatId);
      sessionsActive.dec();

      // Clean up inject directory (stale files would confuse next spawn)
      try { cleanupInjectDir(session.injectDir); } catch { /* ignore */ }
      // Clean up media directory — files are scoped to this session's lifetime
      try { cleanupSessionMediaDir(chatId); } catch { /* ignore */ }

      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        sessionCrashes.inc({ agent_id: session.agentId });
        // Increment crash count for backoff (survives active.delete)
        const count = (this.restartCounts.get(chatId) ?? 0) + 1;
        this.restartCounts.set(chatId, count);
        log.error(
          "session-manager",
          `Session for chat ${chatId} crashed: code=${code} signal=${signal} (crash #${count})`,
        );
      }
    });
  }

  /** Pipe child stderr to a log file. */
  private setupStderrLogging(chatId: string, child: ChildProcess): void {
    if (!child.stderr) return;

    const logDir = this.logDir;
    mkdirSync(logDir, { recursive: true });

    const safeChatId = chatId.replace(/:/g, "_");
    const logPath = `${logDir}/session-${safeChatId}.log`;
    const logStream = createWriteStream(logPath, { flags: "a" });

    logStream.on("error", (err) => {
      log.error("session-manager", `Log write error for chat ${chatId}: ${err.message}`);
    });

    // pipe() auto-ends logStream when stderr emits 'end', which fires after
    // all buffered data has been consumed. Do NOT manually call logStream.end()
    // on the 'exit' event — 'exit' can fire while stderr data is still in
    // kernel buffers, causing data loss (0-byte log files).
    child.stderr.pipe(logStream);
  }
}
