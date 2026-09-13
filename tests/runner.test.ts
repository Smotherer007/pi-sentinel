import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PipelineRunner } from "../src/clients/pipeline-runner.ts";
import { _resetCacheForTesting } from "../src/clients/cache.ts";
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

describe("PipelineRunner hardening", () => {
  const runner = new PipelineRunner();

  test("classifies a failing step and exposes the structured result", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [
            {
              name: "type-check",
              cmd: "echo \"src/a.ts(1,1): error TS2322: nope\" && exit 2",
              timeoutMs: 5000,
            },
          ],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, false);
    const failure = run.failure!;
    assert.equal(failure.failureKind, "type-error");
    assert.equal(failure.timedOut, false);
    assert.equal(failure.priority, "normal");
    assert.ok(failure.errorSummary?.includes("error TS2322"));
    assert.equal(failure.signature.length, 12);
    assert.equal(failure.attempts, 1);
    assert.equal(run.steps[0].failureKind, "type-error");
  });

  test("a timeout is reported as a timeout, not as a code error", async () => {
    _setConfigForTesting(
      defineConfig({
        verification: { killGraceMs: 100 },
        pipelines: {
          onFileMutation: [{ name: "slow", cmd: "sleep 10", timeoutMs: 150 }],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    const failure = run.failure!;
    assert.equal(failure.timedOut, true);
    assert.equal(failure.failureKind, "timeout");
    assert.equal(failure.exitCode, 124);
    assert.ok(failure.formattedError.includes("not a code error"), failure.formattedError);
  });

  test("kills the whole process tree on timeout", async () => {
    const late = path.join(dir, "late.txt");
    fs.rmSync(late, { force: true });

    // The shell must stay alive as the parent (two commands), so killing only
    // the shell would leave `node` running long enough to write the file.
    const step = {
      name: "tree",
      cmd: "sleep 0.1; node -e \"setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 300)\"",
      timeoutMs: 150,
    };

    const outcome = await runner.execute(step, dir);
    assert.equal(outcome.exitCode, 124);
    await new Promise((done) => setTimeout(done, 700));
    assert.equal(fs.existsSync(late), false, "a killed step must not keep working in the background");
  });

  test("applies the priority of a step: warning never fails the run", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [
            { name: "lint", cmd: "echo 'lint problem' && exit 1", timeoutMs: 5000, priority: "warning" },
          ],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, true);
    assert.equal(run.warnings.length, 1);
    assert.equal(run.warnings[0].failureKind, "lint-error");
  });

  test("warnOnly is still the same thing as priority warning", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [{ name: "lint", cmd: "exit 1", timeoutMs: 5000, warnOnly: true }],
          onTurnEnd: [],
        },
      }),
    );
    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, true);
  });

  test("critical steps block the run", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [{ name: "crit", cmd: "exit 1", timeoutMs: 5000, priority: "critical" }],
          onTurnEnd: [],
        },
      }),
    );
    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, false);
    assert.equal(run.failure?.priority, "critical");
  });

  test("skips steps whose phase does not match the trigger", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [{ name: "tests", cmd: "exit 1", timeoutMs: 5000, phase: "turn" }],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, true, "a turn-phase step must not run on a mutation");
    assert.equal(run.steps.length, 1);
    assert.ok(run.steps[0].skipped?.includes("phase"));
  });

  test("skips steps that do not match the changed files", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [
            { name: "type-check", cmd: "exit 1", timeoutMs: 5000, files: ["**/*.ts"] },
          ],
          onTurnEnd: [],
        },
      }),
    );

    const doc = path.join(dir, "notes.txt");
    fs.writeFileSync(doc, "hello");

    const skipped = await new PipelineRunner().runAll("onFileMutation", dir, { focusPaths: [doc] });
    assert.equal(skipped.passed, true);
    assert.ok(skipped.steps[0].skipped?.includes("no matching files"));

    const tsFile = path.join(dir, "a.ts");
    fs.writeFileSync(tsFile, "export const a = 1;");
    const ran = await new PipelineRunner().runAll("onFileMutation", dir, { focusPaths: [tsFile] });
    assert.equal(ran.passed, false, "a matching file runs the step");
  });

  test("a step without file patterns always runs", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [{ name: "always", cmd: "exit 1", timeoutMs: 5000 }],
          onTurnEnd: [],
        },
      }),
    );
    const run = await new PipelineRunner().runAll("onFileMutation", dir, {
      focusPaths: [path.join(dir, "whatever.txt")],
    });
    assert.equal(run.passed, false);
  });

  test("retries an infrastructure failure and reports the attempt count", async () => {
    const counter = path.join(dir, "counter.txt");
    fs.rmSync(counter, { force: true });
    // Relative path on purpose: the command runs with `dir` as its cwd, and
    // quoting an absolute path would fight the shell.
    const cmd =
      "node -e \"const fs=require('fs');const f='counter.txt';const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));process.exit(n===0?124:0)\"";

    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [
            {
              name: "flaky",
              cmd,
              timeoutMs: 5000,
              retry: { maxAttempts: 2, retryOn: ["timeout"] },
            },
          ],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, true, "the second attempt succeeded");
    assert.equal(run.steps[0].attempts, 2);
  });

  test("never retries a real code failure", async () => {
    const counter = path.join(dir, "counter2.txt");
    fs.rmSync(counter, { force: true });
    const cmd =
      "node -e \"const fs=require('fs');const f='counter2.txt';const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));console.log('error TS2322: boom');process.exit(1)\"";

    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [
            {
              name: "type-check",
              cmd,
              timeoutMs: 5000,
              retry: { maxAttempts: 3, retryOn: ["timeout", "environment-error"] },
            },
          ],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, false);
    assert.equal(run.steps[0].attempts, 1, "a type error is not retried");
    assert.equal(fs.readFileSync(counter, "utf-8"), "1");
  });

  test("bounds the output buffer and announces the truncation", async () => {
    _setConfigForTesting(
      defineConfig({
        verification: { maxOutputBytes: 200 },
        pipelines: {
          onFileMutation: [
            {
              name: "noisy",
              cmd: "node -e \"for (let i = 0; i < 2000; i++) console.log('error TS9999: boom ' + i); process.exit(1)\"",
              timeoutMs: 10000,
            },
          ],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    const output = run.failure!.rawOutput;
    assert.ok(output.length < 2000, `output must stay bounded, got ${output.length}`);
    assert.ok(output.includes("output truncated"));
  });

  test("redacts credentials from the step environment", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [
            {
              name: "leaky",
              cmd: "node -e \"console.log('token is ' + process.env.SENTINEL_TEST_TOKEN); process.exit(1)\"",
              timeoutMs: 5000,
              env: { SENTINEL_TEST_TOKEN: "super-secret-value-1234" },
            },
          ],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.failure!.rawOutput.includes("super-secret-value-1234"), false);
    assert.ok(run.failure!.rawOutput.includes("[redacted]"));
  });

  test("refuses a working directory outside the project", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [{ name: "escape", cmd: "pwd", timeoutMs: 5000, cwd: "../.." }],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, false);
    assert.equal(run.failure!.failureKind, "environment-error");
    assert.ok(run.failure!.rawOutput.includes("escapes the project root"));
  });

  test("accepts a working directory inside the project", async () => {
    const sub = path.join(dir, "nested");
    fs.mkdirSync(sub, { recursive: true });
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [{ name: "inside", cmd: "exit 0", timeoutMs: 5000, cwd: "nested" }],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    assert.equal(run.passed, true);
  });
});

