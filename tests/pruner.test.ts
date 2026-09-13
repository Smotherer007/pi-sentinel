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

  test("prints the code state the result refers to", () => {
    const text = formatError({ ...base, stateHash: "abc123abc123" });
    assert.ok(text.includes("state: abc123abc123"));
  });

  test("reports regressed verified states", () => {
    const text = formatError({
      ...base,
      regressions: [
        {
          path: "/repo/src/config.ts",
          verifiedAt: "2026-09-13T09:07:38.000Z",
          verifiedStep: "onTurnEnd:unit-tests",
          verifiedHash: "aaaaaaaaaaaa",
          currentHash: "bbbbbbbbbbbb",
          reverted: false,
        },
      ],
    });

    assert.ok(text.includes("Regressed from a verified state (1 file(s))"), text);
    assert.ok(text.includes("src/config.ts"), "names the regressed file");
    assert.ok(text.includes("onTurnEnd:unit-tests"));
    assert.ok(text.includes("current: bbbbbbbbbbbb vs verified: aaaaaaaaaaaa"));
    assert.equal(text.includes("rolled back"), false, "a regression is not a rollback");
  });

  test("marks a regression that was reverted", () => {
    const text = formatError({
      ...base,
      regressions: [
        {
          path: "/repo/src/config.ts",
          verifiedAt: "2026-09-13T09:07:38.000Z",
          verifiedStep: "step",
          verifiedHash: "aaaa",
          currentHash: "bbbb",
          reverted: true,
        },
      ],
    });
    assert.ok(text.includes("restored to the verified state"));
  });

  test("lists the code-graph blast radius", () => {
    const text = formatError({
      ...base,
      impact: [
        { file: "src/config.ts", symbols: ["parseConfig", "deepMerge"], dependents: ["src/index.ts"] },
      ],
    });
    assert.ok(text.includes("Impact (code graph):"));
    assert.ok(text.includes("src/config.ts"));
    assert.ok(text.includes("parseConfig, deepMerge"));
    assert.ok(text.includes("src/index.ts"));
  });

  test("says none when a file has no dependents", () => {
    const text = formatError({
      ...base,
      impact: [{ file: "src/leaf.ts", symbols: ["leaf"], dependents: [] }],
    });
    assert.ok(text.includes("→ none"));
  });

  test("reports the bounded-retry budget", () => {
    const text = formatError({ ...base, attempt: { attempt: 2, max: 3 } });
    assert.ok(text.includes("Repair attempt 2/3"));
    assert.ok(text.includes("stop and report"));
  });

  test("explains a stop caused by an unchanged code state", () => {
    const text = formatError({ ...base, attempt: { attempt: 3, max: 3, stopped: true } });
    assert.ok(text.includes("identical code state"));
  });

  test("keeps the original ordering of sections", () => {
    const text = formatError({
      ...base,
      stateHash: "deadbeefdead",
      regressions: [
        {
          path: "/repo/a.ts",
          verifiedAt: "2026-09-13T09:00:00.000Z",
          verifiedStep: "step",
          verifiedHash: "1",
          currentHash: "2",
          reverted: false,
        },
      ],
      impact: [{ file: "a.ts", symbols: [], dependents: ["b.ts"] }],
    });

    const traceAt = text.indexOf("error TS2304");
    const regressionAt = text.indexOf("Regressed from a verified state");
    const impactAt = text.indexOf("Impact (code graph):");
    const adviceAt = text.indexOf("still in place");

    assert.ok(traceAt < regressionAt && regressionAt < impactAt && impactAt < adviceAt, text);
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

describe("formatError — structured failure information", () => {
  const base = {
    step: "type-check",
    exitCode: 2,
    durationMs: 10,
    prunedTrace: "error TS2322",
    rawOutput: "raw",
    warnOnly: false,
  };

  test("names the failure kind and the concrete error", () => {
    const text = formatError({
      ...base,
      failureKind: "type-error",
      errorSummary: "src/a.ts(1,1): error TS2322: nope",
    });
    assert.ok(text.includes("kind: type error"));
    assert.ok(text.includes("what failed: src/a.ts(1,1): error TS2322: nope"));
  });

  test("tells the agent a timeout is not a code error", () => {
    const text = formatError({ ...base, failureKind: "timeout", timedOut: true });
    assert.ok(text.includes("timed out"));
    assert.ok(text.includes("not a code error"));
    assert.ok(text.includes("still in place"), "a timeout never triggers a rollback");
  });

  test("tells the agent not to fix code for a missing command", () => {
    const text = formatError({ ...base, failureKind: "command-not-found" });
    assert.ok(text.includes("could not be started"));
    assert.ok(text.includes("do not change application code"));
  });

  test("reports how many attempts a retried step needed", () => {
    const text = formatError({ ...base, attempts: 2 });
    assert.ok(text.includes("attempts: 2"));
  });

  test("reports a rollback conflict without claiming a restore", () => {
    const text = formatError({
      ...base,
      failureKind: "type-error",
      conflicts: [
        {
          path: "/repo/src/foo.ts",
          expectedHash: "aaaaaaaaaaaa",
          actualHash: "bbbbbbbbbbbb",
          reason: "modified after the Sentinel snapshot",
        },
      ],
    });
    assert.ok(text.includes("ROLLBACK CONFLICT"));
    assert.ok(text.includes("src/foo.ts was modified after the Sentinel snapshot."));
    assert.ok(text.includes("The file was NOT overwritten. Manual recovery required."));
    assert.equal(text.includes("still in place"), false, "a conflict is not a clean no-op");
  });

  test("escalates a repeated failure with explicit guidance", () => {
    const text = formatError({ ...base, failureKind: "type-error", escalation: { count: 3, max: 3 } });
    assert.ok(text.includes("Repeated verification failure detected."));
    assert.ok(text.includes("occurred 3 time(s)"));
    assert.ok(text.includes("Do not repeat the same approach"));
  });

  test("places the rollback advice before the kind-specific hint", () => {
    const text = formatError({ ...base, rolledBack: true, failureKind: "timeout", timedOut: true });
    const rollbackAt = text.indexOf("Your changes were rolled back");
    const kindAt = text.indexOf("This is a timeout");
    assert.ok(rollbackAt >= 0 && kindAt >= 0, text);
    assert.ok(rollbackAt < kindAt, "the outcome first, then what to do about the kind");
  });

  test("appends the escalation after the advice, so the advice is read first", () => {
    const text = formatError({ ...base, failureKind: "test-failure", escalation: { count: 3, max: 3 } });
    assert.ok(text.indexOf("Fix the reported error") < text.indexOf("Repeated verification failure"));
  });
});
