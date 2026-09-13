import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { preview, applyOutputCap, CHARS_PER_TOKEN } from "../src/clients/spill.ts";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-spill-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("preview", () => {
  test("returns the text unchanged when it fits", () => {
    assert.equal(preview("short", 100), "short");
  });

  test("a zero budget disables truncation", () => {
    const text = "x".repeat(1000);
    assert.equal(preview(text, 0), text);
  });

  test("keeps the head and the tail around an explicit notice", () => {
    const text = `HEAD${"y".repeat(500)}TAIL`;
    const result = preview(text, 100, "… [cut]");

    assert.ok(result.length <= 100 + "… [cut]".length + 1, "result stays near the budget");
    assert.ok(result.startsWith("HEAD"), "leading context is kept");
    assert.ok(result.endsWith("TAIL"), "trailing summary is kept");
    assert.ok(result.includes("… [cut]"), "the cut is announced, never silent");
  });

  test("marks truncation instead of pretending the output was complete", () => {
    const result = preview("a".repeat(400), 40);
    assert.ok(result.includes("truncated"), "must not look like a complete log");
  });
});

describe("applyOutputCap", () => {
  test("passes small payloads through without touching the disk", () => {
    const result = applyOutputCap("error TS1", 2500, path.join(dir, "spills"), "type-check");
    assert.equal(result.text, "error TS1");
    assert.equal(result.spilledPath, undefined);
    assert.equal(fs.existsSync(path.join(dir, "spills")), false);
  });

  test("caps the payload and spills the full output to a file", () => {
    const text = "error TS1234: something\n".repeat(5000);
    const result = applyOutputCap(text, 100, path.join(dir, "spills"), "type-check");

    assert.equal(result.text.length <= 100 * CHARS_PER_TOKEN + 200, true, "preview is bounded");
    assert.ok(result.spilledPath, "a spill file is reported");
    assert.equal(fs.readFileSync(result.spilledPath!, "utf-8"), text, "full output is preserved");
  });

  test("still returns a bounded preview when spilling is impossible", () => {
    // A path under a file (not a directory) cannot be created.
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x");
    const result = applyOutputCap("z".repeat(50_000), 100, path.join(blocker, "spills"), "step");

    assert.equal(result.spilledPath, undefined);
    assert.ok(result.text.length < 10_000, "no unbounded output reaches the model");
  });
});
