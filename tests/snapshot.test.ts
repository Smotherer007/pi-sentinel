import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SnapshotStore } from "../src/clients/snapshot.ts";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-snap-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SnapshotStore.rollbackCall", () => {
  test("restores a modified file", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "original");

    store.captureCall("call-1", file);
    fs.writeFileSync(file, "mutated");
    assert.equal(fs.readFileSync(file, "utf-8"), "mutated");

    const report = store.rollbackCall("call-1");
    assert.deepEqual(report.restored, [file]);
    assert.equal(fs.readFileSync(file, "utf-8"), "original");
  });

  test("removes a newly created file", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "created.txt");

    store.captureCall("call-2", file); // does not exist yet
    fs.writeFileSync(file, "new content");

    const report = store.rollbackCall("call-2");
    assert.deepEqual(report.deleted, [file]);
    assert.equal(fs.existsSync(file), false, "untracked new file must be removed");
  });

  test("leaves unrelated files alone", () => {
    const store = new SnapshotStore();
    const related = path.join(dir, "related.txt");
    const unrelated = path.join(dir, "unrelated.txt");
    fs.writeFileSync(related, "orig");
    fs.writeFileSync(unrelated, "user work");

    store.captureCall("call-3", related);
    fs.writeFileSync(related, "broken");
    fs.writeFileSync(unrelated, "user edited");

    store.rollbackCall("call-3");
    assert.equal(fs.readFileSync(related, "utf-8"), "orig");
    assert.equal(fs.readFileSync(unrelated, "utf-8"), "user edited", "user work preserved");
  });

  test("reports nothing for an unknown call", () => {
    const store = new SnapshotStore();
    assert.equal(store.rollbackCall("nope").attempted, false);
  });
});

describe("SnapshotStore.rollbackTurn", () => {
  test("restores every file touched in the turn", () => {
    const store = new SnapshotStore();
    const f1 = path.join(dir, "turn1.txt");
    const f2 = path.join(dir, "turn2.txt");
    fs.writeFileSync(f1, "one");
    fs.writeFileSync(f2, "two");

    store.captureTurn(f1);
    store.captureTurn(f2);
    store.captureTurn(f1); // second touch must not overwrite the first snapshot

    fs.writeFileSync(f1, "changed twice");
    fs.writeFileSync(f2, "changed");

    const report = store.rollbackTurn();
    assert.equal(report.restored.length, 2);
    assert.equal(fs.readFileSync(f1, "utf-8"), "one");
    assert.equal(fs.readFileSync(f2, "utf-8"), "two");
    assert.equal(store.hasTurnSnapshot(), false, "scope cleared after restore");
  });
});

describe("SnapshotStore.isCallUnchanged", () => {
  test("detects byte-identical rewrites", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "same.txt");
    fs.writeFileSync(file, "content");
    store.captureCall("c", file);
    assert.equal(store.isCallUnchanged("c"), true);

    fs.writeFileSync(file, "content!");
    assert.equal(store.isCallUnchanged("c"), false);
  });
});
