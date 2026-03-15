/**
 * Polling liveness watchdog.
 *
 * Tracks the timestamp of the last received Telegram update. A periodic check
 * compares the elapsed time against a threshold. When the threshold is exceeded,
 * a lightweight API heartbeat (getMe) distinguishes a quiet chat period from
 * dead polling. If the heartbeat fails, the process exits so launchd restarts it.
 */

import { log } from "./logger.js";

const DEFAULT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_INTERVAL_MS = 60 * 1000; // 60 seconds

export interface WatchdogDeps {
  /** API heartbeat — should resolve true if Telegram API is reachable. */
  heartbeat: () => Promise<boolean>;
  /** Called to terminate the process. Default: process.exit */
  exit?: (code: number) => void;
  /** Clock for testing. Default: Date.now */
  now?: () => number;
  /** Time without updates before checking connectivity. Default: 600_000 (10 min) */
  thresholdMs?: number;
  /** Interval between checks. Default: 60_000 (60s) */
  intervalMs?: number;
}

export interface Watchdog {
  /** Call on every incoming update to reset the liveness timer. */
  touch(): void;
  /** Start the periodic liveness check. */
  start(): void;
  /** Stop the periodic liveness check. */
  stop(): void;
  /** Run one check cycle (exposed for testing). */
  check(): Promise<void>;
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
  const thresholdMs = deps.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const exitFn = deps.exit ?? ((code: number) => process.exit(code));
  const now = deps.now ?? Date.now;

  let lastUpdateTs = now();
  let timer: ReturnType<typeof setInterval> | null = null;

  function touch(): void {
    lastUpdateTs = now();
  }

  async function check(): Promise<void> {
    const elapsed = now() - lastUpdateTs;
    if (elapsed < thresholdMs) return;

    log.warn(
      "watchdog",
      `No updates for ${Math.round(elapsed / 1000)}s (threshold: ${Math.round(thresholdMs / 1000)}s) — checking API connectivity`,
    );

    try {
      const ok = await deps.heartbeat();
      if (ok) {
        log.info("watchdog", "API heartbeat succeeded — quiet period, resetting watchdog");
        lastUpdateTs = now();
        return;
      }
    } catch (err) {
      log.error("watchdog", "API heartbeat threw:", err);
    }

    log.error("watchdog", "Polling appears dead — exiting for launchd restart");
    exitFn(1);
  }

  function start(): void {
    if (timer) return;
    lastUpdateTs = now();
    timer = setInterval(() => {
      check().catch((err) => {
        log.error("watchdog", "Unexpected check error:", err);
      });
    }, intervalMs);
    // Don't prevent process exit
    if (timer) (timer as NodeJS.Timeout).unref();
    log.info(
      "watchdog",
      `Started (threshold: ${Math.round(thresholdMs / 1000)}s, interval: ${Math.round(intervalMs / 1000)}s)`,
    );
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { touch, start, stop, check };
}
