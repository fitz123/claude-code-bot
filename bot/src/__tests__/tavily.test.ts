import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  tavilySopsFilePath,
  TAVILY_SOPS_FILE_RELPATH,
  TAVILY_SOPS_KEY,
} from "../pi-extensions/tavily-secret.js";
import type { ExecFileSyncLike } from "../secrets.js";

const KEY = "tvly-test-key";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface MockFetch {
  fn: typeof fetch;
  calls: FetchCall[];
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
  it("resolves config/secrets.sops.yaml relative to the Pi session cwd", () => {
    assert.equal(tavilySopsFilePath("/workspace"), "/workspace/config/secrets.sops.yaml");
  });

  it("reads tavily.api_key from the workspace SOPS file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tavily-secret-test-"));
    mkdirSync(join(tmpDir, "config"));
    writeFileSync(join(tmpDir, TAVILY_SOPS_FILE_RELPATH), "placeholder: true\n", "utf8");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFileSync: ExecFileSyncLike = (file, args) => {
      calls.push({ file, args });
      return "tvly-from-sops\n";
    };

    try {
      const value = readTavilyApiKeyFromSops({
        cwd: tmpDir,
        execFileSync,
      });

      assert.equal(value, "tvly-from-sops");
      assert.deepEqual(calls, [{
        file: "sops",
        args: ["-d", "--extract", '["tavily"]["api_key"]', join(tmpDir, TAVILY_SOPS_FILE_RELPATH)],
      }]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the SOPS file is missing without invoking sops", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tavily-secret-missing-test-"));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFileSync: ExecFileSyncLike = (file, args) => {
      calls.push({ file, args });
      return "should-not-run\n";
    };

    try {
      assert.equal(readTavilyApiKeyFromSops({ cwd: tmpDir, execFileSync }), undefined);
      assert.equal(calls.length, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
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
});
