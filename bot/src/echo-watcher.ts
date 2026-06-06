/**
 * Echo watcher — polls the private bot echo spool for files written by deliver.sh,
 * parses them, and routes them through a platform-agnostic handler callback.
 *
 * No Telegram-specific imports — platform routing is done by the callback
 * registered in telegram-bot.ts (or any other platform adapter).
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger.js";

/** Base directory where deliver.sh writes echo JSON files. */
export const ECHO_DIR_BASE = join(homedir(), ".minime", "bot-echo");

/**
 * Shared prefix for echo framing text.
 */
export const ECHO_PREFIX = "[Bot echo";

/**
 * Shape of the JSON echo files written by deliver.sh after each successful send.
 *
 * File location: `<ECHO_DIR_BASE>/<chatId>/<epoch>-<pid>-<random>.json`
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
 * The handler is responsible for resolving the target session and delivering
 * the framed text to the live agent path. Platform-specific routing (binding
 * lookup, session key derivation) lives in the handler, keeping EchoWatcher
 * platform-agnostic.
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
  pollIntervalMs?: number;
  /** Override the base directory to scan (defaults to ECHO_DIR_BASE). Useful for tests. */
  echoDir?: string;
}

/**
 * Polls the private echo spool for echo JSON files written by `deliver.sh` and
 * dispatches each message to the registered {@link EchoHandler}.
 *
 * Lifecycle:
 * - {@link drain}() — process all existing files once (call on startup)
 * - {@link start}() — begin periodic polling via `setInterval`
 * - {@link stop}()  — clear the polling timer
 *
 * Uses polling (not `fs.watch`) to avoid macOS FSEvents edge cases with
 * nested directories.
 */
export class EchoWatcher {
  private readonly handler: EchoHandler;
  private readonly pollIntervalMs: number;
  private readonly echoDir: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: EchoWatcherOptions) {
    this.handler = opts.handler;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.echoDir = opts.echoDir ?? ECHO_DIR_BASE;
  }

  /** Start polling. Creates the echo base directory if needed. */
  start(): void {
    if (this.timer) return;
    if (!this.ensureEchoDir()) return;
    this.timer = setInterval(() => this.pollAll(), this.pollIntervalMs);
    (this.timer as NodeJS.Timeout).unref();
  }

  /** Process all existing echo files once (drain on startup). */
  drain(): void {
    if (!this.ensureEchoDir()) return;
    this.pollAll();
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureEchoDir(): boolean {
    try {
      mkdirSync(this.echoDir, { recursive: true, mode: 0o700 });
      const info = lstatSync(this.echoDir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("echo spool path is not a plain directory");
      }
      const uid = process.getuid?.();
      if (uid !== undefined && info.uid !== uid) {
        throw new Error("echo spool is not owned by the bot user");
      }
      if ((info.mode & 0o077) !== 0) {
        chmodSync(this.echoDir, 0o700);
      }
      return true;
    } catch (err) {
      log.warn("echo-watcher", `Echo spool disabled: ${(err as Error).message}`);
      return false;
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
        const info = lstatSync(chatDir);
        if (info.isSymbolicLink() || !info.isDirectory()) continue;
        const uid = process.getuid?.();
        if (uid !== undefined && info.uid !== uid) continue;
        if ((info.mode & 0o077) !== 0) {
          chmodSync(chatDir, 0o700);
        }
      } catch {
        continue;
      }
      this.processDir(chatDir);
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
        const info = lstatSync(filePath);
        if (info.isSymbolicLink() || !info.isFile()) {
          try { unlinkSync(filePath); } catch { /* ignore */ }
          continue;
        }
        const uid = process.getuid?.();
        if (uid !== undefined && info.uid !== uid) {
          continue;
        }
      } catch {
        continue;
      }

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
