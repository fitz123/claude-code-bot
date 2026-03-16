import { GrammyError } from "grammy";
import { log } from "./logger.js";

/**
 * Check if an error is a Telegram 409 Conflict error.
 * This happens when another bot instance is already polling.
 */
export function is409ConflictError(err: unknown): boolean {
  // Direct GrammyError
  if (err instanceof GrammyError && err.error_code === 409) return true;

  // BotError wrapping a GrammyError (bot.start() wraps handler errors)
  if (
    err &&
    typeof err === "object" &&
    "error" in err &&
    (err as { error: unknown }).error instanceof GrammyError &&
    ((err as { error: GrammyError }).error).error_code === 409
  ) {
    return true;
  }

  return false;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Injected sleep for testing — defaults to real setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Start a grammY bot with retry-on-409 logic.
 *
 * When a new bot instance starts before Telegram releases the old long-poll
 * connection, the API returns 409 Conflict. Instead of crashing immediately
 * (which causes a launchd crash-loop), this retries with exponential backoff.
 *
 * @param startFn - Function that starts the bot (typically () => bot.start(opts))
 * @param opts - Retry configuration
 */
export async function startBotWithRetry(
  startFn: () => Promise<void>,
  opts?: RetryOptions,
): Promise<void> {
  const maxRetries = opts?.maxRetries ?? 5;
  const baseDelayMs = opts?.baseDelayMs ?? 5_000;
  const sleep = opts?.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await startFn();
      return;
    } catch (err) {
      if (is409ConflictError(err) && attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 60_000);
        log.warn(
          "main",
          `409 Conflict on startup attempt ${attempt}/${maxRetries} — retrying in ${delay / 1000}s`,
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}
