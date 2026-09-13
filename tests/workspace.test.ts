import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { parsePorcelain, changedPaths, outOfBandChanges } from "../src/clients/workspace.ts";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ws-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parsePorcelain", () => {
  test("parses modified, added and untracked entries", () => {
    const stdout = [" M src/a.ts", "A  src/b.ts", "?? src/new.ts", ""].join("\n");
    const changes = parsePorcelain(stdout, "/p");

    assert.deepEqual(changes, [
      { status: " M", path: "/p/src/a.ts" },
      { status: "A ", path: "/p/src/b.ts" },
      { status: "??", path: "/p/src/new.ts" },
    ]);
  });

  test("uses the new path of a rename", () => {
    const changes = parsePorcelain("R  src/old.ts -> src/new.ts", "/p");
    assert.deepEqual(changes, [{ status: "R ", path: "/p/src/new.ts" }]);
  });

  test("unquotes paths with spaces", () => {
    const changes = parsePorcelain(' M "src/a b.ts"', "/p");
    assert.deepEqual(changes, [{ status: " M", path: "/p/src/a b.ts" }]);
  });

  test("ignores blank lines and empty output", () => {
    assert.deepEqual(parsePorcelain("", "/p"), []);
    assert.deepEqual(parsePorcelain("\n\n", "/p"), []);
  });
});

describe("changedPaths", () => {
  test("returns nothing outside a git repository", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-nogit-"));
    try {
      assert.deepEqual(changedPaths(plain), []);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  test("sees changes that never went through edit/write", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-git-"));
    try {
      execSync("git init -q", { cwd: repo });
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      fs.writeFileSync(path.join(repo, "src", "generated.ts"), "export {};\n");

      const changes = changedPaths(repo);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].status, "??");
      assert.equal(changes[0].path, path.join(repo, "src", "generated.ts"));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("reports a modification of a tracked file", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-git2-"));
    try {
      execSync("git init -q", { cwd: repo });
      fs.writeFileSync(path.join(repo, "a.ts"), "one\n");
      execSync("git add a.ts", { cwd: repo });
      execSync('git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repo });
      fs.writeFileSync(path.join(repo, "a.ts"), "two\n");

      const changes = changedPaths(repo);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].status.trim(), "M");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("outOfBandChanges", () => {
  test("excludes paths the mutation hooks already captured", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-git3-"));
    try {
      execSync("git init -q", { cwd: repo });
      const known = path.join(repo, "hooked.ts");
      const unknown = path.join(repo, "bash-made.ts");
      fs.writeFileSync(known, "a\n");
      fs.writeFileSync(unknown, "b\n");

      const changes = outOfBandChanges(repo, [known]);
      assert.deepEqual(
        changes.map((c) => c.path),
        [unknown],
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("honours the ignore predicate", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-git4-"));
    try {
      execSync("git init -q", { cwd: repo });
      fs.writeFileSync(path.join(repo, "keep.ts"), "a\n");
      fs.writeFileSync(path.join(repo, "skip.md"), "b\n");

      const changes = outOfBandChanges(repo, [], (abs) => abs.endsWith(".md"));
      assert.deepEqual(
        changes.map((c) => c.status),
        ["??"],
      );
      assert.equal(changes.length, 1);
      assert.ok(changes[0].path.endsWith("keep.ts"));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
