# Top-level defaultModel for agent config — Round 1

## Goal

Let the bot owner declare the model once at the top of `config.yaml` instead of repeating `model:` on every agent. Per-agent `model` still works as an override. Resolves fitz123/claude-code-bot#97.

## Validation Commands

```bash
cd bot && npm test
cd bot && npx tsc --noEmit
```

## Reference: current config validation

`bot/src/config.ts:90-113` — `validateAgent` makes `model` mandatory on every agent (the real reason this matters today is that production `config.local.yaml` repeats the same `model: claude-opus-4-7` line across 5 agents — main, coder, anna, yulia, cyber-architect — and bumping the fleet to a new release means editing every block):

```ts
function validateAgent(raw: unknown, id: string): AgentConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Agent "${id}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.workspaceCwd !== "string") {
    throw new Error(`Agent "${id}" missing workspaceCwd`);
  }
  if (typeof obj.model !== "string") {
    throw new Error(`Agent "${id}" missing model`);
  }
  return {
    id: String(obj.id ?? id),
    workspaceCwd: obj.workspaceCwd,
    model: obj.model,
    fallbackModel: typeof obj.fallbackModel === "string" ? obj.fallbackModel : undefined,
    // ... rest of fields
  };
}
```

`bot/src/config.ts:62-76` — `RawConfig` interface has no `defaultModel` / `defaultFallbackModel` fields:

```ts
interface RawConfig {
  telegramTokenService?: string;
  agents?: Record<string, unknown>;
  bindings?: unknown[];
  sessionDefaults?: unknown;
  logLevel?: string;
  metricsPort?: number;
  discord?: {
    tokenService?: string;
    bindings?: unknown[];
  };
  adminChatId?: number;
  defaultDeliveryChatId?: number;
  defaultDeliveryThreadId?: number;
}
```

`bot/src/config.ts:295-309` — `loadConfig` iterates agents and calls `validateAgent` with no access to top-level defaults:

```ts
export function loadConfig(configPath?: string): BotConfig {
  const raw: RawConfig = loadRawMergedConfig(configPath) as RawConfig;
  // ...
  const agents: Record<string, AgentConfig> = {};
  for (const [id, agentRaw] of Object.entries(raw.agents)) {
    agents[id] = validateAgent(agentRaw, id);
  }
  // ...
}
```

`bot/src/types.ts` declares `AgentConfig` — `model: string` (required), `fallbackModel?: string`. The resolved shape stays the same; `model` remains a required string on the loaded `AgentConfig`.

`bot/src/__tests__/config-defaults.test.ts` exists and is the home for new tests covering `defaultModel` / `defaultFallbackModel` behavior.

## Tasks

### Task 1: Top-level defaultModel and defaultFallbackModel in agent config (#97, P1)

**Problem.** `bot/src/config.ts:98` rejects any agent without an explicit `model` field. When the owner wants all agents on the same model, they must repeat the `model:` line on every agent. There is no single place to bump the model for the whole fleet — production `config.local.yaml` repeats `model: claude-opus-4-7` across 5 agents, so every Opus release means 5 edits.

**What we want.** The config supports an optional top-level `defaultModel` (and symmetric `defaultFallbackModel`) that agents inherit when they do not declare their own. Per-agent `model` / `fallbackModel` still wins when present. Validation still fails if an agent ends up with no resolved model at all.

- [ ] Top-level `defaultModel` (string) is accepted in `config.yaml` / `config.local.yaml`
- [ ] Top-level `defaultFallbackModel` (string) is accepted in the same way
- [ ] Agents without a `model` field resolve to `defaultModel` in the loaded `AgentConfig`
- [ ] Agents without a `fallbackModel` field resolve to `defaultFallbackModel` in the loaded `AgentConfig`
- [ ] Agent-level `model` / `fallbackModel` still overrides the top-level default
- [ ] Config validation fails with a clear error if an agent has no `model` and no `defaultModel` is set
- [ ] Top-level `defaultModel` / `defaultFallbackModel` values that are present but not strings fail validation with a clear error
- [ ] `config.yaml` (public template) demonstrates inheritance: `defaultModel` is set at the config root and at least one agent omits `model` and inherits it
- [ ] `config.local.yaml.example` demonstrates the same inheritance pattern
- [ ] Existing configs that specify `model` on every agent and no `defaultModel` continue to load without changes (backward compat)
- [ ] Add tests in `bot/src/__tests__/config-defaults.test.ts` covering: inheritance, per-agent override wins, missing-model error when no default set, non-string default rejected, backward-compat for fully explicit configs
- [ ] Verify existing tests pass
