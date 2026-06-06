/**
 * A2 — web-tools (Tavily) pure, testable core.
 *
 * Backs the two model-callable Pi tools `web_search` and `web_fetch` with the
 * Tavily API (`api.tavily.com`). The thin Pi wrapper at
 * `bot/.claude/extensions/web-tools.ts` reads the API key from the workspace
 * SOPS file once at load, then
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
 * Everything here is pure + dependency-injected (`fetchImpl`, `apiKey`,
 * `resolveHost`, `warn`) so `tavily.test.ts` can exercise request shape,
 * response parse, HTTP-error, DNS-based egress guard, and missing-key paths
 * with mocks and never touch the network.
 */

import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";
import { TAVILY_SOPS_FILE_RELPATH, TAVILY_SOPS_KEY } from "./tavily-constants.js";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

/** Default result count for `web_search` when the model omits `max_results`. */
export const DEFAULT_SEARCH_MAX_RESULTS = 5;
/** Clamp so a model can never request a runaway page of results. */
export const MAX_SEARCH_MAX_RESULTS = 20;
/** Keep model-supplied search text small enough to avoid pasted local data. */
export const MAX_SEARCH_QUERY_CHARS = 300;
/** Hard cap for fetch URLs before they are sent to Tavily. */
export const MAX_FETCH_URL_CHARS = 2048;
const DNS_RESOLVE_TIMEOUT_MS = 1500;

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
  reason: "missing-key" | "bad-args" | "blocked-egress" | "http-error" | "request-failed";
  detail?: string;
}

export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

