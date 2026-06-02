import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assemblePiContext,
  buildBundle,
  collectRules,
  expandImports,
  resolvePersona,
  writeTempArtifact,
  _resetPiContextCache,
} from "../pi-context-assembler.js";
import { log } from "../logger.js";
import type { AgentConfig } from "../types.js";

// The verbatim memory directive — pinned here so a wording drift in the module
// fails this test (it is part of the deterministic bundle contract, D7).
const MEMORY_DIRECTIVE =
  "MEMORY.md above is the index of long-term memory. When a topic matches an entry, use the read tool to load the specific `memory/auto/<name>.md` on demand. (Auto-recall like the Claude harness is not yet available under Pi — read deliberately by index; a memory_search tool is a tracked fast-follow.)";

const created: string[] = [];

after(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  _resetPiContextCache();
});

interface WorkspaceSpec {
  claudeMd?: string;
  files?: Record<string, string>;
}

/** Build a throwaway workspace dir from a spec and register it for cleanup. */
function makeWorkspace(spec: WorkspaceSpec): string {
  const ws = mkdtempSync(join(tmpdir(), "pi-ctx-"));
  created.push(ws);
  if (spec.claudeMd !== undefined) {
    writeFileSync(join(ws, "CLAUDE.md"), spec.claudeMd, "utf8");
  }
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const abs = join(ws, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return ws;
}

/** A realistic fixture: CLAUDE.md with an import + a MEMORY.md import, two rules,
 *  a settings.local.json + an output-style file. */
function fullFixture(): string {
  return makeWorkspace({
    claudeMd: [
      "# Test Workspace",
      "",
      "INTRO_BODY_TOKEN here.",
      "",
      "@import.md",
      "@MEMORY.md",
      "",
      "## Trailing",
      "",
      "TRAILING_BODY_TOKEN.",
    ].join("\n"),
    files: {
      "import.md": "IMPORTED_BODY_TOKEN",
      "MEMORY.md": "MEMORY_INDEX_TOKEN",
      ".claude/rules/platform/x.md": "PLATFORM_RULE_TOKEN",
      ".claude/rules/custom/y.md": "CUSTOM_RULE_TOKEN",
      ".claude/settings.local.json": JSON.stringify({ outputStyle: "persona-style" }),
      ".claude/output-styles/persona-style.md": "PERSONA_TOKEN body",
    },
  });
}

function agentFor(ws: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { id: "main", workspaceCwd: ws, model: "gpt-5.5", ...overrides };
}

/** Run `fn` while capturing log.warn messages; return both the value and warnings. */
function captureWarn<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = log.warn;
  log.warn = (_tag: string, message: string) => {
    warnings.push(message);
  };
  try {
    return { value: fn(), warnings };
  } finally {
    log.warn = original;
  }
}

describe("buildBundle — deterministic order (D7)", () => {
  it("assembles body, imports (in order), platform rules, custom rules, memory directive", () => {
    const ws = fullFixture();
    const bundle = buildBundle(ws);

    const iBody = bundle.indexOf("INTRO_BODY_TOKEN");
    const iImport = bundle.indexOf("## import.md");
    const iMemorySection = bundle.indexOf("## MEMORY.md");
    const iPlatform = bundle.indexOf("## .claude/rules/platform/x.md");
    const iCustom = bundle.indexOf("## .claude/rules/custom/y.md");
    const iMemAccess = bundle.indexOf("## Memory access");

    for (const [name, idx] of Object.entries({ iBody, iImport, iMemorySection, iPlatform, iCustom, iMemAccess })) {
      assert.ok(idx >= 0, `${name} should be present in the bundle`);
    }
    assert.ok(iBody < iImport, "body precedes the first import section");
    assert.ok(iImport < iMemorySection, "imports keep their CLAUDE.md order (import.md before MEMORY.md)");
    assert.ok(iMemorySection < iPlatform, "imports precede platform rules");
    assert.ok(iPlatform < iCustom, "platform rules precede custom rules");
    assert.ok(iCustom < iMemAccess, "custom rules precede the memory directive");
  });

  it("expands import + rule content and removes every @-line from the body", () => {
    const ws = fullFixture();
    const bundle = buildBundle(ws);

    assert.ok(bundle.includes("IMPORTED_BODY_TOKEN"), "import.md content is inlined");
    assert.ok(bundle.includes("MEMORY_INDEX_TOKEN"), "MEMORY.md content is inlined");
    assert.ok(bundle.includes("PLATFORM_RULE_TOKEN"));
    assert.ok(bundle.includes("CUSTOM_RULE_TOKEN"));
    assert.ok(bundle.includes("TRAILING_BODY_TOKEN"), "body after the @-lines is preserved");

    // The @-import lines themselves are stripped from the body (only the expanded
    // `## <relpath>` section headers carry the path).
    assert.ok(!/^[ \t]*@import\.md[ \t]*$/m.test(bundle), "@import.md line removed");
    assert.ok(!/^[ \t]*@MEMORY\.md[ \t]*$/m.test(bundle), "@MEMORY.md line removed");
  });

  it("includes the fixed memory-access directive verbatim", () => {
    const ws = fullFixture();
    const bundle = buildBundle(ws);
    assert.ok(bundle.includes(`## Memory access\n\n${MEMORY_DIRECTIVE}`));
  });
});

