import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildExtractRequest,
  buildSearchRequest,
  DEFAULT_SEARCH_MAX_RESULTS,
  executeWebFetch,
  executeWebSearch,
  formatExtractResult,
  formatSearchResult,
  formatTavilyWarn,
  MAX_SEARCH_MAX_RESULTS,
  parseExtractResponse,
  parseSearchResponse,
  TAVILY_EXTRACT_URL,
  TAVILY_SEARCH_URL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  type RunToolDeps,
  type TavilyWarn,
} from "../pi-extensions/tavily.js";
import {
  readTavilyApiKeyFromSops,
  tavilyControlWorkspaceRoot,
  tavilySopsFilePath,
  TAVILY_SOPS_FILE_RELPATH,
  TAVILY_SOPS_KEY,
} from "../pi-extensions/tavily-secret.js";
import type { ExecFileSyncLike } from "../secrets.js";
import { MINIME_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

const KEY = "tvly-test-key";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = resolve(__dirname, "..", "..");
const WEB_TOOLS_WRAPPER_PATH = resolve(BOT_DIR, ".claude", "extensions", "web-tools.ts");

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface MockFetch {
  fn: typeof fetch;
  calls: FetchCall[];
}

interface WrapperToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: { ok: boolean };
}

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<WrapperToolResult>;
}

/** A minimal Response-like object for the success / HTTP-error paths. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): MockFetch {
  const calls: FetchCall[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** Capture warn events for assertions. */
function makeDeps(overrides: Partial<RunToolDeps> = {}): { deps: RunToolDeps; warns: TavilyWarn[] } {
  const warns: TavilyWarn[] = [];
  const deps: RunToolDeps = {
    apiKey: KEY,
    fetchImpl: mockFetch(async () => jsonResponse({ results: [] })).fn,
    resolveHost: async () => ["93.184.216.34"],
    warn: (e) => warns.push(e),
    ...overrides,
  };
  return { deps, warns };
}

describe("tavily: buildSearchRequest", () => {
  it("targets the Tavily /search endpoint via POST with a Bearer header", () => {
    const req = buildSearchRequest(KEY, { query: "hello" });
    assert.equal(req.url, TAVILY_SEARCH_URL);
    assert.equal(req.method, "POST");
    assert.equal(req.headers["Authorization"], `Bearer ${KEY}`);
    assert.equal(req.headers["Content-Type"], "application/json");
  });

  it("trims the query and applies defaults in the body", () => {
    const body = JSON.parse(buildSearchRequest(KEY, { query: "  spacey  " }).body);
    assert.equal(body.query, "spacey");
    assert.equal(body.max_results, DEFAULT_SEARCH_MAX_RESULTS);
    assert.equal(body.search_depth, "basic");
    assert.equal(body.include_answer, true);
  });

  it("clamps max_results to the cap and floors fractions", () => {
    const big = JSON.parse(buildSearchRequest(KEY, { query: "q", max_results: 999 }).body);
    assert.equal(big.max_results, MAX_SEARCH_MAX_RESULTS);
    const frac = JSON.parse(buildSearchRequest(KEY, { query: "q", max_results: 3.9 }).body);
    assert.equal(frac.max_results, 3);
  });

  it("falls back to the default for non-positive / non-numeric max_results", () => {
    assert.equal(JSON.parse(buildSearchRequest(KEY, { query: "q", max_results: 0 }).body).max_results, DEFAULT_SEARCH_MAX_RESULTS);
    assert.equal(JSON.parse(buildSearchRequest(KEY, { query: "q", max_results: "abc" }).body).max_results, DEFAULT_SEARCH_MAX_RESULTS);
  });

  it("honors advanced depth and include_answer=false", () => {
    const body = JSON.parse(buildSearchRequest(KEY, { query: "q", search_depth: "advanced", include_answer: false }).body);
    assert.equal(body.search_depth, "advanced");
    assert.equal(body.include_answer, false);
  });

  it("threads an explicit include_answer=true into the request (present → in request)", () => {
    const body = JSON.parse(buildSearchRequest(KEY, { query: "q", include_answer: true }).body);
    assert.equal(body.include_answer, true);
  });

  it("does NOT put the api key in the body (header only)", () => {
    const body = JSON.parse(buildSearchRequest(KEY, { query: "q" }).body);
    assert.equal(body.api_key, undefined);
  });
});

