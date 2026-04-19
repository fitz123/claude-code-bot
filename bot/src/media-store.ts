import { mkdirSync, rmSync, readdirSync, statSync, unlinkSync, existsSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./logger.js";

export const MEDIA_BASE = "/tmp/bot-media";
export const DEFAULT_MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/**
 * Paths downloaded by a handler that have NOT yet been released to a
 * session. On successful delivery (queue consumes the message) the handler
 * calls `releaseMediaPath` and the path leaves this set — the session owns
 * the file from that point and it's reclaimed on session close. On drop
 * paths (queue cap exceeded, /reconnect, /clean, handler error before
 * enqueue) the handler calls `discardMediaPath` which removes from the set
 * and unlinks. Consulted by `cleanupStaleSessionMedia` and
 * `enforceMediaCap` so they never delete files that are pre-delivery
 * in-flight.
 */
const inflightMediaPaths = new Set<string>();

function safeChatId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function sessionMediaDir(chatId: string): string {
  return join(MEDIA_BASE, safeChatId(chatId));
}

/**
 * Create `path` with mode 0o700 if missing, otherwise verify it's a real dir
 * (not a symlink) and force permissions to 0o700. mkdirSync's `mode` option is
 * ignored when the dir already exists, so a pre-squatted `/tmp/bot-media` with
 * loose perms would otherwise leak filenames to other local users.
 */
function ensureSecureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to use ${path}: it is a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to use ${path}: not a directory`);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    chmodSync(path, 0o700);
  }
}

export function ensureSessionMediaDir(chatId: string): string {
  const dir = sessionMediaDir(chatId);
  // mode 0o700: only the bot user can traverse/list. On shared hosts this
  // prevents other local users from enumerating filenames of downloaded media.
  ensureSecureDir(MEDIA_BASE);
  ensureSecureDir(dir);
  return dir;
}

/**
 * Verify MEDIA_BASE exists and is a real directory (not a symlink). Returns
 * false on symlink (refuse to follow — a pre-squatted link could redirect
 * deletions outside the intended tree) or missing. Callers treat false as
 * "nothing safe to clean; bail out".
 */
function mediaBaseSafeToTouch(): boolean {
  if (!existsSync(MEDIA_BASE)) return false;
  try {
    const stat = lstatSync(MEDIA_BASE);
    if (stat.isSymbolicLink()) {
      log.warn("media-store", `Refusing to touch ${MEDIA_BASE}: it is a symlink`);
      return false;
    }
    if (!stat.isDirectory()) {
      log.warn("media-store", `Refusing to touch ${MEDIA_BASE}: not a directory`);
      return false;
    }
  } catch (err) {
    if (!isMissingErr(err)) {
      log.warn("media-store", `Failed to stat ${MEDIA_BASE}: ${(err as Error).message}`);
    }
    return false;
  }
  return true;
}

export function cleanupSessionMediaDir(chatId: string): void {
  if (!mediaBaseSafeToTouch()) return;
  rmSync(sessionMediaDir(chatId), { recursive: true, force: true });
}

/**
 * Wipe the entire media root. Not invoked automatically — see the startup
 * comment in main.ts for why a blanket wipe at boot is unsafe (polling
 * ownership isn't proven yet, could clobber an overlapping old instance's
 * files). Kept as a manual escape hatch; per-session `cleanupSessionMediaDir`
 * on close and `enforceMediaCap` eviction reclaim orphans during normal
 * operation.
 */
export function cleanupAllMedia(): void {
  if (!existsSync(MEDIA_BASE)) return;
  try {
    const stat = lstatSync(MEDIA_BASE);
    if (stat.isSymbolicLink()) {
      // Pre-squatted symlink: unlink the link itself, do not recurse into target.
      log.warn("media-store", `${MEDIA_BASE} is a symlink; unlinking the link only`);
      unlinkSync(MEDIA_BASE);
      return;
    }
  } catch (err) {
    if (!isMissingErr(err)) {
      log.warn("media-store", `Failed to stat ${MEDIA_BASE}: ${(err as Error).message}`);
    }
    return;
  }
  rmSync(MEDIA_BASE, { recursive: true, force: true });
}

/**
 * Remove files in this session's media dir that are not currently tracked as
 * in-flight. Used when a stored session is discarded (agent changed or
 * deleted) to wipe leftovers from the prior logical session — including
 * orphans from a crashed prior process — without deleting the file the
 * current handler just downloaded for the next session's turn.
 */
export function cleanupStaleSessionMedia(chatId: string): void {
  if (!mediaBaseSafeToTouch()) return;
  const dir = sessionMediaDir(chatId);
  if (!existsSync(dir)) return;
  // Verify the per-session dir is a real dir, not a symlink. A pre-squatted
  // symlink at /tmp/bot-media/<chat> would otherwise let unlinkSync resolve
  // through it and delete files in the target tree. MEDIA_BASE is normally
  // 0o700 once `ensureSecureDir` has run, but this can fire on session
  // rotation before any download has tightened perms.
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) {
      log.warn("media-store", `Refusing to clean ${dir}: it is a symlink`);
      return;
    }
    if (!stat.isDirectory()) {
      log.warn("media-store", `Refusing to clean ${dir}: not a directory`);
      return;
    }
  } catch (err) {
    if (!isMissingErr(err)) {
      log.warn("media-store", `Failed to stat ${dir}: ${(err as Error).message}`);
    }
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!isMissingErr(err)) {
      log.warn("media-store", `Failed to scan ${dir} for stale cleanup: ${(err as Error).message}`);
    }
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    if (inflightMediaPaths.has(path)) continue;
    try {
      unlinkSync(path);
      log.debug("media-store", `Removed stale media ${path} on session rotation`);
    } catch (err) {
      if (!isMissingErr(err)) {
        log.warn("media-store", `Failed to clean ${path}: ${(err as Error).message}`);
      }
    }
  }
}

export function allocateMediaPath(chatId: string, prefix: string, extension: string): string {
  const dir = ensureSessionMediaDir(chatId);
  const path = join(dir, `${prefix}-${randomUUID()}${extension}`);
  inflightMediaPaths.add(path);
  return path;
}

/**
 * Mark a media file as no longer in-flight (delivered to a session, which now
 * owns its lifetime). Does not touch the file.
 */
export function releaseMediaPath(path: string): void {
  inflightMediaPaths.delete(path);
}

/**
 * Release tracking AND unlink the file. Used when a media file is dropped
 * (queue cap exceeded, /reconnect, /clean) or the handler hits an error
 * before enqueue.
 */
export function discardMediaPath(path: string): void {
  inflightMediaPaths.delete(path);
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isMissingErr(err)) {
      log.warn("media-store", `Failed to discard ${path}: ${(err as Error).message}`);
    }
  }
}

function isMissingErr(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Evict oldest files (by mtime) across all session media dirs until total bytes ≤ maxBytes.
 * Empty session dirs are left in place; they're reclaimed on session close.
 */
export function enforceMediaCap(maxBytes: number): void {
  // Best-effort housekeeping: never throw. An unrelated permission/IO error
  // in another chat's dir must not fail the current download-enqueue path.
  if (!existsSync(MEDIA_BASE)) return;

  const candidates: { path: string; size: number; mtime: number }[] = [];
  let total = 0;
  let chatEntries;
  try {
    chatEntries = readdirSync(MEDIA_BASE, { withFileTypes: true });
  } catch (err) {
    if (!isMissingErr(err)) {
      log.warn("media-store", `Failed to scan ${MEDIA_BASE}: ${(err as Error).message}`);
    }
    return;
  }
  for (const chatEntry of chatEntries) {
    if (!chatEntry.isDirectory()) continue;
    const dir = join(MEDIA_BASE, chatEntry.name);
    let fileEntries;
    try {
      fileEntries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Session dir may have been removed concurrently (cleanup on close).
      if (!isMissingErr(err)) {
        log.warn("media-store", `Failed to scan ${dir}: ${(err as Error).message}`);
      }
      continue;
    }
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile()) continue;
      const path = join(dir, fileEntry.name);
      try {
        const stat = statSync(path);
        total += stat.size;
        // In-flight files (downloaded, not yet handed to a session) must not
        // be evicted — the handler is about to enqueue them and the agent
        // would get a path that no longer exists.
        if (!inflightMediaPaths.has(path)) {
          candidates.push({ path, size: stat.size, mtime: stat.mtimeMs });
        }
      } catch (err) {
        if (!isMissingErr(err)) {
          log.warn("media-store", `Failed to stat ${path}: ${(err as Error).message}`);
        }
      }
    }
  }

  if (total <= maxBytes) return;

  candidates.sort((a, b) => a.mtime - b.mtime);

  for (const f of candidates) {
    if (total <= maxBytes) break;
    try {
      unlinkSync(f.path);
      total -= f.size;
      log.debug("media-store", `Evicted ${f.path} (${f.size} bytes) to stay under cap`);
    } catch (err) {
      if (!isMissingErr(err)) {
        log.warn("media-store", `Failed to evict ${f.path}: ${(err as Error).message}`);
      }
    }
  }

  if (total > maxBytes) {
    log.warn("media-store", `Media cap ${maxBytes} exceeded: ${total} bytes remain after eviction sweep`);
  }
}