describe("expandImports", () => {
  it("extracts @-lines in order, reads them relative to baseDir, and strips them from the body", () => {
    const ws = makeWorkspace({
      files: { "a.md": "AAA", "sub/b.md": "BBB" },
    });
    const body = ["top", "@a.md", "@sub/b.md", "bottom"].join("\n");
    const { bodyWithoutImports, sections } = expandImports(body, ws);

    assert.strictEqual(bodyWithoutImports, "top\nbottom");
    assert.deepStrictEqual(sections, [
      { relpath: "a.md", content: "AAA" },
      { relpath: "sub/b.md", content: "BBB" },
    ]);
  });

  it("warns and skips a missing import (never throws)", () => {
    const ws = makeWorkspace({ files: { "present.md": "HERE" } });
    const { value: result, warnings } = captureWarn(() =>
      expandImports("@missing.md\n@present.md", ws),
    );

    assert.deepStrictEqual(result.sections, [{ relpath: "present.md", content: "HERE" }]);
    assert.ok(warnings.some((m) => m.includes("missing.md")), "warned about the missing import");
  });

  it("warns (does not recurse) when an imported file itself contains an @-line", () => {
    const ws = makeWorkspace({ files: { "nested.md": "before\n@deeper.md\nafter" } });
    const { value, warnings } = captureWarn(() => expandImports("@nested.md", ws));
    const { sections } = value;

    // The nested @-line is left as literal text, not expanded (1-level policy).
    assert.strictEqual(sections.length, 1);
    assert.ok(sections[0].content.includes("@deeper.md"));
    assert.ok(warnings.some((m) => m.includes("nested.md") && m.includes("1-level")));
  });

  it("does not treat inline @ tokens (e.g. user@host) as imports", () => {
    const { bodyWithoutImports, sections } = expandImports("email me at me@host.com please", "/tmp");
    assert.strictEqual(sections.length, 0);
    assert.strictEqual(bodyWithoutImports, "email me at me@host.com please");
  });
});

describe("collectRules", () => {
  it("returns platform rules then custom rules, each sorted by relpath", () => {
    const ws = makeWorkspace({
      files: {
        ".claude/rules/platform/b.md": "PB",
        ".claude/rules/platform/a.md": "PA",
        ".claude/rules/custom/z.md": "CZ",
      },
    });
    const rules = collectRules(ws);
    assert.deepStrictEqual(
      rules.map((r) => r.relpath),
      [
        ".claude/rules/platform/a.md",
        ".claude/rules/platform/b.md",
        ".claude/rules/custom/z.md",
      ],
    );
  });

  it("tolerates a missing rules dir (returns the rules that exist)", () => {
    const ws = makeWorkspace({ files: { ".claude/rules/platform/only.md": "ONLY" } });
    const rules = collectRules(ws);
    assert.deepStrictEqual(rules.map((r) => r.relpath), [".claude/rules/platform/only.md"]);
  });
});

describe("resolvePersona (D6)", () => {
  it("resolves the persona from the output-style referenced by settings.local.json", () => {
    const ws = fullFixture();
    const persona = resolvePersona(agentFor(ws));
    assert.strictEqual(persona, "PERSONA_TOKEN body");
  });

  it("appends the config systemPrompt AFTER the output-style content", () => {
    const ws = fullFixture();
    const persona = resolvePersona(agentFor(ws, { systemPrompt: "CONFIG_PROMPT" }));
    assert.strictEqual(persona, "PERSONA_TOKEN body\n\nCONFIG_PROMPT");
  });

  it("returns the config systemPrompt alone when there is no output-style", () => {
    const ws = makeWorkspace({ claudeMd: "# x" });
    assert.strictEqual(resolvePersona(agentFor(ws, { systemPrompt: "ONLY_CONFIG" })), "ONLY_CONFIG");
  });

  it("returns null when neither an output-style nor a config systemPrompt resolves", () => {
    const ws = makeWorkspace({ claudeMd: "# x" });
    assert.strictEqual(resolvePersona(agentFor(ws)), null);
  });

  it("returns null (no throw) when settings.local.json is not valid JSON", () => {
    const ws = makeWorkspace({ files: { ".claude/settings.local.json": "{not json" } });
    const { value: persona } = captureWarn(() => resolvePersona(agentFor(ws)));
    assert.strictEqual(persona, null);
  });
});

