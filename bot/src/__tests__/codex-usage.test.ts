import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_USAGE_TEXTFILE_NAME,
  captureCodexQuotaFromHeaders,
  DEFAULT_NODE_EXPORTER_TEXTFILE_DIR,
  extractCodexResponseHeaders,
  formatCodexQuotaPrometheus,
  formatCodexQuotaWriteError,
  parseCodexQuotaHeaders,
  recordCodexQuotaFromHeaders,
  resolveCodexQuotaPaths,
  writeCodexQuotaSnapshot,
  type CodexQuotaSnapshot,
} from "../pi-extensions/codex-usage.js";

const fixtures: string[] = [];

after(() => {
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-usage-test-"));
  fixtures.push(dir);
  return dir;
}

function sampleSnapshot(): CodexQuotaSnapshot {
  const parsed = parseCodexQuotaHeaders(
    {
      "x-codex-primary-used-percent": "12.5",
      "x-codex-secondary-used-percent": "88",
      "x-codex-primary-reset-at": "2026-06-05T17:00:00.000Z",
      "x-codex-secondary-reset-at": "2026-06-12T00:00:00.000Z",
      "x-codex-plan-type": "Pro",
      "x-codex-active-limit": "primary",
    },
    new Date("2026-06-05T12:00:00.000Z"),
  );
  assert.ok(parsed);
  return parsed;
}

describe("codex usage header parsing", () => {
  it("parses Codex quota headers into the 5h and weekly windows", () => {
    const snapshot = sampleSnapshot();

    assert.equal(snapshot.provider, "codex");
    assert.equal(snapshot.sampledAt, "2026-06-05T12:00:00.000Z");
    assert.equal(snapshot.lastSuccessTimestamp, 1780660800);
    assert.deepEqual(snapshot.windows["5h"], {
      usedPercent: 12.5,
      remainingPercent: 87.5,
      resetAt: "2026-06-05T17:00:00.000Z",
      resetTimestamp: 1780678800,
    });
    assert.deepEqual(snapshot.windows.week, {
      usedPercent: 88,
      remainingPercent: 12,
      resetAt: "2026-06-12T00:00:00.000Z",
      resetTimestamp: 1781222400,
    });
    assert.equal(snapshot.planType, "Pro");
    assert.equal(snapshot.activeLimit, "primary");
  });

  it("handles case-insensitive records, header arrays, and percent suffixes", () => {
    const snapshot = parseCodexQuotaHeaders(
      [
        ["X-Codex-Primary-Used-Percent", "7.25%"],
        ["X-Codex-Secondary-Reset-At", "1781222400000"],
      ],
      new Date("2026-06-05T12:00:00.000Z"),
    );

    assert.ok(snapshot);
    assert.equal(snapshot.windows["5h"].usedPercent, 7.25);
    assert.equal(snapshot.windows["5h"].remainingPercent, 92.75);
    assert.equal(snapshot.windows.week.resetAt, "2026-06-12T00:00:00.000Z");
  });

  it("skips malformed numeric and timestamp headers without throwing", () => {
    const snapshot = parseCodexQuotaHeaders(
      {
        "x-codex-primary-used-percent": "not-a-number",
        "x-codex-secondary-used-percent": "35.5",
        "x-codex-primary-reset-at": "not-a-date",
        "x-codex-plan-type": "  Team   Plan  ",
      },
      new Date("2026-06-05T12:00:00.000Z"),
    );

    assert.ok(snapshot);
    assert.equal(snapshot.windows["5h"].usedPercent, undefined);
    assert.equal(snapshot.windows["5h"].resetTimestamp, undefined);
    assert.equal(snapshot.windows.week.usedPercent, 35.5);
    assert.equal(snapshot.windows.week.remainingPercent, 64.5);
    assert.equal(snapshot.planType, "Team Plan");
  });

  it("returns null when no known quota headers are present", () => {
    assert.equal(parseCodexQuotaHeaders({ "content-type": "application/json" }), null);
    assert.equal(parseCodexQuotaHeaders(undefined), null);
  });

  it("returns null for metadata-only or all-malformed quota usage headers", () => {
    assert.equal(
      parseCodexQuotaHeaders({
        "x-codex-plan-type": "Pro",
        "x-codex-active-limit": "primary",
      }),
      null,
    );
    assert.equal(
      parseCodexQuotaHeaders({
        "x-codex-primary-used-percent": "not-a-number",
        "x-codex-secondary-used-percent": "-1",
        "x-codex-primary-reset-at": "2026-06-05T17:00:00.000Z",
      }),
      null,
    );
  });

  it("finds nested provider response headers defensively", () => {
    const headers = {
      "x-codex-primary-used-percent": "41",
    };

    assert.equal(
      extractCodexResponseHeaders({ providerResponse: { response: { headers } } }),
      headers,
    );
  });
});

describe("codex usage paths and Prometheus formatting", () => {
  it("uses env paths, then node_exporter env, then writable Homebrew textfile default", () => {
    const cwd = "/tmp/codex-usage-cwd";
    assert.deepEqual(
      resolveCodexQuotaPaths({
        cwd,
        env: {
          CODEX_QUOTA_STATE_FILE: "state/quota.json",
          CODEX_QUOTA_TEXTFILE_DIR: "metrics",
          NODE_EXPORTER_TEXTFILE_DIR: "ignored",
        },
        isWritableDir: () => false,
      }),
      {
        stateFile: "/tmp/codex-usage-cwd/state/quota.json",
        textfileDir: "/tmp/codex-usage-cwd/metrics",
      },
    );

    assert.deepEqual(
      resolveCodexQuotaPaths({
        cwd,
        env: { NODE_EXPORTER_TEXTFILE_DIR: "node-metrics" },
        isWritableDir: () => false,
      }),
      {
        stateFile: "/tmp/codex-usage-cwd/.tmp/codex-quota-state.json",
        textfileDir: "/tmp/codex-usage-cwd/node-metrics",
      },
    );

    assert.deepEqual(
      resolveCodexQuotaPaths({
        cwd,
        env: {},
        isWritableDir: (path) => path === DEFAULT_NODE_EXPORTER_TEXTFILE_DIR,
      }),
      {
        stateFile: "/tmp/codex-usage-cwd/.tmp/codex-quota-state.json",
        textfileDir: DEFAULT_NODE_EXPORTER_TEXTFILE_DIR,
      },
    );

    assert.deepEqual(
      resolveCodexQuotaPaths({
        cwd,
        env: {},
        isWritableDir: () => false,
      }),
      {
        stateFile: "/tmp/codex-usage-cwd/.tmp/codex-quota-state.json",
      },
    );
  });

  it("formats ADR-compatible gauges and low-cardinality metadata labels", () => {
    const text = formatCodexQuotaPrometheus({
      ...sampleSnapshot(),
      planType: "ChatGPT Team",
      activeLimit: "primary window",
    });

    assert.match(text, /# TYPE codex_usage_5h_percent gauge/);
    assert.match(text, /codex_usage_5h_percent 12\.5/);
    assert.match(text, /codex_usage_weekly_percent 88/);
    assert.match(text, /codex_usage_5h_reset_timestamp 1780678800/);
    assert.match(text, /codex_usage_weekly_reset_timestamp 1781222400/);
    assert.match(text, /codex_usage_last_success_timestamp 1780660800/);
    assert.match(
      text,
      /codex_usage_info\{provider="codex",plan_type="chatgpt_team",active_limit="primary_window"\} 1/,
    );
  });
});

describe("codex usage atomic writes", () => {
  it("captures parsed quota headers to an attempt file without promoting canonical state", () => {
    const dir = tempDir();
    const stateFile = join(dir, "state.json");
    const attemptFile = join(dir, "attempts", "quota-attempt.json");

    const result = captureCodexQuotaFromHeaders(
      { "x-codex-primary-used-percent": "12.5" },
      {
        env: { CODEX_QUOTA_ATTEMPT_FILE: attemptFile },
        now: new Date("2026-06-05T12:00:00.000Z"),
      },
    );

    assert.equal(result.status, "captured");
    assert.equal(existsSync(attemptFile), true);
    assert.equal(existsSync(stateFile), false);
    assert.equal(JSON.parse(readFileSync(attemptFile, "utf8")).windows["5h"].usedPercent, 12.5);
  });

  it("writes JSON state and Prometheus textfiles atomically", () => {
    const dir = tempDir();
    const stateFile = join(dir, "state", "quota.json");
    const textfileDir = join(dir, "textfiles");
    const result = writeCodexQuotaSnapshot(sampleSnapshot(), {
      stateFile,
      textfileDir,
    });

    assert.equal(result.stateFile, stateFile);
    assert.equal(result.metricsFile, join(textfileDir, CODEX_USAGE_TEXTFILE_NAME));
    assert.equal(existsSync(stateFile), true);
    assert.equal(existsSync(result.metricsFile), true);

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.provider, "codex");
    assert.equal(state.windows["5h"].usedPercent, 12.5);

    const metrics = readFileSync(result.metricsFile, "utf8");
    assert.match(metrics, /codex_usage_5h_percent 12\.5/);
    assert.equal(readdirSync(join(dir, "state")).some((name) => name.endsWith(".tmp")), false);
    assert.equal(readdirSync(textfileDir).some((name) => name.endsWith(".tmp")), false);
  });

  it("replaces existing files with the latest successful snapshot", () => {
    const dir = tempDir();
    const stateFile = join(dir, "state.json");
    const textfileDir = join(dir, "metrics");
    writeFileSync(stateFile, "old\n");

    const first = sampleSnapshot();
    writeCodexQuotaSnapshot(first, { stateFile, textfileDir });

    const second = parseCodexQuotaHeaders(
      {
        "x-codex-primary-used-percent": "30",
      },
      new Date("2026-06-05T13:00:00.000Z"),
    );
    assert.ok(second);
    writeCodexQuotaSnapshot(second, { stateFile, textfileDir });

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.windows["5h"].usedPercent, 30);
    assert.equal(state.lastSuccessTimestamp, 1780664400);
    assert.match(readFileSync(join(textfileDir, CODEX_USAGE_TEXTFILE_NAME), "utf8"), /codex_usage_5h_percent 30/);
  });

  it("leaves existing state untouched when metrics staging fails", () => {
    const dir = tempDir();
    const stateFile = join(dir, "state.json");
    const blockedMetricsDir = join(dir, "blocked-metrics");
    const priorState = "old-state\n";
    writeFileSync(stateFile, priorState);
    writeFileSync(blockedMetricsDir, "not a directory");

    assert.throws(
      () => writeCodexQuotaSnapshot(sampleSnapshot(), { stateFile, textfileDir: blockedMetricsDir }),
      /ENOTDIR|EEXIST/,
    );
    assert.equal(readFileSync(stateFile, "utf8"), priorState);
  });

  it("treats absent quota headers as no-op before writing", () => {
    const dir = tempDir();
    const stateFile = join(dir, "state.json");
    const result = recordCodexQuotaFromHeaders(
      { "content-type": "application/json" },
      { stateFile, textfileDir: join(dir, "metrics") },
    );

    assert.deepEqual(result, { status: "no_quota_headers" });
    assert.equal(existsSync(stateFile), false);
  });

  it("returns write_error with a structured warning when the cache path cannot be written", () => {
    const dir = tempDir();
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");

    const result = recordCodexQuotaFromHeaders(
      { "x-codex-primary-used-percent": "12.5" },
      { stateFile: join(blocked, "quota.json"), textfileDir: join(dir, "metrics") },
    );

    assert.equal(result.status, "write_error");
    if (result.status !== "write_error") {
      return;
    }
    assert.match(formatCodexQuotaWriteError(result.error), /^\[codex-usage\] failed to write quota cache:/);
  });
});
