import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyToolCall } from "../pi-extensions/guard.js";
import {
  readWriteAllowlistEntriesForGuard,
  resolveWriteAllowlistSchemaPath,
} from "../pi-extensions/write-allowlist-schema.js";
import { validateWorkspaceContract, workspaceValidationErrors } from "../workspace-validator.js";
import {
  MINIME_SCHEMA_PATH_ENV,
  resolveWorkspaceContract,
} from "../workspace-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = resolve(__dirname, "..", "..");
const MINIMAL_WORKSPACE_FIXTURE = join(BOT_ROOT, "test-fixtures", "minimal-workspace");

const fixtures: string[] = [];

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createWorkspace(options: {
  schema?: string | null;
  extraFiles?: Record<string, string>;
  workspaceCwd?: string;
} = {}): string {
  const workspace = mkdtempSync(join(tmpdir(), "minime-validator-workspace-"));
  fixtures.push(workspace);
  mkdirSync(join(workspace, "agent-workspace"), { recursive: true });
  writeFileSync(
    join(workspace, "config.yaml"),
    [
      "agents:",
      "  main:",
      `    workspaceCwd: ${options.workspaceCwd ?? "./agent-workspace"}`,
      "    model: gpt-5.5",
      "telegramTokenEnv: MINIME_FIXTURE_TELEGRAM_TOKEN",
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

  if (options.schema !== null) {
    writeFileSync(join(workspace, "schema.md"), options.schema ?? validSchema(["agent-workspace/", "*.md", "schema.md"]));
  }

  for (const [rel, content] of Object.entries(options.extraFiles ?? {})) {
    const path = join(workspace, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  return workspace;
}

function validSchema(entries: readonly string[]): string {
  return [
    "# Workspace schema",
    "",
    "```write-allowlist",
    ...entries,
    "```",
    "",
  ].join("\n");
}

function validate(workspace: string, env: NodeJS.ProcessEnv = {}) {
  const contract = resolveWorkspaceContract({ workspace, cwd: workspace, env });
  return validateWorkspaceContract(contract, { env });
}

function createSiblingWorkspaceFixture(): {
  root: string;
  controlWorkspace: string;
  agentMain: string;
  agentReviewer: string;
} {
  const root = mkdtempSync(join(tmpdir(), "minime-validator-sibling-layout-"));
  fixtures.push(root);
  const controlWorkspace = join(root, "control-workspace");
  const agentMain = join(root, "agent-workspace-main");
  const agentReviewer = join(root, "agent-workspace-reviewer");
  mkdirSync(controlWorkspace, { recursive: true });
  mkdirSync(agentMain, { recursive: true });
  mkdirSync(agentReviewer, { recursive: true });
  writeFileSync(
    join(controlWorkspace, "config.yaml"),
    [
      "agents:",
      "  main:",
      `    workspaceCwd: ${agentMain}`,
      "    model: gpt-5.5",
      "  reviewer:",
      `    workspaceCwd: ${agentReviewer}`,
      "    model: gpt-5.5",
      "telegramTokenEnv: MINIME_FIXTURE_TELEGRAM_TOKEN",
      "bindings:",
      "  - chatId: 111",
      "    agentId: main",
      "    kind: dm",
      "  - chatId: 222",
      "    agentId: reviewer",
      "    kind: dm",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(controlWorkspace, "crons.yaml"),
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
  writeFileSync(join(controlWorkspace, "schema.md"), validSchema(["*.md", "schema.md"]));
  return { root, controlWorkspace, agentMain, agentReviewer };
}

function guardBlocks(workspaceRoot: string, schemaPath: string, relPath: string): boolean {
  const entries = readWriteAllowlistEntriesForGuard(schemaPath);
  return classifyToolCall(
    { toolName: "write", input: { path: relPath } },
    { workspaceRoot, writeAllowlist: entries },
  ).block;
}

describe("workspace validator schema parity with the live guard parser", () => {
  it("validates the tracked fixture from a package-installed-like layout", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "minime-validator-installed-"));
    fixtures.push(projectDir);
    const packageRoot = join(projectDir, "node_modules", "minime");
    const artifactExtensionDir = join(packageRoot, "dist", "extensions", "pi");
    mkdirSync(artifactExtensionDir, { recursive: true });
    const moduleUrl = pathToFileURL(join(packageRoot, "dist", "workspace-contract.js")).href;
    const contract = resolveWorkspaceContract({
      workspace: MINIMAL_WORKSPACE_FIXTURE,
      cwd: projectDir,
      moduleUrl,
      env: {},
    });

    const result = validateWorkspaceContract(contract, { env: {} });

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.strictEqual(result.contract.effectivePaths.workspaceRoot.source, "cli");
    assert.strictEqual(result.contract.paths.piExtensionDir, artifactExtensionDir);
    assert.deepStrictEqual(result.schema?.entries, ["agent-workspace/", "*.md", "schema.md"]);
    assert.strictEqual(result.crons?.length, 1);
  });

  it("valid schema: validator entries match guard entries and guard verdicts", () => {
    const workspace = createWorkspace();
    const result = validate(workspace);
    const guardEntries = readWriteAllowlistEntriesForGuard(result.contract.paths.schemaPath);

    assert.deepStrictEqual(result.schema?.entries, guardEntries);
    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(guardBlocks(workspace, result.contract.paths.schemaPath, "agent-workspace/note.md"), false);
    assert.equal(guardBlocks(workspace, result.contract.paths.schemaPath, "unregistered/file.txt"), true);
  });

  it("accepts an absolute agent workspaceCwd outside the control workspace root", () => {
    const externalWorkspace = mkdtempSync(join(tmpdir(), "minime-validator-external-agent-"));
    fixtures.push(externalWorkspace);
    const workspace = createWorkspace({ workspaceCwd: externalWorkspace });
    const result = validate(workspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(result.config?.agents.main.workspaceCwd, externalWorkspace);
  });

  it("accepts a symlinked agent workspaceCwd that resolves outside the control workspace root", () => {
    const externalWorkspace = mkdtempSync(join(tmpdir(), "minime-validator-external-agent-"));
    fixtures.push(externalWorkspace);
    const workspace = createWorkspace();
    const agentWorkspace = join(workspace, "agent-workspace");
    rmSync(agentWorkspace, { recursive: true, force: true });
    symlinkSync(externalWorkspace, agentWorkspace, "dir");

    const result = validate(workspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
  });

  it("accepts sibling control and agent workspace roots with multiple agents", () => {
    const { controlWorkspace, agentMain, agentReviewer } = createSiblingWorkspaceFixture();
    const result = validate(controlWorkspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(result.contract.paths.controlWorkspaceRoot, controlWorkspace);
    assert.equal(result.config?.agents.main.workspaceCwd, agentMain);
    assert.equal(result.config?.agents.reviewer.workspaceCwd, agentReviewer);
  });

  it("rejects a missing configured agent workspaceCwd", () => {
    const workspace = createWorkspace({ workspaceCwd: "./missing-agent-workspace" });
    const result = validate(workspace);

    assert.match(
      workspaceValidationErrors(result).map((item) => item.message).join("\n"),
      /agent "main" workspaceCwd does not exist/,
    );
  });

  it("rejects a configured agent workspaceCwd that is not a directory", () => {
    const workspace = createWorkspace({
      workspaceCwd: "./not-a-directory",
      extraFiles: { "not-a-directory": "not a directory" },
    });
    const result = validate(workspace);

    assert.match(
      workspaceValidationErrors(result).map((item) => item.message).join("\n"),
      /agent "main" workspaceCwd is not a directory/,
    );
  });

  it("missing schema: validator fails hard and the guard parser fails closed", () => {
    const workspace = createWorkspace({ schema: null });
    const result = validate(workspace);

    assert.match(workspaceValidationErrors(result).map((item) => item.message).join("\n"), /schema file does not exist/);
    assert.deepStrictEqual(result.schema?.entries, []);
    assert.deepStrictEqual(readWriteAllowlistEntriesForGuard(result.contract.paths.schemaPath), []);
    assert.equal(guardBlocks(workspace, result.contract.paths.schemaPath, "agent-workspace/note.md"), true);
  });

  it("empty schema block: validator fails hard and guard parser fails closed", () => {
    const workspace = createWorkspace({ schema: validSchema(["# only a comment"]) });
    const result = validate(workspace);

    assert.match(workspaceValidationErrors(result).map((item) => item.message).join("\n"), /empty/);
    assert.deepStrictEqual(result.schema?.entries, []);
    assert.deepStrictEqual(readWriteAllowlistEntriesForGuard(result.contract.paths.schemaPath), []);
    assert.equal(guardBlocks(workspace, result.contract.paths.schemaPath, "agent-workspace/note.md"), true);
  });

  it("malformed schema block: validator fails hard and guard parser fails closed", () => {
    const workspace = createWorkspace({
      schema: [
        "# Workspace schema",
        "",
        "```write-allowlist",
        "agent-workspace/",
        "",
      ].join("\n"),
    });
    const result = validate(workspace);

    assert.match(workspaceValidationErrors(result).map((item) => item.message).join("\n"), /closing fence/);
    assert.deepStrictEqual(result.schema?.entries, []);
    assert.deepStrictEqual(readWriteAllowlistEntriesForGuard(result.contract.paths.schemaPath), []);
    assert.equal(guardBlocks(workspace, result.contract.paths.schemaPath, "agent-workspace/note.md"), true);
  });

  it("schema override: validator and guard use the same MINIME_SCHEMA_PATH", () => {
    const workspace = createWorkspace({
      schema: validSchema(["default-only/"]),
      extraFiles: {
        "schemas/override.md": validSchema(["agent-workspace/", "schema.md"]),
      },
    });
    const env = { [MINIME_SCHEMA_PATH_ENV]: "schemas/override.md" };
    const result = validate(workspace, env);
    const guardSchemaPath = resolveWriteAllowlistSchemaPath(workspace, env);

    assert.equal(result.contract.paths.schemaPath, guardSchemaPath);
    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.deepStrictEqual(
      result.schema?.entries,
      readWriteAllowlistEntriesForGuard(guardSchemaPath),
    );
    assert.equal(guardBlocks(workspace, guardSchemaPath, "agent-workspace/note.md"), false);
    assert.equal(guardBlocks(workspace, guardSchemaPath, "default-only/file.txt"), true);
  });
});
