import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CACHE_VERSION,
  VerificationCache,
  createCacheKey,
  getVerificationCache,
  _resetCacheForTesting,
} from "../src/clients/cache.ts";
import { projectDir } from "../src/config.ts";
import type { PipelineRunResult, PipelineStep } from "../src/types.ts";

let home: string;
let dir: string;

const step: PipelineStep = { name: "type-check", cmd: "tsc --noEmit", timeoutMs: 1000 };

function write(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function passing(): PipelineRunResult {
  return {
    passed: true,
    failure: null,
    warnings: [],
    steps: [{ name: "type-check", passed: true, durationMs: 5, exitCode: 0 }],
  };
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cache-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cache-"));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetCacheForTesting();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // The cache lives under the home-scoped project dir, not the project itself.
  fs.rmSync(projectDir(dir), { recursive: true, force: true });
});

describe("createCacheKey", () => {
  test("is stable for an identical state", () => {
    const file = write("src/a.ts", "export const a = 1;\n");
    const a = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [file], steps: [step] });
    const b = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [file], steps: [step] });
    assert.equal(a, b);
  });

  test("changes when a file's content changes", () => {
    const file = write("src/a.ts", "export const a = 1;\n");
    const before = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [file], steps: [step] });
    write("src/a.ts", "export const a = 2;\n");
    const after = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [file], steps: [step] });
    assert.notEqual(before, after);
  });

  test("changes when the pipeline configuration changes", () => {
    const file = write("src/a.ts", "x\n");
    const before = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [file], steps: [step] });
    const after = createCacheKey({
      trigger: "onFileMutation",
      cwd: dir,
      focusPaths: [file],
      steps: [{ ...step, cmd: "tsc --noEmit --strict" }],
    });
    assert.notEqual(before, after);
  });

  test("changes when the lock file or tsconfig changes", () => {
    const file = write("src/a.ts", "x\n");
    write("package-lock.json", '{"lockfileVersion":3}');
    const before = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [file], steps: [step] });
    write("package-lock.json", '{"lockfileVersion":3,"changed":true}');
    const after = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [file], steps: [step] });
    assert.notEqual(before, after);

    write("tsconfig.json", "{}");
    const withTsconfig = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [file], steps: [step] });
    assert.notEqual(after, withTsconfig, "adding a tsconfig is a new question");
  });

  test("changes with the relevant environment", () => {
    const file = write("src/a.ts", "x\n");
    const before = createCacheKey({
      trigger: "onFileMutation",
      cwd: dir,
      focusPaths: [file],
      steps: [step],
      env: { NODE_ENV: "test" },
    });
    const after = createCacheKey({
      trigger: "onFileMutation",
      cwd: dir,
      focusPaths: [file],
      steps: [step],
      env: { NODE_ENV: "production" },
    });
    assert.notEqual(before, after);
  });

  test("differs between triggers and ignores path order", () => {
    const a = write("src/a.ts", "a\n");
    const b = write("src/b.ts", "b\n");
    const mutation = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [a, b], steps: [step] });
    const turn = createCacheKey({ trigger: "onTurnEnd", cwd: dir, focusPaths: [a, b], steps: [step] });
    const reversed = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [b, a], steps: [step] });
    assert.notEqual(mutation, turn);
    assert.equal(mutation, reversed);
  });

  test("a missing file is part of the key", () => {
    const missing = path.join(dir, "src/gone.ts");
    const key = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [missing], steps: [step] });
    write("src/gone.ts", "now here\n");
    const after = createCacheKey({ trigger: "onFileMutation", cwd: dir, focusPaths: [missing], steps: [step] });
    assert.notEqual(key, after);
  });
});

describe("VerificationCache", () => {
  interface CacheOverrides {
    enabled?: boolean;
    ttlMs?: number;
    maxEntries?: number;
    persist?: boolean;
  }

  function makeCache(overrides: CacheOverrides = {}) {
    return new VerificationCache({
      enabled: true,
      ttlMs: 60_000,
      maxEntries: 10,
      persist: true,
      cwd: dir,
      ...overrides,
    });
  }

  test("returns a hit for a stored key", () => {
    const cache = makeCache();
    cache.set("k", passing());
    const hit = cache.get("k");
    assert.equal(hit?.passed, true);
    assert.equal(hit?.cached, true);
    assert.equal(cache.stats().hits, 1);
  });

  test("counts a miss and returns null", () => {
    const cache = makeCache();
    assert.equal(cache.get("nope"), null);
    assert.equal(cache.stats().misses, 1);
  });

  test("never stores a failure", () => {
    const cache = makeCache();
    cache.set("k", {
      passed: false,
      failure: null,
      warnings: [],
      steps: [],
    });
    assert.equal(cache.get("k"), null);
  });

  test("does nothing when disabled", () => {
    const cache = makeCache({ enabled: false });
    cache.set("k", passing());
    assert.equal(cache.get("k"), null);
    assert.equal(cache.stats().entries, 0);
  });

  test("expires entries past their ttl", () => {
    const cache = makeCache({ ttlMs: 1000 });
    cache.set("k", passing(), 0);
    assert.equal(cache.get("k", 500)?.passed, true);
    assert.equal(cache.get("k", 5000), null, "expired");
  });

  test("ttl of zero never expires", () => {
    const cache = makeCache({ ttlMs: 0 });
    cache.set("k", passing(), 0);
    assert.equal(cache.get("k", 10 ** 9)?.passed, true);
  });

  test("evicts the oldest entries beyond maxEntries", () => {
    const cache = makeCache({ maxEntries: 2 });
    cache.set("a", passing(), 1);
    cache.set("b", passing(), 2);
    cache.set("c", passing(), 3);
    assert.equal(cache.size(), 2);
    assert.equal(cache.get("a", 4), null, "oldest evicted");
    assert.equal(cache.get("c", 4)?.passed, true);
  });

  test("returns copies, so callers cannot mutate stored results", () => {
    const cache = makeCache();
    cache.set("k", passing());
    const hit = cache.get("k")!;
    hit.steps[0].passed = false;
    assert.equal(cache.get("k")?.steps[0].passed, true);
  });

  test("persists across instances and survives a corrupt file", () => {
    const cache = makeCache();
    cache.set("k", passing());

    const file = path.join(projectDir(dir), "verify-cache.json");
    assert.equal(fs.existsSync(file), true);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(raw.version, CACHE_VERSION);

    const reopened = makeCache();
    assert.equal(reopened.get("k")?.passed, true);

    fs.writeFileSync(file, "{ not json");
    assert.equal(makeCache().get("k"), null, "a corrupt cache is ignored, not fatal");
  });

  test("clear removes memory and disk state", () => {
    const cache = makeCache();
    cache.set("k", passing());
    cache.clear();
    assert.equal(cache.get("k"), null);
    assert.equal(cache.size(), 0);
    assert.equal(fs.existsSync(path.join(projectDir(dir), "verify-cache.json")), false);
  });
});

describe("getVerificationCache", () => {
  test("memoises per cwd and follows option changes", () => {
    const options = { enabled: true, ttlMs: 0, maxEntries: 5, persist: false };
    const first = getVerificationCache(dir, options);
    const second = getVerificationCache(dir, options);
    assert.equal(first, second, "same project, same instance");

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cache-other-"));
    const third = getVerificationCache(other, options);
    assert.notEqual(first, third);
    fs.rmSync(other, { recursive: true, force: true });
  });
});
