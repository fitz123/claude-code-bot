/**
 * A1 — guardian + protect-files write guard (pure, testable core).
 *
 * Ports the workspace's file-write protection (the `protect-files.sh` +
 * `guardian.sh` PreToolUse hooks, which only run for the CLAUDE path) into a
 * provider-agnostic classifier so a Pi (`openai-codex`) session is guarded the
 * same way. The thin Pi wrapper at
 * `bot/.claude/extensions/guardian-protect-files.ts` calls {@link classifyToolCall}
 * from a `tool_call` handler and returns `{ block, reason }` to Pi.
 *
 * Single source of truth: {@link PROTECTED_PREFIXES} pins the upstream-owned
 * paths that `protect-files.sh` / `bot-code-readonly.md` encode — the full
 * 10-path IMMUTABLE CORE (6 directory prefixes + 4 root-only files). This is the
 * deny-overlay of the schema-enforced write guard: it is checked FIRST and ALWAYS
 * blocks, even when the workspace allow-list would match. A pinned test
 * (`guard.test.ts`) locks the set so drift is caught.
 *
 * This re-implementation deliberately FIXES four bugs in the bash hooks:
 *  1. traversal — the hook resolves `..` with a fragile sed loop; here
 *     `node:path` canonicalizes `.`/`..`/`//` so `bot/../../etc/x` and
 *     `bot/../bot/x` both classify correctly.
 *  2. APFS case — macOS APFS is case-insensitive, but the hook's `case`
 *     matching is case-sensitive, so `BOT/x` slips through. Matching here is
 *     case-insensitive.
 *  3. bash-redirect coverage — the hooks only inspect `tool_input.file_path`
 *     (write/edit) and never parse bash, so `echo x > bot/y`, `tee`, `mv`, `cp`
 *     into a protected path are unguarded. {@link extractBashWriteTargets}
 *     parses the command for write targets.
 *  4. fail-open — when the project root is unknown the hook strips a leading `/`
 *     and relies on literal patterns, silently bypassing the prefix match. Here
 *     an unknown root FAILS CLOSED (blocks).
 */

import { basename, isAbsolute, normalize, relative, resolve } from "node:path";

/**
 * Upstream-owned paths (relative to the workspace root) a guarded session may NOT
 * write into — the IMMUTABLE CORE / deny-overlay of the schema-enforced write
 * guard. Two entry kinds, distinguished by the trailing slash:
 *   - Directory prefix (trailing slash, e.g. `bot/`): matches the bare directory
 *     name itself OR anything under it.
 *   - Root-only file (no slash, e.g. `README.md`): matches that EXACT root-level
 *     path only — `README.md` blocks the root file but NOT `docs/README.md`.
 * Matching is case-insensitive (APFS).
 *
 * This is the full 10-path set `protect-files.sh` / `bot-code-readonly.md` encode
 * (no longer a narrowed 4). PINNED by `guard.test.ts`. To change: edit the
 * upstream rule (`bot-code-readonly.md` / `protect-files.sh`) and this list
 * together — they are the doc and its enforcement.
 */
export const PROTECTED_PREFIXES = [
  "bot/",
  ".claude/hooks/",
  ".claude/rules/platform/",
  ".claude/skills/workspace-health/scripts/",
  ".github/workflows/",
  ".githooks/",
  ".gitleaks.toml",
  ".gitleaksignore",
  "README.md",
  "config.local.yaml.example",
] as const;

/** Built-in Pi tools that write a single file at `input.path`. */
const WRITE_FILE_TOOLS = new Set(["write", "edit"]);

/**
 * Command wrappers skipped when locating the real command word in a bash
 * segment, so `sudo tee bot/x` / `nohup cp evil bot/x` are still classified by
 * the wrapped command. (`\cp` is neutralized earlier — the lexer strips the
 * leading backslash.)
 */
const WRAPPER_CMDS = new Set([
  "sudo",
  "command",
  "nohup",
  "time",
  "env",
  "builtin",
  "exec",
  "xargs",
]);

export interface ToolCallLike {
  /** Pi tool name: `write`, `edit`, `bash`, `read`, `grep`, … or a custom name. */
  toolName: string;
  /** Raw tool input object (`{path,...}` for write/edit, `{command}` for bash). */
  input: Record<string, unknown> | undefined;
}

