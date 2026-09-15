import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { CheckpointStore, RunRecorder } from "../src/checkpoints.ts";
import { changedSince, captureBaseline, parsePorcelainZ } from "../src/workspace.ts";
import { gitInit, read, resetCaches, tempDir, write } from "./helpers.ts";

function storeFor(): CheckpointStore {
  return new CheckpointStore(path.join(tempDir("sentinel-cp-"), "checkpoints"), 5);
}

describe("checkpoints without git", () => {
  test("an edited file is restored, a created file is deleted", () => {
    const cwd = tempDir();
    write(cwd, "a.ts", "before");
    const store = storeFor();
    const rec = new RunRecorder(cwd, "edit a", false);

    rec.captureBefore(path.join(cwd, "a.ts"));
    write(cwd, "a.ts", "after");
    rec.captureBefore(path.join(cwd, "new.ts"));
    write(cwd, "new.ts", "created");

    assert.deepEqual(rec.changedFiles().sort(), [path.join(cwd, "a.ts"), path.join(cwd, "new.ts")]);
    const saved = rec.save(store);
    assert.ok(saved);
    assert.equal(saved.label, "edit a");

    const report = store.restore();
    assert.equal(read(cwd, "a.ts"), "before");
    assert.equal(read(cwd, "new.ts"), null);
    assert.deepEqual(report.conflicts, []);
  });

  test("a byte-identical rewrite is not a change", () => {
    const cwd = tempDir();
    write(cwd, "a.ts", "same");
    const rec = new RunRecorder(cwd, "noop", false);
    rec.captureBefore(path.join(cwd, "a.ts"));
    write(cwd, "a.ts", "same");
    assert.deepEqual(rec.changedFiles(), []);
    assert.equal(rec.save(storeFor()), null);
  });

  test("the first capture in a run wins", () => {
    const cwd = tempDir();
    write(cwd, "a.ts", "v1");
    const store = storeFor();
    const rec = new RunRecorder(cwd, "two edits", false);
    rec.captureBefore(path.join(cwd, "a.ts"));
    write(cwd, "a.ts", "v2");
    rec.captureBefore(path.join(cwd, "a.ts"));
    write(cwd, "a.ts", "v3");
    rec.save(store);
    store.restore();
    assert.equal(read(cwd, "a.ts"), "v1");
  });

  test("a file changed after the checkpoint is left alone unless forced", () => {
    const cwd = tempDir();
    write(cwd, "a.ts", "before");
    const store = storeFor();
    const rec = new RunRecorder(cwd, "edit", false);
    rec.captureBefore(path.join(cwd, "a.ts"));
    write(cwd, "a.ts", "agent");
    rec.save(store);
    write(cwd, "a.ts", "user edit afterwards");

    const report = store.restore();
    assert.deepEqual(report.conflicts, [path.join(cwd, "a.ts")]);
    assert.equal(read(cwd, "a.ts"), "user edit afterwards");

    store.restore(undefined, { force: true });
    assert.equal(read(cwd, "a.ts"), "before");
  });

  test("retention keeps only the newest checkpoints; ids and numbers both resolve", () => {
    const cwd = tempDir();
    const store = storeFor();
    for (let i = 0; i < 7; i += 1) {
      const rec = new RunRecorder(cwd, `run ${i}`, false);
      rec.captureBefore(path.join(cwd, `f${i}.ts`));
      write(cwd, `f${i}.ts`, "x");
      rec.save(store);
    }
    const list = store.list();
    assert.equal(list.length, 5);
    assert.equal(list[0].label, "run 6");
    const oldest = list[list.length - 1];
    assert.equal(store.restore(oldest.id.split("-")[0]).id, oldest.id);
    assert.equal(store.restore("does-not-exist").found, false);
  });
});

describe("checkpoints with git (changes made through bash)", () => {
  let cwd: string;
  before(() => {
    cwd = tempDir();
    write(cwd, "tracked.ts", "committed");
    write(cwd, "dirty.ts", "committed");
    gitInit(cwd);
    write(cwd, "dirty.ts", "user work in progress");
  });
  after(resetCaches);

  test("clean tracked files restore from HEAD, new files are deleted, dirty ones are not guessed", () => {
    const store = storeFor();
    const rec = new RunRecorder(cwd, "bash run", true);

    // A shell command rewrites a clean file, creates one, and touches a dirty one.
    write(cwd, "tracked.ts", "formatted by bash");
    write(cwd, "generated/out.ts", "codegen");
    write(cwd, "dirty.ts", "sed -i on top of user work");

    const changed = rec.changedFiles().sort();
    assert.deepEqual(changed, [path.join(cwd, "dirty.ts"), path.join(cwd, "generated/out.ts"), path.join(cwd, "tracked.ts")]);
    rec.save(store, changed);

    const report = store.restore();
    assert.equal(read(cwd, "tracked.ts"), "committed");
    assert.equal(read(cwd, "generated/out.ts"), null);
    assert.deepEqual(report.unrecoverable, [path.join(cwd, "dirty.ts")]);
    assert.equal(read(cwd, "dirty.ts"), "sed -i on top of user work", "never replaced by a guess");
  });

  test("a deleted tracked file comes back", () => {
    const store = storeFor();
    const rec = new RunRecorder(cwd, "rm", true);
    fs.rmSync(path.join(cwd, "tracked.ts"));
    rec.save(store);
    store.restore();
    assert.equal(read(cwd, "tracked.ts"), "committed");
  });

  test("pre-existing dirty files that do not change are not attributed to the agent", () => {
    const baseline = captureBaseline(cwd);
    assert.deepEqual(changedSince(cwd, baseline), []);
  });
});

test("porcelain -z parsing handles renames and spaces", () => {
  const out = parsePorcelainZ(" M a b.ts\0R  new.ts\0old.ts\0?? dir/c.ts\0", "/repo");
  assert.deepEqual(out, ["/repo/a b.ts", "/repo/new.ts", "/repo/dir/c.ts"]);
});
