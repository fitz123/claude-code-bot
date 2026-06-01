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
 * path prefixes that `protect-files.sh` / `bot-code-readonly.md` encode. Per the
 * plan's "no policy engine" guidance this is the 4 highest-value upstream dirs,
 * NOT the full `protect-files.sh` enumeration; a pinned test (`guard.test.ts`)
 * locks the set so drift is caught.
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
 * Upstream-owned path prefixes (relative to the workspace root) a guarded Pi
 * session may NOT write into. Trailing slash = directory prefix. Matching is
 * case-insensitive (APFS) and also matches the bare directory name itself.
 *
 * PINNED by `guard.test.ts` against the canonical set. To change: edit the
 * upstream rule (`bot-code-readonly.md` / `protect-files.sh`) and this list
 * together — they are the doc and its enforcement.
 */
export const PROTECTED_PREFIXES = [
  "bot/",
  ".claude/rules/platform/",
  ".github/workflows/",
  ".githooks/",
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
  /** Absolute workspace root (typically the Pi `ctx.cwd`). */
  workspaceRoot: string | undefined;
}

export interface GuardDecision {
  block: boolean;
  reason?: string;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Is `relPath` (a workspace-root-relative POSIX path) inside one of the
 * {@link PROTECTED_PREFIXES}? Case-insensitive (APFS bug fix); also matches the
 * bare directory name (e.g. `bot` as well as `bot/x`).
 */
export function isProtectedPath(relPath: string): boolean {
  const lc = toPosix(relPath).replace(/^\.\//, "").toLowerCase();
  return PROTECTED_PREFIXES.some((prefix) => {
    const base = prefix.slice(0, -1); // strip trailing slash → bare dir name
    return lc === base || lc.startsWith(prefix);
  });
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
 * Returns a block decision for protected prefixes and for workspace-relative
 * traversal escapes; allows everything else (incl. absolute paths that simply
 * live outside the workspace, matching the legacy hook's within-workspace scope).
 */
function classifyTargetPath(rawTarget: string, root: string, tool: string): GuardDecision {
  const raw = rawTarget.trim();
  if (!raw) {
    return { block: false };
  }

  // node:path.resolve/normalize canonicalize `.`, `..`, `//` — the traversal
  // bug fix. Absolute targets are normalized as-is (so `<ws>/bot/../bot/x`
  // collapses back into `bot/`).
  const abs = normalize(isAbsolute(raw) ? raw : resolve(root, raw));
  const rel = toPosix(relative(normalize(root), abs));

  // Target IS the workspace root directory — cannot write a file there.
  if (rel === "") {
    return { block: false };
  }

  // A workspace-RELATIVE target that climbs above the root is a
  // workspace-structure violation (traversal escape). An absolute target that
  // merely lives outside the workspace (e.g. /tmp/log) is allowed.
  const escapes = rel === ".." || rel.startsWith("../");
  if (escapes) {
    if (!isAbsolute(raw)) {
      return {
        block: true,
        reason:
          `Blocked: ${tool} target "${rawTarget}" escapes the workspace via path ` +
          `traversal (workspace-structure violation).`,
      };
    }
    return { block: false };
  }

  if (isProtectedPath(rel)) {
    return {
      block: true,
      reason:
        `Blocked: ${tool} into upstream-owned path "${rel}" — these files come ` +
        `from upstream (see .claude/rules/platform/bot-code-readonly.md). Change ` +
        `it via a PR in the public repo, then merge upstream.`,
    };
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

  for (const raw of targets) {
    const decision = classifyTargetPath(raw, root, tool);
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

  let ci = 0;
  while (ci < positional.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(positional[ci])) {
    ci++; // skip leading VAR=value env assignments
  }
  while (ci < positional.length && WRAPPER_CMDS.has(basename(positional[ci]))) {
    ci++; // skip sudo / nohup / env / … wrappers
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
 * Extract the GNU coreutils target directory from a `cp`/`mv` arg list:
 * `-t DIR`, `-tDIR`, or `--target-directory[=DIR]`. Returns undefined when the
 * flag is absent (POSIX `cp src dest` form).
 */
function extractTargetDirFlag(args: string[]): string | undefined {
  for (let a = 0; a < args.length; a++) {
    const w = args[a];
    if (w === "-t" || w === "--target-directory") {
      const next = args[a + 1];
      if (next !== undefined && !next.startsWith("-")) {
        return next;
      }
    } else if (w.startsWith("--target-directory=")) {
      return w.slice("--target-directory=".length);
    } else if (w.startsWith("-t") && !w.startsWith("--") && w.length > 2) {
      return w.slice(2);
    }
  }
  return undefined;
}

/**
 * Best-effort, conservative extraction of paths a bash command would write:
 * `>` / `>>` redirects, `tee` file args, `mv` (sources + dest), `cp` (dest).
 * Returns deduped, non-empty target strings. Defense-in-depth on top of the
 * solid write/edit guarantee — not a full shell parser.
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
