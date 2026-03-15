/**
 * In-memory cache mapping (chatId, messageId) → topicId.
 *
 * Telegram's MessageReactionUpdated event does not include message_thread_id,
 * so we cache the topicId from every message the bot sees. When a reaction
 * arrives, we look up the cached topicId to route it to the correct topic
 * session. Cache miss degrades gracefully to chat-level routing (current
 * behavior).
 *
 * The cache is persisted to disk on graceful shutdown (SIGTERM/SIGINT) and
 * restored on startup so that reactions on pre-restart messages still route
 * to the correct topic.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger.js";

const MAX_CACHE_SIZE = 10_000;
const DEFAULT_CACHE_PATH = join(homedir(), ".openclaw", "bot", "data", "thread-cache.json");

const cache = new Map<string, number>();

function cacheKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Record the topicId for a message. Skips if topicId is undefined.
 * Evicts all entries when the cache exceeds MAX_CACHE_SIZE.
 */
export function setThread(chatId: number, messageId: number, topicId: number | undefined): void {
  if (topicId === undefined) return;
  if (cache.size >= MAX_CACHE_SIZE) {
    cache.clear();
  }
  cache.set(cacheKey(chatId, messageId), topicId);
}

/**
 * Look up the cached topicId for a message. Returns undefined on cache miss.
 */
export function getThread(chatId: number, messageId: number): number | undefined {
  return cache.get(cacheKey(chatId, messageId));
}

/** Clear the cache (for testing). */
export function clearThreadCache(): void {
  cache.clear();
}

/** Current cache size (for testing). */
export function threadCacheSize(): number {
  return cache.size;
}

/**
 * Save the cache to disk as JSON. Called on graceful shutdown.
 * Format: array of [key, value] pairs (Map serialization).
 */
export function saveThreadCache(path: string = DEFAULT_CACHE_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const entries = Array.from(cache.entries());
    writeFileSync(path, JSON.stringify(entries), "utf8");
    log.info("thread-cache", `Saved ${entries.length} entries to ${path}`);
  } catch (err) {
    log.error("thread-cache", `Failed to save cache to ${path}:`, err);
  }
}

/**
 * Restore the cache from disk. Called on startup.
 * Missing or corrupt files result in an empty cache (no crash).
 * Respects MAX_CACHE_SIZE — only loads up to 10K entries.
 */
export function restoreThreadCache(path: string = DEFAULT_CACHE_PATH): void {
  try {
    const data = readFileSync(path, "utf8");
    cache.clear();
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      log.warn("thread-cache", `Invalid cache format in ${path} (not an array), starting empty`);
      return;
    }
    let loaded = 0;
    for (const entry of parsed) {
      if (loaded >= MAX_CACHE_SIZE) break;
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (typeof key !== "string" || typeof value !== "number") continue;
      cache.set(key, value);
      loaded++;
    }
    log.info("thread-cache", `Restored ${loaded} entries from ${path}`);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      log.info("thread-cache", `No cache file at ${path}, starting empty`);
    } else {
      log.warn("thread-cache", `Failed to restore cache from ${path}, starting empty:`, err);
    }
  }
}
