import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { isInfrastructureFailure, ranAnything, runChecks, runStep, stepApplies } from "../src/runner.ts";
import { tempDir } from "./helpers.ts";

describe("runStep", () => {
  const cwd = tempDir();

  test("a passing command", async () => {
    const result = await runStep({ name: "ok", cmd: "echo hello" }, { cwd });
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /hello/);
    assert.equal(result.kind, undefined);
  });

  test("a failing command is classified from its output", async () => {
    const result = await runStep({ name: "typecheck", cmd: "echo \"src/a.ts(1,2): error TS2322: nope\"; exit 2" }, { cwd });
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 2);
    assert.equal(result.kind, "type-error");
  });

  test("a missing command is an infrastructure failure", async () => {
    const result = await runStep({ name: "lint", cmd: "definitely-not-a-command-xyz" }, { cwd });
    assert.equal(result.kind, "command-not-found");
    assert.equal(isInfrastructureFailure(result), true);
  });

  test("a timeout kills the whole process tree", async () => {
    const marker = path.join(cwd, "survivor");
    const started = Date.now();
    const result = await runStep({ name: "slow", cmd: `(sleep 2 && touch ${marker}) & sleep 5`, timeoutMs: 300 }, { cwd });
    assert.equal(result.timedOut, true);
    assert.equal(result.kind, "timeout");
    assert.ok(Date.now() - started < 2_000, "returns at the deadline");
    await new Promise((r) => setTimeout(r, 2_300));
    assert.equal(fs.existsSync(marker), false, "the background child was killed too");
  });

  test("secrets from the environment are redacted", async () => {
    const result = await runStep({ name: "leak", cmd: "echo $API_TOKEN", env: { API_TOKEN: "super-secret-value-123" } }, { cwd });
    assert.doesNotMatch(result.output, /super-secret-value-123/);
  });

  test("a cwd outside the project is refused", async () => {
    const result = await runStep({ name: "escape", cmd: "pwd", cwd: "../.." }, { cwd });
    assert.equal(result.passed, false);
    assert.equal(result.kind, "environment-error");
  });

  test("an abort signal stops the command", async () => {
    const controller = new AbortController();
    const pending = runStep({ name: "long", cmd: "sleep 5" }, { cwd, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.equal(result.exitCode, 130);
    assert.equal(result.kind, "environment-error", "an abort is never a code failure");
  });
});

describe("runChecks", () => {
  const cwd = tempDir();

  test("stops at the first blocking failure", async () => {
    const run = await runChecks(
      [
        { name: "a", cmd: "exit 1" },
        { name: "b", cmd: "echo never" },
      ],
      { cwd },
    );
    assert.equal(run.passed, false);
    assert.equal(run.failure?.name, "a");
    assert.equal(run.steps.length, 1);
  });

  test("warning-only steps do not block", async () => {
    const run = await runChecks(
      [
        { name: "lint", cmd: "exit 1", warnOnly: true },
        { name: "test", cmd: "exit 0" },
      ],
      { cwd },
    );
    assert.equal(run.passed, true);
    assert.deepEqual(run.warnings.map((w) => w.name), ["lint"]);
  });

  test("steps with a files filter skip unrelated changes", async () => {
    const run = await runChecks([{ name: "tsc", cmd: "exit 1", files: ["**/*.ts"] }], { cwd, changed: [path.join(cwd, "README.md")] });
    assert.equal(run.passed, true);
    assert.equal(run.steps[0].skipped, "no matching files changed");
    assert.equal(ranAnything(run), false);
  });

  test("files filters match project-relative paths", () => {
    const step = { name: "tsc", cmd: "true", files: ["**/*.ts"] };
    assert.equal(stepApplies(step, cwd, [path.join(cwd, "src/deep/a.ts")]), true);
    assert.equal(stepApplies(step, cwd, [path.join(cwd, "docs/a.md")]), false);
    assert.equal(stepApplies(step, cwd, undefined), true, "no change list means run");
  });
});
