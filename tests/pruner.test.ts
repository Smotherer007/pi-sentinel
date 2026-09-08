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

  test("caps at maxLines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `error: line ${i}`);
    const result = pruneTrace(lines.join("\n"), 5);
    const count = result.split("\n").length;
    assert.ok(count <= 8, `should cap near maxLines, got ${count}`);
  });

  test("falls back to anchors when no critical lines", () => {
    const output = ["hello", "world", "foo", "bar", "baz", "qux", "end"].join("\n");
    const result = pruneTrace(output, 12);
    assert.ok(result.includes("hello"));
    assert.ok(result.includes("end"));
  });

  test("returns empty for empty input", () => {
    assert.equal(pruneTrace("", 12), "");
    assert.equal(pruneTrace("   ", 12), "");
  });
});

describe("formatError", () => {
  test("builds a terse error payload", () => {
    const text = formatError({
      step: "type-check",
      exitCode: 1,
      durationMs: 1234,
      prunedTrace: "error TS2304",
      rawOutput: "full",
      warnOnly: false,
    });
    assert.ok(text.includes("type-check"));
    assert.ok(text.includes("exit code: 1"));
    assert.ok(text.includes("error TS2304"));
  });

  test("notes warning mode", () => {
    const text = formatError({
      step: "linter",
      exitCode: 1,
      durationMs: 100,
      prunedTrace: "warn",
      rawOutput: "full",
      warnOnly: true,
    });
    assert.ok(text.includes("WARNING only"));
  });
});
