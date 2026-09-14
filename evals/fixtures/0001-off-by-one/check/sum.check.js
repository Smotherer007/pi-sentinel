import { test } from "node:test";
import assert from "node:assert/strict";

import { sum } from "../src/sum.js";

/**
 * Named `.check.js`, not `.test.js`, on purpose: the repository's own
 * `node --test` discovers `*.test.*` from its root, and a fixture is an input to
 * the eval — it must never appear as a test of sentinel itself. (It did, once,
 * and made the suite red.)
 */
test("rejects a non-array", () => {
  assert.throws(() => sum(null), /array/);
});
