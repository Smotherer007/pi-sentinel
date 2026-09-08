import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  defineConfig,
  DEFAULT_CONFIG,
  isExcluded,
  _resetForTesting,
} from "../src/config.ts";

describe("defineConfig", () => {
  test("merges over defaults", () => {
    const conf = defineConfig({ maxTraceLines: 5 });
    assert.equal(conf.maxTraceLines, 5);
    assert.equal(conf.enabled, true);
    assert.equal(conf.pipelines.onFileMutation.length, 2);
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
});
