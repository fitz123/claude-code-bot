import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getVersion } from "../version.js";

describe("getVersion", () => {
  it("returns a short git hash in a git repo", () => {
    const version = getVersion();
    // We're running inside a git repo, so we should get a valid short hash
    assert.notStrictEqual(version, "unknown");
    // Short hash is typically 7-12 hex characters
    assert.match(version, /^[0-9a-f]{7,12}$/);
  });

  it("returns a non-empty string", () => {
    const version = getVersion();
    assert.ok(version.length > 0);
  });
});
