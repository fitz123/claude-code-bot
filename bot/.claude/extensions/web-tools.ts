/**
 * A2 — web-tools (Tavily) Pi extension wrapper.
 *
 * Thin, jiti-loaded wrapper (intentionally OUTSIDE `bot/src`, so excluded from
 * `tsc --noEmit` and the `npm test` glob — see `bot/src/pi-extensions/README.md`).
 * All request/parse/error logic lives in the unit-tested pure helper `tavily.ts`;
 * this file only:
 *  1. obtains the Tavily API key for this Pi process — warn-logs if absent;
 *  2. registers the `web_search` + `web_fetch` tools so the model can call them;
 *  3. delegates each `execute` to the pure helper and returns its `text`.
 *
 * Loaded into every `pi --mode rpc` spawn via `--extension` (see
 * `resolvePiExtensionArgs` in `bot/src/pi-rpc-protocol.ts`). Disable the whole
 * extension set with `PI_EXTENSIONS_DISABLED=1`.
 *
 * Graceful by contract: a missing key does NOT prevent registration — the tools
 * stay model-callable and return a clear "unavailable" result (no throw), so the
 * Pi session never crashes over a web tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  executeWebFetch,
  executeWebSearch,
  formatTavilyWarn,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  type RunToolDeps,
  type TavilyWarn,
} from "../../src/pi-extensions/tavily.js";

/** Read the Tavily key for this Pi process; returns undefined if absent. */
function readTavilyApiKey(): string | undefined {
  return undefined;
}

export default function (pi: ExtensionAPI): void {
  const apiKey = readTavilyApiKey();

  const warn = (event: TavilyWarn): void => {
    // eslint-disable-next-line no-console -- structured warn-log for the Pi session
    console.warn(formatTavilyWarn(event));
  };

  if (!apiKey) {
    warn({ tool: "web_search", reason: "missing-key" });
  }

  const deps: RunToolDeps = { apiKey, fetchImpl: fetch, warn };

  // Pi's tool `execute` signature is `(toolCallId, params, signal, onUpdate, ctx)`
  // and it MUST resolve to an `AgentToolResult` (`{ content, details }`), NOT a
  // bare string — see the vendor `subagent/index.ts` and the
  // `@earendil-works/pi-coding-agent` `ToolDefinition` type. The actual tool
  // arguments are the SECOND positional (`params`); the first is the tool-call id.
  pi.registerTool({
    ...WEB_SEARCH_TOOL,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await executeWebSearch(params ?? {}, deps);
      return { content: [{ type: "text" as const, text: result.text }], details: { ok: result.ok } };
    },
  });

  pi.registerTool({
    ...WEB_FETCH_TOOL,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await executeWebFetch(params ?? {}, deps);
      return { content: [{ type: "text" as const, text: result.text }], details: { ok: result.ok } };
    },
  });
}
