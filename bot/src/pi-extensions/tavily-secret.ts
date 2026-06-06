import { resolve } from "node:path";
import { readSopsSecret, type ExecFileSyncLike } from "../secrets.js";

export const TAVILY_SOPS_FILE_RELPATH = "config/secrets.sops.yaml";
export const TAVILY_SOPS_KEY = "tavily.api_key";

export interface ReadTavilyApiKeyOptions {
  cwd?: string;
  execFileSync?: ExecFileSyncLike;
}

export function tavilySopsFilePath(cwd: string = process.cwd()): string {
  return resolve(cwd, TAVILY_SOPS_FILE_RELPATH);
}

/** Read the Tavily key from the workspace-private SOPS file; never throws. */
export function readTavilyApiKeyFromSops(opts: ReadTavilyApiKeyOptions = {}): string | undefined {
  try {
    return readSopsSecret({
      file: tavilySopsFilePath(opts.cwd),
      key: TAVILY_SOPS_KEY,
      execFileSync: opts.execFileSync,
    });
  } catch {
    return undefined;
  }
}
