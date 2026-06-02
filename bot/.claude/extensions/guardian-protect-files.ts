/**
 * A1 — guardian + protect-files write guard (Pi extension wrapper).
 *
 * Thin, jiti-loaded wrapper (intentionally OUTSIDE `bot/src`, so excluded from
 * `tsc --noEmit` and the `npm test` glob — see `bot/src/pi-extensions/README.md`).
 * All logic lives in the unit-tested pure helper `guard.ts`; this file only
 * wires a Pi `tool_call` handler to {@link classifyToolCall} and returns Pi's
 * `{ block, reason }` result.
 *
 * Loaded into every `pi --mode rpc` spawn via `--extension` (see
 * `resolvePiExtensionArgs` in `bot/src/pi-rpc-protocol.ts`). Disable the whole
 * extension set with `PI_EXTENSIONS_DISABLED=1`.
 *
 * This wrapper drives the SCHEMA-ENFORCED deny-by-default model: it parses the
 * workspace `schema.md` ```` ```write-allowlist ```` block and injects it as
 * `writeAllowlist`. It injects exactly ONE model per session — it does NOT also
 * inject the legacy `orphanAllowlist` (root-component) model. That model's
 * matching logic still lives in `guard.ts` for not-yet-migrated callers; this
 * wrapper has migrated off it. See the design plan
 * `docs/plans/2026-06-02-pi-claude-write-guard-enforcers.md`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyToolCall } from "../../src/pi-extensions/guard.js";
import { PI_GUARD_WORKSPACE_ROOT_ENV } from "../../src/pi-rpc-protocol.js";

/**
 * Tools that carry a write target: `write`/`edit` (at `input.path`) and `bash`
 * (via redirect / `tee` / `mv` / `cp`, parsed by `guard.ts`). The schema
 * allow-check only matters for these; read/grep/ls never reach it, so the
 * `schema.md` read is skipped on that hot path.
 */
const WRITE_TARGET_TOOLS = new Set(["write", "edit", "bash"]);

/** The fence tag that opens the single write-allowlist block in `schema.md`. */
const WRITE_ALLOWLIST_FENCE = "```write-allowlist";

/**
 * Per-process cache of the parsed write-allowlist, keyed by workspace root. The
 * `schema.md` block is read once per spawn (Pi sessions are short-lived); an
 * edit to `schema.md` is picked up on the next spawn, not mid-session.
 */
const writeAllowlistCache = new Map<string, string[]>();

/**
 * Read the workspace write allow-list — the lines of the single
 * ```` ```write-allowlist ```` fenced block in `<workspaceRoot>/schema.md`.
 * Mirrors the awk extraction `guardian.sh` uses
 * (`/^```write-allowlist$/{f=1;next} f&&/^```/{exit} f`): the lines strictly
 * between an opening fence that is EXACTLY ```` ```write-allowlist ```` and the
 * next line starting with ```` ``` ````. Both stop after the FIRST block (the awk
 * `exit`s, this loop `break`s) so they stay identical even if schema.md carries a
 * second block against its contract. Each extracted line then has `#` comments
 * stripped, is trimmed, and blanks dropped — the same stripping the guardian
 * orphan-allowlist uses.
 *
 * Returns the parsed lines, or an EMPTY array when `schema.md` is missing /
 * unreadable or has no `write-allowlist` block. The empty array is DELIBERATE
 * (not `undefined`): per the write-guard fail-safe, a missing/empty allow-list
 * must DENY-BY-DEFAULT (fail closed) inside {@link classifyToolCall} — the
 * immutable core still blocks and every other target is denied with an
 * actionable "add it to schema.md" message. Injecting `undefined` would instead
 * turn the deny-by-default model OFF (re-enabling allow-all for non-immutable
 * paths) — the opposite of fail-closed. The pure classifier never touches the
 * filesystem; this wrapper does the I/O and injects the result.
 */
function readWriteAllowlist(workspaceRoot: string): string[] {
  const cached = writeAllowlistCache.get(workspaceRoot);
  if (cached !== undefined) {
    return cached;
  }
  const lines: string[] = [];
  let content: string;
  try {
    content = readFileSync(join(workspaceRoot, "schema.md"), "utf8");
  } catch {
    // Missing/unreadable schema.md → empty list → fail-closed in the classifier.
    writeAllowlistCache.set(workspaceRoot, lines);
    return lines;
  }
  let inBlock = false;
  for (const rawLine of content.split("\n")) {
    if (!inBlock) {
      if (rawLine === WRITE_ALLOWLIST_FENCE) {
        inBlock = true;
      }
      continue;
    }
    if (rawLine.startsWith("```")) {
      break; // closing fence of the write-allowlist block
    }
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line) {
      lines.push(line);
    }
  }
  writeAllowlistCache.set(workspaceRoot, lines);
  return lines;
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    // Protection is anchored at the IMMUTABLE workspace root. For a subagent
    // CHILD that is the parent workspace (carried in PI_GUARD_WORKSPACE_ROOT), so
    // a caller-supplied `cwd` cannot move the guard root and let a delegated
    // absolute write reach a protected dir. For a top-level parent the env is
    // unset (scrubbed by buildPiSpawnEnv) → the guard root IS `ctx.cwd`. Relative
    // targets still resolve against the real `ctx.cwd` (where the OS writes them).
    const guardRoot = process.env[PI_GUARD_WORKSPACE_ROOT_ENV]?.trim() || ctx.cwd;

    // Schema-enforced DENY-BY-DEFAULT (the new model). Read the `schema.md`
    // write-allowlist lazily for the write-target tools only (never on the
    // read/grep hot path), cached per process. Inject `writeAllowlist` ONLY —
    // never the legacy `orphanAllowlist`: the wrapper drives exactly one model
    // per session, and a missing/empty list fails CLOSED in classifyToolCall.
    const writeAllowlist =
      WRITE_TARGET_TOOLS.has(event.toolName) && guardRoot
        ? readWriteAllowlist(guardRoot)
        : undefined;

    const decision = classifyToolCall(
      {
        toolName: event.toolName,
        input: event.input as Record<string, unknown> | undefined,
      },
      { workspaceRoot: guardRoot, resolveRoot: ctx.cwd, writeAllowlist },
    );

    if (decision.block) {
      // RPC mode has no UI (ctx.hasUI === false); the block reason flows back to
      // the model via Pi's ToolCallEventResult. Surface a notice when a UI exists.
      if (ctx.hasUI && decision.reason) {
        ctx.ui.notify(decision.reason, "warning");
      }
      return { block: true, reason: decision.reason };
    }

    return undefined;
  });
}
