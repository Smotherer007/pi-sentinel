import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, parseArgs } from "../src/cli.ts";
import { formatDuration } from "../src/duration.ts";

test("defaults", () => {
  assert.equal(describe(parseArgs([])), "retries=3 timeout=10m");
});

test("formatDuration", () => {
  assert.equal(formatDuration(5400), "1h30m");
  assert.equal(formatDuration(45), "45s");
});
