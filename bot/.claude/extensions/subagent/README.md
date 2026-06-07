# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Bot adaptation (A3 — Pi Phase-2 extensions)

This is the upstream Pi `subagent` example, ADOPTED as a bot Pi extension and
loaded into every `pi --mode rpc` spawn via `--extension` (see
`resolvePiExtensionArgs` in `bot/src/pi-rpc-protocol.ts`). Three behavioral changes
from upstream:

1. **Provider wiring**: each spawned child runs on the bot's `openai-codex`
   provider/model (parity with the parent session) instead of the vendor's
   hardcoded Claude models. That wiring — plus the child-output (JSONL) parser,
   the result classifier, the dependency-injected child runner, the agent
   precedence-merge, and the structured child-error warn-log — lives in the
   unit-tested pure helper `bot/src/pi-extensions/subagent-args.ts` (single
   source of truth); `index.ts` is a thin orchestrator over it. The sample agents
   below have had their Claude-specific `model:` frontmatter REMOVED so each
   inherits the codex default (`buildSubagentSpawnArgs` injects `--provider
   openai-codex`).
2. **Self-contained discovery**: the bundled agents (`agents/*.md`) and workflow
   prompts (`prompts/*.md`) are auto-discovered from the extension's OWN dir
   (resolved from the module via `import.meta.url`, not cwd), so the extension
   works on `--extension` load with no symlink setup. Bundled definitions are the
   **lowest-precedence baseline** — user (`~/.pi/agent/agents`, `~/.pi/agent/prompts`)
   and project (`.pi/agents`, `.pi/prompts`) definitions layer on top and
   **override the bundled ones by name**. `discoverAgents` always loads the
   bundled `agents/` dir first regardless of `agentScope`; the bundled `prompts/`
   dir is registered via a `resources_discover` handler in `index.ts`.
3. **Child extension subset**: each child `pi -p` spawn passes `--no-extensions`,
   then explicitly loads only web-tools via `PI_SUBAGENT_CHILD_WRAPPER_RELPATHS`.
   Children do not load `subagent/index.ts`, so recursive subagent spawning stays
   disabled. Missing web-tools wrappers fail during spawn arg resolution; a
   missing Tavily key leaves web tools registered but returning graceful
   unavailable results.

**Tool/param contract:** the registered tool is named `subagent`; modes are
`single` (`{ agent, task }`), `parallel` (`{ tasks: [...] }`), and `chain`
(`{ chain: [...] }` with a `{previous}` placeholder) — the same contract the
workflow prompts in `prompts/` and the bot's delegation skills invoke.

> **Note:** the Installation section below is retained verbatim from upstream as
> reference and does NOT reflect the live deployment. In this bot the extension
> is loaded via `--extension` (see above), and the bundled agents + prompts are
> auto-discovered from the extension's own dir (see "Self-contained discovery")
> — the symlink commands under Installation are NOT needed. The sample agents'
> Claude `model:` frontmatter is also removed (children inherit the
> `openai-codex` default). Users MAY still add or override agents/prompts in the
> user (`~/.pi/agent/...`) or project (`.pi/...`) dirs; those override the
> bundled ones by name.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Loads the **bundled agents** (shipped with this extension, lowest precedence) plus **user-level agents** from `~/.pi/agent/agents` (which override bundled by name). Project-local agents are NOT loaded by default.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: gpt-5.5
---

System prompt for the agent goes here.
```

**Locations (precedence, lowest → highest):**
- `<extension>/agents/*.md` - Bundled (always loaded, the baseline)
- `~/.pi/agent/agents/*.md` - User-level (loaded unless `agentScope: "project"`)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Later sources override earlier ones with the same name: user overrides bundled; project overrides both (when `agentScope` includes project). The bundled agents always load regardless of `agentScope`, so the extension is self-contained.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Codex default | read, grep, find, ls, bash, web_search, web_fetch |
| `planner` | Implementation plans | Codex default | read, grep, find, ls, web_search, web_fetch |
| `reviewer` | Code review | Codex default | read, grep, find, ls, bash, web_search, web_fetch |
| `worker` | General-purpose | Codex default | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

These are auto-discovered from the bundled `prompts/` dir via the extension's `resources_discover` handler (lowest precedence). User (`~/.pi/agent/prompts`) and project (`.pi/prompts`) prompts of the same name override the bundled ones.

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
