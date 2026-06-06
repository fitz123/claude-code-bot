/**
 * A3 — subagent (pure, testable core).
 *
 * Backs the adopted vendor `subagent` Pi extension
 * (`bot/.claude/extensions/subagent/`), which delegates a task to a specialized
 * agent by spawning an ISOLATED `pi` child process and streaming back its result.
 * The vendor example hardcodes non-Codex models; the only behavioral adaptation for
 * this bot is the PROVIDER WIRING — spawned children must run on the same
 * `openai-codex` provider/model the parent Pi session uses (see
 * `pi-rpc-protocol.ts`). That wiring, the child-output (JSONL) parser, the
 * result classifier, the dependency-injected child runner, and the structured
 * child-error warn-log all live here so they are unit-tested
 * (`subagent.test.ts`); the wrapper `index.ts` is a thin jiti-only orchestrator
 * that calls into this module (single source of truth — see
 * `pi-extensions/README.md`).
 *
 * Everything here is pure / dependency-injected (the child `spawn` and the
 * `warn` sink are injected), so the tests drive the spawn-arg shape, the
 * JSONL-line parse, and the child-error path with a FAKE spawn and never launch
 * a real `pi` process.
 */

/** Provider every subagent child is spawned under (parity with the parent). */
export const SUBAGENT_PROVIDER = "openai-codex";
/** Default model when an agent definition pins none (parity with the parent). */
export const DEFAULT_SUBAGENT_MODEL = "openai-codex/gpt-5.5";

/**
 * Normalize an agent-pinned model into a fully-qualified `provider/model`.
 * Mirrors `normalizePiModel` in `pi-rpc-protocol.ts`: an empty/absent value
 * falls back to {@link DEFAULT_SUBAGENT_MODEL}; a bare model name (no `/`) is
 * prefixed with {@link SUBAGENT_PROVIDER}; an already-qualified value passes
 * through untouched.
 */
export function normalizeSubagentModel(model: string | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return DEFAULT_SUBAGENT_MODEL;
  }
  return trimmed.includes("/") ? trimmed : `${SUBAGENT_PROVIDER}/${trimmed}`;
}

/** The subset of an agent definition the spawn-arg builder needs. */
export interface SubagentSpawnAgent {
  /** Agent-pinned model (frontmatter `model`); undefined → codex default. */
  model?: string;
  /** Agent-pinned tool allow-list (frontmatter `tools`); empty → inherit all. */
  tools?: string[];
}

export interface BuildSubagentSpawnArgsOptions {
  /**
   * Path to a temp file holding the agent's system prompt. When set, append it
   * via `--append-system-prompt <path>` (the vendor writes a 0600 temp file).
   */
  systemPromptPath?: string;
  /**
   * Pre-resolved `--extension <abs-path>` args to load into the child. Appended
   * verbatim BEFORE the positional task. Empty/absent means the child loads no
   * explicit first-party extensions. The child still passes `--no-extensions` to
   * block Pi's ambient discovery. The caller resolves these (`resolvePiExtensionArgs`)
   * so this module stays pure/testable.
   */
  extensionArgs?: string[];
}

/**
 * Build the complete `pi` argv for one subagent child, in the vendor's order
 * with the openai-codex provider wired in:
 *   --mode json -p --no-session --no-extensions --provider <p> --model <m>
 *   [--tools a,b] [--append-system-prompt <path>] [--extension <abs> ...] "Task: <task>"
 *
 * `--mode json` + `-p` make the child emit a single-shot JSONL transcript on
 * stdout (parsed by {@link parseSubagentEventLine}); `--no-session` keeps the
 * child stateless. The trailing positional carries the delegated task.
 */
export function buildSubagentSpawnArgs(
  agent: SubagentSpawnAgent,
  task: string,
  options?: BuildSubagentSpawnArgsOptions,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--provider",
    SUBAGENT_PROVIDER,
    "--model",
    normalizeSubagentModel(agent.model),
  ];

  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  if (options?.systemPromptPath) {
    args.push("--append-system-prompt", options.systemPromptPath);
  }

  // Load the child's resolved extension wrappers BEFORE the positional task.
  if (options?.extensionArgs && options.extensionArgs.length > 0) {
    args.push(...options.extensionArgs);
  }

  args.push(`Task: ${task}`);
  return args;
}

/** A `{ type, text }` text block of an assistant message. */
export interface SubagentTextBlock {
  type: "text";
  text: string;
}

/** A `{ type: "toolCall", ... }` block of an assistant message. */
export interface SubagentToolCallBlock {
  type: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
}

export type SubagentContentBlock =
  | SubagentTextBlock
  | SubagentToolCallBlock
  | { type: string; [key: string]: unknown };

