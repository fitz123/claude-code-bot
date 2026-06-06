import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import client from "prom-client";
import {
  recordResultMetrics,
  recordTelegramApiError,
  recordTelegramApiCall,
  classifyPiRetry,
  recordPiRetry,
  recordPiTurnDuration,
  tokensInput,
  tokensOutput,
  tokensCacheRead,
  tokensCacheCreation,
  costUsd,
  turnDuration,
  piTurnDuration,
  piRetryTotal,
  pi429Total,
  piOverloadTotal,
  piRetryUnknownTotal,
  piSessionResumeDiscarded,
  telegramApiErrors,
  telegramApiCalls,
  sessionsActive,
  sessionCrashes,
  messagesReceived,
  messagesSent,
  startMetricsServer,
  stopMetricsServer,
} from "../metrics.js";
import { parsePiEvent } from "../pi-rpc-protocol.js";

// Reset all metrics before each test to get clean counts
beforeEach(() => {
  client.register.resetMetrics();
});

describe("recordResultMetrics", () => {
  it("records cost and duration", async () => {
    recordResultMetrics("main", {
      cost_usd: 0.05,
      duration_ms: 12000,
    });

    const costVal = await costUsd.get();
    assert.strictEqual(costVal.values.length, 1);
    assert.strictEqual(costVal.values[0].value, 0.05);
    assert.strictEqual(costVal.values[0].labels.agent_id, "main");

    const durVal = await turnDuration.get();
    // Histogram has sum, count, and bucket values
    const sum = durVal.values.find((v) => v.metricName === "bot_claude_turn_duration_seconds_sum");
    assert.ok(sum, "expected histogram sum");
    assert.strictEqual(sum.value, 12); // 12000ms = 12s
  });

  it("records token usage from usage object", async () => {
    recordResultMetrics("test-agent", {
      cost_usd: 0.01,
      duration_ms: 5000,
      usage: {
        input_tokens: 1500,
        output_tokens: 800,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
      },
    });

    const input = await tokensInput.get();
    assert.strictEqual(input.values[0].value, 1500);
    assert.strictEqual(input.values[0].labels.agent_id, "test-agent");

    const output = await tokensOutput.get();
    assert.strictEqual(output.values[0].value, 800);

    const cacheRead = await tokensCacheRead.get();
    assert.strictEqual(cacheRead.values[0].value, 500);

    const cacheCreate = await tokensCacheCreation.get();
    assert.strictEqual(cacheCreate.values[0].value, 100);
  });

  it("handles missing fields gracefully", async () => {
    // Should not throw when fields are missing
    recordResultMetrics("main", {});

    const costVal = await costUsd.get();
    assert.strictEqual(costVal.values.length, 0);
  });

  it("handles missing usage gracefully", async () => {
    recordResultMetrics("main", { cost_usd: 0.01 });

    const input = await tokensInput.get();
    assert.strictEqual(input.values.length, 0);
  });

  it("accumulates across multiple calls", async () => {
    recordResultMetrics("main", { cost_usd: 0.05 });
    recordResultMetrics("main", { cost_usd: 0.03 });

    const costVal = await costUsd.get();
    assert.strictEqual(costVal.values[0].value, 0.08);
  });
});

describe("legacy active-runtime metric compatibility", () => {
  it("keeps legacy bot_claude names while describing active-runtime usage", async () => {
    const body = await client.register.metrics();

    assert.match(
      body,
      /# HELP bot_claude_tokens_input_total Total input tokens reported by the active agent runtime \(legacy metric name\)/,
    );
    assert.match(
      body,
      /# HELP bot_claude_tokens_output_total Total output tokens reported by the active agent runtime \(legacy metric name\)/,
    );
    assert.match(
      body,
      /# HELP bot_claude_cost_usd_total Total USD cost reported by the active agent runtime \(legacy metric name\)/,
    );
    assert.match(
      body,
      /# HELP bot_claude_turn_duration_seconds Turn duration reported by the active agent runtime in seconds \(legacy metric name\)/,
    );
  });
});

