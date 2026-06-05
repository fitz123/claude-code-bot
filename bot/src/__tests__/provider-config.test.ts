import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAgent } from "../config.js";

describe("validateAgent provider field", () => {
  it("treats absent provider as Pi", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "gpt-5.5" },
      "main",
    );
    assert.strictEqual(agent.provider, "pi");
  });

  it("rejects provider \"claude\" with a migration error", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", provider: "claude" },
        "main",
      ),
      /Agent "main" uses provider "claude", but the Claude runtime has been removed; remove provider or set provider: "pi"/,
    );
  });

  it("accepts provider \"pi\"", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "gpt-5.5", provider: "pi" },
      "main",
    );
    assert.strictEqual(agent.provider, "pi");
  });

  it("rejects an invalid provider value", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", provider: "openai" },
        "main",
      ),
      /Agent "main" has invalid provider "openai" \(must be "pi"; Claude runtime was removed\)/,
    );
  });

  it("rejects a non-string provider value", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", provider: 42 },
        "main",
      ),
      /Agent "main" has invalid provider/,
    );
  });

  it("rejects an absent-provider Pi agent with no explicit model", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x" },
        "coder",
        "gpt-5.5",
      ),
      /Agent "coder" missing model \(Pi agents must set an explicit model; top-level defaultModel is no longer inherited by Pi agents\)/,
    );
  });

  it("accepts a Pi agent with an explicit model and does not apply defaultModel", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "gpt-5.5" },
      "coder",
      "gpt-4.2",
    );
    assert.strictEqual(agent.model, "gpt-5.5");
    assert.strictEqual(agent.provider, "pi");
  });

  it("accepts Pi thinking levels", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "gpt-5.5", provider: "pi", thinking: "xhigh" },
      "coder",
    );
    assert.strictEqual(agent.thinking, "xhigh");
  });

  it("rejects invalid thinking values", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", provider: "pi", thinking: "ultra" },
        "coder",
      ),
      /Agent "coder" has invalid thinking "ultra" \(must be one of: off, minimal, low, medium, high, xhigh\)/,
    );
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", provider: "pi", thinking: 42 },
        "coder",
      ),
      /Agent "coder" has invalid thinking "42"/,
    );
  });

  it("rejects fallbackModel with a migration error", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", fallbackModel: "gpt-5-mini" },
        "main",
      ),
      /Agent "main" uses fallbackModel, but fallback models were removed with the Claude runtime; remove fallbackModel/,
    );
  });

  it("rejects effort with a migration error", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", effort: "high" },
        "main",
      ),
      /Agent "main" uses effort, but effort was replaced by Pi thinking; use thinking: off\|minimal\|low\|medium\|high\|xhigh/,
    );
  });

  it("rejects maxTurns because Pi sessions do not enforce it", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", maxTurns: 5 },
        "main",
      ),
      /Agent "main" uses maxTurns, but Pi sessions do not support this setting; remove maxTurns/,
    );
  });

  it("rejects allowedTools because Pi sessions do not enforce it", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "gpt-5.5", allowedTools: ["Read"] },
        "main",
      ),
      /Agent "main" uses allowedTools, but Pi sessions do not support this setting; remove allowedTools/,
    );
  });

  it("preserves other supported fields when provider is set", () => {
    const agent = validateAgent(
      {
        workspaceCwd: "/tmp/x",
        model: "gpt-5.5",
        systemPrompt: "be helpful",
        thinking: "medium",
        provider: "pi",
      },
      "main",
    );
    assert.strictEqual(agent.model, "gpt-5.5");
    assert.strictEqual(agent.systemPrompt, "be helpful");
    assert.strictEqual(agent.thinking, "medium");
    assert.strictEqual(agent.provider, "pi");
  });
});
