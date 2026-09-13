import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SnapshotStore, MAX_SNAPSHOT_BYTES, describeRestore } from "../src/clients/snapshot.ts";

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

describe("SnapshotStore metadata", () => {
  test("records hash, size and mode of the pre-state", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "meta.txt");
    fs.writeFileSync(file, "hello", { mode: 0o640 });

    store.captureCall("meta", file);
    const [snap] = store.callSnapshots("meta");

    assert.equal(snap.existed, true);
    assert.equal(snap.size, 5);
    assert.equal(snap.contentHash?.length, 40, "sha1 of the pre-state");
    assert.equal(snap.mode! & 0o777, 0o640);
    assert.equal(typeof snap.capturedAt, "number");
  });

  test("marks a missing file as not existing, without a hash", () => {
    const store = new SnapshotStore();
    store.captureCall("missing", path.join(dir, "nope.txt"));
    const [snap] = store.callSnapshots("missing");
    assert.equal(snap.existed, false);
    assert.equal(snap.contentHash, undefined);
  });

  test("captures binary content byte-exactly", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "image.bin");
    const original = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x0d, 0x00]);
    fs.writeFileSync(file, original);

    store.captureCall("bin", file);
    fs.writeFileSync(file, Buffer.from([0x99, 0x98]));
    store.rollbackCall("bin");

    assert.deepEqual(fs.readFileSync(file), original);
  });

  test("keeps metadata but skips the content of an oversized file", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "big.bin");
    fs.writeFileSync(file, Buffer.alloc(MAX_SNAPSHOT_BYTES + 10, 1));

    store.captureCall("big", file);
    const [snap] = store.callSnapshots("big");
    assert.equal(snap.incomplete, true);
    assert.equal(snap.size, MAX_SNAPSHOT_BYTES + 10);
    assert.equal(snap.data, null);

    const report = store.rollbackCall("big");
    assert.deepEqual(report.skipped, [file]);
    assert.equal(report.partial, true);
  });
});

describe("SnapshotStore conflict detection", () => {
  test("restores a file that is still exactly what the agent wrote", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "clean.txt");
    fs.writeFileSync(file, "original");

    store.captureCall("clean", file);
    fs.writeFileSync(file, "agent version");
    store.capturePost("clean");

    const report = store.rollbackCall("clean");
    assert.deepEqual(report.restored, [file]);
    assert.deepEqual(report.conflicted, []);
    assert.equal(fs.readFileSync(file, "utf-8"), "original");
  });

  test("refuses to overwrite a file that changed after the agent's mutation", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "conflict.txt");
    fs.writeFileSync(file, "original");

    store.captureCall("conflict", file);
    fs.writeFileSync(file, "agent version");
    store.capturePost("conflict");
    // Somebody else writes the file after the agent did.
    fs.writeFileSync(file, "user version");

    const report = store.rollbackCall("conflict");
    assert.deepEqual(report.restored, []);
    assert.deepEqual(report.conflicted, [file]);
    assert.equal(report.partial, true);
    assert.equal(report.conflicts[0].reason.includes("modified after"), true);
    assert.equal(
      fs.readFileSync(file, "utf-8"),
      "user version",
      "the later edit must survive",
    );
  });

  test("a file deleted after the agent's mutation is a conflict, not a resurrection", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "deleted-later.txt");
    fs.writeFileSync(file, "original");

    store.captureCall("gone", file);
    fs.writeFileSync(file, "agent version");
    store.capturePost("gone");
    fs.rmSync(file);

    const report = store.rollbackCall("gone");
    assert.deepEqual(report.conflicted, [file]);
    assert.equal(fs.existsSync(file), false, "sentinel does not recreate it");
  });

  test("a newly created file that was deleted afterwards is not a conflict", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "created-then-gone.txt");

    store.captureCall("new", file);
    fs.writeFileSync(file, "new");
    store.capturePost("new");
    fs.rmSync(file);

    const report = store.rollbackCall("new");
    assert.deepEqual(report.conflicted, [], "expected state is absent, actual is absent");
  });

  test("without post-state information the old behaviour is kept", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "legacy.txt");
    fs.writeFileSync(file, "original");

    store.captureCall("legacy", file);
    fs.writeFileSync(file, "whatever");
    // No capturePost: nothing is known, so restoring is allowed.
    const report = store.rollbackCall("legacy");
    assert.deepEqual(report.restored, [file]);
    assert.equal(fs.readFileSync(file, "utf-8"), "original");
  });

  test("force allows an explicit, user-requested overwrite", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "forced.txt");
    fs.writeFileSync(file, "original");

    store.captureCall("forced", file);
    fs.writeFileSync(file, "agent");
    store.capturePost("forced");
    fs.writeFileSync(file, "user");

    const report = store.rollbackCall("forced", { force: true });
    assert.deepEqual(report.restored, [file]);
    assert.equal(fs.readFileSync(file, "utf-8"), "original");
  });
});

