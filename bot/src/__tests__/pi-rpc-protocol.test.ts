import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { _resetPiContextCache } from "../pi-context-assembler.js";
import {
  NewlineOnlyJsonlSplitter,
  PI_CRON_WRAPPER_RELPATHS,
  PI_EXTENSION_ARTIFACT_WRAPPER_RELPATHS,
  PI_EXTENSION_WRAPPER_RELPATHS,
  PI_SUBAGENT_CHILD_ARTIFACT_WRAPPER_RELPATHS,
  PI_SUBAGENT_CHILD_WRAPPER_RELPATHS,
  buildGetStateCommand,
  buildPiPromptCommand,
  buildPiSpawnArgs,
  buildPiSpawnEnv,
  buildPiSubagentChildSpawnEnv,
  buildPiSteerCommand,
  extractPiTextDelta,
  isPiAlreadyProcessingRejection,
  parsePiEvent,
  piExtensionRelpathForDir,
  readPiStream,
  resolvePiExtensionArgs,
  resolveValidatedPiAgentWorkspaceCwd,
  sendPiGetState,
  sendPiPrompt,
  sendPiSteer,
  spawnPiRpcSession,
  type PiExtensionResolveOptions,
} from "../pi-rpc-protocol.js";
import type { AgentConfig, StreamLine } from "../types.js";
import {
  MINIME_CONFIG_PATH_ENV,
  MINIME_CRONS_PATH_ENV,
  MINIME_WORKSPACE_ROOT_ENV,
} from "../workspace-contract.js";

const testAgent: AgentConfig = {
  id: "main",
  workspaceCwd: "/tmp/test-workspace",
  model: "gpt-5.5",
};

// Existing base-arg tests assert spawn-arg SHAPING (model/prompt/session) in
// isolation. Disable extension loading via the kill-switch so these assertions
// do not depend on whether the A1-A3 wrapper files happen to exist on disk —
// extension loading has its own dedicated block below.
const NO_EXTENSIONS: PiExtensionResolveOptions = {
  env: { PI_EXTENSIONS_DISABLED: "1" },
};

describe("NewlineOnlyJsonlSplitter", () => {
  it("does not split on U+2028 or U+2029 inside JSON strings", () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    const firstRecord = JSON.stringify({
      message: `before${lineSeparator}middle${paragraphSeparator}after`,
    });
    const secondRecord = JSON.stringify({ message: "done" });
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(
      splitter.push(Buffer.from(`${firstRecord}\n${secondRecord}\n`)),
      [firstRecord, secondRecord],
    );
  });

  it("accepts CRLF by stripping the trailing carriage return", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"ok\":true}\r\n")), [
      "{\"ok\":true}",
    ]);
  });

  it("does not split on a lone carriage return", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"a\":1}\r")), []);
    assert.deepStrictEqual(splitter.push(Buffer.from("{\"b\":2}\n")), [
      "{\"a\":1}\r{\"b\":2}",
    ]);
  });

  it("splits only on LF and reassembles partial chunks", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"text\":\"hel")), []);
    assert.deepStrictEqual(splitter.push(Buffer.from("lo\"}\n{\"n\"")), [
      "{\"text\":\"hello\"}",
    ]);
    assert.deepStrictEqual(splitter.push(Buffer.from(":2}\n")), [
      "{\"n\":2}",
    ]);
  });

  it("preserves multibyte characters split across chunks", () => {
    const splitter = new NewlineOnlyJsonlSplitter();
    const record = JSON.stringify({ text: String.fromCharCode(0x20ac) });
    const framed = Buffer.from(`${record}\n`);
    const splitAt = framed.indexOf(0xe2) + 1;

    assert.deepStrictEqual(splitter.push(framed.subarray(0, splitAt)), []);
    assert.deepStrictEqual(splitter.push(framed.subarray(splitAt)), [record]);
  });

  it("flushes an unterminated trailing record on end()", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"a\":1")), []);
    assert.deepStrictEqual(splitter.end(), ["{\"a\":1"]);
  });

  it("strips a trailing carriage return from the final record on end()", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    splitter.push(Buffer.from("{\"a\":1}\r"));
    assert.deepStrictEqual(splitter.end(), ["{\"a\":1}"]);
  });

  it("returns no records on end() when nothing is buffered", () => {
    const splitter = new NewlineOnlyJsonlSplitter();

    assert.deepStrictEqual(splitter.push(Buffer.from("{\"a\":1}\n")), [
      "{\"a\":1}",
    ]);
    assert.deepStrictEqual(splitter.end(), []);
  });
});

