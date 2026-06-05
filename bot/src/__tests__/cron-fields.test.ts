import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCronForPlist, type CronPlistDef } from "../cron-plist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("cron field documentation", () => {
  const readme = readRepoFile("README.md");

  const cronFields = [
    "type",
    "engine",
    "timeout",
    "deliveryThreadId",
    "enabled",
  ];

  for (const field of cronFields) {
    it(`README documents cron field: ${field}`, () => {
      assert.ok(
        readme.includes(`\`${field}\``),
        `README.md does not document cron field '${field}'`
      );
    });
  }

  it("README has a cron field reference table", () => {
    assert.ok(
      readme.includes("Cron field reference"),
      "README.md missing 'Cron field reference' section"
    );
  });

  it("crons.yaml demonstrates deliveryThreadId", () => {
    const example = readRepoFile("crons.yaml");
    assert.ok(
      example.includes("deliveryThreadId"),
      "crons.yaml does not demonstrate deliveryThreadId"
    );
  });

  it("crons.yaml demonstrates enabled field", () => {
    const example = readRepoFile("crons.yaml");
    assert.ok(
      example.includes("enabled"),
      "crons.yaml does not demonstrate enabled field"
    );
  });

  it("crons.yaml documents engine and the 15-minute timeout default", () => {
    const example = readRepoFile("crons.yaml");
    assert.ok(example.includes("engine"), "crons.yaml does not document engine");
    assert.ok(example.includes("900000 = 15 min"), "crons.yaml does not document the 15-minute cron timeout default");
  });

  it("README documents Pi engine behavior and cron health metrics", () => {
    assert.ok(readme.includes("engine: pi"), "README.md does not document engine: pi");
    assert.ok(readme.includes("LLM crons only run through Pi"), "README.md does not document Pi-only cron rollback");
    assert.ok(readme.includes("CRON_HEALTH_TEXTFILE_DIR"), "README.md does not document CRON_HEALTH_TEXTFILE_DIR");
    assert.ok(readme.includes("minime_cron_last_success_timestamp"), "README.md does not document cron success metric");
    assert.ok(readme.includes("900000 = 15 min"), "README.md does not document the 15-minute cron timeout default");
  });

  it("crons.local.yaml.example shows the engine override", () => {
    const example = readRepoFile("crons.local.yaml.example");
    assert.ok(example.includes("engine: pi"), "crons.local.yaml.example does not show engine: pi");
  });

  it("plist generator validates LLM engine values", () => {
    const validPiCron: CronPlistDef = {
      name: "valid-pi",
      schedule: "0 * * * *",
      type: "llm",
      engine: "pi",
      prompt: "Summarize status",
      agentId: "main",
    };
    const invalidPiCron: CronPlistDef = {
      ...validPiCron,
      name: "invalid-pi",
      engine: "bad" as unknown as CronPlistDef["engine"],
    };
    const scriptCron: CronPlistDef = {
      name: "script-bad-engine",
      schedule: "0 * * * *",
      type: "script",
      engine: "bad" as unknown as CronPlistDef["engine"],
      command: "echo ok",
      agentId: "main",
    };

    assert.strictEqual(validateCronForPlist(validPiCron), undefined);
    assert.match(
      validateCronForPlist(invalidPiCron) ?? "",
      /invalid-pi has invalid engine "bad"/,
    );
    assert.strictEqual(validateCronForPlist(scriptCron), undefined);
  });

});

describe("CronJob type includes enabled field", () => {
  it("types.ts CronJob interface has enabled field", () => {
    const typesSource = readRepoFile("bot/src/types.ts");
    const cronJobMatch = typesSource.match(
      /export interface CronJob \{[\s\S]*?\}/
    );
    assert.ok(cronJobMatch, "CronJob interface not found in types.ts");
    assert.ok(
      cronJobMatch[0].includes("enabled"),
      "CronJob interface does not include 'enabled' field"
    );
  });
});
