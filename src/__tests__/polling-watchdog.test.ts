import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWatchdog } from "../polling-watchdog.js";

describe("polling-watchdog", () => {
  it("does not exit when updates arrive within threshold", async () => {
    let exited = false;
    const wd = createWatchdog({
      heartbeat: async () => true,
      exit: () => { exited = true; },
      now: () => 1000,
      thresholdMs: 5000,
    });

    wd.touch(); // recent update
    await wd.check();
    assert.strictEqual(exited, false);
  });

  it("resets on successful heartbeat when threshold exceeded (quiet period)", async () => {
    let clock = 0;
    let heartbeatCalled = false;
    let exited = false;

    const wd = createWatchdog({
      heartbeat: async () => { heartbeatCalled = true; return true; },
      exit: () => { exited = true; },
      now: () => clock,
      thresholdMs: 5000,
      maxQuietHeartbeats: 3,
    });

    // Touch at time 0
    wd.touch();
    // Advance past threshold
    clock = 6000;
    await wd.check();

    assert.strictEqual(heartbeatCalled, true);
    assert.strictEqual(exited, false);

    // After reset, another check should NOT trigger heartbeat again
    heartbeatCalled = false;
    clock = 7000; // only 1s since reset
    await wd.check();
    assert.strictEqual(heartbeatCalled, false);
  });

  it("exits after maxQuietHeartbeats consecutive quiet resets", async () => {
    let clock = 0;
    let exited = false;

    const wd = createWatchdog({
      heartbeat: async () => true,
      exit: () => { exited = true; },
      now: () => clock,
      thresholdMs: 5000,
      maxQuietHeartbeats: 3,
    });

    wd.touch();

    // First quiet heartbeat — no exit
    clock = 6000;
    await wd.check();
    assert.strictEqual(exited, false);

    // Second quiet heartbeat — no exit
    clock = 12000;
    await wd.check();
    assert.strictEqual(exited, false);

    // Third quiet heartbeat — exits (3 consecutive with no real updates)
    clock = 18000;
    await wd.check();
    assert.strictEqual(exited, true);
  });

  it("touch resets the quiet heartbeat counter", async () => {
    let clock = 0;
    let exited = false;

    const wd = createWatchdog({
      heartbeat: async () => true,
      exit: () => { exited = true; },
      now: () => clock,
      thresholdMs: 5000,
      maxQuietHeartbeats: 2,
    });

    wd.touch();

    // First quiet heartbeat
    clock = 6000;
    await wd.check();
    assert.strictEqual(exited, false);

    // A real update arrives — resets the counter
    wd.touch();

    // First quiet heartbeat after touch — counter back to 1
    clock = 12000;
    await wd.check();
    assert.strictEqual(exited, false);

    // Second quiet heartbeat — now exits (2 consecutive)
    clock = 18000;
    await wd.check();
    assert.strictEqual(exited, true);
  });

  it("exits when heartbeat returns false after threshold exceeded", async () => {
    let clock = 0;
    let exitCode: number | null = null;

    const wd = createWatchdog({
      heartbeat: async () => false,
      exit: (code) => { exitCode = code; },
      now: () => clock,
      thresholdMs: 5000,
    });

    wd.touch();
    clock = 6000;
    await wd.check();

    assert.strictEqual(exitCode, 1);
  });

  it("exits when heartbeat throws after threshold exceeded", async () => {
    let clock = 0;
    let exitCode: number | null = null;

    const wd = createWatchdog({
      heartbeat: async () => { throw new Error("network error"); },
      exit: (code) => { exitCode = code; },
      now: () => clock,
      thresholdMs: 5000,
    });

    wd.touch();
    clock = 6000;
    await wd.check();

    assert.strictEqual(exitCode, 1);
  });

  it("touch resets the timer so check passes", async () => {
    let clock = 0;
    let exited = false;

    const wd = createWatchdog({
      heartbeat: async () => false,
      exit: () => { exited = true; },
      now: () => clock,
      thresholdMs: 5000,
    });

    // Touch at 0, advance to 4999 — just under threshold
    wd.touch();
    clock = 4999;
    await wd.check();
    assert.strictEqual(exited, false);

    // Touch again at 4999, advance to 9998 — under threshold from last touch
    wd.touch();
    clock = 9998;
    await wd.check();
    assert.strictEqual(exited, false);

    // Now go over threshold from last touch
    clock = 10000;
    await wd.check();
    assert.strictEqual(exited, true);
  });

  it("start initializes the timestamp and stop clears the interval", () => {
    const wd = createWatchdog({
      heartbeat: async () => true,
      exit: () => {},
      thresholdMs: 5000,
      intervalMs: 100_000, // long interval to avoid actual fires
    });

    // start and stop should not throw
    wd.start();
    wd.stop();
  });

  it("start is idempotent — calling twice does not create duplicate timers", () => {
    const wd = createWatchdog({
      heartbeat: async () => true,
      exit: () => {},
      thresholdMs: 5000,
      intervalMs: 100_000,
    });

    wd.start();
    wd.start(); // should be a no-op
    wd.stop();
  });

  it("uses default threshold of 10 minutes", async () => {
    let clock = 0;
    let heartbeatCalled = false;

    const wd = createWatchdog({
      heartbeat: async () => { heartbeatCalled = true; return true; },
      exit: () => {},
      now: () => clock,
      // no thresholdMs — should default to 600_000
    });

    wd.touch();
    // 9 minutes — should not trigger
    clock = 9 * 60 * 1000;
    await wd.check();
    assert.strictEqual(heartbeatCalled, false);

    // 11 minutes — should trigger
    clock = 11 * 60 * 1000;
    await wd.check();
    assert.strictEqual(heartbeatCalled, true);
  });
});
