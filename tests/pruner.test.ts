import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { pruneTrace, formatError } from "../src/formatting/pruner.ts";

describe("pruneTrace", () => {
  test("keeps error lines", () => {
    const output = [
      "Build starting...",
      "error TS2304: Cannot find name 'foo'",
      "  at src/index.ts:10:5",
      "Build completed",
    ].join("\n");

    const result = pruneTrace(output, 12);
    assert.ok(result.includes("error TS2304"), "should keep TS error line");
    assert.ok(result.includes("10:5"), "should keep line:col reference");
    assert.ok(!result.includes("Build starting"), "should drop noise");
  });

  test("caps exactly at maxLines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `error: line ${i}`);
    for (const max of [3, 5, 12]) {
      const result = pruneTrace(lines.join("\n"), max);
      const count = result.split("\n").length;
      assert.equal(count, max, `expected exactly ${max} lines, got ${count}`);
    }
  });

  test("keeps header and footer when capping", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `error: line ${i}`);
    const result = pruneTrace(lines.join("\n"), 6);
    assert.ok(result.includes("error: line 0"), "header kept");
    assert.ok(result.includes("error: line 99"), "footer kept");
    assert.ok(result.includes("..."), "elision marker present");
  });

  test("falls back to anchors when no critical lines", () => {
    const output = ["hello", "world", "foo", "bar", "baz", "qux", "end"].join("\n");
    const result = pruneTrace(output, 12);
    assert.ok(result.includes("hello"));
    assert.ok(result.includes("end"));
  });

  test("strips ANSI escape sequences", () => {
    const output = "\u001b[31merror: boom\u001b[0m";
    const result = pruneTrace(output, 12);
    assert.equal(result.includes("\u001b"), false, "no escape sequences");
    assert.ok(result.includes("error: boom"));
  });

  test("collapses consecutive duplicates", () => {
    const output = ["error: same", "error: same", "error: same"].join("\n");
    const result = pruneTrace(output, 12);
    assert.equal(result, "error: same");
  });

  test("prioritises lines mentioning focusPaths", () => {
    const output = [
      "error in unrelated.ts:1:1: broke",
      "src/target.ts(3,7): error TS9999: focused diagnostic",
    ].join("\n");
    const result = pruneTrace(output, 12, ["src/target.ts"]);
    assert.ok(
      result.startsWith("src/target.ts"),
      `focused line should come first, got:\n${result}`,
    );
  });

  test("returns empty for empty input", () => {
    assert.equal(pruneTrace("", 12), "");
    assert.equal(pruneTrace("   ", 12), "");
  });
});

describe("formatError", () => {
  const base = {
    step: "type-check",
    exitCode: 1,
    durationMs: 1234,
    prunedTrace: "error TS2304",
    rawOutput: "full",
    warnOnly: false,
  };

  test("builds a terse error payload", () => {
    const text = formatError(base);
    assert.ok(text.includes("type-check"));
    assert.ok(text.includes("exit code: 1"));
    assert.ok(text.includes("error TS2304"));
  });

  test("never claims a rollback that did not happen", () => {
    // Regression: the message always said "has been rolled back", even when
    // autoRollback was off and the changes were still on disk.
    const notRolledBack = formatError({ ...base, rolledBack: false });
    assert.ok(notRolledBack.includes("still in place"));
    assert.equal(notRolledBack.includes("rolled back"), false);

    const rolledBack = formatError({ ...base, rolledBack: true });
    assert.ok(rolledBack.includes("rolled back"));
  });

  test("notes warning mode", () => {
    const text = formatError({ ...base, step: "linter", warnOnly: true });
    assert.ok(text.includes("WARNING only"));
  });
});
