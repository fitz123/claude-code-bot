import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { AgentConfig } from "./types.js";
import { log } from "./logger.js";

/**
 * Spawn-time context assembler for the Pi (`pi --mode rpc`, OpenAI Codex) path.
 *
 * Pi reads context files as FLAT text — no `@`-import expansion, no
 * `.claude/rules/` auto-load, no memory recall (verified in
 * `@earendil-works/pi-coding-agent` resource-loader/system-prompt). Without help,
 * an agent's CLAUDE.md `@`-imports and rule files silently vanish under Pi. This
 * module assembles the SAME context a Claude Code session loads, from the agent's
 * LIVE workspace files (zero drift), and hands it to Pi via CLI args:
 *   --system-prompt          → the persona (REPLACES Pi's base prompt)
 *   --append-system-prompt   → the context bundle (APPENDED)
 *   --no-context-files       → so Pi does not ALSO load CLAUDE.md/AGENTS.md (no double context)
 *
 * Everything here is FAIL-SAFE: a missing/unreadable source is warned + skipped,
 * never thrown. A total failure returns null so the caller degrades to a bare Pi
 * spawn rather than crashing it. Wiring into the spawn path is in pi-rpc-protocol.ts.
 *
 * Deterministic bundle order (see {@link assembleBundle}):
 *   1. CLAUDE.md body with every `@<path>` line removed.
 *   2. Each removed `@`-import expanded as a `## <relpath>` section, in the order
 *      the `@`-lines appeared (read relative to the CLAUDE.md dir; 1 level only —
 *      a nested `@`-line in an imported file is NOT recursed, only warned).
 *   3. Every `.claude/rules/platform/*.md` as a `## <relpath>` section, sorted.
 *   4. Every `.claude/rules/custom/*.md` as a `## <relpath>` section, sorted.
 *   5. A fixed `## Memory access` directive (verbatim {@link MEMORY_ACCESS_DIRECTIVE}).
 */

/** Resolved artifact paths handed to the Pi spawn (paths, not inline content). */
export interface PiContextArtifacts {
  /** Persona file for `--system-prompt`. Omitted when the agent has no persona. */
  systemPromptPath?: string;
  /** Context-bundle file for `--append-system-prompt`. Always present on success. */
  appendSystemPromptPath: string;
}

/** A `## <relpath>` bundle section: a header + the file's content. */
export interface ContextSection {
  relpath: string;
  content: string;
}

export type PiArtifactKind = "bundle" | "persona";

/**
 * A standalone `@<path>` import line: optional leading whitespace, `@`, a single
 * non-whitespace path token, optional trailing whitespace, nothing else. This is
 * deliberately strict so an inline `user@host` or `@pkg/name` inside prose never
 * matches — only a line that IS an import (e.g. `@MEMORY.md`).
 */
const IMPORT_LINE = /^[ \t]*@(\S+)[ \t]*$/;

/**
 * The fixed `## Memory access` directive (verbatim). MEMORY.md itself reaches the
 * bundle as a `## MEMORY.md` section (it is a CLAUDE.md `@`-import) = the index;
 * the corpus under `memory/auto/*` is read ON DEMAND, not inlined. Auto-recall
 * like the Claude harness is not yet available under Pi (a tracked fast-follow).
 */
const MEMORY_ACCESS_DIRECTIVE =
  "MEMORY.md above is the index of long-term memory. When a topic matches an entry, use the read tool to load the specific `memory/auto/<name>.md` on demand. (Auto-recall like the Claude harness is not yet available under Pi — read deliberately by index; a memory_search tool is a tracked fast-follow.)";

