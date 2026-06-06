import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MINIME_CONFIG_PATH_ENV,
  MINIME_CRONS_PATH_ENV,
  MINIME_WORKSPACE_ROOT_ENV,
  resolveWorkspaceContract,
  workspaceContractDiagnostics,
  type WorkspaceContractPaths,
} from "../workspace-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(BOT_ROOT, "..");

function assertAbsolutePaths(paths: WorkspaceContractPaths): void {
  for (const [name, path] of Object.entries(paths)) {
    assert.ok(isAbsolute(path), `${name} should be absolute: ${path}`);
    assert.strictEqual(path, normalize(path), `${name} should be normalized`);
  }
}

describe("workspace contract resolver", () => {
  it("preserves the current source checkout path layout by default", () => {
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/ignored-cwd",
      env: {},
      homeDir: "/tmp/minime-home",
      pid: 12345,
    });

    assertAbsolutePaths(contract.paths);
    assert.strictEqual(contract.paths.packageRoot, BOT_ROOT);
    assert.strictEqual(contract.paths.botRoot, BOT_ROOT);
    assert.strictEqual(contract.paths.controlWorkspaceRoot, REPO_ROOT);
    assert.strictEqual(contract.paths.workspaceRoot, REPO_ROOT);
    assert.strictEqual(contract.paths.configPath, resolve(REPO_ROOT, "config.yaml"));
    assert.strictEqual(contract.paths.cronsPath, resolve(REPO_ROOT, "crons.yaml"));
    assert.strictEqual(contract.paths.piExtensionDir, resolve(BOT_ROOT, ".claude", "extensions"));
    assert.strictEqual(contract.paths.dataDir, resolve(REPO_ROOT, "data"));
    assert.strictEqual(contract.paths.sessionStorePath, resolve(BOT_ROOT, "data", "sessions.json"));
    assert.strictEqual(contract.effectivePaths.sessionStorePath.source, "current-repo-fallback");
    assert.strictEqual(contract.paths.logDir, "/tmp/minime-home/.minime/logs");
    assert.strictEqual(contract.paths.mediaBaseDir, "/tmp/bot-media");
    assert.strictEqual(contract.paths.runtimeDir, resolve(REPO_ROOT, ".tmp"));
    assert.strictEqual(contract.effectivePaths.workspaceRoot.source, "current-repo-fallback");
    assert.deepStrictEqual(contract.warnings, []);
  });

  it("uses package artifact Pi wrappers for a built source checkout", () => {
    const builtSourceModuleUrl = pathToFileURL(
      join(BOT_ROOT, "dist", "workspace-contract.js"),
    ).href;
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/ignored-cwd",
      env: {},
      moduleUrl: builtSourceModuleUrl,
      homeDir: "/tmp/minime-home",
    });

    assert.strictEqual(contract.paths.packageRoot, BOT_ROOT);
    assert.strictEqual(contract.paths.piExtensionDir, resolve(BOT_ROOT, "dist", "extensions", "pi"));
  });

  it("uses package artifact Pi wrappers for an installed package", () => {
    const installedModuleUrl = pathToFileURL(
      join(tmpdir(), "project", "node_modules", "minime", "dist", "workspace-contract.js"),
    ).href;
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/install-cwd",
      env: {},
      moduleUrl: installedModuleUrl,
      homeDir: "/tmp/minime-home",
    });

    assert.strictEqual(basename(contract.paths.packageRoot), "minime");
    assert.strictEqual(
      contract.paths.piExtensionDir,
      normalize(join(tmpdir(), "project", "node_modules", "minime", "dist", "extensions", "pi")),
    );
  });

  it("uses an explicit CLI workspace before MINIME_WORKSPACE_ROOT", () => {
    const cwd = mkdtempSync(join(tmpdir(), "minime-contract-cwd-"));
    const cliWorkspace = "cli-workspace";
    const envWorkspace = join(tmpdir(), "ignored-env-workspace");
    const contract = resolveWorkspaceContract({
      cwd,
      workspace: cliWorkspace,
      env: { [MINIME_WORKSPACE_ROOT_ENV]: envWorkspace },
      homeDir: "/tmp/minime-home",
    });

    assert.strictEqual(contract.paths.workspaceRoot, resolve(cwd, cliWorkspace));
    assert.strictEqual(contract.paths.controlWorkspaceRoot, resolve(cwd, cliWorkspace));
    assert.strictEqual(contract.effectivePaths.workspaceRoot.source, "cli");
    assert.strictEqual(contract.effectivePaths.controlWorkspaceRoot.source, "cli");
    assert.strictEqual(contract.paths.configPath, resolve(cwd, cliWorkspace, "config.yaml"));
  });

  it("uses MINIME_WORKSPACE_ROOT for workspace-relative defaults", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "minime-contract-workspace-"));
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/ignored-cwd",
      env: { [MINIME_WORKSPACE_ROOT_ENV]: workspaceRoot },
      homeDir: "/tmp/minime-home",
    });

    assertAbsolutePaths(contract.paths);
    assert.strictEqual(contract.paths.controlWorkspaceRoot, workspaceRoot);
    assert.strictEqual(contract.paths.workspaceRoot, workspaceRoot);
    assert.strictEqual(contract.effectivePaths.workspaceRoot.source, "env");
    assert.strictEqual(contract.paths.configPath, join(workspaceRoot, "config.yaml"));
    assert.strictEqual(contract.paths.cronsPath, join(workspaceRoot, "crons.yaml"));
    assert.strictEqual(contract.paths.dataDir, join(workspaceRoot, "data"));
    assert.strictEqual(contract.paths.runtimeDir, join(workspaceRoot, ".tmp"));
  });

  it("uses explicit config and crons path overrides", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "minime-contract-overrides-"));
    const absoluteCronsPath = join(workspaceRoot, "absolute", "crons.yaml");
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/ignored-cwd",
      env: {
        [MINIME_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CONFIG_PATH_ENV]: "custom/config.yaml",
        [MINIME_CRONS_PATH_ENV]: absoluteCronsPath,
        LOG_DIR: "/tmp/minime-logs",
        MINIME_TEST_MEDIA_BASE: "/tmp/minime-media",
      },
      homeDir: "/tmp/minime-home",
      pid: 6789,
    });

    assert.strictEqual(contract.paths.configPath, join(workspaceRoot, "custom", "config.yaml"));
    assert.strictEqual(contract.paths.cronsPath, absoluteCronsPath);
    assert.strictEqual(contract.paths.logDir, "/tmp/minime-logs");
    assert.strictEqual(contract.paths.mediaBaseDir, "/tmp/minime-media/6789");
    assert.strictEqual(contract.effectivePaths.configPath.source, "env");
    assert.strictEqual(contract.effectivePaths.cronsPath.source, "env");
  });

  it("does not guess a package install parent directory as the workspace", () => {
    const cwd = mkdtempSync(join(tmpdir(), "minime-contract-install-cwd-"));
    const installedModuleUrl = pathToFileURL(
      join(tmpdir(), "project", "node_modules", "minime", "dist", "workspace-contract.js"),
    ).href;
    const contract = resolveWorkspaceContract({
      cwd,
      env: {},
      moduleUrl: installedModuleUrl,
      homeDir: "/tmp/minime-home",
    });

    assert.strictEqual(basename(contract.paths.packageRoot), "minime");
    assert.strictEqual(contract.paths.workspaceRoot, cwd);
    assert.strictEqual(contract.effectivePaths.workspaceRoot.source, "cwd-fallback");
    assert.match(contract.warnings.join("\n"), /Pass --workspace or MINIME_WORKSPACE_ROOT/);
  });

  it("returns structured diagnostics without reading or echoing secret env values", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "minime-contract-diagnostics-"));
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/ignored-cwd",
      env: {
        [MINIME_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CONFIG_PATH_ENV]: "missing-config.yaml",
        TELEGRAM_TOKEN: "do-not-print-me",
        SOPS_AGE_KEY: "do-not-print-me-either",
      },
      homeDir: "/tmp/minime-home",
    });
    const diagnostics = workspaceContractDiagnostics(contract);
    const serialized = JSON.stringify({ diagnostics, warnings: contract.warnings });

    assert.strictEqual(diagnostics.configPath.path, join(workspaceRoot, "missing-config.yaml"));
    assert.doesNotMatch(serialized, /do-not-print-me/);
  });
});
