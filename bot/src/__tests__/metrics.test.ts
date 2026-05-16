import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import client from "prom-client";
import {
  recordResultMetrics,
  recordTelegramApiError,
  recordTelegramApiCall,
  tokensInput,
  tokensOutput,
  tokensCacheRead,
  tokensCacheCreation,
  costUsd,
  turnDuration,
  telegramApiErrors,
  telegramApiCalls,
  sessionsActive,
  sessionCrashes,
  messagesReceived,
  messagesSent,
  startMetricsServer,
  stopMetricsServer,
} from "../metrics.js";

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
