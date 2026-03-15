/**
 * In-memory cache mapping (chatId, messageId) → topicId.
 *
 * Telegram's MessageReactionUpdated event does not include message_thread_id,
 * so we cache the topicId from every message the bot sees. When a reaction
 * arrives, we look up the cached topicId to route it to the correct topic
 * session. Cache miss degrades gracefully to chat-level routing (current
 * behavior).
 */

const MAX_CACHE_SIZE = 10_000;

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
