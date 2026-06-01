/**
 * A2 — web-tools (Tavily) pure, testable core.
 *
 * Backs the two model-callable Pi tools `web_search` and `web_fetch` with the
 * Tavily API (`api.tavily.com`). The thin Pi wrapper at
 * `bot/.claude/extensions/web-tools.ts` reads the API key from the macOS
 * keychain once at load (service `tavily-api-key`, account `minime`), then
 * `pi.registerTool`s both tools, delegating each `execute` to
 * {@link executeWebSearch} / {@link executeWebFetch} here.
 *
 * Design contract (criterion 3 of the plan):
 *  - registered + model-callable: the wrapper registers both tools with the
 *    schemas exported here ({@link WEB_SEARCH_TOOL}, {@link WEB_FETCH_TOOL}).
 *  - GRACEFUL: an `execute` never throws. A missing key, bad args, an HTTP
 *    error, or a network failure all resolve to a {@link WebToolResult} whose
 *    `text` explains the failure to the model (and `ok:false`).
 *  - structured warn-log: every failure also calls the injected `warn` sink
 *    with a {@link TavilyWarn} so the Pi session logs it (the wrapper passes
 *    `console.warn` of {@link formatTavilyWarn}).
 *
 * Everything here is pure + dependency-injected (`fetchImpl`, `apiKey`, `warn`)
 * so `tavily.test.ts` can exercise request shape, response parse, HTTP-error,
 * and missing-key paths with a mock fetch and never touch the network.
 */

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

/** Default result count for `web_search` when the model omits `max_results`. */
export const DEFAULT_SEARCH_MAX_RESULTS = 5;
/** Clamp so a model can never request a runaway page of results. */
export const MAX_SEARCH_MAX_RESULTS = 20;

/** A fully-described HTTP request (so tests can assert shape without a network). */
export interface TavilyHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** JSON-encoded request body. */
  body: string;
}

export interface WebSearchArgs {
  query?: unknown;
  max_results?: unknown;
  search_depth?: unknown;
  include_answer?: unknown;
}

export interface WebFetchArgs {
  url?: unknown;
}

/** Normalized Tavily search hit. */
export interface TavilySearchHit {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface ParsedSearch {
  answer?: string;
  results: TavilySearchHit[];
}

/** Normalized Tavily extract hit. */
export interface TavilyExtractHit {
  url: string;
  content: string;
}

export interface ParsedExtract {
  results: TavilyExtractHit[];
  /** URLs Tavily could not extract (carried through for the model). */
  failed: string[];
}

/** A tool `execute` outcome. `text` is always present (graceful even on error). */
export interface WebToolResult {
  ok: boolean;
  text: string;
}

export interface TavilyWarn {
  tool: "web_search" | "web_fetch";
  reason: "missing-key" | "bad-args" | "http-error" | "request-failed";
  detail?: string;
}

export interface RunToolDeps {
  /** Tavily API key, or undefined when the keychain lookup failed at load. */
  apiKey: string | undefined;
  /** Injected fetch (defaults to global `fetch` in the wrapper). */
  fetchImpl: typeof fetch;
  /** Structured warn sink. */
  warn?: (event: TavilyWarn) => void;
}

/** Format a {@link TavilyWarn} into a single structured log line. */
export function formatTavilyWarn(w: TavilyWarn): string {
  return `[web-tools] tool=${w.tool} reason=${w.reason}${w.detail ? ` detail=${w.detail}` : ""}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function coerceMaxResults(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_SEARCH_MAX_RESULTS;
  }
  return Math.min(Math.floor(n), MAX_SEARCH_MAX_RESULTS);
}

/** Build the Tavily `/search` HTTP request for a `web_search` call. */
export function buildSearchRequest(apiKey: string, args: WebSearchArgs): TavilyHttpRequest {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const depth = args.search_depth === "advanced" ? "advanced" : "basic";
  const includeAnswer = args.include_answer !== false; // default true
  return {
    url: TAVILY_SEARCH_URL,
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      query,
      max_results: coerceMaxResults(args.max_results),
      search_depth: depth,
      include_answer: includeAnswer,
    }),
  };
}

/** Build the Tavily `/extract` HTTP request for a `web_fetch` call. */
export function buildExtractRequest(apiKey: string, args: WebFetchArgs): TavilyHttpRequest {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  return {
    url: TAVILY_EXTRACT_URL,
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ urls: [url] }),
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Defensively parse a Tavily `/search` JSON body into {@link ParsedSearch}. */
export function parseSearchResponse(raw: unknown): ParsedSearch {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawResults = Array.isArray(obj.results) ? obj.results : [];
  const results: TavilySearchHit[] = rawResults
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => {
      const score = r.score;
      return {
        title: asString(r.title),
        url: asString(r.url),
        content: asString(r.content),
        score: typeof score === "number" ? score : undefined,
      };
    });
  const answer = asString(obj.answer);
  return answer ? { answer, results } : { results };
}

/** Defensively parse a Tavily `/extract` JSON body into {@link ParsedExtract}. */
export function parseExtractResponse(raw: unknown): ParsedExtract {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawResults = Array.isArray(obj.results) ? obj.results : [];
  const results: TavilyExtractHit[] = rawResults
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => ({
      url: asString(r.url),
      // Tavily returns the page text under `raw_content` (also seen as `content`).
      content: asString(r.raw_content) || asString(r.content),
    }))
    .filter((r) => r.url || r.content);

  const rawFailed = Array.isArray(obj.failed_results) ? obj.failed_results : [];
  const failed = rawFailed
    .map((f) => (f && typeof f === "object" ? asString((f as Record<string, unknown>).url) : asString(f)))
    .filter(Boolean);

  return { results, failed };
}

/** Render a {@link ParsedSearch} as model-readable text. */
export function formatSearchResult(query: string, parsed: ParsedSearch): string {
  const lines: string[] = [];
  if (parsed.answer) {
    lines.push(`Answer: ${parsed.answer}`, "");
  }
  if (parsed.results.length === 0) {
    lines.push(`No web results for "${query}".`);
    return lines.join("\n").trim();
  }
  lines.push(`Results for "${query}":`);
  parsed.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || "(untitled)"} — ${r.url}`);
    if (r.content) {
      lines.push(`   ${r.content}`);
    }
  });
  return lines.join("\n");
}

