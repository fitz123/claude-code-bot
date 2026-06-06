import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = resolve(__dirname, "..", "..");
const EXPECTED_BUNDLED_AGENT_FILES = ["planner.md", "reviewer.md", "scout.md", "worker.md"];
const EXPECTED_BUNDLED_PROMPT_FILES = ["implement-and-review.md", "implement.md", "scout-and-plan.md"];

interface PackedFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackedFile[];
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_loglevel: "error",
    ...extra,
  };
}

function parseNpmPackJson(stdout: string): PackResult {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.lastIndexOf("\n[");
  const jsonText = jsonStart === -1 ? trimmed : trimmed.slice(jsonStart + 1);
  const parsed = JSON.parse(jsonText) as PackResult[];
  assert.equal(parsed.length, 1);
  return parsed[0];
}

function runNpmPack(args: readonly string[], cwd = BOT_ROOT): PackResult {
  const result = spawnSync("npm", ["pack", "--json", ...args], {
    cwd,
    encoding: "utf8",
    env: commandEnv(),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return parseNpmPackJson(result.stdout);
}

function createWorkspace(root: string): string {
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "agent-workspace"), { recursive: true });
  mkdirSync(join(workspace, "config"), { recursive: true });
  writeFileSync(join(workspace, "config", "secrets.sops.yaml"), "placeholder: true\n", "utf8");
  writeFileSync(
    join(workspace, "config.yaml"),
    [
      "agents:",
      "  main:",
      "    workspaceCwd: ./agent-workspace",
      "    model: gpt-5.5",
      "secrets:",
      "  sopsFile: missing.sops.yaml",
      "telegramTokenSopsKey: telegram.bot_token",
      "bindings:",
      "  - chatId: 111",
      "    agentId: main",
      "    kind: dm",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(workspace, "crons.yaml"),
    [
      "crons:",
      "  - name: smoke",
      "    schedule: \"0 9 * * *\"",
      "    prompt: smoke",
      "    agentId: main",
      "    deliveryChatId: 111",
      "",
    ].join("\n"),
  );
  return workspace;
}

function collectSchemaFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSchemaFiles(path));
    } else if (entry.isFile() && entry.name === "schema.md") {
      found.push(path);
    }
  }
  return found;
}

function runInstalledBin(projectDir: string, args: readonly string[], workspace: string): SpawnSyncReturns<string> {
  return spawnSync(join(projectDir, "node_modules", ".bin", "minime-bot"), args, {
    cwd: projectDir,
    encoding: "utf8",
    env: commandEnv({
      MINIME_WORKSPACE_ROOT: workspace,
    }),
  });
}

function assertPackFiles(files: readonly string[]): void {
  for (const expected of [
    "dist/cli.js",
    "dist/config.js",
    "dist/cron-runner.js",
    "dist/pi-rpc-protocol.js",
    "dist/workspace-contract.js",
    "dist/workspace-validator.js",
    "dist/pi-extensions/subagent-args.js",
    "dist/pi-extensions/tavily.js",
    "dist/pi-extensions/tavily-secret.js",
    "dist/extensions/pi/web-tools.js",
    "dist/extensions/pi/subagent/agents.js",
    "dist/extensions/pi/subagent/index.js",
    "scripts/deliver.sh",
    ...EXPECTED_BUNDLED_AGENT_FILES.map((file) => `dist/extensions/pi/subagent/agents/${file}`),
    ...EXPECTED_BUNDLED_PROMPT_FILES.map((file) => `dist/extensions/pi/subagent/prompts/${file}`),
  ]) {
    assert.ok(files.includes(expected), `expected npm pack to include ${expected}`);
  }

  assert.ok(!files.some((file) => file.includes("guardian-protect-files")), "guard extension should not be packed");
  assert.ok(!files.some((file) => file.startsWith("src/")), "source TS should not be packed");
  assert.ok(!files.some((file) => file.startsWith(".claude/")), "source extension wrappers should not be packed");
  assert.ok(!files.some((file) => file.startsWith("test-fixtures/")), "workspace fixtures should not be packed");
  assert.ok(!files.some((file) => file.startsWith("dist/__tests__/")), "compiled tests should not be packed");
}

