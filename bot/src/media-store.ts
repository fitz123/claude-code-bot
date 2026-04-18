import { mkdirSync, rmSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./logger.js";

export const MEDIA_BASE = "/tmp/bot-media";
export const DEFAULT_MAX_MEDIA_BYTES = 200 * 1024 * 1024;

function safeChatId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function sessionMediaDir(chatId: string): string {
  return join(MEDIA_BASE, safeChatId(chatId));
}

export function ensureSessionMediaDir(chatId: string): string {
  const dir = sessionMediaDir(chatId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupSessionMediaDir(chatId: string): void {
  rmSync(sessionMediaDir(chatId), { recursive: true, force: true });
}

export function allocateMediaPath(chatId: string, prefix: string, extension: string): string {
  const dir = ensureSessionMediaDir(chatId);
  return join(dir, `${prefix}-${randomUUID()}${extension}`);
}

/**
 * Evict oldest files (by mtime) across all session media dirs until total bytes ≤ maxBytes.
 * Empty session dirs are left in place; they're reclaimed on session close.
 */
export function enforceMediaCap(maxBytes: number): void {
  if (!existsSync(MEDIA_BASE)) return;

  const files: { path: string; size: number; mtime: number }[] = [];
  for (const chatEntry of readdirSync(MEDIA_BASE, { withFileTypes: true })) {
    if (!chatEntry.isDirectory()) continue;
    const dir = join(MEDIA_BASE, chatEntry.name);
    for (const fileEntry of readdirSync(dir, { withFileTypes: true })) {
      if (!fileEntry.isFile()) continue;
      const path = join(dir, fileEntry.name);
      try {
        const stat = statSync(path);
        files.push({ path, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        // File vanished mid-scan — ignore
      }
    }
  }

  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= maxBytes) return;

  files.sort((a, b) => a.mtime - b.mtime);

  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      unlinkSync(f.path);
      total -= f.size;
      log.debug("media-store", `Evicted ${f.path} (${f.size} bytes) to stay under cap`);
    } catch {
      // File already gone — ignore
    }
  }
}
