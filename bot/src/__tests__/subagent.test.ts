import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateAssistantUsage,
  buildSubagentSpawnArgs,
  DEFAULT_SUBAGENT_MODEL,
  emptyUsageStats,
  formatSubagentChildErrorWarn,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  normalizeSubagentModel,
  parseSubagentEventLine,
  runSubagentChild,
  SUBAGENT_PROVIDER,
  type SubagentChildErrorWarn,
  type SubagentChildLike,
  type SubagentMessage,
  type SubagentReadableLike,
  type SubagentSpawn,
} from "../pi-extensions/subagent-args.js";

/** Build a JSONL `message_end` line for an assistant message. */
function assistantLine(message: Partial<SubagentMessage>): string {
  return `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], ...message } })}\n`;
}

describe("subagent: normalizeSubagentModel", () => {
  it("defaults to the codex model when empty/absent", () => {
    assert.equal(normalizeSubagentModel(undefined), DEFAULT_SUBAGENT_MODEL);
    assert.equal(normalizeSubagentModel("   "), DEFAULT_SUBAGENT_MODEL);
  });

  it("prefixes a bare model name with the codex provider", () => {
    assert.equal(normalizeSubagentModel("gpt-5.5"), `${SUBAGENT_PROVIDER}/gpt-5.5`);
  });

  it("passes an already-qualified provider/model through untouched", () => {
    assert.equal(normalizeSubagentModel("anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
    assert.equal(normalizeSubagentModel("openai-codex/gpt-5.5"), "openai-codex/gpt-5.5");
  });
});

describe("subagent: buildSubagentSpawnArgs", () => {
  it("wires the openai-codex provider + default model, json mode, and the task", () => {
    const args = buildSubagentSpawnArgs({}, "find auth code");
    assert.deepEqual(args, [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--provider",
      SUBAGENT_PROVIDER,
      "--model",
      DEFAULT_SUBAGENT_MODEL,
      "Task: find auth code",
    ]);
  });

  it("normalizes an agent-pinned model and appends a tools allow-list", () => {
    const args = buildSubagentSpawnArgs({ model: "gpt-5.5-mini", tools: ["read", "grep", "ls"] }, "scout");
    assert.equal(args[args.indexOf("--model") + 1], `${SUBAGENT_PROVIDER}/gpt-5.5-mini`);
    assert.equal(args[args.indexOf("--tools") + 1], "read,grep,ls");
    assert.equal(args[args.length - 1], "Task: scout");
  });

  it("omits --tools when the agent pins none, and the task is always last", () => {
    const args = buildSubagentSpawnArgs({ tools: [] }, "do it");
    assert.equal(args.includes("--tools"), false);
    assert.equal(args[args.length - 1], "Task: do it");
  });

  it("appends --append-system-prompt when a prompt path is given (before the task)", () => {
    const args = buildSubagentSpawnArgs({}, "t", { systemPromptPath: "/tmp/p/prompt.md" });
    const idx = args.indexOf("--append-system-prompt");
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], "/tmp/p/prompt.md");
    assert.ok(idx < args.length - 1);
    assert.equal(args[args.length - 1], "Task: t");
  });
});

describe("subagent: parseSubagentEventLine", () => {
  it("surfaces a message_end as a message event", () => {
    const ev = parseSubagentEventLine(assistantLine({ content: [{ type: "text", text: "hi" }] }).trim());
    assert.ok(ev);
    assert.equal(ev.kind, "message");
    assert.equal(ev.message.role, "assistant");
  });

  it("surfaces a tool_result_end as a toolResult event", () => {
    const ev = parseSubagentEventLine(JSON.stringify({ type: "tool_result_end", message: { role: "tool", content: [] } }));
    assert.ok(ev);
    assert.equal(ev.kind, "toolResult");
  });

  it("returns null for blank, non-JSON, non-object, and unrelated events", () => {
    assert.equal(parseSubagentEventLine(""), null);
    assert.equal(parseSubagentEventLine("   "), null);
    assert.equal(parseSubagentEventLine("not json"), null);
    assert.equal(parseSubagentEventLine("123"), null);
    assert.equal(parseSubagentEventLine(JSON.stringify({ type: "turn_end" })), null);
    assert.equal(parseSubagentEventLine(JSON.stringify({ type: "message_end" })), null); // no message
  });
});