export interface ClassifyOptions {
  /**
   * Absolute workspace root the protected-prefix check is anchored at — the
   * IMMUTABLE top of the protected tree. For a top-level Pi session this is the
   * `ctx.cwd`; for a subagent child spawned with a caller-supplied `cwd` it is the
   * PARENT workspace root (so the child cannot move the guard root). See
   * {@link resolveRoot}.
   */
  workspaceRoot: string | undefined;
  /**
   * Working dir RELATIVE targets resolve against (the process's real `ctx.cwd`).
   * Defaults to {@link workspaceRoot} when absent, collapsing to the original
   * single-root behavior. It diverges from `workspaceRoot` ONLY for a subagent
   * child whose `cwd` was overridden: protection stays pinned to the parent
   * workspace while a genuine relative write resolves where it actually lands, so
   * an absolute write back into a protected dir is still caught and a legitimate
   * relative write under the child's own cwd is not over-blocked.
   */
  resolveRoot?: string;
  /**
   * Guardian orphan-allowlist patterns — the merged `orphan-allowlist.txt` +
   * `orphan-allowlist.local.txt` root-level names/globs. When provided, a
   * `write` that CREATES a new root-level entry whose first path segment matches
   * NONE of these is blocked (the "workspace-structure rule" of criterion 2,
   * ported from `guardian.sh`). `undefined` → the orphan check is disabled (the
   * pure classifier never reads the filesystem itself; the wrapper injects this).
   */
  orphanAllowlist?: readonly string[];
  /**
   * Schema-driven write allow-list — the lines of `schema.md`'s
   * ```` ```write-allowlist ```` fenced block (comments/blanks already stripped
   * by the wrapper). When PRESENT (defined, even if empty), the guard switches to
   * DENY-BY-DEFAULT: after the immutable-core deny, a write/edit/bash target is
   * ALLOWED only if its workspace-relative path matches an allow line; otherwise
   * it is BLOCKED with an actionable message naming `schema.md`. An EMPTY array
   * means the `schema.md` block is missing/empty/unparseable → the allow-check
   * fails CLOSED (the immutable core still blocks; everything else is denied).
   * `undefined` → deny-by-default is OFF and the legacy {@link orphanAllowlist}
   * model (if injected) is in force instead. The wrapper injects exactly ONE
   * model per session — never both. See {@link isAllowedPath}.
   */
  writeAllowlist?: readonly string[];
  /**
   * Existence probe for overwrite detection (the wrapper passes `fs.existsSync`).
   * An EXISTING target is an overwrite, never a new root-level entry, so it is
   * exempt from the orphan check (guardian.sh parity). Default: nothing exists.
   */
  fileExists?: (absPath: string) => boolean;
}

