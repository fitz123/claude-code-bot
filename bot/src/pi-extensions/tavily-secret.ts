import { resolve } from "node:path";
import { readSopsSecret, type ExecFileSyncLike } from "../secrets.js";
import { TAVILY_SOPS_FILE_RELPATH, TAVILY_SOPS_KEY } from "./tavily-constants.js";

export { TAVILY_SOPS_FILE_RELPATH, TAVILY_SOPS_KEY } from "./tavily-constants.js";

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