export interface RunToolDeps {
  /** Tavily API key, or undefined when the SOPS lookup failed at load. */
  apiKey: string | undefined;
  /** Injected fetch (defaults to global `fetch` in the wrapper). */
  fetchImpl: typeof fetch;
  /** Optional DNS resolver for hostname egress checks (mocked in tests). */
  resolveHost?: ResolveHost;
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

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|authorization|cookie|credential|passwd|password|secret|session|token)\b\s*[:=]\s*\S{4,}/i;
const AUTH_HEADER_PATTERN = /\b(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{12,}\b/i;
const COMMON_SECRET_TOKEN_PATTERN =
  /\b(?:gh[pousr]_|sk-|tvly-|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/;
const PRIVATE_KEY_MARKER_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const LOCAL_PATH_PATTERN =
  /(?:^|[\s"'`=:(])(?:~\/|\.\.\/|\/(?:Users|home|private|var\/folders|etc|tmp)\/|[A-Za-z]:\\)[^\s"'`)]*/;
const REPO_FILE_PATH_PATTERN =
  /(?:^|[\s"'`=:(])(?:\.claude\/|bot\/|memory\/|\.ssh\/|(?:config\.local\.yaml|\.env|id_rsa)\b|[A-Za-z0-9_-]+\/[A-Za-z0-9._/-]+\.(?:env|json|key|md|pem|ts|tsx|yaml|yml)\b)/;
const HIGH_ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9_+/=-]{32,}/g;
const SENSITIVE_URL_PARAM_PATTERN =
  /(?:api[_-]?key|auth|cookie|credential|key|passwd|password|secret|session|token)/i;

function containsHighEntropyToken(text: string): boolean {
  for (const [token] of text.matchAll(HIGH_ENTROPY_TOKEN_PATTERN)) {
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token)) {
      return true;
    }
  }
  return false;
}

interface OutboundTextValidationOptions {
  checkSensitiveAssignments?: boolean;
  checkLocalPaths?: boolean;
  checkRepoPaths?: boolean;
}

function validateOutboundText(
  kind: "query" | "url" | "url path" | "url fragment" | "url query parameter",
  text: string,
  maxChars: number,
  options: OutboundTextValidationOptions = {},
): string | undefined {
  if (text.length > maxChars) {
    return `${kind} exceeds ${maxChars} characters`;
  }
  if (/[\r\n]/.test(text)) {
    return `${kind} contains multiline content`;
  }
  if (text.includes("```")) {
    return `${kind} contains a code block`;
  }
  if (PRIVATE_KEY_MARKER_PATTERN.test(text)) {
    return `${kind} contains private-key material`;
  }
  if (AUTH_HEADER_PATTERN.test(text) || COMMON_SECRET_TOKEN_PATTERN.test(text) || JWT_PATTERN.test(text)) {
    return `${kind} contains credential-like text`;
  }
  if (options.checkSensitiveAssignments !== false && SENSITIVE_ASSIGNMENT_PATTERN.test(text)) {
    return `${kind} contains a sensitive assignment`;
  }
  if (options.checkLocalPaths && LOCAL_PATH_PATTERN.test(text)) {
    return `${kind} contains local path text`;
  }
  if (options.checkRepoPaths && REPO_FILE_PATH_PATTERN.test(text)) {
    return `${kind} contains workspace/repository path text`;
  }
  if (containsHighEntropyToken(text)) {
    return `${kind} contains high-entropy token-like text`;
  }
  return undefined;
}

function canonicalHostname(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function ipv4Octets(host: string): number[] | undefined {
  if (isIP(host) !== 4) {
    return undefined;
  }
  return host.split(".").map((part) => Number(part));
}

function isPublicIpv4(octets: readonly number[]): boolean {
  const [a, b, c, d] = octets;
  const isLimitedBroadcastOrMulticast = a >= 224;
  const isThisNetwork = a === 0;
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const isLoopback = a === 127;
  const isSharedAddressSpace = a === 100 && b >= 64 && b <= 127;
  const isLinkLocal = a === 169 && b === 254;
  const isIetfProtocolAssignment = a === 192 && b === 0 && c === 0;
  const isDocumentation = (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
  const isDeprecated6to4Relay = a === 192 && b === 88 && c === 99;
  const isBenchmarking = a === 198 && (b === 18 || b === 19);
  return !(
    isLimitedBroadcastOrMulticast ||
    isThisNetwork ||
    isPrivate ||
    isLoopback ||
    isSharedAddressSpace ||
    isLinkLocal ||
    isIetfProtocolAssignment ||
    isDocumentation ||
    isDeprecated6to4Relay ||
    isBenchmarking
  );
}

function ipv6Groups(host: string): number[] | undefined {
  if (isIP(host) !== 6) {
    return undefined;
  }

  let source = host;
  let embeddedIpv4Groups: number[] = [];
  const lastColon = source.lastIndexOf(":");
  const possibleIpv4 = lastColon === -1 ? "" : source.slice(lastColon + 1);
  const embeddedIpv4 = possibleIpv4.includes(".") ? ipv4Octets(possibleIpv4) : undefined;
  if (embeddedIpv4) {
    source = source.slice(0, lastColon);
    embeddedIpv4Groups = [
      (embeddedIpv4[0] << 8) | embeddedIpv4[1],
      (embeddedIpv4[2] << 8) | embeddedIpv4[3],
    ];
  }

  const halves = source.split("::");
  if (halves.length > 2) {
    return undefined;
  }

  const parseHalf = (half: string): number[] => {
    if (!half) {
      return [];
    }
    return half.split(":").map((part) => Number.parseInt(part, 16));
  };
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  const explicitGroupCount = left.length + right.length + embeddedIpv4Groups.length;
  const zeroFillCount = halves.length === 2 ? 8 - explicitGroupCount : 0;
  if (zeroFillCount < 0 || (halves.length === 1 && explicitGroupCount !== 8)) {
    return undefined;
  }

  return [...left, ...Array(zeroFillCount).fill(0), ...right, ...embeddedIpv4Groups];
}

function ipv4MappedOctets(groups: readonly number[]): number[] | undefined {
  const hasIpv4Prefix = groups.slice(0, 5).every((group) => group === 0);
  if (!hasIpv4Prefix || (groups[5] !== 0 && groups[5] !== 0xffff)) {
    return undefined;
  }
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
}

function isPublicIpv6(groups: readonly number[]): boolean {
  const mappedV4 = ipv4MappedOctets(groups);
  if (mappedV4 !== undefined) {
    return isPublicIpv4(mappedV4);
  }

  const [first, second] = groups;
  const isGlobalUnicast = (first & 0xe000) === 0x2000;
  if (!isGlobalUnicast) {
    return false;
  }

  const isDocumentation = first === 0x2001 && second === 0x0db8;
  const isTeredo = first === 0x2001 && second === 0;
  const isBenchmark = first === 0x2001 && second === 0x0002 && groups[2] === 0;
  const isOrchidV2 = first === 0x2001 && second >= 0x0020 && second <= 0x002f;
  const isDeprecated6to4 = first === 0x2002;
  const isDocumentationV2 = first === 0x3fff;
  return !(
    isDocumentation ||
    isTeredo ||
    isBenchmark ||
    isOrchidV2 ||
    isDeprecated6to4 ||
    isDocumentationV2
  );
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = canonicalHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }

  const v4 = ipv4Octets(host);
  if (v4) {
    return !isPublicIpv4(v4);
  }

  const v6 = ipv6Groups(host);
  if (!v6) {
    return false;
  }
  return !isPublicIpv6(v6);
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const records = await lookupDns(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function resolveHostWithTimeout(resolveHost: ResolveHost, hostname: string): Promise<readonly string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("dns-timeout")), DNS_RESOLVE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([resolveHost(hostname), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function validateResolvedHostname(hostname: string, resolveHost: ResolveHost): Promise<string | undefined> {
  const host = canonicalHostname(hostname);
  if (isIP(host)) {
    return undefined;
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveHostWithTimeout(resolveHost, host);
  } catch {
    return "url host could not be resolved safely";
  }

  if (addresses.length === 0) {
    return "url host could not be resolved safely";
  }

  if (addresses.some((address) => isPrivateOrLocalHost(address))) {
    return "url host resolves to a local/private address";
  }

  return undefined;
}

function validateWebSearchEgress(query: string): string | undefined {
  return validateOutboundText("query", query, MAX_SEARCH_QUERY_CHARS, {
    checkLocalPaths: true,
    checkRepoPaths: true,
  });
}

interface WebFetchEgressValidation {
  problem?: string;
  safeUrl?: string;
}

function decodeUrlText(kind: "url path" | "url fragment", text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function validateDecodedUrlText(kind: "url path" | "url fragment", rawText: string): string | undefined {
  const decoded = decodeUrlText(kind, rawText);
  if (decoded === undefined) {
    return `${kind} contains malformed percent-encoding`;
  }
  const textForValidation = kind === "url path" ? decoded.replace(/^\/{2,}/, "/") : decoded;
  return validateOutboundText(kind, textForValidation, MAX_FETCH_URL_CHARS, {
    checkLocalPaths: true,
    checkRepoPaths: kind === "url fragment",
  });
}

async function validateWebFetchEgress(
  url: string,
  resolveHost: ResolveHost = defaultResolveHost,
): Promise<WebFetchEgressValidation> {
  const textProblem = validateOutboundText("url", url, MAX_FETCH_URL_CHARS, {
    checkSensitiveAssignments: false,
  });
  if (textProblem) {
    return { problem: textProblem };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: "url must be an absolute http(s) URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { problem: "url must use http(s)" };
  }
  if (parsed.username || parsed.password) {
    return { problem: "url contains credentials" };
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    return { problem: "url targets a local/private host" };
  }

  const resolvedHostProblem = await validateResolvedHostname(parsed.hostname, resolveHost);
  if (resolvedHostProblem) {
    return { problem: resolvedHostProblem };
  }

  const rawPathProblem = validateOutboundText("url path", parsed.pathname, MAX_FETCH_URL_CHARS, {
    checkLocalPaths: true,
  });
  if (rawPathProblem) {
    return { problem: rawPathProblem };
  }
  const decodedPathProblem = validateDecodedUrlText("url path", parsed.pathname);
  if (decodedPathProblem) {
    return { problem: decodedPathProblem };
  }

  if (parsed.hash) {
    const fragmentProblem = validateDecodedUrlText("url fragment", parsed.hash.slice(1));
    if (fragmentProblem) {
      return { problem: fragmentProblem };
    }
  }

  for (const [name, value] of parsed.searchParams) {
    if (value && SENSITIVE_URL_PARAM_PATTERN.test(name)) {
      return { problem: "url contains a sensitive query parameter" };
    }
    const paramProblem = validateOutboundText("url query parameter", value, MAX_SEARCH_QUERY_CHARS, {
      checkLocalPaths: true,
      checkRepoPaths: true,
    });
    if (paramProblem) {
      return { problem: paramProblem };
    }
  }

  parsed.hash = "";
  return { safeUrl: parsed.href };
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

function missingKeyText(tool: "web_search" | "web_fetch"): string {
  return `${tool} is unavailable: Tavily API key not configured (SOPS key ` +
    `${TAVILY_SOPS_KEY} in ${TAVILY_SOPS_FILE_RELPATH}). Add the private ` +
    "control-workspace Tavily SOPS file and restart the bot.";
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
    return errResult(missingKeyText("web_search"));
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    deps.warn?.({ tool: "web_search", reason: "bad-args", detail: "empty query" });
    return errResult("web_search requires a non-empty 'query' string.");
  }

  const egressProblem = validateWebSearchEgress(query);
  if (egressProblem) {
    deps.warn?.({ tool: "web_search", reason: "blocked-egress", detail: egressProblem });
    return errResult(`web_search blocked: ${egressProblem}. Do not send local or private data to external web services.`);
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
    return errResult(missingKeyText("web_fetch"));
  }

  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) {
    deps.warn?.({ tool: "web_fetch", reason: "bad-args", detail: "empty url" });
    return errResult("web_fetch requires a non-empty 'url' string.");
  }

  const egress = await validateWebFetchEgress(url, deps.resolveHost ?? defaultResolveHost);
  if (egress.problem) {
    deps.warn?.({ tool: "web_fetch", reason: "blocked-egress", detail: egress.problem });
    return errResult(`web_fetch blocked: ${egress.problem}. Do not send local or private data to external web services.`);
  }

  const req = buildExtractRequest(deps.apiKey, { url: egress.safeUrl ?? url });
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
    "(title, URL, snippet) and an optional synthesized answer. Do not include " +
    "local file contents, paths, credentials, or other private data.",
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
    "Fetch and extract the readable text content of a single public web page URL " +
    "via Tavily. URLs containing credentials or private/local targets are blocked.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute URL to fetch." },
    },
    required: ["url"],
  },
} as const;
