/**
 * Append-only JSONL logger for reaction events.
 *
 * Writes to ~/.minime/logs/reactions.jsonl. Failures are caught and logged
 * to stderr so logging never disrupts the message flow but persistent failures
 * are still detectable operationally.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = process.env.LOG_DIR ?? join(homedir(), ".minime", "logs");
const LOG_PATH = join(LOG_DIR, "reactions.jsonl");

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
 * Never throws — errors are logged to stderr.
 *
 * @param entry - The reaction event data
 * @param logDir - Override log directory (for testing)
 */
export async function logReaction(entry: ReactionLogEntry, logDir?: string): Promise<void> {
  try {
    const dir = logDir ?? LOG_DIR;
    const path = logDir ? join(dir, "reactions.jsonl") : LOG_PATH;
    await mkdir(dir, { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Never throw — logging must not break message flow — but surface failures
    console.error("reaction-log: failed to write:", err);
  }
}
