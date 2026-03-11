import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinding, isAuthorized } from "../telegram-bot.js";
import { buildSpawnArgs } from "../cli-protocol.js";
import type { TelegramBinding, AgentConfig, BotConfig } from "../types.js";

// Production bindings from config.yaml
const BINDINGS: TelegramBinding[] = [
  { chatId: <redacted-user-id>, agentId: "main", kind: "dm", label: "User DM" },
  { chatId: 1320328600, agentId: "yulia", kind: "dm", label: "Contact DM" },
  { chatId: 7418988410, agentId: "anna", kind: "dm", label: "Contact DM" },
  { chatId: -1003783997959, agentId: "cyber-architect", kind: "group", label: "Cyber Architect Group" },
];

// Production agents from config.yaml
const AGENTS: Record<string, AgentConfig> = {
  main: {
    id: "main",
    workspaceCwd: "/Users/user/.openclaw/workspace",
    model: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    maxTurns: 50,
  },
  yulia: {
    id: "yulia",
    workspaceCwd: "/Users/user/.openclaw/workspace-yulia",
    model: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    maxTurns: 50,
  },
  anna: {
    id: "anna",
    workspaceCwd: "/Users/user/.openclaw/workspace-anna",
    model: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    maxTurns: 50,
  },
  "cyber-architect": {
    id: "cyber-architect",
    workspaceCwd: "/Users/user/.openclaw/workspace-cyber-architect",
    model: "claude-opus-4-6",
    fallbackModel: "claude-sonnet-4-6",
    maxTurns: 50,
  },
};

describe("Binding verification: all 4 bindings present", () => {
  it("has exactly 4 bindings", () => {
    assert.strictEqual(BINDINGS.length, 4);
  });

  it("User DM → main agent", () => {
    const b = resolveBinding(<redacted-user-id>, BINDINGS);
    assert.ok(b);
    assert.strictEqual(b.agentId, "main");
    assert.strictEqual(b.kind, "dm");
  });

  it("Contact DM → yulia agent", () => {
    const b = resolveBinding(1320328600, BINDINGS);
    assert.ok(b);
    assert.strictEqual(b.agentId, "yulia");
    assert.strictEqual(b.kind, "dm");
  });

  it("Contact DM → anna agent", () => {
    const b = resolveBinding(7418988410, BINDINGS);
    assert.ok(b);
    assert.strictEqual(b.agentId, "anna");
    assert.strictEqual(b.kind, "dm");
  });

  it("Cyber Architect group → cyber-architect agent", () => {
    const b = resolveBinding(-1003783997959, BINDINGS);
    assert.ok(b);
    assert.strictEqual(b.agentId, "cyber-architect");
    assert.strictEqual(b.kind, "group");
  });
});

describe("Workspace verification: each cwd exists with CLAUDE.md", () => {
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

  it("Ninja and Yulia resolve to different agents and workspaces", () => {
    const ninja = resolveBinding(<redacted-user-id>, BINDINGS)!;
    const yulia = resolveBinding(1320328600, BINDINGS)!;
    assert.notStrictEqual(ninja.agentId, yulia.agentId);
    assert.notStrictEqual(AGENTS[ninja.agentId].workspaceCwd, AGENTS[yulia.agentId].workspaceCwd);
  });

  it("spawn args for different agents produce different --add-dir values", () => {
    const ninjaAgent = AGENTS["main"];
    const yuliaAgent = AGENTS["yulia"];
    const ninjaArgs = buildSpawnArgs({ agent: ninjaAgent, sessionId: "a" });
    const yuliaArgs = buildSpawnArgs({ agent: yuliaAgent, sessionId: "b" });

    const ninjaDir = ninjaArgs[ninjaArgs.indexOf("--add-dir") + 1];
    const yuliaDir = yuliaArgs[yuliaArgs.indexOf("--add-dir") + 1];
    assert.notStrictEqual(ninjaDir, yuliaDir);
  });
});
