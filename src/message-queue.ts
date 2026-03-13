import type { Context } from "grammy";
import { log } from "./logger.js";

export const DEFAULT_DEBOUNCE_MS = 3000;
export const DEFAULT_QUEUE_CAP = 20;

/**
 * Callback that sends combined text to Claude and relays the response.
 * Called by the queue when debounce expires or collect buffer drains.
 */
export type ProcessFn = (
  chatId: string,
  agentId: string,
  text: string,
  ctx: Context,
) => Promise<void>;

/** Fire-and-forget cleanup callback (e.g. delete a temp file after processing). */
export type CleanupFn = () => void;

interface ChatQueueState {
  /** Messages pending debounce timer (pre-send) */
  pendingTexts: string[];
  /** Cleanup callbacks for pending messages */
  pendingCleanups: CleanupFn[];
  debounceTimer: ReturnType<typeof setTimeout> | null;

  /** Messages collected during active processing (mid-turn) */
  collectBuffer: string[];
  /** Cleanup callbacks for collected messages */
  collectCleanups: CleanupFn[];

  /** Whether a message is currently being processed */
  busy: boolean;

  /** Latest context for sending responses */
  latestCtx: Context | null;

  /** Agent ID for this chat */
  agentId: string;
}

/**
 * Build a collect prompt from queued messages.
 * Single message is returned as-is; multiple messages get a header and separators.
 */
export function buildCollectPrompt(texts: string[]): string {
  if (texts.length === 1) return texts[0];

  const lines = ["[Queued messages while agent was busy]"];
  for (let i = 0; i < texts.length; i++) {
    lines.push("---");
    lines.push(`Queued #${i + 1}`);
    lines.push(texts[i]);
  }
  return lines.join("\n");
}

/**
 * Per-chat message queue with pre-send debounce and mid-turn collect.
 *
 * Pre-send debounce: messages arriving within debounceMs are concatenated
 * into a single prompt before sending to Claude.
 *
 * Mid-turn collect: messages arriving while Claude is processing are buffered
 * and delivered as a combined followup when the current turn completes.
 */
export class MessageQueue {
  private queues = new Map<string, ChatQueueState>();
  private debounceMs: number;
  private queueCap: number;
  private processFn: ProcessFn;

  constructor(
    processFn: ProcessFn,
    options?: { debounceMs?: number; queueCap?: number },
  ) {
    this.processFn = processFn;
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.queueCap = options?.queueCap ?? DEFAULT_QUEUE_CAP;
  }

  private getState(chatId: string, agentId: string): ChatQueueState {
    let state = this.queues.get(chatId);
    if (!state) {
      state = {
        pendingTexts: [],
        pendingCleanups: [],
        debounceTimer: null,
        collectBuffer: [],
        collectCleanups: [],
        busy: false,
        latestCtx: null,
        agentId,
      };
      this.queues.set(chatId, state);
    }
    state.agentId = agentId;
    return state;
  }

  /**
   * Enqueue a message for a chat. Handles debouncing and mid-turn collect.
   * Fire-and-forget: returns immediately, processing happens in background.
   */
  enqueue(chatId: string, agentId: string, text: string, ctx: Context, cleanup?: CleanupFn): void {
    const state = this.getState(chatId, agentId);
    state.latestCtx = ctx;

    if (state.busy) {
      // Mid-turn collect: buffer the message
      if (state.collectBuffer.length < this.queueCap) {
        state.collectBuffer.push(text);
        if (cleanup) state.collectCleanups.push(cleanup);
        log.debug(
          "message-queue",
          `Queued mid-turn message for ${chatId} (${state.collectBuffer.length} in buffer)`,
        );
      } else {
        if (cleanup) cleanup();
        log.warn(
          "message-queue",
          `Collect buffer full for ${chatId}, dropping message`,
        );
      }
      return;
    }

    // Pre-send debounce: add to pending and reset timer
    if (state.pendingTexts.length >= this.queueCap) {
      if (cleanup) cleanup();
      log.warn(
        "message-queue",
        `Debounce buffer full for ${chatId}, dropping message`,
      );
      return;
    }
    state.pendingTexts.push(text);
    if (cleanup) state.pendingCleanups.push(cleanup);

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    state.debounceTimer = setTimeout(() => {
      this.flush(chatId).catch((err) => {
        log.error("message-queue", `Flush error for ${chatId}:`, err);
      });
    }, this.debounceMs);
  }

