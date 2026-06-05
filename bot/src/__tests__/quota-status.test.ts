import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CODEX_QUOTA_STALE_MS,
  formatCompactDuration,
  formatResetEta,
  formatSampleAge,
  readQuotaStatus,
  resolveQuotaStateFile,
} from "../quota-status.js";

const fixtures: string[] = [];

after(() => {
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "quota-status-test-"));
  fixtures.push(dir);
  return dir;
}

function writeQuotaState(path: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        provider: "codex",
        sampledAt: "2026-06-05T12:00:00.000Z",
        lastSuccess: "2026-06-05T12:00:00.000Z",
        lastSuccessTimestamp: 1780660800,
        planType: "Pro",
        activeLimit: "primary",
        windows: {
          "5h": {
            usedPercent: 12.5,
            remainingPercent: 87.5,
            resetAt: "2026-06-05T17:00:00.000Z",
            resetTimestamp: 1780678800,
          },
          week: {
            usedPercent: 88,
            remainingPercent: 12,
            resetAt: "2026-06-12T00:00:00.000Z",
            resetTimestamp: 1781222400,
          },
        },
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

describe("quota status reader", () => {
  it("reads fresh Codex quota data from the configured state file", () => {
    const dir = tempDir();
    const stateFile = join(dir, "quota.json");
    writeQuotaState(stateFile, {
      lastAttempt: "2026-06-05T12:01:00.000Z",
      lastAttemptTimestamp: 1780660860,
      probeSuccess: true,
    });

    const status = readQuotaStatus({
      stateFile,
      now: new Date("2026-06-05T12:02:00.000Z"),
    });

    assert.equal(status.state, "available");
    assert.equal(status.stateFile, stateFile);
    assert.equal(status.staleMs, DEFAULT_CODEX_QUOTA_STALE_MS);
    assert.equal(status.sampleAge, "2m ago");
    assert.equal(status.snapshot.provider, "codex");
    assert.equal(status.snapshot.windows["5h"].usedPercent, 12.5);
    assert.equal(status.snapshot.windows["5h"].remainingPercent, 87.5);
    assert.equal(status.snapshot.windows["5h"].resetTimestamp, 1780678800);
    assert.equal(status.snapshot.windows.week.usedPercent, 88);
    assert.equal(status.snapshot.lastAttemptTimestamp, 1780660860);
    assert.equal(status.snapshot.probeSuccess, true);
    assert.equal(status.snapshot.planType, "Pro");
  });

  it("marks quota data stale when the last successful sample is older than the threshold", () => {
    const dir = tempDir();
    const stateFile = join(dir, "quota.json");
    writeQuotaState(stateFile);

    const status = readQuotaStatus({
      stateFile,
      now: new Date("2026-06-05T12:31:00.000Z"),
      env: {
        CODEX_QUOTA_STALE_MS: "1800000",
      },
    });

    assert.equal(status.state, "stale");
    assert.equal(status.sampleAge, "31m ago");
    assert.equal(status.staleMs, 1_800_000);
  });

  it("returns unavailable when the state file is missing", () => {
    const dir = tempDir();
    const status = readQuotaStatus({
      stateFile: join(dir, "missing.json"),
      now: new Date("2026-06-05T12:00:00.000Z"),
    });

    assert.deepEqual(status, {
      state: "unavailable",
      stateFile: join(dir, "missing.json"),
      reason: "missing_file",
      staleMs: DEFAULT_CODEX_QUOTA_STALE_MS,
    });
  });

  it("returns unavailable with last attempt when no successful sample exists yet", () => {
    const dir = tempDir();
    const stateFile = join(dir, "quota.json");
    writeQuotaState(stateFile, {
      lastSuccess: undefined,
      lastSuccessTimestamp: undefined,
      sampledAt: undefined,
      lastAttempt: "2026-06-05T12:01:00.000Z",
      lastAttemptTimestamp: 1780660860,
      probeSuccess: false,
    });

    const status = readQuotaStatus({
      stateFile,
      now: new Date("2026-06-05T12:02:00.000Z"),
    });

    assert.equal(status.state, "unavailable");
    if (status.state !== "unavailable") {
      throw new Error("expected unavailable quota status");
    }
    assert.equal(status.reason, "no_success");
    assert.equal(status.snapshot?.lastAttemptTimestamp, 1780660860);
    assert.equal(status.snapshot?.probeSuccess, false);
  });

  it("returns read_error for malformed state files", () => {
    const dir = tempDir();
    const stateFile = join(dir, "quota.json");
    writeFileSync(stateFile, "{not json\n");

    const status = readQuotaStatus({
      stateFile,
      now: new Date("2026-06-05T12:00:00.000Z"),
    });

    assert.equal(status.state, "read_error");
    assert.equal(status.stateFile, stateFile);
    assert.match(status.error, /JSON|property name/i);
  });

  it("returns read_error for invalid stale threshold configuration", () => {
    const dir = tempDir();
    const stateFile = join(dir, "quota.json");
    writeQuotaState(stateFile);

    const status = readQuotaStatus({
      stateFile,
      env: { CODEX_QUOTA_STALE_MS: "not-a-number" },
      now: new Date("2026-06-05T12:00:00.000Z"),
    });

    assert.equal(status.state, "read_error");
    assert.match(status.error, /CODEX_QUOTA_STALE_MS must be a positive number/);
  });

  it("returns read_error for unsupported providers and invalid windows", () => {
    const dir = tempDir();
    const stateFile = join(dir, "quota.json");

    writeQuotaState(stateFile, { provider: "other" });
    let status = readQuotaStatus({ stateFile });
    assert.equal(status.state, "read_error");
    assert.match(status.error, /provider is unsupported/);

    writeQuotaState(stateFile, { windows: [] });
    status = readQuotaStatus({ stateFile });
    assert.equal(status.state, "read_error");
    assert.match(status.error, /windows must be an object/);
  });

  it("resolves the state file from CODEX_QUOTA_STATE_FILE or the default path", () => {
    const dir = tempDir();

    assert.equal(
      resolveQuotaStateFile({
        cwd: dir,
        env: { CODEX_QUOTA_STATE_FILE: "state/quota.json" },
      }),
      join(dir, "state", "quota.json"),
    );
    assert.equal(resolveQuotaStateFile({ cwd: dir, env: {} }), join(dir, ".tmp", "codex-quota-state.json"));
  });
});

describe("quota status duration formatting", () => {
  it("formats compact reset ETAs and sample ages", () => {
    const now = new Date("2026-06-05T12:00:00.000Z");

    assert.equal(formatResetEta("2026-06-05T16:52:00.000Z", now), "4h 52m");
    assert.equal(formatResetEta(1781262000, now), "6d 23h");
    assert.equal(formatResetEta("2026-06-05T11:59:00.000Z", now), "now");
    assert.equal(formatSampleAge("2026-06-05T11:58:00.000Z", now), "2m ago");
    assert.equal(formatCompactDuration(30_000), "0m");
  });
});
