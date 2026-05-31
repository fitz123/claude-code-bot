import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAgent } from "../config.js";

describe("validateAgent provider field", () => {
  it("defaults to \"claude\" when provider is absent", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "claude-opus-4-7" },
      "main",
    );
    assert.strictEqual(agent.provider, "claude");
  });

  it("accepts provider \"claude\" explicitly", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "claude-opus-4-7", provider: "claude" },
      "main",
    );
    assert.strictEqual(agent.provider, "claude");
  });

  it("accepts provider \"pi\"", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "claude-opus-4-7", provider: "pi" },
      "main",
    );
    assert.strictEqual(agent.provider, "pi");
  });

  it("rejects an invalid provider value", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "claude-opus-4-7", provider: "openai" },
        "main",
      ),
      /Agent "main" has invalid provider "openai" \(must be "claude" or "pi"\)/,
    );
  });

  it("rejects a non-string provider value", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", model: "claude-opus-4-7", provider: 42 },
        "main",
      ),
      /Agent "main" has invalid provider/,
    );
  });

  it("rejects a pi agent with no explicit model (must not inherit the Claude defaultModel)", () => {
    assert.throws(
      () => validateAgent(
        { workspaceCwd: "/tmp/x", provider: "pi" },
        "coder",
        "opus", // Claude-oriented top-level defaultModel
      ),
      /Agent "coder" uses provider "pi" and must set an explicit model/,
    );
  });

  it("accepts a pi agent with an explicit model and does not apply defaultModel", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", model: "gpt-5.5", provider: "pi" },
      "coder",
      "opus",
    );
    assert.strictEqual(agent.model, "gpt-5.5");
    assert.strictEqual(agent.provider, "pi");
  });

  it("a claude agent still inherits the top-level defaultModel (regression)", () => {
    const agent = validateAgent(
      { workspaceCwd: "/tmp/x", provider: "claude" },
      "main",
      "claude-opus-4-7",
    );
    assert.strictEqual(agent.model, "claude-opus-4-7");
  });

  it("does not change other field handling when provider is set", () => {
    const agent = validateAgent(
      {
        workspaceCwd: "/tmp/x",
        model: "claude-opus-4-7",
        fallbackModel: "claude-sonnet-4-6",
        systemPrompt: "be helpful",
        maxTurns: 5,
        effort: "high",
        provider: "pi",
      },
      "main",
    );
    assert.strictEqual(agent.model, "claude-opus-4-7");
    assert.strictEqual(agent.fallbackModel, "claude-sonnet-4-6");
    assert.strictEqual(agent.systemPrompt, "be helpful");
    assert.strictEqual(agent.maxTurns, 5);
    assert.strictEqual(agent.effort, "high");
    assert.strictEqual(agent.provider, "pi");
  });
});
