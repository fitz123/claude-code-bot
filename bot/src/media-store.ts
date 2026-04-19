import { mkdirSync, rmSync, readdirSync, statSync, unlinkSync, existsSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./logger.js";

export const MEDIA_BASE = "/tmp/bot-media";
export const DEFAULT_MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/**
 * Paths currently owned by an in-flight handler (downloaded but not yet
 * delivered to a session, or delivered and owned by an active session).
 * Used by `cleanupStaleSessionMedia` to decide what belongs to the current
 * logical session vs. orphaned from a prior process or a rotated agent.
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

export function cleanupSessionMediaDir(chatId: string): void {
  rmSync(sessionMediaDir(chatId), { recursive: true, force: true });
}

/**
 * Wipe the entire media root. Called on bot startup so prior-run downloads
 * (including orphaned pending-debounce files and files that survived agent
 * rotation via the freshness heuristic) cannot leak into a new process.
 */
export function cleanupAllMedia(): void {
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
  const dir = sessionMediaDir(chatId);
  if (!existsSync(dir)) return;
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

  const files: { path: string; size: number; mtime: number }[] = [];
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
        files.push({ path, size: stat.size, mtime: stat.mtimeMs });
      } catch (err) {
        if (!isMissingErr(err)) {
          log.warn("media-store", `Failed to stat ${path}: ${(err as Error).message}`);
        }
      }
    }
  }

  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= maxBytes) return;

  files.sort((a, b) => a.mtime - b.mtime);

  for (const f of files) {
    if (total <= maxBytes) break;
    // Never evict a file a live handler still owns (downloaded but not yet
    // enqueued). Deleting it would strand the handler with a stale path and
    // the session would receive a dangling reference.
    if (inflightMediaPaths.has(f.path)) continue;
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