describe("package artifact install", () => {
  it("npm pack --dry-run includes runtime artifacts and excludes source workspace files", { timeout: 120_000 }, () => {
    const staleFiles = [
      join(BOT_ROOT, "dist", "stale-pack-artifact.js"),
      join(BOT_ROOT, "dist", "stale-pack-artifact.d.ts"),
    ];
    mkdirSync(join(BOT_ROOT, "dist"), { recursive: true });
    for (const staleFile of staleFiles) {
      writeFileSync(staleFile, "throw new Error('stale artifact should not be packed');\n", "utf8");
    }

    try {
      const dryRun = runNpmPack(["--dry-run"]);
      const files = dryRun.files.map((file) => file.path);
      assertPackFiles(files);
      assert.ok(!files.includes("dist/stale-pack-artifact.js"), "stale dist JS should not be packed");
      assert.ok(!files.includes("dist/stale-pack-artifact.d.ts"), "stale dist declarations should not be packed");
    } finally {
      for (const staleFile of staleFiles) {
        try {
          unlinkSync(staleFile);
        } catch {
          // npm prepack removes these when the clean build path is working.
        }
      }
    }
  });

  it("installs the packed package and runs CLI plus generated Pi wrappers", { timeout: 180_000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), "minime-package-install-"));
    const packDir = join(temp, "pack");
    const projectDir = join(temp, "project");
    mkdirSync(packDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const workspace = createWorkspace(temp);
    assert.deepEqual(collectSchemaFiles(workspace), [], "installed workspace fixture must not contain schema.md");

    try {
      const pack = runNpmPack(["--pack-destination", packDir]);
      assertPackFiles(pack.files.map((file) => file.path));
      const tarball = join(packDir, pack.filename);
      assert.ok(existsSync(tarball), `expected tarball at ${tarball}`);

      writeFileSync(join(projectDir, "package.json"), "{\"type\":\"module\"}\n");
      const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
        cwd: projectDir,
        encoding: "utf8",
        env: commandEnv(),
      });
      assert.equal(install.status, 0, install.stderr || install.stdout);

      const help = runInstalledBin(projectDir, ["--help"], workspace);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /minime-bot workspace validate --workspace <path>/);

      const configValidate = runInstalledBin(projectDir, ["config", "validate", "--workspace", workspace], workspace);
      assert.equal(configValidate.status, 0, configValidate.stderr);
      assert.match(configValidate.stdout, /Config valid\./);
      assert.doesNotMatch(configValidate.stdout, /telegram\.bot_token/);

      const workspaceValidate = runInstalledBin(projectDir, ["workspace", "validate", "--workspace", workspace], workspace);
      assert.equal(workspaceValidate.status, 0, workspaceValidate.stderr);
      assert.match(workspaceValidate.stdout, /Workspace valid\./);
      assert.match(workspaceValidate.stdout, /Pi extension dir: .*node_modules\/minime\/dist\/extensions\/pi/);

      const artifactCheck = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", INSTALLED_ARTIFACT_CHECK],
        {
          cwd: projectDir,
          encoding: "utf8",
          env: commandEnv({
            FIXTURE_WORKSPACE: workspace,
            MINIME_WORKSPACE_ROOT: workspace,
            SOURCE_BOT_ROOT: BOT_ROOT,
          }),
        },
      );
      assert.equal(artifactCheck.status, 0, artifactCheck.stderr || artifactCheck.stdout);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

