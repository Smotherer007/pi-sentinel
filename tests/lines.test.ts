import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { RANK, dedupeLines, errorLines, isDiagnosticRank, rankLine, stripAnsi } from "../src/formatting/lines.ts";

describe("stripAnsi", () => {
  test("removes SGR sequences", () => {
    assert.equal(stripAnsi("\u001b[31merror\u001b[0m"), "error");
  });
});

describe("rankLine", () => {
  test("ranks compiler errors above stack frames", () => {
    assert.equal(rankLine("src/a.ts(1,2): error TS2322: nope"), RANK.compilerError);
    assert.equal(rankLine("  at Object.<anonymous> (src/a.ts:1:2)"), RANK.stack);
  });

  test("ranks test failures and assertions", () => {
    assert.equal(rankLine("  ✖ parses the config"), RANK.testFailure);
    assert.equal(rankLine("AssertionError [ERR_ASSERTION]: expected 1"), RANK.testFailure);
    assert.equal(rankLine("  + expected - actual"), RANK.assertion);
  });

  test("ranks source locations above context", () => {
    assert.equal(rankLine("src/foo.ts:42:17"), RANK.location);
    assert.equal(rankLine("    17 | const x = 1;"), RANK.context);
  });

  test("ranks npm noise last", () => {
    assert.equal(rankLine("npm notice Downloading typescript"), RANK.noise);
    assert.equal(rankLine("Build starting..."), RANK.noise);
  });

  test("recognises build and lint failures", () => {
    assert.equal(rankLine("error[E0432]: unresolved import"), RANK.compilerError);
    assert.equal(rankLine("error MSB3073: the command exited"), RANK.compilerError);
  });
});

describe("isDiagnosticRank", () => {
  test("separates diagnostics from context and noise", () => {
    assert.equal(isDiagnosticRank(RANK.compilerError), true);
    assert.equal(isDiagnosticRank(RANK.location), true);
    assert.equal(isDiagnosticRank(RANK.context), false);
    assert.equal(isDiagnosticRank(RANK.noise), false);
  });
});

describe("dedupeLines", () => {
  test("collapses consecutive duplicates only", () => {
    assert.deepEqual(dedupeLines(["a", "a", "b", "a"]), ["a", "b", "a"]);
  });
});

describe("errorLines", () => {
  test("returns the most valuable lines, noise excluded", () => {
    const output = [
      "npm notice Downloading typescript",
      "error TS2322: Type 'string' is not assignable to type 'number'.",
      "npm notice done",
    ].join("\n");

    const lines = errorLines(output);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("error TS2322"));
  });

  test("honours the limit and skips duplicates", () => {
    const output = [
      "error TS1001: a",
      "error TS1001: a",
      "error TS1002: b",
      "error TS1003: c",
    ].join("\n");
    assert.equal(errorLines(output, 2).length, 2);
    assert.equal(errorLines(output, 3).length, 3, "duplicates do not fill the budget");
  });

  test("returns nothing for pure noise", () => {
    assert.deepEqual(errorLines("npm notice hello\nDownloading...\n"), []);
  });
});
