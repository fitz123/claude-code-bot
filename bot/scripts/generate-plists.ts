#!/usr/bin/env npx tsx
// generate-plists.ts — Generates launchd plist files from crons.yaml
// Usage: npx tsx scripts/generate-plists.ts [--dry-run]
// Output: ~/Library/LaunchAgents/ai.minime.cron.<name>.plist

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(BOT_DIR, "..");
const CRONS_PATH = resolve(REPO_ROOT, "crons.yaml");
const CRONS_LOCAL_PATH = resolve(REPO_ROOT, "crons.local.yaml");
const HOME = homedir();
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const LOG_DIR = process.env.LOG_DIR ?? join(HOME, ".minime", "logs");
const RUN_CRON_SCRIPT = resolve(BOT_DIR, "scripts", "run-cron.sh");

const dryRun = process.argv.includes("--dry-run");

interface CronDef {
  name: string;
  schedule: string;
  type?: "llm" | "script";
  prompt?: string;
  command?: string;
  agentId: string;
  deliveryChatId?: number;
  timeout?: number;
  enabled?: boolean;
}

interface CronsYaml {
  crons: CronDef[];
}

// Parse cron expression to launchd StartCalendarInterval entries
// launchd doesn't support */N — we expand to individual entries
interface CalendarInterval {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Month?: number;
  Weekday?: number;
}

function parseCronToCalendarIntervals(expr: string): CalendarInterval[] | null {
  // Handle "every N" (seconds) → use StartInterval instead
  if (expr.startsWith("every ")) {
    return null; // signals to use StartInterval
  }

  const parts = expr.split(" ");
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expr}`);
  }

  const [minute, hour, day, month, weekday] = parts;

  // Expand each field
  const minutes = expandField(minute, 0, 59);
  const hours = expandField(hour, 0, 23);
  const days = expandField(day, 1, 31);
  const months = expandField(month, 1, 12);
  const weekdays = expandField(weekday, 0, 6); // 0=Sunday in launchd, 1=Monday in cron...

  // Convert cron weekdays (0=Sun, 1=Mon..7=Sun) to launchd (0=Sun, 1=Mon..)
  // Actually both use 0=Sunday convention, so no conversion needed
  // But cron uses 1-5 for Mon-Fri, launchd uses 1-5 for Mon-Fri. Compatible.

  // Generate all combinations
  const intervals: CalendarInterval[] = [];

  // If weekday is specified (not *), iterate over weekdays
  // If day/month is specified, iterate over those
  // Generate the minimal set of entries

  for (const m of months) {
    for (const d of days) {
      for (const wd of weekdays) {
        for (const h of hours) {
          for (const min of minutes) {
            const entry: CalendarInterval = {};
            if (min !== -1) entry.Minute = min;
            if (h !== -1) entry.Hour = h;
            if (d !== -1) entry.Day = d;
            if (m !== -1) entry.Month = m;
            if (wd !== -1) entry.Weekday = wd;
            intervals.push(entry);
          }
        }
      }
    }
  }

  return intervals;
}

// Expand a cron field to array of values. Returns [-1] for wildcard (*)
function expandField(field: string, min: number, max: number): number[] {
  if (field === "*") return [-1]; // wildcard

  const values: number[] = [];

  for (const part of field.split(",")) {
    // Handle step: */N or M-N/S
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;

      if (range !== "*") {
        if (range.includes("-")) {
          const [s, e] = range.split("-");
          start = parseInt(s, 10);
          end = parseInt(e, 10);
        } else {
          start = parseInt(range, 10);
        }
      }

      for (let i = start; i <= end; i += step) {
        values.push(i);
      }
    }
    // Handle range: M-N
    else if (part.includes("-")) {
      const [start, end] = part.split("-").map((s) => parseInt(s, 10));
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
    }
    // Single value
    else {
      values.push(parseInt(part, 10));
    }
  }

  return values;
}

function calendarIntervalToPlist(interval: CalendarInterval): string {
  const lines: string[] = [];
  lines.push("        <dict>");
  if (interval.Month !== undefined && interval.Month !== -1) {
    lines.push(`          <key>Month</key>`);
    lines.push(`          <integer>${interval.Month}</integer>`);
  }
  if (interval.Day !== undefined && interval.Day !== -1) {
    lines.push(`          <key>Day</key>`);
    lines.push(`          <integer>${interval.Day}</integer>`);
  }
  if (interval.Weekday !== undefined && interval.Weekday !== -1) {
    lines.push(`          <key>Weekday</key>`);
    lines.push(`          <integer>${interval.Weekday}</integer>`);
  }
  if (interval.Hour !== undefined && interval.Hour !== -1) {
    lines.push(`          <key>Hour</key>`);
    lines.push(`          <integer>${interval.Hour}</integer>`);
  }
  if (interval.Minute !== undefined && interval.Minute !== -1) {
    lines.push(`          <key>Minute</key>`);
    lines.push(`          <integer>${interval.Minute}</integer>`);
  }
  lines.push("        </dict>");
  return lines.join("\n");
}

function generatePlist(cron: CronDef): string {
  const label = `ai.minime.cron.${cron.name}`;
  const intervals = parseCronToCalendarIntervals(cron.schedule);

  let scheduleSection: string;

  if (intervals === null) {
    // "every N" seconds
    const seconds = parseInt(cron.schedule.replace("every ", ""), 10);
    scheduleSection = `    <key>StartInterval</key>
    <integer>${seconds}</integer>`;
  } else if (intervals.length === 1) {
    scheduleSection = `    <key>StartCalendarInterval</key>
