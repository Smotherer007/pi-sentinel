/**
 * The session runtime: the stores a sentinel session owns, as a value.
 *
 * These are the assertions the extraction was for. Each one fails if a store
 * becomes shared again, which is exactly the regression that is invisible in
 * a suite driven through the hooks — a `session_start` clears a shared tracker,
 * so a leak between two instances looks like correct behaviour until two
 * sessions interleave in one process.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createRuntime } from "../src/runtime.ts";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-runtime-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createRuntime", () => {
  test("two runtimes share no state", () => {
    const a = createRuntime();
    const b = createRuntime();

    // Turn snapshots: the pre-state a rollback would restore.
    const file = path.join(dir, "a.ts");
    fs.writeFileSync(file, "one\n");
    a.snapshots.captureTurn(file);
    assert.equal(a.snapshots.hasTurnSnapshot(), true);
    assert.equal(b.snapshots.hasTurnSnapshot(), false, "the other session captured nothing");

    // Failure counters: what notices a repair loop.
    a.escalations.record("type-error:boom");
    a.escalations.record("type-error:boom");
    assert.equal(a.escalations.count("type-error:boom"), 2);
    assert.equal(b.escalations.count("type-error:boom"), 0, "counters are not shared");

    // The checkpoint being captured for the turn.
    a.checkpoints.begin({ turnIndex: 1, session: undefined });
    assert.equal(a.checkpoints.isCapturing, true);
    assert.equal(b.checkpoints.isCapturing, false, "capture scopes are not shared");

    a.escalations.reset();
    assert.equal(a.escalations.count("type-error:boom"), 0);
  });

  test("the stores a runtime hands out are usable on their own", () => {
    const runtime = createRuntime();
    assert.equal(runtime.checkpoints.pendingPaths().length, 0);
    assert.deepEqual(runtime.escalations.snapshot(), []);
    assert.equal(runtime.snapshots.hasTurnSnapshot(), false);
  });
});