describe("subagent: result parsing helpers", () => {
  it("getFinalOutput returns the last assistant text block", () => {
    const messages: SubagentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "tool", content: [{ type: "text", text: "tool noise" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }, { type: "text", text: "final answer" }] },
    ];
    assert.equal(getFinalOutput(messages), "final answer");
  });

  it("getFinalOutput returns '' when no assistant text exists", () => {
    assert.equal(getFinalOutput([]), "");
    assert.equal(getFinalOutput([{ role: "assistant", content: [{ type: "toolCall", name: "x", arguments: {} }] }]), "");
  });

  it("isFailedResult flags non-zero exit and error/aborted stop reasons", () => {
    assert.equal(isFailedResult({ exitCode: 0, messages: [], stderr: "" }), false);
    assert.equal(isFailedResult({ exitCode: 1, messages: [], stderr: "" }), true);
    assert.equal(isFailedResult({ exitCode: 0, messages: [], stderr: "", stopReason: "error" }), true);
    assert.equal(isFailedResult({ exitCode: 0, messages: [], stderr: "", stopReason: "aborted" }), true);
  });

  it("getResultOutput prefers diagnostics for failures and final text for success", () => {
    assert.equal(getResultOutput({ exitCode: 1, messages: [], stderr: "boom", errorMessage: "" }), "boom");
    assert.equal(getResultOutput({ exitCode: 1, messages: [], stderr: "", errorMessage: "model err" }), "model err");
    assert.equal(
      getResultOutput({ exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], stderr: "" }),
      "ok",
    );
    assert.equal(getResultOutput({ exitCode: 0, messages: [], stderr: "" }), "(no output)");
  });

  it("accumulateAssistantUsage sums assistant usage and ignores non-assistant", () => {
    const usage = emptyUsageStats();
    accumulateAssistantUsage(usage, {
      role: "assistant",
      content: [],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { total: 0.01 } },
    });
    accumulateAssistantUsage(usage, { role: "tool", content: [], usage: { input: 999 } });
    assert.deepEqual(usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01, contextTokens: 17, turns: 1 });
  });
});

describe("subagent: formatSubagentChildErrorWarn", () => {
  it("formats a structured warn line with optional fields", () => {
    assert.equal(
      formatSubagentChildErrorWarn({ agent: "worker", exitCode: 2, stopReason: "error", detail: "blew up" }),
      "[subagent] agent=worker exit=2 stopReason=error detail=blew up",
    );
    assert.equal(formatSubagentChildErrorWarn({ agent: "scout", exitCode: 1 }), "[subagent] agent=scout exit=1");
  });
});

// ---- mock-spawn driven runner tests -----------------------------------------

/** Minimal data-stream stub backing the fake child. */
class FakeStream implements SubagentReadableLike {
  private cbs: Array<(chunk: Buffer | string) => void> = [];
  on(event: "data", listener: (chunk: Buffer | string) => void): this {
    if (event === "data") this.cbs.push(listener);
    return this;
  }
  emit(chunk: string): void {
    for (const cb of this.cbs) cb(Buffer.from(chunk));
  }
}

/** A controllable fake child process — the test drives stdout/stderr/close. */
class FakeChild implements SubagentChildLike {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  private closeCbs: Array<(code: number | null) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];
  on(event: "close", listener: (code: number | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close" | "error", listener: ((code: number | null) => void) | ((err: Error) => void)): this {
    if (event === "close") this.closeCbs.push(listener as (code: number | null) => void);
    else this.errorCbs.push(listener as (err: Error) => void);
    return this;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  emitClose(code: number | null): void {
    for (const cb of this.closeCbs) cb(code);
  }
  emitError(err: Error): void {
    for (const cb of this.errorCbs) cb(err);
  }
}

interface SpawnRecord {
  command: string;
  args: string[];
  cwd?: string;
}

function setupRunner() {
  const child = new FakeChild();
  const calls: SpawnRecord[] = [];
  const warns: SubagentChildErrorWarn[] = [];
  const spawn: SubagentSpawn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return child;
  };
  return { child, calls, warns, spawn };
}