describe("writeTempArtifact", () => {
  it("writes atomically to the stable per-agent path and leaves no staging file", () => {
    const ws = makeWorkspace({ claudeMd: "# x" });
    const path = writeTempArtifact(ws, "agent-7", "bundle", "BUNDLE_CONTENT");

    assert.ok(path.endsWith(join(".tmp", "pi-context-agent-7.bundle.md")));
    assert.strictEqual(readFileSync(path, "utf8"), "BUNDLE_CONTENT");
    assert.throws(() => statSync(`${path}.tmp.${process.pid}`), "staging file is renamed away");
  });
});

describe("assemblePiContext", () => {
  it("writes the bundle + persona to .tmp/ and returns both paths", () => {
    const ws = fullFixture();
    const agent = agentFor(ws);
    const result = assemblePiContext(agent);

    assert.ok(result);
    assert.ok(result.appendSystemPromptPath.endsWith(join(".tmp", "pi-context-main.bundle.md")));
    assert.ok(result.systemPromptPath);
    assert.ok(result.systemPromptPath.endsWith(join(".tmp", "pi-context-main.persona.md")));

    const bundle = readFileSync(result.appendSystemPromptPath, "utf8");
    assert.ok(bundle.includes("PLATFORM_RULE_TOKEN") && bundle.includes("## Memory access"));
    assert.strictEqual(readFileSync(result.systemPromptPath, "utf8"), "PERSONA_TOKEN body");
  });

  it("omits the persona path when the agent has no output-style and no config systemPrompt", () => {
    const ws = makeWorkspace({
      claudeMd: "# x\n\nBODY",
      files: { ".claude/rules/platform/r.md": "RULE" },
    });
    const result = assemblePiContext(agentFor(ws));

    assert.ok(result);
    assert.strictEqual(result.systemPromptPath, undefined);
    assert.ok(result.appendSystemPromptPath);
  });

  it("fail-safe: a missing CLAUDE.md does not throw (rules-only bundle still assembles)", () => {
    const ws = makeWorkspace({ files: { ".claude/rules/platform/r.md": "RULE_ONLY" } });
    const { value: result } = captureWarn(() => assemblePiContext(agentFor(ws)));
    assert.ok(result);
    assert.ok(readFileSync(result.appendSystemPromptPath, "utf8").includes("RULE_ONLY"));
  });

  it("returns null (bare spawn) for an empty workspace — no CLAUDE.md, no rules, no persona", () => {
    const ws = makeWorkspace({});
    const { value } = captureWarn(() => assemblePiContext(agentFor(ws)));
    assert.strictEqual(value, null);
  });

  it("caches by the source manifest: a cache hit reuses artifacts; a touched source re-assembles", () => {
    _resetPiContextCache();
    const ws = makeWorkspace({
      claudeMd: "# x\n\nBODY",
      files: { ".claude/rules/platform/x.md": "RULE_AAA" },
    });
    const rulePath = join(ws, ".claude", "rules", "platform", "x.md");
    // Pin a known integer mtime so restoring it reproduces the SAME manifest
    // signature (avoids sub-millisecond mtime drift between writes).
    const pinned = new Date(1_700_000_000_000);
    utimesSync(rulePath, pinned, pinned);

    const agent = agentFor(ws, { id: "cacheagent" });
    const first = assemblePiContext(agent);
    assert.ok(first);
    assert.ok(readFileSync(first.appendSystemPromptPath, "utf8").includes("RULE_AAA"));

    // Mutate content to the SAME byte length and restore the pinned mtime →
    // identical manifest signature → cache hit → the stale bundle is returned
    // (proves no re-read).
    writeFileSync(rulePath, "RULE_BBB", "utf8");
    utimesSync(rulePath, pinned, pinned);
    const second = assemblePiContext(agent);
    assert.ok(second);
    const cachedBundle = readFileSync(second.appendSystemPromptPath, "utf8");
    assert.ok(cachedBundle.includes("RULE_AAA"), "cache hit reused the prior bundle (no re-read)");
    assert.ok(!cachedBundle.includes("RULE_BBB"));

    // Bump the mtime → signature changes → re-assemble → fresh content.
    const later = new Date(1_700_000_005_000);
    utimesSync(rulePath, later, later);
    const third = assemblePiContext(agent);
    assert.ok(third);
    assert.ok(
      readFileSync(third.appendSystemPromptPath, "utf8").includes("RULE_BBB"),
      "a touched source re-assembles the bundle",
    );
  });
});
