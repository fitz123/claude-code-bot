import type { PlatformContext } from "./types.js";
import { log } from "./logger.js";

export const DEFAULT_DEBOUNCE_MS = 3000;
export const DEFAULT_QUEUE_CAP = 20;

/**
 * Callback that sends combined text to the active agent and relays the response.
 * Called by the queue when debounce expires or collect buffer drains.
 *
 * `onAgentOwnership` MUST be invoked once the agent has accepted the prompt
 * (the conversation history now references any media paths in the text). After
 * that point, even if response relay fails, persistent media must NOT be
 * discarded — the agent owns it for the rest of the session.
 */
export type ProcessFn = (
  chatId: string,
  agentId: string,
  text: string,
  platform: PlatformContext,
  onAgentOwnership: () => void,
) => Promise<void>;

/** Fire-and-forget cleanup callback (e.g. delete a temp file after processing). */
export type CleanupFn = () => void;

interface ChatQueueState {
  /** Messages pending debounce timer (pre-send) */
  pendingTexts: string[];
  /** Cleanup callbacks for pending messages (fire on successful delivery) */
  pendingCleanups: CleanupFn[];
  /**
   * Drop-only cleanup callbacks for pending messages. Fire when the message
   * is dropped (cap exceeded) or the queue is cleared (/reconnect, /clean).
   * Discarded on successful flush — the session will own the file and clean
   * it up on close. Used for persistent media that must outlive the turn.
   */
  pendingDropCleanups: CleanupFn[];
  debounceTimer: ReturnType<typeof setTimeout> | null;

  /** Messages collected during active processing (mid-turn) */
  collectBuffer: string[];
  /** Cleanup callbacks for collected messages (fire on successful delivery) */
  collectCleanups: CleanupFn[];
  /** Drop-only cleanup callbacks for collected messages (see pendingDropCleanups). */
  collectDropCleanups: CleanupFn[];

  /** Whether a message is currently being processed */
  busy: boolean;