/** Per-message usage as emitted by Pi's JSON mode (all fields optional). */
export interface SubagentMessageUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

/** A Pi `AgentMessage` (defensively typed — everything optional). */
export interface SubagentMessage {
  role?: string;
  content?: SubagentContentBlock[];
  usage?: SubagentMessageUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Accumulated usage across a child run. */
export interface SubagentUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export function emptyUsageStats(): SubagentUsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * A parsed child-stdout JSONL line. `message_end` / `tool_result_end` carry a
 * `message`; everything else (and any malformed line) parses to `null` so the
 * runner skips it without throwing.
 */
export type SubagentStreamEvent =
  | { kind: "message"; message: SubagentMessage }
  | { kind: "toolResult"; message: SubagentMessage }
  | null;

/**
 * Parse a single JSONL line from a `--mode json` child. Mirrors the vendor's
 * inline `processLine`: only `message_end` and `tool_result_end` events (with a
 * `message`) are surfaced. Never throws — a blank or non-JSON line → `null`.
 */
export function parseSubagentEventLine(line: string): SubagentStreamEvent {
  if (!line.trim()) {
    return null;
  }
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") {
    return null;
  }
  const e = event as { type?: unknown; message?: unknown };
  if ((e.type === "message_end" || e.type === "tool_result_end") && e.message && typeof e.message === "object") {
    return {
      kind: e.type === "message_end" ? "message" : "toolResult",
      message: e.message as SubagentMessage,
    };
  }
  return null;
}

/**
 * Fold an assistant `message_end` message into the running usage stats (mirrors
 * the vendor accumulation). No-op for non-assistant messages.
 */
export function accumulateAssistantUsage(usage: SubagentUsageStats, message: SubagentMessage): void {
  if (message.role !== "assistant") {
    return;
  }
  usage.turns++;
  const u = message.usage;
  if (u) {
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.cacheWrite += u.cacheWrite ?? 0;
    usage.cost += u.cost?.total ?? 0;
    usage.contextTokens = u.totalTokens ?? 0;
  }
}

/** The final assistant text of a run = text blocks of the last assistant msg. */
export function getFinalOutput(messages: SubagentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && typeof (part as SubagentTextBlock).text === "string") {
          return (part as SubagentTextBlock).text;
        }
      }
    }
  }
  return "";
}

/** A completed (or in-progress) child run, for failure classification. */
export interface SubagentResultLike {
  exitCode: number;
  messages: SubagentMessage[];
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
}

/** A run failed if it exited non-zero or the model errored/aborted. */
export function isFailedResult(result: SubagentResultLike): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/** Best available text for a result — error diagnostics for failures. */
export function getResultOutput(result: SubagentResultLike): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

/** Structured payload for the child-error warn-log. */
export interface SubagentChildErrorWarn {
  agent: string;
  exitCode: number;
  stopReason?: string;
  detail?: string;
}

/** Format a {@link SubagentChildErrorWarn} into a single structured log line. */
export function formatSubagentChildErrorWarn(w: SubagentChildErrorWarn): string {
  const parts = [`[subagent] agent=${w.agent}`, `exit=${w.exitCode}`];
  if (w.stopReason) {
    parts.push(`stopReason=${w.stopReason}`);
  }
  if (w.detail) {
    parts.push(`detail=${w.detail}`);
  }
  return parts.join(" ");
}

/** Minimal readable-stream surface the runner consumes (Node `Readable`). */
export interface SubagentReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/** Minimal child-process surface the runner consumes (Node `ChildProcess`). */
export interface SubagentChildLike {
  stdout: SubagentReadableLike | null;
  stderr: SubagentReadableLike | null;
  killed?: boolean;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Injected spawn (real: `node:child_process.spawn`; tests: a fake). */
export interface SubagentSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
}

export type SubagentSpawn = (
  command: string,
  args: string[],
  options: SubagentSpawnOptions,
) => SubagentChildLike;

export interface SubagentRunResult extends SubagentResultLike {
  usage: SubagentUsageStats;
  model?: string;
  /** True when the run was killed via the abort signal (user-initiated). */
  aborted: boolean;
}

export interface RunSubagentChildDeps {
  /** Injected spawn — the only side-effecting dependency. */
  spawn: SubagentSpawn;
  /** Resolved executable (e.g. `node` or `pi`). */
  command: string;
  /** Full argv (typically {@link buildSubagentSpawnArgs} output). */
  args: string[];
  /** Working directory for the child. */
  cwd?: string;
  /** Allowlisted child environment. */
  env?: Record<string, string>;
  /** Abort signal — when aborted, SIGTERM then (after a grace) SIGKILL. */
  signal?: AbortSignal;
  /** Streaming hook fired after each parsed message (drives onUpdate). */
  onMessage?: (result: SubagentRunResult) => void;
  /** Structured warn sink for a failed (non-aborted) child. */
  warn?: (event: SubagentChildErrorWarn) => void;
  /** Agent name (for the warn payload only). */
  agentName: string;
  /**
   * Grace period (ms) between SIGTERM and the SIGKILL escalation on abort.
   * Defaults to {@link SUBAGENT_ABORT_GRACE_MS}; injectable so tests can drive
   * the escalation without a real 5s wait.
   */
  abortGraceMs?: number;
}

