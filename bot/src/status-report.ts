import type { SessionHealth } from "./session-manager.js";
import {
  formatCompactDuration,
  formatResetEta,
  formatSampleAge,
  type QuotaStatus,
  type QuotaWindowName,
  type QuotaWindowSnapshot,
} from "./quota-status.js";

export const DEFAULT_SESSION_LAST_SUCCESS_STALE_MS = 30 * 60 * 1000;

type CachedQuotaStatus = Extract<QuotaStatus, { state: "available" | "stale" }>;

export interface BuildStatusReportOptions {
  activeCount: number;
  maxSessions: number;
  uptimeSeconds: number;
  sessionHealth?: SessionHealth;
  quotaStatus?: QuotaStatus;
  now?: Date;
  lastSuccessStaleMs?: number;
}

export function buildStatusReport(options: BuildStatusReportOptions): string {
  const now = options.now ?? new Date();
  const lines = [
    `Sessions: ${options.activeCount}/${options.maxSessions}`,
    `Uptime: ${formatCompactDuration(options.uptimeSeconds * 1000)}`,
  ];

  if (options.sessionHealth) {
    lines.push("", ...formatSessionHealth(options.sessionHealth, now, options.lastSuccessStaleMs));
  }

  const quotaLines = formatQuotaBlock(options.quotaStatus, options.sessionHealth, now);
  if (quotaLines.length > 0) {
    lines.push("", ...quotaLines);
  }

  return lines.join("\n");
}

function formatSessionHealth(
  health: SessionHealth,
  now: Date,
  lastSuccessStaleMs = DEFAULT_SESSION_LAST_SUCCESS_STALE_MS,
): string[] {
  const lines = [
    `Agent: ${health.agentId} (${health.provider})`,
    `Model: ${health.model}`,
    formatReasoningLine(health),
    `State: ${formatSessionState(health)}`,
    `Session ID: ${health.sessionId}`,
  ];

  const diagnostics = formatSessionDiagnostics(health, now, lastSuccessStaleMs);
  if (diagnostics.length > 0) {
    lines.push("Diagnostics:", ...diagnostics.map((line) => `  ${line}`));
  }

  return lines;
}

function formatReasoningLine(health: SessionHealth): string {
  return `Thinking: ${health.thinking ?? "default"}`;
}

function formatSessionState(health: SessionHealth): string {
  if (health.processingMs !== null) {
    return `processing (${formatProcessingDuration(health.processingMs)})`;
  }
  return `idle (${formatCompactDuration(health.idleMs)})`;
}

function formatSessionDiagnostics(health: SessionHealth, now: Date, lastSuccessStaleMs: number): string[] {
  const lines: string[] = [];

  if (!health.alive) {
    lines.push(`Process: dead (PID ${health.pid ?? "n/a"})`);
  }
  if (health.restartCount > 0) {
    lines.push(`Restarts: ${health.restartCount}`);
  }

  const lastSuccessLine = formatLastSuccessDiagnostic(health.lastSuccessAt, now, lastSuccessStaleMs);
  if (lastSuccessLine) {
    lines.push(lastSuccessLine);
  }

  return lines;
}

function formatLastSuccessDiagnostic(lastSuccessAt: number | null, now: Date, staleMs: number): string | undefined {
  if (lastSuccessAt === null) {
    return "Last success: none";
  }

  const ageMs = now.getTime() - lastSuccessAt;
  if (ageMs <= staleMs) {
    return undefined;
  }

  return `Last success: ${formatSampleAge(lastSuccessAt, now) ?? "unknown"} (stale)`;
}

function formatQuotaBlock(
  quotaStatus: QuotaStatus | undefined,
  health: SessionHealth | undefined,
  now: Date,
): string[] {
  if (!shouldRenderQuotaBlock(quotaStatus, health)) {
    return [];
  }
  if (!quotaStatus) {
    return ["Codex quota: unavailable (no cached state)"];
  }

  switch (quotaStatus.state) {
    case "available":
      return formatAvailableQuota(quotaStatus, now);
    case "stale":
      return formatStaleQuota(quotaStatus, now);
    case "unavailable":
      return formatUnavailableQuota(quotaStatus, now);
    case "read_error":
      return ["Codex quota: unavailable (read error)"];
  }
}

