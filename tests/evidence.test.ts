import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  recordVerified,
  detectRegressions,
  revertToVerified,
  verifiedEntry,
  allVerified,
  forgetVerified,
  stateHashOf,
  hashFile,
} from "../src/clients/evidence.ts";

let home: string;
let dir: string;
let file: string;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ev-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ev-"));
  file = path.join(dir, "a.ts");
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(file, "export const a = 1;\n");
  forgetVerified(dir, [file]);
});

describe("recordVerified", () => {
  test("records the hash of a state that passed", () => {
    const updated = recordVerified(dir, [file], "onTurnEnd:unit-tests");
    assert.equal(updated.length, 1);
    assert.equal(updated[0].hash, hashFile(file)!);

    const entry = verifiedEntry(dir, file);
    assert.ok(entry);
    assert.equal(entry.step, "onTurnEnd:unit-tests");
    assert.ok(entry.blob, "a restorable copy is kept");
  });

  test("keeps a restorable blob on disk", () => {
    recordVerified(dir, [file], "step");
    const before = fs.readFileSync(file, "utf-8");
    fs.writeFileSync(file, "export const a = 2;\n");
    assert.equal(revertToVerified(dir, file), true);
    assert.equal(fs.readFileSync(file, "utf-8"), before);
  });

  test("is idempotent for an unchanged state", () => {
    recordVerified(dir, [file], "step");
    const again = recordVerified(dir, [file], "step");
    assert.deepEqual(again, [], "no write when nothing changed");
    assert.equal(allVerified(dir).length, 1);
  });

  test("ignores files that do not exist", () => {
    assert.deepEqual(recordVerified(dir, [path.join(dir, "nope.ts")], "step"), []);
  });
});

describe("detectRegressions", () => {
  test("is empty right after a green run", () => {
    recordVerified(dir, [file], "step");
    assert.deepEqual(detectRegressions(dir, [file]), []);
  });

  test("reports a file that differs from its verified state", () => {
    recordVerified(dir, [file], "onTurnEnd:unit-tests");
    fs.writeFileSync(file, "export const a = 'broken';\n");

    const [regression] = detectRegressions(dir, [file]);
    assert.ok(regression, "a change after a green state is a regression");
    assert.equal(regression.verifiedStep, "onTurnEnd:unit-tests");
    assert.notEqual(regression.currentHash, regression.verifiedHash);
    assert.equal(regression.reverted, false);
  });

  test("treats a deleted file as regressed", () => {
    recordVerified(dir, [file], "step");
    fs.rmSync(file);
    const [regression] = detectRegressions(dir, [file]);
    assert.equal(regression.currentHash, "missing");
  });

  test("ignores files that were never verified", () => {
    assert.deepEqual(detectRegressions(dir, [file]), []);
  });
});

describe("revertToVerified", () => {
  test("restores the exact bytes that passed", () => {
    fs.writeFileSync(file, "export const a = 1;\n");
    recordVerified(dir, [file], "step");
    fs.writeFileSync(file, "export const a = 999;\n");

    assert.equal(revertToVerified(dir, file), true);
    assert.equal(fs.readFileSync(file, "utf-8"), "export const a = 1;\n");
  });

  test("returns false without evidence", () => {
    assert.equal(revertToVerified(dir, file), false);
  });

  test("returns false when the blob is gone", () => {
    recordVerified(dir, [file], "step");
    const entry = verifiedEntry(dir, file)!;
    fs.rmSync(path.join(home, ".pi", "sentinel-state"), { recursive: true, force: true });
    assert.equal(revertToVerified(dir, file), false);
    assert.ok(entry.blob);
  });

  test("does not claim a revert it did not perform", () => {
    recordVerified(dir, [file], "step");
    fs.writeFileSync(file, "changed\n");
    assert.equal(revertToVerified(dir, path.join(dir, "other.ts")), false);
    assert.equal(fs.readFileSync(file, "utf-8"), "changed\n");
  });
});

describe("forgetVerified", () => {
  test("removes evidence for a path", () => {
    recordVerified(dir, [file], "step");
    forgetVerified(dir, [file]);
    assert.equal(verifiedEntry(dir, file), null);
    assert.deepEqual(allVerified(dir), []);
  });
});

describe("stateHashOf", () => {
  test("is stable for an unchanged code state", () => {
    assert.equal(stateHashOf([file]), stateHashOf([file]));
  });

  test("changes when any file changes", () => {
    const before = stateHashOf([file]);
    fs.writeFileSync(file, "changed\n");
    assert.notEqual(stateHashOf([file]), before);
  });

  test("is order-insensitive", () => {
    const second = path.join(dir, "b.ts");
    fs.writeFileSync(second, "export const b = 1;\n");
    assert.equal(stateHashOf([file, second]), stateHashOf([second, file]));
  });

  test("is short enough to print in feedback", () => {
    assert.equal(stateHashOf([file]).length, 12);
  });

  test("an empty path set has no state to identify", () => {
    // The SHA-1 of the empty string is a valid-looking hash, and it used to be
    // printed as the state a red run was about even when nothing changed.
    assert.equal(stateHashOf([]), "");
    assert.notEqual(stateHashOf([]), "da39a3ee5e6b");
  });
});