/** Read a file, returning null on ANY error (fail-safe: missing/unreadable → skip). */
function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** List `*.md` files in a dir as absolute paths, sorted by name. Missing dir → []. */
function listMarkdown(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Single source of truth for parsing a body's `@`-import lines: returns the
 * non-import lines (in order) and the path tokens of every standalone `@<path>`
 * line (in order). Both expandImports (which expands them) and the manifest
 * signature (which stats them) use this, so the set of imports the cache tracks
 * can never drift from the set the bundle actually expands.
 */
function partitionImports(body: string): { keptLines: string[]; importRelpaths: string[] } {
  const keptLines: string[] = [];
  const importRelpaths: string[] = [];
  for (const line of body.split("\n")) {
    const match = IMPORT_LINE.exec(line);
    if (match) {
      importRelpaths.push(match[1]);
    } else {
      keptLines.push(line);
    }
  }
  return { keptLines, importRelpaths };
}

/** Render one `## <relpath>` section. Content is trimmed for stable spacing. */
function sectionMarkdown(relpath: string, content: string): string {
  return `## ${relpath}\n\n${content.trim()}`;
}

/**
 * Split a CLAUDE.md body into (a) the body with every `@<path>` line removed and
 * (b) the expanded import sections, in the order the `@`-lines appeared. Each
 * import is read RELATIVE to baseDir (the CLAUDE.md dir), 1 level only:
 *  - a missing/unreadable import file → warn + skip (no section, no throw);
 *  - an imported file that itself contains a `@`-line → warn naming it, but do
 *    NOT recurse (its `@`-line is left as literal text in its section).
 */
export function expandImports(
  body: string,
  baseDir: string,
): { bodyWithoutImports: string; sections: ContextSection[] } {
  const { keptLines, importRelpaths } = partitionImports(body);

  const sections: ContextSection[] = [];
  for (const relpath of importRelpaths) {
    const abs = resolve(baseDir, relpath);
    const content = safeReadFile(abs);
    if (content === null) {
      log.warn("pi-context", `@-import not readable, skipping: ${abs}`);
      continue;
    }
    if (content.split("\n").some((line) => IMPORT_LINE.test(line))) {
      // 1-level policy: do NOT recurse into a nested import. The nested `@`-line
      // stays as literal text in this section; only warn so the deeper import is
      // visible (no current agent has one — this catches a future regression).
      log.warn(
        "pi-context",
        `nested @-import inside "${relpath}" is NOT expanded (1-level policy)`,
      );
    }
    sections.push({ relpath, content });
  }

  return { bodyWithoutImports: keptLines.join("\n"), sections };
}

/**
 * Collect every rule file as a `## <relpath>` section: all
 * `.claude/rules/platform/*.md` (sorted by relpath) followed by all
 * `.claude/rules/custom/*.md` (sorted by relpath). A missing dir is tolerated
 * (returns no sections for it). Relpaths are workspace-relative POSIX paths.
 */
export function collectRules(workspaceCwd: string): ContextSection[] {
  const out: ContextSection[] = [];
  for (const sub of ["platform", "custom"] as const) {
    const dir = join(workspaceCwd, ".claude", "rules", sub);
    for (const abs of listMarkdown(dir)) {
      const content = safeReadFile(abs);
      if (content === null) {
        log.warn("pi-context", `rule file not readable, skipping: ${abs}`);
        continue;
      }
      out.push({ relpath: relative(workspaceCwd, abs), content });
    }
  }
  return out;
}

interface BundleResult {
  bundle: string;
  /**
   * True when at least one REAL source contributed (a CLAUDE.md body, an
   * expanded import, or a rule). False means the bundle is only the fixed memory
   * directive — there is nothing worth forcing `--no-context-files` for, so the
   * caller may prefer a bare spawn (let Pi load its own flat context).
   */
  hasContent: boolean;
}

/** Assemble the deterministic context bundle (order 1-5 above) from live files. */
function assembleBundle(workspaceCwd: string): BundleResult {
  const claudeMdPath = join(workspaceCwd, "CLAUDE.md");
  const rawBody = safeReadFile(claudeMdPath);
  if (rawBody === null) {
    log.warn("pi-context", `CLAUDE.md not found at ${claudeMdPath} — bundling rules only`);
  }

  const { bodyWithoutImports, sections } = expandImports(rawBody ?? "", dirname(claudeMdPath));
  const rules = collectRules(workspaceCwd);

  const parts: string[] = [];
  const trimmedBody = bodyWithoutImports.trim();
  if (trimmedBody) {
    parts.push(trimmedBody);
  }
  for (const section of sections) {
    parts.push(sectionMarkdown(section.relpath, section.content));
  }
  for (const rule of rules) {
    parts.push(sectionMarkdown(rule.relpath, rule.content));
  }
  parts.push(`## Memory access\n\n${MEMORY_ACCESS_DIRECTIVE}`);

  const hasContent = trimmedBody !== "" || sections.length > 0 || rules.length > 0;
  return { bundle: `${parts.join("\n\n")}\n`, hasContent };
}

/** Build the context bundle markdown string for a workspace (order 1-5 above). */
export function buildBundle(workspaceCwd: string): string {
  return assembleBundle(workspaceCwd).bundle;
}

/**
 * Resolve the agent's persona (the `--system-prompt` content), or null when none.
 *  - Read `<workspaceCwd>/.claude/settings.local.json` `outputStyle` →
 *    `<workspaceCwd>/.claude/output-styles/<outputStyle>.md`; that file is the persona.
 *  - If `agent.systemPrompt` (config) is also set, append it AFTER the output-style
 *    content (blank-line separated).
 *  - If neither resolves → null → the caller passes NO `--system-prompt` (ride Pi base).
 */
export function resolvePersona(agent: AgentConfig): string | null {
  const parts: string[] = [];

  const outputStyle = readOutputStyleContent(agent.workspaceCwd);
  if (outputStyle && outputStyle.trim()) {
    parts.push(outputStyle.trim());
  }
  if (agent.systemPrompt && agent.systemPrompt.trim()) {
    parts.push(agent.systemPrompt.trim());
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * An output-style slug must be a single path segment — Claude resolves output
 * styles by NAME, never by path. Reject any slug containing a path separator so a
 * settings.local.json value like `"../../../../etc/passwd"` cannot escape
 * `.claude/output-styles/` and pull an arbitrary file into the `--system-prompt`.
 */
function isSafeOutputStyleSlug(slug: string): boolean {
  return !slug.includes("/") && !slug.includes("\\");
}

/** Read the output-style markdown referenced by settings.local.json, or null. */
function readOutputStyleContent(workspaceCwd: string): string | null {
  const settingsPath = join(workspaceCwd, ".claude", "settings.local.json");
  const raw = safeReadFile(settingsPath);
  if (raw === null) {
    return null;
  }
  let slug: unknown;
  try {
    slug = (JSON.parse(raw) as { outputStyle?: unknown }).outputStyle;
  } catch {
    log.warn("pi-context", `settings.local.json is not valid JSON: ${settingsPath}`);
    return null;
  }
  if (typeof slug !== "string" || slug.trim() === "") {
    return null;
  }
  if (!isSafeOutputStyleSlug(slug)) {
    log.warn("pi-context", `output-style slug is not a bare filename, ignoring: "${slug}"`);
    return null;
  }
  const stylePath = join(workspaceCwd, ".claude", "output-styles", `${slug}.md`);
  const content = safeReadFile(stylePath);
  if (content === null) {
    log.warn("pi-context", `output-style "${slug}" not found at ${stylePath}`);
    return null;
  }
  return content;
}

/**
 * Atomically write a bundle/persona artifact to a STABLE per-agent path under
 * `<workspaceCwd>/.tmp/`: `pi-context-<agentId>.<kind>.md`. Write a staging file
 * (`<path>.tmp.<pid>`) then `renameSync` over the final path, so a concurrent
 * reader never sees a half-written file. Stable path ⇒ no accumulation, no cleanup
 * job. Returns the final path. May throw (e.g. unwritable `.tmp/`) — the caller
 * (assemblePiContext) wraps it in the fail-safe.
 */
export function writeTempArtifact(
  workspaceCwd: string,
  agentId: string,
  kind: PiArtifactKind,
  content: string,
): string {
  const tmpDir = join(workspaceCwd, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const finalPath = join(tmpDir, `pi-context-${agentId}.${kind}.md`);
  const stagingPath = `${finalPath}.tmp.${process.pid}`;
  writeFileSync(stagingPath, content, "utf8");
  renameSync(stagingPath, finalPath);
  return finalPath;
}

interface CacheEntry {
  signature: string;
  result: PiContextArtifacts;
}

/**
 * Per-agent cache of the last assembled artifacts, keyed on a manifest signature
 * of every source file's `{path, mtime, size}` (the OpenClaw `workspaceFileCache`
 * pattern). Repeat spawns with unchanged sources reuse the artifacts — no re-read,
 * no re-assemble, no re-write — while a touched source re-assembles (freshness
 * parity). Module-scoped: the process lives for the bot's lifetime.
 */
const cache = new Map<string, CacheEntry>();

/**
 * A manifest signature over every source file: CLAUDE.md, each `@`-import, every
 * platform + custom rule, settings.local.json, the resolved output-style file, and
 * the config-level systemPrompt. A missing file contributes a stable `missing`
 * marker, so adding/removing a source also changes the signature.
 */
function computeManifestSignature(agent: AgentConfig): string {
  const workspaceCwd = agent.workspaceCwd;
  const files: string[] = [];

  const claudeMdPath = join(workspaceCwd, "CLAUDE.md");
  files.push(claudeMdPath);
  const body = safeReadFile(claudeMdPath);
  if (body !== null) {
    for (const relpath of partitionImports(body).importRelpaths) {
      files.push(resolve(dirname(claudeMdPath), relpath));
    }
  }

  for (const sub of ["platform", "custom"] as const) {
    files.push(...listMarkdown(join(workspaceCwd, ".claude", "rules", sub)));
  }

  const settingsPath = join(workspaceCwd, ".claude", "settings.local.json");
  files.push(settingsPath);
  const settingsRaw = safeReadFile(settingsPath);
  if (settingsRaw !== null) {
    try {
      const slug = (JSON.parse(settingsRaw) as { outputStyle?: unknown }).outputStyle;
      if (typeof slug === "string" && slug.trim() !== "" && isSafeOutputStyleSlug(slug)) {
        files.push(join(workspaceCwd, ".claude", "output-styles", `${slug}.md`));
      }
    } catch {
      // Non-JSON settings yield no persona path; the settings file's own stat
      // (above) still invalidates the cache when its contents change.
    }
  }

  const parts = files.sort().map((path) => {
    try {
      const st = statSync(path);
      return `${path}:${st.mtimeMs}:${st.size}`;
    } catch {
      return `${path}:missing`;
    }
  });
  // The config systemPrompt is not a file — fold it in directly.
  parts.push(`systemPrompt:${agent.systemPrompt ?? ""}`);
  return parts.join("|");
}

/** True when every cached artifact path still exists on disk. */
function artifactsExist(result: PiContextArtifacts): boolean {
  if (!existsSync(result.appendSystemPromptPath)) {
    return false;
  }
  if (result.systemPromptPath !== undefined && !existsSync(result.systemPromptPath)) {
    return false;
  }
  return true;
}

/**
 * Assemble the full Pi context for an agent and return the artifact paths, or null
 * to signal "no extra context — bare spawn".
 *
 * Returns null when there is nothing meaningful to inject (no CLAUDE.md body, no
 * imports, no rules, AND no persona) or when assembly fails outright — either way
 * the caller spawns Pi without the context args rather than crashing the spawn.
 *
 * Caches by a source-file manifest: an unchanged source set returns the previously
 * written artifacts without re-reading/re-assembling/re-writing.
 */
export function assemblePiContext(agent: AgentConfig): PiContextArtifacts | null {
  try {
    const signature = computeManifestSignature(agent);
    const cached = cache.get(agent.id);
    if (cached && cached.signature === signature && artifactsExist(cached.result)) {
      return cached.result;
    }

    const { bundle, hasContent } = assembleBundle(agent.workspaceCwd);
    const persona = resolvePersona(agent);

    if (!hasContent && persona === null) {
      // Empty workspace — let Pi fall back to its own (flat) context loading
      // instead of forcing an empty bundle + --no-context-files.
      cache.delete(agent.id);
      return null;
    }

    const appendSystemPromptPath = writeTempArtifact(agent.workspaceCwd, agent.id, "bundle", bundle);
    let systemPromptPath: string | undefined;
    if (persona !== null) {
      systemPromptPath = writeTempArtifact(agent.workspaceCwd, agent.id, "persona", persona);
    }

    const result: PiContextArtifacts =
      systemPromptPath !== undefined
        ? { systemPromptPath, appendSystemPromptPath }
        : { appendSystemPromptPath };
    cache.set(agent.id, { signature, result });
    return result;
  } catch (err) {
    // Belt-and-suspenders: every file op above is already fail-safe, but a write
    // (e.g. an unwritable `.tmp/`) could still throw. Degrade to a bare spawn.
    log.error(
      "pi-context",
      `context assembly failed for agent "${agent.id}", falling back to a bare spawn: ${(err as Error).message}`,
    );
    cache.delete(agent.id);
    return null;
  }
}

/** Test-only: clear the per-agent manifest cache. */
export function _resetPiContextCache(): void {
  cache.clear();
}
