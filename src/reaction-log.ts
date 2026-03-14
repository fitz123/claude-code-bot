/**
 * Append-only JSONL logger for reaction events.
 * Writes to ~/.openclaw/logs/reactions.jsonl.
 * All errors are caught — logging must never break message flow.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function logReaction(entry: ReactionLogEntry): void {
  try {
    if (!dirEnsured) {
      mkdirSync(LOG_DIR, { recursive: true });
      dirEnsured = true;
    }
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Never throw — logging is non-critical
  }
}