function shouldRenderQuotaBlock(quotaStatus: QuotaStatus | undefined, health: SessionHealth | undefined): boolean {
  if (!quotaStatus) {
    return isPiCodexSession(health);
  }
  if (quotaStatus.state !== "unavailable") {
    return true;
  }
  if (quotaStatus.reason !== "missing_file") {
    return true;
  }
  return isPiCodexSession(health);
}

function isPiCodexSession(health: SessionHealth | undefined): boolean {
  return health?.provider === "pi";
}

function formatAvailableQuota(quotaStatus: CachedQuotaStatus, now: Date): string[] {
  const snapshot = quotaStatus.snapshot;
  const lines = [`Codex quota: fresh (sample ${quotaStatus.sampleAge})`];
  appendQuotaMetadata(lines, snapshot.planType, snapshot.activeLimit);
  appendQuotaWindow(lines, "5h", snapshot.windows["5h"], now);
  appendQuotaWindow(lines, "week", snapshot.windows.week, now);
  appendAttemptLine(lines, snapshot.lastAttemptTimestamp ?? snapshot.lastAttempt, snapshot.probeSuccess, now);
  return lines;
}

function formatStaleQuota(quotaStatus: CachedQuotaStatus, now: Date): string[] {
  const snapshot = quotaStatus.snapshot;
  const lines = [`Codex quota: stale (last success ${quotaStatus.sampleAge})`];
  appendQuotaMetadata(lines, snapshot.planType, snapshot.activeLimit);
  appendQuotaWindow(lines, "5h", snapshot.windows["5h"], now);
  appendQuotaWindow(lines, "week", snapshot.windows.week, now);
  appendAttemptLine(lines, snapshot.lastAttemptTimestamp ?? snapshot.lastAttempt, snapshot.probeSuccess, now);
  return lines;
}

function formatUnavailableQuota(quotaStatus: Extract<QuotaStatus, { state: "unavailable" }>, now: Date): string[] {
  const detail = quotaStatus.reason === "missing_file" ? "state file missing" : "no successful sample";
  const lines = [`Codex quota: unavailable (${detail})`];
  const snapshot = quotaStatus.snapshot;
  if (snapshot) {
    appendAttemptLine(lines, snapshot.lastAttemptTimestamp ?? snapshot.lastAttempt, snapshot.probeSuccess, now);
  }
  return lines;
}

function appendQuotaMetadata(lines: string[], planType: string | undefined, activeLimit: string | undefined): void {
  const parts = [];
  if (planType) {
    parts.push(`plan ${planType}`);
  }
  if (activeLimit) {
    parts.push(`active ${activeLimit}`);
  }
  if (parts.length > 0) {
    lines.push(`  ${parts.join(", ")}`);
  }
}

function appendQuotaWindow(
  lines: string[],
  name: QuotaWindowName,
  window: QuotaWindowSnapshot,
  now: Date,
): void {
  const resetEta = formatResetEta(window.resetTimestamp ?? window.resetAt, now);
  const reset = resetEta ? `, resets in ${resetEta}` : "";
  lines.push(
    `  ${name}: ${formatPercent(window.usedPercent)} used, ${formatPercent(resolveRemainingPercent(window))} left${reset}`,
  );
}

function appendAttemptLine(
  lines: string[],
  lastAttempt: string | number | undefined,
  probeSuccess: boolean | undefined,
  now: Date,
): void {
  const age = formatSampleAge(lastAttempt, now);
  if (!age && probeSuccess === undefined) {
    return;
  }

  const outcome = probeSuccess === undefined ? "unknown" : probeSuccess ? "ok" : "failed";
  lines.push(`  Last attempt: ${age ?? "unknown"} (${outcome})`);
}

function resolveRemainingPercent(window: QuotaWindowSnapshot): number | undefined {
  if (typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)) {
    return window.remainingPercent;
  }
  if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
    return Math.max(0, 100 - window.usedPercent);
  }
  return undefined;
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }

  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function formatProcessingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
