import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  defineConfig,
  DEFAULT_CONFIG,
  isExcluded,
  shouldVerify,
  matchesGlob,
  loadConfig,
  getConfig,
  priorityOf,
  stepMatchesFiles,
  stepPhaseMatches,
  getState,
  recordMetrics,
  recordEscalation,
  recordTurnOutcome,
  _resetForTesting,
} from "../src/config.ts";

let home: string;
let project: string;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cfg-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  project = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cfg-"));
  fs.writeFileSync(path.join(project, "package.json"), '{"type":"module"}\n');
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe("defineConfig", () => {
  test("merges over defaults", () => {
    const conf = defineConfig({ maxTraceLines: 5 });
    assert.equal(conf.maxTraceLines, 5);
    assert.equal(conf.enabled, true);
    assert.equal(conf.pipelines.onFileMutation.length, 2);
  });

  test("every feature is on by default", () => {
    const conf = DEFAULT_CONFIG;

    // Master switches.
    assert.equal(conf.enabled, true);
    assert.equal(conf.autoRollback, true);

    // P0 close the loop.
    assert.equal(conf.autoFix, true);
    assert.equal(conf.maxAutoRetries, 3);

    // P1 checkpoints.
    assert.equal(conf.checkpointRetention, 50);

    // P2 state-bound evidence.
    assert.equal(conf.trackVerifiedState, true);
    assert.equal(conf.revertOnRegression, true);
    assert.equal(conf.pruneStaleTraces, true);

    // P3 out-of-band detection.
    assert.equal(conf.detectOutOfBand, true);

    // P4 revision contract.
    assert.equal(conf.revisionContract, true);

    // P5 background checks & output budget.
    assert.equal(conf.backgroundTurnEnd, true);
    assert.equal(conf.maxOutputTokens, 2500);

    // Mindplace synergy.
    assert.equal(conf.impactAwareFocus, true);
  });

  test("a project can switch any feature back off", () => {
    const conf = defineConfig({
      autoRollback: false,
      autoFix: false,
      backgroundTurnEnd: false,
      detectOutOfBand: false,
      revisionContract: false,
      revertOnRegression: false,
      pruneStaleTraces: false,
      trackVerifiedState: false,
      impactAwareFocus: false,
    });

    assert.equal(conf.autoRollback, false);
    assert.equal(conf.autoFix, false);
    assert.equal(conf.backgroundTurnEnd, false);
    assert.equal(conf.detectOutOfBand, false);
    assert.equal(conf.revisionContract, false);
    assert.equal(conf.revertOnRegression, false);
    assert.equal(conf.pruneStaleTraces, false);
    assert.equal(conf.trackVerifiedState, false);
    assert.equal(conf.impactAwareFocus, false);
  });

  test("deep merges nested pipelines", () => {
    const conf = defineConfig({
      pipelines: { onTurnEnd: [{ name: "t", cmd: "npm test", timeoutMs: 5000 }] },
    });
    assert.equal(conf.pipelines.onTurnEnd.length, 1);
    assert.equal(conf.pipelines.onFileMutation.length, 2, "should keep default onFileMutation");
  });

  test("preserves onFileMutation when empty provided", () => {
    const conf = defineConfig({
      pipelines: { onFileMutation: [] },
    });
    assert.equal(conf.pipelines.onFileMutation.length, 0);
    assert.equal(conf.pipelines.onTurnEnd.length, 1);
  });

  test("returns default when no overrides", () => {
    assert.deepEqual(defineConfig({}), DEFAULT_CONFIG);
  });
});

describe("matchesGlob", () => {
  test("leading **/ matches zero directories", () => {
    assert.equal(matchesGlob("**/node_modules/**", "node_modules/foo/index.js"), true);
    assert.equal(matchesGlob("**/node_modules/**", "a/node_modules/x.js"), true);
  });

  test("anchored patterns match relative paths", () => {
    assert.equal(matchesGlob("dist/**", "dist/a.js"), true);
    assert.equal(matchesGlob("dist/**", "src/a.js"), false);
  });

  test("**/*.md matches at any depth", () => {
    assert.equal(matchesGlob("**/*.md", "README.md"), true);
    assert.equal(matchesGlob("**/*.md", "docs/a.md"), true);
    assert.equal(matchesGlob("**/*.md", "src/a.ts"), false);
  });

  test("? matches a single non-slash character", () => {
    assert.equal(matchesGlob("a?.ts", "ab.ts"), true);
    assert.equal(matchesGlob("a?.ts", "a/b.ts"), false);
  });
});

