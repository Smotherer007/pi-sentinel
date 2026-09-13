import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rollbackMutation, rollbackMutations, rollbackTurn } from "../src/clients/rollback.ts";
import { snapshots } from "../src/clients/snapshot.ts";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-rollback-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts from a clean turn scope. `dir` is intentionally not wiped:
  // most tests overwrite the files they check.
  snapshots.beginTurn();
});

describe("automatic rollback without a snapshot", () => {
  test("a turn restore is an explicit no-op, never a repo-wide git reset", () => {
    const result = rollbackTurn(dir);
    assert.equal(result.success, false);
    assert.equal(result.method, "none");
    assert.equal(result.command, "", "no destructive git command is ever run");
    assert.match(result.message, /nothing was restored/);
  });

  test("an unknown mutation is a no-op too", () => {
    const result = rollbackMutation("never-seen", dir);
    assert.equal(result.success, false);
    assert.equal(result.method, "none");
    assert.equal(result.command, "");
  });

  test("a batch with no captured mutations is a no-op", () => {
    const result = rollbackMutations(["a", "b"], dir);
    assert.equal(result.success, false);
    assert.equal(result.method, "none");
    assert.equal(result.command, "");
  });
});

describe("turn rollback correctness", () => {
  test("restores a file to the pre-turn state, keeping the user's earlier edit", () => {
    const file = path.join(dir, "edited.txt");
    // The user changed the file before the agent's turn. That state — not HEAD —
    // is what a rollback has to restore.
    fs.writeFileSync(file, "user version\n");

    snapshots.captureTurn(file);
    fs.writeFileSync(file, "agent version\n");

    const result = rollbackTurn(dir);
    assert.equal(result.success, true);
    assert.equal(result.method, "snapshot:turn");
    assert.equal(fs.readFileSync(file, "utf-8"), "user version\n");
  });

  test("restores a file the agent deleted", () => {
    const file = path.join(dir, "deleted.txt");
    fs.writeFileSync(file, "content\n");

    snapshots.captureTurn(file);
    fs.rmSync(file);

    const result = rollbackTurn(dir);
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(file, "utf-8"), "content\n");
  });

  test("removes a file the agent created", () => {
    const file = path.join(dir, "created.txt");
    snapshots.captureTurn(file);
    fs.writeFileSync(file, "new\n");

    const result = rollbackTurn(dir);
    assert.equal(result.success, true);
    assert.equal(fs.existsSync(file), false);
  });

  test("leaves files the turn never touched exactly as they are", () => {
    const touched = path.join(dir, "touched.txt");
    const untouched = path.join(dir, "untouched.txt");
    fs.writeFileSync(touched, "before\n");
    fs.writeFileSync(untouched, "someone else's work\n");

    snapshots.captureTurn(touched);
    fs.writeFileSync(touched, "after\n");
    fs.writeFileSync(untouched, "someone else's newer work\n");

    rollbackTurn(dir);

    assert.equal(fs.readFileSync(touched, "utf-8"), "before\n");
    assert.equal(
      fs.readFileSync(untouched, "utf-8"),
      "someone else's newer work\n",
      "unrelated uncommitted work must survive a rollback",
    );
  });
});
