/**
 * Append-only JSONL logger for reaction events.
 *
 * Writes to ~/.openclaw/logs/reactions.jsonl. Failures are silently caught
 * so logging never disrupts the message flow.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".openclaw", "logs");
const LOG_PATH = join(LOG_DIR, "reactions.jsonl");

let dirEnsured = false;

export interface ReactionLogEntry {
  ts: string;
  chatId: number;
  topicId: number | undefined;
  messageId: number;
  userId: number | undefined;
  username: string | undefined;
  added: string[];
  removed: string[];
}

/**
 * Append a reaction event to the JSONL log file.
 * Wrapped in try/catch — never throws.
 */
export function logReaction(entry: ReactionLogEntry): void {
  try {
    if (!dirEnsured) {
      mkdirSync(LOG_DIR, { recursive: true });
      dirEnsured = true;
    }
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Intentionally swallowed — logging must never break message flow
  }
}
