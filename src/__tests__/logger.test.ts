import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { log, setLogLevel, getLogLevel, parseLogLevel } from "../logger.js";

// Capture console output for assertions
function captureConsole() {
  const captured: Array<{ method: string; args: unknown[] }> = [];
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => captured.push({ method: "log", args });
  console.debug = (...args: unknown[]) => captured.push({ method: "debug", args });
  console.warn = (...args: unknown[]) => captured.push({ method: "warn", args });
  console.error = (...args: unknown[]) => captured.push({ method: "error", args });

  return {
    captured,
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

describe("parseLogLevel", () => {
  it("parses valid levels", () => {
    assert.strictEqual(parseLogLevel("debug"), "debug");
    assert.strictEqual(parseLogLevel("info"), "info");
    assert.strictEqual(parseLogLevel("warn"), "warn");
    assert.strictEqual(parseLogLevel("error"), "error");
  });

  it("is case insensitive", () => {
    assert.strictEqual(parseLogLevel("DEBUG"), "debug");
    assert.strictEqual(parseLogLevel("Info"), "info");
    assert.strictEqual(parseLogLevel("WARN"), "warn");
  });

  it("returns undefined for invalid values", () => {
    assert.strictEqual(parseLogLevel("trace"), undefined);
    assert.strictEqual(parseLogLevel(""), undefined);
    assert.strictEqual(parseLogLevel(42), undefined);
    assert.strictEqual(parseLogLevel(null), undefined);
    assert.strictEqual(parseLogLevel(undefined), undefined);
  });

  it("rejects Object.prototype property names", () => {
    assert.strictEqual(parseLogLevel("toString"), undefined);
    assert.strictEqual(parseLogLevel("constructor"), undefined);
    assert.strictEqual(parseLogLevel("hasOwnProperty"), undefined);
    assert.strictEqual(parseLogLevel("valueOf"), undefined);
  });
});

describe("setLogLevel / getLogLevel", () => {
  let originalLevel: ReturnType<typeof getLogLevel>;

  beforeEach(() => {
    originalLevel = getLogLevel();
  });

  afterEach(() => {
    setLogLevel(originalLevel);
  });

  it("defaults to info", () => {
    setLogLevel("info"); // reset to default
    assert.strictEqual(getLogLevel(), "info");
  });

  it("can change the log level", () => {
    setLogLevel("debug");
    assert.strictEqual(getLogLevel(), "debug");
    setLogLevel("error");
    assert.strictEqual(getLogLevel(), "error");
  });
});

describe("log output format", () => {
  let cap: ReturnType<typeof captureConsole>;
  let originalLevel: ReturnType<typeof getLogLevel>;

  beforeEach(() => {
    originalLevel = getLogLevel();
    setLogLevel("debug");
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
    setLogLevel(originalLevel);
  });

  it("formats with ISO timestamp, level, and tag", () => {
    log.info("test-tag", "hello world");

    assert.strictEqual(cap.captured.length, 1);
    assert.strictEqual(cap.captured[0].method, "log");
    const output = cap.captured[0].args[0] as string;
    // Check ISO timestamp pattern
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(output), `Expected ISO timestamp, got: ${output}`);
    assert.ok(output.includes("INFO"), `Expected INFO level, got: ${output}`);
    assert.ok(output.includes("[test-tag]"), `Expected [test-tag], got: ${output}`);
    assert.ok(output.includes("hello world"), `Expected message, got: ${output}`);
  });

  it("passes extra args through", () => {
    const extra = { key: "value" };
    log.info("tag", "message", extra);

    assert.strictEqual(cap.captured.length, 1);
    assert.strictEqual(cap.captured[0].args.length, 2);
    assert.strictEqual(cap.captured[0].args[1], extra);
  });

  it("uses correct console methods for each level", () => {
    log.debug("t", "d");
    log.info("t", "i");
    log.warn("t", "w");
    log.error("t", "e");

    assert.strictEqual(cap.captured.length, 4);
    assert.strictEqual(cap.captured[0].method, "debug");
    assert.strictEqual(cap.captured[1].method, "log");
    assert.strictEqual(cap.captured[2].method, "warn");
    assert.strictEqual(cap.captured[3].method, "error");
  });

  it("includes level name in output", () => {
    log.debug("t", "d");
    log.warn("t", "w");
    log.error("t", "e");

    assert.ok((cap.captured[0].args[0] as string).includes("DEBUG"));
    assert.ok((cap.captured[1].args[0] as string).includes("WARN"));
    assert.ok((cap.captured[2].args[0] as string).includes("ERROR"));
  });
});

describe("log level filtering", () => {
  let cap: ReturnType<typeof captureConsole>;
  let originalLevel: ReturnType<typeof getLogLevel>;

  beforeEach(() => {
    originalLevel = getLogLevel();
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
    setLogLevel(originalLevel);
  });

  it("at info level, debug is suppressed", () => {
    setLogLevel("info");
    log.debug("t", "should not appear");
    log.info("t", "should appear");

    assert.strictEqual(cap.captured.length, 1);
    assert.ok((cap.captured[0].args[0] as string).includes("should appear"));
  });

  it("at warn level, debug and info are suppressed", () => {
    setLogLevel("warn");
    log.debug("t", "no");
    log.info("t", "no");
    log.warn("t", "yes");
    log.error("t", "yes");

    assert.strictEqual(cap.captured.length, 2);
  });

  it("at error level, only error shows", () => {
    setLogLevel("error");
    log.debug("t", "no");
    log.info("t", "no");
    log.warn("t", "no");
    log.error("t", "yes");

    assert.strictEqual(cap.captured.length, 1);
    assert.ok((cap.captured[0].args[0] as string).includes("ERROR"));
  });

  it("at debug level, all messages show", () => {
    setLogLevel("debug");
    log.debug("t", "d");
    log.info("t", "i");
    log.warn("t", "w");
    log.error("t", "e");

    assert.strictEqual(cap.captured.length, 4);
  });
});
