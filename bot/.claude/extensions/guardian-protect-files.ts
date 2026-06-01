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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyToolCall } from "../../src/pi-extensions/guard.js";

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const decision = classifyToolCall(
      {
        toolName: event.toolName,
        input: event.input as Record<string, unknown> | undefined,
      },
      { workspaceRoot: ctx.cwd },
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
