import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { pruneTrace } from "../src/format/prune.ts";

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

describe("pruneTrace ranking", () => {
  test("keeps the compiler error and drops npm noise, whatever the order", () => {
    const output = [
      "npm notice Downloading typescript",
      "npm notice done",
      "  at Module._compile (node:internal/modules/cjs/loader:1:2)",
      "src/a.ts(42,17): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n");

    const result = pruneTrace(output, 12);
    assert.ok(result.includes("error TS2322"));
    assert.ok(result.includes("at Module._compile"), "stack frames are kept as evidence");
    assert.equal(result.includes("Downloading"), false, "download notices are noise");
    assert.ok(result.indexOf("error TS2322") < result.indexOf("at Module._compile"), "diagnostics first");
  });

  test("keeps a context line that belongs to a diagnostic", () => {
    const output = [
      "some unrelated banner",
      "error TS2322: Type 'string' is not assignable to type 'number'.",
      "  42 | const x: number = 'nope';",
    ].join("\n");

    const result = pruneTrace(output, 12);
    assert.ok(result.includes("42 | const x: number"), "the source line explains the error");
    assert.equal(result.includes("unrelated banner"), false);
  });

  test("drops context that belongs to nothing", () => {
    const output = ["error TS1000: real", "  99 | orphaned context line"].join("\n");
    const result = pruneTrace(output, 12);
    assert.ok(result.includes("error TS1000"));
  });

  test("ranks a test failure above a version banner", () => {
    const output = ["v22.0.0", "✖ adds two numbers", "npm notice lifecycle"].join("\n");
    const result = pruneTrace(output, 12);
    assert.ok(result.includes("adds two numbers"));
    assert.equal(result.includes("npm notice"), false);
  });
});

describe("pruneTrace — node:test TAP output", () => {
  const output = [
    "TAP version 13",
    "# Subtest: report lists lines and the total",
    "not ok 1 - report lists lines and the total",
    "  ---",
    "  duration_ms: 1.727351",
    "  location: '/p/test/invoice.test.ts:5:1'",
    "  error: |-",
    "    Expected values to be strictly equal:",
    "    + actual - expected",
    "",
    "    + 'Tea: 5.00'",
    "    - 'Tea: €5.00'",
    "  code: 'ERR_ASSERTION'",
    "  expected: |-",
    "    Tea: €5.00",
    "  actual: |-",
    "    Tea: 5.00",
    "  stack: |-",
    "    TestContext.<anonymous> (file:///p/test/invoice.test.ts:7:10)",
    "    Test.runInAsyncScope (node:async_hooks:214:14)",
    "    Test.run (node:internal/test_runner/test:1047:25)",
    "    Test.start (node:internal/test_runner/test:944:17)",
    "  ...",
    "# fail 1",
  ].join("\n");

  test("keeps the values that explain the assertion, ahead of stack frames", () => {
    const result = pruneTrace(output, 12);
    for (const needle of ["not ok 1", "+ 'Tea: 5.00'", "- 'Tea: €5.00'", "Tea: €5.00", "Expected values to be strictly equal"]) {
      assert.ok(result.includes(needle), `missing ${needle}:\n${result}`);
    }
    assert.equal(/^error: \|-$/m.test(result), false, "the YAML key is not mistaken for an error");
    assert.ok(result.indexOf("- 'Tea: €5.00'") < result.indexOf("Test.run ("), "values before frames");
  });
});