describe("isExcluded", () => {
  test("matches node_modules", () => {
    assert.equal(isExcluded("node_modules/foo/index.js", DEFAULT_CONFIG), true);
  });
  test("matches md files", () => {
    assert.equal(isExcluded("README.md", DEFAULT_CONFIG), true);
  });
  test("does not exclude src", () => {
    assert.equal(isExcluded("src/index.ts", DEFAULT_CONFIG), false);
  });
  test("relativises absolute paths against cwd", () => {
    const cwd = "/home/u/proj";
    // Regression: `dist/**` used to miss absolute paths because the relative
    // path was reduced to a bare basename.
    assert.equal(isExcluded("/home/u/proj/dist/a.js", DEFAULT_CONFIG, cwd), true);
    assert.equal(isExcluded("/home/u/proj/src/a.ts", DEFAULT_CONFIG, cwd), false);
  });
  test("outside-cwd absolute paths are not matched by anchored patterns", () => {
    assert.equal(isExcluded("/home/u/other/dist/a.js", DEFAULT_CONFIG, "/home/u/proj"), false);
  });
});

describe("shouldVerify", () => {
  test("empty include verifies everything not excluded", () => {
    assert.equal(shouldVerify("src/a.ts", DEFAULT_CONFIG, "/p"), true);
    assert.equal(shouldVerify("README.md", DEFAULT_CONFIG, "/p"), false);
  });

  test("include restricts verification to matching files", () => {
    const conf = defineConfig({ include: ["src/**/*.ts"] });
    assert.equal(shouldVerify("src/a.ts", conf, "/p"), true);
    assert.equal(shouldVerify("tests/a.ts", conf, "/p"), false);
    assert.equal(shouldVerify("/p/src/nested/a.ts", conf, "/p"), true);
  });

  test("exclude wins over include", () => {
    const conf = defineConfig({ include: ["**/*.ts"] });
    assert.equal(shouldVerify("/p/dist/a.ts", conf, "/p"), false);
  });
});

test("reset helper restores defaults", () => {
  _resetForTesting();
  assert.equal(isExcluded("README.md", DEFAULT_CONFIG), true);
});

describe("loadConfig", () => {
  test("picks up an edit even when the mtime did not change", async () => {
    // Regression: cache-busting was mtime-based, and some filesystems (CI
    // containers, network mounts) have coarse mtime resolution. Two edits
    // inside one tick made Node's ESM loader serve the *old* config, so sentinel
    // silently kept verifying with stale pipelines.
    const file = path.join(project, "sentinel.config.js");
    const fixed = new Date("2026-01-01T00:00:00.000Z");

    fs.writeFileSync(file, "export default { maxTraceLines: 1 };\n", "utf-8");
    fs.utimesSync(file, fixed, fixed);
    await loadConfig(project);
    assert.equal(getConfig().maxTraceLines, 1);

    fs.writeFileSync(file, "export default { maxTraceLines: 2 };\n", "utf-8");
    fs.utimesSync(file, fixed, fixed);
    await loadConfig(project);
    assert.equal(getConfig().maxTraceLines, 2, "an unchanged mtime must not pin the old config");

    fs.rmSync(file);
    await loadConfig(project);
    assert.equal(getConfig().maxTraceLines, DEFAULT_CONFIG.maxTraceLines);
  });

  test("re-reads an unchanged file without re-evaluating a stale module", async () => {
    const file = path.join(project, "sentinel.config.js");
    fs.writeFileSync(file, "export default { maxTraceLines: 9 };\n", "utf-8");

    await loadConfig(project);
    assert.equal(getConfig().maxTraceLines, 9);
    await loadConfig(project);
    assert.equal(getConfig().maxTraceLines, 9, "idempotent across events");
  });
});

describe("P6 verification settings", () => {
  test("behaviour-changing features are opt-in", () => {
    // Deliberate: upgrading must not silently batch, reuse or escalate.
    assert.equal(DEFAULT_CONFIG.verification.debounceMs, 0);
    assert.equal(DEFAULT_CONFIG.verification.cache.enabled, false);
    assert.equal(DEFAULT_CONFIG.verification.failureEscalation.enabled, false);
  });

  test("safety limits are on unconditionally", () => {
    assert.ok(DEFAULT_CONFIG.verification.maxOutputBytes > 0);
    assert.ok(DEFAULT_CONFIG.verification.killGraceMs > 0);
  });

  test("a project can switch each of them on", () => {
    const conf = defineConfig({
      verification: {
        debounceMs: 150,
        cache: { enabled: true, ttlMs: 60_000, maxEntries: 10, persist: false },
        failureEscalation: { enabled: true, maxRepeatedFailures: 2 },
      },
    });
    assert.equal(conf.verification.debounceMs, 150);
    assert.equal(conf.verification.cache.enabled, true);
    assert.equal(conf.verification.cache.ttlMs, 60_000);
    assert.equal(conf.verification.failureEscalation.maxRepeatedFailures, 2);
    assert.equal(conf.verification.maxOutputBytes, DEFAULT_CONFIG.verification.maxOutputBytes);
  });

  test("nested cache settings merge instead of replacing", () => {
    const conf = defineConfig({ verification: { cache: { enabled: true } } });
    assert.equal(conf.verification.cache.persist, DEFAULT_CONFIG.verification.cache.persist);
    assert.equal(conf.verification.cache.ttlMs, DEFAULT_CONFIG.verification.cache.ttlMs);
  });
});

