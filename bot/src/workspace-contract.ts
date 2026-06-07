import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MINIME_WORKSPACE_ROOT_ENV = "MINIME_WORKSPACE_ROOT";
export const MINIME_CONFIG_PATH_ENV = "MINIME_CONFIG_PATH";
export const MINIME_CRONS_PATH_ENV = "MINIME_CRONS_PATH";

export type WorkspacePathSource =
  | "cli"
  | "env"
  | "current-repo-fallback"
  | "cwd-fallback"
  | "workspace-default"
  | "package-default"
  | "runtime-default";

export interface WorkspacePathDiagnostic {
  path: string;
  source: WorkspacePathSource;
}

export interface WorkspaceContractPaths {
  /** Installed/source package root that owns runtime code and bundled extensions. */
  packageRoot: string;
  botRoot: string;
  /** Control/app workspace root selected by --workspace or MINIME_WORKSPACE_ROOT. */
  controlWorkspaceRoot: string;
  /** Backwards-compatible alias for controlWorkspaceRoot. */
  workspaceRoot: string;
  configPath: string;
  cronsPath: string;
  piExtensionDir: string;
  dataDir: string;
  sessionStorePath: string;
  logDir: string;
  mediaBaseDir: string;
  runtimeDir: string;
}

export type WorkspaceContractPathName = keyof WorkspaceContractPaths;

export type WorkspaceContractEffectivePaths = {
  [K in WorkspaceContractPathName]: WorkspacePathDiagnostic;
};

export interface ResolvedWorkspaceContract {
  paths: WorkspaceContractPaths;
  effectivePaths: WorkspaceContractEffectivePaths;
  warnings: string[];
}

export interface ResolveWorkspaceContractOptions {
  /** Explicit CLI --workspace value. Relative paths resolve against cwd. */
  workspace?: string;
  /** Env overrides. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Process cwd used for relative CLI/env paths. Defaults to process.cwd(). */
  cwd?: string;
  /** Module URL used to infer package root. Defaults to this module URL. */
  moduleUrl?: string;
  /** Home directory used for runtime defaults. Defaults to os.homedir(). */
  homeDir?: string;
  /** Process id used for the test media dir convention. Defaults to process.pid. */
  pid?: number;
}

const thisModuleUrl = import.meta.url;

function absolutePath(value: string, base: string): string {
  return normalize(resolve(base, value));
}