describe("PipelineRunner cache integration", () => {
  test("reuses a passing run for an identical state", async () => {
    _resetCacheForTesting();
    const file = path.join(dir, "cached.ts");
    fs.writeFileSync(file, "export const a = 1;\n");

    _setConfigForTesting(
      defineConfig({
        verification: { cache: { enabled: true, persist: false, ttlMs: 0, maxEntries: 10 } },
        pipelines: {
          onFileMutation: [{ name: "check", cmd: "echo ok && exit 0", timeoutMs: 5000 }],
          onTurnEnd: [],
        },
      }),
    );

    const first = await new PipelineRunner().runAll("onFileMutation", dir, { focusPaths: [file] });
    assert.equal(first.passed, true);
    assert.equal(first.cached, undefined);

    const second = await new PipelineRunner().runAll("onFileMutation", dir, { focusPaths: [file] });
    assert.equal(second.passed, true);
    assert.equal(second.cached, true);
    assert.equal(second.steps[0].cached, true);
  });

  test("skipCache forces a real run", async () => {
    _resetCacheForTesting();
    const file = path.join(dir, "skipped.ts");
    fs.writeFileSync(file, "export const a = 1;\n");

    _setConfigForTesting(
      defineConfig({
        verification: { cache: { enabled: true, persist: false, ttlMs: 0, maxEntries: 10 } },
        pipelines: {
          onFileMutation: [{ name: "check", cmd: "exit 0", timeoutMs: 5000 }],
          onTurnEnd: [],
        },
      }),
    );

    await new PipelineRunner().runAll("onFileMutation", dir, { focusPaths: [file] });
    const forced = await new PipelineRunner().runAll("onFileMutation", dir, {
      focusPaths: [file],
      skipCache: true,
    });
    assert.equal(forced.cached, undefined);
  });

  test("a step marked cacheable:false disables caching for the run", async () => {
    _resetCacheForTesting();
    const file = path.join(dir, "flaky.ts");
    fs.writeFileSync(file, "export const a = 1;\n");

    _setConfigForTesting(
      defineConfig({
        verification: { cache: { enabled: true, persist: false, ttlMs: 0, maxEntries: 10 } },
        pipelines: {
          onFileMutation: [{ name: "tests", cmd: "exit 0", timeoutMs: 5000, cacheable: false }],
          onTurnEnd: [],
        },
      }),
    );

    await new PipelineRunner().runAll("onFileMutation", dir, { focusPaths: [file] });
    const again = await new PipelineRunner().runAll("onFileMutation", dir, { focusPaths: [file] });
    assert.equal(again.cached, undefined, "a non-deterministic step is never reused");
  });

  test("changing the file invalidates the cached result", async () => {
    _resetCacheForTesting();
    const file = path.join(dir, "changing.ts");
    fs.writeFileSync(file, "v1\n");

    _setConfigForTesting(
      defineConfig({
        verification: { cache: { enabled: true, persist: false, ttlMs: 0, maxEntries: 10 } },
        pipelines: {
          onFileMutation: [{ name: "check", cmd: "exit 0", timeoutMs: 5000 }],
          onTurnEnd: [],
        },
      }),
    );

    await new PipelineRunner().runAll("onFileMutation", dir, { focusPaths: [file] });
    fs.writeFileSync(file, "v2\n");
    const after = await new PipelineRunner().runAll("onFileMutation", dir, { focusPaths: [file] });
    assert.equal(after.cached, undefined, "new content is a new question");
  });
});

