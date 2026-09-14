/**
 * Unit tests for run-input freshness.
 *
 * The bug these prevent: a verdict was bound to the files *this turn* touched,
 * so a whole-project check (`npm test`) could go red, be delivered ten seconds
 * later against a tree that had already been fixed, and spend a repair attempt
 * on it. The cases below pin down what the binding must include — and, just as
 * important, that it stays cheap enough to take on every run.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  RUN_INPUT_MAX_BYTES,
  describeMoved,
  fingerprintInputs,
  identityOf,
  movedInputs,
  projectFiles,
} from "../src/clients/freshness.ts";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-fresh-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "tests", "a.test.ts"), "// test\n");
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.ts"), "// vendored\n");
  fs.writeFileSync(path.join(dir, "docs", "readme.md"), "# docs\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "notes\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const TS_ONLY = { include: ["**/*.ts"], exclude: ["**/node_modules/**", "**/*.md"] };

describe("freshness: which files a verdict is bound to", () => {
  test("include and exclude decide, and dependencies are never walked", () => {
    const { files, truncated } = projectFiles(dir, TS_ONLY);
    assert.deepEqual(files, ["package.json", "src/a.ts", "tests/a.test.ts"]);
    assert.equal(truncated, false);
  });

  test("a narrowing pattern prunes the directories it cannot reach", () => {
    const { files } = projectFiles(dir, { include: ["src/**"], exclude: [] });
    assert.deepEqual(files, ["package.json", "src/a.ts"]);
  });

  test("with no include, sources are bound but a check's own output is not", () => {
    fs.writeFileSync(path.join(dir, "ran.log"), "run\n");
    const { files } = projectFiles(dir, { include: [], exclude: [] });
    assert.ok(files.includes("src/a.ts"), "source files are inputs");
    assert.ok(files.includes("package.json"), "manifests are inputs");
    assert.equal(
      files.includes("ran.log"),
      false,
      "a log the check itself writes must not invalidate the check",
    );
    assert.equal(files.includes("notes.txt"), false);
  });

  test("manifests are bound even though `include` does not match them", () => {
    const { files } = projectFiles(dir, { include: ["src/**/*.ts"], exclude: [] });
    assert.ok(files.includes("package.json"), "package.json decides what `npm test` means");
  });

  test("the cap is reported rather than hidden", () => {
    const { files, truncated } = projectFiles(dir, TS_ONLY, 1);
    assert.equal(truncated, true);
    assert.ok(files.length >= 1);
  });

  test("focus paths are bound even when no pattern matches them", () => {
    const inputs = fingerprintInputs(dir, [path.join(dir, "notes.txt")], TS_ONLY);
    assert.ok(inputs.scope.includes(path.join(dir, "notes.txt")));
    assert.equal(inputs.truncated, false);
  });
});

describe("freshness: noticing that the tree moved", () => {
  test("an untouched project reports nothing", () => {
    const inputs = fingerprintInputs(dir, [], TS_ONLY);
    assert.deepEqual(movedInputs(inputs, dir, TS_ONLY), []);
  });

  test("an edit below the include set is reported", () => {
    const inputs = fingerprintInputs(dir, [], TS_ONLY);
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 2;\n");
    assert.deepEqual(movedInputs(inputs, dir, TS_ONLY), [path.join(dir, "src", "a.ts")]);
  });

  test("a file created while the run was in flight is reported", () => {
    const inputs = fingerprintInputs(dir, [], TS_ONLY);
    fs.writeFileSync(path.join(dir, "src", "new.ts"), "export const n = 1;\n");
    assert.deepEqual(movedInputs(inputs, dir, TS_ONLY), [path.join(dir, "src", "new.ts")]);
  });

  test("a file deleted while the run was in flight is reported", () => {
    const victim = path.join(dir, "tests", "a.test.ts");
    fs.writeFileSync(victim, "// test\n");
    const inputs = fingerprintInputs(dir, [], TS_ONLY);
    fs.rmSync(victim);
    assert.deepEqual(movedInputs(inputs, dir, TS_ONLY), [victim]);
  });

  test("a change outside the bound set is not reported", () => {
    const inputs = fingerprintInputs(dir, [], TS_ONLY);
    fs.writeFileSync(path.join(dir, "docs", "readme.md"), "# changed\n");
    fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.ts"), "// changed\n");
    assert.deepEqual(movedInputs(inputs, dir, TS_ONLY), []);
  });
});

describe("freshness: file identity", () => {
  test("a missing file is not an error", () => {
    assert.equal(identityOf(path.join(dir, "nope.ts")), "missing");
  });

  test("an oversized file is bound by size and mtime, not by content", () => {
    const big = path.join(dir, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(RUN_INPUT_MAX_BYTES + 1, 7));
    assert.match(identityOf(big), /^size:\d+:mtime:/);
  });
});

describe("freshness: the notice text stays bounded", () => {
  test("names the first few and counts the rest", () => {
    const moved = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((n) => path.join(dir, "src", n));
    assert.equal(describeMoved(moved, dir), "src/a.ts, src/b.ts, src/c.ts (+2 more)");
    assert.equal(describeMoved(moved.slice(0, 2), dir), "src/a.ts, src/b.ts");
  });
});
