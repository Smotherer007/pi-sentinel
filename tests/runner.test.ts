import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PipelineRunner } from "../src/clients/pipeline-runner.ts";
import { defineConfig, _setConfigForTesting } from "../src/config.ts";

let dir: string;
let home: string;

before(() => {
  // Keep state writes out of the real home directory.
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-run-"));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("PipelineRunner.execute", () => {
  const runner = new PipelineRunner();

  test("reports exit 0 for a successful command", async () => {
    const outcome = await runner.execute({ name: "ok", cmd: "exit 0", timeoutMs: 5000 }, dir);
    assert.equal(outcome.exitCode, 0);
  });

  test("captures non-zero exit codes", async () => {
    const outcome = await runner.execute({ name: "bad", cmd: "echo boom && exit 3", timeoutMs: 5000 }, dir);
    assert.equal(outcome.exitCode, 3);
    assert.ok(outcome.stdout.includes("boom"));
  });

  test("kills a command that exceeds its timeout", async () => {
    const outcome = await runner.execute(
      { name: "slow", cmd: "sleep 5", timeoutMs: 200 },
      dir,
    );
    assert.equal(outcome.exitCode, 124);
    assert.ok(outcome.stdout.includes("timeout after 200ms"));
  });

  test("aborts a running command via AbortSignal", async () => {
    const controller = new AbortController();
    const promise = runner.execute(
      { name: "abortable", cmd: "sleep 5", timeoutMs: 10_000 },
      dir,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    const outcome = await promise;
    assert.equal(outcome.exitCode, 130);
    assert.equal(outcome.aborted, true);
  });
});

describe("PipelineRunner.runAll", () => {
  test("returns a failure for a critical step", async () => {
    _setConfigForTesting(
      defineConfig({
        maxTraceLines: 5,
        pipelines: {
          onFileMutation: [{ name: "crit", cmd: "echo 'error: nope' && exit 1", timeoutMs: 5000 }],
          onTurnEnd: [],
        },
      }),
    );
    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, false);
    assert.equal(run.failure?.step, "crit");
    assert.ok(run.failure?.prunedTrace.includes("error: nope"));
    assert.equal(run.failure?.formattedError.includes("still in place"), true);
  });

  test("collects warnOnly failures without failing the run", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [
            { name: "lint", cmd: "echo 'warn: style' && exit 2", timeoutMs: 5000, warnOnly: true },
          ],
          onTurnEnd: [],
        },
      }),
    );
    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, true);
    assert.equal(run.failure, null);
    assert.equal(run.warnings.length, 1);
    assert.equal(run.warnings[0].step, "lint");
  });

  test("reports passed for an empty pipeline", async () => {
    _setConfigForTesting(
      defineConfig({ pipelines: { onFileMutation: [], onTurnEnd: [] } }),
    );
    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, true);
    assert.deepEqual(run.steps, []);
  });
});
