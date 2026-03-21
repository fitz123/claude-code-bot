import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("cron field documentation", () => {
  const readme = readRepoFile("README.md");

  const cronFields = [
    "type",
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
