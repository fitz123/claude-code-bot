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
  /** Called after each chat directory is fully processed — use to flush accumulated writes. */
  onFlush?: () => void;
  pollIntervalMs?: number;
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
 * After each chat directory is fully processed, the optional `onFlush`
 * callback fires so the caller can batch-write accumulated inject files.
 *
 * Uses polling (not `fs.watch`) to avoid macOS FSEvents edge cases with
 * nested directories.
 */
export class EchoWatcher {
  private readonly handler: EchoHandler;
  private readonly onFlush?: () => void;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: EchoWatcherOptions) {
    this.handler = opts.handler;
    this.onFlush = opts.onFlush;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
  }

  /** Start polling. Creates the echo base directory if needed. */
  start(): void {
    mkdirSync(ECHO_DIR_BASE, { recursive: true });
    this.timer = setInterval(() => this.pollAll(), this.pollIntervalMs);
  }

  /** Process all existing echo files once (drain on startup). */
  drain(): void {
    mkdirSync(ECHO_DIR_BASE, { recursive: true });
    this.pollAll();
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Scan all chat subdirectories under ECHO_DIR_BASE. */
  private pollAll(): void {
    let entries: string[];
    try {
      entries = readdirSync(ECHO_DIR_BASE);
    } catch {
      return;
    }

    for (const entry of entries) {
      const chatDir = join(ECHO_DIR_BASE, entry);
      try {
        if (!statSync(chatDir).isDirectory()) continue;
      } catch {
        continue;
      }
      this.processDir(chatDir);
      if (this.onFlush) this.onFlush();
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
      try {
        const raw = readFileSync(filePath, "utf-8");
        const msg: EchoMessage = JSON.parse(raw);

        const threadId =
          msg.threadId === null || msg.threadId === undefined
            ? undefined
            : String(msg.threadId);

        this.handler(String(msg.chatId), threadId, msg.text);
      } catch {
        // Skip malformed files — log and continue
      }

      // Clean up processed file
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
