import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const TEST_DIR = "/tmp/bot-inject/__hook_test__";
const HOOK_PATH = resolve(
  import.meta.dirname,
  "../../../.claude/hooks/inject-message.sh",
);

function runHook(): { exitCode: number; stdout: string } {
  try {
    const stdout = execSync(`bash "${HOOK_PATH}"`, {
      env: { ...process.env, BOT_INJECT_DIR: TEST_DIR },
      encoding: "utf-8",
      timeout: 5000,
    });
    return { exitCode: 0, stdout };
  } catch (err: unknown) {
    const e = err as { status: number; stdout: string };
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? "" };
  }
}

function parseHookOutput(stdout: string): {
  additionalContext: string;
} | null {
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout);
  return {
    additionalContext:
      parsed.hookSpecificOutput?.additionalContext ?? "",
  };
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("inject-message.sh hook", () => {
  it("exits cleanly when no files exist", () => {
    const { exitCode, stdout } = runHook();
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout.trim(), "");
  });

  it("exits cleanly when BOT_INJECT_DIR is empty", () => {
    try {
      const stdout = execSync(`bash "${HOOK_PATH}"`, {
        env: { ...process.env, BOT_INJECT_DIR: "" },
        encoding: "utf-8",
        timeout: 5000,
      });
      assert.strictEqual(stdout.trim(), "");
    } catch (err: unknown) {
      const e = err as { status: number };
      assert.strictEqual(e.status, 0);
    }
  });

  it("handles pending file with LIVE MESSAGE framing", () => {
    writeFileSync(join(TEST_DIR, "pending"), "1\nHello from user", "utf-8");

    const { exitCode, stdout } = runHook();
    assert.strictEqual(exitCode, 0);

    const result = parseHookOutput(stdout);
    assert.ok(result);
    assert.ok(result.additionalContext.includes("LIVE MESSAGE"));
    assert.ok(result.additionalContext.includes("Hello from user"));
    assert.ok(!result.additionalContext.includes("CONTEXT UPDATE"));

    // pending file should be consumed
    assert.ok(!existsSync(join(TEST_DIR, "pending")));
    assert.ok(!existsSync(join(TEST_DIR, "pending.claimed")));
  });

  it("handles pending-echo file with CONTEXT UPDATE framing", () => {
    writeFileSync(
      join(TEST_DIR, "pending-echo"),
      "1\n[Bot echo — context only, no reply needed]\n\nTest echo message",
      "utf-8",
    );

    const { exitCode, stdout } = runHook();
    assert.strictEqual(exitCode, 0);

    const result = parseHookOutput(stdout);
    assert.ok(result);
    assert.ok(result.additionalContext.includes("CONTEXT UPDATE"));
    assert.ok(result.additionalContext.includes("Test echo message"));
    assert.ok(!result.additionalContext.includes("LIVE MESSAGE"));

    // pending-echo file should be consumed
    assert.ok(!existsSync(join(TEST_DIR, "pending-echo")));
    assert.ok(!existsSync(join(TEST_DIR, "pending-echo.claimed")));
  });

  it("handles both pending and pending-echo files together", () => {
    writeFileSync(join(TEST_DIR, "pending"), "1\nUser says hi", "utf-8");
    writeFileSync(
      join(TEST_DIR, "pending-echo"),
      "1\n[Bot echo — context only, no reply needed]\n\nCron sent a report",
      "utf-8",
    );

    const { exitCode, stdout } = runHook();
    assert.strictEqual(exitCode, 0);

    const result = parseHookOutput(stdout);
    assert.ok(result);
    // Both framings should be present
    assert.ok(result.additionalContext.includes("LIVE MESSAGE"));
    assert.ok(result.additionalContext.includes("User says hi"));
    assert.ok(result.additionalContext.includes("CONTEXT UPDATE"));
    assert.ok(result.additionalContext.includes("Cron sent a report"));

    // LIVE MESSAGE should come before CONTEXT UPDATE
    const liveIdx = result.additionalContext.indexOf("LIVE MESSAGE");
    const contextIdx = result.additionalContext.indexOf("CONTEXT UPDATE");
    assert.ok(liveIdx < contextIdx, "LIVE MESSAGE should precede CONTEXT UPDATE");

    // Both files should be consumed
    assert.ok(!existsSync(join(TEST_DIR, "pending")));
    assert.ok(!existsSync(join(TEST_DIR, "pending-echo")));
  });

  it("updates ack counter for pending but not for pending-echo", () => {
    // First: process a pending file
    writeFileSync(join(TEST_DIR, "pending"), "2\nmsg1\n\n---\n\nmsg2", "utf-8");
    runHook();

    // Ack file should exist with count 2
    const ack1 = readFileSync(join(TEST_DIR, "ack"), "utf-8").trim();
    assert.strictEqual(ack1, "2");

    // Now process an echo file
    writeFileSync(
      join(TEST_DIR, "pending-echo"),
      "1\n[Bot echo — context only, no reply needed]\n\nEcho msg",
      "utf-8",
    );
    runHook();

    // Ack should still be 2 (echo messages don't update ack)
    const ack2 = readFileSync(join(TEST_DIR, "ack"), "utf-8").trim();
    assert.strictEqual(ack2, "2");

    // Process another pending file
    writeFileSync(join(TEST_DIR, "pending"), "1\nmsg3", "utf-8");
    runHook();

    // Ack should now be 3
    const ack3 = readFileSync(join(TEST_DIR, "ack"), "utf-8").trim();
    assert.strictEqual(ack3, "3");
  });

  it("handles pending file with invalid count", () => {
    writeFileSync(join(TEST_DIR, "pending"), "invalid\nsome content", "utf-8");

    const { exitCode, stdout } = runHook();
    assert.strictEqual(exitCode, 0);
    // Should exit cleanly with no output (invalid count = no content)
    assert.strictEqual(stdout.trim(), "");
  });

  it("handles pending-echo file with invalid count", () => {
    writeFileSync(join(TEST_DIR, "pending-echo"), "bad\necho content", "utf-8");

    const { exitCode, stdout } = runHook();
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout.trim(), "");
  });

  it("handles multiple echo messages separated by ---", () => {
    writeFileSync(
      join(TEST_DIR, "pending-echo"),
      "2\n[Bot echo — context only, no reply needed]\n\nFirst chunk\n\n---\n\n[Bot echo — context only, no reply needed]\n\nSecond chunk",
      "utf-8",
    );

    const { exitCode, stdout } = runHook();
    assert.strictEqual(exitCode, 0);

    const result = parseHookOutput(stdout);
    assert.ok(result);
    assert.ok(result.additionalContext.includes("First chunk"));
    assert.ok(result.additionalContext.includes("Second chunk"));
  });
});
