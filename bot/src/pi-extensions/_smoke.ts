/**
 * Task 0 smoke stub — THROWAWAY (removed in Task 4).
 *
 * Proves that a non-test helper placed in `bot/src/pi-extensions/*.ts` is:
 *   1. type-checked by `tsc --noEmit` (tsconfig `include: ["src/**\/*.ts"]`), and
 *   2. reachable/exercised by the `npm test` glob (`src/__tests__/*.test.ts`),
 *      because the sibling test imports it from `../pi-extensions/_smoke.js`.
 *
 * The explicit `: number` / `: string` annotations below are deliberate: if this
 * file were NOT in the `tsc` graph, a deliberately-wrong annotation would slip
 * through silently. Their presence in a clean `tsc --noEmit` run is the proof.
 *
 * See ./README.md for the location lock + wrapper lint-coverage decision.
 */

/** Trivial pure helper; the smoke test asserts on its output. */
export function smokeAdd(a: number, b: number): number {
  return a + b;
}

/** Module-load marker; asserting on it proves the test glob loaded this file. */
export const SMOKE_MARKER: string = "pi-extensions-smoke";