/** Grace period before escalating an aborted child from SIGTERM to SIGKILL. */
export const SUBAGENT_ABORT_GRACE_MS = 5000;

/**
 * Spawn a subagent child and resolve once it closes, accumulating its JSONL
 * transcript into a {@link SubagentRunResult}. Mirrors the vendor's spawn loop
 * but is dependency-injected and provider-agnostic so tests drive it with a
 * fake child. A FAILED, non-aborted child emits a structured `warn` (the
 * child-error warn-log required by the plan). Never rejects: a spawn `error`
 * resolves with `exitCode: 1`.
 */
export function runSubagentChild(deps: RunSubagentChildDeps): Promise<SubagentRunResult> {
  const result: SubagentRunResult = {
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsageStats(),
    aborted: false,
  };

  const emit = () => deps.onMessage?.(result);

  return new Promise<SubagentRunResult>((resolve) => {
    let settled = false;
    let buffer = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;

    const ingest = (event: SubagentStreamEvent) => {
      if (!event) {
        return;
      }
      result.messages.push(event.message);
      if (event.kind === "message" && event.message.role === "assistant") {
        accumulateAssistantUsage(result.usage, event.message);
        if (!result.model && event.message.model) {
          result.model = event.message.model;
        }
        if (event.message.stopReason) {
          result.stopReason = event.message.stopReason;
        }
        if (event.message.errorMessage) {
          result.errorMessage = event.message.errorMessage;
        }
      }
      emit();
    };

    const processLine = (line: string) => ingest(parseSubagentEventLine(line));

    const finish = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      // Remove the abort listener so it can't fire after the run has settled
      // and so it doesn't leak across chain/parallel reuse of one signal.
      removeAbortListener?.();
      result.exitCode = code;
      if (!result.aborted && isFailedResult(result)) {
        deps.warn?.({
          agent: deps.agentName,
          exitCode: result.exitCode,
          stopReason: result.stopReason,
          detail: result.errorMessage || result.stderr.trim().slice(-300) || undefined,
        });
      }
      resolve(result);
    };

    const child = deps.spawn(deps.command, deps.args, {
      cwd: deps.cwd,
      env: deps.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr?.on("data", (chunk) => {
      result.stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (buffer.trim()) {
        processLine(buffer);
      }
      finish(code ?? 0);
    });

    child.on("error", () => {
      finish(1);
    });

    if (deps.signal) {
      const killChild = () => {
        result.aborted = true;
        child.kill("SIGTERM");
        // `child.kill()` sets `child.killed = true` the instant the signal is
        // SENT (not when the process exits), so `!child.killed` would always be
        // false and SIGKILL would never fire. Escalate only if the child has
        // not actually closed/errored yet (`settled` flips in `finish()`).
        killTimer = setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, deps.abortGraceMs ?? SUBAGENT_ABORT_GRACE_MS);
      };
      if (deps.signal.aborted) {
        killChild();
      } else {
        const signal = deps.signal;
        signal.addEventListener("abort", killChild, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", killChild);
      }
    }
  });
}

// ---- agent discovery precedence (pure) --------------------------------------

/** Any discovered agent — keyed by `name` for precedence merging. */
export interface NamedAgent {
  name: string;
}

/**
 * Merge ordered agent layers by `name`, lowest precedence FIRST.
 *
 * Backs `discoverAgents` in the wrapper (`bot/.claude/extensions/subagent/
 * agents.ts`), which reads the real dirs (pi-runtime dep) and passes the parsed
 * layers here. Pass layers low→high: `[bundled, user, project]`. Each later
 * layer OVERRIDES an earlier one with the same `name`; novel names are additive.
 * Insertion order of the result follows first-seen order across layers (a later
 * override keeps the earlier slot), so the bundled baseline stays stable.
 *
 * The bundled layer is always included by the caller regardless of scope, so the
 * extension is self-contained; user/project layers the caller omits per scope
 * simply arrive empty here.
 */
export function mergeAgentsByPrecedence<T extends NamedAgent>(layers: T[][]): T[] {
  const byName = new Map<string, T>();
  for (const layer of layers) {
    for (const agent of layer) {
      byName.set(agent.name, agent);
    }
  }
  return Array.from(byName.values());
}
