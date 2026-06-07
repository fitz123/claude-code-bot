#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = process.argv[2] ? resolve(process.argv[2]) : resolve(packageRoot, "..");

const skippedDirs = new Set([
  ".beads",
  ".git",
  ".ralphex",
  "dist",
  "memory",
  "node_modules",
]);

const binaryExtensions = new Set([
  ".gif",
  ".jpg",
  ".jpeg",
  ".png",
  ".tgz",
]);

const allowedPathPrefixes = [
  `docs${sep}plans${sep}`,
];

const allowedPaths = new Set([
  "orphan-allowlist.txt",
  `reference${sep}governance${sep}decisions.md`,
  `bot${sep}scripts${sep}check-no-active-schema-guard-contract.mjs`,
  `bot${sep}src${sep}__tests__${sep}package-install.test.ts`,
  `bot${sep}src${sep}__tests__${sep}pi-rpc-protocol.test.ts`,
  `bot${sep}src${sep}__tests__${sep}schema-guard-contract-check.test.ts`,
]);

const bannedLinePatterns = [
  /\bMINIME_SCHEMA_PATH(?:_ENV)?\b/,
  /\bPI_GUARD_WORKSPACE_ROOT(?:_ENV)?\b/,
  /\bguardian-protect-files\b/,
  /\bguardian\.sh\b/,
  /\bprotect-files\.sh\b/,
  /\breadWriteAllowlistSchema\b/,
  /\bwrite-allowlist\b/i,
  /\bimmutable core\b/i,
  /\b(?:schema|write)\s+guard\b/i,
  /\bguard extension\b/i,
];

const staleSchemaRequirementPatterns = [
  /\bschema\.md\b.*\b(required|requires|must exist|validity|runtime correctness|package correctness)\b/i,
  /\b(required|requires|must exist)\b.*\bschema\.md\b/i,
];

const retiredContextPattern = /\b(retired|not required|no longer requires|does not require|without any schema\.md|without schema\.md|must not|should not)\b/i;

function shouldSkipDir(absPath) {
  const base = absPath.split(sep).pop();
  return skippedDirs.has(base);
}

function isAllowedPath(relPath) {
  return allowedPaths.has(relPath) || allowedPathPrefixes.some((prefix) => relPath.startsWith(prefix));
}

function isProbablyBinary(relPath) {
  return binaryExtensions.has(relPath.slice(relPath.lastIndexOf(".")).toLowerCase());
}

function* walk(absDir) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const absPath = join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(absPath)) yield* walk(absPath);
      continue;
    }
    if (entry.isFile()) yield absPath;
  }
}

function lineHasBannedContract(line) {
  if (bannedLinePatterns.some((pattern) => pattern.test(line))) return true;
  if (retiredContextPattern.test(line)) return false;
  return staleSchemaRequirementPatterns.some((pattern) => pattern.test(line));
}

const findings = [];

for (const absPath of walk(repoRoot)) {
  const relPath = relative(repoRoot, absPath);
  if (isAllowedPath(relPath) || isProbablyBinary(relPath)) continue;
  if (statSync(absPath).size > 2_000_000) continue;

  const text = readFileSync(absPath, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (lineHasBannedContract(line)) {
      findings.push(`${relPath}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (findings.length > 0) {
  console.error("Found active schema/write-guard contract references:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("No active schema/write-guard contract references found.");
