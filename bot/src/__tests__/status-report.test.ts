import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../status-report.js";
import type { SessionHealth } from "../session-manager.js";
import type { QuotaSnapshot, QuotaStatus } from "../quota-status.js";

const NOW = new Date("2026-06-05T12:00:00.000Z");

function ts(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function baseHealth(overrides: Partial<SessionHealth> = {}): SessionHealth {
  return {
    pid: 12345,
    alive: true,
    agentId: "main",
    sessionId: "session-123",
    provider: "pi",
    model: "openai-codex/gpt-5.5",
    thinking: "xhigh",
    idleMs: 125_000,
    processingMs: null,
    lastSuccessAt: NOW.getTime() - 2 * 60_000,
    restartCount: 0,
    ...overrides,
  };
}

function quotaSnapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    provider: "codex",
    sampledAt: "2026-06-05T11:58:00.000Z",
    lastSuccess: "2026-06-05T11:58:00.000Z",
    lastSuccessTimestamp: ts("2026-06-05T11:58:00.000Z"),
    planType: "Pro",
    activeLimit: "primary",
    windows: {
      "5h": {
        usedPercent: 12.5,
        remainingPercent: 87.5,
        resetAt: "2026-06-05T16:52:00.000Z",
        resetTimestamp: ts("2026-06-05T16:52:00.000Z"),
      },
      week: {
        usedPercent: 88,
        remainingPercent: 12,
        resetAt: "2026-06-12T11:00:00.000Z",
        resetTimestamp: ts("2026-06-12T11:00:00.000Z"),
      },
    },
    ...overrides,
  };
}

function baseReport(overrides: Partial<Parameters<typeof buildStatusReport>[0]> = {}): string {
  return buildStatusReport({
    activeCount: 1,
    maxSessions: 3,
    uptimeSeconds: 7_500,
    sessionHealth: baseHealth(),
    now: NOW,
    ...overrides,
  });
}

