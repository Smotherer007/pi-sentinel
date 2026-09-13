import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  defineConfig,
  DEFAULT_CONFIG,
  isExcluded,
  shouldVerify,
  matchesGlob,
  _resetForTesting,
} from "../src/config.ts";

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
