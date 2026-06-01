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
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyToolCall } from "../../src/pi-extensions/guard.js";
import { PI_GUARD_WORKSPACE_ROOT_ENV } from "../../src/pi-rpc-protocol.js";

/**
 * Read the merged guardian orphan-allowlist (`orphan-allowlist.txt` +
 * `orphan-allowlist.local.txt`) from the workspace root, stripping comments and
 * blank lines (the same format `guardian.sh` parses). Returns `undefined` when
 * neither file is readable, which DISABLES the orphan check — the
 * security-critical protected-prefix guard still applies, so a missing hygiene
 * list never bricks all root-level writes (the one deliberate softening vs
 * guardian.sh's fail-closed, justified because the orphan check is workspace
 * hygiene, not a security boundary).
 */
function readOrphanAllowlist(workspaceRoot: string): string[] | undefined {
  const patterns: string[] = [];
  let found = false;
  for (const name of ["orphan-allowlist.txt", "orphan-allowlist.local.txt"]) {
    let content: string;
    try {
      content = readFileSync(join(workspaceRoot, name), "utf8");
    } catch {
      continue; // missing file (the .local override is optional) → skip
    }
    found = true;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (line) {
        patterns.push(line);
      }
    }
  }
  return found ? patterns : undefined;
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

    // The orphan check (guardian.sh parity) applies ONLY to the `write` tool, so
    // read the allowlist lazily — never on the read/grep/bash/edit hot path. The
    // allowlist files live at the protected workspace root, so read from there.
    const orphanAllowlist =
      event.toolName === "write" && guardRoot ? readOrphanAllowlist(guardRoot) : undefined;

    const decision = classifyToolCall(
      {
        toolName: event.toolName,
        input: event.input as Record<string, unknown> | undefined,
      },
      { workspaceRoot: guardRoot, resolveRoot: ctx.cwd, orphanAllowlist, fileExists: existsSync },
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
