import type { PlatformContext } from "./types.js";
import { log } from "./logger.js";
import { injectDirForChat, writeInjectFile, readAckCount, cleanupInjectDir } from "./inject-file.js";

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
  platform: PlatformContext,
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

  /** Deferred cleanups for messages consumed by hook mid-turn (temp files still in use) */
  deferredCleanups: CleanupFn[];

  /** Whether a message is currently being processed */
  busy: boolean;

  /** Latest platform context for sending responses */
  latestPlatform: PlatformContext | null;

  /** Agent ID for this chat */
  agentId: string;

  /** Cumulative count of messages confirmed consumed by inject hook */
  injectConsumed: number;
  /** Last ack count read from hook's ack file */
  injectLastAck: number;
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
        deferredCleanups: [],
        busy: false,
        latestPlatform: null,
        agentId,
        injectConsumed: 0,
        injectLastAck: 0,
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
  enqueue(chatId: string, agentId: string, text: string, platform: PlatformContext, cleanup?: CleanupFn): void {
    const state = this.getState(chatId, agentId);
    state.latestPlatform = platform;

    if (state.busy) {
      // Refresh ack state before cap check so consumed messages free up space
      this.refreshAck(chatId, state);

      // Compact: remove entries already consumed by inject hook to bound array growth.
      // Without this, arrays grow unbounded during long turns with continuous message flow.
      // Cleanups are deferred — temp files may still be in use by the active turn
      // (e.g. Claude reading an image path delivered via additionalContext).
      if (state.injectConsumed > 0) {
        const consumed = state.injectConsumed;
        state.collectBuffer.splice(0, consumed);
        const consumedCleanups = state.collectCleanups.splice(0, consumed);
        state.deferredCleanups.push(...consumedCleanups);
        state.injectConsumed = 0;
      }

      // Mid-turn collect: buffer the message
      if (state.collectBuffer.length < this.queueCap) {
        state.collectBuffer.push(text);
        state.collectCleanups.push(cleanup ?? (() => {}));

        // Write inject file so PreToolUse hook can deliver mid-turn
        this.writeInject(chatId, state);

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

    // Start pre-stream typing indicator (covers session spawn, queue wait, thinking phase)
    // relayStream() will clear this timer on handoff and start its own
    this.startPreStreamTyping(state.latestPlatform);

    try {
      if (state.latestPlatform) {
        await this.processFn(chatId, state.agentId, combinedText, state.latestPlatform);
      }
    } catch (err) {
      log.error("message-queue", `Send error for ${chatId}:`, err);
      if (state.latestPlatform) {
        await state.latestPlatform
          .replyError(`Something went wrong: ${err instanceof Error ? err.message : String(err)}\n\nTry again or /reset the session.`)
          .catch(() => {});
      }
    } finally {
      this.stopPreStreamTyping(state.latestPlatform);
      for (const fn of cleanups) fn();
    }

    // If queue was cleared during processing (e.g., /reset), stop here
    if (this.queues.get(chatId) !== state) return;

    // Run deferred cleanups from mid-turn compaction (temp files safe to delete now)
    for (const fn of state.deferredCleanups) fn();
    state.deferredCleanups = [];

    state.busy = false;

    // Drain collect buffer if messages arrived during processing
    await this.drainCollectBuffer(chatId);

    // Evict idle state to prevent unbounded memory growth from stale entries
    this.evictIfIdle(chatId);
  }

  private async drainCollectBuffer(chatId: string): Promise<void> {
    const state = this.queues.get(chatId);
    if (!state || state.collectBuffer.length === 0) return;

    // Dedup: remove messages already consumed by the inject hook mid-turn
    const consumed = this.finalizeInject(chatId, state);
    if (consumed > 0) {
      state.collectBuffer.splice(0, consumed);
      const consumedCleanups = state.collectCleanups.splice(0, consumed);
      for (const fn of consumedCleanups) fn();
      log.debug("message-queue", `Deduped ${consumed} inject-consumed message(s) for ${chatId}`);
    }

    // If all messages were consumed by hook, just run cleanups and return
    if (state.collectBuffer.length === 0) {
      const cleanups = state.collectCleanups.splice(0);
      for (const fn of cleanups) fn();
      return;
    }

    // Loop to drain messages that arrive during processing (avoids recursion)
    while (state.collectBuffer.length > 0) {
      // Dedup messages consumed by hook during previous drain iteration
      const loopConsumed = this.finalizeInject(chatId, state);
      if (loopConsumed > 0) {
        state.collectBuffer.splice(0, loopConsumed);
        const loopCleanups = state.collectCleanups.splice(0, loopConsumed);
        for (const fn of loopCleanups) fn();
        log.debug("message-queue", `Deduped ${loopConsumed} inject-consumed message(s) for ${chatId} (drain loop)`);
      }
      if (state.collectBuffer.length === 0) break;

      const collected = state.collectBuffer.splice(0);
      const cleanups = state.collectCleanups.splice(0);
      const prompt = buildCollectPrompt(collected);

      state.busy = true;
      log.debug(
        "message-queue",
        `Draining ${collected.length} collected message(s) for ${chatId}`,
      );

      this.startPreStreamTyping(state.latestPlatform);

      try {
        if (state.latestPlatform) {
          await this.processFn(chatId, state.agentId, prompt, state.latestPlatform);
        }
      } catch (err) {
        log.error("message-queue", `Collect drain error for ${chatId}:`, err);
        if (state.latestPlatform) {
          await state.latestPlatform
            .replyError(`Something went wrong: ${err instanceof Error ? err.message : String(err)}\n\nTry again or /reset the session.`)
            .catch(() => {});
        }
      } finally {
        this.stopPreStreamTyping(state.latestPlatform);
        for (const fn of cleanups) fn();
      }

      // If queue was cleared during processing, stop draining
      if (this.queues.get(chatId) !== state) return;

      // Run deferred cleanups from mid-turn compaction (temp files safe to delete now)
      for (const fn of state.deferredCleanups) fn();
      state.deferredCleanups = [];

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
      for (const fn of state.deferredCleanups) fn();
      this.queues.delete(chatId);
    }
    // Clean up inject files (safe even if no state)
    try { cleanupInjectDir(injectDirForChat(chatId)); } catch { /* ignore */ }
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
      for (const fn of state.collectCleanups) fn();
      for (const fn of state.deferredCleanups) fn();
      try { cleanupInjectDir(injectDirForChat(chatId)); } catch { /* ignore */ }
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

  /**
   * Refresh injectConsumed from the hook's ack file.
   * Called before cap checks to ensure consumed messages free up buffer space.
   */
  private refreshAck(chatId: string, state: ChatQueueState): void {
    try {
      const dir = injectDirForChat(chatId);
      const ackCount = readAckCount(dir);
      if (ackCount > state.injectLastAck) {
        state.injectConsumed += ackCount - state.injectLastAck;
        state.injectLastAck = ackCount;
      }
    } catch {
      // Non-critical — stale count just means slightly conservative cap check
    }
  }

  /**
   * Write un-consumed collect buffer messages to the inject file.
   * Called each time a mid-turn message is enqueued.
   */
  private writeInject(chatId: string, state: ChatQueueState): void {
    try {
      const dir = injectDirForChat(chatId);

      // Check for new ack updates from hook (messages consumed since last check)
      this.refreshAck(chatId, state);

      // Write all un-consumed messages to inject file
      const toInject = state.collectBuffer.slice(state.injectConsumed);
      if (toInject.length > 0) {
        writeInjectFile(dir, toInject);
      }
    } catch (err) {
      log.warn("message-queue", `Inject file write failed for ${chatId}: ${(err as Error).message}`);
    }
  }

  /**
   * Finalize inject state before draining: read final ack, clean up files, reset state.
   * Returns the number of messages confirmed consumed by hook.
   */
  private finalizeInject(chatId: string, state: ChatQueueState): number {
    try {
      const dir = injectDirForChat(chatId);

      // Read final ack count from hook
      const ackCount = readAckCount(dir);
      if (ackCount > state.injectLastAck) {
        state.injectConsumed += ackCount - state.injectLastAck;
      }

      const consumed = state.injectConsumed;

      // Clean up inject files (pending file may still exist if hook didn't fire)
      cleanupInjectDir(dir);

      // Reset inject state for next turn
      state.injectConsumed = 0;
      state.injectLastAck = 0;

      return consumed;
    } catch (err) {
      log.warn("message-queue", `Inject finalize failed for ${chatId}: ${(err as Error).message}`);
      state.injectConsumed = 0;
      state.injectLastAck = 0;
      return 0;
    }
  }
}