describe("subagent: runSubagentChild (mock spawn)", () => {
  it("spawns with the given command/args/cwd and collects a clean result (no warn)", async () => {
    const { child, calls, warns, spawn } = setupRunner();
    const promise = runSubagentChild({
      spawn,
      command: "pi",
      args: ["--mode", "json", "-p"],
      cwd: "/work",
      agentName: "scout",
      warn: (e) => warns.push(e),
    });
    child.stdout.emit(
      assistantLine({
        content: [{ type: "text", text: "done" }],
        usage: { input: 8, output: 3, totalTokens: 11 },
        model: "openai-codex/gpt-5.5",
        stopReason: "end",
      }),
    );
    child.emitClose(0);
    const result = await promise;

    assert.deepEqual(calls, [{ command: "pi", args: ["--mode", "json", "-p"], cwd: "/work" }]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.aborted, false);
    assert.equal(getFinalOutput(result.messages), "done");
    assert.equal(result.usage.turns, 1);
    assert.equal(result.usage.input, 8);
    assert.equal(result.model, "openai-codex/gpt-5.5");
    assert.equal(warns.length, 0);
  });

  it("reassembles a JSONL line split across stdout chunks (and trailing buffer at close)", async () => {
    const { child, spawn } = setupRunner();
    const line = assistantLine({ content: [{ type: "text", text: "split-output" }] }).trimEnd();
    const promise = runSubagentChild({ spawn, command: "pi", args: [], agentName: "worker" });
    child.stdout.emit(line.slice(0, 20));
    child.stdout.emit(line.slice(20)); // no trailing newline — processed from the buffer at close
    child.emitClose(0);
    const result = await promise;
    assert.equal(getFinalOutput(result.messages), "split-output");
  });

  it("warns on a non-zero exit, carrying stderr as the detail (child error)", async () => {
    const { child, warns, spawn } = setupRunner();
    const promise = runSubagentChild({ spawn, command: "pi", args: [], agentName: "worker", warn: (e) => warns.push(e) });
    child.stderr.emit("fatal: boom\n");
    child.emitClose(2);
    const result = await promise;
    assert.equal(result.exitCode, 2);
    assert.equal(isFailedResult(result), true);
    assert.equal(warns.length, 1);
    assert.equal(warns[0].agent, "worker");
    assert.equal(warns[0].exitCode, 2);
    assert.match(warns[0].detail ?? "", /boom/);
  });

  it("warns on a model error stopReason even when the exit code is 0", async () => {
    const { child, warns, spawn } = setupRunner();
    const promise = runSubagentChild({ spawn, command: "pi", args: [], agentName: "reviewer", warn: (e) => warns.push(e) });
    child.stdout.emit(assistantLine({ stopReason: "error", errorMessage: "model exploded" }));
    child.emitClose(0);
    const result = await promise;
    assert.equal(result.stopReason, "error");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].detail, "model exploded");
  });

  it("resolves exitCode 1 and warns on a spawn 'error' event", async () => {
    const { child, warns, spawn } = setupRunner();
    const promise = runSubagentChild({ spawn, command: "pi", args: [], agentName: "scout", warn: (e) => warns.push(e) });
    child.emitError(new Error("ENOENT: pi not found"));
    const result = await promise;
    assert.equal(result.exitCode, 1);
    assert.equal(warns.length, 1);
    assert.equal(warns[0].exitCode, 1);
  });

  it("kills the child on abort, flags aborted, and does NOT warn (user-initiated)", async () => {
    const { child, warns, spawn } = setupRunner();
    const ac = new AbortController();
    const promise = runSubagentChild({
      spawn,
      command: "pi",
      args: [],
      agentName: "scout",
      signal: ac.signal,
      warn: (e) => warns.push(e),
    });
    ac.abort();
    assert.equal(child.killed, true);
    child.emitClose(143); // SIGTERM exit
    const result = await promise;
    assert.equal(result.aborted, true);
    assert.equal(warns.length, 0);
  });

  it("kills immediately when the signal is already aborted before spawn", async () => {
    const { child, spawn } = setupRunner();
    const ac = new AbortController();
    ac.abort();
    const promise = runSubagentChild({ spawn, command: "pi", args: [], agentName: "scout", signal: ac.signal });
    assert.equal(child.killed, true);
    child.emitClose(143);
    const result = await promise;
    assert.equal(result.aborted, true);
  });

  it("streams onMessage updates as messages arrive", async () => {
    const { child, spawn } = setupRunner();
    const snapshots: string[] = [];
    const promise = runSubagentChild({
      spawn,
      command: "pi",
      args: [],
      agentName: "worker",
      onMessage: (r) => snapshots.push(getFinalOutput(r.messages)),
    });
    child.stdout.emit(assistantLine({ content: [{ type: "text", text: "step 1" }] }));
    child.stdout.emit(assistantLine({ content: [{ type: "text", text: "step 2" }] }));
    child.emitClose(0);
    await promise;
    assert.deepEqual(snapshots, ["step 1", "step 2"]);
  });
});