/** Render a {@link ParsedExtract} as model-readable text. */
export function formatExtractResult(parsed: ParsedExtract): string {
  if (parsed.results.length === 0) {
    const failedNote = parsed.failed.length ? ` (failed: ${parsed.failed.join(", ")})` : "";
    return `No content could be extracted.${failedNote}`;
  }
  const lines: string[] = [];
  for (const r of parsed.results) {
    lines.push(`URL: ${r.url}`, r.content || "(no content)");
  }
  if (parsed.failed.length) {
    lines.push("", `Failed to extract: ${parsed.failed.join(", ")}`);
  }
  return lines.join("\n");
}

function errResult(text: string): WebToolResult {
  return { ok: false, text };
}

/**
 * Run a built Tavily request through `fetchImpl`, returning the parsed JSON body
 * on a 2xx response. Throws on non-2xx (caller maps to a graceful result) and on
 * any transport error (propagated from `fetchImpl`).
 */
async function fetchTavilyJson(req: TavilyHttpRequest, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      detail = "";
    }
    const err = new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
    (err as { httpStatus?: number }).httpStatus = res.status;
    throw err;
  }
  return res.json();
}

/** Execute a `web_search` tool call. Never throws (criterion 3 — graceful). */
export async function executeWebSearch(args: WebSearchArgs, deps: RunToolDeps): Promise<WebToolResult> {
  if (!deps.apiKey) {
    deps.warn?.({ tool: "web_search", reason: "missing-key" });
    return errResult(
      "web_search is unavailable: Tavily API key not configured (keychain service " +
        "'tavily-api-key', account 'minime'). Set it and restart the bot.",
    );
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    deps.warn?.({ tool: "web_search", reason: "bad-args", detail: "empty query" });
    return errResult("web_search requires a non-empty 'query' string.");
  }

  const req = buildSearchRequest(deps.apiKey, { ...args, query });
  try {
    const json = await fetchTavilyJson(req, deps.fetchImpl);
    return { ok: true, text: formatSearchResult(query, parseSearchResponse(json)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isHttp = typeof (err as { httpStatus?: number }).httpStatus === "number";
    deps.warn?.({
      tool: "web_search",
      reason: isHttp ? "http-error" : "request-failed",
      detail: message,
    });
    return errResult(`web_search failed: ${message}`);
  }
}

/** Execute a `web_fetch` tool call. Never throws (criterion 3 — graceful). */
export async function executeWebFetch(args: WebFetchArgs, deps: RunToolDeps): Promise<WebToolResult> {
  if (!deps.apiKey) {
    deps.warn?.({ tool: "web_fetch", reason: "missing-key" });
    return errResult(
      "web_fetch is unavailable: Tavily API key not configured (keychain service " +
        "'tavily-api-key', account 'minime'). Set it and restart the bot.",
    );
  }

  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) {
    deps.warn?.({ tool: "web_fetch", reason: "bad-args", detail: "empty url" });
    return errResult("web_fetch requires a non-empty 'url' string.");
  }

  const req = buildExtractRequest(deps.apiKey, { url });
  try {
    const json = await fetchTavilyJson(req, deps.fetchImpl);
    return { ok: true, text: formatExtractResult(parseExtractResponse(json)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isHttp = typeof (err as { httpStatus?: number }).httpStatus === "number";
    deps.warn?.({
      tool: "web_fetch",
      reason: isHttp ? "http-error" : "request-failed",
      detail: message,
    });
    return errResult(`web_fetch failed: ${message}`);
  }
}

/**
 * Tool registration descriptors (name/label/description/parameters) consumed by
 * `pi.registerTool` in the wrapper. The wrapper attaches the matching `execute`.
 * `parameters` is a JSON Schema object — the standard Pi tool-parameter shape.
 */
export const WEB_SEARCH_TOOL = {
  name: "web_search",
  label: "Web Search",
  description:
    "Search the web for current information via Tavily. Returns ranked results " +
    "(title, URL, snippet) and an optional synthesized answer.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: {
        type: "number",
        description: `Max results to return (1-${MAX_SEARCH_MAX_RESULTS}, default ${DEFAULT_SEARCH_MAX_RESULTS}).`,
      },
      search_depth: {
        type: "string",
        enum: ["basic", "advanced"],
        description: "Search depth; 'advanced' is slower but more thorough.",
      },
      include_answer: {
        type: "boolean",
        description: "Whether to include a synthesized answer in the results (default true).",
      },
    },
    required: ["query"],
  },
} as const;

export const WEB_FETCH_TOOL = {
  name: "web_fetch",
  label: "Web Fetch",
  description:
    "Fetch and extract the readable text content of a single web page URL via Tavily.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute URL to fetch." },
    },
    required: ["url"],
  },
} as const;
