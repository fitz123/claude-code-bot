/**
 * Echo watcher — polls /tmp/bot-echo/ for echo files written by deliver.sh,
 * parses them, and routes to the appropriate session's inject directory via
 * a platform-agnostic handler callback.
 *
 * No Telegram-specific imports — platform routing is done by the callback
 * registered in telegram-bot.ts (or any other platform adapter).
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** Base directory where deliver.sh writes echo JSON files. */
export const ECHO_DIR_BASE = "/tmp/bot-echo";

/**
 * Shared prefix for echo framing text. Also checked in
 * .claude/hooks/inject-message.sh — keep in sync.
 */
export const ECHO_PREFIX = "[Bot echo";

/**
 * Shape of the JSON echo files written by deliver.sh after each successful send.
 *
 * File location: `/tmp/bot-echo/<chatId>/<epoch>-<pid>-<random>.json`
 */
export interface EchoMessage {
  /** Telegram chat ID (numeric string). */
  chatId: string;
  /** Telegram message_thread_id, if the message was sent to a topic. `null` or absent for non-topic chats. */
  threadId?: string | null;
  /** Original markdown text of the delivered message (pre-HTML conversion). */
  text: string;
  /** Identifier of the sender (e.g. `"deliver.sh"`). */
  origin: string;
  /** Unix epoch seconds when the message was sent. */
  timestamp: number;
}

/**
 * Callback invoked once per echo message during a poll cycle.
 *
 * The handler is responsible for resolving the target session and writing
 * the framed text to the session's inject directory. Platform-specific
 * routing (binding lookup, session key derivation) lives in the handler,
 * keeping EchoWatcher platform-agnostic.
 *
 * @param chatId   - Telegram chat ID as a string
 * @param threadId - Topic/thread ID if present, otherwise `undefined`
 * @param text     - Original markdown text of the delivered message
 */
export type EchoHandler = (
  chatId: string,
  threadId: string | undefined,
  text: string,
) => void;

/** Options for EchoWatcher constructor. */
export interface EchoWatcherOptions {
  handler: EchoHandler;
  /** Called once per poll cycle after all chat directories are processed — use to flush accumulated writes. */
  onFlush?: () => void;
  pollIntervalMs?: number;
  /** Override the base directory to scan (defaults to ECHO_DIR_BASE). Useful for tests. */
  echoDir?: string;
}

/**
 * Polls `/tmp/bot-echo/` for echo JSON files written by `deliver.sh` and
 * dispatches each message to the registered {@link EchoHandler}.
 *
 * Lifecycle:
 * - {@link drain}() — process all existing files once (call on startup)
 * - {@link start}() — begin periodic polling via `setInterval`
 * - {@link stop}()  — clear the polling timer
 *
 * After all chat directories are processed in a poll cycle, the optional
 * `onFlush` callback fires so the caller can batch-write accumulated inject files.
 *
 * Uses polling (not `fs.watch`) to avoid macOS FSEvents edge cases with
 * nested directories.
 */
export class EchoWatcher {
  private readonly handler: EchoHandler;
  private readonly onFlush?: () => void;
  private readonly pollIntervalMs: number;
  private readonly echoDir: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: EchoWatcherOptions) {
    this.handler = opts.handler;
    this.onFlush = opts.onFlush;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.echoDir = opts.echoDir ?? ECHO_DIR_BASE;
  }

  /** Start polling. Creates the echo base directory if needed. */
  start(): void {
    if (this.timer) return;
    mkdirSync(this.echoDir, { recursive: true });
    this.timer = setInterval(() => this.pollAll(), this.pollIntervalMs);
    (this.timer as NodeJS.Timeout).unref();
  }

  /** Process all existing echo files once (drain on startup). */
  drain(): void {
    mkdirSync(this.echoDir, { recursive: true });
    this.pollAll();
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Scan all chat subdirectories under the echo base directory. */
  private pollAll(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.echoDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const chatDir = join(this.echoDir, entry);
      try {
        if (!statSync(chatDir).isDirectory()) continue;
      } catch {
        continue;
      }
      this.processDir(chatDir);
    }
    if (this.onFlush) {
      try {
        this.onFlush();
      } catch { /* swallow — onFlush errors must not crash the poll timer */ }
    }
  }

  /** Process all .json echo files in a single chat directory. */
  private processDir(chatDir: string): void {
    let files: string[];
    try {
      files = readdirSync(chatDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = join(chatDir, file);

      // Parse the echo file — skip and delete malformed files
      let msg: EchoMessage;
      try {
        const raw = readFileSync(filePath, "utf-8");
        msg = JSON.parse(raw);
      } catch {
        // Malformed or unreadable file — delete and continue
        try { unlinkSync(filePath); } catch { /* ignore */ }
        continue;
      }

      // Validate required fields — skip and delete files with unexpected shape
      if (
        (typeof msg.chatId !== "string" && typeof msg.chatId !== "number") ||
        typeof msg.text !== "string" ||
        !msg.text
      ) {
        try { unlinkSync(filePath); } catch { /* ignore */ }
        continue;
      }

      // Dispatch to handler — leave file on disk if handler fails (retry next cycle)
      try {
        const threadId =
          msg.threadId === null || msg.threadId === undefined
            ? undefined
            : String(msg.threadId);

        this.handler(String(msg.chatId), threadId, msg.text);
      } catch {
        // Handler error — skip this file, retry next poll cycle
        continue;
      }

      // Clean up successfully processed file
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
