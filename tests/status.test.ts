import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  formatDuration,
  formatStamp,
  metricsLines,
  turnHistoryLines,
  verificationLines,
} from "../src/formatting/status.ts";
import { emptyMetrics } from "../src/config.ts";

describe("formatDuration", () => {
  test("milliseconds, seconds and minutes", () => {
    assert.equal(formatDuration(420), "420ms");
    assert.equal(formatDuration(2400), "2.4s");
    assert.equal(formatDuration(64_000), "1m 04s");
  });

  test("never produces a negative or NaN line", () => {
    assert.equal(formatDuration(Number.NaN), "0ms");
    assert.equal(formatDuration(-5), "0ms");
  });
});

describe("formatStamp", () => {
  test("renders an ISO timestamp readably", () => {
    assert.equal(formatStamp("2026-09-13T13:06:20.123Z"), "2026-09-13 13:06:20");
  });
});

describe("metricsLines", () => {
  test("summarises counters and averages the check duration", () => {
    const lines = metricsLines({
      ...emptyMetrics(),
      checks: 4,
      successes: 3,
      failures: 1,
      totalDurationMs: 1600,
      cacheHits: 2,
      cacheMisses: 2,
      timeouts: 1,
      skippedSteps: 3,
      retries: 1,
      escalations: 1,
      rollbacks: 2,
      partialRollbacks: 1,
    }).join("\n");

    assert.ok(lines.includes("Performance"));
    assert.ok(lines.includes("checks:      4 (3 ok / 1 failed)"));
    assert.ok(lines.includes("2 hit(s) / 2 miss(es)"));
    assert.ok(lines.includes("avg check:   400ms"));
    assert.ok(lines.includes("timeouts: 1"));
    assert.ok(lines.includes("3 skipped"));
    assert.ok(lines.includes("rollbacks:   2 (1 partial)"));
  });

  test("does not divide by zero on a fresh project", () => {
    assert.ok(metricsLines(emptyMetrics()).join("\n").includes("avg check:   0ms"));
  });
});

describe("verificationLines", () => {
  test("renders compact, log-free one-liners", () => {
    const lines = verificationLines([
      { at: "2026-09-13T13:00:00.000Z", step: "type-check", passed: true, exitCode: 0, durationMs: 420 },
      { at: "2026-09-13T12:59:00.000Z", step: "unit-tests", passed: false, exitCode: 1, durationMs: 2400 },
    ]);
    assert.deepEqual(lines, ["  ✓ type-check  420ms", "  ✗ unit-tests  2.4s"]);
  });

  test("honours the limit", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      at: new Date().toISOString(),
      step: `s${i}`,
      passed: true,
      exitCode: 0,
      durationMs: 1,
    }));
    assert.equal(verificationLines(records, 3).length, 3);
  });
});

describe("turnHistoryLines", () => {
  test("marks the outcome and names the failing step only when red", () => {
    const lines = turnHistoryLines([
      { at: "2026-09-13T13:06:20.000Z", turnIndex: 33, passed: false, step: "unit-tests" },
      { at: "2026-09-13T13:05:00.000Z", turnIndex: 32, passed: true },
    ]);
    assert.deepEqual(lines, [
      "  ✗ turn #33  2026-09-13 13:06:20  (unit-tests)",
      "  ✓ turn #32  2026-09-13 13:05:00",
    ]);
  });
});
