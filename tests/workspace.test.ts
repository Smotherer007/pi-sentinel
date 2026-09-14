import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { parsePorcelain, changedPaths, outOfBandChanges } from "../src/clients/workspace.ts";
import { defineConfig, shouldVerify } from "../src/config.ts";

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

describe("a rename is reported at the path that exists", () => {
  test("the new path wins, and the old one is not invented", () => {
    // `R  old -> new` is what git prints for a rename; verifying or snapshotting
    // the old path would act on a file that is gone.
    const changes = parsePorcelain("R  src/old.ts -> src/new.ts\n", "/w");
    assert.deepEqual(changes, [{ status: "R ", path: path.resolve("/w", "src/new.ts") }]);
  });

  test("quoted paths survive", () => {
    const changes = parsePorcelain('R  "a b.ts" -> "c d.ts"\n', "/w");
    assert.equal(changes[0].path, path.resolve("/w", "c d.ts"));
  });

  test("a copy is reported like a rename, at the copy", () => {
    const changes = parsePorcelain("C  src/a.ts -> src/b.ts\n", "/w");
    assert.equal(changes[0].path, path.resolve("/w", "src/b.ts"));
  });
});

describe("a nested repository is seen, as one path", () => {
  let nestedRoot: string;
  before(() => {
    nestedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-nested-"));
    const git = (cmd: string, cwd: string) => execSync(`git ${cmd}`, { cwd, stdio: "pipe" });
    fs.writeFileSync(path.join(nestedRoot, "README.md"), "outer\n");
    git("init -q", nestedRoot);
    git("config user.email t@t", nestedRoot);
    git("config user.name t", nestedRoot);
    git("add -A", nestedRoot);
    git("commit -qm init", nestedRoot);

    const inner = path.join(nestedRoot, "nested");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, "inner.ts"), "export const inner = 1;\n");
    git("init -q", inner);
    git("config user.email t@t", inner);
    git("config user.name t", inner);
    git("add -A", inner);
    git("commit -qm nested", inner);

    // The change sentinel is supposed to notice, made inside the nested repo.
    fs.writeFileSync(path.join(inner, "inner.ts"), "export const inner = 2;\n");
  });

  after(() => {
    fs.rmSync(nestedRoot, { recursive: true, force: true });
  });

  test("git reports the directory, so sentinel sees a path no file glob matches", () => {
    const changes = changedPaths(nestedRoot);
    const nested = changes.find((change) => change.path.endsWith("nested"));
    assert.ok(nested, "the nested repo is visible to out-of-band detection at all");
    // The consequence, pinned so it cannot drift silently: a directory cannot
    // match `**/*.ts`, so `shouldVerify` drops this path and the change inside it
    // is not verified. The turn-end hook now *names* that fact to the user
    // instead of staying quiet, which is the honest half of the boundary;
    // deciding to walk into a nested repository is a separate decision.
    //
    // Note the dependence on configuration: with no `include` patterns at all,
    // sentinel verifies everything not excluded, so this path *is* passed on and
    // the step's own file filter gets to decide. The boundary above is the one a
    // project with a file list — like this repository — actually has.
    assert.equal(
      shouldVerify(nested!.path, defineConfig({ include: ["**/*.ts"] }), nestedRoot),
      false,
    );
    assert.equal(shouldVerify(nested!.path, defineConfig({}), nestedRoot), true);
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
