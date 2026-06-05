import { existsSync, readFileSync } from "node:fs";
import { resolveCodexQuotaPaths } from "./pi-extensions/codex-usage.js";

export const CODEX_QUOTA_STALE_MS_ENV = "CODEX_QUOTA_STALE_MS";
export const DEFAULT_CODEX_QUOTA_STALE_MS = 30 * 60 * 1000;

export type QuotaProvider = "codex";
export type QuotaWindowName = "5h" | "week";
export type QuotaStatusState = "available" | "stale" | "unavailable" | "read_error";

export interface QuotaWindowSnapshot {
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  resetTimestamp?: number;
}

export interface QuotaSnapshot {
  provider: QuotaProvider;
  windows: Record<QuotaWindowName, QuotaWindowSnapshot>;
  sampledAt?: string;
  lastSuccess?: string;
  lastSuccessTimestamp?: number;
  lastAttempt?: string;
  lastAttemptTimestamp?: number;
  probeSuccess?: boolean;
  planType?: string;
  activeLimit?: string;
}

export interface QuotaStatusOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stateFile?: string;
  now?: Date;
  staleMs?: number;
}

export type QuotaStatus =
  | {
      state: "available" | "stale";
      stateFile: string;
      snapshot: QuotaSnapshot;
      ageMs: number;
      sampleAge: string;
      staleMs: number;
    }
  | {
      state: "unavailable";
      stateFile: string;
      reason: "missing_file" | "no_success";
      staleMs: number;
      snapshot?: QuotaSnapshot;
    }
  | {
      state: "read_error";
      stateFile: string;
      error: string;
      staleMs: number;
    };

export function readQuotaStatus(options: QuotaStatusOptions = {}): QuotaStatus {
  const stateFile = resolveQuotaStateFile(options);
  const now = options.now ?? new Date();
  let staleMs = DEFAULT_CODEX_QUOTA_STALE_MS;
  try {
    staleMs = resolveQuotaStaleMs(options);
  } catch (error) {
    return {
      state: "read_error",
      stateFile,
      error: errorMessage(error),
      staleMs,
    };
  }

  if (!existsSync(stateFile)) {
    return {
      state: "unavailable",
      stateFile,
      reason: "missing_file",
      staleMs,
    };
  }

  try {
    const snapshot = parseQuotaSnapshot(JSON.parse(readFileSync(stateFile, "utf8")));
    const lastSuccessMs = lastSuccessMillis(snapshot);
    if (lastSuccessMs === undefined) {
      return {
        state: "unavailable",
        stateFile,
        reason: "no_success",
        staleMs,
        snapshot,
      };
    }

    const ageMs = Math.max(0, now.getTime() - lastSuccessMs);
    const sampleAge = formatSampleAge(lastSuccessMs, now) ?? "0m ago";
    return {
      state: ageMs > staleMs ? "stale" : "available",
      stateFile,
      snapshot,
      ageMs,
      sampleAge,
      staleMs,
    };
  } catch (error) {
    return {
      state: "read_error",
      stateFile,
      error: errorMessage(error),
      staleMs,
    };
  }
}

export function resolveQuotaStateFile(options: Pick<QuotaStatusOptions, "env" | "cwd" | "stateFile"> = {}): string {
  return resolveCodexQuotaPaths({
    env: options.env,
    cwd: options.cwd,
    stateFile: options.stateFile,
    isWritableDir: () => false,
  }).stateFile;
}

export function resolveQuotaStaleMs(options: Pick<QuotaStatusOptions, "env" | "staleMs"> = {}): number {
  if (options.staleMs !== undefined) {
    if (!isPositiveFiniteNumber(options.staleMs)) {
      throw new Error(`${CODEX_QUOTA_STALE_MS_ENV} must be a positive number`);
    }
    return Math.floor(options.staleMs);
  }

  const env = options.env ?? process.env;
  const raw = env[CODEX_QUOTA_STALE_MS_ENV];
  const trimmed = raw?.trim();
  if (!trimmed) {
    return DEFAULT_CODEX_QUOTA_STALE_MS;
  }

  const parsed = Number(trimmed);
  if (!isPositiveFiniteNumber(parsed)) {
    throw new Error(`${CODEX_QUOTA_STALE_MS_ENV} must be a positive number`);
  }
  return Math.floor(parsed);
}

export function parseQuotaSnapshot(raw: unknown): QuotaSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("quota state must be an object");
  }

  const record = raw as Record<string, unknown>;
  if (record.provider !== "codex") {
    throw new Error("quota state provider is unsupported");
  }

  const windows = parseQuotaWindows(record.windows);
  return {
    provider: "codex",
    windows,
    ...optionalStringField(record, "sampledAt"),
    ...optionalStringField(record, "lastSuccess"),
    ...optionalNumberField(record, "lastSuccessTimestamp"),
    ...optionalStringField(record, "lastAttempt"),
    ...optionalNumberField(record, "lastAttemptTimestamp"),
    ...optionalBooleanField(record, "probeSuccess"),
    ...optionalStringField(record, "planType"),
    ...optionalStringField(record, "activeLimit"),
  };
}

export function formatResetEta(reset: string | number | undefined, now = new Date()): string | undefined {
  const resetMs = timestampMillis(reset);
  if (resetMs === undefined) {
    return undefined;
  }
  const remainingMs = resetMs - now.getTime();
  return remainingMs <= 0 ? "now" : formatCompactDuration(remainingMs);
}

export function formatSampleAge(sample: string | number | undefined, now = new Date()): string | undefined {
  const sampleMs = timestampMillis(sample);
  if (sampleMs === undefined) {
    return undefined;
  }
  const ageMs = now.getTime() - sampleMs;
  if (ageMs < 0) {
    return `in ${formatCompactDuration(Math.abs(ageMs))}`;
  }
  return `${formatCompactDuration(ageMs)} ago`;
}

export function formatCompactDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function parseQuotaWindows(raw: unknown): Record<QuotaWindowName, QuotaWindowSnapshot> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("quota state windows must be an object");
  }

  const windows = raw as Record<string, unknown>;
  return {
    "5h": parseQuotaWindow(windows["5h"]),
    week: parseQuotaWindow(windows.week),
  };
}

function parseQuotaWindow(raw: unknown): QuotaWindowSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const record = raw as Record<string, unknown>;
  return {
    ...optionalNumberField(record, "usedPercent"),
    ...optionalNumberField(record, "remainingPercent"),
    ...optionalStringField(record, "resetAt"),
    ...optionalNumberField(record, "resetTimestamp"),
  };
}

function optionalStringField<T extends string>(record: Record<string, unknown>, key: T): Partial<Record<T, string>> {
  const value = record[key];
  return typeof value === "string" && value.trim() ? ({ [key]: value } as Partial<Record<T, string>>) : {};
}

function optionalNumberField<T extends string>(record: Record<string, unknown>, key: T): Partial<Record<T, number>> {
  const value = record[key];
  return isFiniteNumber(value) ? ({ [key]: value } as Partial<Record<T, number>>) : {};
}

function optionalBooleanField<T extends string>(record: Record<string, unknown>, key: T): Partial<Record<T, boolean>> {
  const value = record[key];
  return typeof value === "boolean" ? ({ [key]: value } as Partial<Record<T, boolean>>) : {};
}

function lastSuccessMillis(snapshot: QuotaSnapshot): number | undefined {
  return timestampMillis(snapshot.lastSuccessTimestamp ?? snapshot.lastSuccess ?? snapshot.sampledAt);
}

function timestampMillis(value: string | number | undefined): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return value > 1_000_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
