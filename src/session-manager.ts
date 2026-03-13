import { type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import PQueue from "p-queue";
import type { AgentConfig, SessionState, StreamLine, BotConfig } from "./types.js";
import { spawnClaudeSession, sendMessage, readStream } from "./cli-protocol.js";
import { SessionStore } from "./session-store.js";
import { log } from "./logger.js";
import { recordResultMetrics, sessionsActive, sessionCrashes } from "./metrics.js";

const LOG_DIR = "/Users/user/.openclaw/logs";
const OUTBOX_BASE = "/tmp/bot-outbox";
const STARTUP_TIMEOUT_MS = 10_000;
const RESPONSE_ACTIVITY_TIMEOUT_MS = 300_000; // 5 minutes with no events = hung
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
  lastActivity: number;
  /** Timestamp when current turn started processing, null if idle. */
  processingStartedAt: number | null;
  /** Timestamp of last successful response (result received). */
  lastSuccessAt: number | null;
  /** Number of times this session's subprocess was restarted. */
  restartCount: number;
  /** Per-session outbox directory for file delivery. */
  outboxPath: string;
}

export interface SessionHealth {
  pid: number | null;
  alive: boolean;
  agentId: string;
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
  private agents: Record<string, AgentConfig>;
  private idleTimeoutMs: number;
  private maxConcurrentSessions: number;
  private logDir: string;

  constructor(config: BotConfig, storePath?: string, logDir?: string) {
    this.agents = config.agents;
    this.idleTimeoutMs = config.sessionDefaults.idleTimeoutMs;
    this.maxConcurrentSessions = config.sessionDefaults.maxConcurrentSessions;
    this.store = new SessionStore(storePath);
    this.logDir = logDir ?? LOG_DIR;
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

    const agent = this.agents[agentId];
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // Check if we need to evict
    await this.evictIfNeeded();

    // Check if we have a stored session to resume (discards stale sessions)
    const { resume, sessionId } = this.resolveStoredSession(chatId, agentId);

    // Crash backoff: prevent rapid crash→spawn→crash loops
    const prevCrashCount = this.restartCounts.get(chatId) ?? 0;
    if (prevCrashCount >= MAX_CRASH_RESTARTS) {
      log.error("session-manager", `Session for chat ${chatId} blocked after ${prevCrashCount} consecutive crashes — use /reset to unblock`);
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

    // Spawn the claude subprocess
    const child = spawnClaudeSession({
      agent,
      sessionId,
      resume,
      includePartialMessages: true,
      outboxPath,
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
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount,
      outboxPath,
    };

    this.active.set(chatId, session);
    sessionsActive.inc();

    // Persist to store
    this.store.setSession(chatId, {
      sessionId,
      chatId,
      agentId,
      lastActivity: session.lastActivity,
    });

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
        this.store.setSession(chatId, {
          sessionId: session.sessionId,
          chatId,
          agentId,
          lastActivity: session.lastActivity,
        });

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
    }, this.idleTimeoutMs);
  }

  /** Close a session: persist state, SIGTERM child, clean up. */
  async closeSession(chatId: string): Promise<void> {
    // Always clear crash count so /reset unblocks circuit-broken chats
    this.restartCounts.delete(chatId);

    const session = this.active.get(chatId);
    if (!session) return;

    // Clear idle timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    // Persist final state
    this.store.setSession(chatId, {
      sessionId: session.sessionId,
      chatId,
      agentId: session.agentId,
      lastActivity: session.lastActivity,
    });

    // Remove from active map first to prevent re-entry
    this.active.delete(chatId);
    sessionsActive.dec();

    // Clean up outbox directory
    try {
      rmSync(session.outboxPath, { recursive: true, force: true });
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
  resolveStoredSession(chatId: string, agentId: string): { resume: boolean; sessionId: string } {
    const stored = this.store.getSession(chatId);
    if (!stored || stored.sessionId === "") {
      return { resume: false, sessionId: randomUUID() };
    }

    const agentDeleted = !(stored.agentId in this.agents);
    const agentMismatch = stored.agentId !== agentId;

    if (agentMismatch || agentDeleted) {
      const reason = agentDeleted
        ? `agent "${stored.agentId}" no longer exists`
        : `agentId changed from "${stored.agentId}" to "${agentId}"`;
      log.warn("session-manager", `Discarding stale session for chat ${chatId}: ${reason}`);
      this.store.deleteSession(chatId);
      return { resume: false, sessionId: randomUUID() };
    }

    return { resume: true, sessionId: stored.sessionId };
  }

  /** LRU eviction: close the session with oldest lastActivity. */
  private async evictIfNeeded(): Promise<void> {
    if (this.active.size < this.maxConcurrentSessions) return;

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