describe("recordTelegramApiError", () => {
  it("records error with method and code labels", async () => {
    recordTelegramApiError("editMessageText", 429);

    const val = await telegramApiErrors.get();
    assert.strictEqual(val.values.length, 1);
    assert.strictEqual(val.values[0].labels.method, "editMessageText");
    assert.strictEqual(val.values[0].labels.error_code, "429");
    assert.strictEqual(val.values[0].value, 1);
  });

  it("records http_error string code", async () => {
    recordTelegramApiError("sendMessage", "http_error");

    const val = await telegramApiErrors.get();
    assert.strictEqual(val.values[0].labels.error_code, "http_error");
  });

  it("accumulates errors per label set", async () => {
    recordTelegramApiError("editMessageText", 429);
    recordTelegramApiError("editMessageText", 429);
    recordTelegramApiError("sendMessage", 400);

    const val = await telegramApiErrors.get();
    const edit429 = val.values.find(
      (v) => v.labels.method === "editMessageText" && v.labels.error_code === "429",
    );
    const send400 = val.values.find(
      (v) => v.labels.method === "sendMessage" && v.labels.error_code === "400",
    );
    assert.strictEqual(edit429?.value, 2);
    assert.strictEqual(send400?.value, 1);
  });
});

describe("recordTelegramApiCall", () => {
  it("records call with method and binding labels", async () => {
    recordTelegramApiCall("sendMessage", "User1 DM");

    const val = await telegramApiCalls.get();
    assert.strictEqual(val.values.length, 1);
    assert.strictEqual(val.values[0].labels.method, "sendMessage");
    assert.strictEqual(val.values[0].labels.binding, "User1 DM");
    assert.strictEqual(val.values[0].value, 1);
  });

  it("accumulates per (method, binding) label set", async () => {
    recordTelegramApiCall("sendMessage", "User1 DM");
    recordTelegramApiCall("sendMessage", "User1 DM");
    recordTelegramApiCall("sendMessage", "Group A");
    recordTelegramApiCall("getUpdates", "none");

    const val = await telegramApiCalls.get();
    const userSend = val.values.find(
      (v) => v.labels.method === "sendMessage" && v.labels.binding === "User1 DM",
    );
    const groupSend = val.values.find(
      (v) => v.labels.method === "sendMessage" && v.labels.binding === "Group A",
    );
    const poll = val.values.find(
      (v) => v.labels.method === "getUpdates" && v.labels.binding === "none",
    );
    assert.strictEqual(userSend?.value, 2);
    assert.strictEqual(groupSend?.value, 1);
    assert.strictEqual(poll?.value, 1);
  });

  it("records 'unbound' sentinel as a regular label value", async () => {
    recordTelegramApiCall("sendMessage", "unbound");

    const val = await telegramApiCalls.get();
    assert.strictEqual(val.values[0].labels.binding, "unbound");
    assert.strictEqual(val.values[0].value, 1);
  });
});

describe("session lifecycle metrics", () => {
  it("sessionsActive gauge increments and decrements", async () => {
    sessionsActive.inc();
    sessionsActive.inc();
    let val = await sessionsActive.get();
    assert.strictEqual(val.values[0].value, 2);

    sessionsActive.dec();
    val = await sessionsActive.get();
    assert.strictEqual(val.values[0].value, 1);
  });

  it("sessionCrashes counter increments", async () => {
    sessionCrashes.inc();
    sessionCrashes.inc();

    const val = await sessionCrashes.get();
    assert.strictEqual(val.values[0].value, 2);
  });
});