describe("priorityOf", () => {
  test("defaults to normal", () => {
    assert.equal(priorityOf({ name: "a", cmd: "a", timeoutMs: 1 }), "normal");
  });

  test("warnOnly is the legacy spelling of warning", () => {
    assert.equal(priorityOf({ name: "a", cmd: "a", timeoutMs: 1, warnOnly: true }), "warning");
  });

  test("an explicit priority wins over warnOnly", () => {
    assert.equal(
      priorityOf({ name: "a", cmd: "a", timeoutMs: 1, warnOnly: true, priority: "critical" }),
      "critical",
    );
  });
});

describe("stepPhaseMatches", () => {
  const step = { name: "s", cmd: "c", timeoutMs: 1 };

  test("an unset phase runs in both groups", () => {
    assert.equal(stepPhaseMatches(step, "onFileMutation"), true);
    assert.equal(stepPhaseMatches(step, "onTurnEnd"), true);
  });

  test("a phase restricts the step to its group", () => {
    assert.equal(stepPhaseMatches({ ...step, phase: "mutation" }, "onFileMutation"), true);
    assert.equal(stepPhaseMatches({ ...step, phase: "mutation" }, "onTurnEnd"), false);
    assert.equal(stepPhaseMatches({ ...step, phase: "turn" }, "onTurnEnd"), true);
    assert.equal(stepPhaseMatches({ ...step, phase: "turn" }, "onFileMutation"), false);
  });
});

describe("stepMatchesFiles", () => {
  const step = { name: "s", cmd: "c", timeoutMs: 1 };

  test("no patterns means always relevant", () => {
    assert.equal(stepMatchesFiles(step, []), true);
    assert.equal(stepMatchesFiles(step, ["a/b.md"]), true);
    assert.equal(stepMatchesFiles({ ...step, files: [] }, ["a/b.md"]), true);
  });

  test("unknown changed files run the step rather than skipping a check", () => {
    assert.equal(stepMatchesFiles({ ...step, files: ["**/*.ts"] }, []), true);
  });

  test("matches project-relative and absolute paths", () => {
    const withFiles = { ...step, files: ["src/**/*.ts"] };
    assert.equal(stepMatchesFiles(withFiles, ["src/a.ts"], "/p"), true);
    assert.equal(stepMatchesFiles(withFiles, ["/p/src/a.ts"], "/p"), true);
    assert.equal(stepMatchesFiles(withFiles, ["/p/docs/a.md"], "/p"), false);
  });

  test("one matching file is enough", () => {
    const withFiles = { ...step, files: ["**/*.rs"] };
    assert.equal(stepMatchesFiles(withFiles, ["src/a.ts", "src/lib.rs"], "/p"), true);
  });
});

describe("P6 state persistence", () => {
  test("metrics start at zero and accumulate", () => {
    _resetForTesting();
    const state = getState();
    assert.equal(state.metrics.checks, 0);
    assert.equal(state.metrics.cacheHits, 0);

    recordMetrics({ checks: 2, successes: 2, totalDurationMs: 100 });
    recordMetrics({ checks: 1, failures: 1, timeouts: 1, totalDurationMs: 50 });

    const after = getState();
    assert.equal(after.metrics.checks, 3);
    assert.equal(after.metrics.successes, 2);
    assert.equal(after.metrics.failures, 1);
    assert.equal(after.metrics.timeouts, 1);
    assert.equal(after.metrics.totalDurationMs, 150);
  });

  test("an unknown metric key is ignored, not written as NaN", () => {
    _resetForTesting();
    recordMetrics({ notAMetric: 5 } as never);
    assert.equal(Number.isFinite(getState().metrics.checks), true);
  });

  test("turn outcomes are recorded newest-first and deduplicated per turn", () => {
    _resetForTesting();
    recordTurnOutcome({ at: "2026-01-01T00:00:00.000Z", turnIndex: 1, passed: true });
    recordTurnOutcome({ at: "2026-01-01T00:01:00.000Z", turnIndex: 2, passed: false, step: "tests" });
    recordTurnOutcome({ at: "2026-01-01T00:02:00.000Z", turnIndex: 2, passed: false, step: "lint" });

    const state = getState();
    assert.equal(state.turnHistory.length, 2, "same turn + outcome replaces the entry");
    assert.equal(state.turnHistory[0].step, "lint");
    assert.equal(state.turnHistory[1].turnIndex, 1);
  });

  test("escalations are logged with a cap", () => {
    _resetForTesting();
    for (let i = 0; i < 25; i += 1) {
      recordEscalation({
        at: new Date().toISOString(),
        step: "tests",
        kind: "test-failure",
        count: 3,
        signature: `sig-${i}`,
      });
    }
    assert.equal(getState().escalations.length, 20);
    assert.equal(getState().escalations[0].signature, "sig-24");
  });
});