describe("PipelineRunner — missing commands and per-step pruning budget", () => {
  test("a missing command is a failure the agent can classify, never a crash", async () => {
    _setConfigForTesting(
      defineConfig({
        pipelines: {
          onFileMutation: [
            { name: "missing", cmd: "sentinel-no-such-command-xyz --version", timeoutMs: 5000 },
          ],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);

    assert.equal(run.passed, false);
    assert.equal(run.failure?.failureKind, "command-not-found");
    assert.notEqual(run.failure?.exitCode, 0);
  });

  test("a step's maxTraceLines overrides the global pruner budget", async () => {
    _setConfigForTesting(
      defineConfig({
        maxTraceLines: 10,
        pipelines: {
          onFileMutation: [
            {
              name: "terse",
              cmd: "printf 'error TS1: a\\nerror TS2: b\\nerror TS3: c\\n' && exit 1",
              timeoutMs: 5000,
              maxTraceLines: 1,
            },
          ],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    const trace = run.failure?.prunedTrace ?? "";

    assert.equal(run.passed, false);
    assert.ok(trace.includes("error TS1"), "the first diagnostic is kept");
    assert.ok(!trace.includes("error TS2"), "the per-step budget wins over the global one");
    assert.ok(!trace.includes("error TS3"));
  });
});

describe("PipelineRunner config safety", () => {
  test("an invalid timeoutMs is refused, not reported as a timeout", async () => {
    // Regression: 0/negative/NaN/Infinity and a missing value all collapse to
    // a ~1 ms setTimeout, which reported every healthy check as a timeout — and
    // with autoRollback on that undid a perfectly good change.
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      _setConfigForTesting(
        defineConfig({
          pipelines: {
            onFileMutation: [{ name: "healthy", cmd: "exit 0", timeoutMs: timeoutMs as number }],
            onTurnEnd: [],
          },
        }),
      );

      const run = await new PipelineRunner().runAll("onFileMutation", dir);
      assert.equal(run.passed, false, `timeoutMs ${String(timeoutMs)} must not pass`);
      assert.equal(run.failure?.timedOut, false, "it is a config error, not a timeout");
      assert.equal(run.failure?.failureKind, "environment-error");
      assert.ok(run.failure?.formattedError.includes("invalid timeoutMs"));
    }
  });

  test("a negative output cap cannot grow the buffer without bound", async () => {
    const script = `let i=0; const w=()=>{ if(i++<4000){ process.stdout.write("0123456789"); setImmediate(w);} else process.exit(1);}; w();`;
    _setConfigForTesting(
      defineConfig({
        verification: { maxOutputBytes: -1 },
        pipelines: {
          onFileMutation: [{ name: "noisy", cmd: `node -e '${script}'`, timeoutMs: 20000 }],
          onTurnEnd: [],
        },
      }),
    );

    const run = await new PipelineRunner().runAll("onFileMutation", dir);
    const output = run.failure?.rawOutput ?? "";
    assert.ok(output.length < 2_000_000, `output must stay bounded, got ${output.length}`);
  });
});