  private async flush(chatId: string): Promise<void> {
    const state = this.queues.get(chatId);
    if (!state || state.pendingTexts.length === 0) return;

    const texts = state.pendingTexts.splice(0);
    const cleanups = state.pendingCleanups.splice(0);
    state.debounceTimer = null;
    state.busy = true;

    const combinedText = texts.length === 1 ? texts[0] : texts.join("\n\n");

    try {
      if (state.latestCtx) {
        await this.processFn(chatId, state.agentId, combinedText, state.latestCtx);
      }
    } catch (err) {
      log.error("message-queue", `Send error for ${chatId}:`, err);
      if (state.latestCtx) {
        await state.latestCtx
          .reply("Something went wrong. Try again or /reset the session.")
          .catch(() => {});
      }
    } finally {
      for (const fn of cleanups) fn();
    }

    // If queue was cleared during processing (e.g., /reset), stop here
    if (this.queues.get(chatId) !== state) return;

    state.busy = false;

    // Drain collect buffer if messages arrived during processing
    await this.drainCollectBuffer(chatId);

    // Evict idle state to prevent unbounded memory growth from stale entries
    this.evictIfIdle(chatId);
  }

  private async drainCollectBuffer(chatId: string): Promise<void> {
    const state = this.queues.get(chatId);
    if (!state || state.collectBuffer.length === 0) return;

    // Loop to drain messages that arrive during processing (avoids recursion)
    while (state.collectBuffer.length > 0) {
      const collected = state.collectBuffer.splice(0);
      const cleanups = state.collectCleanups.splice(0);
      const prompt = buildCollectPrompt(collected);

      state.busy = true;
      log.debug(
        "message-queue",
        `Draining ${collected.length} collected message(s) for ${chatId}`,
      );

      try {
        if (state.latestCtx) {
          await this.processFn(chatId, state.agentId, prompt, state.latestCtx);
        }
      } catch (err) {
        log.error("message-queue", `Collect drain error for ${chatId}:`, err);
        if (state.latestCtx) {
          await state.latestCtx
            .reply("Something went wrong processing queued messages. Try again or /reset the session.")
            .catch(() => {});
        }
      } finally {
        for (const fn of cleanups) fn();
      }

      // If queue was cleared during processing, stop draining
      if (this.queues.get(chatId) !== state) return;

      state.busy = false;
    }
  }

  /** Check if a chat is currently busy processing. */
  isBusy(chatId: string): boolean {
    return this.queues.get(chatId)?.busy ?? false;
  }

  /** Get pending debounce message count. */
  getPendingCount(chatId: string): number {
    return this.queues.get(chatId)?.pendingTexts.length ?? 0;
  }

  /** Get mid-turn collect buffer count. */
  getCollectCount(chatId: string): number {
    return this.queues.get(chatId)?.collectBuffer.length ?? 0;
  }

  /** Clear a chat's queue state (e.g., on /reset). */
  clear(chatId: string): void {
    const state = this.queues.get(chatId);
    if (state) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
      for (const fn of state.pendingCleanups) fn();
      for (const fn of state.collectCleanups) fn();
      this.queues.delete(chatId);
    }
  }

  /** Clear all queues (for shutdown). */
  clearAll(): void {
    for (const [, state] of this.queues) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
      for (const fn of state.pendingCleanups) fn();
      for (const fn of state.collectCleanups) fn();
    }
    this.queues.clear();
  }

  /** Remove idle queue state to free memory (Context refs, etc). */
  private evictIfIdle(chatId: string): void {
    const state = this.queues.get(chatId);
    if (
      state &&
      !state.busy &&
      state.pendingTexts.length === 0 &&
      state.collectBuffer.length === 0 &&
      !state.debounceTimer
    ) {
      this.queues.delete(chatId);
    }
  }
}
