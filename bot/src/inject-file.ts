/**
 * Mid-turn message injection via file-based IPC.
 *
 * When a user sends a message while the agent is busy (doing tool calls),
 * the bot writes the message to an inject file. A PreToolUse hook in the
 * agent workspace reads the file and returns its content as additionalContext,
 * allowing the agent to see the message mid-turn.
 *
 * Protocol:
 *   pending   — bot writes formatted messages (atomic: write tmp + rename)
 *   ack       — hook writes cumulative consumed count after reading pending
 */

import { writeFileSync, readFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const INJECT_DIR_BASE = "/tmp/bot-inject";
export const INJECT_ENV_VAR = "BOT_INJECT_DIR";

/** Deterministic inject directory path for a given chat/session key. */
export function injectDirForChat(chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(INJECT_DIR_BASE, safe);
}

/**
 * Write messages atomically to a named file in the inject directory.
 *
 * File format:
 *   Line 1: message count (integer)
 *   Line 2+: formatted message text (messages separated by --- lines)
 *
 * Atomic write: write to a temp file, then rename. This prevents the hook
 * from reading a partially-written file.
 */
function writeAtomicInjectFile(dir: string, filename: string, messages: string[]): void {
  mkdirSync(dir, { recursive: true });

  const separator = "\n\n---\n\n";
  const body = messages.join(separator);
  const content = `${messages.length}\n${body}`;

  const pendingPath = join(dir, filename);
  const tmpPath = join(dir, `.${filename}.${randomBytes(4).toString("hex")}.tmp`);

  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, pendingPath);
}

/** Write user messages to `pending` (owned by MessageQueue). */
export function writeInjectFile(dir: string, messages: string[]): void {
  writeAtomicInjectFile(dir, "pending", messages);
}

/**
 * Write echo messages to `pending-echo` (owned by EchoWatcher).
 * Separate from `pending` so echo writes never collide with user-message writes.
 */
export function writeEchoInjectFile(dir: string, messages: string[]): void {
  writeAtomicInjectFile(dir, "pending-echo", messages);
}

/**
 * Read the cumulative ack count from the hook's ack file.
 * Returns 0 if no ack file exists or on any error.
 */
export function readAckCount(dir: string): number {
  try {
    const raw = readFileSync(join(dir, "ack"), "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/** Remove the inject directory and all files in it. */
export function cleanupInjectDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