describe("buildPiSpawnArgs", () => {
  it("builds the Pi RPC OpenAI Codex command arguments", () => {
    assert.deepStrictEqual(buildPiSpawnArgs(testAgent, undefined, NO_EXTENSIONS), [
      "--mode", "rpc",
      "--provider", "openai-codex",
      "--model", "openai-codex/gpt-5.5",
      "--no-extensions",
    ]);
  });

  it("keeps an already-prefixed model", () => {
    const args = buildPiSpawnArgs({
      ...testAgent,
      model: "openai-codex/gpt-5.5",
    }, undefined, NO_EXTENSIONS);

    assert.strictEqual(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.5");
  });

  it("uses the default Pi model when the model is blank", () => {
    const args = buildPiSpawnArgs({ ...testAgent, model: " " }, undefined, NO_EXTENSIONS);

    assert.strictEqual(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.5");
  });

  it("includes Pi thinking when configured on a Pi agent", () => {
    const args = buildPiSpawnArgs({
      ...testAgent,
      provider: "pi",
      thinking: "xhigh",
    }, undefined, NO_EXTENSIONS);

    const idx = args.indexOf("--thinking");
    assert.notStrictEqual(idx, -1, "should include --thinking");
    assert.strictEqual(args[idx + 1], "xhigh");
  });

  it("includes thinking when configured on an absent-provider Pi agent", () => {
    const args = buildPiSpawnArgs({
      ...testAgent,
      thinking: "xhigh",
    }, undefined, NO_EXTENSIONS);

    const idx = args.indexOf("--thinking");
    assert.notStrictEqual(idx, -1, "should include --thinking");
    assert.strictEqual(args[idx + 1], "xhigh");
  });

  it("assembles context for an absent-provider Pi agent", () => {
    const args = buildPiSpawnArgs({
      ...testAgent,
      systemPrompt: "You are precise.",
    }, undefined, NO_EXTENSIONS);

    assert.ok(args.includes("--system-prompt"));
    assert.notStrictEqual(args[args.indexOf("--system-prompt") + 1], "You are precise.");
    assert.ok(args.includes("--append-system-prompt"));
    assert.ok(args.includes("--no-context-files"));
  });

  it("omits removed-runtime flags", () => {
    const args = buildPiSpawnArgs({
      ...testAgent,
      systemPrompt: "persona",
    }, undefined, NO_EXTENSIONS);

    assert.ok(!args.includes("--fallback-model"));
    assert.ok(!args.includes("--max-turns"));
    assert.ok(!args.includes("--effort"));
    assert.ok(!args.includes("--add-dir"));
  });

  it("appends --session with the resume session id when one is provided", () => {
    const args = buildPiSpawnArgs(testAgent, "pi-sess-resume", NO_EXTENSIONS);
    const idx = args.indexOf("--session");

    assert.notStrictEqual(idx, -1, "should include --session on resume");
    assert.strictEqual(args[idx + 1], "pi-sess-resume");
  });

  it("omits --session on a fresh start (no resume id, or a blank one)", () => {
    assert.ok(
      !buildPiSpawnArgs(testAgent, undefined, NO_EXTENSIONS).includes("--session"),
      "no arg => fresh start",
    );
    assert.ok(
      !buildPiSpawnArgs(testAgent, "", NO_EXTENSIONS).includes("--session"),
      "blank id => fresh start",
    );
  });
});

describe("buildPiSpawnArgs context assembly (provider: pi)", () => {
  const fixtures: string[] = [];

  after(() => {
    for (const dir of fixtures) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The assembler caches per agentId at module scope; reset between tests so a
  // prior fixture's manifest can never satisfy a later test's cache lookup.
  beforeEach(() => {
    _resetPiContextCache();
  });

  interface WorkspaceSpec {
    claudeMd?: string;
    files?: Record<string, string>;
  }

  /** Build a throwaway pi workspace from a spec and register it for cleanup. */
  function makePiWorkspace(spec: WorkspaceSpec): string {
    const ws = mkdtempSync(join(tmpdir(), "pi-spawn-ctx-"));
    fixtures.push(ws);
    if (spec.claudeMd !== undefined) {
      writeFileSync(join(ws, "CLAUDE.md"), spec.claudeMd, "utf8");
    }
    for (const [rel, content] of Object.entries(spec.files ?? {})) {
      const abs = join(ws, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
    return ws;
  }

  function piAgent(ws: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
    return { id: "pi", workspaceCwd: ws, model: "gpt-5.5", provider: "pi", ...overrides };
  }

  /** A realistic pi workspace: a CLAUDE.md body, one rule, an output-style persona. */
  function fullPiWorkspace(): string {
    return makePiWorkspace({
      claudeMd: "# Pi Agent\n\nBODY_TOKEN here.",
      files: {
        ".claude/rules/platform/x.md": "PLATFORM_RULE_TOKEN",
        ".claude/settings.local.json": JSON.stringify({ outputStyle: "persona-style" }),
        ".claude/output-styles/persona-style.md": "PERSONA_TOKEN body",
      },
    });
  }

  it("injects --system-prompt (persona), --append-system-prompt (bundle), and --no-context-files", () => {
    const ws = fullPiWorkspace();
    const args = buildPiSpawnArgs(piAgent(ws), undefined, NO_EXTENSIONS);

    const personaIdx = args.indexOf("--system-prompt");
    const bundleIdx = args.indexOf("--append-system-prompt");
    assert.notStrictEqual(personaIdx, -1, "persona delivered via --system-prompt");
    assert.notStrictEqual(bundleIdx, -1, "bundle delivered via --append-system-prompt");
    assert.ok(args.includes("--no-context-files"), "Pi must not double-load flat context");

    // The args carry FILE PATHS (not inline content), pointing at the stable
    // per-agent temp artifacts that exist on disk.
    const personaPath = args[personaIdx + 1];
    const bundlePath = args[bundleIdx + 1];
    assert.ok(personaPath.endsWith(join(".tmp", "pi-context-pi.persona.md")), personaPath);
    assert.ok(bundlePath.endsWith(join(".tmp", "pi-context-pi.bundle.md")), bundlePath);
    assert.ok(existsSync(personaPath) && existsSync(bundlePath), "artifacts written to disk");

    assert.strictEqual(readFileSync(personaPath, "utf8"), "PERSONA_TOKEN body");
    const bundle = readFileSync(bundlePath, "utf8");
    assert.ok(bundle.includes("PLATFORM_RULE_TOKEN") && bundle.includes("## Memory access"));
  });

  it("omits --system-prompt when the agent has no persona (rides Pi base), keeping the bundle + flag", () => {
    const ws = makePiWorkspace({
      claudeMd: "# Pi Agent\n\nBODY",
      files: { ".claude/rules/platform/r.md": "RULE" },
    });
    const args = buildPiSpawnArgs(piAgent(ws), undefined, NO_EXTENSIONS);

    assert.ok(!args.includes("--system-prompt"), "no persona => ride Pi's base prompt");
    assert.ok(args.includes("--append-system-prompt"), "bundle still delivered");
    assert.ok(args.includes("--no-context-files"));
  });

  it("emits at most ONE --system-prompt and ONE --append-system-prompt (legacy branch removed)", () => {
    // Both an output-style AND a config systemPrompt resolve. The persona must be
    // a single merged file (output-style then config prompt), NOT a second
    // --append-system-prompt arg from the deleted legacy branch.
    const ws = fullPiWorkspace();
    const args = buildPiSpawnArgs(piAgent(ws, { systemPrompt: "CONFIG_PROMPT" }), undefined, NO_EXTENSIONS);

    assert.strictEqual(args.filter((a) => a === "--system-prompt").length, 1);
    assert.strictEqual(args.filter((a) => a === "--append-system-prompt").length, 1);

    const personaPath = args[args.indexOf("--system-prompt") + 1];
    assert.strictEqual(readFileSync(personaPath, "utf8"), "PERSONA_TOKEN body\n\nCONFIG_PROMPT");
  });

  it("composes with --extension args: context args precede extensions; --session stays last", () => {
    const FAKE_DIR = "/fake/ext";
    const ws = fullPiWorkspace();
    const args = buildPiSpawnArgs(piAgent(ws), "pi-sess-resume", {
      extensionsDir: FAKE_DIR,
      env: {},
      exists: () => true,
    });

    const noContextIdx = args.indexOf("--no-context-files");
    const firstExtension = args.indexOf("--extension");
    const session = args.indexOf("--session");

    assert.notStrictEqual(noContextIdx, -1);
    assert.notStrictEqual(firstExtension, -1);
    assert.ok(noContextIdx < firstExtension, "context args must precede --extension args");
    assert.ok(firstExtension < session, "--extension args must precede --session");
    assert.strictEqual(args[session + 1], "pi-sess-resume");
    assert.strictEqual(args.filter((a) => a === "--extension").length, 2);
  });

  it("degrades to no context args for an empty pi workspace", () => {
    // No CLAUDE.md, no rules, no persona => assemblePiContext returns null =>
    // none of the context CLI layers are emitted. Extension auto-discovery is
    // still suppressed by the spawn builder's unconditional --no-extensions.
    const ws = makePiWorkspace({});
    const args = buildPiSpawnArgs(piAgent(ws), undefined, NO_EXTENSIONS);

    assert.ok(!args.includes("--system-prompt"));
    assert.ok(!args.includes("--append-system-prompt"));
    assert.ok(!args.includes("--no-context-files"));
    // The base command is intact.
    assert.deepStrictEqual(args, [
      "--mode", "rpc",
      "--provider", "openai-codex",
      "--model", "openai-codex/gpt-5.5",
      "--no-extensions",
    ]);
  });

  it("suppresses flat context loading when context artifact writes fail", () => {
    const ws = makePiWorkspace({ claudeMd: "# Pi Agent\n\nBODY" });
    writeFileSync(join(ws, ".tmp"), "i am a file, not a dir", "utf8");

    const args = buildPiSpawnArgs(piAgent(ws, { id: "writefail" }), undefined, NO_EXTENSIONS);

    assert.ok(!args.includes("--system-prompt"));
    assert.ok(!args.includes("--append-system-prompt"));
    assert.ok(args.includes("--no-context-files"));
  });

  it("suppresses flat context loading when CLAUDE.md is an escaping symlink", () => {
    const parent = mkdtempSync(join(tmpdir(), "pi-spawn-ctx-symlink-"));
    fixtures.push(parent);
    writeFileSync(join(parent, "CLAUDE.md"), "HOST_SECRET_TOKEN", "utf8");
    const ws = mkdtempSync(join(parent, "ws-"));
    symlinkSync(join(parent, "CLAUDE.md"), join(ws, "CLAUDE.md"));

    const args = buildPiSpawnArgs(piAgent(ws, { id: "escapesymlink" }), undefined, NO_EXTENSIONS);

    assert.ok(args.includes("--append-system-prompt"), "sanitized bundle still delivered");
    assert.ok(args.includes("--no-context-files"), "Pi must not flat-load the escaping symlink");
    const bundlePath = args[args.indexOf("--append-system-prompt") + 1];
    const bundle = readFileSync(bundlePath, "utf8");
    assert.ok(!bundle.includes("HOST_SECRET_TOKEN"), "outside-workspace target was not inlined");
  });
});

describe("Pi extension loading (--extension)", () => {
  const FAKE_DIR = "/fake/ext";
  // All three wrappers present, extensions enabled.
  const presentAll: PiExtensionResolveOptions = {
    extensionsDir: FAKE_DIR,
    env: {},
    exists: () => true,
  };
  const wrapperAbs = (rel: string): string => resolve(FAKE_DIR, rel);

  it("resolves a repeatable --extension arg (abs path) for each wrapper, in load order", () => {
    assert.deepStrictEqual(resolvePiExtensionArgs(presentAll), [
      "--extension", wrapperAbs("web-tools.ts"),
      "--extension", wrapperAbs("subagent/index.ts"),
    ]);
  });

  it("defaults the wrapper list to web-tools and subagent", () => {
    assert.deepStrictEqual(
      [...PI_EXTENSION_WRAPPER_RELPATHS],
      ["web-tools.ts", "subagent/index.ts"],
    );
    assert.deepStrictEqual(
      [...PI_EXTENSION_ARTIFACT_WRAPPER_RELPATHS],
      ["web-tools.js", "subagent/index.js"],
    );
  });

  it("post-retirement extension contract excludes guardian in parent, cron, and subagent child args", () => {
    const parentArgs = resolvePiExtensionArgs(presentAll);
    const subagentChildArgs = resolvePiExtensionArgs({
      ...presentAll,
      relpaths: PI_SUBAGENT_CHILD_WRAPPER_RELPATHS,
    });
    const cronArgs = resolvePiExtensionArgs({
      ...presentAll,
      relpaths: PI_CRON_WRAPPER_RELPATHS,
    });

    assert.deepStrictEqual(parentArgs, [
      "--extension", wrapperAbs("web-tools.ts"),
      "--extension", wrapperAbs("subagent/index.ts"),
    ]);
    assert.deepStrictEqual(subagentChildArgs, [
      "--extension", wrapperAbs("web-tools.ts"),
    ]);
    assert.deepStrictEqual(cronArgs, []);
    assert.doesNotMatch(
      JSON.stringify({ parentArgs, subagentChildArgs, cronArgs }),
      /guardian-protect-files/,
    );
  });

  it("the subagent-child wrapper subset is web-tools only, without subagent recursion", () => {
    assert.deepStrictEqual([...PI_SUBAGENT_CHILD_WRAPPER_RELPATHS], ["web-tools.ts"]);
    assert.deepStrictEqual([...PI_SUBAGENT_CHILD_ARTIFACT_WRAPPER_RELPATHS], ["web-tools.js"]);
  });

  it("the Pi cron wrapper subset is empty", () => {
    assert.deepStrictEqual([...PI_CRON_WRAPPER_RELPATHS], []);
  });

  it("resolves only the requested relpaths subset (subagent child loads web-tools only)", () => {
    const args = resolvePiExtensionArgs({ ...presentAll, relpaths: PI_SUBAGENT_CHILD_WRAPPER_RELPATHS });
    assert.deepStrictEqual(args, [
      "--extension", wrapperAbs("web-tools.ts"),
    ]);
  });

  it("resolves only the requested relpaths subset (Pi cron loads no wrappers)", () => {
    const args = resolvePiExtensionArgs({ ...presentAll, relpaths: PI_CRON_WRAPPER_RELPATHS });
    assert.deepStrictEqual(args, []);
  });

  it("maps source wrapper relpaths to built JS relpaths for package artifact dirs", () => {
    const artifactDir = resolve("/tmp/project/node_modules/minime/dist/extensions/pi");

    assert.equal(
      piExtensionRelpathForDir(artifactDir, "subagent/index.ts"),
      "subagent/index.js",
    );
    assert.equal(
      piExtensionRelpathForDir(`${artifactDir}/`, "web-tools.ts"),
      "web-tools.js",
    );
    assert.equal(piExtensionRelpathForDir(FAKE_DIR, "subagent/index.ts"), "subagent/index.ts");
  });

  it("resolves JS wrappers from a package artifact extension dir", () => {
    const artifactDir = resolve("/tmp/project/node_modules/minime/dist/extensions/pi");
    const args = resolvePiExtensionArgs({
      extensionsDir: artifactDir,
      env: {},
      exists: () => true,
    });

    assert.deepStrictEqual(args, [
      "--extension", resolve(artifactDir, "web-tools.js"),
      "--extension", resolve(artifactDir, "subagent/index.js"),
    ]);
  });

  it("the subset still honors the kill-switch (subagent child spawns bare when disabled)", () => {
    const args = resolvePiExtensionArgs({
      extensionsDir: FAKE_DIR,
      exists: () => true,
      env: { PI_EXTENSIONS_DISABLED: "1" },
      relpaths: PI_SUBAGENT_CHILD_WRAPPER_RELPATHS,
    });
    assert.deepStrictEqual(args, []);
  });

  it("the subset still fails CLOSED when the A2 web-tools wrapper is missing on disk", () => {
    const presentWithoutWeb = (p: string): boolean => !p.includes("web-tools.ts");
    assert.throws(
      () =>
        resolvePiExtensionArgs({
          extensionsDir: FAKE_DIR,
          env: {},
          exists: presentWithoutWeb,
          relpaths: PI_SUBAGENT_CHILD_WRAPPER_RELPATHS,
        }),
      /web-tools\.ts[\s\S]*Refusing to spawn without the expected first-party extensions/,
    );
  });

  it("buildPiSpawnArgs appends the resolved --extension paths after the model/prompt block", () => {
    const args = buildPiSpawnArgs(testAgent, undefined, presentAll);

    assert.ok(args.includes("--no-extensions"), "ambient Pi extension discovery is always suppressed");
    assert.strictEqual(args.filter((a) => a === "--extension").length, 2);
    assert.ok(args.includes(wrapperAbs("web-tools.ts")));
    assert.ok(args.includes(wrapperAbs("subagent/index.ts")));
    // Base args remain intact and precede the first --extension.
    assert.strictEqual(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.5");
    assert.ok(args.indexOf("--model") < args.indexOf("--extension"));
  });

  it("kill-switch PI_EXTENSIONS_DISABLED=1 omits explicit wrappers but still disables ambient discovery", () => {
    const args = buildPiSpawnArgs(testAgent, undefined, {
      extensionsDir: FAKE_DIR,
      exists: () => true,
      env: { PI_EXTENSIONS_DISABLED: "1" },
    });

    assert.ok(!args.includes("--extension"));
    assert.deepStrictEqual(args, [
      "--mode", "rpc",
      "--provider", "openai-codex",
      "--model", "openai-codex/gpt-5.5",
      "--no-extensions",
    ]);
  });

  it("treats any kill-switch value other than \"1\" as NOT disabled", () => {
    const args = resolvePiExtensionArgs({
      extensionsDir: FAKE_DIR,
      exists: () => true,
      env: { PI_EXTENSIONS_DISABLED: "0" },
    });
    assert.ok(args.includes("--extension"));
  });

  it("fails CLOSED (throws loudly) when a configured wrapper is missing on disk", () => {
    assert.throws(
      () => resolvePiExtensionArgs({ extensionsDir: FAKE_DIR, env: {}, exists: () => false }),
      /Pi extension wrapper not found[\s\S]*Refusing to spawn without the expected first-party extensions/,
    );
  });

  it("names the specific missing wrapper and points at the kill-switch bypass", () => {
    // Only the A3 subagent entrypoint is missing; the others are present.
    const present = (p: string): boolean => !p.includes("subagent");
    assert.throws(
      () => resolvePiExtensionArgs({ extensionsDir: FAKE_DIR, env: {}, exists: present }),
      /subagent\/index\.ts[\s\S]*PI_EXTENSIONS_DISABLED=1/,
    );
  });

  it("places all --extension paths before --session on resume", () => {
    const args = buildPiSpawnArgs(testAgent, "pi-sess-resume", presentAll);
    const lastExtension = args.lastIndexOf("--extension");
    const session = args.indexOf("--session");

    assert.notStrictEqual(lastExtension, -1);
    assert.notStrictEqual(session, -1);
    assert.ok(lastExtension < session, "--extension args must precede --session");
    assert.strictEqual(args[session + 1], "pi-sess-resume");
  });

  // End-to-end smoke (real disk, no mocks): the resolver's missing-wrapper contract
  // means resolvePiExtensionArgs() with NO overrides — real default dir
  // (bot/.claude/extensions) + real fs.existsSync — returns without throwing
  // only if all expected wrapper files exist where a live Pi spawn expects
  // them. This is the acceptance smoke that the mocked tests above cannot give:
  // it would catch a wrapper that was renamed, moved, or never copied.
  it("smoke: a real Pi spawn resolves the expected on-disk wrappers", () => {
    // Override only the env (drop any ambient kill-switch) so the default dir +
    // default existsSync run against the real repo layout.
    const args = resolvePiExtensionArgs({ env: {} });

    const flags = args.filter((a) => a === "--extension");
    assert.strictEqual(flags.length, 2, "expected one --extension per wrapper");

    const paths = args.filter((a) => a !== "--extension");
    assert.strictEqual(paths.length, 2);
    for (const p of paths) {
      assert.ok(p.startsWith("/"), `wrapper path must be absolute: ${p}`);
      assert.ok(existsSync(p), `resolved wrapper must exist on disk: ${p}`);
    }
    // Paths resolve to the canonical entrypoints, in load order.
    assert.deepStrictEqual(
      paths.map((p) => p.split("/.claude/extensions/")[1]),
      [...PI_EXTENSION_WRAPPER_RELPATHS],
    );
  });
});

describe("buildPiSpawnEnv", () => {
  beforeEach(() => {
    mkdirSync(testAgent.workspaceCwd, { recursive: true });
  });

  function withWorkspaceRoot<T>(workspaceRoot: string, fn: () => T): T {
    const oldWorkspace = process.env[MINIME_WORKSPACE_ROOT_ENV];
    try {
      process.env[MINIME_WORKSPACE_ROOT_ENV] = workspaceRoot;
      return fn();
    } finally {
      if (oldWorkspace === undefined) {
        delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_WORKSPACE_ROOT_ENV] = oldWorkspace;
      }
    }
  }

  it("allows only Pi runtime env and removes ambient credentials", () => {
    const envKeys = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "DISCORD_BOT_TOKEN",
      "GITHUB_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "LC_CTYPE",
      "LC_SECRET",
      "NPM_TOKEN",
      "OPENAI_API_KEY",
      "PI_CODING_AGENT_SESSION_DIR",
      "PI_RPC_TEST_MARKER",
      "SSH_AUTH_SOCK",
      "TAVILY_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "MINIME_SESSION_SECRET",
      "MINIME_SCHEMA_PATH",
      "PI_GUARD_WORKSPACE_ROOT",
      MINIME_CONFIG_PATH_ENV,
      MINIME_CRONS_PATH_ENV,
      MINIME_WORKSPACE_ROOT_ENV,
    ];
    const oldValues = new Map(envKeys.map((key) => [key, process.env[key]]));

    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "fixture";
      process.env.ANTHROPIC_API_KEY = "fixture";
      process.env.ANTHROPIC_OAUTH_TOKEN = "fixture";
      process.env.AWS_ACCESS_KEY_ID = "fixture";
      process.env.AWS_SECRET_ACCESS_KEY = "fixture";
      process.env.AWS_SESSION_TOKEN = "fixture";
      process.env.DISCORD_BOT_TOKEN = "fixture";
      process.env.GITHUB_TOKEN = "fixture";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/google-creds.json";
      process.env.LC_CTYPE = "UTF-8";
      process.env.LC_SECRET = "fixture";
      process.env.NPM_TOKEN = "fixture";
      process.env.OPENAI_API_KEY = "fixture";
      process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/pi-sessions";
      process.env.PI_RPC_TEST_MARKER = "keep";
      process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
      process.env.TAVILY_API_KEY = "fixture";
      process.env.TELEGRAM_BOT_TOKEN = "fixture";
      process.env.MINIME_SESSION_SECRET = "fixture";
      process.env.MINIME_SCHEMA_PATH = "/tmp/schema.md";
      process.env.PI_GUARD_WORKSPACE_ROOT = "/tmp/guard-root";
      process.env[MINIME_WORKSPACE_ROOT_ENV] = "/tmp";
      delete process.env[MINIME_CONFIG_PATH_ENV];
      delete process.env[MINIME_CRONS_PATH_ENV];

      const env = buildPiSpawnEnv();

      assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
      assert.strictEqual(env.DISCORD_BOT_TOKEN, undefined);
      assert.strictEqual(env.PI_CODING_AGENT_SESSION_DIR, "/tmp/pi-sessions");
      assert.strictEqual(env.PI_RPC_TEST_MARKER, undefined);
      assert.strictEqual(env.SSH_AUTH_SOCK, undefined);
      assert.strictEqual(env.TAVILY_API_KEY, undefined);
      assert.strictEqual(env.TELEGRAM_BOT_TOKEN, undefined);
      assert.strictEqual(env.MINIME_SESSION_SECRET, undefined);
      assert.strictEqual(env.MINIME_SCHEMA_PATH, undefined);
      assert.strictEqual(env.PI_GUARD_WORKSPACE_ROOT, undefined);
      assert.strictEqual(env[MINIME_WORKSPACE_ROOT_ENV], "/tmp");
      assert.strictEqual(env[MINIME_CONFIG_PATH_ENV], undefined);
      assert.strictEqual(env[MINIME_CRONS_PATH_ENV], undefined);
      assert.strictEqual(env.ANTHROPIC_OAUTH_TOKEN, undefined);
      assert.strictEqual(env.AWS_ACCESS_KEY_ID, undefined);
      assert.strictEqual(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.strictEqual(env.AWS_SESSION_TOKEN, undefined);
      assert.strictEqual(env.GITHUB_TOKEN, undefined);
      assert.strictEqual(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
      assert.strictEqual(env.LC_CTYPE, "UTF-8");
      assert.strictEqual(env.LC_SECRET, undefined);
      assert.strictEqual(env.NPM_TOKEN, undefined);
      assert.strictEqual(env.OPENAI_API_KEY, undefined);
    } finally {
      for (const key of envKeys) {
        const oldValue = oldValues.get(key);
        if (oldValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = oldValue;
        }
      }
    }
  });

  it("includes /opt/homebrew/bin in PATH", () => {
    const env = withWorkspaceRoot("/tmp", () => buildPiSpawnEnv());

    assert.ok(env.PATH?.includes("/opt/homebrew/bin"));
  });

  it("passes the non-secret control workspace contract to Pi children", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-spawn-env-control-contract-"));
    const oldWorkspace = process.env[MINIME_WORKSPACE_ROOT_ENV];
    const oldConfig = process.env[MINIME_CONFIG_PATH_ENV];
    const oldCrons = process.env[MINIME_CRONS_PATH_ENV];

    try {
      process.env[MINIME_WORKSPACE_ROOT_ENV] = workspaceRoot;
      process.env[MINIME_CONFIG_PATH_ENV] = "settings/bot.yaml";
      process.env[MINIME_CRONS_PATH_ENV] = "ops/crons.yaml";

      const env = buildPiSpawnEnv();

      assert.strictEqual(env[MINIME_WORKSPACE_ROOT_ENV], workspaceRoot);
      assert.strictEqual(env[MINIME_CONFIG_PATH_ENV], join(workspaceRoot, "settings", "bot.yaml"));
      assert.strictEqual(env[MINIME_CRONS_PATH_ENV], join(workspaceRoot, "ops", "crons.yaml"));
    } finally {
      if (oldWorkspace === undefined) {
        delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_WORKSPACE_ROOT_ENV] = oldWorkspace;
      }
      if (oldConfig === undefined) {
        delete process.env[MINIME_CONFIG_PATH_ENV];
      } else {
        process.env[MINIME_CONFIG_PATH_ENV] = oldConfig;
      }
      if (oldCrons === undefined) {
        delete process.env[MINIME_CRONS_PATH_ENV];
      } else {
        process.env[MINIME_CRONS_PATH_ENV] = oldCrons;
      }
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not double-prepend /opt/homebrew/bin when already present", () => {
    const oldPath = process.env.PATH;

    try {
      process.env.PATH = "/opt/homebrew/bin:/usr/bin";
      const env = withWorkspaceRoot("/tmp", () => buildPiSpawnEnv());

      assert.strictEqual(env.PATH, "/opt/homebrew/bin:/usr/bin");
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

  it("builds PATH without empty elements when inherited PATH is blank or has separators", () => {
    const oldPath = process.env.PATH;

    try {
      process.env.PATH = "";
      assert.strictEqual(withWorkspaceRoot("/tmp", () => buildPiSpawnEnv()).PATH, "/opt/homebrew/bin");

      process.env.PATH = ":/usr/bin::/bin:";
      assert.strictEqual(withWorkspaceRoot("/tmp", () => buildPiSpawnEnv()).PATH, "/opt/homebrew/bin:/usr/bin:/bin");
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

  it("scrubs the legacy CLAUDECODE session marker", () => {
    const oldMarker = process.env.CLAUDECODE;

    try {
      process.env.CLAUDECODE = "1";
      const env = withWorkspaceRoot("/tmp", () => buildPiSpawnEnv());

      assert.strictEqual(env.CLAUDECODE, undefined);
    } finally {
      if (oldMarker === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = oldMarker;
      }
    }
  });

  it("allows an absolute agent workspace outside the control workspace root", () => {
    const controlWorkspace = mkdtempSync(join(tmpdir(), "pi-spawn-env-control-"));

    try {
      const resolved = withWorkspaceRoot(controlWorkspace, () => resolveValidatedPiAgentWorkspaceCwd(testAgent));

      assert.strictEqual(resolved, testAgent.workspaceCwd);
    } finally {
      rmSync(controlWorkspace, { recursive: true, force: true });
    }
  });

  it("allows a symlinked agent workspace that resolves outside the control workspace root", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-spawn-env-root-"));
    const externalWorkspace = mkdtempSync(join(tmpdir(), "pi-spawn-env-external-"));
    const symlinkWorkspace = join(workspaceRoot, "agent-workspace");
    symlinkSync(externalWorkspace, symlinkWorkspace, "dir");

    try {
      const resolved = withWorkspaceRoot(
        workspaceRoot,
        () => resolveValidatedPiAgentWorkspaceCwd({ ...testAgent, workspaceCwd: symlinkWorkspace }),
      );

      assert.strictEqual(resolved, symlinkWorkspace);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(externalWorkspace, { recursive: true, force: true });
    }
  });

});

describe("spawnPiRpcSession workspace validation", () => {
  it("validates missing workspaceCwd before assembling context artifacts", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-spawn-root-"));
    const missingWorkspace = join(workspaceRoot, "missing-agent-workspace");
    const oldWorkspace = process.env[MINIME_WORKSPACE_ROOT_ENV];

    try {
      process.env[MINIME_WORKSPACE_ROOT_ENV] = workspaceRoot;

      assert.throws(
        () => spawnPiRpcSession({ ...testAgent, id: "missing", workspaceCwd: missingWorkspace }),
        /workspaceCwd does not exist/,
      );
      assert.ok(!existsSync(join(missingWorkspace, ".tmp")), "context artifacts must not be written before validation");
    } finally {
      if (oldWorkspace === undefined) {
        delete process.env[MINIME_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_WORKSPACE_ROOT_ENV] = oldWorkspace;
      }
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("buildPiSubagentChildSpawnEnv", () => {
  it("uses the same credential-scrubbed env as Pi spawns", () => {
    const envKeys = [
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "LC_CTYPE",
      "OPENAI_API_KEY",
      "PATH",
      "PI_CODING_AGENT_SESSION_DIR",
      "SSH_AUTH_SOCK",
      "TAVILY_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      MINIME_CONFIG_PATH_ENV,
      MINIME_CRONS_PATH_ENV,
      MINIME_WORKSPACE_ROOT_ENV,
    ];
    const oldValues = new Map(envKeys.map((key) => [key, process.env[key]]));

    try {
      process.env.ANTHROPIC_API_KEY = "fixture";
      process.env.GITHUB_TOKEN = "fixture";
      process.env.LC_CTYPE = "UTF-8";
      process.env.OPENAI_API_KEY = "fixture";
      process.env.PATH = "/usr/bin";
      process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/pi-sessions";
      process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
      process.env.TAVILY_API_KEY = "fixture";
      process.env.TELEGRAM_BOT_TOKEN = "fixture";
      process.env[MINIME_WORKSPACE_ROOT_ENV] = "/tmp";
      delete process.env[MINIME_CONFIG_PATH_ENV];
      delete process.env[MINIME_CRONS_PATH_ENV];

      const env = buildPiSubagentChildSpawnEnv();

      assert.strictEqual(env.PI_CODING_AGENT_SESSION_DIR, "/tmp/pi-sessions");
      assert.strictEqual(env.LC_CTYPE, "UTF-8");
      assert.strictEqual(env.PATH, "/opt/homebrew/bin:/usr/bin");
      assert.strictEqual(env[MINIME_WORKSPACE_ROOT_ENV], "/tmp");
      assert.strictEqual(env[MINIME_CONFIG_PATH_ENV], undefined);
      assert.strictEqual(env[MINIME_CRONS_PATH_ENV], undefined);
      assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
      assert.strictEqual(env.GITHUB_TOKEN, undefined);
      assert.strictEqual(env.OPENAI_API_KEY, undefined);
      assert.strictEqual(env.SSH_AUTH_SOCK, undefined);
      assert.strictEqual(env.TAVILY_API_KEY, undefined);
      assert.strictEqual(env.TELEGRAM_BOT_TOKEN, undefined);
    } finally {
      for (const key of envKeys) {
        const oldValue = oldValues.get(key);
        if (oldValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = oldValue;
        }
      }
    }
  });

  it("propagates explicit control config and crons path overrides", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-subagent-child-env-control-contract-"));
    const envKeys = [
      "DISCORD_BOT_TOKEN",
      "TAVILY_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      MINIME_CONFIG_PATH_ENV,
      MINIME_CRONS_PATH_ENV,
      MINIME_WORKSPACE_ROOT_ENV,
    ];
    const oldValues = new Map(envKeys.map((key) => [key, process.env[key]]));

    try {
      process.env.DISCORD_BOT_TOKEN = "fixture";
      process.env.TAVILY_API_KEY = "fixture";
      process.env.TELEGRAM_BOT_TOKEN = "fixture";
      process.env[MINIME_WORKSPACE_ROOT_ENV] = workspaceRoot;
      process.env[MINIME_CONFIG_PATH_ENV] = "settings/bot.yaml";
      process.env[MINIME_CRONS_PATH_ENV] = "ops/crons.yaml";

      const env = buildPiSubagentChildSpawnEnv();

      assert.strictEqual(env[MINIME_WORKSPACE_ROOT_ENV], workspaceRoot);
      assert.strictEqual(env[MINIME_CONFIG_PATH_ENV], join(workspaceRoot, "settings", "bot.yaml"));
      assert.strictEqual(env[MINIME_CRONS_PATH_ENV], join(workspaceRoot, "ops", "crons.yaml"));
      assert.strictEqual(env.DISCORD_BOT_TOKEN, undefined);
      assert.strictEqual(env.TAVILY_API_KEY, undefined);
      assert.strictEqual(env.TELEGRAM_BOT_TOKEN, undefined);
    } finally {
      for (const key of envKeys) {
        const oldValue = oldValues.get(key);
        if (oldValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = oldValue;
        }
      }
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("Pi RPC prompt and steer commands", () => {
  function createMockChild(overrides: Partial<Record<string, unknown>> = {}): ChildProcess {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    Object.assign(child, {
      stdin,
      pid: 1234,
      exitCode: null,
      killed: false,
      ...overrides,
    });
    return child;
  }

  it("builds prompt and steer command objects", () => {
    assert.deepStrictEqual(buildPiPromptCommand("hello"), {
      type: "prompt",
      message: "hello",
    });
    assert.deepStrictEqual(buildPiSteerCommand("stop"), {
      type: "steer",
      message: "stop",
    });
  });

  it("attaches streamingBehavior to a prompt command only when requested (Defect B)", () => {
    // followUp variant: the queue-driven send path delivers every Pi prompt with
    // followUp so a desynced bare prompt can never collide with a live turn.
    assert.deepStrictEqual(buildPiPromptCommand("hello", "followUp"), {
      type: "prompt",
      message: "hello",
      streamingBehavior: "followUp",
    });
    assert.deepStrictEqual(buildPiPromptCommand("hello", "steer"), {
      type: "prompt",
      message: "hello",
      streamingBehavior: "steer",
    });
    // Regression: a bare prompt (no behavior) keeps its historical shape exactly —
    // the field must be ABSENT, not `undefined`, so JSON framing is unchanged.
    const bare = buildPiPromptCommand("hello");
    assert.ok(!("streamingBehavior" in bare), "bare prompt must omit the field entirely");
  });

  it("builds a no-argument get_state command object", () => {
    assert.deepStrictEqual(buildGetStateCommand(), { type: "get_state" });
  });

  it("writes get_state commands to stdin", () => {
    const chunks: Buffer[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const child = createMockChild({ stdin });

    sendPiGetState(child);

    assert.deepStrictEqual(JSON.parse(Buffer.concat(chunks).toString().trim()), {
      type: "get_state",
    });
  });

  it("writes prompt commands to stdin", () => {
    const chunks: Buffer[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const child = createMockChild({ stdin });

    sendPiPrompt(child, "hello");

    assert.deepStrictEqual(JSON.parse(Buffer.concat(chunks).toString().trim()), {
      type: "prompt",
      message: "hello",
    });
  });

  it("writes a prompt command carrying streamingBehavior:followUp when asked (Defect B)", () => {
    const chunks: Buffer[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const child = createMockChild({ stdin });

    sendPiPrompt(child, "hello", "followUp");

    assert.deepStrictEqual(JSON.parse(Buffer.concat(chunks).toString().trim()), {
      type: "prompt",
      message: "hello",
      streamingBehavior: "followUp",
    });
  });

  it("writes steer commands to stdin", () => {
    const chunks: Buffer[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const child = createMockChild({ stdin });

    sendPiSteer(child, "focus");

    assert.deepStrictEqual(JSON.parse(Buffer.concat(chunks).toString().trim()), {
      type: "steer",
      message: "focus",
    });
  });

  it("throws when the child process is unavailable", () => {
    assert.throws(
      () => sendPiPrompt(createMockChild({ exitCode: 1 }), "hello"),
      /Pi RPC child process is not available/,
    );
  });
});

/**
 * Mirrors the exact `sawNonTextBlock` detection in stream-relay.ts (the consumer):
 * a stream_event whose `event.type === "content_block_start"` and whose
 * `content_block.type` is set and not "text" flips the flag.
 */
function flipsSawNonTextBlock(msg: StreamLine): boolean {
  if (msg.type !== "stream_event") {
    return false;
  }
  const ev = msg.event as Record<string, unknown>;
  if (ev.type !== "content_block_start") {
    return false;
  }
  const block = ev.content_block as Record<string, unknown> | undefined;
  return Boolean(block?.type && block.type !== "text");
}

describe("parsePiEvent", () => {
  it("translates a text_delta message_update into a streamable StreamEvent", () => {
    const line = parsePiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });

    assert.ok(line);
    assert.strictEqual(line.type, "stream_event");
    assert.strictEqual(extractPiTextDelta(line), "hello");
    assert.strictEqual(flipsSawNonTextBlock(line), false);
  });

  it("ignores non-text message_update deltas and the legacy text field", () => {
    assert.strictEqual(
      parsePiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
      }),
      null,
    );
    assert.strictEqual(
      parsePiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "" },
      }),
      null,
    );
    // The chunk lives in `delta`, not `text` — a `text` field must not stream.
    assert.strictEqual(
      parsePiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", text: "wrong field" },
      }),
      null,
    );
  });

  it("translates tool_execution_start so stream-relay flips sawNonTextBlock", () => {
    const line = parsePiEvent({
      type: "tool_execution_start",
      toolName: "bash",
    });

    assert.ok(line);
    assert.strictEqual(flipsSawNonTextBlock(line), true);
    // A tool block carries no streamable text.
    assert.strictEqual(extractPiTextDelta(line), null);
  });

  it("falls back to a generic tool name when none is provided", () => {
    const line = parsePiEvent({ type: "tool_execution_start" });

    assert.ok(line);
    assert.strictEqual(flipsSawNonTextBlock(line), true);
  });

  it("treats turn_end as a non-terminal per-turn boundary (returns null)", () => {
    // turn_end fires once per turn; only agent_end is terminal. Mapping turn_end
    // to a ResultMessage would truncate a multi-turn (tool-using) response at its
    // first turn, so turn_end must translate to null regardless of its content.
    assert.strictEqual(
      parsePiEvent({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "partial turn text" },
          ],
        },
      }),
      null,
    );
  });

  it("translates agent_end into a ResultMessage with the last assistant message text", () => {
    const line = parsePiEvent({
      type: "agent_end",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "first" }] },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "assistant", content: [{ type: "text", text: "final answer" }] },
      ],
    });

    assert.ok(line);
    assert.strictEqual(line.type, "result");
    assert.strictEqual((line as { result: string }).result, "final answer");
  });

  it("yields empty result text (not a crash) for an agent_end with no assistant text", () => {
    const line = parsePiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }] }],
    });

    assert.ok(line);
    assert.strictEqual((line as { result: string }).result, "");
    // agent_end here carries no top-level sessionId — that comes from get_state.
    assert.strictEqual((line as { session_id: string }).session_id, "");
  });

  it("multi-turn sequence (2x turn_end + 1x agent_end) terminates exactly once with the FINAL text", () => {
    // Verified live sequence: a tool-using response fires turn_end per turn, then
    // a single agent_end. Only agent_end is terminal, and it carries the final answer.
    const sequence = [
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "let me check" }] },
      },
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "still working" }] },
      },
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "do the thing" },
          { role: "assistant", content: [{ type: "text", text: "let me check" }] },
          { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
          { role: "assistant", content: [{ type: "text", text: "the final answer" }] },
        ],
      },
    ];

    const lines = sequence.map((e) => parsePiEvent(e));
    const terminals = lines.filter((l) => l?.type === "result");

    assert.strictEqual(terminals.length, 1);
    assert.strictEqual((terminals[0] as { result: string }).result, "the final answer");
    // The two turn_end boundaries do not terminate.
    assert.strictEqual(lines[0], null);
    assert.strictEqual(lines[1], null);
  });

  it("single-turn sequence (1x turn_end + 1x agent_end) terminates exactly once", () => {
    const sequence = [
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "quick answer" }] },
      },
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "quick answer" }] },
        ],
      },
    ];

    const lines = sequence.map((e) => parsePiEvent(e));
    const terminals = lines.filter((l) => l?.type === "result");

    assert.strictEqual(terminals.length, 1);
    assert.strictEqual((terminals[0] as { result: string }).result, "quick answer");
    assert.strictEqual(lines[0], null);
  });

  it("captures the Pi session id from a successful get_state response", () => {
    const line = parsePiEvent({
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "pi-sess-123", isStreaming: false },
    });

    assert.ok(line);
    assert.strictEqual(line.type, "system");
    const init = line as unknown as Record<string, unknown>;
    assert.strictEqual(init.subtype, "init");
    assert.strictEqual(init.session_id, "pi-sess-123");
  });

  it("ignores successful responses that carry no session id", () => {
    assert.strictEqual(parsePiEvent({ type: "response", command: "prompt", success: true }), null);
    assert.strictEqual(
      parsePiEvent({ type: "response", command: "get_state", success: true, data: { sessionId: "" } }),
      null,
    );
  });

  it("surfaces a failed prompt response (a REAL rejection) as a terminal error ResultMessage", () => {
    const line = parsePiEvent({
      type: "response",
      command: "prompt",
      success: false,
      error: "prompt rejected",
    });

    assert.ok(line);
    assert.strictEqual(line.type, "result");
    const result = line as unknown as Record<string, unknown>;
    assert.strictEqual(result.subtype, "error_during_execution");
    assert.strictEqual(result.result, "prompt rejected");
    assert.strictEqual(result.is_error, true);
  });

  it("does NOT terminate the turn on Pi's 'already processing' prompt rejection (Defect A)", () => {
    // A second, concurrent prompt collided with a turn that is STILL ALIVE. Pi's
    // concurrency guard rejects it, but the in-flight turn will still emit its own
    // agent_end. Mapping this to a terminal result would truncate the live answer
    // and relay Pi's internal error to the user — so it must be NON-terminal (null).
    assert.strictEqual(
      parsePiEvent({
        type: "response",
        command: "prompt",
        success: false,
        error:
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      }),
      null,
    );
  });

  it("detects the 'already processing' rejection defensively (case-insensitive substring, not exact match)", () => {
    // Reworded / recased vendor message still classifies as the recoverable
    // concurrency rejection — the detection is a normalized substring match, not
    // an exact-string equality check.
    assert.strictEqual(
      parsePiEvent({
        type: "response",
        command: "prompt",
        success: false,
        error: "Error: the agent is ALREADY PROCESSING a turn; pass streamingBehavior.",
      }),
      null,
    );
    assert.strictEqual(isPiAlreadyProcessingRejection("Agent is already processing."), true);
    assert.strictEqual(isPiAlreadyProcessingRejection("AGENT IS ALREADY PROCESSING"), true);
    // A different error that lacks the discriminating phrase is NOT a concurrency
    // rejection, even if it mentions the agent.
    assert.strictEqual(isPiAlreadyProcessingRejection("agent crashed"), false);
    assert.strictEqual(isPiAlreadyProcessingRejection("still processing the file"), false);
    // The match requires BOTH "already processing" AND "agent": the phrase alone,
    // without the "agent" subject, is deliberately NOT classified as recoverable
    // (guards against an unrelated error that merely contains the phrase).
    assert.strictEqual(isPiAlreadyProcessingRejection("already processing the request"), false);
    // Empty string is a string input that fails both substring checks.
    assert.strictEqual(isPiAlreadyProcessingRejection(""), false);
    assert.strictEqual(isPiAlreadyProcessingRejection(undefined), false);
    assert.strictEqual(isPiAlreadyProcessingRejection(null), false);
  });

  it("a DIFFERENT failed prompt error stays terminal even when a live turn is not the cause", () => {
    // Constraint: a genuinely failed prompt with a different error (real rejection,
    // no live turn) must STILL be terminal so the turn does not hang.
    const line = parsePiEvent({
      type: "response",
      command: "prompt",
      success: false,
      error: "Model refused the request",
    });

    assert.ok(line);
    assert.strictEqual(line.type, "result");
    const result = line as unknown as Record<string, unknown>;
    assert.strictEqual(result.subtype, "error_during_execution");
    assert.strictEqual(result.result, "Model refused the request");
    assert.strictEqual(result.is_error, true);
  });

  it("surfaces a failed prompt response with no error field as a terminal result with the default message", () => {
    // A failed `prompt` with no `error` field is NOT the "already processing"
    // rejection (the detector returns false for a missing string), so it stays
    // terminal — falling back to the default message rather than hanging.
    const line = parsePiEvent({ type: "response", command: "prompt", success: false });

    assert.ok(line);
    assert.strictEqual(line.type, "result");
    const result = line as unknown as Record<string, unknown>;
    assert.strictEqual(result.subtype, "error_during_execution");
    assert.strictEqual(result.result, "Pi RPC command failed");
    assert.strictEqual(result.is_error, true);
  });

  it("ignores a failed side-command response so it cannot truncate the active turn", () => {
    // A mid-turn `steer` rejection shares the active prompt turn's stdout.
    // Mapping it to a terminal result would end the in-flight response early, so
    // it must be ignored (returned null) rather than surfaced as a result.
    assert.strictEqual(
      parsePiEvent({ type: "response", command: "steer", success: false, error: "no active turn" }),
      null,
    );
    assert.strictEqual(
      parsePiEvent({ type: "response", command: "set_model", success: false, error: "Model not found" }),
      null,
    );
    // A failed response with no command field is also ignored (cannot correlate
    // it to the prompt; ignoring is safer than truncating an active turn).
    assert.strictEqual(
      parsePiEvent({ type: "response", success: false, error: "mystery failure" }),
      null,
    );
  });

  it("translates auto_retry_start into a rate_limit_event preserving the error message", () => {
    const line = parsePiEvent({
      type: "auto_retry_start",
      errorMessage: "429 Too Many Requests",
    });

    assert.ok(line);
    assert.strictEqual(line.type, "assistant");
    const rateLimit = line as unknown as Record<string, unknown>;
    assert.strictEqual(rateLimit.subtype, "rate_limit_event");
    assert.strictEqual(rateLimit.error_message, "429 Too Many Requests");
    // pi_event_type is the discriminator the dispatch layer uses to distinguish
    // start (counts a retry) from end (does not).
    assert.strictEqual(rateLimit.pi_event_type, "auto_retry_start");
  });

  it("translates auto_retry_end into a rate_limit_event tagged with its event type", () => {
    const line = parsePiEvent({
      type: "auto_retry_end",
      errorMessage: "recovered",
    });

    assert.ok(line);
    assert.strictEqual(line.type, "assistant");
    const rateLimit = line as unknown as Record<string, unknown>;
    assert.strictEqual(rateLimit.subtype, "rate_limit_event");
    assert.strictEqual(rateLimit.error_message, "recovered");
    assert.strictEqual(rateLimit.pi_event_type, "auto_retry_end");
  });

  it("defaults the rate_limit_event error message to an empty string when absent", () => {
    const line = parsePiEvent({ type: "auto_retry_start" });

    assert.ok(line);
    const rateLimit = line as unknown as Record<string, unknown>;
    assert.strictEqual(rateLimit.error_message, "");
  });

  it("translates an error event into an error ResultMessage", () => {
    const line = parsePiEvent({ type: "error", errorMessage: "boom" });

    assert.ok(line);
    assert.strictEqual(line.type, "result");
    const result = line as unknown as Record<string, unknown>;
    assert.strictEqual(result.subtype, "error_during_execution");
    assert.strictEqual(result.result, "boom");
    assert.strictEqual(result.is_error, true);
  });

  it("falls back to the message field, then a default, for error result text", () => {
    const fromMessage = parsePiEvent({ type: "error", message: "no errorMessage here" });
    assert.ok(fromMessage);
    assert.strictEqual((fromMessage as { result: string }).result, "no errorMessage here");

    const fromDefault = parsePiEvent({ type: "error" });
    assert.ok(fromDefault);
    assert.strictEqual((fromDefault as { result: string }).result, "Pi RPC error");
  });

  it("returns null for unknown and malformed events", () => {
    assert.strictEqual(parsePiEvent({ type: "tool_execution_update" }), null);
    assert.strictEqual(parsePiEvent({ type: "tool_execution_end" }), null);
    assert.strictEqual(parsePiEvent({}), null);
    assert.strictEqual(parsePiEvent(null), null);
    assert.strictEqual(parsePiEvent(undefined), null);
  });
});