describe("tavily: buildExtractRequest", () => {
  it("targets /extract with the URL wrapped in a urls array", () => {
    const req = buildExtractRequest(KEY, { url: "  https://example.com  " });
    assert.equal(req.url, TAVILY_EXTRACT_URL);
    assert.equal(req.method, "POST");
    assert.equal(req.headers["Authorization"], `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(req.body), { urls: ["https://example.com"] });
  });
});

describe("tavily: parseSearchResponse", () => {
  it("extracts normalized hits and the answer", () => {
    const parsed = parseSearchResponse({
      answer: "the answer",
      results: [
        { title: "T1", url: "u1", content: "c1", score: 0.9 },
        { title: "T2", url: "u2", content: "c2" },
      ],
    });
    assert.equal(parsed.answer, "the answer");
    assert.equal(parsed.results.length, 2);
    assert.deepEqual(parsed.results[0], { title: "T1", url: "u1", content: "c1", score: 0.9 });
    assert.equal(parsed.results[1].score, undefined);
  });

  it("is defensive against garbage shapes (no throw, empty results)", () => {
    assert.deepEqual(parseSearchResponse(null), { results: [] });
    assert.deepEqual(parseSearchResponse({ results: "nope" }), { results: [] });
    assert.deepEqual(parseSearchResponse({ results: [null, 5, { url: "ok" }] }).results, [
      { title: "", url: "ok", content: "", score: undefined },
    ]);
  });

  it("omits the answer key when empty/absent", () => {
    assert.equal("answer" in parseSearchResponse({ results: [] }), false);
    assert.equal("answer" in parseSearchResponse({ answer: "", results: [] }), false);
  });
});

describe("tavily: parseExtractResponse", () => {
  it("prefers raw_content, falls back to content, and collects failures", () => {
    const parsed = parseExtractResponse({
      results: [
        { url: "u1", raw_content: "raw text" },
        { url: "u2", content: "fallback text" },
        { url: "", raw_content: "" },
      ],
      failed_results: [{ url: "bad1", error: "x" }, "bad2"],
    });
    assert.equal(parsed.results.length, 2);
    assert.deepEqual(parsed.results[0], { url: "u1", content: "raw text" });
    assert.deepEqual(parsed.results[1], { url: "u2", content: "fallback text" });
    assert.deepEqual(parsed.failed, ["bad1", "bad2"]);
  });

  it("is defensive against garbage shapes", () => {
    assert.deepEqual(parseExtractResponse(undefined), { results: [], failed: [] });
    assert.deepEqual(parseExtractResponse({ results: {} }), { results: [], failed: [] });
  });
});

describe("tavily: formatters", () => {
  it("renders search results with answer + numbered hits", () => {
    const text = formatSearchResult("q", {
      answer: "A",
      results: [{ title: "T", url: "U", content: "C" }],
    });
    assert.match(text, /Answer: A/);
    assert.match(text, /1\. T — U/);
    assert.match(text, /C/);
  });

  it("renders a no-results search message", () => {
    assert.match(formatSearchResult("nope", { results: [] }), /No web results for "nope"/);
  });

  it("renders extracted content and failures", () => {
    const text = formatExtractResult({ results: [{ url: "U", content: "body" }], failed: ["F"] });
    assert.match(text, /URL: U/);
    assert.match(text, /body/);
    assert.match(text, /Failed to extract: F/);
  });

  it("renders a no-content extract message with failures", () => {
    assert.match(formatExtractResult({ results: [], failed: ["F"] }), /No content could be extracted\. \(failed: F\)/);
  });
});

describe("tavily: executeWebSearch", () => {
  it("returns ok with formatted text on a successful response", async () => {
    const mock = mockFetch(async () => jsonResponse({ answer: "ans", results: [{ title: "T", url: "U", content: "C" }] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebSearch({ query: "weather" }, deps);
    assert.equal(res.ok, true);
    assert.match(res.text, /Answer: ans/);
    assert.match(res.text, /T — U/);
    assert.equal(warns.length, 0);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, TAVILY_SEARCH_URL);
  });

  it("returns a graceful unavailable result + warn when the key is missing (no fetch)", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ apiKey: undefined, fetchImpl: mock.fn });
    const res = await executeWebSearch({ query: "q" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /unavailable/);
    assert.match(res.text, /SOPS key tavily\.api_key in config\/secrets\.sops\.yaml/);
    assert.doesNotMatch(res.text, /keychain|Keychain|tavily-api-key|minime/);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, [{ tool: "web_search", reason: "missing-key" }]);
  });

  it("rejects an empty query gracefully (bad-args, no fetch)", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebSearch({ query: "   " }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /non-empty 'query'/);
    assert.equal(mock.calls.length, 0);
    assert.equal(warns[0].reason, "bad-args");
  });

  it("blocks local path text in a search query before external egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebSearch({ query: "debug ../private/config.local.yaml" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /blocked/);
    assert.doesNotMatch(res.text, /\.\.\/private/);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, [
      { tool: "web_search", reason: "blocked-egress", detail: "query contains local path text" },
    ]);
  });

  it("reports workspace/repository path text distinctly from local paths", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebSearch({ query: "inspect bot/src/config.ts" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /blocked/);
    assert.doesNotMatch(res.text, /bot\/src\/config\.ts/);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, [
      { tool: "web_search", reason: "blocked-egress", detail: "query contains workspace/repository path text" },
    ]);
  });

  it("allows ordinary search queries containing bot or memory", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const queries = ["Telegram bot webhook docs", "Node memory leak debugging"];

    for (const query of queries) {
      const res = await executeWebSearch({ query }, deps);
      assert.equal(res.ok, true);
    }

    assert.equal(mock.calls.length, queries.length);
    assert.equal(warns.length, 0);
    assert.deepEqual(
      mock.calls.map((call) => JSON.parse(String(call.init?.body)).query),
      queries,
    );
  });

  it("blocks multiline search content before external egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebSearch({ query: "line one\nline two" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /multiline/);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, [
      { tool: "web_search", reason: "blocked-egress", detail: "query contains multiline content" },
    ]);
  });

  it("maps a non-2xx response to a graceful http-error result", async () => {
    const mock = mockFetch(async () => jsonResponse("rate limited", 429));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebSearch({ query: "q" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /web_search failed/);
    assert.match(res.text, /HTTP 429/);
    assert.equal(warns[0].tool, "web_search");
    assert.equal(warns[0].reason, "http-error");
  });

  it("maps a transport error to a graceful request-failed result", async () => {
    const mock = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebSearch({ query: "q" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /web_search failed: ECONNREFUSED/);
    assert.equal(warns[0].reason, "request-failed");
  });
});

describe("tavily: executeWebFetch", () => {
  it("returns ok with extracted text on success", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [{ url: "U", raw_content: "page body" }] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebFetch({ url: "https://example.com" }, deps);
    assert.equal(res.ok, true);
    assert.match(res.text, /page body/);
    assert.equal(mock.calls[0].url, TAVILY_EXTRACT_URL);
    assert.equal(warns.length, 0);
  });

  it("returns a graceful unavailable result + warn when the key is missing", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ apiKey: undefined, fetchImpl: mock.fn });
    const res = await executeWebFetch({ url: "https://example.com" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /unavailable/);
    assert.match(res.text, /SOPS key tavily\.api_key in config\/secrets\.sops\.yaml/);
    assert.doesNotMatch(res.text, /keychain|Keychain|tavily-api-key|minime/);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, [{ tool: "web_fetch", reason: "missing-key" }]);
  });

  it("rejects an empty url gracefully (bad-args)", async () => {
    const { deps, warns } = makeDeps();
    const res = await executeWebFetch({ url: "" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /non-empty 'url'/);
    assert.equal(warns[0].reason, "bad-args");
  });

  it("blocks URLs with credential-bearing query params before external egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebFetch({ url: "https://example.com/docs?session=example" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /blocked/);
    assert.doesNotMatch(res.text, /session=example/);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, [
      { tool: "web_fetch", reason: "blocked-egress", detail: "url contains a sensitive query parameter" },
    ]);
  });

  it("blocks encoded and repeated-slash local URL paths before external egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const urls = [
      "https://example.com/%2Ftmp%2Fprivate%2Fconfig.local.yaml",
      "https://example.com//tmp/private/config.local.yaml",
      "https://example.com/%E0%A4%A",
    ];
    const details = [
      "url path contains local path text",
      "url path contains local path text",
      "url path contains malformed percent-encoding",
    ];

    for (const url of urls) {
      const res = await executeWebFetch({ url }, deps);
      assert.equal(res.ok, false);
      assert.match(res.text, /blocked/);
    }

    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, details.map((detail) => ({
      tool: "web_fetch" as const,
      reason: "blocked-egress" as const,
      detail,
    })));
  });

  it("blocks sensitive URL fragments before external egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebFetch({ url: "https://example.com/#token=abcd" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /blocked/);
    assert.doesNotMatch(res.text, /token=abcd/);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, [
      { tool: "web_fetch", reason: "blocked-egress", detail: "url fragment contains a sensitive assignment" },
    ]);
  });

  it("strips harmless URL fragments before external egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [{ url: "https://example.com/docs", raw_content: "body" }] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebFetch({ url: "https://example.com/docs#section" }, deps);
    assert.equal(res.ok, true);
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(JSON.parse(String(mock.calls[0].init?.body)), { urls: ["https://example.com/docs"] });
    assert.equal(warns.length, 0);
  });

  it("blocks non-global IPv4 literal URLs before external egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const urls = [
      "http://10.0.0.1/",
      "http://127.0.0.1/",
      "http://100.64.0.1/",
      "http://169.254.1.1/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://192.0.0.9/",
      "http://192.0.0.10/",
      "http://192.0.2.1/",
      "http://198.18.0.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://224.0.0.1/",
      "http://240.0.0.1/",
      "http://255.255.255.255/",
    ];

    for (const url of urls) {
      const res = await executeWebFetch({ url }, deps);
      assert.equal(res.ok, false);
      assert.match(res.text, /local\/private host/);
    }

    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, urls.map(() => ({
      tool: "web_fetch" as const,
      reason: "blocked-egress" as const,
      detail: "url targets a local/private host",
    })));
  });

  it("blocks hostnames that resolve to local/private addresses before external egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const resolveCalls: string[] = [];
    const { deps, warns } = makeDeps({
      fetchImpl: mock.fn,
      resolveHost: async (hostname) => {
        resolveCalls.push(hostname);
        return ["10.0.0.1"];
      },
    });

    const res = await executeWebFetch({ url: "https://10.0.0.1.nip.io/docs" }, deps);

    assert.equal(res.ok, false);
    assert.match(res.text, /blocked/);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(resolveCalls, ["10.0.0.1.nip.io"]);
    assert.deepEqual(warns, [{
      tool: "web_fetch",
      reason: "blocked-egress",
      detail: "url host resolves to a local/private address",
    }]);
  });

  it("fails closed when hostname resolution is unavailable", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({
      fetchImpl: mock.fn,
      resolveHost: async () => { throw new Error("ENOTFOUND"); },
    });

    const res = await executeWebFetch({ url: "https://example.test/docs" }, deps);

    assert.equal(res.ok, false);
    assert.match(res.text, /blocked/);
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, [{
      tool: "web_fetch",
      reason: "blocked-egress",
      detail: "url host could not be resolved safely",
    }]);
  });

  it("blocks local, private, and reserved IPv6 literal URLs before external egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const urls = [
      "http://[::]/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fd12::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:192.168.1.1]/",
      "http://[0:0:0:0:0:ffff:ac10:1]/",
      "http://[ff00::1]/",
      "http://[2001:db8::1]/",
    ];

    for (const url of urls) {
      const res = await executeWebFetch({ url }, deps);
      assert.equal(res.ok, false);
      assert.match(res.text, /local\/private host/);
    }

    assert.equal(mock.calls.length, 0);
    assert.deepEqual(warns, urls.map(() => ({
      tool: "web_fetch" as const,
      reason: "blocked-egress" as const,
      detail: "url targets a local/private host",
    })));
  });

  it("allows public source-file URLs that are not local path egress", async () => {
    const mock = mockFetch(async () => jsonResponse({ results: [{ url: "https://example.com/src/file.ts", raw_content: "body" }] }));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebFetch({ url: "https://example.com/src/file.ts" }, deps);
    assert.equal(res.ok, true);
    assert.match(res.text, /body/);
    assert.equal(mock.calls.length, 1);
    assert.equal(warns.length, 0);
  });

  it("maps a non-2xx response to a graceful http-error result", async () => {
    const mock = mockFetch(async () => jsonResponse("boom", 500));
    const { deps, warns } = makeDeps({ fetchImpl: mock.fn });
    const res = await executeWebFetch({ url: "https://example.com" }, deps);
    assert.equal(res.ok, false);
    assert.match(res.text, /web_fetch failed/);
    assert.match(res.text, /HTTP 500/);
    assert.equal(warns[0].reason, "http-error");
  });
});

describe("tavily: SOPS API key lookup", () => {
  it("resolves config/secrets.sops.yaml relative to the control workspace", () => {
    assert.equal(tavilySopsFilePath("/workspace"), "/workspace/config/secrets.sops.yaml");
  });

  it("reads tavily.api_key from the control-workspace SOPS file", () => {
    const controlWorkspace = mkdtempSync(join(tmpdir(), "tavily-secret-control-test-"));
    mkdirSync(join(controlWorkspace, "config"));
    writeFileSync(join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH), "placeholder: true\n", "utf8");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFileSync: ExecFileSyncLike = (file, args) => {
      calls.push({ file, args });
      return "tvly-from-sops\n";
    };

    try {
      const value = readTavilyApiKeyFromSops({
        controlWorkspaceRoot: controlWorkspace,
        execFileSync,
      });

      assert.equal(value, "tvly-from-sops");
      assert.deepEqual(calls, [{
        file: "sops",
        args: ["-d", "--extract", '["tavily"]["api_key"]', join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH)],
      }]);
    } finally {
      rmSync(controlWorkspace, { recursive: true, force: true });
    }
  });

  it("uses MINIME_WORKSPACE_ROOT as the control-workspace secret contract", () => {
    const controlWorkspace = mkdtempSync(join(tmpdir(), "tavily-secret-env-control-"));
    const agentWorkspace = mkdtempSync(join(tmpdir(), "tavily-secret-env-agent-"));
    mkdirSync(join(controlWorkspace, "config"));
    writeFileSync(join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH), "placeholder: true\n", "utf8");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFileSync: ExecFileSyncLike = (file, args) => {
      calls.push({ file, args });
      return "tvly-from-control-env\n";
    };
    const oldCwd = process.cwd();

    try {
      process.chdir(agentWorkspace);
      const value = readTavilyApiKeyFromSops({
        env: { [MINIME_WORKSPACE_ROOT_ENV]: controlWorkspace },
        execFileSync,
      });

      assert.equal(value, "tvly-from-control-env");
      assert.equal(tavilyControlWorkspaceRoot({ [MINIME_WORKSPACE_ROOT_ENV]: controlWorkspace }), controlWorkspace);
      assert.deepEqual(calls, [{
        file: "sops",
        args: ["-d", "--extract", '["tavily"]["api_key"]', join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH)],
      }]);
    } finally {
      process.chdir(oldCwd);
      rmSync(controlWorkspace, { recursive: true, force: true });
      rmSync(agentWorkspace, { recursive: true, force: true });
    }
  });

  it("uses the same control-workspace Tavily secret reference from different agent workspaces", () => {
    const controlWorkspace = mkdtempSync(join(tmpdir(), "tavily-secret-shared-control-"));
    const agentOne = mkdtempSync(join(tmpdir(), "tavily-secret-agent-one-"));
    const agentTwo = mkdtempSync(join(tmpdir(), "tavily-secret-agent-two-"));
    mkdirSync(join(controlWorkspace, "config"));
    writeFileSync(join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH), "placeholder: true\n", "utf8");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFileSync: ExecFileSyncLike = (file, args) => {
      calls.push({ file, args });
      return "tvly-shared-control\n";
    };
    const oldCwd = process.cwd();

    try {
      process.chdir(agentOne);
      assert.equal(
        readTavilyApiKeyFromSops({ env: { [MINIME_WORKSPACE_ROOT_ENV]: controlWorkspace }, execFileSync }),
        "tvly-shared-control",
      );

      process.chdir(agentTwo);
      assert.equal(
        readTavilyApiKeyFromSops({ env: { [MINIME_WORKSPACE_ROOT_ENV]: controlWorkspace }, execFileSync }),
        "tvly-shared-control",
      );

      assert.deepEqual(
        calls.map((call) => call.args[3]),
        [join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH), join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH)],
      );
    } finally {
      process.chdir(oldCwd);
      rmSync(controlWorkspace, { recursive: true, force: true });
      rmSync(agentOne, { recursive: true, force: true });
      rmSync(agentTwo, { recursive: true, force: true });
    }
  });

  it("returns undefined when the control SOPS file is missing without invoking sops", () => {
    const controlWorkspace = mkdtempSync(join(tmpdir(), "tavily-secret-missing-test-"));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFileSync: ExecFileSyncLike = (file, args) => {
      calls.push({ file, args });
      return "should-not-run\n";
    };

    try {
      assert.equal(readTavilyApiKeyFromSops({ controlWorkspaceRoot: controlWorkspace, execFileSync }), undefined);
      assert.equal(calls.length, 0);
    } finally {
      rmSync(controlWorkspace, { recursive: true, force: true });
    }
  });

  it("returns undefined without invoking sops when MINIME_WORKSPACE_ROOT is absent", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFileSync: ExecFileSyncLike = (file, args) => {
      calls.push({ file, args });
      return "should-not-run\n";
    };

    assert.equal(readTavilyApiKeyFromSops({ env: {}, execFileSync }), undefined);
    assert.equal(tavilyControlWorkspaceRoot({}), undefined);
    assert.equal(calls.length, 0);
  });

  it("does not expose SOPS secret values through lookup failures", () => {
    const controlWorkspace = mkdtempSync(join(tmpdir(), "tavily-secret-private-value-"));
    mkdirSync(join(controlWorkspace, "config"));
    writeFileSync(join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH), "placeholder: true\n", "utf8");
    const secretValue = "tvly-private-value";
    const execFileSync: ExecFileSyncLike = () => {
      throw new Error(secretValue);
    };

    try {
      assert.equal(readTavilyApiKeyFromSops({ controlWorkspaceRoot: controlWorkspace, execFileSync }), undefined);
    } finally {
      rmSync(controlWorkspace, { recursive: true, force: true });
    }
  });

  it("uses the fixed SOPS file and key constants", () => {
    assert.equal(TAVILY_SOPS_FILE_RELPATH, "config/secrets.sops.yaml");
    assert.equal(TAVILY_SOPS_KEY, "tavily.api_key");
  });
});

describe("tavily: warn + tool descriptors", () => {
  it("formats a structured warn line", () => {
    assert.equal(
      formatTavilyWarn({ tool: "web_search", reason: "http-error", detail: "HTTP 429" }),
      "[web-tools] tool=web_search reason=http-error detail=HTTP 429",
    );
    assert.equal(
      formatTavilyWarn({ tool: "web_fetch", reason: "missing-key" }),
      "[web-tools] tool=web_fetch reason=missing-key",
    );
  });

  it("exposes registerTool-ready descriptors with required params", () => {
    assert.equal(WEB_SEARCH_TOOL.name, "web_search");
    assert.deepEqual([...WEB_SEARCH_TOOL.parameters.required], ["query"]);
    assert.equal(WEB_SEARCH_TOOL.parameters.properties.query.type, "string");
    // include_answer is exposed so the model can control it (impl already supports it).
    assert.equal(WEB_SEARCH_TOOL.parameters.properties.include_answer.type, "boolean");

    assert.equal(WEB_FETCH_TOOL.name, "web_fetch");
    assert.deepEqual([...WEB_FETCH_TOOL.parameters.required], ["url"]);
    assert.equal(WEB_FETCH_TOOL.parameters.properties.url.type, "string");
  });

  it("wrapper registers web_search/web_fetch and missing-key executions stay graceful", async () => {
    const childProcessMock = mock.module("node:child_process", {
      namedExports: {
        execFileSync: () => {
          throw new Error("missing test key");
        },
      },
    });
    const moduleUrl = pathToFileURL(resolve(BOT_DIR, ".claude", "extensions", "web-tools.ts")).href;
    const mod = await import(moduleUrl) as {
      default: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
    };
    const registered: RegisteredTool[] = [];
    const warns: string[] = [];
    const originalWarn = console.warn;
    const originalFetch = globalThis.fetch;
    console.warn = (...args: Parameters<typeof console.warn>): void => {
      warns.push(args.map(String).join(" "));
    };
    globalThis.fetch = async () => {
      throw new Error("wrapper test must not call fetch");
    };

    try {
      mod.default({ registerTool: (tool) => registered.push(tool) });

      assert.deepEqual(registered.map((tool) => tool.name), ["web_search", "web_fetch"]);
      assert.ok(warns.some((line) => line.includes("tool=web_search") && line.includes("reason=missing-key")));

      const search = registered.find((tool) => tool.name === "web_search");
      const fetchTool = registered.find((tool) => tool.name === "web_fetch");
      assert.ok(search);
      assert.ok(fetchTool);

      const searchResult = await search.execute("call-1", { query: "codex" });
      assert.equal(searchResult.details.ok, false);
      assert.match(searchResult.content[0].text, /unavailable/);

      const fetchResult = await fetchTool.execute("call-2", { url: "https://example.com" });
      assert.equal(fetchResult.details.ok, false);
      assert.match(fetchResult.content[0].text, /unavailable/);
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
      childProcessMock.restore();
    }
  });
});

describe("web-tools Pi wrapper", () => {
  async function importWrapper(): Promise<(pi: { registerTool(tool: RegisteredTool): void }) => void> {
    const mod = await import(pathToFileURL(WEB_TOOLS_WRAPPER_PATH).href) as {
      default: (pi: { registerTool(tool: RegisteredTool): void }) => void;
    };
    return mod.default;
  }

  it("imports the wrapper, registers both tools, and stays graceful when the SOPS file is missing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "web-tools-wrapper-missing-"));
    const oldCwd = process.cwd();
    const oldWarn = console.warn;
    const oldWorkspace = process.env[MINIME_WORKSPACE_ROOT_ENV];
    const warnings: string[] = [];
    const registered: RegisteredTool[] = [];

    try {
      process.chdir(tmpDir);
      delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      console.warn = (message?: unknown) => {
        warnings.push(String(message));
      };
      const registerWebTools = await importWrapper();
      registerWebTools({ registerTool: (tool) => registered.push(tool) });

      assert.deepEqual(registered.map((tool) => tool.name), ["web_search", "web_fetch"]);
      assert.deepEqual(warnings, ["[web-tools] tool=web_search reason=missing-key"]);

      const result = await registered[0].execute("call-1", { query: "docs" });
      assert.equal(result.details.ok, false);
      assert.match(result.content[0].text, /web_search is unavailable/);
      assert.match(result.content[0].text, /SOPS key tavily\.api_key in config\/secrets\.sops\.yaml/);
    } finally {
      console.warn = oldWarn;
      if (oldWorkspace === undefined) delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      else process.env[MINIME_WORKSPACE_ROOT_ENV] = oldWorkspace;
      process.chdir(oldCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads the wrapper API key from the control workspace while cwd is an arbitrary child workspace", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "web-tools-wrapper-sops-"));
    const controlWorkspace = join(tmpDir, "control-workspace");
    const childWorkspace = join(tmpDir, "subagent-child-workspace");
    const binDir = join(tmpDir, "bin");
    const sopsLog = join(tmpDir, "sops-argv.txt");
    const oldCwd = process.cwd();
    const oldPath = process.env.PATH;
    const oldWorkspace = process.env[MINIME_WORKSPACE_ROOT_ENV];
    const oldFetch = globalThis.fetch;
    const registered: RegisteredTool[] = [];
    const fetchCalls: FetchCall[] = [];

    try {
      mkdirSync(join(controlWorkspace, "config"), { recursive: true });
      mkdirSync(childWorkspace, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH), "placeholder: true\n", "utf8");
      writeFileSync(
        join(binDir, "sops"),
        [
          "#!/bin/bash",
          `printf '%s\\n' "$@" > ${JSON.stringify(sopsLog)}`,
          "printf 'tvly-wrapper-key\\n'",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(join(binDir, "sops"), 0o755);
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      process.env[MINIME_WORKSPACE_ROOT_ENV] = controlWorkspace;
      process.chdir(childWorkspace);
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init });
        return jsonResponse({ results: [] });
      }) as typeof fetch;

      const registerWebTools = await importWrapper();
      registerWebTools({ registerTool: (tool) => registered.push(tool) });
      const result = await registered[0].execute("call-1", { query: "docs" });

      assert.equal(result.details.ok, true);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].init?.headers && (fetchCalls[0].init.headers as Record<string, string>)["Authorization"], "Bearer tvly-wrapper-key");
      assert.deepEqual(readFileSync(sopsLog, "utf8").trim().split("\n"), [
        "-d",
        "--extract",
        '["tavily"]["api_key"]',
        join(controlWorkspace, TAVILY_SOPS_FILE_RELPATH),
      ]);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldWorkspace === undefined) delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      else process.env[MINIME_WORKSPACE_ROOT_ENV] = oldWorkspace;
      process.chdir(oldCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
