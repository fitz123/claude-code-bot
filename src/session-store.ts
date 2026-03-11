import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionState } from "./types.js";

const DEFAULT_STORE_PATH = "/Users/ninja/.openclaw/bot/data/sessions.json";

export type SessionStoreData = Record<string, SessionState>;

export class SessionStore {
  private data: SessionStoreData = {};
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? DEFAULT_STORE_PATH;
    this.load();
  }

  /** Load store from disk. Returns empty store if file doesn't exist. */
  load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        this.data = parsed as SessionStoreData;
      }
    } catch {
      this.data = {};
    }
  }

  /** Persist store to disk atomically (write .tmp then rename). */
  save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = this.path + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmpPath, this.path);
  }

  getSession(chatId: string): SessionState | undefined {
    return this.data[chatId];
  }

  setSession(chatId: string, state: SessionState): void {
    this.data[chatId] = state;
    this.save();
  }

  deleteSession(chatId: string): void {
    delete this.data[chatId];
    this.save();
  }

  getAllSessions(): SessionStoreData {
    return { ...this.data };
  }

  /** For testing: return count of stored sessions */
  get size(): number {
    return Object.keys(this.data).length;
  }
}