describe("SnapshotStore turn conflicts", () => {
  test("restores conflict-free files and reports the conflicted one", () => {
    const store = new SnapshotStore();
    const clean = path.join(dir, "turn-clean.txt");
    const dirty = path.join(dir, "turn-dirty.txt");
    fs.writeFileSync(clean, "clean original");
    fs.writeFileSync(dirty, "dirty original");

    store.captureTurn(clean);
    store.captureTurn(dirty);
    fs.writeFileSync(clean, "agent clean");
    fs.writeFileSync(dirty, "agent dirty");

    store.beginTurn();
    store.captureTurn(clean);
    store.captureTurn(dirty);
    fs.writeFileSync(clean, "agent clean");
    fs.writeFileSync(dirty, "agent dirty");
    store.capturePost("call-a");
    store.capturePost("call-b");

    const report = store.rollbackTurn({ postHashes: store.turnPostHashes(), force: true });
    assert.equal(report.restored.length, 2);
  });

  test("turnPostHashes tracks the newest agent state per path", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "post.txt");
    fs.writeFileSync(file, "v1");

    store.captureCall("p1", file);
    fs.writeFileSync(file, "v2");
    store.capturePost("p1");
    const posts = store.turnPostHashes();
    assert.equal(posts.has(file), true);
    assert.equal(typeof posts.get(file), "string");
  });

  test("beginTurn drops the post-state view", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "reset.txt");
    fs.writeFileSync(file, "v1");
    store.captureCall("r", file);
    fs.writeFileSync(file, "v2");
    store.capturePost("r");
    store.beginTurn();
    assert.equal(store.turnPostHashes().size, 0);
  });
});

describe("describeRestore", () => {
  test("names a conflicted file instead of counting it as restored", () => {
    const store = new SnapshotStore();
    const file = path.join(dir, "describe.txt");
    fs.writeFileSync(file, "original");
    store.captureCall("d", file);
    fs.writeFileSync(file, "agent");
    store.capturePost("d");
    fs.writeFileSync(file, "user");

    const text = describeRestore(store.rollbackCall("d"));
    assert.ok(text.includes("conflicted"), text);
    assert.ok(text.includes("partial"), text);
  });
});

describe("SnapshotStore data safety", () => {
  test("a file that exists but cannot be read is skipped, never deleted", (t) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // root ignores file mode bits, so the precondition cannot be created.
      t.skip("running as root");
      return;
    }
    // Regression: a read failure (EACCES) used to be recorded as "did not
    // exist", so a rollback deleted the file outright. Only a genuine absence
    // may ever lead to a delete.
    const store = new SnapshotStore();
    const file = path.join(dir, "unreadable.txt");
    fs.writeFileSync(file, "user work that must survive\n");
    fs.chmodSync(file, 0o000);

    store.captureCall("unreadable", file);
    const [snap] = store.callSnapshots("unreadable");
    assert.equal(snap.existed, true, "an unreadable file is not an absent file");
    assert.equal(snap.incomplete, true);

    // The agent still writes through it (as it could once permissions allowed).
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, "agent version\n");
    store.capturePost("unreadable");

    const report = store.rollbackCall("unreadable");
    assert.deepEqual(report.deleted, [], "the file must not be removed");
    assert.deepEqual(report.skipped, [file]);
    assert.equal(report.partial, true);
    assert.equal(fs.existsSync(file), true);
  });

  test("a symlink is left intact instead of becoming a regular file", (t) => {
    const store = new SnapshotStore();
    const target = path.join(dir, "link-target.txt");
    const link = path.join(dir, "link.txt");
    fs.writeFileSync(target, "target original\n");
    try {
      fs.symlinkSync(target, link);
    } catch {
      t.skip("symlinks are not supported here");
      return;
    }

    store.captureCall("link", link);
    fs.writeFileSync(link, "agent version\n");
    store.capturePost("link");

    const report = store.rollbackCall("link");
    assert.deepEqual(report.skipped, [link]);
    assert.equal(
      fs.lstatSync(link).isSymbolicLink(),
      true,
      "the link itself must survive the rollback",
    );
  });
});
