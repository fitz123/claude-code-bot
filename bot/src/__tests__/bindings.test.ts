import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveBinding, isAuthorized } from "../telegram-bot.js";
import { buildSpawnArgs } from "../cli-protocol.js";
import type { TelegramBinding, AgentConfig, BotConfig } from "../types.js";

// Unique temp directory per test run to avoid collisions
const TEST_BASE = mkdtempSync(join(tmpdir(), "bindings-test-"));

// Test bindings (fake IDs for testing)
const BINDINGS: TelegramBinding[] = [
  { chatId: 111111111, agentId: "main", kind: "dm", label: "User1 DM" },
  { chatId: 222222222, agentId: "agent-b", kind: "dm", label: "User2 DM" },
  { chatId: 333333333, agentId: "agent-c", kind: "dm", label: "User3 DM" },
  { chatId: -1009999999999, agentId: "cyber-architect", kind: "group", label: "Test Group" },
];

// Test agents with unique per-run paths
const AGENTS: Record<string, AgentConfig> = {
  main: {
    id: "main",
    workspaceCwd: join(TEST_BASE, "workspace"),
    model: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    maxTurns: 50,
  },
  "agent-b": {
    id: "agent-b",
    workspaceCwd: join(TEST_BASE, "workspace-b"),
    model: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    maxTurns: 50,
  },
  "agent-c": {
    id: "agent-c",
    workspaceCwd: join(TEST_BASE, "workspace-c"),
    model: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    maxTurns: 50,
  },
  "cyber-architect": {
    id: "cyber-architect",
    workspaceCwd: join(TEST_BASE, "workspace-cyber-architect"),
    model: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    maxTurns: 50,
  },
};

describe("Binding verification: all 4 bindings present", () => {
  it("has exactly 4 bindings", () => {
    assert.strictEqual(BINDINGS.length, 4);
  });

  it("User1 DM → main agent", () => {
    const b = resolveBinding(111111111, BINDINGS);
    assert.ok(b);
    assert.strictEqual(b.agentId, "main");
    assert.strictEqual(b.kind, "dm");
  });

  it("User2 DM → agent-b", () => {
    const b = resolveBinding(222222222, BINDINGS);
    assert.ok(b);
    assert.strictEqual(b.agentId, "agent-b");
    assert.strictEqual(b.kind, "dm");
  });

  it("User3 DM → agent-c", () => {
    const b = resolveBinding(333333333, BINDINGS);
    assert.ok(b);
    assert.strictEqual(b.agentId, "agent-c");
    assert.strictEqual(b.kind, "dm");
  });

  it("Test Group → cyber-architect agent", () => {
    const b = resolveBinding(-1009999999999, BINDINGS);
    assert.ok(b);
    assert.strictEqual(b.agentId, "cyber-architect");
    assert.strictEqual(b.kind, "group");
  });
});

describe("Workspace verification: each cwd exists with CLAUDE.md", () => {
  before(() => {
    for (const agent of Object.values(AGENTS)) {
      mkdirSync(agent.workspaceCwd, { recursive: true });
      writeFileSync(resolve(agent.workspaceCwd, "CLAUDE.md"), "# Test");
    }
  });

  after(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
  });

  for (const [agentId, agent] of Object.entries(AGENTS)) {
    it(`${agentId} workspace exists: ${agent.workspaceCwd}`, () => {
      assert.ok(existsSync(agent.workspaceCwd), `Directory missing: ${agent.workspaceCwd}`);
    });

    it(`${agentId} workspace has CLAUDE.md`, () => {
      const claudeMd = resolve(agent.workspaceCwd, "CLAUDE.md");
      assert.ok(existsSync(claudeMd), `CLAUDE.md missing: ${claudeMd}`);
    });
  }
});

describe("Workspace routing: each binding uses correct --add-dir", () => {
  for (const binding of BINDINGS) {
    it(`chatId ${binding.chatId} (${binding.label}) spawns with correct workspace`, () => {
      const agent = AGENTS[binding.agentId];
      assert.ok(agent, `Agent ${binding.agentId} not found`);

      const args = buildSpawnArgs({ agent, sessionId: "test-uuid" });
      const addDirIdx = args.indexOf("--add-dir");
      assert.ok(addDirIdx >= 0, "Missing --add-dir flag");
      assert.strictEqual(args[addDirIdx + 1], agent.workspaceCwd);
    });
  }
});

describe("Auth: unauthorized users are rejected", () => {
  it("unknown chatId is not authorized", () => {
    assert.strictEqual(isAuthorized(999999999, BINDINGS), false);
  });

  it("random positive chatId is rejected", () => {
    assert.strictEqual(isAuthorized(123456789, BINDINGS), false);
  });

  it("random negative chatId (group) is rejected", () => {
    assert.strictEqual(isAuthorized(-1001234567890, BINDINGS), false);
  });

  it("zero is rejected", () => {
    assert.strictEqual(isAuthorized(0, BINDINGS), false);
  });

  it("all known chatIds are authorized", () => {
    for (const b of BINDINGS) {
      assert.ok(isAuthorized(b.chatId, BINDINGS), `${b.label} should be authorized`);
    }
  });
});

describe("Session isolation: different chats get different sessions", () => {
  it("each binding maps to a unique agentId", () => {
    const agentIds = BINDINGS.map((b) => b.agentId);
    const unique = new Set(agentIds);
    assert.strictEqual(unique.size, agentIds.length, "Duplicate agentId in bindings");
  });

  it("each agent has a unique workspaceCwd", () => {
    const cwds = Object.values(AGENTS).map((a) => a.workspaceCwd);
    const unique = new Set(cwds);
    assert.strictEqual(unique.size, cwds.length, "Duplicate workspaceCwd in agents");
  });

  it("User1 and User2 resolve to different agents and workspaces", () => {
    const user1 = resolveBinding(111111111, BINDINGS)!;
    const user2 = resolveBinding(222222222, BINDINGS)!;
    assert.notStrictEqual(user1.agentId, user2.agentId);
    assert.notStrictEqual(AGENTS[user1.agentId].workspaceCwd, AGENTS[user2.agentId].workspaceCwd);
  });

  it("spawn args for different agents produce different --add-dir values", () => {
    const user1Agent = AGENTS["main"];
    const user2Agent = AGENTS["agent-b"];
    const user1Args = buildSpawnArgs({ agent: user1Agent, sessionId: "a" });
    const user2Args = buildSpawnArgs({ agent: user2Agent, sessionId: "b" });

    const user1Dir = user1Args[user1Args.indexOf("--add-dir") + 1];
    const user2Dir = user2Args[user2Args.indexOf("--add-dir") + 1];
    assert.notStrictEqual(user1Dir, user2Dir);
  });
});
