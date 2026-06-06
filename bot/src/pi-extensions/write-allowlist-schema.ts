import { readFileSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { MINIME_SCHEMA_PATH_ENV } from "../workspace-contract.js";

export const WRITE_ALLOWLIST_FENCE = "```write-allowlist";

export type WriteAllowlistSchemaIssueKind =
  | "missing-file"
  | "unreadable-file"
  | "missing-block"
  | "malformed-block"
  | "empty-block";

export interface WriteAllowlistSchemaIssue {
  kind: WriteAllowlistSchemaIssueKind;
  message: string;
}

export interface WriteAllowlistSchemaResult {
  schemaPath: string;
  entries: string[];
  issue?: WriteAllowlistSchemaIssue;
}

export type ReadSchemaFile = (schemaPath: string) => string;

function defaultReadSchemaFile(schemaPath: string): string {
  return readFileSync(schemaPath, "utf8");
}

function issue(
  schemaPath: string,
  kind: WriteAllowlistSchemaIssueKind,
  message: string,
): WriteAllowlistSchemaResult {
  return {
    schemaPath,
    entries: [],
    issue: { kind, message },
  };
}

export function resolveWriteAllowlistSchemaPath(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[MINIME_SCHEMA_PATH_ENV]?.trim();
  if (override) {
    return normalize(isAbsolute(override) ? override : resolve(workspaceRoot, override));
  }
  return normalize(resolve(workspaceRoot, "schema.md"));
}

export function parseWriteAllowlistSchemaContent(
  content: string,
  schemaPath = "schema.md",
): WriteAllowlistSchemaResult {
  const entries: string[] = [];
  let inBlock = false;
  let foundBlock = false;
  let closedBlock = false;

  for (const rawLine of content.split("\n")) {
    if (!inBlock) {
      if (rawLine === WRITE_ALLOWLIST_FENCE) {
        inBlock = true;
        foundBlock = true;
      }
      continue;
    }

    if (rawLine.startsWith("```")) {
      closedBlock = true;
      break;
    }

    const line = rawLine.replace(/#.*$/, "").trim();
    if (line) {
      entries.push(line);
    }
  }

  if (!foundBlock) {
    return issue(
      schemaPath,
      "missing-block",
      `schema does not contain an exact ${WRITE_ALLOWLIST_FENCE} fenced block`,
    );
  }

  if (!closedBlock) {
    return issue(
      schemaPath,
      "malformed-block",
      "schema write-allowlist block is missing a closing fence",
    );
  }

  if (entries.length === 0) {
    return issue(
      schemaPath,
      "empty-block",
      "schema write-allowlist block is empty after comments and blank lines are removed",
    );
  }

  return { schemaPath, entries };
}

export function readWriteAllowlistSchema(
  schemaPath: string,
  readSchemaFile: ReadSchemaFile = defaultReadSchemaFile,
): WriteAllowlistSchemaResult {
  let content: string;
  try {
    content = readSchemaFile(schemaPath);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err
      ? String((err as NodeJS.ErrnoException).code)
      : "";
    if (code === "ENOENT") {
      return issue(schemaPath, "missing-file", `schema file does not exist: ${schemaPath}`);
    }
    return issue(schemaPath, "unreadable-file", `schema file cannot be read: ${schemaPath}`);
  }

  return parseWriteAllowlistSchemaContent(content, schemaPath);
}

export function readWriteAllowlistEntriesForGuard(
  schemaPath: string,
  readSchemaFile?: ReadSchemaFile,
): string[] {
  const result = readWriteAllowlistSchema(schemaPath, readSchemaFile);
  return result.issue ? [] : result.entries;
}
