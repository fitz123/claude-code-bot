import type { LogLevel } from "./types.js";

export type { LogLevel };

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Parse a string into a valid LogLevel, or return undefined if invalid. */
export function parseLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.toLowerCase();
  if (Object.hasOwn(LEVEL_ORDER, lower)) return lower as LogLevel;
  return undefined;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function format(level: LogLevel, tag: string, message: string): string {
  return `${new Date().toISOString()} ${level.toUpperCase()} [${tag}] ${message}`;
}

export const log = {
  debug(tag: string, message: string, ...args: unknown[]): void {
    if (!shouldLog("debug")) return;
    if (args.length > 0) {
      console.debug(format("debug", tag, message), ...args);
    } else {
      console.debug(format("debug", tag, message));
    }
  },

  info(tag: string, message: string, ...args: unknown[]): void {
    if (!shouldLog("info")) return;
    if (args.length > 0) {
      console.log(format("info", tag, message), ...args);
    } else {
      console.log(format("info", tag, message));
    }
  },

  warn(tag: string, message: string, ...args: unknown[]): void {
    if (!shouldLog("warn")) return;
    if (args.length > 0) {
      console.warn(format("warn", tag, message), ...args);
    } else {
      console.warn(format("warn", tag, message));
    }
  },

  error(tag: string, message: string, ...args: unknown[]): void {
    if (!shouldLog("error")) return;
    if (args.length > 0) {
      console.error(format("error", tag, message), ...args);
    } else {
      console.error(format("error", tag, message));
    }
  },
};
