/**
 * A2 — web-tools (Tavily) Pi extension wrapper.
 *
 * Thin, jiti-loaded wrapper (intentionally OUTSIDE `bot/src`, so excluded from
 * `tsc --noEmit` and the `npm test` glob — see `bot/src/pi-extensions/README.md`).
 * All request/parse/error logic lives in the unit-tested pure helper `tavily.ts`;
 * this file only:
 *  1. reads the Tavily API key from the macOS keychain ONCE at load
 *     (service `tavily-api-key`, account `minime`) — warn-logs if absent;
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

import { execFileSync } from "node:child_process";
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

const KEYCHAIN_SERVICE = "tavily-api-key";
const KEYCHAIN_ACCOUNT = "minime";

/** Read the Tavily key from the macOS keychain; returns undefined if absent. */
function readTavilyApiKey(): string | undefined {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
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

  pi.registerTool({
    ...WEB_SEARCH_TOOL,
    execute: async (input: Record<string, unknown>) => {
      const result = await executeWebSearch(input, deps);
      return result.text;
    },
  });

  pi.registerTool({
    ...WEB_FETCH_TOOL,
    execute: async (input: Record<string, unknown>) => {
      const result = await executeWebFetch(input, deps);
      return result.text;
    },
  });
}