function optionalEnvPath(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function inferPackageRoot(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const dirName = basename(moduleDir);
  if (dirName === "src" || dirName === "dist") {
    return normalize(resolve(moduleDir, ".."));
  }
  return normalize(moduleDir);
}

function inferPiExtensionDir(packageRoot: string, moduleUrl: string): WorkspacePathDiagnostic {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  if (basename(moduleDir) === "dist") {
    return {
      path: normalize(resolve(packageRoot, "dist", "extensions", "pi")),
      source: "package-default",
    };
  }
  return {
    path: normalize(resolve(packageRoot, ".claude", "extensions")),
    source: "package-default",
  };
}

function controlWorkspaceRootFromOptions(
  options: Required<Pick<ResolveWorkspaceContractOptions, "cwd" | "env">> & {
    packageRoot: string;
    workspace?: string;
  },
): { diagnostic: WorkspacePathDiagnostic; warnings: string[] } {
  const cliWorkspace = options.workspace?.trim();
  if (cliWorkspace) {
    return {
      diagnostic: { path: absolutePath(cliWorkspace, options.cwd), source: "cli" },
      warnings: [],
    };
  }

  const envWorkspace = optionalEnvPath(options.env, MINIME_WORKSPACE_ROOT_ENV);
  if (envWorkspace) {
    return {
      diagnostic: { path: absolutePath(envWorkspace, options.cwd), source: "env" },
      warnings: [],
    };
  }

  if (basename(options.packageRoot) !== "bot") {
    return {
      diagnostic: { path: options.cwd, source: "cwd-fallback" },
      warnings: [
        `No control workspace root was supplied; using cwd (${options.cwd}). Pass --workspace or ` +
          `${MINIME_WORKSPACE_ROOT_ENV} when running from a package install.`,
      ],
    };
  }

  return {
    diagnostic: {
      path: normalize(resolve(options.packageRoot, "..")),
      source: "current-repo-fallback",
    },
    warnings: [],
  };
}

function pathOverrideOrWorkspaceDefault(
  env: NodeJS.ProcessEnv,
  envKey: string,
  controlWorkspaceRoot: string,
  defaultFileName: string,
): WorkspacePathDiagnostic {
  const override = optionalEnvPath(env, envKey);
  if (override) {
    return { path: absolutePath(override, controlWorkspaceRoot), source: "env" };
  }
  return {
    path: normalize(resolve(controlWorkspaceRoot, defaultFileName)),
    source: "workspace-default",
  };
}

function runtimePath(value: string, base: string, source: WorkspacePathSource): WorkspacePathDiagnostic {
  return { path: absolutePath(value, base), source };
}

export function resolveWorkspaceContract(
  options: ResolveWorkspaceContractOptions = {},
): ResolvedWorkspaceContract {
  const env = options.env ?? process.env;
  const cwd = normalize(options.cwd ? resolve(options.cwd) : process.cwd());
  const moduleUrl = options.moduleUrl ?? thisModuleUrl;
  const homeDir = normalize(options.homeDir ?? homedir());
  const pid = options.pid ?? process.pid;
  const packageRoot = inferPackageRoot(moduleUrl);
  const botRoot = packageRoot;

  const packageRootDiag: WorkspacePathDiagnostic = {
    path: packageRoot,
    source: "package-default",
  };
  const botRootDiag: WorkspacePathDiagnostic = {
    path: botRoot,
    source: "package-default",
  };
  const workspaceRootResult = controlWorkspaceRootFromOptions({
    cwd,
    env,
    packageRoot,
    workspace: options.workspace,
  });
  const workspaceRootDiag = workspaceRootResult.diagnostic;
  const configPathDiag = pathOverrideOrWorkspaceDefault(
    env,
    MINIME_CONFIG_PATH_ENV,
    workspaceRootDiag.path,
    "config.yaml",
  );
  const cronsPathDiag = pathOverrideOrWorkspaceDefault(
    env,
    MINIME_CRONS_PATH_ENV,
    workspaceRootDiag.path,
    "crons.yaml",
  );
  const piExtensionDirDiag = inferPiExtensionDir(packageRoot, moduleUrl);
  const dataDirDiag: WorkspacePathDiagnostic = {
    path: normalize(resolve(workspaceRootDiag.path, "data")),
    source: "workspace-default",
  };
  const sessionStoreDataDirDiag =
    workspaceRootDiag.source === "current-repo-fallback"
      ? {
          path: normalize(resolve(botRoot, "data")),
          source: "current-repo-fallback" as const,
        }
      : dataDirDiag;
  const sessionStorePathDiag: WorkspacePathDiagnostic = {
    path: normalize(resolve(sessionStoreDataDirDiag.path, "sessions.json")),
    source: sessionStoreDataDirDiag.source,
  };
  const logDirOverride = env.LOG_DIR?.trim();
  const logDirDiag = runtimePath(
    logDirOverride || join(homeDir, ".minime", "logs"),
    cwd,
    logDirOverride ? "env" : "runtime-default",
  );
  const mediaBaseOverride = env.MINIME_TEST_MEDIA_BASE?.trim();
  const mediaBaseDirDiag = runtimePath(
    mediaBaseOverride ? join(mediaBaseOverride, String(pid)) : "/tmp/bot-media",
    cwd,
    mediaBaseOverride ? "env" : "runtime-default",
  );
  const runtimeDirDiag: WorkspacePathDiagnostic = {
    path: normalize(resolve(workspaceRootDiag.path, ".tmp")),
    source: "workspace-default",
  };

  const effectivePaths: WorkspaceContractEffectivePaths = {
    packageRoot: packageRootDiag,
    botRoot: botRootDiag,
    controlWorkspaceRoot: workspaceRootDiag,
    workspaceRoot: workspaceRootDiag,
    configPath: configPathDiag,
    cronsPath: cronsPathDiag,
    piExtensionDir: piExtensionDirDiag,
    dataDir: dataDirDiag,
    sessionStorePath: sessionStorePathDiag,
    logDir: logDirDiag,
    mediaBaseDir: mediaBaseDirDiag,
    runtimeDir: runtimeDirDiag,
  };

  return {
    paths: Object.fromEntries(
      Object.entries(effectivePaths).map(([key, value]) => [key, value.path]),
    ) as unknown as WorkspaceContractPaths,
    effectivePaths,
    warnings: workspaceRootResult.warnings,
  };
}

export function workspaceContractDiagnostics(
  contract: ResolvedWorkspaceContract,
): WorkspaceContractEffectivePaths {
  return contract.effectivePaths;
}

export function resolveAgentWorkspaceCwd(controlWorkspaceRoot: string, workspaceCwd: string): string {
  return normalize(isAbsolute(workspaceCwd) ? workspaceCwd : resolve(controlWorkspaceRoot, workspaceCwd));
}
