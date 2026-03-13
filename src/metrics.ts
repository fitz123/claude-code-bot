import { createServer, type Server } from "node:http";
import client from "prom-client";
import { log } from "./logger.js";

// Use the default registry
const register = client.register;

// --- Token usage ---

export const tokensInput = new client.Counter({
  name: "bot_claude_tokens_input_total",
  help: "Total input tokens consumed",
  labelNames: ["agent_id"] as const,
});

export const tokensOutput = new client.Counter({
  name: "bot_claude_tokens_output_total",
  help: "Total output tokens consumed",
  labelNames: ["agent_id"] as const,
});

export const tokensCacheRead = new client.Counter({
  name: "bot_claude_tokens_cache_read_total",
  help: "Total cache read input tokens",
  labelNames: ["agent_id"] as const,
});

export const tokensCacheCreation = new client.Counter({
  name: "bot_claude_tokens_cache_creation_total",
  help: "Total cache creation input tokens",
  labelNames: ["agent_id"] as const,
});

// --- Cost ---

export const costUsd = new client.Counter({
  name: "bot_claude_cost_usd_total",
  help: "Total USD cost from Claude API",
  labelNames: ["agent_id"] as const,
});

// --- Turn duration ---

export const turnDuration = new client.Histogram({
  name: "bot_claude_turn_duration_seconds",
  help: "Claude turn duration in seconds",
  labelNames: ["agent_id"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

// --- Telegram API errors ---

export const telegramApiErrors = new client.Counter({
  name: "bot_telegram_api_errors_total",
  help: "Total Telegram API errors",
  labelNames: ["method", "error_code"] as const,
});

// --- Session lifecycle ---

export const sessionsActive = new client.Gauge({
  name: "bot_sessions_active",
  help: "Number of currently active sessions",
});

export const sessionCrashes = new client.Counter({
  name: "bot_session_crashes_total",
  help: "Total session subprocess crashes",
});

// --- Message flow ---

export const messagesReceived = new client.Counter({
  name: "bot_telegram_messages_received_total",
  help: "Total Telegram messages received",
  labelNames: ["type"] as const,
});

export const messagesSent = new client.Counter({
  name: "bot_telegram_messages_sent_total",
  help: "Total Telegram messages sent by the bot",
});

// --- Helpers ---

/**
 * Record metrics from a Claude CLI result event.
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

/**
 * Record a Telegram API error for metrics.
 */
export function recordTelegramApiError(method: string, errorCode: number | string): void {
  telegramApiErrors.inc({ method, error_code: String(errorCode) });
}

// --- HTTP server ---

let metricsServer: Server | null = null;

/**
 * Start the Prometheus metrics HTTP server on the given port.
 * Serves /metrics in standard Prometheus text format.
 * Returns the server instance.
 */
export function startMetricsServer(port: number): Server {
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

  server.listen(port, () => {
    log.info("metrics", `Prometheus metrics server listening on port ${port}`);
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