export interface GuardDecision {
  block: boolean;
  reason?: string;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Is `relPath` (a workspace-root-relative POSIX path) covered by the immutable
 * {@link PROTECTED_PREFIXES}? Two entry kinds:
 *   - trailing-slash directory entry → prefix match (also matches the bare
 *     directory name, e.g. `bot` as well as `bot/x`).
 *   - no-slash file entry → ROOT-ONLY EXACT match (`README.md` blocks the root
 *     file but NOT `docs/README.md`; a file entry never prefix-matches).
 * Case-insensitive (APFS bug fix).
 */
export function isProtectedPath(relPath: string): boolean {
  const lc = toPosix(relPath).replace(/^\.\//, "").toLowerCase();
  return PROTECTED_PREFIXES.some((entry) => {
    const e = entry.toLowerCase();
    if (e.endsWith("/")) {
      const base = e.slice(0, -1); // strip trailing slash → bare dir name
      return lc === base || lc.startsWith(e);
    }
    // No-slash file entry: ROOT-ONLY EXACT (no prefix match).
    return lc === e;
  });
}

/** Compile a simple shell glob (`*`, `?`, literals) to an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex metachars (NOT * or ?)
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Does a write's root path component match the guardian orphan allowlist?
 * Mirrors `guardian.sh`'s exact-or-glob `case` match; case-insensitive for APFS
 * parity with the rest of this module (the allowlist patterns are lowercase).
 */
export function isAllowedRootComponent(rootComponent: string, allowlist: readonly string[]): boolean {
  const rc = rootComponent.toLowerCase();
  return allowlist.some((raw) => {
    const pat = raw.trim().toLowerCase();
    if (!pat) {
      return false;
    }
    if (!pat.includes("*") && !pat.includes("?")) {
      return rc === pat;
    }
    return globToRegExp(pat).test(rc);
  });
}

/**
 * Does `relPath` (a workspace-root-relative POSIX path) match an entry in the
 * schema-driven write allow-list? Implements the three D17 line kinds, all
 * case-insensitively (APFS parity with the rest of this module):
 *   - **Directory prefix** (trailing slash, e.g. `memory/`): matches the bare
 *     directory name itself OR anything under it (`memory` and `memory/x.md`).
 *   - **Root-only glob** (a bare glob with `*`/`?`, e.g. `*.md`): matches a
 *     ROOT-LEVEL file only — `relPath` has no `/` AND the glob matches it.
 *   - **Exact root-file** (no slash, no glob, e.g. `MEMORY.md`): matches that
 *     exact relative path only.
 * Reuses {@link globToRegExp} for the root-only-glob kind. Deliberately does NOT
 * reuse {@link isAllowedRootComponent} — that matches the FIRST path component
 * only, which is the wrong granularity here (this check is full-relative-path).
 */
export function isAllowedPath(relPath: string, writeAllowlist: readonly string[]): boolean {
  const lc = toPosix(relPath).replace(/^\.\//, "").toLowerCase();
  return writeAllowlist.some((raw) => {
    const pat = raw.trim().toLowerCase();
    if (!pat) {
      return false;
    }
    if (pat.endsWith("/")) {
      // Directory prefix: the bare dir name OR anything under it.
      const base = pat.slice(0, -1);
      return lc === base || lc.startsWith(pat);
    }
    if (pat.includes("*") || pat.includes("?")) {
      // Root-only glob: a ROOT-LEVEL file only (no `/` in the relative path).
      return !lc.includes("/") && globToRegExp(pat).test(lc);
    }
    // Exact root-file: that exact relative path only (never a prefix match).
    return lc === pat;
  });
}

/**
 * Suggest the `schema.md` allow-list line that would unblock `relPath`: the
 * first directory component as a directory-prefix line when the path is nested
 * (`docs/x.md` → `docs/`), or the exact path for a root-level file (`notes.md` →
 * `notes.md`). Used to make the deny-by-default block message actionable.
 */
function suggestAllowLine(relPath: string): string {
  const slash = relPath.indexOf("/");
  return slash === -1 ? relPath : relPath.slice(0, slash + 1);
}

interface CollectedTargets {
  tool: string;
  /** Raw write-target path strings this tool call would modify. */
  targets: string[];
  /** True for write/edit (a missing path is anomalous → fail closed). */
  needsPath: boolean;
}

function collectTargets(call: ToolCallLike): CollectedTargets {
  const tool = call.toolName;
  const input = call.input ?? {};

  if (WRITE_FILE_TOOLS.has(tool)) {
    const p = input.path;
    return { tool, targets: typeof p === "string" ? [p] : [], needsPath: true };
  }

  if (tool === "bash") {
    const cmd = input.command;
    return {
      tool,
      targets: typeof cmd === "string" ? extractBashWriteTargets(cmd) : [],
      needsPath: false,
    };
  }

  // read / grep / find / ls / custom tools do not write a file → nothing to guard.
  return { tool, targets: [], needsPath: false };
}

/**
 * Classify one target path (relative or absolute) against the workspace root.
 * Returns a block decision for protected prefixes (immutable core), for traversal
 * escapes, for schema deny-by-default allow-list misses (when a `writeAllowlist`
 * is injected — the new model), and (for `write`, legacy model) for guardian
 * orphan-allowlist violations; allows everything else (incl. absolute paths that
 * simply live outside the workspace, matching the legacy hook's within-workspace
 * scope). Precedence: immutable-core deny > schema allow > default-deny.
 *
 * `workspaceRoot` anchors the protected-prefix/orphan check (the IMMUTABLE top of
 * the protected tree); `resolveRoot` is the cwd RELATIVE targets resolve against.
 * They are identical for a top-level session and for a default child — only a
 * subagent child with an overridden `cwd` separates them (see {@link ClassifyOptions}).
 */
function classifyTargetPath(
  rawTarget: string,
  workspaceRoot: string,
  resolveRoot: string,
  tool: string,
  opts: ClassifyOptions,
): GuardDecision {
  const raw = rawTarget.trim();
  if (!raw) {
    return { block: false };
  }

  // node:path.resolve/normalize canonicalize `.`, `..`, `//` — the traversal
  // bug fix. A RELATIVE target resolves against the real working dir
  // (`resolveRoot`), so its absolute location is exactly where the OS would write
  // it; an absolute target is normalized as-is (so `<ws>/bot/../bot/x` collapses
  // back into `bot/`).
  const abs = normalize(isAbsolute(raw) ? raw : resolve(resolveRoot, raw));
  // Containment is decided CASE-INSENSITIVELY (APFS). Folding BOTH sides before
  // `relative()` is essential: without it, an absolute target that case-varies
  // the workspace-root prefix (e.g. `/users/...` for the real `/Users/...`)
  // yields a `..`-escape relative path and is wrongly allowed below — even
  // though APFS resolves it to the SAME protected file. `isProtectedPath` folds
  // too, so the folded rel flows through consistently.
  //   - relProtect: position vs the IMMUTABLE protection root (prefix + orphan).
  //   - relResolve: position vs the real working dir (relative-traversal escape).
  // For a single root the two are identical → original behavior, byte for byte.
  const relProtect = toPosix(relative(normalize(workspaceRoot).toLowerCase(), abs.toLowerCase()));
  const relResolve = toPosix(relative(normalize(resolveRoot).toLowerCase(), abs.toLowerCase()));

  // Target IS the workspace root directory — cannot write a file there.
  if (relProtect === "") {
    return { block: false };
  }

  // A RELATIVE target that climbs above its OWN working dir is a
  // workspace-structure violation (traversal escape). An absolute target that
  // merely lives outside the workspace (e.g. /tmp/log) is allowed.
  const climbs = relResolve === ".." || relResolve.startsWith("../");
  if (climbs && !isAbsolute(raw)) {
    return {
      block: true,
      reason:
        `Blocked: ${tool} target "${rawTarget}" escapes the workspace via path ` +
        `traversal (workspace-structure violation).`,
    };
  }

  // Target lives OUTSIDE the protected workspace tree (an absolute path
  // elsewhere, or a relative path that resolved under a different working dir) —
  // nothing upstream-owned to protect there.
  const outsideWorkspace = relProtect === ".." || relProtect.startsWith("../");
  if (outsideWorkspace) {
    return { block: false };
  }

  if (isProtectedPath(relProtect)) {
    return {
      block: true,
      reason:
        `Blocked: ${tool} into upstream-owned path "${relProtect}" — these files ` +
        `come from upstream (see .claude/rules/platform/bot-code-readonly.md). ` +
        `Change it via a PR in the public repo, then merge upstream.`,
    };
  }

  // Schema-enforced DENY-BY-DEFAULT allow-check. This runs AFTER the immutable
  // core (deny-overlay > allow > default-deny) and is the NEW model, gated on a
  // provided `writeAllowlist`. When present, a write/edit/bash target is allowed
  // ONLY if its workspace-relative path matches an allow line (the three D17
  // kinds in `isAllowedPath`); otherwise it is BLOCKED. An EMPTY allow-list
  // (missing/empty/unparseable `schema.md` block) denies everything non-immutable
  // — the fail-CLOSED path (security never relaxes; never silently allow-all).
  // `undefined` → this model is OFF and the legacy orphan check below applies
  // instead (the wrapper injects exactly ONE model per session, never both).
  if (opts.writeAllowlist !== undefined) {
    if (isAllowedPath(relProtect, opts.writeAllowlist)) {
      return { block: false };
    }
    const reason =
      opts.writeAllowlist.length === 0
        ? `Blocked (deny-by-default, fail-closed): ${tool} target "${relProtect}" — the ` +
          `workspace write allow-list is empty or unreadable (schema.md is missing, or its ` +
          "```write-allowlist``` block is empty/unparseable). Add the block to schema.md and " +
          `register this path, notify the workspace owner, then retry. To bypass for one ` +
          `session set PI_EXTENSIONS_DISABLED=1.`
        : `Blocked (deny-by-default): ${tool} target "${relProtect}" is not in the workspace ` +
          "write allow-list. Add a line to schema.md's ```write-allowlist``` block (e.g. " +
          `"${suggestAllowLine(relProtect)}"), notify the workspace owner, then retry. To ` +
          `bypass for one session set PI_EXTENSIONS_DISABLED=1.`;
    return { block: true, reason };
  }

  // Guardian orphan check — the "workspace-structure rule" of criterion 2,
  // ported from `guardian.sh`: a `write` that CREATES a NEW root-level entry
  // whose first path segment is not in the orphan allowlist is blocked. Scope
  // matches guardian.sh exactly: the `write` tool only (Edit targets existing
  // content; bash redirects are out of guardian.sh's scope), and only when the
  // target does not already exist (an overwrite is not a new entry). Disabled
  // when no allowlist is injected (`isProtectedPath` already covers the
  // security-critical prefixes regardless).
  if (tool === "write" && opts.orphanAllowlist) {
    const rootComponent = relProtect.split("/")[0];
    const exists = opts.fileExists?.(abs) ?? false;
    if (!exists && !isAllowedRootComponent(rootComponent, opts.orphanAllowlist)) {
      return {
        block: true,
        reason:
          `Blocked: ${tool} would create a new root-level entry "${rootComponent}" ` +
          `not in the workspace orphan-allowlist (orphan-allowlist.txt / ` +
          `orphan-allowlist.local.txt). Add a pattern there, or write under an ` +
          `existing allowed directory.`,
      };
    }
  }

  return { block: false };
}

/**
 * Decide whether a Pi `tool_call` should be blocked.
 *
 *  - write/edit with no resolvable path → fail closed (defense-in-depth).
 *  - read-only / non-writing tools → allow.
 *  - unknown workspace root → fail CLOSED (cannot verify → block).
 *  - any target hitting a protected prefix or escaping the workspace → block.
 */
export function classifyToolCall(call: ToolCallLike, opts: ClassifyOptions): GuardDecision {
  const { tool, targets, needsPath } = collectTargets(call);

  if (needsPath && targets.length === 0) {
    return {
      block: true,
      reason: `Blocked: ${tool} called without a resolvable file path (fail-closed).`,
    };
  }

  if (targets.length === 0) {
    return { block: false };
  }

  const root = opts.workspaceRoot?.trim();
  if (!root) {
    return {
      block: true,
      reason:
        `Blocked: workspace root unknown — cannot verify ${tool} target(s) ` +
        `against protected paths (fail-closed).`,
    };
  }

  // Relative targets resolve against the real working dir; absent, that IS the
  // (immutable) protection root — collapsing to the original single-root guard.
  const resolveRoot = opts.resolveRoot?.trim() || root;

  for (const raw of targets) {
    const decision = classifyTargetPath(raw, root, resolveRoot, tool, opts);
    if (decision.block) {
      return decision;
    }
  }

  return { block: false };
}

// --- bash command parsing (best-effort, conservative) ---------------------

interface Tok {
  type: "word" | "op";
  value: string;
}

/**
 * Tokenize a shell command into words + operators, honoring single/double
 * quotes and backslash escapes. Quote/escape handling neutralizes the `\cp`
 * alias-bypass and unwraps quoted redirect targets (`> "bot/x"`). Best-effort:
 * command substitution and process substitution are not interpreted.
 */
function lexShell(command: string): Tok[] {
  const toks: Tok[] = [];
  let word = "";
  let hasWord = false;
  const n = command.length;

  const flush = (): void => {
    if (hasWord) {
      toks.push({ type: "word", value: word });
      word = "";
      hasWord = false;
    }
  };

  let i = 0;
  while (i < n) {
    const c = command[i];

    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      hasWord = true;
      if (end === -1) {
        word += command.slice(i + 1);
        break;
      }
      word += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      hasWord = true;
      while (j < n) {
        if (command[j] === "\\" && j + 1 < n) {
          word += command[j + 1];
          j += 2;
          continue;
        }
        if (command[j] === '"') {
          break;
        }
        word += command[j];
        j++;
      }
      i = j + 1;
      continue;
    }

    if (c === "\\") {
      if (i + 1 < n) {
        word += command[i + 1];
        hasWord = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (c === " " || c === "\t") {
      flush();
      i++;
      continue;
    }

    if (c === "\n" || c === "\r") {
      flush();
      toks.push({ type: "op", value: "\n" });
      i++;
      continue;
    }

    if (c === ">") {
      flush();
      if (command[i + 1] === ">") {
        toks.push({ type: "op", value: ">>" });
        i += 2;
      } else if (command[i + 1] === "|") {
        // `>|` is the clobber redirect (force-overwrite under `noclobber`) —
        // semantically a write redirect, so treat it the same as `>`.
        toks.push({ type: "op", value: ">" });
        i += 2;
      } else {
        toks.push({ type: "op", value: ">" });
        i++;
      }
      continue;
    }

    if (c === "<") {
      flush();
      toks.push({ type: "op", value: "<" });
      i++;
      continue;
    }

    if (c === "|") {
      flush();
      if (command[i + 1] === "|") {
        toks.push({ type: "op", value: "||" });
        i += 2;
      } else {
        toks.push({ type: "op", value: "|" });
        i++;
      }
      continue;
    }

    if (c === ";") {
      flush();
      toks.push({ type: "op", value: ";" });
      i++;
      continue;
    }

    if (c === "&") {
      flush();
      if (command[i + 1] === "&") {
        toks.push({ type: "op", value: "&&" });
        i += 2;
      } else {
        toks.push({ type: "op", value: "&" });
        i++;
      }
      continue;
    }

    word += c;
    hasWord = true;
    i++;
  }
  flush();
  return toks;
}

const SEGMENT_SEPARATORS = new Set(["|", "||", "&&", ";", "&", "\n"]);

/** Extract the write-target paths from a single pipeline segment's tokens. */
function analyzeSegment(toks: Tok[]): string[] {
  const targets: string[] = [];
  const isRedirectTarget: boolean[] = new Array(toks.length).fill(false);
  const isFdDesignator: boolean[] = new Array(toks.length).fill(false);

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== "op") {
      continue;
    }
    if (t.value === ">" || t.value === ">>" || t.value === "<") {
      // A word immediately preceding a redirect op is an fd designator (the `2`
      // in `2> err`), not a positional arg.
      if (toks[k - 1]?.type === "word") {
        isFdDesignator[k - 1] = true;
      }
      // The word after a WRITE redirect is a write target.
      if ((t.value === ">" || t.value === ">>") && toks[k + 1]?.type === "word") {
        isRedirectTarget[k + 1] = true;
        targets.push(toks[k + 1].value);
      }
    }
  }

  const positional: string[] = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].type === "word" && !isRedirectTarget[k] && !isFdDesignator[k]) {
      positional.push(toks[k].value);
    }
  }

  // Strip the command prefix to find the REAL command word. The prefix is any
  // interleaving of: leading `VAR=value` env assignments (also `env`'s own
  // VAR=val args), command wrappers (sudo/env/nohup/…), and the OPTIONS those
  // wrappers take (`sudo -n`, `env -i`, `time -p`). Skipping only wrapper NAMES
  // (the old two-loop form) left `env FOO=bar tee x` parsed as command `FOO=bar`
  // and `sudo -n tee x` as command `-n`, missing the `tee` write target.
  let ci = 0;
  for (;;) {
    if (ci >= positional.length) {
      break;
    }
    const w = positional[ci];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      ci++; // VAR=value assignment (leading, or an arg to a preceding `env`)
      continue;
    }
    if (WRAPPER_CMDS.has(basename(w))) {
      ci++; // a command wrapper (sudo / env / nohup / time / …)
      continue;
    }
    // A leading-dash word is a wrapper OPTION only once a wrapper/assignment has
    // already been consumed (ci > 0). At ci === 0 the real command sits there and
    // never starts with `-`, so a bare `tee -a x` keeps `tee` as the command.
    if (ci > 0 && w.startsWith("-")) {
      ci++;
      continue;
    }
    break; // first non-assignment / non-wrapper / non-option word = the command
  }

  const cmd = ci < positional.length ? basename(positional[ci]) : "";
  const rawArgs = positional.slice(ci + 1);
  const argWords = rawArgs.filter((v) => !v.startsWith("-"));

  if (cmd === "tee") {
    targets.push(...argWords); // tee writes every file argument
  } else if (cmd === "mv") {
    targets.push(...argWords); // mv: sources are deleted + dest created
  } else if (cmd === "cp") {
    // GNU `cp -t DIR` / `--target-directory=DIR` writes the sources INTO DIR, so
    // the real destination is DIR — not the last positional arg the POSIX form
    // uses. Honor the flag first so `cp -t bot a b` is caught.
    const targetDir = extractTargetDirFlag(rawArgs);
    if (targetDir !== undefined) {
      targets.push(targetDir);
    } else if (argWords.length > 0) {
      targets.push(argWords[argWords.length - 1]); // cp dest = last arg
    }
  }

  return targets;
}

