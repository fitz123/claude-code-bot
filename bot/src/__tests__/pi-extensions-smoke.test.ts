import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { smokeAdd, SMOKE_MARKER } from "../pi-extensions/_smoke.js";

/**
 * Task 0 — THROWAWAY (removed in Task 4 together with `_smoke.ts`).
 *
 * Existence + green run of this test proves the `npm test` glob
 * (`src/__tests__/*.test.ts`) imports and exercises helpers living in
 * `bot/src/pi-extensions/`. `tsc --noEmit` type-checking the same helper proves
 * lint coverage. Together they lock the location for the real A1-A3 helpers.
 */
describe("pi-extensions smoke (Task 0 — throwaway)", () => {
  it("imports + runs a helper from bot/src/pi-extensions/ via the test glob", () => {
    assert.strictEqual(smokeAdd(2, 3), 5);
  });

  it("loads the helper module (proves test-glob reachability)", () => {
    assert.strictEqual(SMOKE_MARKER, "pi-extensions-smoke");
  });
});
