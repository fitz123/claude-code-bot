import { resolve } from "node:path";
import { readSopsSecret, type ExecFileSyncLike } from "../secrets.js";
import { MINIME_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";
import { TAVILY_SOPS_FILE_RELPATH, TAVILY_SOPS_KEY } from "./tavily-constants.js";

export { TAVILY_SOPS_FILE_RELPATH, TAVILY_SOPS_KEY } from "./tavily-constants.js";

export interface ReadTavilyApiKeyOptions {
  controlWorkspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  execFileSync?: ExecFileSyncLike;
}

export function tavilyControlWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env[MINIME_WORKSPACE_ROOT_ENV]?.trim();
  return root ? resolve(root) : undefined;
}

export function tavilySopsFilePath(controlWorkspaceRoot: string): string {
  return resolve(controlWorkspaceRoot, TAVILY_SOPS_FILE_RELPATH);
}

/** Read the Tavily key from the control-workspace SOPS file; never throws. */
export function readTavilyApiKeyFromSops(opts: ReadTavilyApiKeyOptions = {}): string | undefined {
  const controlWorkspaceRoot = opts.controlWorkspaceRoot ?? tavilyControlWorkspaceRoot(opts.env);
  if (!controlWorkspaceRoot) return undefined;

  try {
    return readSopsSecret({
      file: tavilySopsFilePath(controlWorkspaceRoot),
      key: TAVILY_SOPS_KEY,
      execFileSync: opts.execFileSync,
    });
  } catch {
    return undefined;
  }
}
