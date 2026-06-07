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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyToolCall } from "../../src/pi-extensions/guard.js";
import {
  readWriteAllowlistEntriesForGuard,
  resolveWriteAllowlistSchemaPath,
} from "../../src/pi-extensions/write-allowlist-schema.js";
import { PI_GUARD_WORKSPACE_ROOT_ENV } from "../../src/pi-rpc-protocol.js";

/**
 * Tools that carry a write target: `write`/`edit` (at `input.path`) and `bash`
 * (via redirect / `tee` / `mv` / `cp`, parsed by `guard.ts`). The schema
 * allow-check only matters for these; read/grep/ls never reach it, so the
 * `schema.md` read is skipped on that hot path.
 */
const WRITE_TARGET_TOOLS = new Set(["write", "edit", "bash"]);

/**
 * Per-process cache of the parsed write-allowlist, keyed by schema path. The
 * `schema.md` block is read once per spawn (Pi sessions are short-lived); an
 * edit to `schema.md` is picked up on the next spawn, not mid-session.
 */
const writeAllowlistCache = new Map<string, string[]>();

/**
 * Read the workspace write allow-list from the resolved schema path. When
 * MINIME_SCHEMA_PATH is set, it is resolved exactly like the workspace contract:
 * absolute paths are used as-is and relative paths are based on the guard root.
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
  const schemaPath = resolveWriteAllowlistSchemaPath(workspaceRoot, process.env);
  const cached = writeAllowlistCache.get(schemaPath);
  if (cached !== undefined) {
    return cached;
  }
  const lines = readWriteAllowlistEntriesForGuard(schemaPath);
  writeAllowlistCache.set(schemaPath, lines);
  return lines;
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    // Protection is anchored at the IMMUTABLE workspace root carried in
    // PI_GUARD_WORKSPACE_ROOT. Top-level agents and subagent children can both run
    // from a child cwd, so relative targets still resolve against the real
    // `ctx.cwd` (where the OS writes them).
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
