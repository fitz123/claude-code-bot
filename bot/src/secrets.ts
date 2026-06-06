import { execFileSync as nodeExecFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export type SecretSource = "sops" | "env";

export type SecretFailureKind =
  | "not-configured"
  | "invalid-key"
  | "missing-file"
  | "command-not-found"
  | "decrypt-failed"
  | "timeout"
  | "blank"
  | "unset";

export interface SecretSourceFailure {
  source: SecretSource;
  kind: SecretFailureKind;
  key?: string;
  envVar?: string;
}

export class SecretSourceError extends Error {
  readonly failure: SecretSourceFailure;

  constructor(failure: SecretSourceFailure) {
    super(formatSecretSourceFailure(failure));
    this.name = "SecretSourceError";
    this.failure = failure;
  }
}

export class SecretResolutionError extends Error {
  readonly fieldName: string;
  readonly failures: SecretSourceFailure[];

  constructor(fieldName: string, failures: SecretSourceFailure[]) {
    const detail = failures.length > 0
      ? failures.map(formatSecretSourceFailure).join("; ")
      : "no configured secret sources";
    super(`Unable to resolve ${fieldName} from configured secret sources: ${detail}`);
    this.name = "SecretResolutionError";
    this.fieldName = fieldName;
    this.failures = failures;
  }
}

export type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: {
    encoding: BufferEncoding;
    stdio: ["ignore", "pipe", "pipe"];
    timeout: number;
  },
) => string | Buffer;

export interface ReadSopsSecretOptions {
  file: string;
  key: string;
  execFileSync?: ExecFileSyncLike;
}

export interface ResolveSecretOptions {
  sopsFile?: string;
  sopsKey?: string;
  envVar?: string;
  fieldName: string;
  execFileSync?: ExecFileSyncLike;
  env?: NodeJS.ProcessEnv;
}

const SAFE_SOPS_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SOPS_DECRYPT_TIMEOUT_MS = 10_000;

function formatSecretSourceFailure(failure: SecretSourceFailure): string {
  if (failure.source === "sops") {
    const key = failure.key ? ` key '${failure.key}'` : "";
    return `SOPS${key} failed (${failure.kind})`;
  }
  const envVar = failure.envVar ? ` '${failure.envVar}'` : "";
  return `env var${envVar} failed (${failure.kind})`;
}

function toSourceError(failure: SecretSourceFailure): SecretSourceError {
  return new SecretSourceError(failure);
}

function defaultExecFileSync(
  file: string,
  args: readonly string[],
  options: {
    encoding: BufferEncoding;
    stdio: ["ignore", "pipe", "pipe"];
    timeout: number;
  },
): string | Buffer {
  return nodeExecFileSync(file, [...args], options);
}

export function sopsExtractExpression(key: string): string {
  const segments = key.split(".");
  if (key === "" || segments.some((segment) => segment === "")) {
    throw toSourceError({ source: "sops", kind: "invalid-key", key });
  }
  for (const segment of segments) {
    if (!SAFE_SOPS_SEGMENT.test(segment)) {
      throw toSourceError({ source: "sops", kind: "invalid-key", key });
    }
  }
  return segments.map((segment) => `["${segment}"]`).join("");
}

export function readSopsSecret(opts: ReadSopsSecretOptions): string {
  let extract: string;
  try {
    extract = sopsExtractExpression(opts.key);
  } catch (err) {
    if (err instanceof SecretSourceError) {
      throw err;
    }
    throw toSourceError({ source: "sops", kind: "invalid-key", key: opts.key });
  }

  if (!opts.file || !existsSync(opts.file)) {
    throw toSourceError({ source: "sops", kind: "missing-file", key: opts.key });
  }

  const execFileSync = opts.execFileSync ?? defaultExecFileSync;
  let raw: string | Buffer;
  try {
    raw = execFileSync("sops", ["-d", "--extract", extract, opts.file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SOPS_DECRYPT_TIMEOUT_MS,
    });
  } catch (err) {
    const errorMeta = typeof err === "object" && err !== null
      ? (err as { code?: unknown; signal?: unknown })
      : {};
    const code = errorMeta.code;
    const signal = errorMeta.signal;
    throw toSourceError({
      source: "sops",
      kind: code === "ENOENT"
        ? "command-not-found"
        : signal === "SIGTERM"
          ? "timeout"
          : "decrypt-failed",
      key: opts.key,
    });
  }

  const value = String(raw).trim();
  if (value === "") {
    throw toSourceError({ source: "sops", kind: "blank", key: opts.key });
  }
  return value;
}

export function resolveSecret(opts: ResolveSecretOptions): string {
  const failures: SecretSourceFailure[] = [];

  if (opts.sopsKey !== undefined) {
    if (!opts.sopsFile) {
      failures.push({ source: "sops", kind: "missing-file", key: opts.sopsKey });
    } else {
      try {
        return readSopsSecret({
          file: opts.sopsFile,
          key: opts.sopsKey,
          execFileSync: opts.execFileSync,
        });
      } catch (err) {
        if (err instanceof SecretSourceError) {
          failures.push(err.failure);
        } else {
          failures.push({ source: "sops", kind: "decrypt-failed", key: opts.sopsKey });
        }
      }
    }
  }

  if (opts.envVar) {
    const value = (opts.env ?? process.env)[opts.envVar];
    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
    failures.push({
      source: "env",
      kind: value === undefined ? "unset" : "blank",
      envVar: opts.envVar,
    });
  }

  if (failures.length === 0) {
    failures.push({ source: "sops", kind: "not-configured" });
    failures.push({ source: "env", kind: "not-configured" });
  }

  throw new SecretResolutionError(opts.fieldName, failures);
}
