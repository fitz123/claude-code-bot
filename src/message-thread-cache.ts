/**
 * In-memory cache mapping (chatId, messageId) → topicId.
 * Works around the Telegram Bot API limitation where MessageReactionUpdated
 * events lack message_thread_id. Every message handler populates this cache;
 * the reaction handler looks up the topicId from it.
 *
 * Cache miss degrades gracefully to chat-level routing (current behavior).
 * Eviction: map.clear() when size exceeds MAX_ENTRIES.
 */

const MAX_ENTRIES = 10_000;

const cache = new Map<string, number>();

function cacheKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Record which topic a message belongs to.
 * Skips if topicId is undefined (DMs, General topic without thread ID).
 */
export function setThread(chatId: number, messageId: number, topicId: number | undefined): void {
  if (topicId === undefined) return;
  if (cache.size >= MAX_ENTRIES) {
    cache.clear();
  }
  cache.set(cacheKey(chatId, messageId), topicId);
}

/**
 * Look up the topicId for a message. Returns undefined on cache miss.
 */
export function getThread(chatId: number, messageId: number): number | undefined {
  return cache.get(cacheKey(chatId, messageId));
}

/** Visible for testing only. */
export function _clearCache(): void {
  cache.clear();
}

/** Visible for testing only. */
export function _cacheSize(): number {
  return cache.size;
}
