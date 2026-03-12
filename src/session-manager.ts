import { type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import PQueue from "p-queue";
import type { AgentConfig, SessionState, StreamLine, BotConfig } from "./types.js";
import { spawnClaudeSession, sendMessage, readStream } from "./cli-protocol.js";
import { SessionStore } from "./session-store.js";

const LOG_DIR = "/Users/ninja/.openclaw/logs";
const STARTUP_TIMEOUT_MS = 10_000;

export interface ActiveSession {
  child: ChildProcess;
  sessionId: string;
  agentId: string;
  queue: PQueue;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActivity: number;
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
  private store: SessionStore;
  private agents: Record<string, AgentConfig>;
  private idleTimeoutMs: number;
  private maxConcurrentSessions: number;

  constructor(config: BotConfig, storePath?: string) {
    this.agents = config.agents;
    this.idleTimeoutMs = config.sessionDefaults.idleTimeoutMs;
    this.maxConcurrentSessions = config.sessionDefaults.maxConcurrentSessions;
    this.store = new SessionStore(storePath);
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
    if (existing && existing.child.exitCode === null && !existing.child.killed) {
      existing.lastActivity = Date.now();
      this.resetIdleTimer(chatId);
      return existing;
    }

    // If we had an active entry but child is dead, clean it up
    if (existing) {
      this.active.delete(chatId);
    }

    const agent = this.agents[agentId];
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // Check if we need to evict
    await this.evictIfNeeded();

    // Check if we have a stored session to resume
    const stored = this.store.getSession(chatId);
    const resume = stored !== undefined && stored.sessionId !== "";
    const sessionId = resume ? stored.sessionId : randomUUID();

    // Spawn the claude subprocess
    const child = spawnClaudeSession({
      agent,
      sessionId,
      resume,
      includePartialMessages: true,
    });

    // Verify the subprocess actually started
    try {
      await waitForSpawn(child, STARTUP_TIMEOUT_MS);
    } catch (err) {
      // Ensure child is dead before throwing
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      throw err;
    }

    // Prevent EPIPE from becoming uncaughtException when subprocess dies
    child.stdin?.on("error", (err) => {
      console.error(`[session-manager] stdin error for chat ${chatId}: ${err.message}`);
    });

    // Pipe stderr to log file
    this.setupStderrLogging(chatId, child);

    const session: ActiveSession = {
      child,
      sessionId,
      agentId,
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      lastActivity: Date.now(),
    };

    this.active.set(chatId, session);

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
      try {
        sendMessage(session.child, text, session.sessionId);
        session.lastActivity = Date.now();
        this.resetIdleTimer(chatId);

        // Update store with new activity time
        this.store.setSession(chatId, {
          sessionId: session.sessionId,
          chatId,
          agentId,
          lastActivity: session.lastActivity,
        });

        // Read response lines until we get a result
        let gotResult = false;
        const stream = readStream(session.child);
        for await (const line of stream) {
          push(line);
          if (line.type === "result") {
            gotResult = true;
            break;
          }
        }
        if (!gotResult) {
          finish(new Error("Claude subprocess exited before sending a result"));
          return;
        }
        finish();
      } catch (err) {
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

    // Gracefully terminate
    if (session.child.exitCode === null && !session.child.killed) {
      session.child.kill("SIGTERM");

      // Wait up to 5s for graceful exit, then SIGKILL
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          if (session.child.exitCode === null && !session.child.killed) {
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

      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        console.error(
          `[session-manager] Session for chat ${chatId} crashed: code=${code} signal=${signal}`
        );
      }
    });
  }

  /** Pipe child stderr to a log file. */
  private setupStderrLogging(chatId: string, child: ChildProcess): void {
    if (!child.stderr) return;

    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }

    const logPath = `${LOG_DIR}/session-${chatId}.log`;
    const logStream = createWriteStream(logPath, { flags: "a" });
    child.stderr.pipe(logStream);

    child.once("exit", () => {
      logStream.end();
    });
  }
}
