import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildFailureFeedback, spillDir, type FailureFeedbackInput } from "../src/formatting/feedback.ts";
import { recordVerified, forgetVerified, stateHashOf } from "../src/clients/evidence.ts";
import { _clearCache } from "../src/clients/mindplace.ts";

let home: string;
let dir: string;
let file: string;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-fb-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-fb-"));
  file = path.join(dir, "config.ts");
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(dir, "graph-out"), { recursive: true, force: true });
  _clearCache();
  fs.writeFileSync(file, "export const a = 1;\n");
  forgetVerified(dir, [file]);
});

function input(overrides: Partial<FailureFeedbackInput> = {}): FailureFeedbackInput {
  return {
    cwd: dir,
    step: "type-check",
    exitCode: 2,
    durationMs: 120,
    prunedTrace: "config.ts(4,12): error TS2322",
    rawOutput: "config.ts(4,12): error TS2322",
    warnOnly: false,
    rolledBack: false,
    focusPaths: [file],
    maxOutputTokens: 2500,
    ...overrides,
  };
}

describe("buildFailureFeedback", () => {
  test("contains the pruned trace and the honest advice", () => {
    const { text } = buildFailureFeedback(input());
    assert.ok(text.includes("error TS2322"));
    assert.ok(text.includes("still in place"));
  });

  test("does not claim a rollback that did not happen", () => {
    const { text } = buildFailureFeedback(input({ rolledBack: false }));
    assert.equal(text.includes("rolled back"), false);
  });

  test("says so when the working tree was restored", () => {
    const { text } = buildFailureFeedback(input({ rolledBack: true }));
    assert.ok(text.includes("rolled back"));
  });

  test("prints the state hash the result refers to", () => {
    const { text } = buildFailureFeedback(input());
    assert.ok(text.includes(`state: ${stateHashOf([file])}`));
  });

  test("reports a regression from a verified state (P2)", () => {
    recordVerified(dir, [file], "onTurnEnd:unit-tests");
    fs.writeFileSync(file, "export const a = 'broken';\n");

    const { text } = buildFailureFeedback(input());
    assert.ok(text.includes("Regressed from a verified state (1 file(s))"));
    assert.ok(text.includes("onTurnEnd:unit-tests"));
    assert.ok(text.includes("config.ts"), "the regressed file is named");
  });

  test("omits regressions when asked to", () => {
    recordVerified(dir, [file], "step");
    fs.writeFileSync(file, "export const a = 'broken';\n");
    const { text } = buildFailureFeedback(input({ includeRegressions: false }));
    assert.equal(text.includes("Regressed from a verified state"), false);
  });

  test("adds the code-graph impact when a graph exists", () => {
    fs.mkdirSync(path.join(dir, "graph-out"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "graph-out", "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "cfg", label: "config.ts", type: "file", sourceFile: "config.ts" },
          { id: "a", label: "parseConfig", type: "function", sourceFile: "config.ts" },
          { id: "u", label: "runner.ts", type: "file", sourceFile: "src/runner.ts" },
        ],
        edges: [{ source: "u", target: "a", relation: "imports" }],
      }),
      "utf-8",
    );
    _clearCache();

    const { text } = buildFailureFeedback(input());
    assert.ok(text.includes("Impact (code graph"));
    assert.ok(text.includes("src/runner.ts"), "dependents are named");
    assert.ok(text.includes("parseConfig"), "symbols are named");
  });

  test("omits the impact section without a graph", () => {
    const { text } = buildFailureFeedback(input());
    assert.equal(text.includes("Impact (code graph"), false);
  });

  test("shows the bounded-repair accounting (P0)", () => {
    const { text } = buildFailureFeedback(
      input({ attempt: { attempt: 2, max: 3 } }),
    );
    assert.ok(text.includes("Repair attempt 2/3"));
  });

  test("explains why the loop stopped when the state did not move", () => {
    const { text } = buildFailureFeedback(
      input({ attempt: { attempt: 3, max: 3, stopped: true } }),
    );
    assert.ok(text.includes("identical code state"));
  });

  test("never mentions attempts for a warnOnly step", () => {
    const { text } = buildFailureFeedback(
      input({ warnOnly: true, attempt: { attempt: 1, max: 3 } }),
    );
    assert.ok(text.includes("WARNING only"));
    assert.equal(text.includes("Repair attempt"), false);
  });

  test("enforces the output budget and spills the rest (P5)", () => {
    const long = "error TS9999: very long line\n".repeat(2000);
    const { text, spilledPath } = buildFailureFeedback(
      input({ prunedTrace: long, rawOutput: long, maxOutputTokens: 100 }),
    );

    assert.ok(text.length < long.length, "the preview is smaller than the input");
    assert.ok(spilledPath, "the full payload is written to a file");
    assert.equal(fs.existsSync(spilledPath!), true);
    assert.ok(spilledPath!.startsWith(spillDir(dir)), "spills live in the project dir");
  });

  test("a budget of zero keeps the payload intact", () => {
    const long = "x".repeat(50_000);
    const { text, spilledPath } = buildFailureFeedback(
      input({ prunedTrace: long, rawOutput: long, maxOutputTokens: 0 }),
    );
    assert.equal(spilledPath, undefined);
    assert.equal(text.includes(long), true);
  });
});