describe("readPiStream", () => {
  function childWithStdout(records: string[]): ChildProcess {
    const child = new EventEmitter() as unknown as ChildProcess;
    const framed = records.map((r) => `${r}\n`).join("");
    Object.assign(child, { stdout: Readable.from([Buffer.from(framed)]) });
    return child;
  }

  it("yields only translated StreamLines, skipping unknown/malformed records", async () => {
    const child = childWithStdout([
      JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionId: "s1" } }),
      "not json",
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
      JSON.stringify({ type: "tool_execution_update" }),
      // A non-terminal turn_end is filtered out by the stream (returns null).
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "mid" }] },
      }),
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      }),
    ]);

    const lines: StreamLine[] = [];
    for await (const line of readPiStream(child)) {
      lines.push(line);
    }

    assert.deepStrictEqual(
      lines.map((l) => l.type),
      ["system", "stream_event", "result"],
    );
    assert.strictEqual(extractPiTextDelta(lines[1]), "hi");
    assert.strictEqual((lines[2] as { result: string }).result, "ok");
  });

  it("handles records split across stdout chunks", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const record = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "split" },
    });
    const framed = Buffer.from(`${record}\n`);
    const cut = Math.floor(framed.length / 2);
    Object.assign(child, {
      stdout: Readable.from([framed.subarray(0, cut), framed.subarray(cut)]),
    });

    const lines: StreamLine[] = [];
    for await (const line of readPiStream(child)) {
      lines.push(line);
    }

    assert.strictEqual(lines.length, 1);
    assert.strictEqual(extractPiTextDelta(lines[0]), "split");
  });

  it("throws when stdout is unavailable", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    await assert.rejects(readPiStream(child).next(), /stdout is not available/);
  });

  it("does not destroy stdout on early return, so a second consumer can resume (single-consumer handoff)", async () => {
    // Models the spawn-path get_state capture: read exactly the SystemInit
    // record, stop the generator, then open a FRESH readPiStream on the SAME
    // child for the first sendSessionMessage. The first generator must leave
    // child.stdout intact (destroyOnReturn:false) or the handoff breaks.
    const stdout = new Readable({ read() {} });
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { stdout });

    // First consumer: the get_state capture reads one SystemInit then stops.
    const first = readPiStream(child);
    stdout.push(
      JSON.stringify({
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "pi-handoff-1" },
      }) + "\n",
    );
    const r1 = await first.next();
    assert.strictEqual(r1.done, false);
    assert.strictEqual(r1.value.type, "system");
    assert.strictEqual((r1.value as { session_id: string }).session_id, "pi-handoff-1");
    await first.return(undefined);

    assert.strictEqual(stdout.destroyed, false, "early return must NOT destroy stdout");

    // Second consumer: a fresh readPiStream keeps reading the same stdout.
    const second = readPiStream(child);
    stdout.push(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "after handoff" },
      }) + "\n",
    );
    const r2 = await second.next();
    assert.strictEqual(r2.done, false);
    assert.strictEqual(extractPiTextDelta(r2.value), "after handoff");
    await second.return(undefined);
  });
});