describe("message flow metrics", () => {
  it("messagesReceived tracks by type", async () => {
    messagesReceived.inc({ type: "text" });
    messagesReceived.inc({ type: "text" });
    messagesReceived.inc({ type: "voice" });

    const val = await messagesReceived.get();
    const text = val.values.find((v) => v.labels.type === "text");
    const voice = val.values.find((v) => v.labels.type === "voice");
    assert.strictEqual(text?.value, 2);
    assert.strictEqual(voice?.value, 1);
  });

  it("messagesSent increments", async () => {
    messagesSent.inc();
    messagesSent.inc();
    messagesSent.inc();

    const val = await messagesSent.get();
    assert.strictEqual(val.values[0].value, 3);
  });
});

describe("classifyPiRetry", () => {
  it("buckets rate-limit signals as 429", () => {
    assert.strictEqual(classifyPiRetry("HTTP 429 Too Many Requests"), "429");
    assert.strictEqual(classifyPiRetry("rate limit exceeded, retrying"), "429");
    assert.strictEqual(classifyPiRetry("rate_limit_error"), "429");
  });

  it("buckets overload / 5xx signals as overload", () => {
    assert.strictEqual(classifyPiRetry("upstream returned 529 overloaded"), "overload");
    assert.strictEqual(classifyPiRetry("503 Service Unavailable"), "overload");
    assert.strictEqual(classifyPiRetry("internal server error"), "overload");
  });

  it("prefers 429 over overload when both could match", () => {
    // A 429 message must never be mis-bucketed as a 5xx/overload.
    assert.strictEqual(classifyPiRetry("429 after a transient 503"), "429");
  });

  it("falls back to unknown for unrecognized or missing messages", () => {
    assert.strictEqual(classifyPiRetry("connection reset by peer"), "unknown");
    assert.strictEqual(classifyPiRetry(""), "unknown");
    assert.strictEqual(classifyPiRetry(undefined), "unknown");
  });
});

describe("recordPiRetry", () => {
  async function bucketValue(
    counter: typeof piRetryTotal,
    agentId: string,
  ): Promise<number> {
    const metric = await counter.get();
    const entry = metric.values.find((v) => v.labels.agent_id === agentId);
    return entry?.value ?? 0;
  }

  it("always increments pi_retry_total plus exactly the 429 bucket", async () => {
    recordPiRetry("main", "HTTP 429 rate limit");

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(pi429Total, "main"), 1);
    assert.strictEqual(await bucketValue(piOverloadTotal, "main"), 0);
    assert.strictEqual(await bucketValue(piRetryUnknownTotal, "main"), 0);
  });

  it("always increments pi_retry_total plus exactly the overload bucket", async () => {
    recordPiRetry("main", "529 overloaded");

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(pi429Total, "main"), 0);
    assert.strictEqual(await bucketValue(piOverloadTotal, "main"), 1);
    assert.strictEqual(await bucketValue(piRetryUnknownTotal, "main"), 0);
  });

  it("always increments pi_retry_total plus exactly the unknown bucket", async () => {
    recordPiRetry("main", "some brand new wording");

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(pi429Total, "main"), 0);
    assert.strictEqual(await bucketValue(piOverloadTotal, "main"), 0);
    assert.strictEqual(await bucketValue(piRetryUnknownTotal, "main"), 1);
  });

  it("treats a missing error message as unknown but still counts the retry", async () => {
    recordPiRetry("main");

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(piRetryUnknownTotal, "main"), 1);
  });

  it("classifies the error_message carried by a translated auto_retry_start", async () => {
    // End-to-end wiring: Pi raw event -> parsePiEvent -> classifier metric.
    const line = parsePiEvent({ type: "auto_retry_start", errorMessage: "429 slow down" });
    assert.ok(line);
    const errorMessage = (line as { error_message?: string }).error_message;
    recordPiRetry("main", errorMessage);

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(pi429Total, "main"), 1);
  });
});

describe("recordPiTurnDuration", () => {
  it("observes seconds into the Pi turn-duration histogram", async () => {
    recordPiTurnDuration("main", 30);

    const durVal = await piTurnDuration.get();
    const sum = durVal.values.find(
      (v) => v.metricName === "bot_pi_turn_duration_seconds_sum",
    );
    assert.ok(sum, "expected Pi histogram sum");
    assert.strictEqual(sum.value, 30);
    assert.strictEqual(sum.labels.agent_id, "main");
  });
});

