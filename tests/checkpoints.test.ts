import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CheckpointStore } from "../src/clients/checkpoints.ts";
import { describeRestore } from "../src/clients/snapshot.ts";

let home: string;
let dir: string;
const store = new CheckpointStore();

function write(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cp-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cp-"));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  store.clear(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});

describe("checkpoint lifecycle", () => {
  test("flushing without captures stores nothing", () => {
    store.begin({ turnIndex: 1 });
    assert.equal(store.flush(dir, 50), null);
    assert.deepEqual(store.list(dir), []);
  });

  test("captures a turn and persists it with a label", () => {
    const file = write("a.ts", "before\n");
    store.begin({ turnIndex: 3, entryId: "entry-1" });
    store.capture(file);
    store.setLabel("parseConfig (a.ts)");

    const summary = store.flush(dir, 50);
    assert.ok(summary);
    assert.equal(summary.turnIndex, 3);
    assert.equal(summary.entryId, "entry-1");
    assert.equal(summary.label, "parseConfig (a.ts)");
    assert.equal(summary.fileCount, 1);
    assert.deepEqual(summary.files, [file]);
  });

  test("keeps the first pre-state when a file is touched twice", () => {
    const file = write("a.ts", "original\n");
    store.begin({ turnIndex: 1 });
    store.capture(file);
    fs.writeFileSync(file, "first mutation\n");
    store.capture(file);
    store.flush(dir, 50);

    store.restore(dir);
    assert.equal(fs.readFileSync(file, "utf-8"), "original\n");
  });

  test("lists checkpoints newest first", () => {
    const file = write("a.ts", "one\n");
    for (const turn of [1, 2, 3]) {
      store.begin({ turnIndex: turn });
      store.capture(file);
      store.flush(dir, 50);
    }

    const list = store.list(dir);
    assert.equal(list.length, 3);
    assert.ok(list[0].seq > list[1].seq && list[1].seq > list[2].seq, "newest first");
    assert.equal(store.latest(dir)?.id, list[0].id);
  });

  test("imports snapshots the in-memory store already read", () => {
    const file = write("a.ts", "before\n");
    store.begin({ turnIndex: 1 });
    store.captureSnapshots([
      { path: file, existed: true, data: Buffer.from("in-memory\n"), incomplete: false },
    ]);
    const summary = store.flush(dir, 50);
    assert.equal(summary?.fileCount, 1);

    store.restore(dir);
    assert.equal(fs.readFileSync(file, "utf-8"), "in-memory\n");
  });
});

describe("checkpoint restore", () => {
  test("restores modified content and removes files created in that turn", () => {
    const modified = write("modified.ts", "original\n");
    const created = path.join(dir, "created.ts");
    const untouched = write("untouched.ts", "hands off\n");

    store.begin({ turnIndex: 1 });
    store.capture(modified);
    store.capture(created);
    store.flush(dir, 50);

    // Simulate the turn's work.
    fs.writeFileSync(modified, "rewritten\n");
    fs.writeFileSync(created, "new file\n");
    fs.writeFileSync(untouched, "user work\n");

    const report = store.restore(dir);
    assert.equal(report.attempted, true);
    assert.equal(fs.readFileSync(modified, "utf-8"), "original\n");
    assert.equal(fs.existsSync(created), false, "newly created files are removed");
    assert.equal(fs.readFileSync(untouched, "utf-8"), "user work\n", "unrelated work survives");
    assert.equal(report.restored.length, 1);
    assert.equal(report.deleted.length, 1);
    assert.equal(describeRestore(report), "restored 1 file(s), removed 1 newly created file(s)");
  });

  test("restores a specific checkpoint by id", () => {
    const file = write("a.ts", "v1\n");
    store.begin({ turnIndex: 1 });
    store.capture(file);
    const first = store.flush(dir, 50)!;

    fs.writeFileSync(file, "v2\n");
    store.begin({ turnIndex: 2 });
    store.capture(file);
    store.flush(dir, 50);

    fs.writeFileSync(file, "v3\n");
    store.restore(dir, first.id);
    assert.equal(fs.readFileSync(file, "utf-8"), "v1\n");
  });

  test("reports nothing to restore for an unknown id", () => {
    const report = store.restore(dir, "999");
    assert.equal(report.attempted, false);
  });

  test("restores a checkpoint that survived a restart", () => {
    const file = write("a.ts", "original\n");
    store.begin({ turnIndex: 1 });
    store.capture(file);
    store.flush(dir, 50);
    fs.writeFileSync(file, "rewritten\n");

    // A fresh store instance stands in for a restarted session.
    const restarted = new CheckpointStore();
    assert.ok(restarted.latest(dir));
    restarted.restore(dir);
    assert.equal(fs.readFileSync(file, "utf-8"), "original\n");
  });
});

describe("checkpoint retention", () => {
  test("prunes older checkpoints beyond the retention limit", () => {
    const file = write("a.ts", "x\n");
    for (const turn of [1, 2, 3, 4]) {
      store.begin({ turnIndex: turn });
      store.capture(file);
      store.flush(dir, 2);
    }

    const list = store.list(dir, 50);
    assert.equal(list.length, 2, "only the newest two survive");
    assert.deepEqual(
      list.map((c) => c.seq).sort((a, b) => b - a),
      [4, 3],
    );
  });

  test("retention of zero keeps everything", () => {
    const file = write("a.ts", "x\n");
    for (const turn of [1, 2, 3]) {
      store.begin({ turnIndex: turn });
      store.capture(file);
      store.flush(dir, 0);
    }
    assert.equal(store.list(dir, 50).length, 3);
  });
});

describe("checkpoint housekeeping", () => {
  test("clear removes every checkpoint", () => {
    const file = write("a.ts", "x\n");
    store.begin({ turnIndex: 1 });
    store.capture(file);
    store.flush(dir, 50);

    assert.equal(store.clear(dir), 1);
    assert.deepEqual(store.list(dir), []);
  });

  test("an empty project has no checkpoints and restores nothing", () => {
    assert.deepEqual(store.list(dir), []);
    assert.equal(store.latest(dir), null);
    assert.equal(store.restore(dir).attempted, false);
  });
});