/**
 * Extract the GNU coreutils target directory from a `cp` arg list:
 * `-t DIR`, `-tDIR`, `--target-directory[=DIR]`, and clustered short forms where
 * `t` is bundled with other flags (`-vt DIR`, `-vtDIR`). In a short-flag cluster
 * the `t` option consumes the rest of the cluster as its argument, or the next
 * separate arg when it is the last letter — so `-vt bot a b` writes into `bot`,
 * not `b`. Returns undefined when the flag is absent (POSIX `cp src dest` form).
 */
function extractTargetDirFlag(args: string[]): string | undefined {
  for (let a = 0; a < args.length; a++) {
    const w = args[a];

    // Long form: --target-directory or --target-directory=DIR.
    if (w === "--target-directory") {
      const next = args[a + 1];
      if (next !== undefined && !next.startsWith("-")) {
        return next;
      }
      continue;
    }
    if (w.startsWith("--target-directory=")) {
      return w.slice("--target-directory=".length);
    }

    // Short form: a single-dash cluster containing `t` (cp's only lowercase-`t`
    // option is --target-directory; `-T` is a different option and is ignored by
    // the case-sensitive search). `t` consumes the remainder of the cluster, or
    // the next separate non-flag arg when it is the cluster's last letter.
    if (w.startsWith("-") && !w.startsWith("--") && w.length > 1) {
      const ti = w.indexOf("t");
      if (ti >= 1) {
        const rest = w.slice(ti + 1);
        if (rest.length > 0) {
          return rest;
        }
        const next = args[a + 1];
        if (next !== undefined && !next.startsWith("-")) {
          return next;
        }
      }
    }
  }
  return undefined;
}