const INSTALLED_ARTIFACT_CHECK = String.raw`
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.FIXTURE_WORKSPACE;
const sourceBotRoot = process.env.SOURCE_BOT_ROOT;
assert.ok(workspace, "FIXTURE_WORKSPACE is required");
assert.ok(sourceBotRoot, "SOURCE_BOT_ROOT is required");

const projectDir = process.cwd();
const packageDir = join(projectDir, "node_modules", "minime");
const artifactDir = join(packageDir, "dist", "extensions", "pi");
const agentWorkspace = join(workspace, "agent-workspace");
const controlTavilySopsFile = join(workspace, "config", "secrets.sops.yaml");
const importFile = (path) => import(pathToFileURL(path).href);
const importPackageFile = (relpath) => importFile(join(packageDir, relpath));
const expectedBundledAgentFiles = ${JSON.stringify(EXPECTED_BUNDLED_AGENT_FILES)};
const expectedBundledPromptFiles = ${JSON.stringify(EXPECTED_BUNDLED_PROMPT_FILES)};

function extensionPathsFromArgs(args) {
  const paths = [];
  for (let idx = 0; idx < args.length; idx += 2) {
    assert.equal(args[idx], "--extension");
    assert.equal(typeof args[idx + 1], "string");
    paths.push(args[idx + 1]);
  }
  return paths;
}

function assertNoGuardContract(label, args) {
  assert.doesNotMatch(JSON.stringify(args), /guardian-protect-files/, label);
}

const piRpc = await importPackageFile("dist/pi-rpc-protocol.js");
const parentExtensionArgs = piRpc.resolvePiExtensionArgs({ env: {} });
const extensionPaths = extensionPathsFromArgs(parentExtensionArgs);
assert.deepEqual(
  extensionPaths.map((path) => relative(artifactDir, path)),
  ["web-tools.js", "subagent/index.js"],
);
assertNoGuardContract("parent Pi extension args must not load the retired guard", parentExtensionArgs);

const subagentChildExtensionArgs = piRpc.resolvePiExtensionArgs({
  env: {},
  relpaths: piRpc.PI_SUBAGENT_CHILD_WRAPPER_RELPATHS,
});
assert.deepEqual(
  extensionPathsFromArgs(subagentChildExtensionArgs).map((path) => relative(artifactDir, path)),
  ["web-tools.js"],
);
assertNoGuardContract("subagent child extension args must not load the retired guard", subagentChildExtensionArgs);

const cronExtensionArgs = piRpc.resolvePiExtensionArgs({
  env: {},
  relpaths: piRpc.PI_CRON_WRAPPER_RELPATHS,
});
assert.deepEqual(cronExtensionArgs, []);
assertNoGuardContract("cron Pi extension args must not load the retired guard", cronExtensionArgs);

for (const extensionPath of extensionPaths) {
  assert.ok(extensionPath.startsWith(artifactDir + "/"), extensionPath);
  assert.equal(extensionPath.startsWith(sourceBotRoot), false);
  const mod = await importFile(extensionPath);
  assert.equal(typeof mod.default, "function", extensionPath);
}

const configMod = await importPackageFile("dist/config.js");
const loadedConfig = configMod.loadConfig(join(workspace, "config.yaml"), {
  resolveSecrets: false,
  workspaceRoot: workspace,
});
assert.equal(loadedConfig.agents.main.workspaceCwd, agentWorkspace);
const childEnv = piRpc.buildPiSpawnEnv(loadedConfig.agents.main);
assert.equal(childEnv.MINIME_WORKSPACE_ROOT, workspace);
assert.equal(childEnv.TELEGRAM_BOT_TOKEN, undefined);
assert.equal(childEnv.DISCORD_BOT_TOKEN, undefined);
assert.equal(childEnv.TAVILY_API_KEY, undefined);

const workspaceContract = await importPackageFile("dist/workspace-contract.js");
const validator = await importPackageFile("dist/workspace-validator.js");

const defaultContract = workspaceContract.resolveWorkspaceContract({
  workspace,
  cwd: projectDir,
  env: {},
});
const defaultResult = validator.validateWorkspaceContract(defaultContract);
assert.equal(validator.workspaceValidationErrors(defaultResult).length, 0);

const registeredTools = [];
const registeredToolDefs = [];
const resourceHandlers = [];
const fakePi = {
  on(event, handler) {
    if (event === "resources_discover") {
      resourceHandlers.push(handler);
    }
  },
  registerTool(tool) {
    registeredTools.push(tool.name);
    registeredToolDefs.push(tool);
  },
};

const fakeBinDir = join(projectDir, "fake-bin");
const sopsArgvFile = join(projectDir, "sops-argv.txt");
mkdirSync(fakeBinDir, { recursive: true });
writeFileSync(
  join(fakeBinDir, "sops"),
  [
    "#!/bin/bash",
    "printf '%s\\n' \"$@\" > \"$SOPS_ARGV_FILE\"",
    "printf 'tvly-installed-wrapper-key\\n'",
    "",
  ].join("\n"),
  "utf8",
);
chmodSync(join(fakeBinDir, "sops"), 0o755);
process.env.PATH = fakeBinDir + ":" + process.env.PATH;
process.env.SOPS_ARGV_FILE = sopsArgvFile;

const callerControlledCwd = join(projectDir, "caller-controlled-subagent-cwd");
mkdirSync(callerControlledCwd, { recursive: true });
process.chdir(callerControlledCwd);
const subagentChildEnv = piRpc.buildPiSubagentChildSpawnEnv();
assert.equal(process.cwd(), callerControlledCwd);
assert.equal(subagentChildEnv.MINIME_WORKSPACE_ROOT, workspace);
assert.equal(subagentChildEnv.TELEGRAM_BOT_TOKEN, undefined);
assert.equal(subagentChildEnv.DISCORD_BOT_TOKEN, undefined);
assert.equal(subagentChildEnv.TAVILY_API_KEY, undefined);

process.chdir(agentWorkspace);

const fetchCalls = [];
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: [] }),
    text: async () => "{\"results\":[]}",
  };
};

const webTools = await importFile(join(artifactDir, "web-tools.js"));
webTools.default(fakePi);
const subagent = await importFile(join(artifactDir, "subagent", "index.js"));
subagent.default(fakePi);
assert.deepEqual(
  registeredTools.filter((name) => ["web_search", "web_fetch", "subagent"].includes(name)).sort(),
  ["subagent", "web_fetch", "web_search"],
);

try {
  const searchTool = registeredToolDefs.find((tool) => tool.name === "web_search");
  assert.ok(searchTool, "web_search should be registered");
  const searchResult = await searchTool.execute("call-1", { query: "installed wrapper" });
  assert.equal(searchResult.details.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer tvly-installed-wrapper-key");
  assert.deepEqual(readFileSync(sopsArgvFile, "utf8").trim().split("\n"), [
    "-d",
    "--extract",
    "[\"tavily\"][\"api_key\"]",
    controlTavilySopsFile,
  ]);
} finally {
  globalThis.fetch = oldFetch;
}

const agentsMod = await importFile(join(artifactDir, "subagent", "agents.js"));
const discovery = agentsMod.discoverAgents(workspace, "project");
const bundledAgentNames = discovery.agents
  .filter((agent) => agent.source === "bundled")
  .map((agent) => agent.name)
  .sort();
assert.deepEqual(bundledAgentNames, expectedBundledAgentFiles.map((file) => file.slice(0, -".md".length)).sort());
const bundledWorker = discovery.agents.find((agent) => agent.name === "worker" && agent.source === "bundled");
assert.ok(bundledWorker, "expected bundled worker agent from installed artifact");
assert.ok(bundledWorker.filePath.startsWith(join(artifactDir, "subagent", "agents")));
assert.equal(bundledWorker.filePath.startsWith(sourceBotRoot), false);

assert.equal(resourceHandlers.length, 1);
const resources = resourceHandlers[0]();
assert.deepEqual(resources.promptPaths, [join(artifactDir, "subagent", "prompts")]);
assert.deepEqual(
  readdirSync(join(artifactDir, "subagent", "agents")).filter((file) => file.endsWith(".md")).sort(),
  expectedBundledAgentFiles,
);
assert.deepEqual(
  readdirSync(resources.promptPaths[0]).filter((file) => file.endsWith(".md")).sort(),
  expectedBundledPromptFiles,
);
for (const file of expectedBundledAgentFiles) {
  assert.ok(existsSync(join(artifactDir, "subagent", "agents", file)), file);
}
for (const file of expectedBundledPromptFiles) {
  assert.ok(existsSync(join(resources.promptPaths[0], file)), file);
}
`;