describe("buildStatusReport", () => {
  it("renders compact idle session health without healthy-path noise", () => {
    const text = baseReport();

    assert.match(text, /Sessions: 1\/3/);
    assert.match(text, /Uptime: 2h 5m/);
    assert.match(text, /Agent: main \(pi\)/);
    assert.match(text, /Model: openai-codex\/gpt-5\.5/);
    assert.match(text, /Thinking: xhigh/);
    assert.match(text, /State: idle \(2m\)/);
    assert.match(text, /Session ID: session-123/);
    assert.match(text, /Codex quota: unavailable \(no cached state\)/);
    assert.doesNotMatch(text, /Memory/i);
    assert.doesNotMatch(text, /PID/);
    assert.doesNotMatch(text, /Last success/);
    assert.doesNotMatch(text, /Restarts/);
  });

  it("renders processing state and Pi thinking", () => {
    const text = baseReport({
      sessionHealth: baseHealth({
        provider: "pi",
        model: "openai-codex/gpt-5.5",
        thinking: "high",
        processingMs: 42_500,
      }),
      quotaStatus: {
        state: "unavailable",
        stateFile: "/tmp/missing.json",
        reason: "missing_file",
        staleMs: 1_800_000,
      },
    });

    assert.match(text, /Agent: main \(pi\)/);
    assert.match(text, /Model: openai-codex\/gpt-5\.5/);
    assert.match(text, /Thinking: high/);
    assert.match(text, /State: processing \(42s\)/);
    assert.match(text, /Codex quota: unavailable \(state file missing\)/);
  });

  it("includes PID diagnostics when the session process is dead", () => {
    const text = baseReport({
      sessionHealth: baseHealth({ alive: false, pid: 9876 }),
    });

    assert.match(text, /Diagnostics:/);
    assert.match(text, /Process: dead \(PID 9876\)/);
  });

  it("includes restart diagnostics only when restarts are non-zero", () => {
    const text = baseReport({
      sessionHealth: baseHealth({ restartCount: 2 }),
    });

    assert.match(text, /Diagnostics:/);
    assert.match(text, /Restarts: 2/);
  });

  it("includes last success diagnostics when missing or stale", () => {
    const missing = baseReport({
      sessionHealth: baseHealth({ lastSuccessAt: null }),
    });
    const stale = baseReport({
      sessionHealth: baseHealth({ lastSuccessAt: NOW.getTime() - 31 * 60_000 }),
    });

    assert.match(missing, /Last success: none/);
    assert.match(stale, /Last success: 31m ago \(stale\)/);
  });

  it("renders fresh Codex quota with used, left, reset ETA, and sample age", () => {
    const quotaStatus: QuotaStatus = {
      state: "available",
      stateFile: "/tmp/quota.json",
      snapshot: quotaSnapshot({
        lastAttempt: "2026-06-05T11:59:00.000Z",
        lastAttemptTimestamp: ts("2026-06-05T11:59:00.000Z"),
        probeSuccess: true,
      }),
      ageMs: 120_000,
      sampleAge: "2m ago",
      staleMs: 1_800_000,
    };

    const text = baseReport({ quotaStatus });

    assert.match(text, /Codex quota: fresh \(sample 2m ago\)/);
    assert.match(text, /plan Pro, active primary/);
    assert.match(text, /5h: 12\.5% used, 87\.5% left, resets in 4h 52m/);
    assert.match(text, /week: 88% used, 12% left, resets in 6d 23h/);
    assert.match(text, /Last attempt: 1m ago \(ok\)/);
  });

  it("renders stale Codex quota honestly with attempt and cached values", () => {
    const quotaStatus: QuotaStatus = {
      state: "stale",
      stateFile: "/tmp/quota.json",
      snapshot: quotaSnapshot({
        lastSuccessTimestamp: ts("2026-06-05T11:29:00.000Z"),
        lastAttemptTimestamp: ts("2026-06-05T11:59:00.000Z"),
        probeSuccess: false,
      }),
      ageMs: 31 * 60_000,
      sampleAge: "31m ago",
      staleMs: 1_800_000,
    };

    const text = baseReport({ quotaStatus });

    assert.match(text, /Codex quota: stale \(last success 31m ago\)/);
    assert.match(text, /5h: 12\.5% used, 87\.5% left/);
    assert.match(text, /Last attempt: 1m ago \(failed\)/);
  });

  it("renders unavailable Codex quota with a failed last attempt before any success", () => {
    const quotaStatus: QuotaStatus = {
      state: "unavailable",
      stateFile: "/tmp/quota.json",
      reason: "no_success",
      staleMs: 1_800_000,
      snapshot: quotaSnapshot({
        sampledAt: undefined,
        lastSuccess: undefined,
        lastSuccessTimestamp: undefined,
        lastAttemptTimestamp: ts("2026-06-05T11:59:00.000Z"),
        probeSuccess: false,
      }),
    };

    const text = baseReport({ quotaStatus });

    assert.match(text, /Codex quota: unavailable \(no successful sample\)/);
    assert.match(text, /Last attempt: 1m ago \(failed\)/);
  });

  it("renders missing and read-error quota states for Pi sessions", () => {
    const missing = baseReport({
      quotaStatus: {
        state: "unavailable",
        stateFile: "/tmp/missing.json",
        reason: "missing_file",
        staleMs: 1_800_000,
      },
    });
    const readError = baseReport({
      quotaStatus: {
        state: "read_error",
        stateFile: "/tmp/quota.json",
        error: "bad json",
        staleMs: 1_800_000,
      },
    });

    assert.match(missing, /Codex quota: unavailable \(state file missing\)/);
    assert.match(readError, /Codex quota: unavailable \(read error\)/);
    assert.doesNotMatch(readError, /bad json/);
  });

  it("renders missing quota data for Pi sessions", () => {
    const text = baseReport({
      sessionHealth: baseHealth({
        provider: "pi",
        model: "openai-codex/gpt-5.5",
        thinking: "medium",
      }),
      quotaStatus: {
        state: "unavailable",
        stateFile: "/tmp/missing.json",
        reason: "missing_file",
        staleMs: 1_800_000,
      },
    });

    assert.match(text, /Codex quota: unavailable \(state file missing\)/);
  });
});