/**
 * Best-effort, conservative extraction of paths a bash command would write:
 * `>` / `>>` redirects, `tee` file args, `mv` (sources + dest), `cp` (dest).
 * Returns deduped, non-empty target strings. Defense-in-depth on top of the
 * solid write/edit guarantee — not a full shell parser.
 *
 * Bash-redirect asymmetry (D16 — by design for v1): this Pi-path coverage has NO
 * claude-path counterpart. `guardian.sh` inspects only `tool_input.file_path`
 * (the Write/Edit target) and never parses bash, so on the claude path a redirect
 * like `echo x > unregistered/y` is UNGUARDED. The Pi path runs the same
 * deny-by-default allow-check over these extracted targets (so the redirect IS
 * blocked here); closing the claude-path gap is a tracked, deliberately deferred
 * known-gap (see guardian.sh's D16 comment + the design plan).
 */
export function extractBashWriteTargets(command: string): string[] {
  const toks = lexShell(command);
  const targets: string[] = [];
  let segment: Tok[] = [];

  for (const t of toks) {
    if (t.type === "op" && SEGMENT_SEPARATORS.has(t.value)) {
      if (segment.length > 0) {
        targets.push(...analyzeSegment(segment));
      }
      segment = [];
    } else {
      segment.push(t);
    }
  }
  if (segment.length > 0) {
    targets.push(...analyzeSegment(segment));
  }

  return [...new Set(targets.map((s) => s.trim()).filter(Boolean))];
}
