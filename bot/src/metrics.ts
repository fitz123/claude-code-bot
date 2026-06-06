import { createServer, type Server } from "node:http";
import client from "prom-client";
import { log } from "./logger.js";

// Use the default registry
const register = client.register;

// Expose Node.js process metrics (heap, CPU, event loop, GC)
client.collectDefaultMetrics();

// --- Token usage ---
// Legacy bot_claude_* names are retained for dashboard continuity. These
// counters record usage reported by the active agent runtime.

export const tokensInput = new client.Counter({
  name: "bot_claude_tokens_input_total",
  help: "Total input tokens reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

export const tokensOutput = new client.Counter({
  name: "bot_claude_tokens_output_total",
  help: "Total output tokens reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

export const tokensCacheRead = new client.Counter({
  name: "bot_claude_tokens_cache_read_total",
  help: "Total cache-read input tokens reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

export const tokensCacheCreation = new client.Counter({
  name: "bot_claude_tokens_cache_creation_total",
  help: "Total cache-creation input tokens reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

// --- Cost ---

export const costUsd = new client.Counter({
  name: "bot_claude_cost_usd_total",
  help: "Total USD cost reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

// --- Turn duration ---

export const turnDuration = new client.Histogram({
  name: "bot_claude_turn_duration_seconds",
  help: "Turn duration reported by the active agent runtime in seconds (legacy metric name)",
  labelNames: ["agent_id"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

// --- Pi RPC (OpenAI Codex provider) ---
// Registered now (Plan A); consumed by the dispatch/alert layers in later plans.

export const piTurnDuration = new client.Histogram({
  name: "bot_pi_turn_duration_seconds",
  help: "Pi RPC turn duration in seconds",
  labelNames: ["agent_id"] as const,
  // SAME buckets as the legacy runtime histogram so dashboards compare directly.
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

export const piRetryTotal = new client.Counter({
  name: "bot_pi_retry_total",
  help: "Total Pi RPC auto-retries (incremented on every auto_retry_start)",
  labelNames: ["agent_id"] as const,
});

export const pi429Total = new client.Counter({
  name: "bot_pi_429_total",
  help: "Pi RPC auto-retries attributed to a rate-limit (429) signal",
  labelNames: ["agent_id"] as const,
});

export const piOverloadTotal = new client.Counter({
  name: "bot_pi_overload_total",
  help: "Pi RPC auto-retries attributed to an overload (529 / 5xx) signal",
  labelNames: ["agent_id"] as const,
});

export const piRetryUnknownTotal = new client.Counter({
  name: "bot_pi_retry_unknown_total",
  help: "Pi RPC auto-retries whose error message matched no known signal (graceful fallback)",
  labelNames: ["agent_id"] as const,
});

export const piSessionResumeDiscarded = new client.Counter({
  name: "bot_pi_session_resume_discarded_total",
  help: "Pi resume attempts discarded after the stored session id was not found (graceful fresh start)",
  labelNames: ["agent_id"] as const,
});

// --- Telegram API errors ---

export const telegramApiErrors = new client.Counter({
  name: "bot_telegram_api_errors_total",
  help: "Total Telegram API errors",
  labelNames: ["method", "error_code"] as const,
});

// --- Telegram API calls (success + failure) ---

export const telegramApiCalls = new client.Counter({
  name: "bot_telegram_api_calls_total",
  help: "Total Telegram API calls attempted by the bot (success or failure)",
  labelNames: ["method", "binding"] as const,
});

// --- Session lifecycle ---

export const sessionsActive = new client.Gauge({
  name: "bot_sessions_active",
  help: "Number of currently active sessions",
});

export const sessionCrashes = new client.Counter({
  name: "bot_session_crashes_total",
  help: "Total session subprocess crashes",
  labelNames: ["agent_id"] as const,
});

// --- Message flow ---

export const messagesReceived = new client.Counter({
  name: "bot_messages_received_total",
  help: "Total messages received",
  labelNames: ["type"] as const,
});

export const messagesSent = new client.Counter({
  name: "bot_messages_sent_total",
  help: "Total messages sent by the bot",
});

// --- Helpers ---

/**
 * Record metrics from an active-runtime result event.
 * The result message contains usage data via the [key: string]: unknown catch-all.
 */
export function recordResultMetrics(
  agentId: string,
  result: { cost_usd?: number; duration_ms?: number; [key: string]: unknown },
): void {
  if (typeof result.cost_usd === "number") {
    costUsd.inc({ agent_id: agentId }, result.cost_usd);
  }

  if (typeof result.duration_ms === "number") {
    turnDuration.observe({ agent_id: agentId }, result.duration_ms / 1000);
  }

  const usage = result.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    if (typeof usage.input_tokens === "number") {
      tokensInput.inc({ agent_id: agentId }, usage.input_tokens);
    }
    if (typeof usage.output_tokens === "number") {
      tokensOutput.inc({ agent_id: agentId }, usage.output_tokens);
    }
    if (typeof usage.cache_read_input_tokens === "number") {
      tokensCacheRead.inc({ agent_id: agentId }, usage.cache_read_input_tokens);
    }
    if (typeof usage.cache_creation_input_tokens === "number") {
      tokensCacheCreation.inc({ agent_id: agentId }, usage.cache_creation_input_tokens);
    }
  }
}

/** Retry bucket inferred from a Pi RPC auto_retry_start error message. */
export type PiRetryBucket = "429" | "overload" | "unknown";

/**
 * Classify a Pi RPC auto-retry error message into a metric bucket.
 *
 * Defensive by design: the 429 check runs before the 5xx check so a rate-limit
 * is never mis-bucketed as overload, and any unrecognized / missing message
 * falls back to "unknown" so a future Pi wording change is still counted rather
 * than silently dropped.
 */
export function classifyPiRetry(errorMessage?: string): PiRetryBucket {
  const msg = (errorMessage ?? "").toLowerCase();

  // Rate limit (429) — must come first; a 429 must never fall through to 5xx.
  if (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("ratelimit") ||
    msg.includes("too many requests")
  ) {
    return "429";
  }

  // Overload / server error (529, 5xx).
  if (
    msg.includes("529") ||
    msg.includes("overload") ||
    msg.includes("service unavailable") ||
    msg.includes("server error") ||
    /\b5\d\d\b/.test(msg)
  ) {
    return "overload";
  }

  return "unknown";
}

/**
 * Record a Pi RPC auto-retry, classifying the auto_retry_start error message.
 * Always increments pi_retry_total and exactly one of the 429 / overload /
 * unknown buckets. This is the classifier wired to parsePiEvent's
 * auto_retry_start translation (which preserves the raw error_message).
 */
export function recordPiRetry(agentId: string, errorMessage?: string): void {
  piRetryTotal.inc({ agent_id: agentId });

  switch (classifyPiRetry(errorMessage)) {
    case "429":
      pi429Total.inc({ agent_id: agentId });
      break;
    case "overload":
      piOverloadTotal.inc({ agent_id: agentId });
      break;
    default:
      piRetryUnknownTotal.inc({ agent_id: agentId });
      break;
  }
}

/**
 * Record a Pi RPC turn duration (seconds) into the Pi histogram, mirroring the
 * legacy turnDuration observation in recordResultMetrics.
 */
export function recordPiTurnDuration(agentId: string, durationSeconds: number): void {
  piTurnDuration.observe({ agent_id: agentId }, durationSeconds);
}

/**
 * Record a Telegram API error for metrics.
 */
export function recordTelegramApiError(method: string, errorCode: number | string): void {
  telegramApiErrors.inc({ method, error_code: String(errorCode) });
}

/**
 * Record a Telegram API call attempt for metrics. Incremented once per
 * transformer invocation (each autoRetry attempt is a separate call), so
 * `errors / calls` over the same window yields an attempt-level error ratio.
 *
 * The `binding` label MUST come from the resolved binding (or a fixed
 * sentinel) — never from the raw `chat_id`, since that would be unbounded.
 */
export function recordTelegramApiCall(method: string, binding: string): void {
  telegramApiCalls.inc({ method, binding });
}

// --- HTTP server ---

let metricsServer: Server | null = null;

/**
 * Start the Prometheus metrics HTTP server on the given port.
 * Serves /metrics in standard Prometheus text format.
 * Returns the server instance.
 */
export function startMetricsServer(port: number, host?: string): Server {
  const listenHost = host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
      try {
        const metrics = await register.metrics();
        res.writeHead(200, { "Content-Type": register.contentType });
        res.end(metrics);
      } catch (err) {
        res.writeHead(500);
        res.end("Error collecting metrics");
        log.error("metrics", `Failed to collect metrics: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.on("error", (err) => {
    log.error("metrics", `Metrics server error: ${err.message}`);
  });

  server.listen(port, listenHost, () => {
    log.info("metrics", `Prometheus metrics server listening on ${listenHost}:${port}`);
  });

  metricsServer = server;
  return server;
}

/**
 * Stop the metrics server if running.
 */
export function stopMetricsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (metricsServer) {
      metricsServer.close(() => resolve());
      metricsServer = null;
    } else {
      resolve();
    }
  });
}