describe("piSessionResumeDiscarded", () => {
  async function bucketValue(agentId: string): Promise<number> {
    const metric = await piSessionResumeDiscarded.get();
    const entry = metric.values.find((v) => v.labels.agent_id === agentId);
    return entry?.value ?? 0;
  }

  it("increments per agent_id when a Pi resume is discarded", async () => {
    piSessionResumeDiscarded.inc({ agent_id: "pi" });
    assert.strictEqual(await bucketValue("pi"), 1);
    assert.strictEqual(await bucketValue("other"), 0);
  });

  it("accumulates across multiple discards for the same agent", async () => {
    piSessionResumeDiscarded.inc({ agent_id: "pi" });
    piSessionResumeDiscarded.inc({ agent_id: "pi" });
    assert.strictEqual(await bucketValue("pi"), 2);
  });
});

describe("Pi metrics registration", () => {
  it("registers all Pi metrics on the default registry", () => {
    const names = client.register.getMetricsAsArray().map((m) => m.name);
    for (const name of [
      "bot_pi_turn_duration_seconds",
      "bot_pi_retry_total",
      "bot_pi_429_total",
      "bot_pi_overload_total",
      "bot_pi_retry_unknown_total",
      "bot_pi_session_resume_discarded_total",
    ]) {
      assert.ok(names.includes(name), `expected ${name} to be registered`);
    }
  });

  it("exposes Pi metrics in the scrape output", async () => {
    recordPiRetry("main", "429 rate limit");
    recordPiTurnDuration("main", 5);
    piSessionResumeDiscarded.inc({ agent_id: "main" });

    const body = await client.register.metrics();
    assert.ok(body.includes("bot_pi_turn_duration_seconds"));
    assert.ok(body.includes("bot_pi_retry_total"));
    assert.ok(body.includes("bot_pi_429_total"));
    assert.ok(body.includes("bot_pi_overload_total"));
    assert.ok(body.includes("bot_pi_retry_unknown_total"));
    assert.ok(body.includes("bot_pi_session_resume_discarded_total"));
  });
});

describe("metrics HTTP server", () => {
  afterEach(async () => {
    await stopMetricsServer();
  });

  it("serves /metrics endpoint with Prometheus text format", async () => {
    // Use port 0 to let the OS assign an available port
    const server = startMetricsServer(0);
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address() as { port: number };

    // Record some data
    messagesReceived.inc({ type: "text" });
    costUsd.inc({ agent_id: "test" }, 0.01);

    const res = await fetch(`http://localhost:${addr.port}/metrics`);
    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get("content-type") ?? "";
    assert.ok(contentType.includes("text/plain") || contentType.includes("openmetrics"), `Expected text/plain or openmetrics, got: ${contentType}`);

    const body = await res.text();
    assert.ok(body.includes("bot_messages_received_total"), "Expected messagesReceived metric");
    assert.ok(body.includes("bot_claude_cost_usd_total"), "Expected costUsd metric");
  });

  it("returns 404 for non-metrics paths", async () => {
    const server = startMetricsServer(0);
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/other`);
    assert.strictEqual(res.status, 404);
  });

  it("defaults host to 127.0.0.1 when not specified", async () => {
    const server = startMetricsServer(0);
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address() as { address: string; port: number };
    assert.strictEqual(addr.address, "127.0.0.1");
  });

  it("binds to provided host (0.0.0.0 for Linux Docker scrape)", async () => {
    const server = startMetricsServer(0, "0.0.0.0");
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address() as { address: string; port: number };
    assert.strictEqual(addr.address, "0.0.0.0");

    // Verify still reachable on loopback even when bound to 0.0.0.0
    const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
    assert.strictEqual(res.status, 200);
  });
});
