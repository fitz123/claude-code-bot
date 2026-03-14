import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import { is409ConflictError, startBotWithRetry } from "../bot-startup.js";

describe("is409ConflictError", () => {
  it("returns true for GrammyError with error_code 409", () => {
    const err = new GrammyError(
      "Conflict: terminated by other getUpdates request",
      { ok: false, error_code: 409, description: "Conflict" } as any,
      "getUpdates",
      {},
    );
    assert.strictEqual(is409ConflictError(err), true);
  });

  it("returns true for BotError wrapping a 409 GrammyError", () => {
    const inner = new GrammyError(
      "Conflict",
      { ok: false, error_code: 409, description: "Conflict" } as any,
      "getUpdates",
      {},
    );
    const err = { error: inner };
    assert.strictEqual(is409ConflictError(err), true);
  });

  it("returns false for GrammyError with non-409 code", () => {
    const err = new GrammyError(
      "Too Many Requests",
      { ok: false, error_code: 429, description: "Too Many Requests" } as any,
      "sendMessage",
      {},
    );
    assert.strictEqual(is409ConflictError(err), false);
  });

  it("returns false for a generic Error", () => {
    assert.strictEqual(is409ConflictError(new Error("network error")), false);
  });

  it("returns false for null/undefined", () => {
    assert.strictEqual(is409ConflictError(null), false);
    assert.strictEqual(is409ConflictError(undefined), false);
  });
});

describe("startBotWithRetry", () => {
  const fakeSleep = async (_ms: number) => {};

  it("succeeds on first attempt without retry", async () => {
    let callCount = 0;
    await startBotWithRetry(
      async () => { callCount++; },
      { maxRetries: 3, sleep: fakeSleep },
    );
    assert.strictEqual(callCount, 1);
  });

  it("retries on 409 and succeeds on subsequent attempt", async () => {
    let callCount = 0;
    await startBotWithRetry(
      async () => {
        callCount++;
        if (callCount < 3) {
          throw new GrammyError(
            "Conflict",
            { ok: false, error_code: 409, description: "Conflict" } as any,
            "getUpdates",
            {},
          );
        }
      },
      { maxRetries: 5, baseDelayMs: 10, sleep: fakeSleep },
    );
    assert.strictEqual(callCount, 3);
  });

  it("throws after exhausting retries on persistent 409", async () => {
    let callCount = 0;
    await assert.rejects(
      () =>
        startBotWithRetry(
          async () => {
            callCount++;
            throw new GrammyError(
              "Conflict",
              { ok: false, error_code: 409, description: "Conflict" } as any,
              "getUpdates",
              {},
            );
          },
          { maxRetries: 3, baseDelayMs: 10, sleep: fakeSleep },
        ),
      (err: unknown) => {
        assert.ok(err instanceof GrammyError);
        assert.strictEqual(err.error_code, 409);
        return true;
      },
    );
    // Should have tried 3 times: attempts 1 and 2 retry, attempt 3 is last so it throws
    assert.strictEqual(callCount, 3);
  });

  it("does not retry non-409 errors", async () => {
    let callCount = 0;
    await assert.rejects(
      () =>
        startBotWithRetry(
          async () => {
            callCount++;
            throw new GrammyError(
              "Bad Request",
              { ok: false, error_code: 400, description: "Bad Request" } as any,
              "getUpdates",
              {},
            );
          },
          { maxRetries: 5, baseDelayMs: 10, sleep: fakeSleep },
        ),
      (err: unknown) => {
        assert.ok(err instanceof GrammyError);
        assert.strictEqual(err.error_code, 400);
        return true;
      },
    );
    assert.strictEqual(callCount, 1);
  });

  it("uses exponential backoff delays", async () => {
    const delays: number[] = [];
    let callCount = 0;
    const trackingSleep = async (ms: number) => { delays.push(ms); };

    await assert.rejects(
      () =>
        startBotWithRetry(
          async () => {
            callCount++;
            throw new GrammyError(
              "Conflict",
              { ok: false, error_code: 409, description: "Conflict" } as any,
              "getUpdates",
              {},
            );
          },
          { maxRetries: 4, baseDelayMs: 1000, sleep: trackingSleep },
        ),
    );
    // 3 retries before final throw: delays for attempts 1, 2, 3
    assert.deepStrictEqual(delays, [1000, 2000, 4000]);
  });

  it("caps backoff delay at 60 seconds", async () => {
    const delays: number[] = [];
    const trackingSleep = async (ms: number) => { delays.push(ms); };

    await assert.rejects(
      () =>
        startBotWithRetry(
          async () => {
            throw new GrammyError(
              "Conflict",
              { ok: false, error_code: 409, description: "Conflict" } as any,
              "getUpdates",
              {},
            );
          },
          { maxRetries: 4, baseDelayMs: 30000, sleep: trackingSleep },
        ),
    );
    // 30000, 60000 (capped from 60000), 60000 (capped from 120000)
    assert.deepStrictEqual(delays, [30000, 60000, 60000]);
  });
});