  /** Latest platform context for sending responses */
  latestPlatform: PlatformContext | null;

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
 * into a single prompt before sending to the agent.
 *
 * Mid-turn collect: messages arriving while the agent is processing are buffered
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
        pendingDropCleanups: [],
        debounceTimer: null,
        collectBuffer: [],
        collectCleanups: [],
        collectDropCleanups: [],
        busy: false,
        latestPlatform: null,
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
   *
   * `cleanup` runs when the message is consumed (successful delivery or drop)
   * and is the right hook for turn-scoped temp files.
   *
   * `dropCleanup` runs only on drop/clear paths (cap exceeded, /reconnect,
   * /clean). It is discarded on successful delivery so the callee can own the
   * file for the session lifetime (persistent media). Use this for downloads
   * that must survive the turn but be reclaimed if the message never reaches
   * an agent.
   */
  enqueue(
    chatId: string,
    agentId: string,
    text: string,
    platform: PlatformContext,
    cleanup?: CleanupFn,
    dropCleanup?: CleanupFn,
  ): void {
    const state = this.getState(chatId, agentId);
    state.latestPlatform = platform;

    if (state.busy) {
      // Mid-turn collect: buffer user messages for reliable follow-up delivery.
      // Pi `steer` has no usable delivery acknowledgement in the stream, so a
      // normal user prompt must not be removed from the queue just because a
      // steer command was written to stdin.
      if (state.collectBuffer.length < this.queueCap) {
        state.collectBuffer.push(text);
        state.collectCleanups.push(cleanup ?? (() => {}));
        state.collectDropCleanups.push(dropCleanup ?? (() => {}));

        log.debug(
          "message-queue",
          `Queued mid-turn message for ${chatId} (${state.collectBuffer.length} in buffer)`,
        );
      } else {
        if (cleanup) cleanup();
        if (dropCleanup) dropCleanup();
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
      if (dropCleanup) dropCleanup();
      log.warn(
        "message-queue",
        `Debounce buffer full for ${chatId}, dropping message`,
      );
      return;
    }
    state.pendingTexts.push(text);
    state.pendingCleanups.push(cleanup ?? (() => {}));
    state.pendingDropCleanups.push(dropCleanup ?? (() => {}));

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
    // Hold drop cleanups locally during processing. If processFn throws, or
    // the queue is cleared mid-process, we must run them so persistent media
    // doesn't leak on disk. Splicing out of state now also means clear()'s
    // own drop-cleanup loop won't double-fire them.
    const dropCleanups = state.pendingDropCleanups.splice(0);
    state.debounceTimer = null;
    state.busy = true;

    const combinedText = texts.length === 1 ? texts[0] : texts.join("\n\n");

    // Start pre-stream typing indicator (covers session spawn, queue wait, thinking phase)
    // relayStream() will clear this timer on handoff and start its own
    this.startPreStreamTyping(state.latestPlatform);

    // Mutable holder so onAgentOwnership can drop the cleanups: once the
    // agent has accepted the prompt, the conversation references any media
    // paths and we must never reclaim them via drop cleanup, even if the
    // response relay fails afterward (issue #99 regression vector). If the
    // queue was cleared before ownership transferred (/reconnect, /clean),
    // ignore the signal — the session is being torn down and drop cleanups
    // must still run.
    let liveDropCleanups: CleanupFn[] | null = dropCleanups;
    const transferOwnership = () => {
      if (this.queues.get(chatId) !== state) return;
      liveDropCleanups = null;
    };

    try {
      if (state.latestPlatform) {
        await this.processFn(chatId, state.agentId, combinedText, state.latestPlatform, transferOwnership);
      }
    } catch (err) {
      log.error("message-queue", `Send error for ${chatId}:`, err);
      if (state.latestPlatform) {
        await state.latestPlatform
          .replyError(`Something went wrong: ${err instanceof Error ? err.message : String(err)}\n\nTry again or /reconnect the session.`)
          .catch(() => {});
      }
    } finally {
      this.stopPreStreamTyping(state.latestPlatform);
      for (const fn of cleanups) fn();
    }

    // If transferOwnership() fired, liveDropCleanups is null and we skip — the
    // session now owns the media for its full lifetime, even if response relay
    // failed afterward. Otherwise (queue cleared, processFn threw before
    // ownership, or processFn returned without ever taking ownership): the
    // agent never claimed the media, reclaim it.
    const queueCleared = this.queues.get(chatId) !== state;
    if (liveDropCleanups) {
      for (const fn of liveDropCleanups) fn();
    }
    if (queueCleared) return;

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
      // Hold drop cleanups locally for exactly this batch. If processFn
      // throws or the queue is cleared mid-drain, we must run them. Any
      // drop cleanups added during processing (new mid-turn collect) stay
      // in state — they'll be processed on the next loop iteration, or
      // handled by clear().
      const dropCleanups = state.collectDropCleanups.splice(0, collected.length);
      const prompt = buildCollectPrompt(collected);

      state.busy = true;
      log.debug(
        "message-queue",
        `Draining ${collected.length} collected message(s) for ${chatId}`,
      );

      this.startPreStreamTyping(state.latestPlatform);

      let liveDropCleanups: CleanupFn[] | null = dropCleanups;
      const transferOwnership = () => {
        if (this.queues.get(chatId) !== state) return;
        liveDropCleanups = null;
      };

      try {
        if (state.latestPlatform) {
          await this.processFn(chatId, state.agentId, prompt, state.latestPlatform, transferOwnership);
        }
      } catch (err) {
        log.error("message-queue", `Collect drain error for ${chatId}:`, err);
        if (state.latestPlatform) {
          await state.latestPlatform
            .replyError(`Something went wrong: ${err instanceof Error ? err.message : String(err)}\n\nTry again or /reconnect the session.`)
            .catch(() => {});
        }
      } finally {
        this.stopPreStreamTyping(state.latestPlatform);
        for (const fn of cleanups) fn();
      }

      const queueCleared = this.queues.get(chatId) !== state;
      if (liveDropCleanups) {
        for (const fn of liveDropCleanups) fn();
      }
      if (queueCleared) return;

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

  /** Clear a chat's queue state (e.g., on /reconnect). */
  clear(chatId: string): void {
    const state = this.queues.get(chatId);
    if (state) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
      for (const fn of state.pendingCleanups) fn();
      for (const fn of state.pendingDropCleanups) fn();
      for (const fn of state.collectCleanups) fn();
      for (const fn of state.collectDropCleanups) fn();
      this.queues.delete(chatId);
    }
  }

  /**
   * Cancel all pending debounce timers without running cleanups or clearing queues.
   * Call before gracefulShutdown() to prevent new flushes from starting during
   * the shutdown wait window.
   */
  cancelAllDebounceTimers(): void {
    for (const state of this.queues.values()) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }
    }
  }

  /** Clear all queues (for shutdown). */
  clearAll(): void {
    for (const [chatId, state] of this.queues) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
      for (const fn of state.pendingCleanups) fn();
      for (const fn of state.pendingDropCleanups) fn();
      for (const fn of state.collectCleanups) fn();
      for (const fn of state.collectDropCleanups) fn();
    }
    this.queues.clear();
  }

  /** Start pre-stream typing indicator on the platform context. */
  private startPreStreamTyping(platform: PlatformContext | null): void {
    if (!platform?.typingIndicator) return;
    platform.sendTyping().catch(() => {});
    platform.preStreamTypingTimer = setInterval(() => {
      platform.sendTyping().catch(() => {});
    }, platform.typingIntervalMs);
  }

  /** Stop pre-stream typing if relayStream didn't already clear it (error/cancel path). */
  private stopPreStreamTyping(platform: PlatformContext | null): void {
    if (platform?.preStreamTypingTimer) {
      clearInterval(platform.preStreamTypingTimer);
      platform.preStreamTypingTimer = undefined;
    }
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