${calendarIntervalToPlist(intervals[0]).replace(/^        /gm, "    ")}`;
  } else {
    const entriesXml = intervals
      .map((i) => calendarIntervalToPlist(i))
      .join("\n");
    scheduleSection = `    <key>StartCalendarInterval</key>
    <array>
${entriesXml}
    </array>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${RUN_CRON_SCRIPT}</string>
        <string>${cron.name}</string>
    </array>
${scheduleSection}
    <key>RunAtLoad</key>
    <false/>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/cron-${cron.name}.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/cron-${cron.name}.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
`;
}

function loadMergedCrons(): CronDef[] {
  const raw: CronsYaml = parseYaml(readFileSync(CRONS_PATH, "utf8"));
  if (!raw?.crons || !Array.isArray(raw.crons)) {
    throw new Error("crons.yaml missing 'crons' array");
  }
  let crons = [...raw.crons];

  if (existsSync(CRONS_LOCAL_PATH)) {
    const localRaw: CronsYaml = parseYaml(readFileSync(CRONS_LOCAL_PATH, "utf8"));
    if (localRaw?.crons && Array.isArray(localRaw.crons)) {
      for (const local of localRaw.crons) {
        const idx = crons.findIndex((c) => c.name === local.name);
        if (idx >= 0) {
          crons[idx] = local;
        } else {
          crons.push(local);
        }
      }
    }
  }

  return crons;
}

function main(): void {
  let crons: CronDef[];
  try {
    crons = loadMergedCrons();
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }

  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });

  let generated = 0;
  let errors = 0;

  for (const cron of crons) {
    if (cron.enabled === false) {
      console.log(`[SKIP] ${cron.name} (enabled: false)`);
      continue;
    }
    const cronType = cron.type ?? "llm";
    if (cronType !== "llm" && cronType !== "script") {
      console.error(`ERROR: ${cron.name} has invalid type "${cron.type}" (must be "llm" or "script")`);
      errors++;
      continue;
    }
    if (cronType === "script" && (!cron.command || !cron.command.trim())) {
      console.error(`ERROR: ${cron.name} is type "script" but missing required "command" field`);
      errors++;
      continue;
    }
    if (cronType === "llm" && (!cron.prompt || !cron.prompt.trim())) {
      console.error(`ERROR: ${cron.name} is type "llm" but missing required "prompt" field`);
      errors++;
      continue;
    }
    try {
      const plistContent = generatePlist(cron);
      const plistPath = resolve(
        LAUNCH_AGENTS_DIR,
        `ai.minime.cron.${cron.name}.plist`,
      );

      if (dryRun) {
        console.log(`[DRY-RUN] Would write: ${plistPath}`);
        console.log(
          `  Schedule: ${cron.schedule} → ${parseCronToCalendarIntervals(cron.schedule) === null ? `StartInterval(${cron.schedule.replace("every ", "")}s)` : `${parseCronToCalendarIntervals(cron.schedule)!.length} calendar interval(s)`}`,
        );
      } else {
        writeFileSync(plistPath, plistContent, "utf8");
        console.log(`Generated: ${plistPath}`);
      }
      generated++;
    } catch (err) {
      console.error(
        `ERROR generating plist for ${cron.name}: ${(err as Error).message}`,
      );
      errors++;
    }
  }

  console.log(
    `\n${dryRun ? "[DRY-RUN] " : ""}Generated ${generated} plists, ${errors} errors`,
  );

  if (errors > 0) {
    process.exit(1);
  }
}

main();
