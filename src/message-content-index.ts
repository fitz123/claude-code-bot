/**
 * In-memory index mapping (chatId, messageId) → message content metadata.
 *
 * When a reaction arrives, the bot needs to know what message was reacted to.
 * Telegram Bot API provides no getMessage method, so we record every message
 * the bot sees (incoming and outgoing) with author, text preview, and direction.
 *
 * Follows the same pattern as message-thread-cache.ts: in-memory Map, persist
 * to disk on shutdown, tolerant restore on startup.
 *
 * Key difference from thread cache: FIFO eviction (oldest entries removed)
 * instead of full clear(), because reactions often arrive after the message
 * and a full wipe would destroy needed context.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger.js";

const MAX_CACHE_SIZE = 10_000;
const MAX_PREVIEW_LENGTH = 150;
const DEFAULT_INDEX_PATH = join(homedir(), ".openclaw", "bot", "data", "message-content-index.json");

export interface MessageRecord {
  from: string;
  preview: string;
  direction: "in" | "out";
  timestamp: number;
}

const index = new Map<string, MessageRecord>();

function indexKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Record a message in the index.
 * Evicts oldest entries (FIFO) when the index exceeds MAX_CACHE_SIZE.
 */
export function recordMessage(
  chatId: number,
  messageId: number,
  from: string,
  text: string,
  direction: "in" | "out",
): void {
  // FIFO eviction: remove oldest entries to make room
  if (index.size >= MAX_CACHE_SIZE) {
    const keysToDelete = index.size - MAX_CACHE_SIZE + 1;
    const iter = index.keys();
    for (let i = 0; i < keysToDelete; i++) {
      const oldest = iter.next().value;
      if (oldest !== undefined) index.delete(oldest);
    }
  }
  index.set(indexKey(chatId, messageId), {
    from,
    preview: text.slice(0, MAX_PREVIEW_LENGTH),
    direction,
    timestamp: Date.now(),
  });
}

/**
 * Look up a recorded message. Returns undefined on cache miss.
 */
export function lookupMessage(chatId: number, messageId: number): MessageRecord | undefined {
  return index.get(indexKey(chatId, messageId));
}

/** Clear the index (for testing). */
export function clearMessageIndex(): void {
  index.clear();
}

/** Current index size (for testing). */
export function messageIndexSize(): number {
  return index.size;
}

/**
 * Save the index to disk as JSON. Called on graceful shutdown.
 * Format: array of [key, value] pairs (Map serialization).
 */
export function saveMessageIndex(path: string = DEFAULT_INDEX_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const entries = Array.from(index.entries());
    writeFileSync(path, JSON.stringify(entries), "utf8");
    log.info("message-index", `Saved ${entries.length} entries to ${path}`);
  } catch (err) {
    log.error("message-index", `Failed to save index to ${path}:`, err);
  }
}

/**
 * Restore the index from disk. Called on startup.
 * Missing or corrupt files result in an empty index (no crash).
 * Respects MAX_CACHE_SIZE — only loads up to 10K entries.
 */
export function restoreMessageIndex(path: string = DEFAULT_INDEX_PATH): void {
  try {
    const data = readFileSync(path, "utf8");
    index.clear();
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      log.warn("message-index", `Invalid index format in ${path} (not an array), starting empty`);
      return;
    }
    let loaded = 0;
    for (const entry of parsed) {
      if (loaded >= MAX_CACHE_SIZE - 1) break;
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (typeof key !== "string") continue;
      if (
        typeof value !== "object" ||
        value === null ||
        typeof value.from !== "string" ||
        typeof value.preview !== "string" ||
        (value.direction !== "in" && value.direction !== "out") ||
        typeof value.timestamp !== "number"
      ) continue;
      index.set(key, value as MessageRecord);
      loaded++;
    }
    log.info("message-index", `Restored ${loaded} entries from ${path}`);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      log.info("message-index", `No index file at ${path}, starting empty`);
    } else {
      log.warn("message-index", `Failed to restore index from ${path}, starting empty:`, err);
    }
  }
}
